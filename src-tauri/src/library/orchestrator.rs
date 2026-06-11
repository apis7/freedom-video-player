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
use crate::library::folder_sig;
use crate::library::index;
use notify::event::{EventKind, ModifyKind};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use rusqlite::params;
use std::collections::{HashMap, HashSet};
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

/// Returns true when a file path belongs to one of FVP's own bookkeeping
/// artefacts (sync mirror, snapshot backups). Used to filter notify
/// events so our own writes don't trigger a library rescan loop.
fn is_self_write(p: &std::path::Path) -> bool {
    let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
        return false;
    };
    let lower = name.to_lowercase();
    // sync.rs writes:
    //   library-sync.db, library-sync.db-wal, library-sync.db-shm,
    //   plus host-discovery.json next to it in host mode.
    if lower.starts_with("library-sync.db") || lower == "host-discovery.json" {
        return true;
    }
    // snapshot.rs writes weekly backups named e.g.
    //   library-snapshot-2026-06-10-161023.db (+ -wal / -shm)
    // and the pre-restore safety copy is library-pre-restore-*.db.
    if (lower.starts_with("library-snapshot-") || lower.starts_with("library-pre-restore-"))
        && (lower.ends_with(".db") || lower.ends_with(".db-wal") || lower.ends_with(".db-shm"))
    {
        return true;
    }
    false
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
    /// Folder ids whose ScanFolder job is currently queued OR
    /// running. A second enqueue for the same folder_id while the
    /// first hasn't finished is a no-op — that prevents notify
    /// bursts (or rapid manual rescans) from piling up a tower of
    /// identical scans behind the worker. Cleared by the worker as
    /// soon as the job starts.
    queued_folders: HashSet<i64>,
    /// True when a `ScanAll` job is queued OR running. Same idea: a
    /// second ScanAll while one is in flight is a no-op.
    scan_all_in_flight: bool,
    /// Wall time of the last detected "activity" — i.e., the last
    /// thing that suggests the library is in flux:
    ///   - a scan that found any dirty files or dirty dirs
    ///   - a notify event that passed the self-write filter
    ///   - a user-driven Rescan / Add folder
    /// Drives the cadence ladder (see CadenceRung). Initialised to
    /// "now" on boot so the first 15 minutes after launch stay Hot.
    /// Surviving across restarts via library_settings would be a nice
    /// future enhancement; for now we accept the post-boot warmup.
    last_activity_at: Option<Instant>,
    /// Wall time of the last periodic ScanAll the cadence heartbeat
    /// fired. Distinct from `last_scan_completed_at_for_folder` because
    /// the latter is per-folder and bookkeeps notify cooldowns.
    last_periodic_scan_fired_at: Option<Instant>,
    /// Last logged rung label, so the heartbeat only logs transitions
    /// instead of spamming "still warm" once a minute.
    last_logged_rung: Option<CadenceRung>,
}

/// Three-rung cadence ladder. The rung is a pure function of
/// "elapsed time since the last detected activity" — no scan-count
/// state machine, no flapping. Empirically the elapsed-time form
/// matches the user's "3 quiet scans then demote" mental model
/// because each rung's threshold equals exactly 3× the previous
/// rung's interval (Hot 5min × 3 = 15min Warm threshold; Warm 1hr × 3 =
/// 3hr Cold threshold).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CadenceRung {
    Hot,
    Warm,
    Cold,
}

impl CadenceRung {
    fn interval(&self) -> Duration {
        match self {
            CadenceRung::Hot => Duration::from_secs(5 * 60),
            CadenceRung::Warm => Duration::from_secs(60 * 60),
            CadenceRung::Cold => Duration::from_secs(24 * 60 * 60),
        }
    }
    fn label(&self) -> &'static str {
        match self {
            CadenceRung::Hot => "hot (5min)",
            CadenceRung::Warm => "warm (1hr)",
            CadenceRung::Cold => "cold (24hr)",
        }
    }
}

fn current_rung(elapsed_since_activity: Duration) -> CadenceRung {
    // Thresholds picked so that "3 quiet ticks" at the current rung
    // tips into the next one (5min × 3 = 15min → Warm; 1hr × 3 = 3hr →
    // Cold).
    if elapsed_since_activity < Duration::from_secs(15 * 60) {
        CadenceRung::Hot
    } else if elapsed_since_activity < Duration::from_secs(3 * 60 * 60) {
        CadenceRung::Warm
    } else {
        CadenceRung::Cold
    }
}

