//! Library indexer — walks watched folders, computes fingerprints, runs
//! the match-confidence engine, upserts into the SQLite store. Runs on
//! its own thread. Never blocks Player Mode.
//!
//! Phase 2 will flesh this out into a real coordinator with per-folder
//! watchers + a scan queue. For Phase 1 this is the public API surface
//! (a single-folder synchronous scan helper) used by the early library
//! commands; the orchestrator wraps it in Phase 2.

use crate::library::db::LibraryDb;
use crate::library::fingerprint;
use crate::library::metadata;
use crate::library::model::{LibraryFile, LibraryIdentity};
use rusqlite::params;
use std::path::Path;
use std::time::SystemTime;

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "avi", "mov", "m4v", "webm", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts",
];

/// True when this extension is one we want to index. Case-insensitive.
pub fn is_video_extension(ext: &str) -> bool {
    VIDEO_EXTENSIONS.iter().any(|e| e.eq_ignore_ascii_case(ext))
}

/// Walk a folder (optionally recursive, up to `max_depth`) and yield
/// absolute paths of every video file. No I/O beyond enumeration —
/// fingerprinting happens later, in the indexer pass.
pub fn enumerate_videos(folder: &Path, recursive: bool, max_depth: usize) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let cap = if recursive { max_depth } else { 1 };
    walk(folder, 0, cap, &mut out);
    out
}

fn walk(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth >= max_depth {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            // Earlier versions skipped `#recycle` / `$RECYCLE.BIN` /
            // `.Trash*` subdirs — assumption: anything in them was
            // deleted-by-the-user content. That broke NAS users
            // (Synology) who keep real library content inside a folder
            // literally named `#recycle`: those files were never
            // re-enumerated, so `mark_folder_files_missing` permanently
            // flagged them as broken on every rescan. Walk every
            // directory now; the reconciliation pass still uses
            // `path_is_in_recycle_bin` to suppress probable-pair
            // suggestions for things that look like junk.
            walk(&path, depth + 1, max_depth, out);
            continue;
        }
        if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            if is_video_extension(ext) {
                out.push(path);
            }
        }
    }
}

/// True when the directory looks like an OS recycle-bin / trash
/// container. Matches by leaf folder name only — caller decides
/// whether to recurse into it. Cross-platform: Synology `#recycle`,
/// Windows `$RECYCLE.BIN`, macOS / Linux `.Trash*`.
#[allow(dead_code)]
fn is_recycle_bin_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let lower = name.to_lowercase();
    lower == "#recycle"
        || lower == "$recycle.bin"
        || lower == ".trash"
        || lower.starts_with(".trash-")
        || lower == ".trashes"
        || lower == "recycler"
}

/// True when ANY ancestor segment of the path is a recycle-bin
/// container. Used by reconciliation to filter out files that slipped
/// into the DB before we started skipping these folders, so existing
/// library rows don't keep surfacing as PROBABLE pairs.
pub fn path_is_in_recycle_bin(path: &str) -> bool {
    for seg in path.split(['\\', '/']) {
        let lower = seg.to_lowercase();
        if lower == "#recycle"
            || lower == "$recycle.bin"
            || lower == ".trash"
            || lower.starts_with(".trash-")
            || lower == ".trashes"
            || lower == "recycler"
        {
            return true;
        }
    }
    false
}

