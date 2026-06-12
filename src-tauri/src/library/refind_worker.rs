//! Background refind worker.
//!
//! Polls the DB for `is_missing = 1` rows and quietly runs the same
//! refind heuristic the right-click 'Search for broken filepath' menu
//! uses, BUT off the UI thread, throttled, and with no toasts. The
//! user moves a folder, the next periodic scan (or any on-demand
//! lazy-flag from `mark_path_missing`) flips a row to is_missing=1,
//! and within a minute or so this worker has already stat'd it,
//! discovered it's gone, found it at its new location, and rebound
//! the row. By the time the user looks at the broken thumbnail it's
//! already fixed.
//!
//! Design
//! ──────
//! - Single thread, spawned once at boot.
//! - In-memory `attempted_this_session: HashSet<i64>` keeps a row
//!   from being re-tried every cycle when its rebind genuinely
//!   failed (e.g. the file is truly gone). The set resets on
//!   restart so a relaunched session re-checks everything once -
//!   the user may have moved files back, or restored from backup,
//!   between sessions.
//! - Pulls up to N (`BATCH_SIZE`) is_missing rows per cycle, never
//!   processed before in this session. Between rows: small sleep
//!   so we don't hammer SMB with back-to-back stats. Between
//!   cycles: longer sleep.
//! - Emits `library:list-changed` ONCE per cycle if anything
//!   actually changed (Recovered / MergedInto / Rebound). The UI's
//!   existing listener refreshes items, so the formerly-broken
//!   thumbnail flips green without the user doing anything.
//! - Initial delay so the worker doesn't fight the boot ScanAll for
//!   SMB bandwidth.

use crate::library::LibraryDb;
use rusqlite::params;
use std::collections::HashSet;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Time between cycles when there's WORK (we just processed
/// something). Short - keeps the user-perceptible "time to
/// auto-rebind" low.
const ACTIVE_CYCLE_DELAY: Duration = Duration::from_secs(20);

/// Time between cycles when there's NOTHING is_missing OR we've
/// already attempted everything that is. Longer so we're not
/// pointlessly waking up.
const IDLE_CYCLE_DELAY: Duration = Duration::from_secs(120);

/// Delay between individual refind attempts within one cycle. Each
/// attempt does a stat() on the original path and, if missing, may
/// also walk watched folders for a basename match - both are slow
/// on SMB. Sleeping between attempts spreads the load.
const PER_ROW_DELAY: Duration = Duration::from_millis(250);

/// Max rows processed per cycle. Bounded so a library with hundreds
/// of legitimately-missing rows (user deleted a bunch on purpose)
/// doesn't eat the worker thread for half an hour.
const BATCH_SIZE: usize = 8;

/// Initial delay before the first cycle, so the boot ScanAll
/// finishes first. Boot scan already runs ~10s after launch.
const INITIAL_DELAY: Duration = Duration::from_secs(45);

pub fn init(app: AppHandle, db: LibraryDb) {
    std::thread::Builder::new()
        .name("library:refind_worker".into())
        .spawn(move || run(app, db))
        .expect("refind_worker thread spawn");
}

fn run(app: AppHandle, db: LibraryDb) {
    crate::log!(
        "library:refind",
        "worker started (initial-delay={:?}, batch={}, per-row={:?}, active-cycle={:?}, idle-cycle={:?})",
        INITIAL_DELAY,
        BATCH_SIZE,
        PER_ROW_DELAY,
        ACTIVE_CYCLE_DELAY,
        IDLE_CYCLE_DELAY,
    );
    std::thread::sleep(INITIAL_DELAY);
    let mut attempted: HashSet<i64> = HashSet::new();
    loop {
        let candidates = load_missing_ids(&db);
        let pending: Vec<i64> = candidates
            .into_iter()
            .filter(|id| !attempted.contains(id))
            .take(BATCH_SIZE)
            .collect();
        if pending.is_empty() {
            std::thread::sleep(IDLE_CYCLE_DELAY);
            continue;
        }
        let mut state_changed = false;
        let mut recovered = 0u32;
        let mut still_missing = 0u32;
        for id in pending {
            attempted.insert(id);
            match crate::commands::library::try_refind_core(&db, id) {
                Ok(crate::commands::library::RefindResult::Recovered)
                | Ok(crate::commands::library::RefindResult::MergedInto { .. })
                | Ok(crate::commands::library::RefindResult::Rebound { .. }) => {
                    recovered += 1;
                    state_changed = true;
                    // Once a row gets rebound/merged it's no longer
                    // is_missing; drop it from the attempted set so
                    // we're not holding stale ids forever. (Doesn't
                    // affect correctness either way - the load query
                    // filters by is_missing=1 - just memory hygiene.)
                    attempted.remove(&id);
                }
                Ok(crate::commands::library::RefindResult::StillMissing) => {
                    still_missing += 1;
                }
                Ok(_) => {}
                Err(e) => {
                    crate::log!("library:refind", "try_refind file_id={id} errored: {e}");
                }
            }
            std::thread::sleep(PER_ROW_DELAY);
        }
        if recovered > 0 || still_missing > 0 {
            crate::log!(
                "library:refind",
                "cycle done: {recovered} recovered, {still_missing} still missing"
            );
        }
        if state_changed {
            let _ = app.emit("library:list-changed", ());
        }
        std::thread::sleep(ACTIVE_CYCLE_DELAY);
    }
}

fn load_missing_ids(db: &LibraryDb) -> Vec<i64> {
    let conn = db.lock();
    let mut stmt = match conn.prepare(
        "SELECT id FROM library_files WHERE is_missing = 1 ORDER BY id",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map([], |r| r.get::<_, i64>(0));
    match rows {
        Ok(it) => it.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

/// Best-effort 'kick the worker'. Currently a stub - the worker
/// runs on its own schedule and will pick up newly-flagged rows on
/// its next cycle. We expose this so call sites (e.g. mark_path_missing)
/// can call it as a hint without needing to know the worker's
/// internals; if we ever switch to a push-based design (channel-fed
/// queue), this is the API surface to wire up.
pub fn hint_check_soon(_file_id: i64) {
    // Intentionally empty for now. See module-level docs.
    // The 20s active-cycle delay caps the user-perceptible latency
    // between flag and rebind at well under a minute even without
    // a push trigger.
    let _ = params![];
}
