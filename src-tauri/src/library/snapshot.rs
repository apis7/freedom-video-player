//! Library Mode — weekly DB snapshot backups.
//!
//! A background tick wakes once an hour to check whether
//! `snapshot_cadence_days` has elapsed since the last successful
//! backup. When it has, we use SQLite's `VACUUM INTO` to write a
//! clean copy of the library DB to the snapshots directory, then
//! rotate — keeping only the most recent `snapshot_keep_count`.
//!
//! Snapshot destination, in priority order:
//!   1. `<home_folder>/snapshots/` (when the user has designated one)
//!   2. `$LOCALAPPDATA\com.fvp.desktop\snapshots\` (Standalone fallback)
//!
//! Snapshots contain **library metadata only** (the SQLite file):
//! tags, collections, series, watch history, identities, watched
//! folders. They do NOT contain video files (way too big) or
//! profiles/custom-thumbs (those live next to the videos and are
//! backed up by whatever's protecting the video storage).
//!
//! Restore is a manual procedure for now: stop FVP, replace
//! `library.db` with one of the `library-YYYY-MM-DD-HHMMSS.db` files
//! in the snapshots dir, relaunch. Phase 3.2 will surface a UI button
//! for this.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::library::LibraryDb;

const SNAPSHOT_ENABLED_KEY: &str = "snapshot_enabled";
const SNAPSHOT_KEEP_COUNT_KEY: &str = "snapshot_keep_count";
const SNAPSHOT_CADENCE_DAYS_KEY: &str = "snapshot_cadence_days";
const SNAPSHOT_LAST_AT_KEY: &str = "snapshot_last_at";

pub const DEFAULT_KEEP_COUNT: i64 = 3;
pub const DEFAULT_CADENCE_DAYS: i64 = 7;

static TICK_STARTED: OnceLock<()> = OnceLock::new();

/// Spin up the once-per-hour tick that decides whether to snapshot.
/// Idempotent — calling twice is a no-op. Started from setup() after
/// the DB is opened.
pub fn init(db: LibraryDb) {
    if TICK_STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || {
        // First check happens shortly after launch so a fresh install
        // gets its initial snapshot quickly. Subsequent checks are
        // hourly.
        std::thread::sleep(std::time::Duration::from_secs(60));
        loop {
            if let Err(e) = maybe_snapshot(&db) {
                crate::log!("library:snapshot", "tick: {e}");
            }
            std::thread::sleep(std::time::Duration::from_secs(60 * 60));
        }
    });
    crate::log!("library:snapshot", "tick thread started (hourly)");
}

/// Returns Ok(true) if a snapshot was taken on this call,
/// Ok(false) when not yet due (or feature disabled), Err on failure.
pub fn maybe_snapshot(db: &LibraryDb) -> Result<bool, String> {
    let (enabled, keep, cadence_days, last_at) = read_settings(db);
    if !enabled {
        return Ok(false);
    }
    let now = now_unix();
    let cadence_secs = cadence_days * 86_400;
    if last_at + cadence_secs > now {
        return Ok(false);
    }
    take_snapshot_now(db, keep)?;
    set_last_at(db, now);
    Ok(true)
}

/// Force a snapshot regardless of cadence. Exposed so the user can
/// trigger one from Settings ("Take backup now") for confidence.
pub fn force_snapshot(db: &LibraryDb) -> Result<PathBuf, String> {
    let (_, keep, _, _) = read_settings(db);
    let path = take_snapshot_now(db, keep)?;
    set_last_at(db, now_unix());
    Ok(path)
}

/// Restore the library DB from a snapshot file. Process:
///   1. Take a safety snapshot of the CURRENT DB first (so the user
///      can roll back the restore itself if needed).
///   2. Copy the snapshot file over `library.db`. SQLite has the DB
///      locked, so we write to `library.db.restore-tmp` then rename
///      it after closing all known DB handles — but since FVP holds
///      a live `LibraryDb` for the whole session, we instead require
///      the user to restart FVP after the restore. We mark a
///      restore-pending marker and copy on next boot.
///
/// The marker approach (write `library-restore-from`) keeps this
/// command single-step from the UI side — user clicks Restore, gets
/// "Quit FVP and relaunch to complete the restore" message, and on
/// next boot the marker is consumed.
pub fn schedule_restore(db: &LibraryDb, snapshot_path: &Path) -> Result<(), String> {
    if !snapshot_path.is_file() {
        return Err(format!(
            "Snapshot file not found: {}",
            snapshot_path.display()
        ));
    }
    // The marker lives next to library.db so it's automatically in
    // the same directory the boot path checks for migrations.
    let db_path = db.path();
    let marker = db_path.with_file_name("library-restore-from");
    std::fs::write(&marker, snapshot_path.to_string_lossy().as_bytes())
        .map_err(|e| format!("write restore marker: {e}"))?;
    crate::log!(
        "library:snapshot",
        "restore scheduled: marker at {} → {} (effective on next launch)",
        marker.display(),
        snapshot_path.display(),
    );
    Ok(())
}