/// Index a single file: compute cheap fingerprint, parse the filename,
/// upsert into the DB. Returns (file_id, identity_id, was_new_identity).
///
/// Identity resolution:
///   1. Compute cheap fingerprint
///   2. If an identity with the same fingerprint exists → reuse it
///   3. Else create a new identity from the parsed filename
///
/// Match-confidence (PROBABLE detection) is NOT run here — that's a
/// separate pass driven by the indexer orchestrator (Phase 6). This
/// function only handles the silent CERTAIN-match path + new-row creation.
pub fn index_file(
    db: &LibraryDb,
    folder_id: i64,
    path: &Path,
) -> Result<(i64, i64, bool), String> {
    // CHEAP path FIRST: stat the file BEFORE fingerprinting. If a row
    // already exists for this exact path AND its on-disk size+mtime
    // match what we recorded last time, the content can't have changed
    // (mtime updates on any write), so we skip the multi-MB partial-hash
    // read entirely. Massive on network drives: turns "re-fingerprint
    // every file on rescan" (4-8 MB read per file × N) into a single
    // metadata syscall per file.
    let meta = std::fs::metadata(path)
        .map_err(|e| format!("metadata {}: {e}", path.display()))?;
    let size = meta.len() as i64;
    let modified_unix = meta
        .modified()
        .map_err(|e| format!("mtime: {e}"))?
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let path_str = path.to_string_lossy().to_string();

    // Probe for an existing row first. We grab a short-lived lock,
    // copy what we need out, and drop it before any I/O.
    let existing_row: Option<(i64, i64, i64, i64)> = {
        let conn = db.lock();
        conn.query_row(
            "SELECT id, identity_id, size_bytes, modified_unix FROM library_files WHERE path = ?1",
            params![&path_str],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok()
    };

    // Unchanged → just mark present + bail. No fingerprint, no identity
    // lookup, no DB write churn for identity. This is the 99% path on
    // re-scans of stable libraries.
    if let Some((file_id, identity_id, prev_size, prev_mtime)) = existing_row {
        if prev_size == size && prev_mtime == modified_unix {
            let conn = db.lock();
            // Cheapest possible UPDATE — just clear the is_missing flag
            // (set true at the start of every folder scan). Also clear
            // missing_since when the file comes back so the temporal
            // correlation window doesn't keep firing for files that
            // returned. Skip the write if it's already 0 + clear so
            // common-case rescans don't even write.
            conn.execute(
                "UPDATE library_files SET is_missing = 0, missing_since = NULL
                 WHERE id = ?1 AND (is_missing = 1 OR missing_since IS NOT NULL)",
                params![file_id],
            )
            .map_err(|e| format!("touch unchanged file: {e}"))?;
            return Ok((file_id, identity_id, false));
        }
    }

    // Changed (or new) — compute the fingerprint and proceed.
    let cheap = fingerprint::cheap_fingerprint(path)?;
    let parsed = metadata::parse_filename(path);
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let conn = db.lock();

    // 1. Find or create the identity by cheap fingerprint.
    let mut was_new_identity = false;
    let identity_id: i64 = match conn
        .query_row(
            "SELECT id FROM library_identities WHERE cheap_fingerprint = ?1",
            params![cheap],
            |r| r.get(0),
        )
        .ok()
    {
        Some(id) => id,
        None => {
            conn.execute(
                "INSERT INTO library_identities (
                    cheap_fingerprint, duration_ms, movie_title, movie_year,
                    first_seen_at, last_updated_at
                ) VALUES (?1, 0, ?2, ?3, ?4, ?4)",
                params![cheap, parsed.title, parsed.year, now],
            )
            .map_err(|e| format!("insert identity: {e}"))?;
            was_new_identity = true;
            conn.last_insert_rowid()
        }
    };

    // 2. Upsert the file row keyed by path.
    let file_id: i64 = match conn
        .query_row(
            "SELECT id, identity_id FROM library_files WHERE path = ?1",
            params![path_str],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    {
        Some((id, prev_identity)) => {
            // File row exists — refresh physical attributes + identity link.
            // If the identity changed (i.e. the file's CONTENT changed
            // under the same path) AND a .free sidecar still sits next to
            // the video, the user's profile is now timestamp-misaligned.
            // Flip drift_warning so the UI surfaces it loudly.
            let identity_changed = prev_identity != identity_id;
            let has_free_sibling = identity_changed && has_free_next_to(path);
            let drift_flag: i64 = if has_free_sibling { 1 } else { 0 };
            // Only set the flag — never clear an existing one here, since
            // a user dismissal is what clears it (see clear_drift_warning).
            if has_free_sibling {
                conn.execute(
                    "UPDATE library_files SET
                        identity_id = ?1,
                        size_bytes = ?2,
                        modified_unix = ?3,
                        is_missing = 0,
                        missing_since = NULL,
                        drift_warning = ?4
                     WHERE id = ?5",
                    params![identity_id, size, modified_unix, drift_flag, id],
                )
                .map_err(|e| format!("update file: {e}"))?;
            } else {
                conn.execute(
                    "UPDATE library_files SET
                        identity_id = ?1,
                        size_bytes = ?2,
                        modified_unix = ?3,
                        is_missing = 0,
                        missing_since = NULL
                     WHERE id = ?4",
                    params![identity_id, size, modified_unix, id],
                )
                .map_err(|e| format!("update file: {e}"))?;
            }
            id
        }
        None => {
            conn.execute(
                "INSERT INTO library_files (
                    path, watched_folder_id, identity_id, size_bytes,
                    modified_unix, added_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![path_str, folder_id, identity_id, size, modified_unix, now],
            )
            .map_err(|e| format!("insert file: {e}"))?;
            conn.last_insert_rowid()
        }
    };

    // Best-effort filename-based resolution backfill. Many curated
    // libraries embed "1080p" / "720p" / "4K" in the filename. We
    // parse it once on first-touch and only write when the column is
    // currently NULL/empty — user-curated values (or future real probe
    // results) always win.
    if let Some(res) =
        crate::commands::library::parse_resolution_from_filename(&path_str)
    {
        let _ = conn.execute(
            "UPDATE library_files
                SET resolution = ?1
                WHERE id = ?2
                  AND (resolution IS NULL OR resolution = '')",
            params![res, file_id],
        );
    }

    Ok((file_id, identity_id, was_new_identity))
}

/// True when a `.free` file (excluding the `.fvp-autosave.free` sidecar)
/// exists next to a video. Used by the drift sentinel to decide whether
/// an identity change is worth surfacing.
fn has_free_next_to(video: &Path) -> bool {
    let Some(parent) = video.parent() else { return false };
    let Some(stem) = video.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    let stem_lower = stem.to_lowercase();
    let Ok(entries) = std::fs::read_dir(parent) else { return false };
    for e in entries.flatten() {
        let p = e.path();
        let Some(ext) = p.extension().and_then(|s| s.to_str()) else { continue };
        if !ext.eq_ignore_ascii_case("free") {
            continue;
        }
        let Some(name_stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        let lower = name_stem.to_lowercase();
        if lower.ends_with(".fvp-autosave") {
            continue;
        }
        if lower.starts_with(&stem_lower) {
            return true;
        }
    }
    false
}

/// Read MAPS metadata from a `.free` file's payload, if any. Returns
/// (filtered_tier, filtered_summary, unfiltered_tier, unfiltered_summary).
/// None for any field when the file is unreadable, has no MAPS block,
/// or the JSON parse fails. Cheap on local + network drives because
/// `.free` files are tiny (single-digit KB).
fn read_maps_from_free(path: &Path) -> (Option<String>, Option<String>, Option<String>, Option<String>) {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return (None, None, None, None),
    };
    // Parse just enough to reach payload.metadata.maps_{filtered,unfiltered}.
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return (None, None, None, None),
    };
    let meta = v.get("payload").and_then(|p| p.get("metadata"));
    let pull = |key: &str| -> (Option<String>, Option<String>) {
        let block = meta.and_then(|m| m.get(key));
        let tier = block
            .and_then(|b| b.get("tier"))
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());
        let summary = block
            .and_then(|b| b.get("summary"))
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        (tier, summary)
    };
    let (ft, fs) = pull("maps_filtered");
    let (ut, us) = pull("maps_unfiltered");
    (ft, fs, ut, us)
}

