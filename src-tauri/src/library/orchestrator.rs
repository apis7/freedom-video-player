//! Library indexing orchestrator.
//!
//! Owns:
//!   - A `HashMap<folder_id, RecommendedWatcher>` — one fs-event watcher
//!     per watched folder. Replacing/removing a folder drops its watcher.
//!   - A background worker thread + bounded job queue. Jobs are scan
//!     requests; the worker pulls one at a time and runs it to completion.
//!     This serializes all writes to the library DB and keeps CPU/disk
//!     pressure bounded regardless of how many folders are being watched.
//!
//! Coalescing: notify can fire dozens of events during a single
//! download/copy. We debounce to one scan per folder per ~750 ms quiet
//! window — that's quick enough to feel live, slow enough to avoid
//! re-scan storms.
//!
//! Progress + completion are surfaced via Tauri events so the frontend
//! can show a spinner / "N new items" toast without polling.

use crate::library::db::LibraryDb;
use crate::library::index;
use notify::event::{EventKind, ModifyKind};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use rusqlite::params;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const WATCH_DEBOUNCE_MS: u64 = 750;
/// Cooldown after a folder scan completes during which notify events
/// for that folder are IGNORED. Stops the read-triggers-rescan loop on
/// SMB shares (Windows' SMB driver reports remote-file reads as
/// `Modify::Data`, which would otherwise re-fire the scan we just
/// finished, and so on indefinitely). 60s is long enough to outlast
/// libmpv's open + demux + first seek burst on a 2-hour file but short
/// enough that genuinely new files added during the cooldown are still
/// picked up within ~a minute.
const POST_SCAN_COOLDOWN_MS: u64 = 60_000;

/// Global "is libmpv actively holding a file open?" flag, set by the
/// playback module on loadfile / cleared on unload. While true, notify
/// events fire-and-forget — we do NOT enqueue rescans. Prevents the
/// scan job from competing with playback for SMB bandwidth (a single
/// concurrent scan can drop video frames on a flaky link). Pause/seek
/// inside an already-loaded file does NOT clear the flag.
pub static PLAYBACK_HOLDS_FILE: AtomicBool = AtomicBool::new(false);

pub fn set_playback_holds_file(v: bool) {
    PLAYBACK_HOLDS_FILE.store(v, Ordering::Relaxed);
}

/// Per-loop cancellation flag for the currently-running scan. The UI
/// sets it via `library_scan_cancel`; the scan loop checks it between
/// files and bails early. Cleared automatically when a new scan starts.
static SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

/// Per-loop throttle flag. When true, the scan loop sleeps an extra
/// 30 ms between files. The UI sets it via `library_scan_throttle`.
static SCAN_THROTTLE: AtomicBool = AtomicBool::new(false);

pub fn request_scan_cancel() {
    SCAN_CANCEL.store(true, Ordering::Relaxed);
}
pub fn request_scan_throttle(on: bool) {
    SCAN_THROTTLE.store(on, Ordering::Relaxed);
}

/// One unit of work the orchestrator can be asked to do.
enum Job {
    /// Re-scan one watched folder (full enumeration + upsert).
    ScanFolder { folder_id: i64, path: PathBuf, recursive: bool },
    /// Re-scan every watched folder. When `startup_only` is true,
    /// only folders with scan_on_startup=1 are visited (used by the
    /// boot pass). When false, every watched folder is scanned (manual
    /// rescan from the UI).
    ScanAll { startup_only: bool },
}

#[derive(Default)]
struct State {
    /// Notify watchers keyed by folder id. Dropping the watcher
    /// unsubscribes automatically (RAII).
    watchers: HashMap<i64, RecommendedWatcher>,
    /// Last-event timestamp per folder — debounces noisy fs bursts so
    /// one user action doesn't trigger N scans.
    last_event_at: HashMap<i64, Instant>,
    /// Wall time of the last successful scan completion per folder.
    /// Notify events arriving within POST_SCAN_COOLDOWN_MS of this
    /// timestamp are ignored — kills the SMB-read-triggers-rescan
    /// feedback loop. Updated by `run_scan_folder` after each pass.
    last_scan_completed_at: HashMap<i64, Instant>,
}