/// Bump the "last activity" timestamp. Called from every place that
/// counts as activity (real notify event, scan that found dirty
/// content, manual Rescan, new folder added). Cheap; no I/O.
fn mark_activity(reason: &str) {
    let Some(o) = ORCHESTRATOR.get() else { return };
    let mut s = o.state.lock();
    s.last_activity_at = Some(Instant::now());
    crate::log!(
        "library:cadence",
        "activity recorded: {reason} → rung resets to hot (5min)"
    );
    // Force the rung-transition log next time the heartbeat ticks.
    s.last_logged_rung = None;
}

/// Public wrapper around `mark_activity` for use by Tauri commands
/// (user actions outside this module). The crate-internal callers
/// use `mark_activity` directly.
pub fn mark_activity_external(reason: &str) {
    mark_activity(reason);
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
    let worker_state = state.clone();
    thread::spawn(move || {
        while let Ok(job) = rx.recv() {
            match job {
                Job::ScanFolder { folder_id, path, recursive } => {
                    // Remove from the queued set BEFORE running so a
                    // legitimate "user added another file mid-scan"
                    // notify can re-queue once we finish — without
                    // this, the in-flight folder would be locked out
                    // for the entire scan duration.
                    run_scan_folder(&worker_app, &worker_db, folder_id, &path, recursive);
                    worker_state.lock().queued_folders.remove(&folder_id);
                }
                Job::ScanAll { startup_only } => {
                    run_scan_all(&worker_app, &worker_db, startup_only);
                    worker_state.lock().scan_all_in_flight = false;
                }
            }
        }
    });
    let _ = ORCHESTRATOR.set(Orchestrator { job_tx: tx, state });
    // Seed the activity ledger with "now" so the first 15 minutes
    // after launch sit on the Hot rung — gives the user time to drop
    // files in / hit Rescan without waiting an hour for the cadence
    // to notice them.
    if let Some(o) = ORCHESTRATOR.get() {
        o.state.lock().last_activity_at = Some(Instant::now());
    }
    // Cadence heartbeat — wakes once per minute, computes the current
    // rung from time-since-activity, and fires a periodic ScanAll
    // when the rung's interval has elapsed since the last periodic
    // fire. Decoupled from notify so it can do its safety-net job
    // even when notify is unreliable (some SMB servers).
    spawn_cadence_heartbeat();
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

fn spawn_cadence_heartbeat() {
    thread::spawn(|| {
        // Short initial sleep so the boot ScanAll fires first and we
        // don't race it.
        thread::sleep(Duration::from_secs(60));
        loop {
            cadence_tick();
            thread::sleep(Duration::from_secs(60));
        }
    });
}

fn cadence_tick() {
    let Some(o) = ORCHESTRATOR.get() else { return };
    let (rung, elapsed_since_activity, elapsed_since_fire, was_logged) = {
        let s = o.state.lock();
        let now = Instant::now();
        let last_activity = s.last_activity_at.unwrap_or(now);
        let elapsed_activity = now.saturating_duration_since(last_activity);
        let elapsed_fire = s
            .last_periodic_scan_fired_at
            .map(|t| now.saturating_duration_since(t))
            .unwrap_or(Duration::from_secs(u64::MAX / 2));
        let rung = current_rung(elapsed_activity);
        let was_logged = s.last_logged_rung == Some(rung);
        (rung, elapsed_activity, elapsed_fire, was_logged)
    };

    if !was_logged {
        crate::log!(
            "library:cadence",
            "rung={} (last activity {} ago)",
            rung.label(),
            human_dur(elapsed_since_activity)
        );
        o.state.lock().last_logged_rung = Some(rung);
    }

    if elapsed_since_fire < rung.interval() {
        return;
    }
    crate::log!(
        "library:cadence",
        "interval elapsed ({} >= {}) — firing periodic ScanAll",
        human_dur(elapsed_since_fire),
        human_dur(rung.interval())
    );
    o.state.lock().last_periodic_scan_fired_at = Some(Instant::now());
    enqueue_scan_all();
}

fn human_dur(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{:.1}min", s as f64 / 60.0)
    } else if s < 86400 {
        format!("{:.1}hr", s as f64 / 3600.0)
    } else {
        format!("{:.1}d", s as f64 / 86400.0)
    }
}