/// Refresh `has_free_sibling` for every file under a watched folder. ONE
/// `read_dir` per parent directory (regardless of how many videos sit in
/// it), then a single batched UPDATE per stem. Called at the end of a
/// folder scan + by the profile-save hook.
pub fn refresh_free_siblings(db: &LibraryDb, folder_id: i64) -> Result<(), String> {
    let started = std::time::Instant::now();
    // Pull every file under this folder, grouped by parent dir.
    let paths: Vec<(i64, String)> = {
        let conn = db.lock();
        let mut stmt = conn
            .prepare("SELECT id, path FROM library_files WHERE watched_folder_id = ?1")
            .map_err(|e| format!("prepare paths: {e}"))?;
        let rows = stmt
            .query_map(params![folder_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("query paths: {e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("path row: {e}"))?);
        }
        out
    };
    if paths.is_empty() {
        return Ok(());
    }

    // Group file ids by parent dir; carry the full path so we can also
    // read MAPS from the associated .free + detect sibling subtitles.
    let mut by_dir: std::collections::HashMap<
        std::path::PathBuf,
        Vec<(i64, String, std::path::PathBuf)>,
    > = std::collections::HashMap::new();
    for (id, p) in &paths {
        let path = Path::new(p);
        if let Some(parent) = path.parent() {
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                by_dir.entry(parent.to_path_buf()).or_default().push((
                    *id,
                    stem.to_lowercase(),
                    path.to_path_buf(),
                ));
            }
        }
    }

    let dirs_scanned = by_dir.len();
    let mut updates_made = 0u32;
    let mut maps_ingested = 0u32;
    for (dir, members) in by_dir {
        // One dir-scan picks up .free names AND sub names AND maps a
        // free name → full path so MAPS ingestion doesn't re-walk.
        let mut free_stems: std::collections::HashMap<String, std::path::PathBuf> =
            std::collections::HashMap::new();
        let mut sub_stems: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let p = e.path();
                let Some(ext) = p.extension().and_then(|s| s.to_str()) else {
                    continue;
                };
                let Some(name_stem) = p.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let lower = name_stem.to_lowercase();
                if ext.eq_ignore_ascii_case("free") {
                    if lower.ends_with(".fvp-autosave") {
                        continue;
                    }
                    free_stems.insert(lower, p.clone());
                } else if ext.eq_ignore_ascii_case("srt")
                    || ext.eq_ignore_ascii_case("vtt")
                    || ext.eq_ignore_ascii_case("ass")
                    || ext.eq_ignore_ascii_case("sub")
                {
                    sub_stems.insert(lower);
                }
            }
        }
        let mut conn = db.lock();
        let tx = conn.transaction().map_err(|e| format!("hfs tx: {e}"))?;
        for (file_id, stem_lower, full_path) in members {
            // Free sibling presence + full path of the matching .free.
            let free_path = free_stems
                .iter()
                .find(|(f, _)| f.starts_with(&stem_lower))
                .map(|(_, p)| p.clone());
            let has_free = free_path.is_some();
            let new_val: i64 = if has_free { 1 } else { 0 };
            tx.execute(
                "UPDATE library_files SET has_free_sibling = ?1
                 WHERE id = ?2 AND (has_free_sibling IS NULL OR has_free_sibling != ?1)",
                params![new_val, file_id],
            )
            .map_err(|e| format!("update has_free_sibling: {e}"))?;
            updates_made += 1;

            // Subtitle presence: exact stem match OR stem-prefix-with-lang.
            let has_sub = sub_stems.iter().any(|s| {
                s == &stem_lower || s.starts_with(&format!("{stem_lower}."))
            });
            let sub_val: i64 = if has_sub { 1 } else { 0 };
            tx.execute(
                "UPDATE library_files SET has_subtitle = ?1
                 WHERE id = ?2 AND (has_subtitle IS NULL OR has_subtitle != ?1)",
                params![sub_val, file_id],
            )
            .map_err(|e| format!("update has_subtitle: {e}"))?;

            // MAPS ingestion: when a .free exists, read its metadata
            // block once and cache to library_identities.
            if let Some(free_p) = free_path {
                let (ft, fs, ut, us) = read_maps_from_free(&free_p);
                if ft.is_some() || fs.is_some() || ut.is_some() || us.is_some() {
                    tx.execute(
                        "UPDATE library_identities SET
                            maps_filtered_tier = COALESCE(?1, maps_filtered_tier),
                            maps_filtered_summary = COALESCE(?2, maps_filtered_summary),
                            maps_unfiltered_tier = COALESCE(?3, maps_unfiltered_tier),
                            maps_unfiltered_summary = COALESCE(?4, maps_unfiltered_summary)
                         WHERE id = (SELECT identity_id FROM library_files WHERE id = ?5)",
                        params![ft, fs, ut, us, file_id],
                    )
                    .map_err(|e| format!("update maps: {e}"))?;
                    maps_ingested += 1;
                }
            }
            // full_path is captured by the loop for future probing
            // (e.g. embedded subtitle detection via libmpv).
            let _ = full_path;
        }
        tx.commit().map_err(|e| format!("commit hfs tx: {e}"))?;
    }
    crate::log!(
        "library",
        "refresh_free_siblings: folder {} scanned {} parent dirs, {} file row updates ({} MAPS ingested) in {:?}",
        folder_id,
        dirs_scanned,
        updates_made,
        maps_ingested,
        started.elapsed()
    );
    Ok(())
}