/// Consume a pending restore marker BEFORE the DB is opened. Called
/// from setup() right before `LibraryDb::open`. Idempotent: missing
/// marker is a no-op.
///
/// Process:
///   1. Read the marker file → path to the snapshot to restore.
///   2. Stash the current library.db as `library-pre-restore-<ts>.db`
///      in the same dir (one-step undo if the restore is wrong).
///   3. Copy the snapshot over `library.db`.
///   4. Delete the marker.
pub fn consume_restore_marker(db_path: &Path) -> Result<bool, String> {
    let marker = db_path.with_file_name("library-restore-from");
    if !marker.exists() {
        return Ok(false);
    }
    let snapshot_path_bytes = std::fs::read(&marker)
        .map_err(|e| format!("read restore marker: {e}"))?;
    let snapshot_path = String::from_utf8(snapshot_path_bytes)
        .map_err(|e| format!("parse marker: {e}"))?;
    let snapshot_path = snapshot_path.trim();
    let snapshot_pb = PathBuf::from(snapshot_path);
    if !snapshot_pb.is_file() {
        // Clean up the bad marker so we don't loop on it.
        let _ = std::fs::remove_file(&marker);
        return Err(format!(
            "Restore marker points at missing file: {snapshot_path}"
        ));
    }
    // Backup the current DB before clobbering it.
    if db_path.exists() {
        let backup_name = format!(
            "library-pre-restore-{}.db",
            chrono::Local::now().format("%Y-%m-%d-%H%M%S")
        );
        let backup_path = db_path.with_file_name(backup_name);
        if let Err(e) = std::fs::copy(db_path, &backup_path) {
            crate::log!(
                "library:snapshot",
                "consume_restore_marker: pre-restore backup FAILED ({e}) — aborting restore to avoid data loss"
            );
            let _ = std::fs::remove_file(&marker);
            return Err(format!("pre-restore backup failed: {e}"));
        }
        crate::log!(
            "library:snapshot",
            "consume_restore_marker: backed up current DB to {}",
            backup_path.display()
        );
    }
    // Copy snapshot over the active DB path. WAL/SHM files from the
    // OLD DB are stale — delete them so SQLite doesn't get confused.
    let _ = std::fs::remove_file(db_path.with_extension("db-wal"));
    let _ = std::fs::remove_file(db_path.with_extension("db-shm"));
    std::fs::copy(&snapshot_pb, db_path).map_err(|e| {
        format!(
            "copy {} → {}: {e}",
            snapshot_pb.display(),
            db_path.display()
        )
    })?;
    let _ = std::fs::remove_file(&marker);
    crate::log!(
        "library:snapshot",
        "consume_restore_marker: restored from {} → {} (restart in progress)",
        snapshot_pb.display(),
        db_path.display()
    );
    Ok(true)
}

fn take_snapshot_now(db: &LibraryDb, keep: i64) -> Result<PathBuf, String> {
    let dir = effective_snapshot_dir(db);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("create snapshot dir {}: {e}", dir.display()))?;
    let path = dir.join(snapshot_filename());
    // Write to a temp file first so an interrupted backup doesn't
    // leave a half-written snapshot the rotation logic might keep.
    let tmp = path.with_extension("db.tmp");
    // VACUUM INTO is atomic from the source DB's perspective and
    // produces a clean (defragmented) copy. Faster + simpler than
    // the rusqlite Backup API for our size class.
    {
        let conn = db.lock();
        conn.execute(
            &format!(
                "VACUUM INTO '{}'",
                tmp.to_string_lossy().replace('\'', "''")
            ),
            [],
        )
        .map_err(|e| format!("VACUUM INTO {}: {e}", tmp.display()))?;
    }
    std::fs::rename(&tmp, &path)
        .map_err(|e| format!("rename {} → {}: {e}", tmp.display(), path.display()))?;
    crate::log!(
        "library:snapshot",
        "took snapshot: {} ({} bytes)",
        path.display(),
        std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0)
    );
    rotate(&dir, keep);
    Ok(path)
}