/// Queue a re-scan of one folder. Coalesces: if a scan for this
/// folder_id is already queued or running, this call is a no-op and
/// the in-flight scan picks up any newly-changed files anyway.
pub fn enqueue_scan_folder(folder_id: i64, path: PathBuf, recursive: bool) {
    let Some(o) = ORCHESTRATOR.get() else { return };
    {
        let mut s = o.state.lock();
        if !s.queued_folders.insert(folder_id) {
            // Already queued / running — coalesce.
            crate::log!(
                "library:scan",
                "enqueue_scan_folder({folder_id}): COALESCED (a scan for this folder is already in flight)"
            );
            return;
        }
    }
    let _ = o.job_tx.send(Job::ScanFolder { folder_id, path, recursive });
}

/// Queue a re-scan of every watched folder. Manual command path —
/// always scans every folder regardless of scan_on_startup. Coalesces
/// the same way: a second ScanAll while one is running is a no-op.
///
/// NB this is the path used by BOTH user-driven Rescan AND the cadence
/// heartbeat. The cadence heartbeat does NOT mark activity — that
/// would create a self-sustaining loop (heartbeat fires scan → marks
/// activity → stays Hot → heartbeat fires scan again every 5 min
/// forever). Only NON-cadence callers (user actions, new folders)
/// should call mark_activity around this.
pub fn enqueue_scan_all() {
    let Some(o) = ORCHESTRATOR.get() else { return };
    {
        let mut s = o.state.lock();
        if s.scan_all_in_flight {
            crate::log!(
                "library:scan",
                "enqueue_scan_all: COALESCED (a ScanAll is already in flight)"
            );
            return;
        }
        s.scan_all_in_flight = true;
    }
    let _ = o.job_tx.send(Job::ScanAll { startup_only: false });
}

