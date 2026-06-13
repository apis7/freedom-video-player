//! Library Mode — Sync (passive holding-chamber model).
//!
//! Alternate architecture to the live Host/Client model. Each install
//! does ALL the library work locally; periodically writes a copy of
//! its DB to `<home>/library-sync.db`; on launch, checks the sync
//! file's mtime against the local DB and PULLS down if newer.
//!
//! Trade-offs vs Host/Client:
//!   - + No always-on Host required. Single-user, single-device works
//!     the same as Standalone.
//!   - + No lockout overlay; nothing is read-only.
//!   - + Multi-device for the SAME user works as long as you don't
//!     edit two devices simultaneously (last writer wins per-DB).
//!   - − Sync lag — changes propagate every `sync_cadence_minutes`.
//!   - − No row-level merge in V1; whole-DB replacement.
//!     Concurrent edits on the same row → last syncer wins, the
//!     other device's edits are lost. V2 will add row-level merge
//!     by `last_updated_at`.
//!
//! Background tick (`init()`) wakes every minute, checks whether the
//! cadence is due, and EITHER pushes local → sync file OR pulls
//! sync file → local DB. The pull path uses the same restore-marker
//! mechanism the snapshot module uses: it can't hot-swap the live
//! SQLite handle, so it leaves a marker and the change takes effect
//! on next launch. Push is hot — VACUUM INTO works on a live DB.
//!
//! On a launch where the sync file is newer than the local DB, we
//! consume the marker BEFORE opening the DB (mirrors snapshot's
//! consume_restore_marker behavior).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::library::LibraryDb;

const SYNC_LAST_PUSH_AT_KEY: &str = "sync_last_push_at";
const SYNC_LAST_PULL_AT_KEY: &str = "sync_last_pull_at";
const SYNC_CADENCE_MINUTES_KEY: &str = "sync_cadence_minutes";

pub const DEFAULT_CADENCE_MINUTES: i64 = 5;
pub const SYNC_FILE_NAME: &str = "library-sync.db";

static TICK_STARTED: OnceLock<()> = OnceLock::new();

/// Start the once-per-minute tick. Idempotent. Called from setup()
/// after the DB is opened. The tick respects the current mode — it's
/// a no-op when mode != "sync".
pub fn init(db: LibraryDb) {
    if TICK_STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(move || {
        // First check soon after launch so a fresh install pushes
        // its baseline DB to the sync file quickly.
        std::thread::sleep(std::time::Duration::from_secs(45));
        loop {
            if let Err(e) = maybe_tick(&db) {
                crate::log!("library:sync", "tick: {e}");
            }
            std::thread::sleep(std::time::Duration::from_secs(60));
        }
    });
    crate::log!("library:sync", "tick thread started (1-minute check loop)");
}

