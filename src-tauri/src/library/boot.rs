//! Boot sequencing rules + helpers.
//!
//! ## The startup contract
//!
//! 1. The synchronous boot path (Tauri `setup()` callback) MUST NOT
//!    touch remote / slow I/O. The only acceptable blocking calls are
//!    local SQLite, AppData-dir disk reads, and the libmpv DLL load.
//! 2. Anything that reads from SMB, writes to a network share, binds
//!    a network socket, or registers a `notify` watcher on a UNC path
//!    is **deferred**: it runs from a background thread spawned by
//!    `defer_startup`.
//! 3. Every synchronous boot phase is wrapped by `phase!(name, body)`
//!    which emits a `[fvp:library:boot]` log line with the phase's
//!    wall-clock duration. A regression in startup time then surfaces
//!    as a single visible log line, not a 55-second mystery.
//! 4. When a phase MIGHT touch SMB but doesn't always (e.g.
//!    `consume_restore_marker` only matters when a pull marker is
//!    present), guard it with `quickly_reachable` so it gracefully
//!    abandons to next-launch when the network is misbehaving.
//!
//! ## Why a separate module
//!
//! Keeping these helpers in one place makes the contract enforceable
//! by code review. If a new feature adds a slow call to setup(), it's
//! immediately obvious whether it's been wrapped or not.

use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::library::db::LibraryDb;

/// Run a synchronous boot phase, logging its wall-clock duration when
/// it finishes. Any phase that takes more than 200 ms is logged at
/// "warn" prefix so it stands out in the terminal; cheap phases
/// (< 1 ms) are logged compactly.
///
/// The closure's return value is propagated unchanged.
pub fn phase<T>(name: &str, body: impl FnOnce() -> T) -> T {
    let start = Instant::now();
    let value = body();
    let elapsed = start.elapsed();
    let ms = elapsed.as_secs_f64() * 1000.0;
    if ms >= 200.0 {
        crate::log!(
            "library:boot",
            "phase[{name}] took {:.1}ms  (>200ms — investigate if this is unexpected)",
            ms
        );
    } else {
        crate::log!("library:boot", "phase[{name}] {:.1}ms", ms);
    }
    value
}

/// Probe whether a network path is responsive within `budget_ms`.
/// Returns true when `fs::metadata(path)` succeeds in time. False on
/// timeout OR error.
///
/// Used to guard boot-time SMB reads: if the share is unresponsive,
/// the caller skips the work and tries again on next launch instead
/// of stalling startup for 30+ seconds on a kernel SMB timeout.
pub fn quickly_reachable(path: &Path, budget_ms: u64) -> bool {
    let (tx, rx) = mpsc::channel::<bool>();
    let path_owned = path.to_path_buf();
    std::thread::spawn(move || {
        let ok = std::fs::metadata(&path_owned).is_ok();
        // Best-effort send; if the receiver has already timed out and
        // dropped the channel that's fine, the thread just exits.
        let _ = tx.send(ok);
    });
    match rx.recv_timeout(Duration::from_millis(budget_ms)) {
        Ok(reachable) => reachable,
        Err(_) => false,
    }
}

/// Spawn the deferred-startup thread. Everything inside this closure
/// runs OFF the boot thread — so its duration is invisible to the
/// user and to the UI mount. Logged with a clear begin/end pair so a
/// dev tailing the terminal can still see when async init finishes.
///
/// The deferred phases that exist today:
///   - `orchestrator::init` already starts its own deferred portion
///     (watcher reattach + boot ScanAll). The caller chooses whether
///     to call this in addition for host-mode `bring_up`, etc.
pub fn defer_startup<F>(label: &'static str, work: F)
where
    F: FnOnce() + Send + 'static,
{
    std::thread::spawn(move || {
        let start = Instant::now();
        crate::log!("library:boot", "deferred[{label}] BEGIN (off boot thread)");
        work();
        crate::log!(
            "library:boot",
            "deferred[{label}] END in {:?}",
            start.elapsed()
        );
    });
}

/// Spawn the host-server `bring_up` in a deferred thread. Called only
/// when `supervisor_boot` decides the install is configured as a
/// Host (mode == "host" + token present). Was on the boot thread,
/// where the discovery-file write to a possibly-SMB home folder could
/// stall startup; now it's async.
pub fn defer_host_bring_up<F>(work: F)
where
    F: FnOnce() + Send + 'static,
{
    defer_startup("host_bring_up", work);
}

/// Convenience: log the total wall-clock duration of synchronous
/// boot. The `setup()` callback calls this at the very end so the
/// terminal has a single anchor line.
pub fn log_total(boot_started: Instant, db_opened: bool) {
    crate::log!(
        "library:boot",
        "==== synchronous boot complete in {:?}  (db_open={}) ====",
        boot_started.elapsed(),
        db_opened
    );
}

/// Public wrapper around `library::snapshot::consume_restore_marker`
/// that ONLY runs when the snapshot path is quickly reachable. Falls
/// back to a no-op (returns Ok(false)) when SMB is too slow, so the
/// boot thread doesn't stall waiting for kernel timeouts. The marker
/// is left untouched so the next launch retries.
pub fn consume_restore_marker_with_probe(db_path: &Path) -> Result<bool, String> {
    let marker = db_path.with_file_name("library-restore-from");
    if !marker.exists() {
        return Ok(false);
    }
    // Read what the marker points at — local FS, instant.
    let bytes = std::fs::read(&marker).map_err(|e| format!("read marker: {e}"))?;
    let snapshot_path_str = String::from_utf8(bytes)
        .map_err(|e| format!("parse marker: {e}"))?
        .trim()
        .to_string();
    let snapshot_path = Path::new(&snapshot_path_str);
    // Probe with a tight budget. We're not measuring "is the file
    // there" so much as "is the share responsive enough that we won't
    // hang startup for half a minute on the copy."
    if !quickly_reachable(snapshot_path, 500) {
        crate::log!(
            "library:boot",
            "consume_restore_marker: snapshot path {} not reachable within 500ms — \
             abandoning restore for this launch (marker left in place, will retry next launch)",
            snapshot_path.display()
        );
        return Ok(false);
    }
    // Reachable — defer to the real implementation.
    crate::library::snapshot::consume_restore_marker(db_path)
}

/// Used by lib.rs to pass a `LibraryDb` + `AppHandle` to host-mode
/// `bring_up` from a background thread. Kept here so callers don't
/// have to thread-shuffle types themselves.
#[allow(dead_code)] // wired from setup()
pub struct DeferredHostArgs {
    pub db: LibraryDb,
    pub app: AppHandle,
    pub token: String,
    pub home: Option<String>,
}