/// Queue the boot-time pass — only folders flagged scan_on_startup=1.
pub fn enqueue_scan_startup() {
    let Some(o) = ORCHESTRATOR.get() else { return };
    {
        let mut s = o.state.lock();
        if s.scan_all_in_flight {
            return;
        }
        s.scan_all_in_flight = true;
    }
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
            // Filter OUR OWN writes. The sync module pushes
            // `library-sync.db` (+ its WAL / SHM sidecars) to the
            // home folder every cadence_minutes. When the home folder
            // IS the watched folder root, that push fires a notify
            // event that the orchestrator was happily turning into a
            // full library rescan — the user reported "I added one
            // movie and the whole library re-scans every 5 minutes."
            // Sync's own DB and the snapshot backups it writes next
            // to it are never video files and never indexed, so
            // ignoring events on them is safe.
            let any_self_write = ev.paths.iter().any(|p| is_self_write(p));
            if any_self_write {
                // Defensive observability: when a notify event lands on
                // one of FVP's own bookkeeping files (sync mirror,
                // snapshot, etc.) we drop it loudly so we can verify
                // the filter is actually doing its job in user logs.
                // Throttled by the notify debounce + the SMB driver,
                // so this isn't a flood.
                if let Some(first) = ev.paths.first() {
                    crate::log!(
                        "library",
                        "watcher: ignored self-write event on {} (would have triggered rescan)",
                        first.display()
                    );
                }
                return;
            }
            // Real fs change passed the filter — record activity so the
            // cadence ladder snaps back to Hot.
            mark_activity("notify event passed filter");
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
    // Smart enumeration: walk the tree, but skip per-file work for
    // directories whose mtime + child_count match the cached
    // signature. Cold cache (first scan) = everything dirty, same
    // behaviour as before. Warm cache + no on-disk changes = zero
    // dirty files, just a tree of mtime stats.
    let max_depth = if recursive { 8 } else { 1 };
    let cached_signatures = folder_sig::load_signatures(db, folder_id);
    let cached_count = cached_signatures.len();
    let smart = folder_sig::smart_enumerate(path, max_depth, &cached_signatures);
    let files: Vec<std::path::PathBuf> = smart.dirty_files.clone();
    let total = files.len();
    let total_dirs = smart.new_signatures.len();
    let clean_dir_count = smart.clean_dirs.len();
    let dirty_dir_count = smart.dirty_dirs.len();
    crate::log!(
        "library:scan",
        "smart-enumerate: {total_dirs} dirs ({clean_dir_count} clean, {dirty_dir_count} dirty) — {total} dirty file(s) need indexing — cache had {cached_count} prior signature(s) — walk took {:?}",
        enumerate_start.elapsed()
    );
    // Bulk-clear is_missing for every file row whose parent dir was
    // matched as clean — we KNOW those files are still present and
    // unchanged, no per-file stat needed.
    let bulk_clear_started = Instant::now();
    let bulk_cleared = bulk_mark_present_in_clean_dirs(db, folder_id, &smart.clean_dirs);
    if bulk_cleared > 0 {
        crate::log!(
            "library:scan",
            "bulk-marked {bulk_cleared} file row(s) present (in {clean_dir_count} clean dir(s)) in {:?} — skipped per-file stat",
            bulk_clear_started.elapsed()
        );
    }
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
    // Persist the freshly-computed directory signatures so the next
    // scan can skip whatever didn't change. Done UNCONDITIONALLY — a
    // partial scan (user cancelled) still produced valid signatures
    // for the dirs it visited, and future scans of those dirs will
    // still benefit from the cache.
    if let Err(e) = folder_sig::save_signatures(db, folder_id, &smart.new_signatures) {
        crate::log!("library", "save folder signatures failed: {e}");
    }
    // After every scan, refresh has_free_sibling. When the smart
    // walker reported any dirty dirs we still run the full sweep —
    // because moving a video into a NEW directory means the OLD dir
    // also needs its .free state recomputed. But when the smart walk
    // says "nothing changed at all" (zero dirty dirs AND zero dirty
    // files), the .free sweep would be 100% no-op and we skip it,
    // which is where the biggest no-op-scan savings come from.
    let nothing_changed = smart.dirty_dirs.is_empty() && total == 0;
    if !nothing_changed {
        if let Err(e) = index::refresh_free_siblings(db, folder_id) {
            crate::log!("library", "refresh_free_siblings failed: {e}");
        }
    } else {
        crate::log!(
            "library:scan",
            "refresh_free_siblings: SKIPPED (smart-cache: nothing changed)"
        );
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
    // Cadence-ladder feedback: if this scan actually found dirty
    // content (new files or dirs that needed indexing), that's
    // activity → reset to Hot rung. Quiet scans deliberately do NOT
    // reset the ledger, so a string of no-op periodic scans naturally
    // decays through Warm to Cold.
    let any_dirty = dirty_dir_count > 0 || total > 0;
    if any_dirty {
        mark_activity(&format!(
            "scan folder {folder_id} found {} dirty dir(s) + {} dirty file(s)",
            dirty_dir_count, total
        ));
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
    mark_activity("user added a watched folder");
    enqueue_scan_folder(folder_id, path, recursive);
}

/// Hook used before deleting a folder row — stop watching, let the cascade
/// FK drop the files / clean up identities the caller no longer needs.
pub fn on_folder_removed(folder_id: i64) {
    unwatch_folder(folder_id);
}

/// Clear `is_missing` (and `missing_since`) for every library_files
/// row whose path lives directly under one of the given directories.
/// Used by the smart scanner: a directory's mtime + child count
/// matched the cached signature, so we already know every file in
/// it is still there — no need to re-stat each one.
///
/// Returns the number of rows updated. Uses path-prefix matching in
/// memory (single SELECT pulls all rows for the folder; we group by
/// parent and bulk-update by id), which is cheaper than emitting one
/// UPDATE per clean dir.
fn bulk_mark_present_in_clean_dirs(
    db: &LibraryDb,
    folder_id: i64,
    clean_dirs: &[PathBuf],
) -> u32 {
    if clean_dirs.is_empty() {
        return 0;
    }
    use std::collections::HashSet;
    let clean_set: HashSet<String> = clean_dirs
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    // Snapshot every file row for this folder, then filter in Rust.
    let rows: Vec<(i64, String)> = {
        let conn = db.lock();
        let mut stmt = match conn
            .prepare("SELECT id, path FROM library_files WHERE watched_folder_id = ?1")
        {
            Ok(s) => s,
            Err(e) => {
                crate::log!("library", "bulk-mark prep: {e}");
                return 0;
            }
        };
        stmt.query_map(params![folder_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .and_then(|it| it.collect::<Result<Vec<_>, _>>())
        .unwrap_or_default()
    };

    let mut to_clear: Vec<i64> = Vec::new();
    for (id, path) in rows {
        let parent = match std::path::Path::new(&path).parent() {
            Some(p) => p.to_string_lossy().to_string(),
            None => continue,
        };
        if clean_set.contains(&parent) {
            to_clear.push(id);
        }
    }
    if to_clear.is_empty() {
        return 0;
    }

    // Chunked UPDATE — SQLite's expression-tree limit means we don't
    // want to slap thousands of `?N` placeholders in one go.
    let mut total: u32 = 0;
    let conn = db.lock();
    for chunk in to_clear.chunks(500) {
        let placeholders = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE library_files
                SET is_missing = 0,
                    missing_since = NULL
              WHERE id IN ({placeholders})
                AND (is_missing = 1 OR missing_since IS NOT NULL)"
        );
        let params_vec: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|i| i as &dyn rusqlite::ToSql).collect();
        match conn.execute(&sql, params_vec.as_slice()) {
            Ok(n) => total += n as u32,
            Err(e) => {
                crate::log!("library", "bulk-mark UPDATE failed: {e}");
                break;
            }
        }
    }
    total
}

#[cfg(test)]
mod cadence_tests {
    use super::{current_rung, human_dur, CadenceRung};
    use std::time::Duration;

    #[test]
    fn rung_thresholds() {
        assert_eq!(current_rung(Duration::from_secs(0)), CadenceRung::Hot);
        assert_eq!(current_rung(Duration::from_secs(60)), CadenceRung::Hot);
        // Just under 15 min → still Hot
        assert_eq!(
            current_rung(Duration::from_secs(15 * 60 - 1)),
            CadenceRung::Hot
        );
        // 15 min → Warm
        assert_eq!(current_rung(Duration::from_secs(15 * 60)), CadenceRung::Warm);
        assert_eq!(current_rung(Duration::from_secs(60 * 60)), CadenceRung::Warm);
        // Just under 3 hr → still Warm
        assert_eq!(
            current_rung(Duration::from_secs(3 * 60 * 60 - 1)),
            CadenceRung::Warm
        );
        // 3 hr → Cold
        assert_eq!(
            current_rung(Duration::from_secs(3 * 60 * 60)),
            CadenceRung::Cold
        );
        // a week → still Cold (no further demotion)
        assert_eq!(
            current_rung(Duration::from_secs(7 * 24 * 60 * 60)),
            CadenceRung::Cold
        );
    }

    #[test]
    fn rung_intervals_match_user_pitch() {
        // 3 quiet scans at each rung's interval should land in the
        // next rung's threshold band — confirms the "3 quiet scans
        // then demote" mental model.
        assert_eq!(
            CadenceRung::Hot.interval() * 3,
            Duration::from_secs(15 * 60)
        );
        assert_eq!(
            CadenceRung::Warm.interval() * 3,
            Duration::from_secs(3 * 60 * 60)
        );
    }

    #[test]
    fn human_dur_formats() {
        assert_eq!(human_dur(Duration::from_secs(5)), "5s");
        assert_eq!(human_dur(Duration::from_secs(150)), "2.5min");
        assert_eq!(human_dur(Duration::from_secs(7200)), "2.0hr");
        assert_eq!(human_dur(Duration::from_secs(86400 * 3)), "3.0d");
    }
}

#[cfg(test)]
mod self_write_tests {
    use super::is_self_write;
    use std::path::PathBuf;

    #[test]
    fn matches_sync_db_and_sidecars() {
        assert!(is_self_write(&PathBuf::from("\\\\NAS\\Movies\\library-sync.db")));
        assert!(is_self_write(&PathBuf::from("\\\\NAS\\Movies\\library-sync.db-wal")));
        assert!(is_self_write(&PathBuf::from("\\\\NAS\\Movies\\library-sync.db-shm")));
    }

    #[test]
    fn matches_snapshot_and_safety_backups() {
        assert!(is_self_write(&PathBuf::from(
            "C:\\Users\\u\\AppData\\com.fvp.desktop\\library-snapshot-2026-06-10-161023.db"
        )));
        assert!(is_self_write(&PathBuf::from(
            "C:\\AppData\\com.fvp.desktop\\library-pre-restore-2026-06-10-161023.db"
        )));
    }

    #[test]
    fn matches_host_discovery() {
        assert!(is_self_write(&PathBuf::from("\\\\NAS\\Movies\\host-discovery.json")));
    }

    #[test]
    fn does_not_match_real_videos() {
        assert!(!is_self_write(&PathBuf::from("\\\\NAS\\Movies\\Eagle Eye 2008.mp4")));
        assert!(!is_self_write(&PathBuf::from("/library/movies/library-stuff.mkv")));
        assert!(!is_self_write(&PathBuf::from("\\\\NAS\\Movies\\Random.db.mkv")));
    }
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
