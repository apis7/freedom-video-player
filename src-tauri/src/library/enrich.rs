//! TMDb metadata enrichment worker.
//!
//! Runs on its own background thread (separate from the indexer's worker
//! so a slow TMDb response can't slow disk scans). Picks up identity
//! ids one at a time, searches TMDb by parsed title+year, applies the
//! top match to the identity row, and caches the poster locally.
//!
//! Throttled to ~5 req/s (200 ms between requests) so a folder full of
//! 500 movies doesn't burst against TMDb's rate limit.
//!
//! Respects `manual_*` flags on the identity row: if the user edited a
//! field manually, enrichment leaves it alone on subsequent passes.

use crate::library::db::LibraryDb;
use crate::library::poster_cache;
use crate::tmdb;
use parking_lot::Mutex;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const THROTTLE_MS: u64 = 200;
/// Every N completed enrichments, print a one-line batch summary so the
/// terminal shows progress without flooding (per-identity logs would
/// produce 5–10 lines × 1200 identities = thousands of lines).
const BATCH_SUMMARY_EVERY: u32 = 25;

/// Running counters for the batch summary log. Reset between summaries.
static BATCH: OnceLock<Mutex<BatchStats>> = OnceLock::new();

#[derive(Default)]
struct BatchStats {
    started: Option<Instant>,
    success: u32,
    no_match: u32,
    skipped_already_enriched: u32,
    failed: u32,
    posters_cached: u32,
    poster_bytes: u64,
    total_processed: u32,
}

fn batch() -> &'static Mutex<BatchStats> {
    BATCH.get_or_init(|| Mutex::new(BatchStats::default()))
}

fn batch_bump_then_maybe_flush<F: FnOnce(&mut BatchStats)>(mutate: F) {
    let mut b = batch().lock();
    if b.started.is_none() {
        b.started = Some(Instant::now());
    }
    mutate(&mut b);
    b.total_processed += 1;
    if b.total_processed >= BATCH_SUMMARY_EVERY {
        let elapsed = b.started.map(|s| s.elapsed()).unwrap_or_default();
        let rate = if elapsed.as_secs_f64() > 0.0 {
            b.total_processed as f64 / elapsed.as_secs_f64()
        } else {
            0.0
        };
        let poster_mb = b.poster_bytes as f64 / (1024.0 * 1024.0);
        crate::log!(
            "library:enrich",
            "BATCH: {} processed in {:?} ({:.1}/s) — {} matched, {} no-match, {} already-enriched, {} failed, {} posters cached ({:.1} MB)",
            b.total_processed,
            elapsed,
            rate,
            b.success,
            b.no_match,
            b.skipped_already_enriched,
            b.failed,
            b.posters_cached,
            poster_mb
        );
        *b = BatchStats::default();
    }
}

enum Job {
    Enrich { identity_id: i64, force: bool },
}

struct Worker {
    job_tx: Sender<Job>,
}

static WORKER: OnceLock<Worker> = OnceLock::new();

pub fn init(app: AppHandle, db: LibraryDb, app_local_data_dir: PathBuf) {
    if WORKER.get().is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<Job>();
    let worker_app = app.clone();
    let worker_db = db.clone();
    let dir = app_local_data_dir;
    thread::spawn(move || {
        while let Ok(job) = rx.recv() {
            match job {
                Job::Enrich { identity_id, force } => {
                    run_enrich(&worker_app, &worker_db, &dir, identity_id, force);
                }
            }
            // Throttle between requests. The recv() above will block until
            // the next job arrives if the queue is empty — the sleep only
            // costs us when we're actively burning through a backlog.
            thread::sleep(Duration::from_millis(THROTTLE_MS));
        }
    });
    let _ = WORKER.set(Worker { job_tx: tx });
}

/// Queue an identity for enrichment. Idempotent — same id can be queued
/// repeatedly without harm (subsequent runs short-circuit on tmdb_id).
pub fn enqueue(identity_id: i64) {
    if let Some(w) = WORKER.get() {
        let _ = w.job_tx.send(Job::Enrich { identity_id, force: false });
    }
}

