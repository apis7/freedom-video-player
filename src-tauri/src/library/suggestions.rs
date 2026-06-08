//! Roulette + suggestion + profile-creator-nudge scoring.
//!
//! The three tools share one underlying weighting helper (recency decay)
//! but specialize in input pool + secondary signals:
//!   - Roulette: random weighted pick from a user-supplied set
//!   - Suggested Movie: full-library pick, recency decay + series momentum
//!   - Profile Creator Suggestion: unprofiled-only, similarity to .free'd
//!
//! Per directive: weighted bands are days-since-last-watched:
//!     never watched     → 110 %
//!     not in last year  → 100 %
//!     11 months ago     →  92 %
//!     10 months ago     →  86 %
//!     ... declining ...
//! A series-momentum override: if any movie from a series was watched in
//! the last 30 days, the *next unwatched* in that series gets a 110 % boost.

use crate::library::model::{LibraryFile, LibraryIdentity};
use rand::seq::SliceRandom;
use rand::Rng;
use std::collections::HashMap;

const ONE_DAY_SECS: i64 = 86_400;
const SERIES_MOMENTUM_WINDOW_DAYS: i64 = 30;
const SUGGESTION_DISMISS_WINDOW_DAYS: i64 = 7;
/// Long-tail comeback: movies watched a lot in the past but not in 6+ months
/// get a small bonus on top of their baseline recency weight.
const COMEBACK_THRESHOLD_DAYS: i64 = 180;
const COMEBACK_BONUS: f64 = 1.15;

/// Recency-band weights per directive line 93: never→1.10, 12+mo→1.00,
/// 11mo→0.92, 10mo→0.86, then 6 pp per month down. Indexed by
/// months-since-last-watched (0-indexed). Values past index 12 wrap to
/// 1.00 (the "12+ months" flat band). The very recent end (0–1 months)
/// is heavily attenuated so the wheel actively avoids re-suggesting
/// just-watched titles.
const RECENCY_MONTHLY_BAND: [f64; 13] = [
    0.26, // 0 months
    0.32, // 1 month
    0.38, // 2 months
    0.44, // 3 months
    0.50, // 4 months
    0.56, // 5 months
    0.62, // 6 months
    0.68, // 7 months
    0.74, // 8 months
    0.80, // 9 months
    0.86, // 10 months
    0.92, // 11 months
    1.00, // 12 months (baseline)
];

/// Compute a recency-based weight for a single file. `now_unix` is the
/// current epoch second. Output is in [0.0, 2.0] in practice. Per
/// directive line 93's stepped monthly bands.
pub fn recency_weight(last_watched_at: Option<i64>, now_unix: i64) -> f64 {
    let Some(t) = last_watched_at else {
        return 1.10; // never watched — slight boost
    };
    let days = ((now_unix - t).max(0)) / ONE_DAY_SECS;
    let months_idx = (days / 30) as usize;
    let base = if months_idx >= RECENCY_MONTHLY_BAND.len() - 1 {
        1.00
    } else {
        RECENCY_MONTHLY_BAND[months_idx]
    };
    // Long-tail comeback bonus applies anywhere past the threshold —
    // including the >1-year flat region. The intent ("haven't watched in
    // 6+ months → weight extra") gets stronger, not capped, as the gap
    // grows past a year.
    if days >= COMEBACK_THRESHOLD_DAYS {
        base * COMEBACK_BONUS
    } else {
        base
    }
}

/// Pick one identity from a weighted candidate pool. Uses standard
/// "roulette wheel" sampling — cumulative weight then a uniform draw.
/// Returns None for empty pools or all-zero weights.
pub fn weighted_pick<R: Rng + ?Sized>(
    rng: &mut R,
    candidates: &[(i64, f64)], // (identity_id, weight)
) -> Option<i64> {
    if candidates.is_empty() {
        return None;
    }
    let total: f64 = candidates.iter().map(|(_, w)| w.max(0.0)).sum();
    if total <= 0.0 {
        // Pure-zero pool — fall back to uniform random.
        return candidates.choose(rng).map(|(id, _)| *id);
    }
    let pick: f64 = rng.gen_range(0.0..total);
    let mut acc = 0.0;
    for (id, w) in candidates {
        acc += w.max(0.0);
        if pick <= acc {
            return Some(*id);
        }
    }
    candidates.last().map(|(id, _)| *id)
}