struct Orchestrator {
    job_tx: Sender<Job>,
    state: Arc<Mutex<State>>,
}

static ORCHESTRATOR: OnceLock<Orchestrator> = OnceLock::new();

/// Initialize the orchestrator. Called once during app setup AFTER the
/// LibraryDb has been opened + managed. Spawns the worker thread.
pub fn init(app: AppHandle, db: LibraryDb) {
    if ORCHESTRATOR.get().is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<Job>();
    let state: Arc<Mutex<State>> = Arc::new(Mutex::new(State::default()));
    let worker_app = app.clone();
    let worker_db = db.clone();
    thread::spawn(move || {
        while let Ok(job) = rx.recv() {
            match job {
                Job::ScanFolder { folder_id, path, recursive } => {
                    run_scan_folder(&worker_app, &worker_db, folder_id, &path, recursive);
                }
                Job::ScanAll { startup_only } => {
                    run_scan_all(&worker_app, &worker_db, startup_only);
                }
            }
        }
    });
    let _ = ORCHESTRATOR.set(Orchestrator { job_tx: tx, state });
    // Re-attach watchers for every folder already in the DB.
    reattach_all_watchers(&db, &app);
    // Boot pass — only scans folders flagged scan_on_startup=1. Others
    // stay watched (notify still fires) but skip the boot scan.
    let _ = ORCHESTRATOR
        .get()
        .unwrap()
        .job_tx
        .send(Job::ScanAll { startup_only: true });
}

/// Queue a re-scan of one folder.
pub fn enqueue_scan_folder(folder_id: i64, path: PathBuf, recursive: bool) {
    let Some(o) = ORCHESTRATOR.get() else { return };
    let _ = o.job_tx.send(Job::ScanFolder { folder_id, path, recursive });
}

/// Queue a re-scan of every watched folder. Manual command path —
/// always scans every folder regardless of scan_on_startup.
pub fn enqueue_scan_all() {
    let Some(o) = ORCHESTRATOR.get() else { return };
    let _ = o.job_tx.send(Job::ScanAll { startup_only: false });
}

/// Queue the boot-time pass — only folders flagged scan_on_startup=1.
pub fn enqueue_scan_startup() {
    let Some(o) = ORCHESTRATOR.get() else { return };
    let _ = o.job_tx.send(Job::ScanAll { startup_only: true });
}

