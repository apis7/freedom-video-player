//! Tauri command surface for Library Mode.
//!
//! Thin wrappers over `library::*` modules. Folder management +
//! re-scanning go through the orchestrator (which owns the watchers
//! and worker thread); reads come straight off the DB.

use crate::library::model::{LibraryFile, LibraryIdentity, LibraryRow, ProfileStatus, WatchedFolder};
use crate::library::{orchestrator, suggestions, LibraryDb};
use rand::SeedableRng;
use rusqlite::params;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;
use tauri::{AppHandle, Manager, State};

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Add a folder to the library's watch list. Idempotent — if the same path
/// is already watched we return the existing row (so the UI can "add" twice
/// without spawning a duplicate watcher / re-scan).
#[tauri::command]
pub fn library_add_folder(
    db: State<'_, LibraryDb>,
    app: AppHandle,
    path: String,
    recursive: bool,
) -> Result<WatchedFolder, String> {
    crate::log!("library", "add_folder: {path} (recursive={recursive})");
    let pb = PathBuf::from(&path);
    if !pb.is_dir() {
        return Err(format!("Not a folder: {path}"));
    }
    let added_at = now_unix();
    let recursive_i: i64 = if recursive { 1 } else { 0 };

    // Reject paths already covered by an existing recursive watcher.
    // Two watchers on overlapping trees fire on the same fs events and
    // queue redundant scans — that's the multi-rescan storm.
    {
        let conn = db.lock();
        let existing_recursive: Vec<String> = conn
            .prepare("SELECT path FROM watched_folders WHERE recursive = 1")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .and_then(|it| it.collect::<Result<Vec<_>, _>>())
            })
            .unwrap_or_default();
        let new_norm = pb.to_string_lossy().replace('\\', "/").to_lowercase();
        for existing in &existing_recursive {
            let exist_norm = existing.replace('\\', "/").to_lowercase();
            if exist_norm == new_norm {
                continue; // same path is fine — handled by the upsert below
            }
            // "new is under existing" → reject. Trailing separator on
            // the existing path avoids partial-name matches (Jay_Movies
            // matching Jay_Movies_2).
            let exist_with_sep = if exist_norm.ends_with('/') {
                exist_norm.clone()
            } else {
                format!("{exist_norm}/")
            };
            if new_norm.starts_with(&exist_with_sep) {
                return Err(format!(
                    "Already watched via \"{existing}\" (recursive). \
                     No need to add this subfolder separately."
                ));
            }
        }
    }

    let folder = {
        let conn = db.lock();
        match conn.query_row(
            "SELECT id, recursive, added_at, scan_on_startup FROM watched_folders WHERE path = ?1",
            params![path],
            |r| {
                Ok(WatchedFolder {
                    id: r.get(0)?,
                    path: path.clone(),
                    recursive: r.get::<_, i64>(1)? != 0,
                    added_at: r.get(2)?,
                    scan_on_startup: r.get::<_, i64>(3)? != 0,
                })
            },
        ) {
            Ok(existing) => existing,
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                conn.execute(
                    "INSERT INTO watched_folders(path, recursive, added_at, scan_on_startup) VALUES (?1, ?2, ?3, 0)",
                    params![path, recursive_i, added_at],
                )
                .map_err(|e| format!("insert folder: {e}"))?;
                let id = conn.last_insert_rowid();
                WatchedFolder {
                    id,
                    path: path.clone(),
                    recursive,
                    added_at,
                    scan_on_startup: false,
                }
            }
            Err(e) => return Err(format!("query folder: {e}")),
        }
    };

    orchestrator::on_folder_added(folder.id, pb, recursive, app);
    Ok(folder)
}

/// Search every watched folder tree for a file whose final-component
/// matches `filename` (case-insensitive). Returns the absolute paths of
/// every match. Used by the "broken file path" recovery flow: when the
/// user double-clicks a library entry whose path no longer exists, we
/// scan the watched folders to see if the file just moved.
///
/// Best-effort: this enumerates the SAME way the indexer does — only
/// recognized video extensions, recursive when the folder is configured
/// recursive. Bounded by a 5000-file cap so a misconfigured root
/// (whole-drive watch) can't hang the UI.
#[tauri::command]
pub fn library_search_by_filename(
    db: State<'_, LibraryDb>,
    filename: String,
) -> Result<Vec<String>, String> {
    crate::log!("library", "search_by_filename: \"{filename}\"");
    let needle = filename.to_lowercase();
    let folders: Vec<(String, bool)> = {
        let conn = db.lock();
        let mut stmt = conn
            .prepare("SELECT path, recursive FROM watched_folders")
            .map_err(|e| format!("prepare: {e}"))?;
        stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? != 0))
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("query: {e}"))?
    };
    let mut hits: Vec<String> = Vec::new();
    const HARD_CAP: usize = 5000;
    for (root_str, recursive) in folders {
        let root = std::path::Path::new(&root_str);
        if !root.exists() {
            continue;
        }
        for candidate in crate::library::index::enumerate_videos(root, recursive, 6) {
            if hits.len() >= HARD_CAP {
                break;
            }
            let cand_name = candidate
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_lowercase())
                .unwrap_or_default();
            if cand_name == needle {
                if let Some(s) = candidate.to_str() {
                    hits.push(s.to_string());
                }
            }
        }
        if hits.len() >= HARD_CAP {
            break;
        }
    }
    crate::log!("library", "search_by_filename: \"{filename}\" → {} hit(s)", hits.len());
    Ok(hits)
}

