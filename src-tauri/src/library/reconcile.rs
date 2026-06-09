//! Match-confidence engine + reconciliation primitives.
//!
//! Three bands per librrary_directive.md §3:
//!   CERTAIN  — same cheap fingerprint → silent path update
//!   PROBABLE — different fingerprint, strong similarity → user dialog
//!   UNRELATED — no meaningful match → new identity row
//!
//! PROBABLE requires ≥2 signals (duration within ±2-3 %, parsed title+year,
//! embedded metadata title/year, temporal correlation, resolution/codec
//! differs from match). Duration alone or filename alone must NEVER
//! trigger PROBABLE — that's the false-positive trap (sequels with
//! matching runtimes).
//!
//! Currently this is a stub. Match-engine wiring lands in Phase 6.

use crate::library::metadata::{parse_filename, ParsedFilename};
use crate::library::model::LibraryIdentity;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchBand {
    Certain,
    Probable,
    Unrelated,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchVerdict {
    pub band: MatchBand,
    pub signals: Vec<String>,
}

/// Optional pair-level context — extra signals that the score_match call
/// site can collect from elsewhere (DB lookups) and pass in. Per
/// directive's PROBABLE signal table:
///   - Embedded TMDb-id match (medium): two identities point at the same
///     TMDB movie row → strong evidence of "same content."
///   - Temporal correlation (medium): a previously-known file in the
///     same folder vanished within the temporal window; this candidate
///     appeared during that window → "upgrade in place" signature.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExtraSignals<'a> {
    pub new_tmdb_id: Option<i64>,
    pub existing_tmdb_id: Option<i64>,
    /// True when the caller observed a missing-file event in the same
    /// folder within the temporal correlation window.
    pub temporal_correlation: bool,
    /// Bare filenames (no path) used by the 3D-mismatch exclusion. The
    /// stored TMDB titles strip format markers so we have to inspect
    /// the user's file naming to spot a 3D variant.
    pub new_filename: Option<&'a str>,
    pub existing_filename: Option<&'a str>,
}