/// Start watching a folder. Idempotent — re-registers the watcher if one
/// is already present (cheap; drops the old one first).
pub fn watch_folder(folder_id: i64, path: PathBuf, app: AppHandle) -> Result<(), String> {
    let Some(o) = ORCHESTRATOR.get() else {
        return Err("orchestrator not initialized".into());
    };
    let state_for_cb = o.state.clone();
    let app_for_cb = app.clone();
    let path_for_cb = path.clone();
    let folder_id_for_cb = folder_id;

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            // Hard mute while libmpv is holding a file open. SMB drivers
            // report remote reads as Modify::Data events, which would
            // otherwise re-trigger the scan we just finished and steal
            // bandwidth from the active playback (drops video frames,
            // hangs UI under bandwidth pressure).
            if PLAYBACK_HOLDS_FILE.load(Ordering::Relaxed) {
                return;
            }
            // Filter to event kinds that ACTUALLY change the file SET.
            // atime updates show up as Modify::Metadata — discarded.
            let interesting = matches!(
                ev.kind,
                EventKind::Create(_)
                    | EventKind::Remove(_)
                    | EventKind::Modify(ModifyKind::Data(_))
                    | EventKind::Modify(ModifyKind::Name(_))
            );
            if !interesting {
                return;
            }
            let now = Instant::now();
            {
                let mut s = state_for_cb.lock();
                // Post-scan cooldown — within POST_SCAN_COOLDOWN_MS of
                // the last completed scan for THIS folder, ignore any
                // event. Closes the read-triggers-rescan loop even when
                // PLAYBACK_HOLDS_FILE is not set (e.g. fingerprint /
                // profile-scan reads that complete before loadfile).
                if let Some(last_scan_end) = s.last_scan_completed_at.get(&folder_id_for_cb).copied() {
                    if last_scan_end.elapsed().as_millis() < POST_SCAN_COOLDOWN_MS as u128 {
                        return;
                    }
                }
                let last = s
                    .last_event_at
                    .get(&folder_id_for_cb)
                    .copied()
                    .unwrap_or_else(|| now - Duration::from_secs(60));
                s.last_event_at.insert(folder_id_for_cb, now);
                if now.duration_since(last).as_millis() < WATCH_DEBOUNCE_MS as u128 {
                    return;
                }
            }
            // Schedule a fire after the debounce window; if more events
            // come in we'll keep updating last_event_at and only the
            // last scheduled fire will actually enqueue.
            let app2 = app_for_cb.clone();
            let path2 = path_for_cb.clone();
            let state2 = state_for_cb.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(WATCH_DEBOUNCE_MS));
                let s = state2.lock();
                if let Some(last) = s.last_event_at.get(&folder_id_for_cb).copied() {
                    if last.elapsed() < Duration::from_millis(WATCH_DEBOUNCE_MS / 2) {
                        // A newer event came in; let it schedule the scan.
                        return;
                    }
                }
                drop(s);
                let _ = app2.emit(
                    "library:folder-changed",
                    serde_json::json!({ "folder_id": folder_id_for_cb }),
                );
                enqueue_scan_folder(folder_id_for_cb, path2, true);
            });
        },
        Config::default(),
    )
    .map_err(|e| format!("create watcher: {e}"))?;

    watcher
        .watch(&path, RecursiveMode::Recursive)
        .map_err(|e| format!("watch {}: {e}", path.display()))?;

    let mut s = o.state.lock();
    s.watchers.insert(folder_id, watcher);
    Ok(())
}

/// Stop watching a folder. Called when the user removes it from settings.
pub fn unwatch_folder(folder_id: i64) {
    if let Some(o) = ORCHESTRATOR.get() {
        let mut s = o.state.lock();
        s.watchers.remove(&folder_id);
        s.last_event_at.remove(&folder_id);
    }
}