/// Force a re-fetch even when the row already has TMDb data. Used by the
/// "Refresh metadata" right-click action.
pub fn enqueue_force(identity_id: i64) {
    if let Some(w) = WORKER.get() {
        let _ = w.job_tx.send(Job::Enrich { identity_id, force: true });
    }
}

fn run_enrich(
    app: &AppHandle,
    db: &LibraryDb,
    app_local_data_dir: &std::path::Path,
    identity_id: i64,
    force: bool,
) {
    let job_started = Instant::now();
    let Some(snap) = read_snapshot(db, identity_id) else {
        crate::log!("library:enrich", "identity {identity_id} not found");
        batch_bump_then_maybe_flush(|b| b.failed += 1);
        return;
    };
    if snap.tmdb_id.is_some() && !force {
        batch_bump_then_maybe_flush(|b| b.skipped_already_enriched += 1);
        return;
    }
    // Respect the user's "Remove Metadata" action. force=true (the
    // manual Refresh / Replace path) overrides — the user is asking
    // to re-fetch right now and we'll clear the flag as part of the
    // write further down. Background enrichment from a scan does NOT
    // override; it just logs and skips.
    if snap.metadata_user_removed && !force {
        crate::log!(
            "library:enrich",
            "{identity_id} SKIP (metadata_user_removed=1 — user wiped this entry; respect that until they ask for a refresh)"
        );
        batch_bump_then_maybe_flush(|b| b.skipped_already_enriched += 1);
        return;
    }
    let Some(query_title) = snap.movie_title.as_deref() else {
        batch_bump_then_maybe_flush(|b| b.no_match += 1);
        return;
    };
    let year_u32 = snap.movie_year.and_then(|y| u32::try_from(y).ok());
    // Per-identity logs go to DEBUG band (kept terse) — the batch
    // summary is the loud one. Still surface the query for traceability.
    crate::log!(
        "library:enrich",
        "{identity_id} → search \"{query_title}\" year={year_u32:?}"
    );
    let results = match tmdb::search_with_year(query_title, year_u32) {
        Ok(r) => r,
        Err(e) => {
            crate::log!("library:enrich", "{identity_id} search FAILED: {e}");
            batch_bump_then_maybe_flush(|b| b.failed += 1);
            return;
        }
    };
    let best = choose_best_match(&results, snap.movie_year);
    let Some(pick) = best else {
        crate::log!(
            "library:enrich",
            "{identity_id} → no TMDb match ({} candidate(s) returned)",
            results.len()
        );
        batch_bump_then_maybe_flush(|b| b.no_match += 1);
        return;
    };
    let details = match tmdb::details(pick.tmdb_id) {
        Ok(d) => d,
        Err(e) => {
            crate::log!(
                "library:enrich",
                "{identity_id} details({}) FAILED: {e}",
                pick.tmdb_id
            );
            batch_bump_then_maybe_flush(|b| b.failed += 1);
            return;
        }
    };

    let mut poster_size: u64 = 0;
    let mut poster_succeeded = false;
    let poster_local_path: Option<String> = match details.poster_url.as_deref() {
        Some(url) => match poster_cache::fetch_to_cache(db, app_local_data_dir, url) {
            Ok(p) => {
                if let Ok(meta) = std::fs::metadata(&p) {
                    poster_size = meta.len();
                }
                poster_succeeded = true;
                Some(p.to_string_lossy().into_owned())
            }
            Err(e) => {
                crate::log!(
                    "library:enrich",
                    "{identity_id} poster cache FAILED: {e}"
                );
                None
            }
        },
        None => None,
    };

    apply_details(db, identity_id, &snap, &details, poster_local_path);
    let _ = app.emit(
        "library:identity-updated",
        serde_json::json!({ "identity_id": identity_id }),
    );
    let _ = job_started; // duration captured in the batch summary

    batch_bump_then_maybe_flush(|b| {
        b.success += 1;
        if poster_succeeded {
            b.posters_cached += 1;
            b.poster_bytes += poster_size;
        }
    });
}

struct IdentitySnapshot {
    tmdb_id: Option<i64>,
    movie_title: Option<String>,
    movie_year: Option<i64>,
    manual_title: bool,
    manual_year: bool,
    manual_director: bool,
    manual_plot: bool,
    manual_thumbnail: bool,
    manual_genres: bool,
    manual_stars: bool,
    /// User clicked "Remove Metadata" — auto-enrichment must skip this
    /// identity until a user-initiated "Refresh metadata" clears the
    /// flag. force=true (manual refresh) bypasses the skip and clears
    /// the flag as part of the write.
    metadata_user_removed: bool,
}