/// Score a new file against an existing identity. Caller supplies what
/// it has; missing signals just don't contribute. Returns a verdict the
/// reconciliation UI can render verbatim.
pub fn score_match(
    new_cheap_fingerprint: &str,
    new_parsed: &ParsedFilename,
    new_duration_ms: u64,
    new_resolution: Option<&str>,
    new_codec: Option<&str>,
    existing_cheap_fingerprint: &str,
    existing_parsed_title: Option<&str>,
    existing_parsed_year: Option<i64>,
    existing_duration_ms: u64,
    existing_resolution: Option<&str>,
    existing_codec: Option<&str>,
    extra: ExtraSignals<'_>,
) -> MatchVerdict {
    let mut signals: Vec<String> = Vec::new();

    // CERTAIN short-circuit.
    if new_cheap_fingerprint == existing_cheap_fingerprint {
        signals.push("cheap fingerprint matches → CERTAIN".into());
        return MatchVerdict { band: MatchBand::Certain, signals };
    }

    // Hard exclusion — 3D variants are NOT the same movie. A "3D"
    // marker in one side and not the other means they should never
    // reconcile, even when other signals match. We check against the
    // FILENAMES (passed via extra) because TMDB-fetched titles strip
    // format markers — the filename is where "3D" / "SBS" lives.
    let new_has_3d = extra
        .new_filename
        .map(|f| has_3d_marker(f))
        .unwrap_or(false)
        || has_3d_marker(&new_parsed.title);
    let existing_has_3d = extra
        .existing_filename
        .map(|f| has_3d_marker(f))
        .unwrap_or(false)
        || existing_parsed_title
            .map(|t| has_3d_marker(t))
            .unwrap_or(false);
    if new_has_3d != existing_has_3d {
        signals.push("3D / 2D mismatch — not the same release".into());
        return MatchVerdict { band: MatchBand::Unrelated, signals };
    }

    // TMDb-id agreement is a CERTAIN-level signal on its own — two
    // identities pointing at the same TMDb row are the same movie even
    // if the filenames disagree wildly. We surface it as Probable so
    // the user gets the chance to review (it's still distinct content
    // by fingerprint, just same logical movie).
    if let (Some(a), Some(b)) = (extra.new_tmdb_id, extra.existing_tmdb_id) {
        if a == b {
            signals.push(format!("embedded TMDb id matches (id={a})"));
            return MatchVerdict {
                band: MatchBand::Probable,
                signals,
            };
        }
    }

    // HARD requirement #1: titles must fuzzy-match. Without this
    // EVERY other signal is meaningless — two random ~120-min movies
    // with different encodings would otherwise score 2 signals
    // (duration + resolution/codec) and surface as Probable, drowning
    // the user in noise (21k pairs from a 1200-item library).
    let existing_title_str = existing_parsed_title.unwrap_or("");
    if !titles_match(&new_parsed.title, existing_title_str) {
        signals.push("titles don't fuzzy-match — skipped".into());
        return MatchVerdict {
            band: MatchBand::Unrelated,
            signals,
        };
    }
    signals.push(format!(
        "titles fuzzy-match (\"{}\" ↔ \"{}\")",
        new_parsed.title, existing_title_str
    ));

    // Trailer / short-clip rejection: when title fuzzy-matches BUT
    // both durations are known and they differ by more than 50 %,
    // this is almost always a trailer paired with the feature (or a
    // 5-minute YouTube rip paired with the 2-hour movie). Drop.
    if existing_duration_ms > 0 && new_duration_ms > 0 {
        let d = (new_duration_ms as i64 - existing_duration_ms as i64).abs() as f64;
        let avg = (new_duration_ms + existing_duration_ms) as f64 / 2.0;
        let pct = d / avg * 100.0;
        if pct > 50.0 {
            signals.push(format!(
                "duration differs {pct:.0}% — likely trailer / clip, not the same feature"
            ));
            return MatchVerdict {
                band: MatchBand::Unrelated,
                signals,
            };
        }
    }

    // HARD requirement #2: year OR duration must agree. Title alone
    // catches things like "The Stand 1994" vs "The Stand 2020" — same
    // name, different work. Requiring year-within-1 OR duration-within-3%
    // filters those out. Temporal correlation is a third acceptable
    // tie-breaker for the "I moved a file" case.
    let mut second_signal_ok = false;

    if let (Some(existing_year), Some(new_year)) =
        (existing_parsed_year, new_parsed.year)
    {
        if (existing_year - new_year).abs() <= 1 {
            signals.push(format!(
                "year matches (±1: {} ↔ {})",
                existing_year, new_year
            ));
            second_signal_ok = true;
        } else {
            signals.push(format!(
                "year mismatch ({} vs {}) — different movies",
                existing_year, new_year
            ));
            return MatchVerdict {
                band: MatchBand::Unrelated,
                signals,
            };
        }
    }

    if existing_duration_ms > 0 && new_duration_ms > 0 {
        let d = (new_duration_ms as i64 - existing_duration_ms as i64).abs() as f64;
        let avg = (new_duration_ms + existing_duration_ms) as f64 / 2.0;
        let pct = d / avg * 100.0;
        if pct <= 3.0 {
            signals.push(format!("duration matches within {pct:.1}%"));
            second_signal_ok = true;
        }
    }

    if extra.temporal_correlation {
        signals.push("temporal correlation (known file vanished, this appeared)".into());
        second_signal_ok = true;
    }

    // Resolution/codec differing is a tertiary signal — useful as
    // context for the "this is an upgrade" framing but NOT enough to
    // accept the pair on its own.
    let res_differs = matches!(
        (new_resolution, existing_resolution),
        (Some(a), Some(b)) if a != b
    );
    let codec_differs = matches!(
        (new_codec, existing_codec),
        (Some(a), Some(b)) if a != b
    );
    if res_differs || codec_differs {
        signals.push("resolution/codec differs (upgrade signature)".into());
    }

    // Allow title-only when BOTH year and duration are unknown — for
    // unmatched / old files the user explicitly wants the matcher to
    // surface anything name-similar.
    let both_year_and_dur_unknown = existing_parsed_year.is_none()
        && new_parsed.year.is_none()
        && existing_duration_ms == 0
        && new_duration_ms == 0;

    let band = if second_signal_ok || both_year_and_dur_unknown {
        MatchBand::Probable
    } else {
        MatchBand::Unrelated
    };
    MatchVerdict { band, signals }
}