fn reattach_all_watchers(db: &LibraryDb, app: &AppHandle) {
    let conn = db.lock();
    let mut stmt = match conn.prepare("SELECT id, path FROM watched_folders") {
        Ok(s) => s,
        Err(e) => {
            crate::log!("library", "reattach: prepare failed: {e}");
            return;
        }
    };
    let rows: Vec<(i64, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .unwrap_or_default();
    drop(stmt);
    drop(conn);
    for (id, path) in rows {
        let pb = PathBuf::from(&path);
        if !pb.is_dir() {
            crate::log!("library", "folder {id} missing from disk: {path}");
            continue;
        }
        if let Err(e) = watch_folder(id, pb, app.clone()) {
            crate::log!("library", "reattach watcher for {id} failed: {e}");
        }
    }
}

fn run_scan_folder(
    app: &AppHandle,
    db: &LibraryDb,
    folder_id: i64,
    path: &std::path::Path,
    recursive: bool,
) {
    let started = Instant::now();
    crate::log!(
        "library:scan",
        "BEGIN folder_id={folder_id} path={} recursive={recursive}",
        path.display()
    );
    let _ = app.emit(
        "library:scan-started",
        serde_json::json!({ "folder_id": folder_id }),
    );
    if let Err(e) = index::mark_folder_files_missing(db, folder_id) {
        crate::log!("library", "mark missing failed: {e}");
    }
    crate::log!("library:scan", "enumerating videos under {}", path.display());
    let enumerate_start = Instant::now();
    let files = index::enumerate_videos(path, recursive, 8);
    let total = files.len();
    crate::log!(
        "library:scan",
        "enumerated {total} video files in {:?}",
        enumerate_start.elapsed()
    );
    // Fresh scan — clear any stale cancel flag the user may have set.
    SCAN_CANCEL.store(false, Ordering::Relaxed);
    let mut new_items = 0u32;
    let mut skipped_unchanged = 0u32;
    let mut last_progress_log = Instant::now();
    for (i, file_path) in files.iter().enumerate() {
        // Check cancel flag between files. The user may have hit the
        // Cancel button in the scan-progress badge; bail out cleanly.
        if SCAN_CANCEL.load(Ordering::Relaxed) {
            crate::log!(
                "library:scan",
                "CANCELLED at {}/{} for folder {folder_id}",
                i,
                total
            );
            let _ = app.emit(
                "library:scan-cancelled",
                serde_json::json!({ "folder_id": folder_id }),
            );
            break;
        }
        // Throttle: when the user has explicitly asked us to slow down,
        // sleep a small fixed amount between files. 30 ms × 1000 files
        // = 30 seconds added per 1000-file folder — noticeable for the
        // user but lets responsiveness of the rest of the app recover.
        if SCAN_THROTTLE.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(30));
        }
        // Log every 100 files OR every 10 seconds, whichever comes first,
        // so a user staring at the terminal sees progress on big libraries.
        if i % 100 == 0 || last_progress_log.elapsed() >= Duration::from_secs(10) {
            crate::log!(
                "library:scan",
                "indexing {}/{total} ({} new, {} unchanged so far) — current: {}",
                i + 1,
                new_items,
                skipped_unchanged,
                file_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
            );
            last_progress_log = Instant::now();
        }
        match index::index_file(db, folder_id, file_path) {
            Ok((_, identity_id, was_new)) => {
                if was_new {
                    new_items += 1;
                    crate::library::enrich::enqueue(identity_id);
                } else {
                    skipped_unchanged += 1;
                }
            }
            Err(e) => {
                crate::log!(
                    "library:scan",
                    "index FAILED for {}: {e}",
                    file_path.display()
                );
            }
        }
        if i % 20 == 0 || i + 1 == total {
            // Include the basename of the file currently being indexed
            // so the UI badge can show context ("Scanning: The Dark
            // Knight.mkv") instead of just a counter. Full UNC paths
            // can be long; a basename is plenty for the progress ribbon.
            let basename = file_path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let _ = app.emit(
                "library:scan-progress",
                serde_json::json!({
                    "folder_id": folder_id,
                    "scanned": i + 1,
                    "total": total,
                    "current_file": basename,
                }),
            );
        }
    }
    crate::log!(
        "library:scan",
        "indexing done in {:?} — {} files, {} new identities, {} unchanged (skipped fingerprint)",
        started.elapsed(),
        total,
        new_items,
        skipped_unchanged
    );
    // After every scan, refresh the cached has_free_sibling column for
    // every file in this folder. This is the one expensive .free dir
    // walk; subsequent list_items calls read from the DB only.
    if let Err(e) = index::refresh_free_siblings(db, folder_id) {
        crate::log!("library", "refresh_free_siblings failed: {e}");
    }
    let _ = app.emit(
        "library:scan-done",
        serde_json::json!({
            "folder_id": folder_id,
            "scanned": total,
            "new_items": new_items,
            "duration_ms": started.elapsed().as_millis() as u64,
        }),
    );
    // Loud per-folder summary so users staring at the terminal see one
    // unambiguous "scan finished" line with key counts + duration.
    let elapsed = started.elapsed();
    let throughput = if elapsed.as_secs() > 0 {
        total as f64 / elapsed.as_secs_f64()
    } else {
        total as f64
    };
    crate::log!(
        "library:scan",
        "==== folder {folder_id} DONE: {total} files in {:?} ({:.1} files/s, {} new, {} unchanged) ====",
        elapsed,
        throughput,
        new_items,
        skipped_unchanged
    );
    // Mark scan-completed so the notify callback can apply the
    // post-scan cooldown to suppress the read-triggers-rescan loop on
    // SMB. Done UNCONDITIONALLY (even on cancel / errors) — the user
    // doesn't want a half-finished scan to re-fire from leftover events.
    if let Some(o) = ORCHESTRATOR.get() {
        o.state.lock().last_scan_completed_at.insert(folder_id, Instant::now());
    }
}