/// Returns Ok(true) when the tick performed a push or scheduled a
/// pull; Ok(false) when not yet due or mode is irrelevant.
///
/// Fires for BOTH "sync" mode AND "host" mode:
///   - sync mode: push local→mirror, AND pull mirror→local when
///     newer (via restore marker, effective next launch).
///   - host mode: push only. The Host's local DB is authoritative
///     (it accepts live Client writes); pulling from a Sync
///     device's mirror would clobber Client-made edits. Sync
///     devices reading the Host-pushed mirror see the live state;
///     Sync edits made while Host is online may be overwritten
///     when Host pushes next (last-writer-wins; for guaranteed
///     persistence, edits should go through the live Host).
fn maybe_tick(db: &LibraryDb) -> Result<bool, String> {
    let (mode, home, cadence_min) = read_status(db);
    if mode != "sync" && mode != "host" {
        return Ok(false);
    }
    let Some(home_str) = home else {
        return Ok(false);
    };
    let home = std::path::Path::new(&home_str);
    if !home.is_dir() {
        // Network share unreachable. Don't error noisily; next tick
        // will retry. Log once at debug level.
        crate::log!(
            "library:sync",
            "tick: home folder unreachable, skipping ({home_str})"
        );
        return Ok(false);
    }
    let now = now_unix();
    let last_push = read_setting_i64(db, SYNC_LAST_PUSH_AT_KEY);
    let next_push_due = last_push + (cadence_min * 60);
    let sync_path = home.join(SYNC_FILE_NAME);
    let mut did_something = false;

    // FRESH-DEVICE GUARD. On Device #2 joining an existing library
    // (picked the share's home folder for the first time), the
    // local DB is empty and the share has Device #1's data. Without
    // this guard the push branch below fires (last_push_at == 0 →
    // due immediately) and VACUUM INTOs the empty local DB right
    // over the share's library-sync.db — annihilating Device #1's
    // series, collections, watch history, etc.
    //
    // Trigger condition is intentionally broad: "local DB has zero
    // library_files rows AND a sync file exists." Catches both the
    // first-tick case AND the recovery case (where Device #2
    // already pushed empty and we want to back out the moment Device
    // #1 pushes real data again). We schedule a pull and return
    // WITHOUT pushing.
    //
    // Edge case: if Device #1's library is also empty, this just
    // schedules a no-op pull each tick — harmless. The first real
    // push only comes after the user has scanned at least one file.
    if mode == "sync"
        && sync_path.is_file()
        && local_db_is_empty(db)
    {
        let sync_size = std::fs::metadata(&sync_path)
            .map(|m| m.len())
            .unwrap_or(0);
        // Don't bother pulling a sync file that's obviously empty too —
        // it's just a baseline scaffold from another fresh device.
        // (~30KB is roughly the minimum SQLite file with FVP's schema.)
        if sync_size > 64 * 1024 {
            crate::log!(
                "library:sync",
                "fresh-device guard: local DB empty + sync file present ({sync_size} bytes) → pull only, push suppressed"
            );
            schedule_pull(db.path(), &sync_path)?;
            set_setting_i64(db, SYNC_LAST_PULL_AT_KEY, now);
            return Ok(true);
        }
    }

    // Push FIRST when due. This protects the user's local edits BEFORE
    // we schedule any pull. Earlier code returned out of this function
    // as soon as a pull-needed condition was detected, which meant
    // that once sync_mtime drifted past local_mtime (very easy with
    // SQLite WAL mode - writes go to .db-wal, leaving the .db mtime
    // stale), the push branch below was never reached AGAIN. Series
    // creations, custom thumbnails, and other DB mutations stayed in
    // the local file and were lost on next launch when the scheduled
    // pull restored the share's stale state.
    if now >= next_push_due {
        // Touch the local DB file BEFORE the VACUUM INTO push so its
        // mtime advances to "now". Without this, WAL-mode writes keep
        // the .db file's mtime frozen at whenever the last full
        // checkpoint was, which trips the pull-needed comparison
        // below forever. Touch is a no-op if the path doesn't exist.
        let _ = touch_file(db.path());
        push_now(db, &sync_path)?;
        set_setting_i64(db, SYNC_LAST_PUSH_AT_KEY, now);
        crate::log!(
            "library:sync",
            "push: mode={mode} → mirror written (cadence={cadence_min}min)"
        );
        did_something = true;
    }
    // Pull check is sync-mode-only and runs INDEPENDENT of the push
    // above. Both can fire in the same tick.
    if mode == "sync" && sync_path.is_file() {
        let local_mtime = mtime_unix(db.path());
        let sync_mtime = mtime_unix(&sync_path);
        // 5-second slop to absorb clock skew on SMB.
        if sync_mtime > local_mtime + 5 {
            crate::log!(
                "library:sync",
                "pull-needed: sync_mtime={sync_mtime} > local_mtime={local_mtime} — scheduling restore on next launch"
            );
            schedule_pull(db.path(), &sync_path)?;
            set_setting_i64(db, SYNC_LAST_PULL_AT_KEY, now);
            did_something = true;
        }
    }
    Ok(did_something)
}

/// Set a file's mtime to "now" without modifying its contents. Used
/// after a sync push to suppress the SQLite-WAL-mode pull-needed loop
/// (writes go to .db-wal, leaving .db's mtime frozen, so the share
/// always looks newer than local even though their content is in sync).
fn touch_file(p: &Path) -> std::io::Result<()> {
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .open(p)
        .and_then(|f| f.set_modified(std::time::SystemTime::now()));
    Ok(())
}

/// Write a fresh copy of the local DB to the sync file. Uses
/// VACUUM INTO for the same reasons the snapshot module does:
/// atomic-from-source-perspective and produces a clean (defragged)
/// copy. Writes to a `.tmp` then renames to be crash-safe.
pub fn push_now(db: &LibraryDb, sync_path: &Path) -> Result<(), String> {
    if let Some(parent) = sync_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create parent: {e}"))?;
    }
    let tmp = sync_path.with_extension("db.tmp");
    let started = std::time::Instant::now();
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
    // If the destination exists already (previous sync), rename
    // overwrites on Windows for files (atomically). std::fs::rename
    // does the right thing.
    std::fs::rename(&tmp, sync_path)
        .map_err(|e| format!("rename {} → {}: {e}", tmp.display(), sync_path.display()))?;
    crate::log!(
        "library:sync",
        "push: wrote {} in {:?} ({} bytes)",
        sync_path.display(),
        started.elapsed(),
        std::fs::metadata(sync_path).map(|m| m.len()).unwrap_or(0)
    );
    Ok(())
}

/// "Local DB has no library_files rows" — drives the fresh-device
/// pull-only guard. Cheap: indexed COUNT(*) on a single table.
fn local_db_is_empty(db: &LibraryDb) -> bool {
    let conn = db.lock();
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM library_files", [], |r| r.get(0))
        .unwrap_or(0);
    n == 0
}

