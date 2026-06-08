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

    let mut strong_signals = 0u32;

    // Signal 1 — duration within ±3 % (strong but dangerous).
    if existing_duration_ms > 0 && new_duration_ms > 0 {
        let d = (new_duration_ms as i64 - existing_duration_ms as i64).abs() as f64;
        let avg = (new_duration_ms + existing_duration_ms) as f64 / 2.0;
        let pct = d / avg * 100.0;
        if pct <= 3.0 {
            signals.push(format!("duration matches within {pct:.1}%"));
            strong_signals += 1;
        }
    }

    // Signal 2 — parsed title + year match (strong).
    if let (Some(existing_title), Some(existing_year), Some(new_year)) =
        (existing_parsed_title, existing_parsed_year, new_parsed.year)
    {
        if existing_year == new_year && titles_match(existing_title, &new_parsed.title) {
            signals.push(format!(
                "parsed title+year match (\"{}\" / {existing_year})",
                existing_title
            ));
            strong_signals += 1;
        }
    }

    // Signal 3 — embedded metadata title/year via TMDB-id (medium).
    // Two distinct identities pointing at the same TMDB row are almost
    // certainly the same movie; this is a high-quality signal even when
    // the filename and duration disagree.
    if let (Some(a), Some(b)) = (extra.new_tmdb_id, extra.existing_tmdb_id) {
        if a == b {
            signals.push(format!("embedded TMDb id matches (id={a})"));
            strong_signals += 1;
        }
    }

    // Signal 4 — temporal correlation (medium). Caller passes true when
    // a previously-indexed file in the same folder vanished recently
    // and this candidate appeared during that window.
    if extra.temporal_correlation {
        signals.push("temporal correlation (known file vanished, this appeared)".into());
        strong_signals += 1;
    }

    // Signal 5 — resolution / codec differ from the match (medium).
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
        strong_signals += 1;
    }

    let band = if strong_signals >= 2 {
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

fn titles_match(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        s.chars()
            .filter(|c| c.is_alphanumeric() || c.is_whitespace())
            .collect::<String>()
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    }
    norm(a) == norm(b)
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
    fn tmdb_id_plus_temporal_is_probable() {
        // No duration / title / resolution signals — purely the two
        // new "medium" signals. Sum to 2, which crosses the threshold.
        let v = score_match(
            "xyz", &parsed("Random Filename", None), 1_000_000, None, None,
            "abc", None, None, 9_000_000, None, None,
            ExtraSignals {
                new_tmdb_id: Some(12345),
                existing_tmdb_id: Some(12345),
                temporal_correlation: true,
            },
        );
        assert_eq!(v.band, MatchBand::Probable);
    }

    #[test]
    fn tmdb_id_alone_is_unrelated() {
        // Just TMDb match without anything else is one signal → UNRELATED.
        let v = score_match(
            "xyz", &parsed("Random Filename", None), 1_000_000, None, None,
            "abc", None, None, 9_000_000, None, None,
            ExtraSignals {
                new_tmdb_id: Some(12345),
                existing_tmdb_id: Some(12345),
                temporal_correlation: false,
            },
        );
        assert_eq!(v.band, MatchBand::Unrelated);
    }
}