fn run_scan_all(app: &AppHandle, db: &LibraryDb, startup_only: bool) {
    let all_started = Instant::now();
    let sql = if startup_only {
        "SELECT id, path, recursive FROM watched_folders WHERE scan_on_startup = 1"
    } else {
        "SELECT id, path, recursive FROM watched_folders"
    };
    let folders: Vec<(i64, String, bool)> = {
        let conn = db.lock();
        let Ok(mut stmt) = conn.prepare(sql) else {
            return;
        };
        stmt.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)? != 0))
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .unwrap_or_default()
    };
    crate::log!(
        "library:scan",
        "scan_all (startup_only={}): starting pass over {} watched folder(s)",
        startup_only,
        folders.len()
    );
    let mut skipped_missing = 0u32;
    for (id, path, recursive) in &folders {
        let pb = PathBuf::from(path);
        if !pb.is_dir() {
            crate::log!(
                "library:scan",
                "scan_all: SKIP folder {id} \"{path}\" (not a directory on disk)"
            );
            skipped_missing += 1;
            continue;
        }
        run_scan_folder(app, db, *id, &pb, *recursive);
    }
    let _ = app.emit("library:list-changed", serde_json::json!({}));
    crate::log!(
        "library:scan",
        "==== scan_all DONE: {} folder(s) processed ({} skipped missing) in {:?} ====",
        folders.len() - skipped_missing as usize,
        skipped_missing,
        all_started.elapsed()
    );
}

/// Helper: how many files are present in DB right now. Used by commands
/// for diagnostic toasts.
pub fn file_count(db: &LibraryDb) -> i64 {
    let conn = db.lock();
    conn.query_row("SELECT COUNT(*) FROM library_files", [], |r| r.get(0))
        .unwrap_or(0)
}

/// Hook used after a new folder is added — start watching + queue first scan.
pub fn on_folder_added(folder_id: i64, path: PathBuf, recursive: bool, app: AppHandle) {
    if let Err(e) = watch_folder(folder_id, path.clone(), app) {
        crate::log!("library", "watch new folder failed: {e}");
    }
    enqueue_scan_folder(folder_id, path, recursive);
}

/// Hook used before deleting a folder row — stop watching, let the cascade
/// FK drop the files / clean up identities the caller no longer needs.
pub fn on_folder_removed(folder_id: i64) {
    unwatch_folder(folder_id);
}

/// Drop ALL files from a folder regardless of their on-disk presence.
/// Called when the user removes a watched folder from settings.
pub fn purge_folder_files(db: &LibraryDb, folder_id: i64) -> Result<(), String> {
    let conn = db.lock();
    conn.execute(
        "DELETE FROM library_files WHERE watched_folder_id = ?1",
        params![folder_id],
    )
    .map_err(|e| format!("purge files: {e}"))?;
    // Identities with zero files left = orphans; collect+drop them.
    conn.execute(
        "DELETE FROM library_identities
         WHERE id NOT IN (SELECT DISTINCT identity_id FROM library_files)",
        [],
    )
    .map_err(|e| format!("purge orphan identities: {e}"))?;
    Ok(())
}