/// Rewrite a library file's path. Used by the "found it after a move"
/// recovery: when the user picks (or auto-detects) the new location of
/// a broken file, update the DB row in place so all existing identity /
/// tag / series links survive. Clears `is_missing` and `missing_since`.
#[tauri::command]
pub fn library_relocate_file(
    db: State<'_, LibraryDb>,
    file_id: i64,
    new_path: String,
) -> Result<(), String> {
    crate::log!("library", "relocate_file id={file_id} → {new_path}");
    let pb = std::path::Path::new(&new_path);
    if !pb.exists() {
        return Err(format!("New path does not exist: {new_path}"));
    }
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files
            SET path = ?1, is_missing = 0, missing_since = NULL
            WHERE id = ?2",
        params![new_path, file_id],
    )
    .map_err(|e| format!("relocate: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_remove_folder(
    db: State<'_, LibraryDb>,
    folder_id: i64,
    delete_items: bool,
) -> Result<(), String> {
    crate::log!(
        "library",
        "remove_folder id={folder_id} delete_items={delete_items}"
    );
    orchestrator::on_folder_removed(folder_id);
    if delete_items {
        orchestrator::purge_folder_files(&db, folder_id)?;
    }
    let conn = db.lock();
    conn.execute("DELETE FROM watched_folders WHERE id = ?1", params![folder_id])
        .map_err(|e| format!("delete folder: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_list_folders(db: State<'_, LibraryDb>) -> Result<Vec<WatchedFolder>, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT id, path, recursive, added_at, scan_on_startup
             FROM watched_folders ORDER BY added_at",
        )
        .map_err(|e| format!("prepare: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(WatchedFolder {
                id: r.get(0)?,
                path: r.get(1)?,
                recursive: r.get::<_, i64>(2)? != 0,
                added_at: r.get(3)?,
                scan_on_startup: r.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| format!("query: {e}"))?;
    let mut out = Vec::new();
    for f in rows {
        out.push(f.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn library_set_folder_scan_on_startup(
    db: State<'_, LibraryDb>,
    folder_id: i64,
    value: bool,
) -> Result<(), String> {
    crate::log!(
        "library",
        "set_folder_scan_on_startup id={folder_id} value={value}"
    );
    let conn = db.lock();
    conn.execute(
        "UPDATE watched_folders SET scan_on_startup = ?1 WHERE id = ?2",
        params![value as i64, folder_id],
    )
    .map_err(|e| format!("set scan_on_startup: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_rescan_all() -> Result<(), String> {
    crate::log!("library", "rescan_all queued");
    orchestrator::enqueue_scan_all();
    Ok(())
}

#[tauri::command]
pub fn library_scan_cancel() -> Result<(), String> {
    crate::log!("library", "scan cancel requested");
    orchestrator::request_scan_cancel();
    Ok(())
}

#[tauri::command]
pub fn library_scan_throttle(on: bool) -> Result<(), String> {
    crate::log!("library", "scan throttle = {on}");
    orchestrator::request_scan_throttle(on);
    Ok(())
}

#[tauri::command]
pub fn library_rescan_folder(
    db: State<'_, LibraryDb>,
    folder_id: i64,
) -> Result<(), String> {
    let conn = db.lock();
    let (path, recursive): (String, i64) = conn
        .query_row(
            "SELECT path, recursive FROM watched_folders WHERE id = ?1",
            params![folder_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("folder lookup: {e}"))?;
    drop(conn);
    orchestrator::enqueue_scan_folder(folder_id, PathBuf::from(path), recursive != 0);
    Ok(())
}

/// Main UI feed — joins file + identity into one flat row per file.
///
/// Profile status comes from `library_files.has_free_sibling` (cached at
/// scan time + maintained by the post-save hook). Pre-cache versions of
/// this command did per-row `fs::read_dir` calls on the parent directory;
/// on a network drive that was 6+ seconds per refresh and totally froze
/// the UI. With the cache, list_items is a single SQL query + in-memory
/// joins (microseconds even for thousands of rows).
#[tauri::command]
pub fn library_list_items(db: State<'_, LibraryDb>) -> Result<Vec<LibraryRow>, String> {
    let started = std::time::Instant::now();
    crate::log!("library", "list_items: begin");
    let rows = crate::library::index::list_files_with_identity(&db)?;
    let conn = db.lock();
    crate::log!(
        "library",
        "list_items: {} rows joined from DB in {:?}",
        rows.len(),
        started.elapsed()
    );

    // has_free_sibling now travels on the LibraryFile row from the
    // initial JOIN (see list_files_with_identity), so no second-pass
    // SELECT is needed. profile_status_from_row consults the cached
    // field directly.
    //
    // Bulk-load tags / collections / series in three queries instead of
    // 3N+1 (3 per row × 1224 rows = 3672 prepared statements). Group
    // results by identity_id in HashMaps and join in-memory.
    let joins_started = std::time::Instant::now();
    let tags_by_identity = load_all_tags(&conn)?;
    let collections_by_identity = load_all_collection_memberships(&conn)?;
    let series_by_identity = load_all_series_memberships(&conn)?;
    crate::log!(
        "library",
        "list_items: bulk-loaded tags/collections/series in {:?}",
        joins_started.elapsed()
    );

    let mut out = Vec::with_capacity(rows.len());
    for (file, identity) in rows {
        let tags = tags_by_identity
            .get(&identity.id)
            .cloned()
            .unwrap_or_default();
        let collections = collections_by_identity
            .get(&identity.id)
            .cloned()
            .unwrap_or_default();
        let series = series_by_identity.get(&identity.id).cloned();
        let profile_status =
            profile_status_from_row(&file, identity.no_profile_necessary);
        out.push(LibraryRow { file, identity, tags, profile_status, collections, series });
    }
    crate::log!(
        "library",
        "list_items: returning {} rows in {:?} total",
        out.len(),
        started.elapsed()
    );
    Ok(out)
}

/// Trigger a manual refresh of has_free_sibling across one watched
/// folder. The orchestrator runs this at the tail of every scan, but
/// the frontend can also call it on demand (e.g., after the user saves
/// a .free in Creator and wants the icon to flip without a full rescan).
#[tauri::command]
pub fn library_refresh_profile_status(
    db: State<'_, LibraryDb>,
    video_path: String,
) -> Result<(), String> {
    crate::log!("library", "refresh_profile_status for {video_path}");
    crate::library::index::refresh_free_siblings_for_path(&db, &video_path)
}

/// Bulk-load every tag in the library, grouped by identity_id. One
/// query instead of one-per-row. Result preserves alphabetical order
/// per identity (matches the per-identity ORDER BY in load_tags_for).
fn load_all_tags(
    conn: &rusqlite::Connection,
) -> Result<HashMap<i64, Vec<String>>, String> {
    let mut stmt = conn
        .prepare("SELECT identity_id, tag FROM library_tags ORDER BY identity_id, tag")
        .map_err(|e| format!("prepare all tags: {e}"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| format!("query all tags: {e}"))?;
    let mut out: HashMap<i64, Vec<String>> = HashMap::new();
    for r in rows {
        let (id, tag) = r.map_err(|e| format!("tag row: {e}"))?;
        out.entry(id).or_default().push(tag);
    }
    Ok(out)
}

fn load_all_collection_memberships(
    conn: &rusqlite::Connection,
) -> Result<HashMap<i64, Vec<crate::library::model::CollectionMembership>>, String> {
    use crate::library::model::CollectionMembership;
    let mut stmt = conn
        .prepare(
            "SELECT ci.identity_id, c.id, c.name, ci.position
             FROM library_collection_items ci
             JOIN library_collections c ON c.id = ci.collection_id
             ORDER BY ci.identity_id, c.name COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare all collections: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                CollectionMembership {
                    collection_id: r.get(1)?,
                    collection_name: r.get(2)?,
                    position: r.get(3)?,
                },
            ))
        })
        .map_err(|e| format!("query all collections: {e}"))?;
    let mut out: HashMap<i64, Vec<CollectionMembership>> = HashMap::new();
    for r in rows {
        let (id, mem) = r.map_err(|e| format!("collection row: {e}"))?;
        out.entry(id).or_default().push(mem);
    }
    Ok(out)
}

fn load_all_series_memberships(
    conn: &rusqlite::Connection,
) -> Result<HashMap<i64, crate::library::model::SeriesMembership>, String> {
    use crate::library::model::SeriesMembership;
    let mut stmt = conn
        .prepare(
            "SELECT si.identity_id, s.id, s.name, s.has_seasons, si.season, si.position
             FROM library_series_items si
             JOIN library_series s ON s.id = si.series_id",
        )
        .map_err(|e| format!("prepare all series: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                SeriesMembership {
                    series_id: r.get(1)?,
                    series_name: r.get(2)?,
                    has_seasons: r.get::<_, i64>(3)? != 0,
                    season: r.get(4)?,
                    position: r.get(5)?,
                },
            ))
        })
        .map_err(|e| format!("query all series: {e}"))?;
    let mut out: HashMap<i64, SeriesMembership> = HashMap::new();
    for r in rows {
        let (id, mem) = r.map_err(|e| format!("series row: {e}"))?;
        // First-write-wins for the LIMIT-1 semantics the single-row
        // helper had — if an identity is in two series, the first one
        // encountered wins. Matches load_series_for's LIMIT 1 behavior.
        out.entry(id).or_insert(mem);
    }
    Ok(out)
}

fn load_tags_for(conn: &rusqlite::Connection, identity_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT tag FROM library_tags WHERE identity_id = ?1 ORDER BY tag")
        .map_err(|e| format!("prepare tags: {e}"))?;
    let rows = stmt
        .query_map(params![identity_id], |r| r.get::<_, String>(0))
        .map_err(|e| format!("query tags: {e}"))?;
    let mut out = Vec::new();
    for t in rows {
        out.push(t.map_err(|e| format!("tag row: {e}"))?);
    }
    Ok(out)
}

fn load_collections_for(
    conn: &rusqlite::Connection,
    identity_id: i64,
) -> Result<Vec<crate::library::model::CollectionMembership>, String> {
    use crate::library::model::CollectionMembership;
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, ci.position
             FROM library_collection_items ci
             JOIN library_collections c ON c.id = ci.collection_id
             WHERE ci.identity_id = ?1
             ORDER BY c.name COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare collections: {e}"))?;
    let rows = stmt
        .query_map(params![identity_id], |r| {
            Ok(CollectionMembership {
                collection_id: r.get(0)?,
                collection_name: r.get(1)?,
                position: r.get(2)?,
            })
        })
        .map_err(|e| format!("query collections: {e}"))?;
    let mut out = Vec::new();
    for c in rows {
        out.push(c.map_err(|e| format!("collection row: {e}"))?);
    }
    Ok(out)
}

fn load_series_for(
    conn: &rusqlite::Connection,
    identity_id: i64,
) -> Result<Option<crate::library::model::SeriesMembership>, String> {
    use crate::library::model::SeriesMembership;
    conn.query_row(
        "SELECT s.id, s.name, s.has_seasons, si.season, si.position
         FROM library_series_items si
         JOIN library_series s ON s.id = si.series_id
         WHERE si.identity_id = ?1
         LIMIT 1",
        params![identity_id],
        |r| {
            Ok(SeriesMembership {
                series_id: r.get(0)?,
                series_name: r.get(1)?,
                has_seasons: r.get::<_, i64>(2)? != 0,
                season: r.get(3)?,
                position: r.get(4)?,
            })
        },
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("query series: {other}")),
    })
}

/// Derive ProfileStatus from a fully-hydrated LibraryFile row using the
/// cached `has_free_sibling` column. Replaces the old
/// `compute_profile_status` which did an `fs::read_dir` on every call —
/// disastrous on network shares.
fn profile_status_from_row(file: &LibraryFile, no_profile_necessary: bool) -> ProfileStatus {
    if no_profile_necessary {
        return ProfileStatus::NoProfileNecessary;
    }
    match file.has_free_sibling {
        Some(true) => ProfileStatus::HasProfile,
        Some(false) => ProfileStatus::Missing,
        // Legacy NULL — will fill in on next scan. Treat as Missing.
        None => ProfileStatus::Missing,
    }
}

/// Fetch a single row by file id. Used by the right-hand details panel.
#[tauri::command]
pub fn library_get_row(
    db: State<'_, LibraryDb>,
    file_id: i64,
) -> Result<Option<LibraryRow>, String> {
    let conn = db.lock();
    let result = conn.query_row(
        "SELECT
            f.id, f.path, f.watched_folder_id, f.identity_id,
            f.size_bytes, f.modified_unix, f.resolution, f.codec,
            f.is_missing, f.watch_progress_ms, f.last_watched_at,
            f.watched, f.added_at, f.drift_warning,
            i.id, i.cheap_fingerprint, i.strong_fingerprint, i.duration_ms,
            i.tmdb_id, i.movie_title, i.movie_year, i.movie_director,
            i.movie_plot, i.movie_stars_json, i.genres_json,
            i.mpaa_rating, i.imdb_id, i.imdb_rating,
            i.poster_url, i.poster_local_path,
            i.custom_thumbnail_path, i.notes, i.family_rating,
            i.non_family_friendly, i.priority_for_profile,
            i.no_profile_necessary,
            i.manual_title, i.manual_year, i.manual_thumbnail,
            i.manual_director, i.manual_plot,
            i.first_seen_at, i.last_updated_at,
            f.has_free_sibling,
            i.maps_filtered_tier, i.maps_filtered_summary,
            i.maps_unfiltered_tier, i.maps_unfiltered_summary,
            f.has_subtitle,
            i.is_3d,
            i.is_extended
         FROM library_files f
         JOIN library_identities i ON i.id = f.identity_id
         WHERE f.id = ?1",
        params![file_id],
        |r| Ok(row_from(r)),
    );
    match result {
        Ok((file, identity)) => {
            let tags = load_tags_for(&conn, identity.id)?;
            let collections = load_collections_for(&conn, identity.id)?;
            let series = load_series_for(&conn, identity.id)?;
            let profile_status = profile_status_from_row(&file, identity.no_profile_necessary);
            Ok(Some(LibraryRow { file, identity, tags, profile_status, collections, series }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("query row: {e}")),
    }
}

/// Read a cached poster's bytes off disk. Frontend renders via blob URL
/// so we don't need an `asset://` scope carveout.
#[tauri::command]
pub fn library_get_poster_bytes(path: String) -> Result<Vec<u8>, String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err("poster file missing".into());
    }
    std::fs::read(p).map_err(|e| format!("read poster: {e}"))
}

/// Force a TMDb refresh on one identity. Respects `manual_*` flags.
#[tauri::command]
pub fn library_refresh_metadata(identity_id: i64) -> Result<(), String> {
    crate::log!("library", "refresh_metadata id={identity_id} (force-enqueued)");
    crate::library::enrich::enqueue_force(identity_id);
    Ok(())
}

/// Set the user-facing toggles on an identity (no_profile_necessary,
/// priority_for_profile, non_family_friendly). One command for all three
/// so the frontend doesn't need a separate IPC per toggle. Pass null to
/// leave a flag unchanged.
#[tauri::command]
pub fn library_set_flags(
    db: State<'_, LibraryDb>,
    identity_id: i64,
    no_profile_necessary: Option<bool>,
    priority_for_profile: Option<bool>,
    non_family_friendly: Option<bool>,
    is_3d: Option<bool>,
    is_extended: Option<bool>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "set_flags id={identity_id} no_profile_necessary={:?} priority_for_profile={:?} non_family_friendly={:?} is_3d={:?} is_extended={:?}",
        no_profile_necessary, priority_for_profile, non_family_friendly, is_3d, is_extended
    );
    let now = now_unix();
    let conn = db.lock();
    if let Some(v) = no_profile_necessary {
        conn.execute(
            "UPDATE library_identities SET no_profile_necessary = ?1, last_updated_at = ?2 WHERE id = ?3",
            params![v as i64, now, identity_id],
        ).map_err(|e| format!("set no_profile_necessary: {e}"))?;
    }
    if let Some(v) = priority_for_profile {
        conn.execute(
            "UPDATE library_identities SET priority_for_profile = ?1, last_updated_at = ?2 WHERE id = ?3",
            params![v as i64, now, identity_id],
        ).map_err(|e| format!("set priority_for_profile: {e}"))?;
    }
    if let Some(v) = non_family_friendly {
        conn.execute(
            "UPDATE library_identities SET non_family_friendly = ?1, last_updated_at = ?2 WHERE id = ?3",
            params![v as i64, now, identity_id],
        ).map_err(|e| format!("set non_family_friendly: {e}"))?;
    }
    if let Some(v) = is_3d {
        conn.execute(
            "UPDATE library_identities SET is_3d = ?1, last_updated_at = ?2 WHERE id = ?3",
            params![v as i64, now, identity_id],
        ).map_err(|e| format!("set is_3d: {e}"))?;
    }
    if let Some(v) = is_extended {
        conn.execute(
            "UPDATE library_identities SET is_extended = ?1, last_updated_at = ?2 WHERE id = ?3",
            params![v as i64, now, identity_id],
        ).map_err(|e| format!("set is_extended: {e}"))?;
    }
    Ok(())
}

/// Replace the tag set for an identity. The frontend computes the new
/// list (add/remove etc.); the backend just replaces what's there in a
/// single transaction. Tag strings are sanitized to ≤32 chars, trimmed,
/// and deduplicated case-insensitively (preserving first-seen casing).
#[tauri::command]
pub fn library_set_tags(
    db: State<'_, LibraryDb>,
    identity_id: i64,
    tags: Vec<String>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "set_tags id={identity_id} count={}",
        tags.len()
    );
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let cleaned: Vec<String> = tags
        .into_iter()
        .filter_map(|t| {
            let trimmed = t.trim();
            if trimmed.is_empty() || trimmed.len() > 32 {
                return None;
            }
            let key = trimmed.to_lowercase();
            if seen.insert(key) {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect();
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    tx.execute("DELETE FROM library_tags WHERE identity_id = ?1", params![identity_id])
        .map_err(|e| format!("clear tags: {e}"))?;
    for tag in cleaned {
        tx.execute(
            "INSERT INTO library_tags(identity_id, tag) VALUES (?1, ?2)",
            params![identity_id, tag],
        )
        .map_err(|e| format!("insert tag: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit tags: {e}"))?;
    Ok(())
}

/// Set the freeform notes field on an identity. Pass an empty string to
/// clear. Capped at 5000 chars to keep the row tractable in the UI.
#[tauri::command]
pub fn library_set_notes(
    db: State<'_, LibraryDb>,
    identity_id: i64,
    notes: String,
) -> Result<(), String> {
    let trimmed = notes.chars().take(5000).collect::<String>();
    let stored = if trimmed.is_empty() { None } else { Some(trimmed) };
    crate::log!(
        "library",
        "set_notes id={identity_id} len={}",
        stored.as_deref().map(|s| s.len()).unwrap_or(0)
    );
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "UPDATE library_identities SET notes = ?1, last_updated_at = ?2 WHERE id = ?3",
        params![stored, now, identity_id],
    )
    .map_err(|e| format!("set notes: {e}"))?;
    Ok(())
}

/// Set the family rating on an identity (−10 to +10). Pass null to clear.
#[tauri::command]
pub fn library_set_family_rating(
    db: State<'_, LibraryDb>,
    identity_id: i64,
    rating: Option<i64>,
) -> Result<(), String> {
    let clamped = rating.map(|r| r.clamp(-10, 10));
    crate::log!(
        "library",
        "set_family_rating id={identity_id} → {clamped:?}"
    );
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "UPDATE library_identities SET family_rating = ?1, last_updated_at = ?2 WHERE id = ?3",
        params![clamped, now, identity_id],
    )
    .map_err(|e| format!("set family rating: {e}"))?;
    Ok(())
}

/// Manually edit a metadata field on an identity. Setting `value` also
/// flips the corresponding `manual_<field>` flag so auto-enrichment will
/// leave the field alone on subsequent passes. Pass null to clear
/// BOTH the value AND the manual flag (re-allow auto-fetch).
#[tauri::command]
pub fn library_set_manual_metadata(
    db: State<'_, LibraryDb>,
    identity_id: i64,
    field: String,
    value: Option<String>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "set_manual_metadata id={identity_id} field={field} value={}",
        if value.is_some() { "<set>" } else { "<cleared>" }
    );
    let column = match field.as_str() {
        "title" => ("movie_title", "manual_title"),
        "year" => ("movie_year", "manual_year"),
        "director" => ("movie_director", "manual_director"),
        "plot" => ("movie_plot", "manual_plot"),
        "thumbnail" => ("custom_thumbnail_path", "manual_thumbnail"),
        "genres" => ("genres_json", "manual_genres"),
        "stars" => ("movie_stars_json", "manual_stars"),
        _ => return Err(format!("unknown manual field: {field}")),
    };
    let now = now_unix();
    let conn = db.lock();
    if value.is_some() {
        // For year: parse to i64. For genres/stars: client sends a
        // comma-separated string; convert to JSON-array text. Other
        // fields store as-is.
        if field == "year" {
            let y: Option<i64> = value.as_deref().and_then(|s| s.parse().ok());
            conn.execute(
                &format!(
                    "UPDATE library_identities SET {} = ?1, {} = 1, last_updated_at = ?2 WHERE id = ?3",
                    column.0, column.1
                ),
                params![y, now, identity_id],
            )
            .map_err(|e| format!("set {field}: {e}"))?;
        } else if field == "genres" || field == "stars" {
            let items: Vec<String> = value
                .as_deref()
                .map(|s| {
                    s.split(',')
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let json = serde_json::to_string(&items)
                .map_err(|e| format!("encode {field} array: {e}"))?;
            conn.execute(
                &format!(
                    "UPDATE library_identities SET {} = ?1, {} = 1, last_updated_at = ?2 WHERE id = ?3",
                    column.0, column.1
                ),
                params![json, now, identity_id],
            )
            .map_err(|e| format!("set {field}: {e}"))?;
        } else {
            conn.execute(
                &format!(
                    "UPDATE library_identities SET {} = ?1, {} = 1, last_updated_at = ?2 WHERE id = ?3",
                    column.0, column.1
                ),
                params![value, now, identity_id],
            )
            .map_err(|e| format!("set {field}: {e}"))?;
        }
    } else {
        // Clear both value and manual flag → re-enables auto-enrich.
        conn.execute(
            &format!(
                "UPDATE library_identities SET {} = NULL, {} = 0, last_updated_at = ?1 WHERE id = ?2",
                column.0, column.1
            ),
            params![now, identity_id],
        )
        .map_err(|e| format!("clear {field}: {e}"))?;
    }
    Ok(())
}

// ── Collections + Series CRUD ──────────────────────────────────────

#[derive(serde::Serialize)]
pub struct CollectionRow {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub item_count: i64,
    /// True when the user explicitly flagged the whole collection
    /// non-family-friendly. Family Mode also hides collections whose
    /// member set is ENTIRELY NFF — that derivation happens client-
    /// side because the per-member NFF flags live on identities.
    pub non_family_friendly: bool,
}

#[derive(serde::Serialize)]
pub struct SeriesRow {
    pub id: i64,
    pub name: String,
    pub has_seasons: bool,
    pub created_at: i64,
    pub item_count: i64,
    /// How many items in this series are flagged watched. Drives the
    /// "Watched / In progress / Unwatched" progress indicator in the
    /// sidebar per directive.
    pub watched_count: i64,
    /// Same as CollectionRow's field — see above.
    pub non_family_friendly: bool,
}

#[tauri::command]
pub fn library_list_collections(
    db: State<'_, LibraryDb>,
) -> Result<Vec<CollectionRow>, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.created_at,
                    (SELECT COUNT(*) FROM library_collection_items ci WHERE ci.collection_id = c.id),
                    c.non_family_friendly
             FROM library_collections c
             -- sort_position first (drag-reorder via library_reorder_collection),
             -- with NULL-positions sorted last so legacy rows stay alphabetical
             -- until the user reorders them once.
             ORDER BY (c.sort_position IS NULL), c.sort_position, c.name COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare collections: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CollectionRow {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                item_count: r.get(3)?,
                non_family_friendly: r.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|e| format!("query collections: {e}"))?;
    let mut out = Vec::new();
    for c in rows {
        out.push(c.map_err(|e| format!("collection row: {e}"))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn library_create_collection(
    db: State<'_, LibraryDb>,
    name: String,
) -> Result<i64, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Collection name can't be empty.".into());
    }
    crate::log!("library", "create_collection: \"{trimmed}\"");
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO library_collections(name, created_at) VALUES (?1, ?2)",
        params![trimmed, now],
    )
    .map_err(|e| format!("create collection: {e}"))?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn library_rename_collection(
    db: State<'_, LibraryDb>,
    collection_id: i64,
    new_name: String,
) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Name can't be empty.".into());
    }
    crate::log!(
        "library",
        "rename_collection id={collection_id} → \"{trimmed}\""
    );
    let conn = db.lock();
    conn.execute(
        "UPDATE library_collections SET name = ?1 WHERE id = ?2",
        params![trimmed, collection_id],
    )
    .map_err(|e| format!("rename collection: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_delete_collection(
    db: State<'_, LibraryDb>,
    collection_id: i64,
) -> Result<(), String> {
    crate::log!("library", "delete_collection id={collection_id}");
    let conn = db.lock();
    conn.execute(
        "DELETE FROM library_collections WHERE id = ?1",
        params![collection_id],
    )
    .map_err(|e| format!("delete collection: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_add_to_collection(
    db: State<'_, LibraryDb>,
    collection_id: i64,
    identity_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "add_to_collection collection_id={collection_id} adding {} identities",
        identity_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    let max_pos: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) FROM library_collection_items WHERE collection_id = ?1",
            params![collection_id],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    for (i, id) in identity_ids.iter().enumerate() {
        // First item in an empty collection gets position 0 (MAX = -1
        // via COALESCE), so +i+1 = 0. New items appended to an existing
        // collection start one past the current MAX.
        let pos = max_pos + (i as i64) + 1;
        tx.execute(
            "INSERT OR IGNORE INTO library_collection_items(collection_id, identity_id, position)
             VALUES (?1, ?2, ?3)",
            params![collection_id, id, pos],
        )
        .map_err(|e| format!("add to collection: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit add: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_remove_from_collection(
    db: State<'_, LibraryDb>,
    collection_id: i64,
    identity_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "remove_from_collection collection_id={collection_id} removing {} identities",
        identity_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for id in identity_ids {
        tx.execute(
            "DELETE FROM library_collection_items
             WHERE collection_id = ?1 AND identity_id = ?2",
            params![collection_id, id],
        )
        .map_err(|e| format!("remove from collection: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit remove: {e}"))?;
    Ok(())
}

// Series follow the same shape — just a different table set.
#[tauri::command]
pub fn library_list_series(db: State<'_, LibraryDb>) -> Result<Vec<SeriesRow>, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.name, s.has_seasons, s.created_at,
                    (SELECT COUNT(*) FROM library_series_items si WHERE si.series_id = s.id),
                    (SELECT COUNT(*) FROM library_series_items si
                                       JOIN library_files f ON f.identity_id = si.identity_id
                                       WHERE si.series_id = s.id AND f.watched = 1),
                    s.non_family_friendly
             FROM library_series s
             ORDER BY (s.sort_position IS NULL), s.sort_position, s.name COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare series: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SeriesRow {
                id: r.get(0)?,
                name: r.get(1)?,
                has_seasons: r.get::<_, i64>(2)? != 0,
                created_at: r.get(3)?,
                item_count: r.get(4)?,
                watched_count: r.get(5)?,
                non_family_friendly: r.get::<_, i64>(6)? != 0,
            })
        })
        .map_err(|e| format!("query series: {e}"))?;
    let mut out = Vec::new();
    for s in rows {
        out.push(s.map_err(|e| format!("series row: {e}"))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn library_create_series(
    db: State<'_, LibraryDb>,
    name: String,
    has_seasons: bool,
) -> Result<i64, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Series name can't be empty.".into());
    }
    crate::log!(
        "library",
        "create_series: \"{trimmed}\" (has_seasons={has_seasons})"
    );
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO library_series(name, has_seasons, created_at) VALUES (?1, ?2, ?3)",
        params![trimmed, has_seasons as i64, now],
    )
    .map_err(|e| format!("create series: {e}"))?;
    Ok(conn.last_insert_rowid())
}

#[tauri::command]
pub fn library_rename_series(
    db: State<'_, LibraryDb>,
    series_id: i64,
    new_name: String,
) -> Result<(), String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("Name can't be empty.".into());
    }
    crate::log!("library", "rename_series id={series_id} → \"{trimmed}\"");
    let conn = db.lock();
    conn.execute(
        "UPDATE library_series SET name = ?1 WHERE id = ?2",
        params![trimmed, series_id],
    )
    .map_err(|e| format!("rename series: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_delete_series(
    db: State<'_, LibraryDb>,
    series_id: i64,
) -> Result<(), String> {
    crate::log!("library", "delete_series id={series_id}");
    let conn = db.lock();
    conn.execute(
        "DELETE FROM library_series WHERE id = ?1",
        params![series_id],
    )
    .map_err(|e| format!("delete series: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_add_to_series(
    db: State<'_, LibraryDb>,
    series_id: i64,
    identity_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "add_to_series series_id={series_id} adding {} identities",
        identity_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    let max_pos: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(position), -1) FROM library_series_items WHERE series_id = ?1",
            params![series_id],
            |r| r.get(0),
        )
        .unwrap_or(-1);
    for (i, id) in identity_ids.iter().enumerate() {
        // First-ever item gets position 0 (MAX is -1 by COALESCE when
        // empty). When the series already has N items, the new ones
        // start at N. Display layer adds +1 for 1-based labels.
        let pos = max_pos + (i as i64) + 1;
        tx.execute(
            "INSERT OR IGNORE INTO library_series_items(series_id, identity_id, position)
             VALUES (?1, ?2, ?3)",
            params![series_id, id, pos],
        )
        .map_err(|e| format!("add to series: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit add series: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_remove_from_series(
    db: State<'_, LibraryDb>,
    series_id: i64,
    identity_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "remove_from_series series_id={series_id} removing {} identities",
        identity_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for id in identity_ids {
        tx.execute(
            "DELETE FROM library_series_items
             WHERE series_id = ?1 AND identity_id = ?2",
            params![series_id, id],
        )
        .map_err(|e| format!("remove from series: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit remove series: {e}"))?;
    Ok(())
}

// ── Delete + trash + log + reorder ─────────────────────────────────

#[derive(serde::Deserialize)]
pub struct DeleteResult {
    pub removed: u32,
    pub trashed: u32,
    pub failed: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct DeleteSummary {
    pub removed: u32,
    pub trashed: u32,
    pub failed: Vec<String>,
}

/// Remove a set of files from the library DB only. Their on-disk
/// presence is untouched. Per directive: this is the "Remove from
/// Library" Delete-key default.
///
/// Identities that become orphan (no files left pointing to them) are
/// cleaned up so curation rows don't pile up.
#[tauri::command]
pub fn library_remove_files(
    db: State<'_, LibraryDb>,
    file_ids: Vec<i64>,
) -> Result<DeleteSummary, String> {
    crate::log!(
        "library",
        "remove_files: removing {} file row(s) from DB",
        file_ids.len()
    );
    let mut summary = DeleteSummary {
        removed: 0,
        trashed: 0,
        failed: Vec::new(),
    };
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for id in &file_ids {
        match tx.execute("DELETE FROM library_files WHERE id = ?1", params![id]) {
            Ok(n) if n > 0 => summary.removed += 1,
            Ok(_) => summary
                .failed
                .push(format!("file {id} not in library")),
            Err(e) => summary.failed.push(format!("file {id}: {e}")),
        }
    }
    // Drop orphan identities so their tags / collection memberships /
    // series memberships are cleaned up too (FK cascade handles those).
    let _ = tx.execute(
        "DELETE FROM library_identities
         WHERE id NOT IN (SELECT DISTINCT identity_id FROM library_files)",
        [],
    );
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(summary)
}

/// Move a set of files to the OS recycle bin AND remove them from the
/// library DB. Per directive: "Send to recycle bin" — explicit,
/// confirmed, undoable, never the default. `trash` crate handles the
/// per-OS specifics (SHFileOperation on Windows, NSWorkspace on Mac,
/// XDG trash spec on Linux).
/// True for UNC paths like `\\server\share\file.mp4` or
/// `\\?\UNC\server\share\file.mp4` (extended-length UNC form). These
/// can't be sent to the Recycle Bin on Windows — the shell APIs
/// require a per-volume `$RECYCLE.BIN` which doesn't exist on SMB.
fn is_unc_or_network_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

#[tauri::command]
pub fn library_trash_files(
    db: State<'_, LibraryDb>,
    file_ids: Vec<i64>,
) -> Result<DeleteSummary, String> {
    crate::log!(
        "library",
        "trash_files: moving {} file(s) to recycle bin + removing from DB",
        file_ids.len()
    );
    // Resolve paths up front so we can drop the lock during trash I/O.
    let paths: Vec<(i64, String)> = {
        let conn = db.lock();
        let mut stmt = conn
            .prepare("SELECT id, path FROM library_files WHERE id = ?1")
            .map_err(|e| format!("prepare: {e}"))?;
        let mut out = Vec::new();
        for id in &file_ids {
            if let Ok(p) = stmt.query_row(params![id], |r| r.get::<_, String>(1)) {
                out.push((*id, p));
            }
        }
        out
    };

    let mut summary = DeleteSummary {
        removed: 0,
        trashed: 0,
        failed: Vec::new(),
    };
    let mut to_remove: Vec<i64> = Vec::new();
    for (id, path) in &paths {
        // Already absent on disk → user's intent ("get rid of this") is
        // satisfied; just drop the library row. Pre-check is necessary
        // because the trash crate's error mapping for "missing" is
        // inconsistent across OS / shell versions.
        if !std::path::Path::new(path).exists() {
            crate::log!(
                "library",
                "trash_files: {path} already absent on disk — silently removing row"
            );
            summary.trashed += 1;
            to_remove.push(*id);
            continue;
        }
        // UNC / network-share paths can't be sent to the Recycle Bin
        // at all on Windows. The OS shell returns "Class not registered"
        // (0x80070002) because the per-volume `$RECYCLE.BIN` infra
        // doesn't exist on remote SMB. Only option here is a permanent
        // delete via std::fs. The user already confirmed they want the
        // file gone; the alternative (refuse and leave it alone) is
        // worse than the loss of an undo. Log clearly so the difference
        // is auditable.
        if is_unc_or_network_path(path) {
            match std::fs::remove_file(path) {
                Ok(()) => {
                    crate::log!(
                        "library",
                        "trash_files: {path} permanently deleted (UNC path — no recycle bin on remote shares)"
                    );
                    summary.trashed += 1;
                    to_remove.push(*id);
                }
                Err(e) => {
                    if e.kind() == std::io::ErrorKind::NotFound {
                        // Race: vanished between exists() and remove.
                        crate::log!(
                            "library",
                            "trash_files: {path} vanished during permanent delete — silently removing row"
                        );
                        summary.trashed += 1;
                        to_remove.push(*id);
                    } else {
                        crate::log!(
                            "library",
                            "trash_files: FAILED permanent delete {path}: {e}"
                        );
                        summary.failed.push(format!("{path}: {e}"));
                    }
                }
            }
            continue;
        }
        match trash::delete(path) {
            Ok(()) => {
                summary.trashed += 1;
                to_remove.push(*id);
                crate::log!("library", "trash_files: trashed {path}");
            }
            Err(e) => {
                if !std::path::Path::new(path).exists() {
                    crate::log!(
                        "library",
                        "trash_files: {path} disappeared during trash (race) — silently removing row"
                    );
                    summary.trashed += 1;
                    to_remove.push(*id);
                } else {
                    crate::log!(
                        "library",
                        "trash_files: FAILED to trash {path}: {e}"
                    );
                    summary.failed.push(format!("{path}: {e}"));
                }
            }
        }
    }
    if !to_remove.is_empty() {
        let inner = library_remove_files(db, to_remove)?;
        summary.removed = inner.removed;
        for f in inner.failed {
            summary.failed.push(f);
        }
    }
    Ok(summary)
}

/// Log a play event in the watch log. Called by the frontend when a
/// file is opened in Player Mode (independent of watch progress, which
/// is also tracked). Per directive's "opened history" — parents can see
/// what was accessed even if it wasn't ultimately watched.
#[tauri::command]
pub fn library_log_open(
    db: State<'_, LibraryDb>,
    file_id: i64,
) -> Result<(), String> {
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO library_watch_log(file_id, started_at, event_type) VALUES (?1, ?2, 'opened')",
        params![file_id, now],
    )
    .map_err(|e| format!("log open: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_reorder_collection(
    db: State<'_, LibraryDb>,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "reorder_collection: {} ids in new order",
        ordered_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for (pos, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE library_collections SET sort_position = ?1 WHERE id = ?2",
            params![pos as i64, id],
        )
        .map_err(|e| format!("update: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_reorder_series(
    db: State<'_, LibraryDb>,
    ordered_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "reorder_series: {} ids in new order",
        ordered_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for (pos, id) in ordered_ids.iter().enumerate() {
        tx.execute(
            "UPDATE library_series SET sort_position = ?1 WHERE id = ?2",
            params![pos as i64, id],
        )
        .map_err(|e| format!("update: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(())
}

/// Reorder items WITHIN a collection. The `ordered_identity_ids` is the
/// full new ordering of that collection's members (caller computes it
/// after a drag-drop). Updates each row's position to match its array
/// index. Identities not in the array are left at their existing
/// position (they shouldn't be touched by a partial reorder).
#[tauri::command]
pub fn library_reorder_collection_items(
    db: State<'_, LibraryDb>,
    collection_id: i64,
    ordered_identity_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "reorder_collection_items collection_id={collection_id} count={}",
        ordered_identity_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for (pos, id) in ordered_identity_ids.iter().enumerate() {
        tx.execute(
            "UPDATE library_collection_items SET position = ?1
             WHERE collection_id = ?2 AND identity_id = ?3",
            params![pos as i64, collection_id, id],
        )
        .map_err(|e| format!("update: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_reorder_series_items(
    db: State<'_, LibraryDb>,
    series_id: i64,
    ordered_identity_ids: Vec<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "reorder_series_items series_id={series_id} count={}",
        ordered_identity_ids.len()
    );
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    for (pos, id) in ordered_identity_ids.iter().enumerate() {
        tx.execute(
            "UPDATE library_series_items SET position = ?1
             WHERE series_id = ?2 AND identity_id = ?3",
            params![pos as i64, series_id, id],
        )
        .map_err(|e| format!("update: {e}"))?;
    }
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_set_series_has_seasons(
    db: State<'_, LibraryDb>,
    series_id: i64,
    has_seasons: bool,
) -> Result<(), String> {
    crate::log!(
        "library",
        "set_series_has_seasons series_id={series_id} → {has_seasons}"
    );
    let conn = db.lock();
    conn.execute(
        "UPDATE library_series SET has_seasons = ?1 WHERE id = ?2",
        params![has_seasons as i64, series_id],
    )
    .map_err(|e| format!("set has_seasons: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn library_set_series_item_season(
    db: State<'_, LibraryDb>,
    series_id: i64,
    identity_id: i64,
    season: Option<i64>,
) -> Result<(), String> {
    crate::log!(
        "library",
        "set_series_item_season series_id={series_id} identity_id={identity_id} → {season:?}"
    );
    let conn = db.lock();
    conn.execute(
        "UPDATE library_series_items SET season = ?1
         WHERE series_id = ?2 AND identity_id = ?3",
        params![season, series_id, identity_id],
    )
    .map_err(|e| format!("set season: {e}"))?;
    Ok(())
}

// ── Smart TMDb search (collection / series donor-assisted) ──────────

#[derive(serde::Serialize)]
pub struct SmartTmdbCandidate {
    pub identity_id: i64,
    pub current_title: String,
    pub proposed_tmdb_id: u32,
    pub proposed_title: String,
    pub proposed_year: Option<u32>,
    pub proposed_poster_url: Option<String>,
}

/// Smart TMDb search across a collection or series. Idea: when one
/// member has been successfully TMDb-matched, the user has demonstrated
/// the title-naming pattern that works for this group. Try a small set
/// of common title-cleanups on every UN-matched member and surface
/// proposed matches as a review list.
///
/// Cleanup patterns tried per title (each one searched against TMDb):
///   - the raw parsed title
///   - leading numeric prefix stripped ("01 ", "1. ", "01. ")
///   - leading episode marker stripped ("S01E03 ", "E03 ", "1x03 ")
///   - both — leading-number AND episode-marker stripped
///
/// Caller must have at least one already-matched member in the group;
/// returns Err if not, as a gentle reminder to fix one manually first.
///
/// Returns one SmartTmdbCandidate per unmatched member with a TMDb
/// hit. Members with no hit at all are omitted; the frontend then shows
/// the user what was found, lets them check/uncheck, and bulk-applies.
#[tauri::command]
pub fn library_smart_tmdb_search(
    db: State<'_, LibraryDb>,
    group_kind: String,
    group_id: i64,
) -> Result<Vec<SmartTmdbCandidate>, String> {
    crate::log!(
        "library:smart-tmdb",
        "begin: group_kind={group_kind} group_id={group_id}"
    );
    let started = std::time::Instant::now();

    // Pull all identities in the group via JOIN.
    let sql = if group_kind == "collection" {
        "SELECT i.id, i.tmdb_id, i.movie_title, i.movie_year
         FROM library_identities i
         JOIN library_collection_items ci ON ci.identity_id = i.id
         WHERE ci.collection_id = ?1"
    } else if group_kind == "series" {
        "SELECT i.id, i.tmdb_id, i.movie_title, i.movie_year
         FROM library_identities i
         JOIN library_series_items si ON si.identity_id = i.id
         WHERE si.series_id = ?1"
    } else {
        return Err("group_kind must be 'collection' or 'series'".into());
    };

    struct Member {
        id: i64,
        tmdb_id: Option<i64>,
        title: Option<String>,
        year: Option<i64>,
    }
    let members: Vec<Member> = {
        let conn = db.lock();
        let mut stmt = conn.prepare(sql).map_err(|e| format!("prepare members: {e}"))?;
        let rows = stmt
            .query_map(params![group_id], |r| {
                Ok(Member {
                    id: r.get(0)?,
                    tmdb_id: r.get(1)?,
                    title: r.get(2)?,
                    year: r.get(3)?,
                })
            })
            .map_err(|e| format!("query members: {e}"))?;
        rows.filter_map(|x| x.ok()).collect()
    };
    if members.is_empty() {
        return Err("Group has no members.".into());
    }

    // Require at least one matched donor — otherwise we'd run the
    // brute-force cleanup on a cold group and probably attach wrong
    // matches everywhere.
    let donor_count = members.iter().filter(|m| m.tmdb_id.is_some()).count();
    if donor_count == 0 {
        return Err(
            "Match at least one member manually first (via Replace metadata from TMDb…). \
             Smart search uses that as a hint to find the rest."
                .into(),
        );
    }
    crate::log!(
        "library:smart-tmdb",
        "group has {} members, {} already matched (donors)",
        members.len(),
        donor_count
    );

    let mut out: Vec<SmartTmdbCandidate> = Vec::new();
    for m in members.iter().filter(|m| m.tmdb_id.is_none()) {
        let Some(raw_title) = m.title.as_deref() else { continue };
        let year_u32 = m.year.and_then(|y| u32::try_from(y).ok());
        let cleanups = candidate_titles(raw_title);
        crate::log!(
            "library:smart-tmdb",
            "id={} trying {} cleanup(s) of \"{}\"",
            m.id,
            cleanups.len(),
            raw_title
        );
        for clean in &cleanups {
            let results = match crate::tmdb::search_with_year(clean, year_u32) {
                Ok(r) => r,
                Err(_) => continue,
            };
            // Year-match preference, otherwise first.
            let pick = year_u32
                .and_then(|y| {
                    results.iter().find(|r| r.release_year == Some(y)).cloned()
                })
                .or_else(|| results.first().cloned());
            if let Some(p) = pick {
                crate::log!(
                    "library:smart-tmdb",
                    "id={} matched via \"{}\" → tmdb:{} \"{}\"",
                    m.id, clean, p.tmdb_id, p.title
                );
                out.push(SmartTmdbCandidate {
                    identity_id: m.id,
                    current_title: raw_title.to_string(),
                    proposed_tmdb_id: p.tmdb_id,
                    proposed_title: p.title,
                    proposed_year: p.release_year,
                    proposed_poster_url: p.poster_url,
                });
                break;
            }
        }
    }
    crate::log!(
        "library:smart-tmdb",
        "DONE in {:?}: {} candidate(s) proposed",
        started.elapsed(),
        out.len()
    );
    Ok(out)
}

/// Try a small set of common title cleanups so the search engine has
/// multiple shots at finding a match for noisy filenames.
fn candidate_titles(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    let mut out: Vec<String> = Vec::new();
    out.push(trimmed.to_string());

    // Strip leading numeric prefix: "01 ", "1. ", "01. ", "  3 - "
    let leading_num_stripped: String = strip_leading_number(trimmed);
    if leading_num_stripped != trimmed && !leading_num_stripped.is_empty() {
        out.push(leading_num_stripped.clone());
    }

    // Strip leading episode marker: "S01E03 ", "S01.E03", "E03 ", "1x03 "
    let ep_stripped = strip_leading_episode(trimmed);
    if ep_stripped != trimmed && !ep_stripped.is_empty() {
        out.push(ep_stripped.clone());
    }

    // Both: number THEN episode marker, in case both prefixes are present.
    let both = strip_leading_episode(&leading_num_stripped);
    if both != leading_num_stripped && !both.is_empty() {
        out.push(both);
    }

    out
}

fn strip_leading_number(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == 0 {
        return s.to_string();
    }
    // Allow a trailing separator: '.', '-', ')', space.
    let mut j = i;
    while j < bytes.len()
        && matches!(bytes[j], b'.' | b'-' | b')' | b' ' | b'_' | b':')
    {
        j += 1;
    }
    if j == i {
        // Pure number with no separator — leave it.
        return s.to_string();
    }
    s[j..].trim().to_string()
}

fn strip_leading_episode(s: &str) -> String {
    // Episode-marker patterns we recognize at the start. Each match
    // returns the stripped tail or the original.
    let lower = s.to_lowercase();
    // S01E03, s1e3, S01.E03
    let chars: Vec<char> = lower.chars().collect();
    let starts_with_se = |c: &[char]| -> Option<usize> {
        if c.first()? != &'s' {
            return None;
        }
        let mut i = 1;
        while i < c.len() && c[i].is_ascii_digit() {
            i += 1;
        }
        if i == 1 {
            return None;
        }
        // Optional separator
        if i < c.len() && matches!(c[i], '.' | '-' | ' ') {
            i += 1;
        }
        if c.get(i)? != &'e' {
            return None;
        }
        i += 1;
        let mut j = i;
        while j < c.len() && c[j].is_ascii_digit() {
            j += 1;
        }
        if j == i {
            return None;
        }
        Some(j)
    };
    // NxNN (e.g., 1x03)
    let starts_with_axb = |c: &[char]| -> Option<usize> {
        let mut i = 0;
        while i < c.len() && c[i].is_ascii_digit() {
            i += 1;
        }
        if i == 0 {
            return None;
        }
        if c.get(i)? != &'x' {
            return None;
        }
        i += 1;
        let mut j = i;
        while j < c.len() && c[j].is_ascii_digit() {
            j += 1;
        }
        if j == i {
            return None;
        }
        Some(j)
    };
    // E03 / E03.
    let starts_with_e = |c: &[char]| -> Option<usize> {
        if c.first()? != &'e' {
            return None;
        }
        let mut i = 1;
        while i < c.len() && c[i].is_ascii_digit() {
            i += 1;
        }
        if i == 1 {
            return None;
        }
        Some(i)
    };

    let end = starts_with_se(&chars)
        .or_else(|| starts_with_axb(&chars))
        .or_else(|| starts_with_e(&chars));
    if let Some(mut end) = end {
        while end < chars.len() && matches!(chars[end], ' ' | '_' | '-' | '.' | ':') {
            end += 1;
        }
        // Need to slice the ORIGINAL string by char count, not the
        // lowercased one (length-wise they're identical for our inputs,
        // but be safe by counting chars).
        return s.chars().skip(end).collect::<String>().trim().to_string();
    }
    s.to_string()
}

// ── Manual TMDb picker ──────────────────────────────────────────────

/// Apply a specific TMDb id to an identity, replacing the existing
/// metadata. Used by the right-click "Replace metadata from TMDb…" flow
/// when auto-enrichment picked the wrong movie. Sets the manual flag
/// on title + year so future auto-runs don't undo the user's choice.
#[tauri::command]
pub fn library_apply_tmdb_id(
    db: State<'_, LibraryDb>,
    identity_id: i64,
    tmdb_id: u32,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    crate::log!(
        "library",
        "apply_tmdb_id: identity_id={identity_id} tmdb_id={tmdb_id} — fetching details from TMDb"
    );
    let details = crate::tmdb::details(tmdb_id)?;
    crate::log!(
        "library",
        "apply_tmdb_id: TMDb details OK in {:?}, title=\"{}\" poster={}",
        started.elapsed(),
        details.title,
        details.poster_url.is_some()
    );
    let app_local_data_dir = {
        // Re-derive the app local data dir the same way orchestrator does
        // via the same env var Tauri uses. Falls back to %LOCALAPPDATA%.
        std::env::var("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join("com.fvp.desktop")
    };
    let poster_local_path: Option<String> = match details.poster_url.as_deref() {
        Some(url) => {
            let poster_started = std::time::Instant::now();
            crate::log!("library", "apply_tmdb_id: downloading poster {url}");
            match crate::library::poster_cache::fetch_to_cache(
                &db,
                &app_local_data_dir,
                url,
            ) {
                Ok(p) => {
                    crate::log!(
                        "library",
                        "apply_tmdb_id: poster cached in {:?} → {}",
                        poster_started.elapsed(),
                        p.display()
                    );
                    Some(p.to_string_lossy().into_owned())
                }
                Err(e) => {
                    crate::log!("library", "apply_tmdb_id: poster cache FAILED: {e}");
                    None
                }
            }
        }
        None => {
            crate::log!("library", "apply_tmdb_id: TMDb returned no poster");
            None
        }
    };

    let now = now_unix();
    let stars_json =
        serde_json::to_string(&details.top_cast).unwrap_or_else(|_| "[]".into());
    let genres_json =
        serde_json::to_string(&details.genres).unwrap_or_else(|_| "[]".into());
    // Use TMDb's runtime when we have nothing locally. The runtime is in
    // minutes; convert to ms. Don't clobber a non-zero duration that
    // came from somewhere more authoritative (the indexer's libmpv
    // probe path will overwrite this with the true file runtime when
    // it lands; for now this is the best signal we have).
    let tmdb_duration_ms: Option<i64> =
        details.runtime_minutes.map(|m| (m as i64) * 60_000);
    let conn = db.lock();
    conn.execute(
        "UPDATE library_identities SET
            tmdb_id = ?1,
            movie_title = ?2,
            movie_year = ?3,
            movie_director = ?4,
            movie_plot = ?5,
            movie_stars_json = ?6,
            genres_json = ?7,
            imdb_id = ?8,
            imdb_rating = ?9,
            poster_url = ?10,
            poster_local_path = ?11,
            duration_ms = CASE
                WHEN duration_ms > 0 THEN duration_ms
                ELSE COALESCE(?14, 0)
            END,
            manual_title = 1,
            manual_year = 1,
            manual_director = 1,
            manual_plot = 1,
            manual_thumbnail = 1,
            last_updated_at = ?12
         WHERE id = ?13",
        params![
            details.tmdb_id as i64,
            details.title,
            details.release_year.map(|y| y as i64),
            details.director,
            details.overview,
            stars_json,
            genres_json,
            details.imdb_id,
            details.vote_average,
            details.poster_url,
            poster_local_path,
            now,
            identity_id,
            tmdb_duration_ms,
        ],
    )
    .map_err(|e| format!("apply tmdb id: {e}"))?;

    // Best-effort resolution: most curated libraries embed it in the
    // filename ("1080p", "720p", "4K", "2160p"). Parse the file path(s)
    // for this identity and write resolution when we can. This avoids
    // shipping a real video-probe binary just to populate a column.
    // Only writes when the file's resolution column is currently NULL,
    // so user-curated values (or future probes) win.
    {
        let mut stmt = conn
            .prepare(
                "SELECT id, path FROM library_files
                 WHERE identity_id = ?1 AND (resolution IS NULL OR resolution = '')",
            )
            .map_err(|e| format!("prepare files for res: {e}"))?;
        let rows: Vec<(i64, String)> = stmt
            .query_map(params![identity_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("query files for res: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        for (file_id, path) in rows {
            if let Some(res) = parse_resolution_from_filename(&path) {
                let _ = conn.execute(
                    "UPDATE library_files SET resolution = ?1 WHERE id = ?2",
                    params![res, file_id],
                );
            }
        }
    }
    crate::log!(
        "library",
        "apply_tmdb_id: DONE in {:?} (identity_id={identity_id})",
        started.elapsed()
    );
    Ok(())
}

// ── Custom thumbnails + Explorer / website helpers ─────────────────

/// Set a user-uploaded custom thumbnail for an identity. Flips
/// `manual_thumbnail = 1` so subsequent TMDb enrichment leaves it alone
/// (per directive: "Manually-uploaded thumbs are NOT automatically
/// replaced. Allow users to change that in settings; default is that
/// they're not auto-replaced").
#[tauri::command]
pub fn library_set_custom_thumbnail(
    db: State<'_, LibraryDb>,
    identity_id: i64,
    path: Option<String>,
) -> Result<(), String> {
    let now = now_unix();
    // When the user provides a source path, copy it next to EVERY video
    // file under this identity. Filename pattern is
    // `<media-basename>.fvp-thumb.<ext>` so the thumb stays adjacent to
    // its movie — survives drive-share renames, travels with the media
    // to another machine, and is discoverable by anyone browsing the
    // folder. We store the FIRST file's thumb path on the identity for
    // display; if that file is later deleted, other copies of the
    // thumb under sibling files still exist (we just don't follow up
    // to swap the stored path yet — a future fallback).
    let stored_path: Option<String> = match path.as_deref() {
        None => None,
        Some(src_str) => {
            let src = std::path::Path::new(src_str);
            if !src.exists() {
                return Err(format!("Source file not found: {src_str}"));
            }
            let ext = src
                .extension()
                .and_then(|e| e.to_str())
                .filter(|e| e.len() <= 5)
                .unwrap_or("jpg")
                .to_lowercase();
            // Pull every file path under this identity. Order by id so
            // the "first" we pick to store is stable.
            let conn = db.lock();
            let mut stmt = conn
                .prepare(
                    "SELECT path FROM library_files
                     WHERE identity_id = ?1 AND is_missing = 0
                     ORDER BY id ASC",
                )
                .map_err(|e| format!("prepare list files: {e}"))?;
            let media_paths: Vec<String> = stmt
                .query_map(params![identity_id], |r| r.get::<_, String>(0))
                .map_err(|e| format!("query files: {e}"))?
                .filter_map(|r| r.ok())
                .collect();
            drop(stmt);
            drop(conn);
            if media_paths.is_empty() {
                return Err(
                    "No accessible video files for this identity — can't save thumbnail next to media.".into(),
                );
            }
            let mut first_thumb: Option<String> = None;
            let mut copied = 0u32;
            let mut failed = 0u32;
            for media_str in &media_paths {
                let media = std::path::Path::new(media_str);
                let Some(stem) = media.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Some(parent) = media.parent() else { continue };
                let thumb_name = format!("{stem}.fvp-thumb.{ext}");
                let dst = parent.join(&thumb_name);
                match std::fs::copy(src, &dst) {
                    Ok(_) => {
                        copied += 1;
                        if first_thumb.is_none() {
                            first_thumb =
                                Some(dst.to_string_lossy().into_owned());
                        }
                    }
                    Err(e) => {
                        failed += 1;
                        crate::log!(
                            "library",
                            "set_custom_thumbnail: failed to write {}: {e}",
                            dst.display()
                        );
                    }
                }
            }
            crate::log!(
                "library",
                "set_custom_thumbnail: identity_id={identity_id} wrote {copied}/{} sibling thumb(s) ({failed} failed)",
                media_paths.len()
            );
            if first_thumb.is_none() {
                return Err(
                    "Couldn't write the thumbnail next to any of this identity's files. Check share permissions.".into(),
                );
            }
            first_thumb
        }
    };
    let conn = db.lock();
    let manual: i64 = if stored_path.is_some() { 1 } else { 0 };
    conn.execute(
        "UPDATE library_identities
         SET custom_thumbnail_path = ?1, manual_thumbnail = ?2, last_updated_at = ?3
         WHERE id = ?4",
        params![stored_path, manual, now, identity_id],
    )
    .map_err(|e| format!("set custom thumbnail: {e}"))?;
    if path.is_none() {
        crate::log!(
            "library",
            "set_custom_thumbnail: identity_id={identity_id} cleared"
        );
    }
    Ok(())
}

/// Open a file's containing folder in the OS file explorer. Convenience
/// for "Show in Explorer" / "Reveal in Finder" right-click menus.
///
/// Windows note: `explorer.exe /select,<path>` is a single weird-looking
/// argument that std::process::Command's normal quoting mangles (it
/// double-quotes the whole thing, which Explorer parses as a literal
/// filename to open, not a /select switch). We use `raw_arg` on Windows
/// so the argument hits Explorer exactly as composed. UNC paths
/// (`\\server\share\path`) need extra-careful quoting — Explorer wants
/// the path quoted but the /select, prefix NOT quoted.
#[tauri::command]
pub fn library_reveal_in_explorer(path: String) -> Result<(), String> {
    crate::log!("library", "reveal_in_explorer: {path}");
    let p = std::path::Path::new(&path);
    let Some(parent) = p.parent() else {
        return Err("path has no parent folder".into());
    };
    if !p.exists() {
        crate::log!("library", "reveal_in_explorer: file missing");
        return Err(format!("File not found: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // raw_arg passes the string to Explorer verbatim. The space
        // between explorer and the arg is added automatically by spawn.
        // Path goes in double-quotes so spaces / parens / UNC backslashes
        // pass through cleanly; /select, prefix is NOT quoted.
        let raw = format!("/select,\"{}\"", path);
        let spawn_select = std::process::Command::new("explorer.exe")
            .raw_arg(&raw)
            .spawn();
        match spawn_select {
            Ok(_) => return Ok(()),
            Err(e) => {
                crate::log!(
                    "library",
                    "reveal_in_explorer /select failed: {e} (falling back to parent folder)"
                );
            }
        }
        // Fallback: just open the parent folder (no highlight). Better
        // than nothing if the /select form was rejected.
        if std::process::Command::new("explorer.exe")
            .raw_arg(format!("\"{}\"", parent.display()))
            .spawn()
            .is_err()
        {
            return Err("Failed to launch Explorer.".into());
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg("-R").arg(p).spawn();
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
    }
    Ok(())
}

// ── PIN + library settings ───────────────────────────────────────────

const PIN_KEY: &str = "family_view_pin_hash";
const FAMILY_VIEW_ENABLED_KEY: &str = "family_view_enabled";
const FAMILY_VIEW_ALLOWED_KEY: &str = "family_view_allowed";
const CLOCK_FORMAT_KEY: &str = "clock_format"; // "12h" or "24h"
const DELETE_DEFAULT_KEY: &str = "delete_default"; // "remove" or "recycle"

fn hash_pin(pin: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(pin.as_bytes());
    format!("{:x}", h.finalize())
}

/// True when a Family-View PIN is set. Used by Settings to gate UI state.
#[tauri::command]
pub fn library_has_pin(db: State<'_, LibraryDb>) -> Result<bool, String> {
    let conn = db.lock();
    Ok(crate::library::db::get_setting(&conn, PIN_KEY)?.is_some())
}

/// Verify a PIN without changing anything. Frontend uses this to gate
/// disabling Family View or changing the PIN itself.
#[tauri::command]
pub fn library_verify_pin(
    db: State<'_, LibraryDb>,
    pin: String,
) -> Result<bool, String> {
    let conn = db.lock();
    let Some(stored) = crate::library::db::get_setting(&conn, PIN_KEY)? else {
        // No PIN set — verification trivially succeeds (caller decides
        // whether to require a PIN before reaching this point).
        return Ok(true);
    };
    Ok(stored == hash_pin(&pin))
}

/// Set or change the PIN. When changing (PIN already set), `current_pin`
/// MUST match. When clearing, pass `new_pin = None`. Frontend should
/// validate length (4 digits) before calling.
#[tauri::command]
pub fn library_set_pin(
    db: State<'_, LibraryDb>,
    new_pin: Option<String>,
    current_pin: Option<String>,
) -> Result<(), String> {
    let conn = db.lock();
    let existing = crate::library::db::get_setting(&conn, PIN_KEY)?;
    if existing.is_some() {
        let cur = current_pin.unwrap_or_default();
        if existing.as_deref() != Some(&hash_pin(&cur)) {
            return Err("Current PIN is incorrect.".into());
        }
    }
    match new_pin {
        Some(p) => {
            if p.len() != 4 || !p.chars().all(|c| c.is_ascii_digit()) {
                return Err("PIN must be exactly 4 digits.".into());
            }
            crate::library::db::set_setting(&conn, PIN_KEY, &hash_pin(&p))?;
        }
        None => {
            // Clearing the PIN also disables Family View permission, so
            // a future un-PINed user can't have it stuck on.
            conn.execute(
                "DELETE FROM library_settings WHERE key IN (?1, ?2, ?3)",
                params![PIN_KEY, FAMILY_VIEW_ALLOWED_KEY, FAMILY_VIEW_ENABLED_KEY],
            )
            .map_err(|e| format!("clear pin: {e}"))?;
        }
    }
    Ok(())
}

/// Enable Family View capability (the feature itself, not the runtime
/// toggle). Per directive: only available when a PIN is set.
#[tauri::command]
pub fn library_set_family_view_allowed(
    db: State<'_, LibraryDb>,
    allowed: bool,
) -> Result<(), String> {
    crate::log!("library", "set_family_view_allowed → {allowed}");
    let conn = db.lock();
    if allowed && crate::library::db::get_setting(&conn, PIN_KEY)?.is_none() {
        return Err("Set a PIN first.".into());
    }
    crate::library::db::set_setting(
        &conn,
        FAMILY_VIEW_ALLOWED_KEY,
        if allowed { "1" } else { "0" },
    )?;
    Ok(())
}

/// Turn the Family View runtime toggle on/off. When turning OFF, the
/// frontend MUST have verified the PIN already (we don't double-check
/// here — caller is responsible for the gate).
#[tauri::command]
pub fn library_set_family_view_enabled(
    db: State<'_, LibraryDb>,
    enabled: bool,
) -> Result<(), String> {
    crate::log!("library", "set_family_view_enabled → {enabled}");
    let conn = db.lock();
    if enabled
        && crate::library::db::get_setting(&conn, FAMILY_VIEW_ALLOWED_KEY)?
            .as_deref()
            != Some("1")
    {
        return Err("Family View isn't allowed yet — enable it in Settings.".into());
    }
    crate::library::db::set_setting(
        &conn,
        FAMILY_VIEW_ENABLED_KEY,
        if enabled { "1" } else { "0" },
    )?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct LibrarySettingsSnapshot {
    pub has_pin: bool,
    pub family_view_allowed: bool,
    pub family_view_enabled: bool,
    pub clock_format: String,
    pub delete_default: String,
    pub poster_cache_cap_bytes: u64,
    pub poster_cache_size_bytes: u64,
}

#[tauri::command]
pub fn library_get_settings(
    db: State<'_, LibraryDb>,
    app: AppHandle,
) -> Result<LibrarySettingsSnapshot, String> {
    let conn = db.lock();
    // Pull every setting we need in one IN-list query instead of N
    // separate SELECTs.
    let mut settings: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT key, value FROM library_settings
                 WHERE key IN (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| format!("prepare settings bulk: {e}"))?;
        let rows = stmt
            .query_map(
                params![
                    PIN_KEY,
                    FAMILY_VIEW_ALLOWED_KEY,
                    FAMILY_VIEW_ENABLED_KEY,
                    CLOCK_FORMAT_KEY,
                    DELETE_DEFAULT_KEY,
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(|e| format!("query settings bulk: {e}"))?;
        for r in rows.flatten() {
            settings.insert(r.0, r.1);
        }
    }
    let has_pin = settings.contains_key(PIN_KEY);
    let family_view_allowed =
        settings.get(FAMILY_VIEW_ALLOWED_KEY).map(|s| s.as_str()) == Some("1");
    let family_view_enabled =
        settings.get(FAMILY_VIEW_ENABLED_KEY).map(|s| s.as_str()) == Some("1");
    let clock_format = settings
        .get(CLOCK_FORMAT_KEY)
        .cloned()
        .unwrap_or_else(|| "12h".to_string());
    let delete_default = settings
        .get(DELETE_DEFAULT_KEY)
        .cloned()
        .unwrap_or_else(|| "remove".to_string());
    let cap = crate::library::poster_cache::get_cap_bytes(&conn);
    drop(conn);
    let cache_dir = match app.path().app_local_data_dir() {
        Ok(d) => d.join("poster-cache"),
        Err(_) => std::path::PathBuf::new(),
    };
    // current_size_bytes is now cached internally — first call seeds it
    // by walking the dir once, subsequent calls return the running tally.
    let cache_size = crate::library::poster_cache::current_size_bytes(&cache_dir);
    Ok(LibrarySettingsSnapshot {
        has_pin,
        family_view_allowed,
        family_view_enabled,
        clock_format,
        delete_default,
        poster_cache_cap_bytes: cap,
        poster_cache_size_bytes: cache_size,
    })
}

#[tauri::command]
pub fn library_set_clock_format(
    db: State<'_, LibraryDb>,
    format: String,
) -> Result<(), String> {
    if format != "12h" && format != "24h" {
        return Err("Format must be '12h' or '24h'.".into());
    }
    let conn = db.lock();
    crate::library::db::set_setting(&conn, CLOCK_FORMAT_KEY, &format)?;
    Ok(())
}

#[tauri::command]
pub fn library_set_delete_default(
    db: State<'_, LibraryDb>,
    default: String,
) -> Result<(), String> {
    if default != "remove" && default != "recycle" {
        return Err("Default must be 'remove' or 'recycle'.".into());
    }
    let conn = db.lock();
    crate::library::db::set_setting(&conn, DELETE_DEFAULT_KEY, &default)?;
    Ok(())
}

#[tauri::command]
pub fn library_set_poster_cache_cap(
    db: State<'_, LibraryDb>,
    cap_bytes: u64,
) -> Result<(), String> {
    let conn = db.lock();
    crate::library::poster_cache::set_cap_bytes(&conn, cap_bytes)?;
    Ok(())
}

// ── Watch tracking ───────────────────────────────────────────────────

/// Resolve a video path → library_file id, if the path is indexed. The
/// frontend uses this on every file-open so the Player Mode progress
/// writer can drive the library's watch_progress_ms in the background.
/// Returns None for paths that aren't in any watched folder yet.
#[tauri::command]
pub fn library_find_file_by_path(
    db: State<'_, LibraryDb>,
    path: String,
) -> Result<Option<i64>, String> {
    let conn = db.lock();
    conn.query_row(
        "SELECT id FROM library_files WHERE path = ?1",
        params![path],
        |r| r.get::<_, i64>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("lookup file: {other}")),
    })
}

/// Persist the user's current play position. Called from the Player's
/// throttled progress writer (~every 5 s + on stop). Crossing the 75 %
/// threshold also flips `watched` so the next library refresh shows the
/// row as seen.
#[tauri::command]
pub fn library_set_watch_progress(
    db: State<'_, LibraryDb>,
    file_id: i64,
    progress_ms: i64,
) -> Result<(), String> {
    // Quieter than other commands — fires every 5s during playback, and
    // a constant stream of these would drown out interesting events.
    let now = now_unix();
    let conn = db.lock();
    // Lift the duration lookup into a CTE so the CASE doesn't subquery
    // it twice. Fires every 5s during playback — worth the cleanup.
    conn.execute(
        "WITH d AS (
            SELECT i.duration_ms AS dur
            FROM library_files f
            JOIN library_identities i ON i.id = f.identity_id
            WHERE f.id = ?3
         )
         UPDATE library_files
         SET watch_progress_ms = ?1,
             last_watched_at = ?2,
             watched = CASE
                 WHEN watched = 1 THEN 1
                 WHEN (SELECT dur FROM d) > 0
                      AND ?1 * 100 >= (SELECT dur FROM d) * 75
                 THEN 1
                 ELSE 0
             END
         WHERE id = ?3",
        params![progress_ms, now, file_id],
    )
    .map_err(|e| format!("update progress: {e}"))?;
    Ok(())
}

/// Right-click "Mark as watched" — sets the watched bit and zeroes the
/// progress (so the next play prompts to start over, not resume).
#[tauri::command]
pub fn library_mark_watched(
    db: State<'_, LibraryDb>,
    file_id: i64,
) -> Result<(), String> {
    crate::log!("library", "mark_watched file_id={file_id}");
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files
         SET watched = 1, watch_progress_ms = 0, last_watched_at = ?1
         WHERE id = ?2",
        params![now, file_id],
    )
    .map_err(|e| format!("mark watched: {e}"))?;
    Ok(())
}

/// Right-click "Reset progress" — clears watch_progress_ms AND the
/// watched flag (per directive: "if it's manually marked as having been
/// watched, or it was 'watched' per the 75% threshold, it resets").
#[tauri::command]
pub fn library_reset_progress(
    db: State<'_, LibraryDb>,
    file_id: i64,
) -> Result<(), String> {
    crate::log!("library", "reset_progress file_id={file_id}");
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files
         SET watch_progress_ms = 0, watched = 0, last_watched_at = NULL
         WHERE id = ?1",
        params![file_id],
    )
    .map_err(|e| format!("reset progress: {e}"))?;
    Ok(())
}

// ── Reconciliation engine ───────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
pub struct ProbablePair {
    pub left: LibraryRow,
    pub right: LibraryRow,
    pub signals: Vec<String>,
    pub is_likely_cut_difference: bool,
}

/// Detect identity pairs likely to be the same content. O(n^2) over the
/// identity set; for personal libraries (up to ~10k) this completes in a
/// few hundred ms. Filters out pairs the user has dismissed.
///
/// Returns at most one pair per (left, right) ordering — we sort by id so
/// the lower id is always "left" and dedupe accordingly.
#[tauri::command]
pub fn library_find_probable_pairs(
    db: State<'_, LibraryDb>,
) -> Result<Vec<ProbablePair>, String> {
    let started = std::time::Instant::now();
    let rows = crate::library::index::list_files_with_identity(&db)?;
    // Pick one representative file per identity for the engine — true
    // duplicates within an identity aren't "probable pairs", they're
    // certain matches handled by the indexer.
    //
    // CRITICAL: skip is_missing files entirely. When a user deletes a
    // file via Explorer (or the file is offline), the row stays in the
    // DB but its path is gone — surfacing it as a reconcile candidate
    // both wastes the user's time AND triggers crashes if they try to
    // act on it. If an identity has *only* missing files, the whole
    // identity is excluded from comparison.
    let mut by_identity: HashMap<i64, (crate::library::model::LibraryFile, LibraryIdentity)> =
        HashMap::new();
    for (f, i) in rows {
        if f.is_missing {
            continue;
        }
        // Skip files that live inside an OS recycle bin (Synology
        // `#recycle`, Windows `$RECYCLE.BIN`, etc.). The indexer
        // started skipping these directories outright, but pre-existing
        // rows may still reference them — this filter catches those so
        // a deleted file doesn't keep surfacing as a probable-pair
        // candidate.
        if crate::library::index::path_is_in_recycle_bin(&f.path) {
            continue;
        }
        by_identity.entry(i.id).or_insert((f, i));
    }
    let entries: Vec<(crate::library::model::LibraryFile, LibraryIdentity)> =
        by_identity.into_values().collect();

    // Pull dismissals so we can skip those pairs. Borrow handling needs
    // an outer Vec<(String, String)> so the prepared statement can drop
    // before the lock guard does (we then build the HashSet from the Vec).
    let dismissed: std::collections::HashSet<(String, String)> = {
        let conn = db.lock();
        let pairs: Vec<(String, String)> = match conn
            .prepare("SELECT fingerprint_a, fingerprint_b FROM library_dismissed_pairs")
        {
            Ok(mut stmt) => stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        pairs.into_iter().collect()
    };

    // Pull active snoozes (snooze_until > now). Same canonical-order
    // contract as dismissed pairs. Stale snoozes are ignored — we don't
    // bother garbage-collecting them, they just stop matching naturally.
    let snoozed: std::collections::HashSet<(String, String)> = {
        let now = now_unix();
        let conn = db.lock();
        let pairs: Vec<(String, String)> = match conn.prepare(
            "SELECT fingerprint_a, fingerprint_b FROM library_snoozed_pairs WHERE snooze_until > ?1",
        ) {
            Ok(mut stmt) => stmt
                .query_map(params![now], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .and_then(|it| it.collect::<Result<Vec<_>, _>>())
                .unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        pairs.into_iter().collect()
    };

    // Temporal correlation window: per-folder set of folders that had a
    // file vanish in the last N days. When two candidate identities both
    // live in such a folder, the engine adds a "temporal correlation"
    // signal — known file vanished + this one appeared in its place.
    const TEMPORAL_WINDOW_DAYS: i64 = 14;
    let temporal_cutoff = now_unix() - TEMPORAL_WINDOW_DAYS * 86_400;
    let recent_vanished_folders: std::collections::HashSet<String> = {
        let conn = db.lock();
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT path FROM library_files
                 WHERE missing_since IS NOT NULL AND missing_since >= ?1",
            )
            .map_err(|e| format!("prepare vanished: {e}"))?;
        let paths: Vec<String> = stmt
            .query_map(params![temporal_cutoff], |r| r.get::<_, String>(0))
            .map_err(|e| format!("query vanished: {e}"))?
            .filter_map(|r| r.ok())
            .collect();
        paths
            .into_iter()
            .filter_map(|p| {
                std::path::Path::new(&p)
                    .parent()
                    .map(|d| d.to_string_lossy().to_string())
            })
            .collect()
    };

    crate::log!(
        "library",
        "find_probable_pairs: scoring {} identities vs each other ({} folder(s) with recent missings)",
        entries.len(),
        recent_vanished_folders.len()
    );
    let mut out: Vec<ProbablePair> = Vec::new();
    for i in 0..entries.len() {
        for j in (i + 1)..entries.len() {
            let (left_file, left_id) = &entries[i];
            let (right_file, right_id) = &entries[j];
            // Skip dismissed pairs (canonical order: lower fingerprint first).
            let (fa, fb) = if left_id.cheap_fingerprint < right_id.cheap_fingerprint {
                (&left_id.cheap_fingerprint, &right_id.cheap_fingerprint)
            } else {
                (&right_id.cheap_fingerprint, &left_id.cheap_fingerprint)
            };
            if dismissed.contains(&(fa.clone(), fb.clone())) {
                continue;
            }
            if snoozed.contains(&(fa.clone(), fb.clone())) {
                continue;
            }
            // Either file's folder has a recently-vanished sibling → fire
            // the temporal-correlation signal. Same-folder upgrade is the
            // canonical case but cross-folder still counts (user dragged
            // the upgrade into a different organized location).
            let temporal_correlation = {
                let left_dir = std::path::Path::new(&left_file.path)
                    .parent()
                    .map(|d| d.to_string_lossy().to_string())
                    .unwrap_or_default();
                let right_dir = std::path::Path::new(&right_file.path)
                    .parent()
                    .map(|d| d.to_string_lossy().to_string())
                    .unwrap_or_default();
                recent_vanished_folders.contains(&left_dir)
                    || recent_vanished_folders.contains(&right_dir)
            };
            let verdict = crate::library::reconcile::score_identity_pair(
                left_id,
                std::path::Path::new(&left_file.path),
                left_file.resolution.as_deref(),
                left_file.codec.as_deref(),
                right_id,
                Some(std::path::Path::new(&right_file.path)),
                right_file.resolution.as_deref(),
                right_file.codec.as_deref(),
                temporal_correlation,
            );
            if verdict.band == crate::library::reconcile::MatchBand::Probable {
                let cut_diff = crate::library::reconcile::is_likely_cut_difference(
                    left_id.duration_ms as u64,
                    right_id.duration_ms as u64,
                );
                let left_row = build_row(&db, left_file.id)?;
                let right_row = build_row(&db, right_file.id)?;
                if let (Some(l), Some(r)) = (left_row, right_row) {
                    out.push(ProbablePair {
                        left: l,
                        right: r,
                        signals: verdict.signals,
                        is_likely_cut_difference: cut_diff,
                    });
                }
            }
        }
    }
    crate::log!(
        "library",
        "find_probable_pairs: {} probable pair(s) found in {:?}",
        out.len(),
        started.elapsed()
    );
    Ok(out)
}

/// Helper: load a LibraryRow by file_id. Used by reconciliation pair
/// hydration so the dialog has full poster + metadata available.
fn build_row(db: &LibraryDb, file_id: i64) -> Result<Option<LibraryRow>, String> {
    let conn = db.lock();
    let result = conn.query_row(
        "SELECT
            f.id, f.path, f.watched_folder_id, f.identity_id,
            f.size_bytes, f.modified_unix, f.resolution, f.codec,
            f.is_missing, f.watch_progress_ms, f.last_watched_at,
            f.watched, f.added_at, f.drift_warning,
            i.id, i.cheap_fingerprint, i.strong_fingerprint, i.duration_ms,
            i.tmdb_id, i.movie_title, i.movie_year, i.movie_director,
            i.movie_plot, i.movie_stars_json, i.genres_json,
            i.mpaa_rating, i.imdb_id, i.imdb_rating,
            i.poster_url, i.poster_local_path,
            i.custom_thumbnail_path, i.notes, i.family_rating,
            i.non_family_friendly, i.priority_for_profile,
            i.no_profile_necessary,
            i.manual_title, i.manual_year, i.manual_thumbnail,
            i.manual_director, i.manual_plot,
            i.first_seen_at, i.last_updated_at,
            f.has_free_sibling,
            i.maps_filtered_tier, i.maps_filtered_summary,
            i.maps_unfiltered_tier, i.maps_unfiltered_summary,
            f.has_subtitle,
            i.is_3d,
            i.is_extended
         FROM library_files f
         JOIN library_identities i ON i.id = f.identity_id
         WHERE f.id = ?1",
        params![file_id],
        |r| Ok(row_from(r)),
    );
    match result {
        Ok((file, identity)) => {
            let tags = load_tags_for(&conn, identity.id)?;
            let collections = load_collections_for(&conn, identity.id)?;
            let series = load_series_for(&conn, identity.id)?;
            let profile_status = profile_status_from_row(&file, identity.no_profile_necessary);
            Ok(Some(LibraryRow { file, identity, tags, profile_status, collections, series }))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("query row: {e}")),
    }
}

#[derive(serde::Deserialize)]
pub struct TransferChecklist {
    pub tags: bool,
    pub notes: bool,
    pub family_rating: bool,
    pub custom_thumbnail: bool,
    pub non_family_friendly: bool,
    pub priority_for_profile: bool,
    pub no_profile_necessary: bool,
    pub collections: bool,
    pub series_membership: bool,
    pub profile_link: bool,
    pub watch_history: bool,
}

/// Apply curation from `from_identity` onto `to_identity`. Watch history
/// = MERGE (union), per directive. All other fields = COPY when the
/// target's field is empty and `from`'s is non-empty (manual overrides on
/// the target win). Drift_warning is set on every file pointing to the
/// target identity so the user is forced to re-verify any .free.
#[tauri::command]
pub fn library_transfer_curation(
    db: State<'_, LibraryDb>,
    from_identity: i64,
    to_identity: i64,
    checklist: TransferChecklist,
) -> Result<(), String> {
    if from_identity == to_identity {
        return Err("Source and target are the same identity.".into());
    }
    let now = now_unix();
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;

    if checklist.tags {
        // Copy tags from source onto target (deduplicated by PK collision).
        tx.execute(
            "INSERT OR IGNORE INTO library_tags(identity_id, tag)
             SELECT ?1, tag FROM library_tags WHERE identity_id = ?2",
            params![to_identity, from_identity],
        )
        .map_err(|e| format!("copy tags: {e}"))?;
    }
    if checklist.notes
        || checklist.family_rating
        || checklist.custom_thumbnail
        || checklist.non_family_friendly
        || checklist.priority_for_profile
        || checklist.no_profile_necessary
    {
        // Per-field copy — only when source has a value AND target is empty.
        if checklist.notes {
            tx.execute(
                "UPDATE library_identities SET notes = COALESCE(notes,
                    (SELECT notes FROM library_identities WHERE id = ?2))
                 WHERE id = ?1",
                params![to_identity, from_identity],
            ).map_err(|e| format!("copy notes: {e}"))?;
        }
        if checklist.family_rating {
            tx.execute(
                "UPDATE library_identities SET family_rating = COALESCE(family_rating,
                    (SELECT family_rating FROM library_identities WHERE id = ?2))
                 WHERE id = ?1",
                params![to_identity, from_identity],
            ).map_err(|e| format!("copy family rating: {e}"))?;
        }
        if checklist.custom_thumbnail {
            tx.execute(
                "UPDATE library_identities SET custom_thumbnail_path = COALESCE(custom_thumbnail_path,
                    (SELECT custom_thumbnail_path FROM library_identities WHERE id = ?2))
                 WHERE id = ?1",
                params![to_identity, from_identity],
            ).map_err(|e| format!("copy thumbnail: {e}"))?;
        }
        if checklist.non_family_friendly {
            tx.execute(
                "UPDATE library_identities SET non_family_friendly = MAX(non_family_friendly,
                    (SELECT non_family_friendly FROM library_identities WHERE id = ?2))
                 WHERE id = ?1",
                params![to_identity, from_identity],
            ).map_err(|e| format!("copy nff: {e}"))?;
        }
        if checklist.priority_for_profile {
            tx.execute(
                "UPDATE library_identities SET priority_for_profile = MAX(priority_for_profile,
                    (SELECT priority_for_profile FROM library_identities WHERE id = ?2))
                 WHERE id = ?1",
                params![to_identity, from_identity],
            ).map_err(|e| format!("copy priority: {e}"))?;
        }
        if checklist.no_profile_necessary {
            tx.execute(
                "UPDATE library_identities SET no_profile_necessary = MAX(no_profile_necessary,
                    (SELECT no_profile_necessary FROM library_identities WHERE id = ?2))
                 WHERE id = ?1",
                params![to_identity, from_identity],
            ).map_err(|e| format!("copy no-profile-needed: {e}"))?;
        }
        tx.execute(
            "UPDATE library_identities SET last_updated_at = ?1 WHERE id = ?2",
            params![now, to_identity],
        )
        .map_err(|e| format!("bump last_updated_at: {e}"))?;
    }
    if checklist.collections {
        tx.execute(
            "INSERT OR IGNORE INTO library_collection_items(collection_id, identity_id, position)
             SELECT collection_id, ?1, position FROM library_collection_items
             WHERE identity_id = ?2",
            params![to_identity, from_identity],
        )
        .map_err(|e| format!("copy collections: {e}"))?;
    }
    if checklist.series_membership {
        tx.execute(
            "INSERT OR IGNORE INTO library_series_items(series_id, identity_id, season, position)
             SELECT series_id, ?1, season, position FROM library_series_items
             WHERE identity_id = ?2",
            params![to_identity, from_identity],
        )
        .map_err(|e| format!("copy series: {e}"))?;
    }
    if checklist.watch_history {
        // Move watch_log entries from files belonging to FROM identity
        // onto an arbitrary file of the TO identity. The log isn't shown
        // grouped today; preserving the union is the point.
        let to_file_id: Option<i64> = tx
            .query_row(
                "SELECT id FROM library_files WHERE identity_id = ?1 LIMIT 1",
                params![to_identity],
                |r| r.get(0),
            )
            .ok();
        if let Some(target_file_id) = to_file_id {
            tx.execute(
                "INSERT INTO library_watch_log(file_id, started_at, ended_at, end_progress_ms)
                 SELECT ?1, started_at, ended_at, end_progress_ms
                 FROM library_watch_log
                 WHERE file_id IN (SELECT id FROM library_files WHERE identity_id = ?2)",
                params![target_file_id, from_identity],
            )
            .map_err(|e| format!("merge watch log: {e}"))?;
        }
    }
    if checklist.profile_link {
        // Profile link is computed from .free siblings on disk (no DB
        // field). Setting drift_warning forces user re-verification per
        // directive: "Profile is copied but always lands in needs
        // re-verify state, never verified, regardless of prior state."
        tx.execute(
            "UPDATE library_files SET drift_warning = 1
             WHERE identity_id = ?1",
            params![to_identity],
        )
        .map_err(|e| format!("mark drift: {e}"))?;
    }

    tx.commit().map_err(|e| format!("commit transfer: {e}"))?;
    Ok(())
}

/// Action log channel for the frontend. Every notable user action
/// (click, drag, scope change, etc.) calls this with a short string
/// so the terminal-attached console shows causal traces alongside
/// backend events.
#[tauri::command]
pub fn library_dbg(msg: String) -> Result<(), String> {
    crate::log!("ui", "{msg}");
    Ok(())
}

/// Stop flagging a (left, right) pair as a probable match — user said
/// "not the same movie" (or explicitly chose Keep Both). Lower fingerprint
/// goes first so order-flipped re-evaluations still match.
#[tauri::command]
pub fn library_dismiss_pair(
    db: State<'_, LibraryDb>,
    fingerprint_a: String,
    fingerprint_b: String,
) -> Result<(), String> {
    let (fa, fb) = if fingerprint_a < fingerprint_b {
        (fingerprint_a, fingerprint_b)
    } else {
        (fingerprint_b, fingerprint_a)
    };
    crate::log!(
        "library",
        "dismiss_pair fp_a={}… fp_b={}…",
        &fa[..fa.len().min(8)],
        &fb[..fb.len().min(8)]
    );
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO library_dismissed_pairs(fingerprint_a, fingerprint_b, dismissed_at)
         VALUES (?1, ?2, ?3)",
        params![fa, fb, now],
    )
    .map_err(|e| format!("dismiss pair: {e}"))?;
    Ok(())
}

/// Snooze a probable pair for `hours` (default 24). Different from
/// `library_dismiss_pair` — that's permanent ("not the same movie"),
/// this is "I'll decide later, ask me in a day." find_probable_pairs
/// filters pairs whose snooze_until is in the future.
#[tauri::command]
pub fn library_snooze_pair(
    db: State<'_, LibraryDb>,
    fingerprint_a: String,
    fingerprint_b: String,
    hours: Option<i64>,
) -> Result<(), String> {
    let (fa, fb) = if fingerprint_a < fingerprint_b {
        (fingerprint_a, fingerprint_b)
    } else {
        (fingerprint_b, fingerprint_a)
    };
    let h = hours.unwrap_or(24);
    crate::log!(
        "library",
        "snooze_pair fp_a={}… fp_b={}… hours={h}",
        &fa[..fa.len().min(8)],
        &fb[..fb.len().min(8)]
    );
    let snooze_until = now_unix() + h * 3600;
    let conn = db.lock();
    conn.execute(
        "INSERT OR REPLACE INTO library_snoozed_pairs(fingerprint_a, fingerprint_b, snooze_until)
         VALUES (?1, ?2, ?3)",
        params![fa, fb, snooze_until],
    )
    .map_err(|e| format!("snooze pair: {e}"))?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct DuplicateCluster {
    pub identity_id: i64,
    pub files: Vec<LibraryRow>,
}

/// Find clusters of TRUE-duplicate files (same identity → multiple file
/// paths). Single result row per cluster, with all member files joined
/// in. The directive's "Quality variant / Different cut" cluster types
/// fall out of `library_find_probable_pairs` (PROBABLE matches); this
/// command handles the simpler "same fingerprint" case.
#[tauri::command]
pub fn library_find_duplicates(
    db: State<'_, LibraryDb>,
) -> Result<Vec<DuplicateCluster>, String> {
    let rows = crate::library::index::list_files_with_identity(&db)?;
    let mut grouped: HashMap<i64, Vec<crate::library::model::LibraryFile>> = HashMap::new();
    for (f, _) in &rows {
        // Skip files the indexer has flagged as missing on disk —
        // they're not real duplicates of anything anymore, just stale
        // DB rows waiting to be cleaned up. Including them produced
        // ghost clusters (e.g. "this missing file pairs with this real
        // file") that the user couldn't actually resolve.
        if f.is_missing {
            continue;
        }
        grouped.entry(f.identity_id).or_default().push(f.clone());
    }
    let mut out: Vec<DuplicateCluster> = Vec::new();
    for (identity_id, files) in grouped {
        if files.len() < 2 {
            continue;
        }
        let mut hydrated = Vec::new();
        for f in files {
            if let Some(row) = build_row(&db, f.id)? {
                hydrated.push(row);
            }
        }
        if hydrated.len() >= 2 {
            out.push(DuplicateCluster { identity_id, files: hydrated });
        }
    }
    Ok(out)
}

/// Comparison key for the fuzzy-duplicate matcher: strips variant
/// markers ("3D", "Extended", "Director's Cut", trailing year, etc.),
/// punctuation, and case so "Mary Poppins (1964)" and "Mary Poppins
/// 1964" hash to the same key.
///
/// No regex dep — does it with simple string scans + the existing
/// variant constants. Bit verbose but keeps Cargo.toml lean.
fn fuzzy_title_key(title: &str) -> String {
    // Lowercase + replace any non-alphanumeric with whitespace so
    // "Mary-Poppins.1964" tokenizes to ["mary", "poppins", "1964"].
    let lowered: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    // Drop year-like trailing tokens (4 digits 1900-2099) and known
    // variant words. Tokenize, filter, rejoin.
    const VARIANT_TOKENS: &[&str] = &[
        "3d",
        "extended",
        "edition",
        "director",
        "directors",
        "cut",
        "final",
        "theatrical",
        "unrated",
        "uncut",
        "special",
    ];
    lowered
        .split_whitespace()
        .filter(|tok| {
            // Drop years.
            if tok.len() == 4 && tok.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(y) = tok.parse::<u32>() {
                    if (1900..=2099).contains(&y) {
                        return false;
                    }
                }
            }
            !VARIANT_TOKENS.contains(tok)
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Levenshtein-distance based similarity score in [0, 1]. Used by
/// the fuzzy duplicate detector. 1.0 = identical strings; 0.0 = no
/// shared characters at the same positions.
fn similarity(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let alen = a.chars().count();
    let blen = b.chars().count();
    if alen == 0 || blen == 0 {
        return 0.0;
    }
    // Simple DP Levenshtein. Capped at 60 chars per side for perf —
    // movie titles never approach that.
    let a_chars: Vec<char> = a.chars().take(60).collect();
    let b_chars: Vec<char> = b.chars().take(60).collect();
    let m = a_chars.len();
    let n = b_chars.len();
    let mut prev = (0..=n).collect::<Vec<_>>();
    let mut curr = vec![0usize; n + 1];
    for i in 1..=m {
        curr[0] = i;
        for j in 1..=n {
            let cost = if a_chars[i - 1] == b_chars[j - 1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1)
                .min(curr[j - 1] + 1)
                .min(prev[j - 1] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    let dist = prev[n] as f64;
    let max_len = m.max(n) as f64;
    1.0 - dist / max_len
}

/// One side of a fuzzy-duplicate candidate pair. Includes the full
/// library row so the modal can render rich detail without a second
/// round-trip.
#[derive(serde::Serialize)]
pub struct FuzzyDupCandidate {
    pub row: LibraryRow,
}

#[derive(serde::Serialize)]
pub struct FuzzyDupPair {
    pub a: FuzzyDupCandidate,
    pub b: FuzzyDupCandidate,
    /// 0..=100 (rounded similarity*100). Used to sort high-confidence
    /// pairs to the top of the review modal.
    pub score: u32,
}

/// "Find possible duplicates" tool. Compares every pair of identities
/// by fuzzy-matched title + year. Pair is emitted when:
///   - title similarity ≥ 0.85 after stripping variant markers
///   - year within ±1 (or both null)
///   - same is_3d flag (3D releases are not duplicates of their 2D
///     counterparts — different content)
///   - same is_extended flag (Extended cut is a different release)
///   - skips rows flagged is_missing (no point reviewing what's gone)
///   - skips exact-duplicate identities (those are caught by
///     library_find_duplicates already)
///
/// Bounded at 5000 candidate pairs to keep the review modal sane on
/// large libraries; the user can re-run after resolving the first set.
#[tauri::command]
pub fn library_find_possible_duplicates(
    db: State<'_, LibraryDb>,
) -> Result<Vec<FuzzyDupPair>, String> {
    let rows = crate::library::index::list_files_with_identity(&db)?;
    // De-dupe by identity_id (we want one row per identity, picking
    // the largest file as the canonical representative).
    let mut by_identity: HashMap<i64, (crate::library::model::LibraryFile, crate::library::model::LibraryIdentity)> = HashMap::new();
    for (f, i) in rows {
        if f.is_missing {
            continue;
        }
        match by_identity.get(&i.id) {
            Some((existing_f, _)) if existing_f.size_bytes >= f.size_bytes => {}
            _ => {
                by_identity.insert(i.id, (f, i));
            }
        }
    }
    // Pre-compute fuzzy keys so we don't pay the regex cost per
    // O(N²) iteration.
    let candidates: Vec<(i64, String, Option<i64>, bool, bool)> = by_identity
        .iter()
        .map(|(id, (_, i))| {
            let title = i.movie_title.as_deref().unwrap_or("");
            (*id, fuzzy_title_key(title), i.movie_year, i.is_3d, i.is_extended)
        })
        .collect();
    const SCORE_THRESHOLD: f64 = 0.85;
    const HARD_PAIR_CAP: usize = 5000;
    let mut pairs: Vec<FuzzyDupPair> = Vec::new();
    'outer: for i in 0..candidates.len() {
        for j in (i + 1)..candidates.len() {
            let a = &candidates[i];
            let b = &candidates[j];
            if a.1.is_empty() || b.1.is_empty() {
                continue;
            }
            if a.3 != b.3 || a.4 != b.4 {
                continue;
            }
            if let (Some(ya), Some(yb)) = (a.2, b.2) {
                if (ya - yb).abs() > 1 {
                    continue;
                }
            }
            let score = similarity(&a.1, &b.1);
            if score < SCORE_THRESHOLD {
                continue;
            }
            let Some(row_a) = build_row(&db, by_identity[&a.0].0.id)? else { continue };
            let Some(row_b) = build_row(&db, by_identity[&b.0].0.id)? else { continue };
            pairs.push(FuzzyDupPair {
                a: FuzzyDupCandidate { row: row_a },
                b: FuzzyDupCandidate { row: row_b },
                score: (score * 100.0).round() as u32,
            });
            if pairs.len() >= HARD_PAIR_CAP {
                break 'outer;
            }
        }
    }
    pairs.sort_by(|x, y| y.score.cmp(&x.score));
    Ok(pairs)
}

/// Rename a file ON DISK and update the library row. Used by the
/// fuzzy-duplicate review modal's inline-rename action: the user spots
/// a mis-named copy, types a clean name, hits OK — we rename the file
/// in place (same directory, new basename) and update the DB.
#[tauri::command]
pub fn library_rename_file(
    db: State<'_, LibraryDb>,
    file_id: i64,
    new_basename: String,
) -> Result<String, String> {
    let trimmed = new_basename.trim();
    if trimmed.is_empty() {
        return Err("New name can't be empty.".into());
    }
    if trimmed.contains('\\') || trimmed.contains('/') {
        return Err("New name can't contain path separators.".into());
    }
    let conn = db.lock();
    let old_path: String = conn
        .query_row(
            "SELECT path FROM library_files WHERE id = ?1",
            params![file_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("file row missing: {e}"))?;
    drop(conn);
    let old_pb = std::path::Path::new(&old_path);
    let parent = old_pb
        .parent()
        .ok_or_else(|| "file has no parent dir".to_string())?;
    let new_path = parent.join(trimmed);
    let new_path_str = new_path
        .to_str()
        .ok_or_else(|| "new path not utf-8".to_string())?
        .to_string();
    if new_path.exists() {
        return Err(format!(
            "A file with that name already exists at {new_path_str}"
        ));
    }
    std::fs::rename(old_pb, &new_path)
        .map_err(|e| format!("rename {old_path} → {new_path_str}: {e}"))?;
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files SET path = ?1 WHERE id = ?2",
        params![new_path_str, file_id],
    )
    .map_err(|e| format!("update path: {e}"))?;
    crate::log!("library", "rename_file: {old_path} → {new_path_str}");
    Ok(new_path_str)
}

/// One image result from a Google Custom Search image query.
#[derive(serde::Serialize, Clone)]
pub struct GoogleImage {
    /// Full-resolution image URL — what we download when the user picks
    /// it as a custom thumbnail.
    pub url: String,
    /// Thumbnail (small) URL for the picker grid. Google returns these
    /// pre-resized so we don't have to fetch every full-res image just
    /// to render the chooser.
    pub thumb_url: String,
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub source_page: String,
}

/// Google Custom Search JSON API — image search. Caller passes a
/// free-form query (typically "<title> <year> movie poster"). API key
/// + Search Engine ID come from the user's Settings; both must be set
/// or we return an error the UI surfaces as "configure in Settings".
///
/// Free quota: 100 queries / day per Google Cloud project. The user
/// will hit this on a heavy cleanup pass — we expose the upstream
/// error verbatim so they know it's a quota issue rather than ours.
#[tauri::command]
pub async fn library_google_image_search(
    query: String,
    api_key: String,
    cx: String,
) -> Result<Vec<GoogleImage>, String> {
    if api_key.trim().is_empty() || cx.trim().is_empty() {
        return Err("Google API key + Search Engine ID not configured.".into());
    }
    let trimmed_q = query.trim();
    if trimmed_q.is_empty() {
        return Err("Empty search query.".into());
    }
    let q_encoded = url_encode(trimmed_q);
    let url = format!(
        "https://customsearch.googleapis.com/customsearch/v1?key={key}&cx={cx}&q={q}&searchType=image&num=10&safe=off",
        key = url_encode(&api_key),
        cx = url_encode(&cx),
        q = q_encoded,
    );
    crate::log!("library:google", "image search: {trimmed_q}");
    let resp = tauri::async_runtime::spawn_blocking(move || {
        ureq::get(&url)
            .timeout(std::time::Duration::from_secs(15))
            .call()
    })
    .await
    .map_err(|e| format!("join error: {e}"))?;
    let body = match resp {
        Ok(r) => r.into_string().map_err(|e| format!("read body: {e}"))?,
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            return Err(format!("Google CSE HTTP {code}: {body}"));
        }
        Err(e) => return Err(format!("HTTP error: {e}")),
    };
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse: {e} (body: {body})"))?;
    let items = parsed
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let out: Vec<GoogleImage> = items
        .into_iter()
        .filter_map(|it| {
            let url = it.get("link")?.as_str()?.to_string();
            let image = it.get("image")?;
            let thumb_url = image.get("thumbnailLink")?.as_str()?.to_string();
            let width = image.get("width")?.as_u64().unwrap_or(0) as u32;
            let height = image.get("height")?.as_u64().unwrap_or(0) as u32;
            let mime = it
                .get("mime")
                .and_then(|m| m.as_str())
                .unwrap_or("image/jpeg")
                .to_string();
            let source_page = it
                .get("image")
                .and_then(|i| i.get("contextLink"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();
            Some(GoogleImage {
                url,
                thumb_url,
                width,
                height,
                mime,
                source_page,
            })
        })
        .collect();
    crate::log!("library:google", "image search → {} result(s)", out.len());
    Ok(out)
}

/// Minimal URL encoder — only handles characters Google CSE actually
/// cares about. Avoids pulling in a full urlencoding crate for two
/// callers' worth of usage.
fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Download an arbitrary image URL, save it into the poster-cache
/// directory, and set it as the identity's custom_thumbnail_path so
/// it takes precedence over the TMDb poster. Returns the cached path.
/// Used by the Google CSE "Find alt poster" picker — same plumbing as
/// the existing custom-thumbnail upload, just sourced from the web.
#[tauri::command]
pub async fn library_apply_image_url(
    db: State<'_, LibraryDb>,
    app: AppHandle,
    identity_id: i64,
    image_url: String,
) -> Result<String, String> {
    if !image_url.starts_with("https://") && !image_url.starts_with("http://") {
        return Err("URL must be http(s).".into());
    }
    let url_clone = image_url.clone();
    let body: Vec<u8> = tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let resp = ureq::get(&url_clone)
            .timeout(std::time::Duration::from_secs(30))
            .call()
            .map_err(|e| format!("download {url_clone}: {e}"))?;
        let mut bytes: Vec<u8> = Vec::new();
        resp.into_reader()
            .take(20 * 1024 * 1024)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read body: {e}"))?;
        Ok::<Vec<u8>, String>(bytes)
    })
    .await
    .map_err(|e| format!("join: {e}"))??;
    if body.is_empty() {
        return Err("downloaded zero bytes".into());
    }
    // Save into the existing poster-cache directory with a content-hash
    // filename so re-downloading the same image is idempotent.
    let cache_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app data dir: {e}"))?
        .join("poster-cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("create cache dir: {e}"))?;
    let hash = blake3::hash(&body);
    // Sniff extension from MIME-by-magic. Default jpg.
    let ext = if body.starts_with(b"\x89PNG") {
        "png"
    } else if body.starts_with(b"GIF8") {
        "gif"
    } else if body.len() > 12 && &body[0..4] == b"RIFF" && &body[8..12] == b"WEBP" {
        "webp"
    } else {
        "jpg"
    };
    let filename = format!("google_{}.{ext}", hash.to_hex());
    let dest = cache_dir.join(&filename);
    std::fs::write(&dest, &body).map_err(|e| format!("write: {e}"))?;
    let dest_str = dest
        .to_str()
        .ok_or_else(|| "cache path not utf-8".to_string())?
        .to_string();
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "UPDATE library_identities
            SET custom_thumbnail_path = ?1, manual_thumbnail = 1, last_updated_at = ?2
            WHERE id = ?3",
        params![dest_str, now, identity_id],
    )
    .map_err(|e| format!("update thumbnail: {e}"))?;
    crate::log!(
        "library",
        "apply_image_url: identity {identity_id} ← {filename} ({} bytes)",
        body.len()
    );
    Ok(dest_str)
}

/// Flip the non_family_friendly flag on a collection or series.
/// Family Mode reads this column to suppress whole groups.
#[tauri::command]
pub fn library_set_scope_nff(
    db: State<'_, LibraryDb>,
    kind: String,
    id: i64,
    non_family_friendly: bool,
) -> Result<(), String> {
    let table = match kind.as_str() {
        "collection" => "library_collections",
        "series" => "library_series",
        _ => return Err(format!("unknown scope kind: {kind}")),
    };
    let conn = db.lock();
    conn.execute(
        &format!("UPDATE {table} SET non_family_friendly = ?1 WHERE id = ?2"),
        params![non_family_friendly as i64, id],
    )
    .map_err(|e| format!("set scope nff: {e}"))?;
    Ok(())
}

/// Probe one file via libmpv to read its actual resolution +
/// container-reported duration. Used by the Full Metadata Refresh
/// backfill: many old library rows have NULL resolution (the filename
/// didn't contain "1080p" etc.) and 0 duration (fingerprint never ran
/// or was interrupted). Touch each file once and fill in what's
/// missing — never overwrites an existing value, so user-curated rows
/// stay sticky.
///
/// Per-file: ~1-3s over SMB. Caller throttles by serial invocation.
#[tauri::command]
pub async fn library_probe_file(
    db: State<'_, LibraryDb>,
    file_id: i64,
) -> Result<bool, String> {
    let (path, identity_id, current_res, current_dur): (String, i64, Option<String>, i64) = {
        let conn = db.lock();
        conn.query_row(
            "SELECT f.path, f.identity_id, f.resolution, i.duration_ms
             FROM library_files f JOIN library_identities i ON i.id = f.identity_id
             WHERE f.id = ?1",
            params![file_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| format!("probe lookup: {e}"))?
    };
    // Treat marketing-label resolutions ("720p", "1080p", "4K") as
    // "needs probe" so the user gets raw WxH on the next Full
    // Metadata Refresh. They're still displayed if probing fails.
    let res_str = current_res.as_deref().unwrap_or("");
    let need_res = res_str.is_empty() || !res_str.contains('x');
    let need_dur = current_dur <= 0;
    if !need_res && !need_dur {
        return Ok(false); // nothing to do — already populated
    }
    if !std::path::Path::new(&path).exists() {
        return Ok(false);
    }
    // Transient libmpv handle. Same pattern fingerprint::compute uses
    // — vo=null, ao=null, paused — so we can read width/height/duration
    // without paying for decode setup.
    let path_clone = path.clone();
    let result: Result<(Option<String>, u64), String> = tauri::async_runtime::spawn_blocking(move || {
        use libmpv2::Mpv;
        let mpv = Mpv::with_initializer(|init| {
            init.set_option("vo", "null")?;
            init.set_option("ao", "null")?;
            init.set_option("pause", true)?;
            Ok(())
        })
        .map_err(|e| format!("libmpv init: {e:?}"))?;
        let _ = mpv.set_property("msg-level", "all=fatal");
        let handle = mpv.ctx.as_ptr();
        // Reuse the cmd_array helper from playback module's pattern.
        let cstrs = ["loadfile", path_clone.as_str()]
            .iter()
            .map(|s| std::ffi::CString::new(*s))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("CString: {e}"))?;
        let mut ptrs: Vec<*const std::os::raw::c_char> =
            cstrs.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        let code = unsafe { libmpv2_sys::mpv_command(handle, ptrs.as_ptr() as *mut _) };
        if code != 0 {
            return Err(format!("loadfile {path_clone}: code={code}"));
        }
        // Poll for properties to populate. Resolution + duration usually
        // land within ~500ms even over SMB. Cap at 8s to handle slow
        // hosts; bail early once both are set.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut w: i64 = 0;
        let mut h: i64 = 0;
        let mut dur: f64 = 0.0;
        while std::time::Instant::now() < deadline {
            if w == 0 {
                w = mpv.get_property::<i64>("dwidth").unwrap_or(0);
            }
            if h == 0 {
                h = mpv.get_property::<i64>("dheight").unwrap_or(0);
            }
            if dur <= 0.0 {
                dur = mpv.get_property::<f64>("duration").unwrap_or(0.0);
            }
            if w > 0 && h > 0 && dur > 0.0 {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        // Store raw "WxH" so the details panel can compute + display
        // the actual aspect ratio. Filename-parsed labels like "720p"
        // get backfilled to real dimensions on the next probe pass.
        let res = if w > 0 && h > 0 {
            Some(format!("{w}x{h}"))
        } else {
            None
        };
        let duration_ms = (dur * 1000.0) as u64;
        Ok((res, duration_ms))
    })
    .await
    .map_err(|e| format!("probe task join: {e}"))?;
    let (probed_res, probed_dur) = result?;
    let mut changed = false;
    let conn = db.lock();
    if need_res {
        if let Some(r) = probed_res {
            // Overwrite both empty AND filename-label values so
            // marketing labels get upgraded to raw WxH. The
            // `instr(resolution, 'x') = 0` clause skips upgrade
            // when the column already holds a WxH form (don't
            // overwrite legitimate values).
            let _ = conn.execute(
                "UPDATE library_files SET resolution = ?1
                 WHERE id = ?2
                   AND (resolution IS NULL OR resolution = '' OR instr(resolution, 'x') = 0)",
                params![r, file_id],
            );
            changed = true;
        }
    }
    if need_dur && probed_dur > 0 {
        let _ = conn.execute(
            "UPDATE library_identities SET duration_ms = ?1, last_updated_at = ?2
             WHERE id = ?3 AND (duration_ms = 0 OR duration_ms IS NULL)",
            params![probed_dur as i64, now_unix(), identity_id],
        );
        changed = true;
    }
    if changed {
        crate::log!(
            "library",
            "probe_file id={file_id}: filled missing res/dur (res_filled={}, dur_filled={})",
            need_res, need_dur
        );
    }
    Ok(changed)
}

/// Bulk-remove every file row currently flagged is_missing=1. Use case:
/// user manually deleted a bunch of files outside FVP (or via FVP's
/// trash flow followed by a rescan that confirmed they're gone), wants
/// to clean up the broken-link rows in one shot. Returns the count
/// removed so the UI can toast a confirmation. Orphan identities are
/// cascaded as a side effect (FK + the same post-delete sweep
/// library_remove_files uses).
#[tauri::command]
pub fn library_remove_broken_links(db: State<'_, LibraryDb>) -> Result<u32, String> {
    let mut conn = db.lock();
    let tx = conn.transaction().map_err(|e| format!("tx: {e}"))?;
    let removed: u32 = tx
        .execute("DELETE FROM library_files WHERE is_missing = 1", [])
        .map_err(|e| format!("delete: {e}"))? as u32;
    let _ = tx.execute(
        "DELETE FROM library_identities
         WHERE id NOT IN (SELECT DISTINCT identity_id FROM library_files)",
        [],
    );
    tx.commit().map_err(|e| format!("commit: {e}"))?;
    crate::log!("library", "remove_broken_links: removed {removed} row(s)");
    Ok(removed)
}

// ── Roulette + suggestions + drift sentinel ─────────────────────────

/// Roulette: weighted random pick from the user-supplied candidate set.
/// `file_ids` is the queue the user dragged into the tool (empty → fall
/// back to the entire library). Returns the picked row, or None when the
/// pool is empty / all candidates are family-view-blocked.
///
/// Recency weighting biases toward not-recently-watched titles per the
/// directive. Series-momentum boost adds 110% to the next unwatched item
/// in any series with a recent watch.
#[tauri::command]
pub fn library_roulette_pick(
    db: State<'_, LibraryDb>,
    file_ids: Vec<i64>,
    family_view_on: bool,
) -> Result<Option<LibraryRow>, String> {
    let all_rows = crate::library::index::list_files_with_identity(&db)?;
    let conn = db.lock();
    let pool: Vec<(LibraryFile, LibraryIdentity)> = if file_ids.is_empty() {
        all_rows
    } else {
        let want: std::collections::HashSet<i64> = file_ids.into_iter().collect();
        all_rows
            .into_iter()
            .filter(|(f, _)| want.contains(&f.id))
            .collect()
    };
    let now = now_unix();

    // Apply family-view filter at the candidate-collection stage so a
    // family-mode pick never lands on a blocked title even by random chance.
    let candidates: Vec<&(LibraryFile, LibraryIdentity)> = pool
        .iter()
        .filter(|(_, i)| !(family_view_on && i.non_family_friendly))
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }

    // Per directive: series acts as a single entity for roulette
    // purposes. Group candidates into "spin units" — one per series,
    // one per standalone identity. Each unit's weight is the MAX recency
    // weight among its members. When a series unit wins, we then pick
    // the first-unwatched episode (oldest position) as the concrete
    // file to return — so "Hogan's Heroes" winning the spin actually
    // surfaces the next episode the user hasn't seen, not a random one.
    let series_membership = load_series_membership(&conn)?;

    #[derive(Clone, Copy)]
    enum SpinUnit {
        Standalone(i64), // file_id
        Series(i64),     // series_id
    }
    let mut unit_weights: HashMap<String, (SpinUnit, f64)> = HashMap::new();
    for (f, i) in candidates.iter() {
        let recency = suggestions::recency_weight(f.last_watched_at, now);
        let (key, unit) = match series_membership.get(&i.id) {
            Some((series_id, _)) => (format!("series:{series_id}"), SpinUnit::Series(*series_id)),
            None => (format!("file:{}", f.id), SpinUnit::Standalone(f.id)),
        };
        let entry = unit_weights.entry(key).or_insert((unit, 0.0));
        if recency > entry.1 {
            entry.1 = recency;
        }
    }

    // Apply the "next unwatched in series gets 110% boost when something
    // in that series was watched recently" rule at the SERIES-unit level.
    let files: Vec<LibraryFile> = candidates.iter().map(|(f, _)| (*f).clone()).collect();
    let identities_map: HashMap<i64, LibraryIdentity> =
        candidates.iter().map(|(_, i)| (i.id, (*i).clone())).collect();
    let boosted_identities: std::collections::HashSet<i64> =
        suggestions::next_in_recently_watched_series(
            &files,
            &identities_map,
            &series_membership,
            now,
        )
        .into_iter()
        .collect();
    let boosted_series: std::collections::HashSet<i64> = boosted_identities
        .iter()
        .filter_map(|id| series_membership.get(id).map(|(sid, _)| *sid))
        .collect();
    for (_, (unit, weight)) in unit_weights.iter_mut() {
        if let SpinUnit::Series(sid) = unit {
            if boosted_series.contains(sid) {
                *weight *= 1.10;
            }
        }
    }

    // Roulette over the spin units. We hand the picker an integer-keyed
    // vector so we can map back to the chosen unit by index.
    let units_vec: Vec<(SpinUnit, f64)> = unit_weights.into_values().collect();
    let weighted: Vec<(i64, f64)> = units_vec
        .iter()
        .enumerate()
        .map(|(idx, (_, w))| (idx as i64, *w))
        .collect();
    let mut rng = rand::rngs::StdRng::from_entropy();
    let pick_idx = match suggestions::weighted_pick(&mut rng, &weighted) {
        Some(i) => i as usize,
        None => return Ok(None),
    };
    let chosen = units_vec[pick_idx].0;
    let pick_file_id = match chosen {
        SpinUnit::Standalone(file_id) => file_id,
        SpinUnit::Series(series_id) => {
            // Pick the lowest-position UNWATCHED episode in the series.
            // Fall back to the lowest-position episode if every one is
            // watched (user wants to start over).
            let mut members: Vec<(&LibraryFile, &LibraryIdentity)> = candidates
                .iter()
                .filter(|(_, i)| {
                    series_membership
                        .get(&i.id)
                        .map(|(sid, _)| *sid == series_id)
                        .unwrap_or(false)
                })
                .map(|(f, i)| (f, i))
                .collect();
            members.sort_by_key(|(_, i)| {
                series_membership.get(&i.id).map(|(_, pos)| *pos).unwrap_or(0)
            });
            let next = members.iter().find(|(f, _)| !f.watched).copied();
            let fallback = members.first().copied();
            match next.or(fallback) {
                Some((f, _)) => f.id,
                None => return Ok(None),
            }
        }
    };
    drop(conn);
    library_get_row(db, pick_file_id)
}

/// "Suggested Movie" — full-library weighted pick with don't-nag carve-out.
/// Honors the suggestion_dismissals table (a user-clicked "next" within
/// the last 7 days hides that title from rotation).
///
/// Two series-aware rules per directive:
///   - Until the user has watched at least `SERIES_WATCH_THRESHOLD` total
///     videos, series titles are excluded entirely (the user hasn't
///     established enough watching pattern for series recommendations to
///     feel earned).
///   - When we DO pick a title that belongs to a series, swap to the
///     closest-to-first-unwatched item in that series — the user almost
///     certainly wants the next chronological entry, not a random one.
#[tauri::command]
pub fn library_suggest_next(
    db: State<'_, LibraryDb>,
    family_view_on: bool,
) -> Result<Option<LibraryRow>, String> {
    const SERIES_WATCH_THRESHOLD: i64 = 12;

    let all_rows = crate::library::index::list_files_with_identity(&db)?;
    let conn = db.lock();
    let now = now_unix();

    // Total watched videos (lifetime) — drives the series-exclusion gate.
    let total_watched: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM library_files WHERE watched = 1",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let series_allowed = total_watched >= SERIES_WATCH_THRESHOLD;

    // Pull all dismissals up front so we don't query per-row.
    let mut stmt = conn
        .prepare("SELECT identity_id, dismissed_at FROM library_suggestion_dismissals")
        .map_err(|e| format!("prepare dismissals: {e}"))?;
    let dismissed: HashMap<i64, i64> = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .unwrap_or_default()
        .into_iter()
        .collect();
    drop(stmt);

    let series_membership = load_series_membership(&conn)?;
    // identity_id → series_id for quick lookup during filtering / swap.
    let identity_to_series: HashMap<i64, i64> = series_membership
        .iter()
        .map(|(id, (series_id, _))| (*id, *series_id))
        .collect();

    let candidates: Vec<&(LibraryFile, LibraryIdentity)> = all_rows
        .iter()
        .filter(|(f, i)| {
            if family_view_on && i.non_family_friendly {
                return false;
            }
            if suggestions::is_recently_dismissed(dismissed.get(&i.id).copied(), now) {
                return false;
            }
            // Don't suggest titles the user just watched (within 24h).
            if let Some(t) = f.last_watched_at {
                if now - t < 86_400 {
                    return false;
                }
            }
            // Series gate: until threshold met, exclude every series member.
            if !series_allowed && identity_to_series.contains_key(&i.id) {
                return false;
            }
            true
        })
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }

    let files: Vec<LibraryFile> = candidates.iter().map(|(f, _)| f.clone()).collect();
    let identities_map: HashMap<i64, LibraryIdentity> =
        candidates.iter().map(|(_, i)| (i.id, i.clone())).collect();
    let series_boosts: std::collections::HashSet<i64> =
        suggestions::next_in_recently_watched_series(
            &files,
            &identities_map,
            &series_membership,
            now,
        )
        .into_iter()
        .collect();

    let weighted: Vec<(i64, f64)> = candidates
        .iter()
        .map(|(f, i)| {
            let base = suggestions::recency_weight(f.last_watched_at, now);
            let boosted = if series_boosts.contains(&i.id) { base * 1.10 } else { base };
            (f.id, boosted)
        })
        .collect();

    let mut rng = rand::rngs::StdRng::from_entropy();
    let mut pick_file_id = match suggestions::weighted_pick(&mut rng, &weighted) {
        Some(id) => id,
        None => return Ok(None),
    };

    // Series-swap: if the picked file belongs to a series, jump to the
    // closest-to-first unwatched item in that series.
    if let Some((_, picked_identity)) =
        candidates.iter().find(|(f, _)| f.id == pick_file_id)
    {
        if let Some(series_id) = identity_to_series.get(&picked_identity.id).copied() {
            // Gather all files in that series, sorted by position. Pick
            // the lowest-position unwatched file as the "next" suggestion.
            let mut members: Vec<(i64, i64, bool)> = all_rows
                .iter()
                .filter_map(|(f, i)| {
                    identity_to_series.get(&i.id).and_then(|sid| {
                        if *sid == series_id {
                            // (file_id, position-in-series, watched)
                            let pos = series_membership
                                .get(&i.id)
                                .map(|(_, p)| *p)
                                .unwrap_or(0);
                            Some((f.id, pos, f.watched))
                        } else {
                            None
                        }
                    })
                })
                .collect();
            members.sort_by_key(|(_, pos, _)| *pos);
            if let Some(first_unwatched) =
                members.iter().find(|(_, _, watched)| !*watched)
            {
                if first_unwatched.0 != pick_file_id {
                    crate::log!(
                        "library:suggest",
                        "series-swap: picked file {} (series {}) → switching to first-unwatched file {}",
                        pick_file_id, series_id, first_unwatched.0
                    );
                    pick_file_id = first_unwatched.0;
                }
            }
        }
    }
    drop(conn);
    library_get_row(db, pick_file_id)
}

/// "Next" button on the suggestion — record this identity as dismissed
/// for the next 7 days so we don't surface it again immediately.
#[tauri::command]
pub fn library_dismiss_suggestion(
    db: State<'_, LibraryDb>,
    identity_id: i64,
) -> Result<(), String> {
    let now = now_unix();
    let conn = db.lock();
    conn.execute(
        "INSERT INTO library_suggestion_dismissals(identity_id, dismissed_at)
         VALUES (?1, ?2)
         ON CONFLICT(identity_id) DO UPDATE SET dismissed_at = excluded.dismissed_at",
        params![identity_id, now],
    )
    .map_err(|e| format!("dismiss: {e}"))?;
    Ok(())
}

/// Profile Creator nudge: pick the most "obvious next candidate" for a
/// new profile. V1 heuristic: pick a random priority-for-profile title;
/// if none, pick a random un-profiled title that the user hasn't
/// explicitly marked as no-profile-necessary. Bonus weight to titles
/// sharing genres with existing profiled titles (signal that the user
/// invests time on this kind of movie).
#[tauri::command]
pub fn library_profile_creator_suggest(
    db: State<'_, LibraryDb>,
    family_view_on: bool,
) -> Result<Option<LibraryRow>, String> {
    let all_rows = crate::library::index::list_files_with_identity(&db)?;
    // Read has_free_sibling for every file in ONE query — avoids the
    // per-row fs::read_dir that older versions of this command did.
    let sibling: std::collections::HashMap<i64, bool> = {
        let conn = db.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, COALESCE(has_free_sibling, 0) FROM library_files",
            )
            .map_err(|e| format!("prepare hfs: {e}"))?;
        let it = stmt
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? != 0))
            })
            .map_err(|e| format!("query hfs: {e}"))?;
        it.filter_map(|x| x.ok()).collect()
    };

    let has_profile = |f: &LibraryFile| sibling.get(&f.id).copied().unwrap_or(false);

    // Compute the "profiled genre" set from the rows whose folder has a .free.
    let profiled_genres: std::collections::HashSet<String> = all_rows
        .iter()
        .filter(|(f, _)| has_profile(f))
        .flat_map(|(_, i)| i.genres.iter().cloned().map(|g| g.to_lowercase()))
        .collect();

    let candidates: Vec<&(LibraryFile, LibraryIdentity)> = all_rows
        .iter()
        .filter(|(f, i)| {
            if family_view_on && i.non_family_friendly {
                return false;
            }
            if i.no_profile_necessary {
                return false;
            }
            !has_profile(f)
        })
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    // Priority-for-profile titles → flat 5.0 weight (huge boost). Genre
    // overlap → 2.0× per matching profiled genre, capped at 3 matches.
    let weighted: Vec<(i64, f64)> = candidates
        .iter()
        .map(|(_, i)| {
            let mut w = 1.0;
            if i.priority_for_profile {
                w *= 5.0;
            }
            let matches = i
                .genres
                .iter()
                .filter(|g| profiled_genres.contains(&g.to_lowercase()))
                .take(3)
                .count();
            w *= 1.0 + (matches as f64) * 1.0;
            (i.id, w)
        })
        .collect();
    let mut rng = rand::rngs::StdRng::from_entropy();
    let pick_identity = match suggestions::weighted_pick(&mut rng, &weighted) {
        Some(id) => id,
        None => return Ok(None),
    };
    // pick_identity is the IDENTITY id; find the first file pointing to it.
    let file_id = candidates
        .iter()
        .find(|(_, i)| i.id == pick_identity)
        .map(|(f, _)| f.id);
    let Some(fid) = file_id else { return Ok(None) };
    library_get_row(db, fid)
}

/// Acknowledge / clear the drift warning on a file — user reviewed and
/// the profile still aligns (or they updated it). Resets `drift_warning`
/// to 0; the next re-fingerprint with a different content hash would
/// flip it back on.
#[tauri::command]
pub fn library_clear_drift_warning(
    db: State<'_, LibraryDb>,
    file_id: i64,
) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "UPDATE library_files SET drift_warning = 0 WHERE id = ?1",
        params![file_id],
    )
    .map_err(|e| format!("clear drift: {e}"))?;
    Ok(())
}

/// Per-day watch / open bucket. `day` is "YYYY-MM-DD" in local time so
/// the bar charts read intuitively (no UTC-vs-local fencepost arguments).
#[derive(Debug, serde::Serialize)]
pub struct AnalyticsDailyBucket {
    pub day: String,
    pub opens: i64,
    /// Distinct file_ids opened that day.
    pub distinct_files: i64,
    /// Cumulative end_progress_ms across all "progress" events that day.
    pub watched_ms: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct AnalyticsTopRow {
    pub identity_id: i64,
    pub movie_title: Option<String>,
    pub opens: i64,
    pub watched_ms: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct AnalyticsTagSlice {
    pub tag: String,
    pub opens: i64,
    pub distinct_files: i64,
}

#[derive(Debug, serde::Serialize)]
pub struct AnalyticsSnapshot {
    /// Time-bucketed daily series, oldest → newest.
    pub daily: Vec<AnalyticsDailyBucket>,
    /// Top-N most-watched movies in the window.
    pub top_movies: Vec<AnalyticsTopRow>,
    /// Tag-sliced summary in the window.
    pub by_tag: Vec<AnalyticsTagSlice>,
    /// Total opens and watched_ms in the window — pre-aggregated so the
    /// UI doesn't have to sum the daily series.
    pub total_opens: i64,
    pub total_watched_ms: i64,
    pub total_distinct_files: i64,
}

/// Analytics rollup over a window of days, optionally restricted to a
/// specific tag. Reads from library_watch_log. Per directive's analytics
/// dashboard.
#[tauri::command]
pub fn library_analytics(
    db: State<'_, LibraryDb>,
    days: i64,
    tag: Option<String>,
) -> Result<AnalyticsSnapshot, String> {
    let days = days.clamp(1, 365 * 5);
    let now = now_unix();
    let cutoff = now - days * 86_400;
    let conn = db.lock();

    // Daily buckets — group by local date. SQLite's strftime+'unixepoch'
    // gives UTC; we apply 'localtime' so the grouping matches the user's
    // wall clock.
    let mut daily_stmt = conn
        .prepare(
            r#"
            SELECT strftime('%Y-%m-%d', started_at, 'unixepoch', 'localtime') AS day,
                   SUM(CASE WHEN event_type = 'opened' THEN 1 ELSE 0 END) AS opens,
                   COUNT(DISTINCT file_id) AS distinct_files,
                   SUM(CASE WHEN event_type = 'progress' THEN COALESCE(end_progress_ms, 0) ELSE 0 END) AS watched_ms
            FROM library_watch_log
            WHERE started_at >= ?1
              AND (?2 IS NULL OR file_id IN (
                  SELECT lf.id FROM library_files lf
                  JOIN library_identity_tags lit ON lit.identity_id = lf.identity_id
                  JOIN library_tags lt ON lt.id = lit.tag_id
                  WHERE LOWER(lt.name) = LOWER(?2)
              ))
            GROUP BY day
            ORDER BY day ASC
            "#,
        )
        .map_err(|e| format!("prepare daily: {e}"))?;
    let daily_rows = daily_stmt
        .query_map(params![cutoff, tag.as_deref()], |r| {
            Ok(AnalyticsDailyBucket {
                day: r.get(0)?,
                opens: r.get(1).unwrap_or_default(),
                distinct_files: r.get(2).unwrap_or_default(),
                watched_ms: r.get(3).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query daily: {e}"))?;
    let daily: Vec<AnalyticsDailyBucket> = daily_rows
        .filter_map(|r| r.ok())
        .collect();

    let total_opens: i64 = daily.iter().map(|d| d.opens).sum();
    let total_watched_ms: i64 = daily.iter().map(|d| d.watched_ms).sum();
    let total_distinct_files: i64 = {
        // Distinct across the whole window — can't just sum the daily
        // figure since the same file could appear on multiple days.
        let mut stmt = conn
            .prepare(
                r#"
                SELECT COUNT(DISTINCT file_id) FROM library_watch_log
                WHERE started_at >= ?1
                  AND (?2 IS NULL OR file_id IN (
                      SELECT lf.id FROM library_files lf
                      JOIN library_identity_tags lit ON lit.identity_id = lf.identity_id
                      JOIN library_tags lt ON lt.id = lit.tag_id
                      WHERE LOWER(lt.name) = LOWER(?2)
                  ))
                "#,
            )
            .map_err(|e| format!("prepare distinct: {e}"))?;
        stmt.query_row(params![cutoff, tag.as_deref()], |r| r.get::<_, i64>(0))
            .unwrap_or_default()
    };

    let mut top_stmt = conn
        .prepare(
            r#"
            SELECT li.id, li.movie_title,
                   SUM(CASE WHEN lwl.event_type = 'opened' THEN 1 ELSE 0 END) AS opens,
                   SUM(CASE WHEN lwl.event_type = 'progress' THEN COALESCE(lwl.end_progress_ms, 0) ELSE 0 END) AS watched_ms
            FROM library_watch_log lwl
            JOIN library_files lf ON lf.id = lwl.file_id
            JOIN library_identities li ON li.id = lf.identity_id
            WHERE lwl.started_at >= ?1
              AND (?2 IS NULL OR lf.id IN (
                  SELECT lf2.id FROM library_files lf2
                  JOIN library_identity_tags lit ON lit.identity_id = lf2.identity_id
                  JOIN library_tags lt ON lt.id = lit.tag_id
                  WHERE LOWER(lt.name) = LOWER(?2)
              ))
            GROUP BY li.id
            ORDER BY (opens + watched_ms / 60000) DESC
            LIMIT 10
            "#,
        )
        .map_err(|e| format!("prepare top: {e}"))?;
    let top_movies: Vec<AnalyticsTopRow> = top_stmt
        .query_map(params![cutoff, tag.as_deref()], |r| {
            Ok(AnalyticsTopRow {
                identity_id: r.get(0)?,
                movie_title: r.get(1).ok(),
                opens: r.get(2).unwrap_or_default(),
                watched_ms: r.get(3).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query top: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    let mut tag_stmt = conn
        .prepare(
            r#"
            SELECT lt.name,
                   SUM(CASE WHEN lwl.event_type = 'opened' THEN 1 ELSE 0 END) AS opens,
                   COUNT(DISTINCT lwl.file_id) AS distinct_files
            FROM library_watch_log lwl
            JOIN library_files lf ON lf.id = lwl.file_id
            JOIN library_identity_tags lit ON lit.identity_id = lf.identity_id
            JOIN library_tags lt ON lt.id = lit.tag_id
            WHERE lwl.started_at >= ?1
            GROUP BY lt.name
            ORDER BY opens DESC
            LIMIT 20
            "#,
        )
        .map_err(|e| format!("prepare tag: {e}"))?;
    let by_tag: Vec<AnalyticsTagSlice> = tag_stmt
        .query_map(params![cutoff], |r| {
            Ok(AnalyticsTagSlice {
                tag: r.get(0)?,
                opens: r.get(1).unwrap_or_default(),
                distinct_files: r.get(2).unwrap_or_default(),
            })
        })
        .map_err(|e| format!("query tag: {e}"))?
        .filter_map(|r| r.ok())
        .collect();

    Ok(AnalyticsSnapshot {
        daily,
        top_movies,
        by_tag,
        total_opens,
        total_watched_ms,
        total_distinct_files,
    })
}

fn load_series_membership(
    conn: &rusqlite::Connection,
) -> Result<HashMap<i64, (i64, i64)>, String> {
    let mut stmt = conn
        .prepare("SELECT identity_id, series_id, position FROM library_series_items")
        .map_err(|e| format!("prepare series mem: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
        })
        .map_err(|e| format!("query series mem: {e}"))?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, pair) = row.map_err(|e| format!("series mem row: {e}"))?;
        out.insert(id, pair);
    }
    Ok(out)
}

fn row_from(r: &rusqlite::Row<'_>) -> (LibraryFile, LibraryIdentity) {
    let file = LibraryFile {
        id: r.get(0).unwrap_or_default(),
        path: r.get(1).unwrap_or_default(),
        watched_folder_id: r.get(2).unwrap_or_default(),
        identity_id: r.get(3).unwrap_or_default(),
        size_bytes: r.get(4).unwrap_or_default(),
        modified_unix: r.get(5).unwrap_or_default(),
        resolution: r.get(6).ok(),
        codec: r.get(7).ok(),
        is_missing: r.get::<_, i64>(8).unwrap_or_default() != 0,
        watch_progress_ms: r.get(9).unwrap_or_default(),
        last_watched_at: r.get(10).ok(),
        watched: r.get::<_, i64>(11).unwrap_or_default() != 0,
        added_at: r.get(12).unwrap_or_default(),
        drift_warning: r.get::<_, i64>(13).unwrap_or_default() != 0,
        // Appended at SELECT index 43 (see list_files_with_identity).
        has_free_sibling: r.get::<_, Option<i64>>(43).ok().flatten().map(|v| v != 0),
        has_subtitle: r.get::<_, Option<i64>>(48).ok().flatten().map(|v| v != 0),
    };
    let movie_stars: Vec<String> = r
        .get::<_, Option<String>>(23)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let genres: Vec<String> = r
        .get::<_, Option<String>>(24)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let identity = LibraryIdentity {
        id: r.get(14).unwrap_or_default(),
        cheap_fingerprint: r.get(15).unwrap_or_default(),
        strong_fingerprint: r.get(16).ok(),
        duration_ms: r.get(17).unwrap_or_default(),
        tmdb_id: r.get(18).ok(),
        movie_title: r.get(19).ok(),
        movie_year: r.get(20).ok(),
        movie_director: r.get(21).ok(),
        movie_plot: r.get(22).ok(),
        movie_stars,
        genres,
        mpaa_rating: r.get(25).ok(),
        imdb_id: r.get(26).ok(),
        imdb_rating: r.get(27).ok(),
        poster_url: r.get(28).ok(),
        poster_local_path: r.get(29).ok(),
        custom_thumbnail_path: r.get(30).ok(),
        notes: r.get(31).ok(),
        family_rating: r.get(32).ok(),
        non_family_friendly: r.get::<_, i64>(33).unwrap_or_default() != 0,
        priority_for_profile: r.get::<_, i64>(34).unwrap_or_default() != 0,
        no_profile_necessary: r.get::<_, i64>(35).unwrap_or_default() != 0,
        manual_title: r.get::<_, i64>(36).unwrap_or_default() != 0,
        manual_year: r.get::<_, i64>(37).unwrap_or_default() != 0,
        manual_thumbnail: r.get::<_, i64>(38).unwrap_or_default() != 0,
        manual_director: r.get::<_, i64>(39).unwrap_or_default() != 0,
        manual_plot: r.get::<_, i64>(40).unwrap_or_default() != 0,
        first_seen_at: r.get(41).unwrap_or_default(),
        last_updated_at: r.get(42).unwrap_or_default(),
        maps_filtered_tier: r.get(44).ok(),
        maps_filtered_summary: r.get(45).ok(),
        maps_unfiltered_tier: r.get(46).ok(),
        maps_unfiltered_summary: r.get(47).ok(),
        is_3d: r.get::<_, i64>(49).unwrap_or_default() != 0,
        is_extended: r.get::<_, i64>(50).unwrap_or_default() != 0,
    };
    (file, identity)
}

/// Best-effort: parse a resolution string from the filename. Most
/// curated libraries embed it as "1080p", "720p", "4K", "2160p", etc.
/// Returns a canonical "WIDTHxHEIGHT" string (e.g. "1920x1080") on hit,
/// None otherwise. Used as a stopgap until we wire a real video probe.
pub fn parse_resolution_from_filename(path: &str) -> Option<String> {
    let lower = path.to_lowercase();
    // Explicit WxH ("1920x1080") — pull the first one we find.
    if let Some(m) = regex_lite_capture(&lower, r"(\d{3,4})x(\d{3,4})") {
        let (w, h) = m;
        if (640..=7680).contains(&w) && (360..=4320).contains(&h) {
            return Some(format!("{w}x{h}"));
        }
    }
    // Resolution tags. Order matters: "2160p" must beat "1080p" etc.
    let tags: &[(&str, &str)] = &[
        ("4320p", "7680x4320"),
        ("8k", "7680x4320"),
        ("2160p", "3840x2160"),
        ("4k", "3840x2160"),
        ("1440p", "2560x1440"),
        ("2k", "2048x1080"),
        ("1080p", "1920x1080"),
        ("1080i", "1920x1080"),
        ("720p", "1280x720"),
        ("720i", "1280x720"),
        ("576p", "1024x576"),
        ("480p", "854x480"),
        ("360p", "640x360"),
        ("240p", "426x240"),
    ];
    for (tag, res) in tags {
        if lower.contains(tag) {
            return Some((*res).to_string());
        }
    }
    None
}

/// Minimal regex-free capture helper for the "WxH" pattern used by
/// parse_resolution_from_filename. Avoids a regex dep for one call site.
fn regex_lite_capture(s: &str, _pat: &str) -> Option<(u32, u32)> {
    // We only need ONE pattern (\d{3,4})x(\d{3,4}), so hand-roll it.
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let w_len = i - start;
            if (3..=4).contains(&w_len) && i < bytes.len() && bytes[i] == b'x' {
                let after_x = i + 1;
                let mut j = after_x;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                let h_len = j - after_x;
                if (3..=4).contains(&h_len) {
                    let w = std::str::from_utf8(&bytes[start..i])
                        .ok()
                        .and_then(|s| s.parse::<u32>().ok());
                    let h = std::str::from_utf8(&bytes[after_x..j])
                        .ok()
                        .and_then(|s| s.parse::<u32>().ok());
                    if let (Some(w), Some(h)) = (w, h) {
                        return Some((w, h));
                    }
                }
            }
            continue;
        }
        i += 1;
    }
    None
}