fn read_snapshot(db: &LibraryDb, identity_id: i64) -> Option<IdentitySnapshot> {
    let conn = db.lock();
    conn.query_row(
        "SELECT tmdb_id, movie_title, movie_year,
                manual_title, manual_year, manual_director, manual_plot, manual_thumbnail,
                manual_genres, manual_stars,
                metadata_user_removed
         FROM library_identities WHERE id = ?1",
        params![identity_id],
        |r| {
            Ok(IdentitySnapshot {
                tmdb_id: r.get(0)?,
                movie_title: r.get(1)?,
                movie_year: r.get(2)?,
                manual_title: r.get::<_, i64>(3)? != 0,
                manual_year: r.get::<_, i64>(4)? != 0,
                manual_director: r.get::<_, i64>(5)? != 0,
                manual_plot: r.get::<_, i64>(6)? != 0,
                manual_thumbnail: r.get::<_, i64>(7)? != 0,
                manual_genres: r.get::<_, i64>(8)? != 0,
                manual_stars: r.get::<_, i64>(9)? != 0,
                metadata_user_removed: r.get::<_, i64>(10)? != 0,
            })
        },
    )
    .ok()
}

fn choose_best_match(
    results: &[tmdb::TmdbSearchResult],
    expected_year: Option<i64>,
) -> Option<tmdb::TmdbSearchResult> {
    if let Some(year) = expected_year {
        if let Some(hit) = results
            .iter()
            .find(|r| r.release_year.map(|y| y as i64) == Some(year))
        {
            return Some(hit.clone());
        }
    }
    results.first().cloned()
}

fn apply_details(
    db: &LibraryDb,
    identity_id: i64,
    snap: &IdentitySnapshot,
    d: &tmdb::TmdbMovieDetails,
    poster_local_path: Option<String>,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    // Honor manual overrides — if the user set a value by hand, leave the
    // existing column untouched and only fill in fields they haven't
    // claimed manually.
    let title = if snap.manual_title { None } else { Some(d.title.clone()) };
    let year = if snap.manual_year { None } else { d.release_year.map(|y| y as i64) };
    let director = if snap.manual_director { None } else { d.director.clone() };
    let plot = if snap.manual_plot { None } else { Some(d.overview.clone()) };
    let poster = if snap.manual_thumbnail { None } else { poster_local_path };

    let stars_json: Option<String> = if snap.manual_stars {
        None
    } else {
        Some(serde_json::to_string(&d.top_cast).unwrap_or_else(|_| "[]".into()))
    };
    let genres_json: Option<String> = if snap.manual_genres {
        None
    } else {
        Some(serde_json::to_string(&d.genres).unwrap_or_else(|_| "[]".into()))
    };

    let conn = db.lock();
    let _ = conn.execute(
        "UPDATE library_identities SET
            tmdb_id = ?1,
            movie_title = COALESCE(?2, movie_title),
            movie_year = COALESCE(?3, movie_year),
            movie_director = COALESCE(?4, movie_director),
            movie_plot = COALESCE(?5, movie_plot),
            movie_stars_json = COALESCE(?6, movie_stars_json),
            genres_json = COALESCE(?7, genres_json),
            imdb_id = COALESCE(?8, imdb_id),
            imdb_rating = COALESCE(?9, imdb_rating),
            poster_url = COALESCE(?10, poster_url),
            poster_local_path = COALESCE(?11, poster_local_path),
            last_updated_at = ?12,
            -- We got here via the manual Refresh / Replace path (force=true)
            -- or because no metadata existed at all. Either way the user
            -- now wants this row to participate in enrichment again, so
            -- clear the wipe-was-deliberate flag.
            metadata_user_removed = 0
         WHERE id = ?13",
        params![
            d.tmdb_id as i64,
            title,
            year,
            director,
            plot,
            stars_json,
            genres_json,
            d.imdb_id,
            d.vote_average,
            d.poster_url,
            poster,
            now,
            identity_id,
        ],
    );
}