/// Refresh has_free_sibling for ONE file's containing directory. Cheap;
/// used by the post-save hook when the user exports a .free in Creator
/// so the icon flips immediately without waiting for a full rescan.
pub fn refresh_free_siblings_for_path(db: &LibraryDb, video_path: &str) -> Result<(), String> {
    let path = Path::new(video_path);
    let Some(parent) = path.parent() else { return Ok(()) };
    let mut free_stems = std::collections::HashSet::new();
    if let Ok(entries) = std::fs::read_dir(parent) {
        for e in entries.flatten() {
            let p = e.path();
            let Some(ext) = p.extension().and_then(|s| s.to_str()) else {
                continue;
            };
            if !ext.eq_ignore_ascii_case("free") {
                continue;
            }
            let Some(name_stem) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let lower = name_stem.to_lowercase();
            if lower.ends_with(".fvp-autosave") {
                continue;
            }
            free_stems.insert(lower);
        }
    }
    // Find every file in this parent dir (library may have several
    // videos sharing one directory) and update each.
    let parent_str = parent.to_string_lossy().to_string();
    let conn = db.lock();
    let mut stmt = conn
        .prepare("SELECT id, path FROM library_files WHERE path LIKE ?1")
        .map_err(|e| format!("prepare hint: {e}"))?;
    let pattern = format!("{parent_str}%");
    let rows = stmt
        .query_map(params![pattern], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query hint: {e}"))?;
    let candidates: Vec<(i64, String)> = rows
        .filter_map(|r| r.ok())
        .filter(|(_, p)| {
            // Filter LIKE results down to true direct children only (not
            // grandchildren in subfolders that happen to share a prefix).
            Path::new(p).parent().map(|pp| pp == parent).unwrap_or(false)
        })
        .collect();
    drop(stmt);
    for (file_id, p) in candidates {
        let stem_lower = Path::new(&p)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let has_free = free_stems.iter().any(|f| f.starts_with(&stem_lower));
        let new_val: i64 = if has_free { 1 } else { 0 };
        let _ = conn.execute(
            "UPDATE library_files SET has_free_sibling = ?1
             WHERE id = ?2 AND (has_free_sibling IS NULL OR has_free_sibling != ?1)",
            params![new_val, file_id],
        );
    }
    Ok(())
}

/// Mark all files in a watched folder as missing — call BEFORE re-scanning
/// the folder. The scan then flips them back to present as it re-finds
/// each path; anything left missing afterwards is genuinely gone.
///
/// Stamps missing_since=now for files that aren't already tagged. This
/// gives the PROBABLE engine a clean "when did this disappear?" anchor
/// for its temporal-correlation signal. Files that have BEEN missing
/// keep their original timestamp so the window doesn't reset on every
/// rescan.
pub fn mark_folder_files_missing(db: &LibraryDb, folder_id: i64) -> Result<(), String> {
    let conn = db.lock();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "UPDATE library_files
            SET is_missing = 1,
                missing_since = COALESCE(missing_since, ?2)
            WHERE watched_folder_id = ?1",
        params![folder_id, now],
    )
    .map_err(|e| format!("mark missing: {e}"))?;
    Ok(())
}