/// Delete the oldest snapshots until at most `keep` remain. "Oldest"
/// is determined by filename (timestamp-sorted) which is more
/// reliable on network shares than mtime.
fn rotate(dir: &Path, keep: i64) {
    let keep = keep.max(1) as usize;
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    let mut snaps: Vec<(String, PathBuf)> = read
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_string_lossy().into_owned();
            if name.starts_with("library-") && name.ends_with(".db") {
                Some((name, p))
            } else {
                None
            }
        })
        .collect();
    snaps.sort_by(|a, b| a.0.cmp(&b.0)); // ascending, oldest first
    while snaps.len() > keep {
        let (name, path) = snaps.remove(0);
        if let Err(e) = std::fs::remove_file(&path) {
            crate::log!(
                "library:snapshot",
                "rotate: failed to delete {name}: {e}"
            );
        } else {
            crate::log!("library:snapshot", "rotate: deleted old snapshot {name}");
        }
    }
}

/// Where snapshots get written. Prefers `<home>/snapshots/` so they
/// live on the network share alongside the poster cache; falls back
/// to `$LOCALAPPDATA\com.fvp.desktop\snapshots\` when no home folder
/// is configured.
pub fn effective_snapshot_dir(db: &LibraryDb) -> PathBuf {
    let home: Option<String> = {
        let conn = db.lock();
        crate::library::db::get_setting(&conn, "home_folder_path").ok().flatten()
    };
    if let Some(h) = home {
        let p = PathBuf::from(h);
        if p.is_dir() {
            return p.join("snapshots");
        }
    }
    let local = std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    local.join("com.fvp.desktop").join("snapshots")
}

fn snapshot_filename() -> String {
    use chrono::Local;
    let now = Local::now();
    // Sortable + readable. Filename-sort = age-sort.
    format!("library-{}.db", now.format("%Y-%m-%d-%H%M%S"))
}

fn read_settings(db: &LibraryDb) -> (bool, i64, i64, i64) {
    let conn = db.lock();
    let enabled = crate::library::db::get_setting(&conn, SNAPSHOT_ENABLED_KEY)
        .ok()
        .flatten()
        .map(|s| s != "0")
        .unwrap_or(true); // default ON per directive
    let keep = crate::library::db::get_setting(&conn, SNAPSHOT_KEEP_COUNT_KEY)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_KEEP_COUNT)
        .clamp(1, 50);
    let cadence = crate::library::db::get_setting(&conn, SNAPSHOT_CADENCE_DAYS_KEY)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_CADENCE_DAYS)
        .clamp(1, 90);
    let last_at = crate::library::db::get_setting(&conn, SNAPSHOT_LAST_AT_KEY)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    (enabled, keep, cadence, last_at)
}

fn set_last_at(db: &LibraryDb, ts: i64) {
    let conn = db.lock();
    let _ = crate::library::db::set_setting(
        &conn,
        SNAPSHOT_LAST_AT_KEY,
        &ts.to_string(),
    );
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// List current snapshots in the effective directory, newest first.
pub fn list_snapshots(db: &LibraryDb) -> Vec<SnapshotEntry> {
    let dir = effective_snapshot_dir(db);
    let Ok(read) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<SnapshotEntry> = read
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_string_lossy().into_owned();
            if !name.starts_with("library-") || !name.ends_with(".db") {
                return None;
            }
            let meta = p.metadata().ok()?;
            let modified_unix = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            Some(SnapshotEntry {
                filename: name,
                path: p.to_string_lossy().into_owned(),
                size_bytes: meta.len(),
                modified_unix,
            })
        })
        .collect();
    out.sort_by(|a, b| b.filename.cmp(&a.filename)); // newest first
    out
}

#[derive(Debug, serde::Serialize)]
pub struct SnapshotEntry {
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_unix: i64,
}

// Tauri command-facing setters (used by Settings UI).

pub fn set_enabled(db: &LibraryDb, enabled: bool) -> Result<(), String> {
    let conn = db.lock();
    crate::library::db::set_setting(
        &conn,
        SNAPSHOT_ENABLED_KEY,
        if enabled { "1" } else { "0" },
    )
}

pub fn set_keep_count(db: &LibraryDb, count: i64) -> Result<(), String> {
    let n = count.clamp(1, 50);
    let conn = db.lock();
    crate::library::db::set_setting(&conn, SNAPSHOT_KEEP_COUNT_KEY, &n.to_string())
}

pub fn set_cadence_days(db: &LibraryDb, days: i64) -> Result<(), String> {
    let n = days.clamp(1, 90);
    let conn = db.lock();
    crate::library::db::set_setting(
        &conn,
        SNAPSHOT_CADENCE_DAYS_KEY,
        &n.to_string(),
    )
}

/// Snapshot status snapshot for the Settings UI. Reads (enabled,
/// keep_count, cadence_days, last_at).
pub fn read_status(db: &LibraryDb) -> (bool, i64, i64, i64) {
    read_settings(db)
}