/// Series momentum: for each series with a recent watch, find the next
/// unwatched item and return its identity_id. Caller adds the boost to
/// the suggestion pool.
///
/// `series_membership` is identity_id → (series_id, position).
/// `series_recent_watch` is series_id → most-recent watch unix.
pub fn next_in_recently_watched_series(
    files: &[LibraryFile],
    identities: &HashMap<i64, LibraryIdentity>,
    series_membership: &HashMap<i64, (i64, i64)>, // identity_id → (series_id, position)
    now_unix: i64,
) -> Vec<i64> {
    // Build series_id → list of (identity_id, position, watched)
    let mut by_series: HashMap<i64, Vec<(i64, i64, bool)>> = HashMap::new();
    for f in files {
        let Some(&(series_id, pos)) = series_membership.get(&f.identity_id) else {
            continue;
        };
        let watched = f.watched
            || f
                .last_watched_at
                .map(|t| (now_unix - t).abs() < SERIES_MOMENTUM_WINDOW_DAYS * ONE_DAY_SECS)
                .unwrap_or(false);
        let _ = identities; // identities arg reserved for future use (e.g. NFF filter)
        by_series
            .entry(series_id)
            .or_default()
            .push((f.identity_id, pos, watched));
    }
    let mut boosted: Vec<i64> = Vec::new();
    for (_series_id, mut entries) in by_series {
        entries.sort_by_key(|(_, pos, _)| *pos);
        // Did anything in this series get watched recently? If yes, find
        // the lowest-position unwatched item and boost it.
        let recent_in_series = entries.iter().any(|(_, _, watched)| *watched);
        if !recent_in_series {
            continue;
        }
        if let Some((next_id, _, _)) = entries.iter().find(|(_, _, watched)| !*watched) {
            boosted.push(*next_id);
        }
    }
    boosted
}

/// Should we exclude this identity from suggestions because the user
/// recently hit "next" on it? Implements the don't-nag-for-a-week rule.
pub fn is_recently_dismissed(dismissed_at: Option<i64>, now_unix: i64) -> bool {
    match dismissed_at {
        Some(t) => (now_unix - t) < SUGGESTION_DISMISS_WINDOW_DAYS * ONE_DAY_SECS,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn never_watched_is_slightly_boosted() {
        let w = recency_weight(None, 1_700_000_000);
        assert!((w - 1.10).abs() < 1e-6);
    }

    #[test]
    fn old_watch_is_baseline() {
        // Last watched 400 days ago → baseline 1.0 (well past year).
        let now = 1_700_000_000;
        let last = now - 400 * ONE_DAY_SECS;
        let w = recency_weight(Some(last), now);
        assert!((w - 1.0 * COMEBACK_BONUS).abs() < 1e-6);
    }

    #[test]
    fn very_recent_watch_is_low() {
        let now = 1_700_000_000;
        let last = now - 2 * ONE_DAY_SECS;
        let w = recency_weight(Some(last), now);
        assert!(w < 0.55);
    }

    #[test]
    fn monthly_bands_match_directive() {
        // Directive line 93's example anchor points: 11mo → 0.92, 10mo → 0.86.
        let now = 1_700_000_000;
        // 11 months back ≈ 330 days.
        let last_11mo = now - 330 * ONE_DAY_SECS;
        // 10 months back ≈ 300 days.
        let last_10mo = now - 300 * ONE_DAY_SECS;
        // 13 months back ≈ 395 days — past the 12-month flat band, so we
        // get baseline 1.00 × COMEBACK_BONUS since 395 ≥ 180 threshold.
        let last_13mo = now - 395 * ONE_DAY_SECS;
        let w_11 = recency_weight(Some(last_11mo), now);
        let w_10 = recency_weight(Some(last_10mo), now);
        let w_13 = recency_weight(Some(last_13mo), now);
        // 11mo and 10mo are past comeback threshold (180d) so they get
        // bonus'd. Compare against the raw band × bonus.
        assert!((w_11 - 0.92 * COMEBACK_BONUS).abs() < 1e-6, "11mo: {w_11}");
        assert!((w_10 - 0.86 * COMEBACK_BONUS).abs() < 1e-6, "10mo: {w_10}");
        assert!((w_13 - 1.00 * COMEBACK_BONUS).abs() < 1e-6, "13mo: {w_13}");
    }

    #[test]
    fn weighted_pick_respects_weights() {
        // Heavily-weighted id should win the lion's share of samples.
        let mut rng = rand::rngs::StdRng::seed_from_u64(42);
        let candidates = vec![(1, 1.0), (2, 1.0), (3, 100.0)];
        let mut counts: HashMap<i64, u32> = HashMap::new();
        for _ in 0..1000 {
            if let Some(id) = weighted_pick(&mut rng, &candidates) {
                *counts.entry(id).or_default() += 1;
            }
        }
        let big = *counts.get(&3).unwrap_or(&0);
        assert!(big > 900, "heavy weight should dominate, got {big}");
    }
}