/// Return all rows joined for the library list view. Columns added in
/// schema bumps go at the END of the SELECT — that way each helper's
/// row_from() can append a single new `r.get(N)` line without
/// renumbering every other column index. Current tail:
///   index 43 → f.has_free_sibling (v2)
///   index 44 → i.maps_filtered_tier (v4)
///   index 45 → i.maps_filtered_summary (v4)
///   index 46 → i.maps_unfiltered_tier (v4)
///   index 47 → i.maps_unfiltered_summary (v4)
///   index 48 → f.has_subtitle (v4)
pub fn list_files_with_identity(db: &LibraryDb) -> Result<Vec<(LibraryFile, LibraryIdentity)>, String> {
    let conn = db.lock();
    let mut stmt = conn
        .prepare(
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
             ORDER BY COALESCE(i.movie_title, f.path) COLLATE NOCASE",
        )
        .map_err(|e| format!("prepare list: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            let file = LibraryFile {
                id: r.get(0)?,
                path: r.get(1)?,
                watched_folder_id: r.get(2)?,
                identity_id: r.get(3)?,
                size_bytes: r.get(4)?,
                modified_unix: r.get(5)?,
                resolution: r.get(6)?,
                codec: r.get(7)?,
                is_missing: r.get::<_, i64>(8)? != 0,
                watch_progress_ms: r.get(9)?,
                last_watched_at: r.get(10)?,
                watched: r.get::<_, i64>(11)? != 0,
                added_at: r.get(12)?,
                drift_warning: r.get::<_, i64>(13)? != 0,
                has_free_sibling: r.get::<_, Option<i64>>(43)?.map(|v| v != 0),
                has_subtitle: r.get::<_, Option<i64>>(48)?.map(|v| v != 0),
            };
            let movie_stars: Vec<String> = r
                .get::<_, Option<String>>(23)?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let genres: Vec<String> = r
                .get::<_, Option<String>>(24)?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let identity = LibraryIdentity {
                id: r.get(14)?,
                cheap_fingerprint: r.get(15)?,
                strong_fingerprint: r.get(16)?,
                duration_ms: r.get(17)?,
                tmdb_id: r.get(18)?,
                movie_title: r.get(19)?,
                movie_year: r.get(20)?,
                movie_director: r.get(21)?,
                movie_plot: r.get(22)?,
                movie_stars,
                genres,
                mpaa_rating: r.get(25)?,
                imdb_id: r.get(26)?,
                imdb_rating: r.get(27)?,
                poster_url: r.get(28)?,
                poster_local_path: r.get(29)?,
                custom_thumbnail_path: r.get(30)?,
                notes: r.get(31)?,
                family_rating: r.get(32)?,
                non_family_friendly: r.get::<_, i64>(33)? != 0,
                priority_for_profile: r.get::<_, i64>(34)? != 0,
                no_profile_necessary: r.get::<_, i64>(35)? != 0,
                manual_title: r.get::<_, i64>(36)? != 0,
                manual_year: r.get::<_, i64>(37)? != 0,
                manual_thumbnail: r.get::<_, i64>(38)? != 0,
                manual_director: r.get::<_, i64>(39)? != 0,
                manual_plot: r.get::<_, i64>(40)? != 0,
                first_seen_at: r.get(41)?,
                last_updated_at: r.get(42)?,
                maps_filtered_tier: r.get(44)?,
                maps_filtered_summary: r.get(45)?,
                maps_unfiltered_tier: r.get(46)?,
                maps_unfiltered_summary: r.get(47)?,
                is_3d: r.get::<_, Option<i64>>(49)?.map(|v| v != 0).unwrap_or(false),
                is_extended: r.get::<_, Option<i64>>(50)?.map(|v| v != 0).unwrap_or(false),
            };
            Ok((file, identity))
        })
        .map_err(|e| format!("query: {e}"))?;

    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row: {e}"))?);
    }
    Ok(out)
}