/// Force a sync PULL regardless of cadence or mtime comparison.
/// UI-triggered recovery for Device #2-clobbered-share scenarios
/// where the user wants to forcibly drop local state and re-pull
/// from the share. Schedules a restore marker; the change takes
/// effect on next launch.
pub fn force_pull(db: &LibraryDb) -> Result<PathBuf, String> {
    let home = home_folder(db).ok_or_else(|| {
        "No home folder set. Pick one in Settings → Library before pulling.".to_string()
    })?;
    if !home.is_dir() {
        return Err(format!(
            "Home folder not reachable right now: {}",
            home.display()
        ));
    }
    let sync_path = home.join(SYNC_FILE_NAME);
    if !sync_path.is_file() {
        return Err(format!(
            "No sync file at {} — nothing to pull. The Host or other Sync device hasn't written one yet.",
            sync_path.display()
        ));
    }
    schedule_pull(db.path(), &sync_path)?;
    set_setting_i64(db, SYNC_LAST_PULL_AT_KEY, now_unix());
    Ok(sync_path)
}

/// Force a sync push regardless of cadence. UI-triggered.
pub fn force_push(db: &LibraryDb) -> Result<PathBuf, String> {
    let home = home_folder(db).ok_or_else(|| {
        "No home folder set. Pick one in Settings → Library before syncing.".to_string()
    })?;
    if !home.is_dir() {
        return Err(format!(
            "Home folder not reachable right now: {}",
            home.display()
        ));
    }
    let sync_path = home.join(SYNC_FILE_NAME);
    push_now(db, &sync_path)?;
    set_setting_i64(db, SYNC_LAST_PUSH_AT_KEY, now_unix());
    Ok(sync_path)
}

/// Write the restore marker so the next boot pulls this sync file
/// down. Same mechanism as snapshot::schedule_restore.
fn schedule_pull(db_path: &Path, sync_path: &Path) -> Result<(), String> {
    let marker = db_path.with_file_name("library-restore-from");
    std::fs::write(&marker, sync_path.to_string_lossy().as_bytes())
        .map_err(|e| format!("write pull marker: {e}"))?;
    crate::log!(
        "library:sync",
        "schedule_pull: marker at {} → {}",
        marker.display(),
        sync_path.display()
    );
    Ok(())
}

fn home_folder(db: &LibraryDb) -> Option<PathBuf> {
    let conn = db.lock();
    crate::library::db::get_setting(&conn, "home_folder_path")
        .ok()
        .flatten()
        .map(PathBuf::from)
}

fn read_status(db: &LibraryDb) -> (String, Option<String>, i64) {
    let conn = db.lock();
    let mode = crate::library::db::get_setting(&conn, "library_mode")
        .ok()
        .flatten()
        .unwrap_or_else(|| "standalone".to_string());
    let home = crate::library::db::get_setting(&conn, "home_folder_path")
        .ok()
        .flatten();
    let cadence = crate::library::db::get_setting(&conn, SYNC_CADENCE_MINUTES_KEY)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_CADENCE_MINUTES)
        .clamp(1, 1440);
    (mode, home, cadence)
}

fn read_setting_i64(db: &LibraryDb, key: &str) -> i64 {
    let conn = db.lock();
    crate::library::db::get_setting(&conn, key)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn set_setting_i64(db: &LibraryDb, key: &str, value: i64) {
    let conn = db.lock();
    let _ = crate::library::db::set_setting(&conn, key, &value.to_string());
}

pub fn set_cadence_minutes(db: &LibraryDb, minutes: i64) -> Result<(), String> {
    let n = minutes.clamp(1, 1440);
    let conn = db.lock();
    crate::library::db::set_setting(&conn, SYNC_CADENCE_MINUTES_KEY, &n.to_string())
}

fn mtime_unix(p: &Path) -> i64 {
    p.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, serde::Serialize)]
pub struct SyncStatus {
    pub mode_is_sync: bool,
    pub home_folder_path: Option<String>,
    pub sync_file_path: Option<String>,
    pub sync_file_exists: bool,
    pub sync_file_mtime: i64,
    pub sync_file_size_bytes: u64,
    pub local_db_mtime: i64,
    pub last_push_at: i64,
    pub last_pull_at: i64,
    pub cadence_minutes: i64,
}

pub fn read_full_status(db: &LibraryDb) -> SyncStatus {
    let (mode, home, cadence_minutes) = read_status(db);
    let home_pb = home.as_deref().map(PathBuf::from);
    let sync_path = home_pb.as_ref().map(|h| h.join(SYNC_FILE_NAME));
    let (exists, mtime, size) = match &sync_path {
        Some(p) if p.is_file() => (
            true,
            mtime_unix(p),
            std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        ),
        _ => (false, 0, 0),
    };
    SyncStatus {
        mode_is_sync: mode == "sync",
        home_folder_path: home,
        sync_file_path: sync_path.map(|p| p.to_string_lossy().into_owned()),
        sync_file_exists: exists,
        sync_file_mtime: mtime,
        sync_file_size_bytes: size,
        local_db_mtime: mtime_unix(db.path()),
        last_push_at: read_setting_i64(db, SYNC_LAST_PUSH_AT_KEY),
        last_pull_at: read_setting_i64(db, SYNC_LAST_PULL_AT_KEY),
        cadence_minutes,
    }
}