/// Returns true when the title contains an explicit 3D marker. We're
/// conservative — only obvious markers count, so "3D Movies" folder
/// names alone won't trigger if the title is "Frozen". Boundary checks
/// keep us from matching "3D" inside arbitrary tokens.
fn has_3d_marker(title: &str) -> bool {
    let lower = title.to_lowercase();
    // Common 3D markers — bracketed, hyphen-bordered, or whitespace-bordered.
    let markers = [
        " 3d ", " 3d.", " 3d-", " 3d_", "[3d]", "(3d)", ".3d.", ".3d-",
        " sbs ", "[sbs]", "(sbs)", ".sbs.",
        " side-by-side", "side by side",
        " half-sbs", "halfsbs", "half sbs",
        " ou ", "[ou]", "(ou)",  // over-under
        " htab", "[htab]", "(htab)",  // half top-and-bottom
    ];
    for m in markers {
        if lower.contains(m) {
            return true;
        }
    }
    // Endings: "Frozen 3D", "Avatar 3D"
    if lower.ends_with(" 3d") || lower.ends_with("-3d") || lower.ends_with(".3d") {
        return true;
    }
    false
}

/// Token set for fuzzy title comparison. Strips punctuation, year
/// tokens (4-digit 1900-2099), variant markers (3D / Extended /
/// Director's Cut / etc.), and stop words ("the", "a", "an") so
/// "Mary Poppins (1964)" and "1964 - Mary Poppins - Disney" yield
/// overlapping token sets. Used by `titles_match`.
fn title_tokens(s: &str) -> Vec<String> {
    const STOP_WORDS: &[&str] = &["the", "a", "an", "of", "and"];
    const VARIANT_WORDS: &[&str] = &[
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
        "remastered",
        "hd",
        "bluray",
        "brrip",
        "dvdrip",
        "webrip",
        "x264",
        "x265",
        "h264",
        "h265",
        "1080p",
        "720p",
        "480p",
        "2160p",
        "4k",
    ];
    let cleaned: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    cleaned
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
            !STOP_WORDS.contains(tok) && !VARIANT_WORDS.contains(tok)
        })
        .map(|s| s.to_string())
        .collect()
}

/// True when two titles plausibly refer to the same movie. Uses
/// token-containment: the SHORTER title's significant tokens must
/// ALL appear in the longer title. Allows "Mary Poppins" ↔ "Mary
/// Poppins Disney" (subset match) but rejects "Terminator" ↔
/// "Sherlock Holmes" (zero overlap). Empty token sets (rare —
/// titles that are entirely stop-words / years / variant markers)
/// never match anything to avoid mass-pairing junk identities.
fn titles_match(a: &str, b: &str) -> bool {
    let ta = title_tokens(a);
    let tb = title_tokens(b);
    if ta.is_empty() || tb.is_empty() {
        return false;
    }
    let (shorter, longer) = if ta.len() <= tb.len() {
        (&ta, &tb)
    } else {
        (&tb, &ta)
    };
    let long_set: std::collections::HashSet<&String> = longer.iter().collect();
    shorter.iter().all(|t| long_set.contains(t))
}

/// Cut-detection threshold per librrary_directive.md §5: when runtime
/// differs by more than this fraction, we treat the candidates as
/// likely-different-cuts (Theatrical / Extended / Director's).
pub const CUT_DELTA_THRESHOLD: f64 = 0.05;

/// True when two durations imply a cut-difference (not just a rounding
/// discrepancy). Used by the reconciliation dialog to default the
/// profile-transfer checkbox to UNCHECKED.
pub fn is_likely_cut_difference(a_ms: u64, b_ms: u64) -> bool {
    if a_ms == 0 || b_ms == 0 {
        return false;
    }
    let delta = (a_ms as i64 - b_ms as i64).abs() as f64;
    let avg = (a_ms + b_ms) as f64 / 2.0;
    delta / avg > CUT_DELTA_THRESHOLD
}

/// Convenience adapter: score a new identity against an existing one
/// using only what's stored in the DB. Wraps `score_match`. The
/// `temporal_correlation` flag is computed by the caller (it requires
/// knowledge of recent missing-file events in the same folder).
pub fn score_identity_pair(
    new_id: &LibraryIdentity,
    new_path: &Path,
    new_resolution: Option<&str>,
    new_codec: Option<&str>,
    existing_id: &LibraryIdentity,
    existing_path: Option<&Path>,
    existing_resolution: Option<&str>,
    existing_codec: Option<&str>,
    temporal_correlation: bool,
) -> MatchVerdict {
    let new_parsed = parse_filename(new_path);
    let new_filename = new_path
        .file_name()
        .and_then(|s| s.to_str());
    let existing_filename = existing_path
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str());
    score_match(
        &new_id.cheap_fingerprint,
        &new_parsed,
        new_id.duration_ms as u64,
        new_resolution,
        new_codec,
        &existing_id.cheap_fingerprint,
        existing_id.movie_title.as_deref(),
        existing_id.movie_year,
        existing_id.duration_ms as u64,
        existing_resolution,
        existing_codec,
        ExtraSignals {
            new_tmdb_id: new_id.tmdb_id,
            existing_tmdb_id: existing_id.tmdb_id,
            temporal_correlation,
            new_filename,
            existing_filename,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(title: &str, year: Option<i64>) -> ParsedFilename {
        ParsedFilename { title: title.to_string(), year }
    }

    #[test]
    fn cheap_fp_match_is_certain() {
        let v = score_match(
            "abc", &parsed("Movie", Some(2020)), 5_000_000, None, None,
            "abc", Some("Movie"), Some(2020), 5_000_000, None, None,
            ExtraSignals::default(),
        );
        assert_eq!(v.band, MatchBand::Certain);
    }

    #[test]
    fn upgrade_pattern_is_probable() {
        // Different fp, same title+year, similar duration, resolution differs.
        let v = score_match(
            "xyz", &parsed("Moana", Some(2016)), 6_240_000,
            Some("3840x2160"), Some("hevc"),
            "abc", Some("Moana"), Some(2016), 6_180_000,
            Some("1920x1080"), Some("h264"),
            ExtraSignals::default(),
        );
        assert_eq!(v.band, MatchBand::Probable);
    }

    #[test]
    fn duration_alone_is_unrelated() {
        let v = score_match(
            "xyz", &parsed("Other Movie", None), 6_000_000, None, None,
            "abc", Some("Some Movie"), Some(2010), 6_010_000, None, None,
            ExtraSignals::default(),
        );
        assert_eq!(v.band, MatchBand::Unrelated);
    }

    #[test]
    fn title_alone_is_unrelated() {
        let v = score_match(
            "xyz", &parsed("Moana", Some(2016)), 1_000_000, None, None,
            "abc", Some("Moana"), Some(2016), 9_000_000, None, None,
            ExtraSignals::default(),
        );
        assert_eq!(v.band, MatchBand::Unrelated);
    }

    #[test]
    fn tmdb_id_match_is_probable_on_its_own() {
        // Two identities pointing at the same TMDb row → same logical
        // movie. Surface as Probable even when filenames / titles /
        // durations disagree (user might have linked one identity to
        // the wrong TMDb row; the dialog gives them the chance to
        // reject). Hard-rule above the title check.
        let v = score_match(
            "xyz", &parsed("Random Filename", None), 1_000_000, None, None,
            "abc", None, None, 9_000_000, None, None,
            ExtraSignals {
                new_tmdb_id: Some(12345),
                existing_tmdb_id: Some(12345),
                temporal_correlation: false,
                new_filename: None,
                existing_filename: None,
            },
        );
        assert_eq!(v.band, MatchBand::Probable);
    }

    #[test]
    fn trailer_vs_feature_is_unrelated() {
        // Title fuzzy-matches AND year matches, but durations differ
        // 89% → almost certainly a trailer / clip. The duration-sanity
        // check kicks in and overrides the title+year agreement.
        let v = score_match(
            "xyz", &parsed("Moana", Some(2016)), 1_000_000, None, None,
            "abc", Some("Moana"), Some(2016), 9_000_000, None, None,
            ExtraSignals::default(),
        );
        assert_eq!(v.band, MatchBand::Unrelated);
    }

    #[test]
    fn title_year_match_at_similar_runtime_is_probable() {
        // "Mary Poppins (1964)" vs "Mary Poppins 1964" — different
        // fingerprints (different encodes), same logical movie. Both
        // ~140 min. Should be Probable.
        let v = score_match(
            "xyz", &parsed("Mary Poppins", Some(1964)), 8_400_000, None, None,
            "abc", Some("Mary Poppins"), Some(1964), 8_400_000, None, None,
            ExtraSignals::default(),
        );
        assert_eq!(v.band, MatchBand::Probable);
    }
}
