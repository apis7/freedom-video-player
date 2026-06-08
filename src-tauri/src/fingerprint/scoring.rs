//! Score a `.free` profile's fingerprint against an open video file's
//! fingerprint, and scan a folder for plausibly-matching profiles.

use crate::fingerprint::phash;
use crate::profile::format::{Fingerprint, FreeFile};
use crate::profile::io;
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Tolerance (ms) when comparing durations. Containers can round differently.
const DURATION_TOLERANCE_MS: i64 = 2000;

/// Average Hamming distance (per dHash sample) below which we consider the
/// pHashes "visually identical" — survives re-encoding.
const PHASH_EXACT_THRESHOLD: f64 = 10.0;
/// Threshold for "visually similar" (same content, looks different).
const PHASH_SOFT_THRESHOLD: f64 = 22.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchQuality {
    NoMatch,
    Weak,
    Soft,
    Exact,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchScore {
    pub quality: MatchQuality,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MatchResult {
    pub path: String,
    pub profile: FreeFile,
    pub score: MatchScore,
}

pub fn score_against(profile: &Fingerprint, video: &Fingerprint) -> MatchScore {
    let mut reasons = Vec::new();

    let filename_match = profile.filename == video.filename;
    let size_match = profile.size_bytes == video.size_bytes;
    let codec_match = !profile.codec.is_empty()
        && !video.codec.is_empty()
        && profile.codec == video.codec;
    let container_match = !profile.container.is_empty()
        && !video.container.is_empty()
        && profile.container == video.container;
    let duration_close =
        (profile.duration_ms as i64 - video.duration_ms as i64).abs() <= DURATION_TOLERANCE_MS;

    reasons.push(if filename_match {
        "filename matches".into()
    } else {
        format!("filename differs (\"{}\" → \"{}\")", profile.filename, video.filename)
    });
    reasons.push(if size_match {
        "size matches".into()
    } else {
        format!("size differs ({} → {} bytes)", profile.size_bytes, video.size_bytes)
    });
    reasons.push(if codec_match {
        format!("codec matches ({})", profile.codec)
    } else {
        format!("codec differs ({} → {})", profile.codec, video.codec)
    });
    reasons.push(if container_match {
        format!("container matches ({})", profile.container)
    } else {
        format!("container differs ({} → {})", profile.container, video.container)
    });
    reasons.push(if duration_close {
        format!(
            "duration within tolerance (Δ {} ms)",
            (profile.duration_ms as i64 - video.duration_ms as i64).abs()
        )
    } else {
        format!(
            "duration differs (Δ {} ms)",
            (profile.duration_ms as i64 - video.duration_ms as i64).abs()
        )
    });

    // pHash comparison — when BOTH fingerprints have samples, compute the
    // average Hamming distance across matching positions. Low distance is
    // strong evidence two fingerprints represent the same source video,
    // even when filename + size differ (e.g. re-encoded copy).
    let phash_avg = average_phash_distance(profile, video);
    if let Some(avg) = phash_avg {
        reasons.push(format!("pHash avg distance = {avg:.1} (lower = more similar)"));
    }

    let phash_exact = phash_avg.map(|d| d <= PHASH_EXACT_THRESHOLD).unwrap_or(false);
    let phash_soft = phash_avg.map(|d| d <= PHASH_SOFT_THRESHOLD).unwrap_or(false);

    let quality = if filename_match && size_match && codec_match && container_match && duration_close {
        MatchQuality::Exact
    } else if phash_exact && duration_close {
        // Same visual content + similar duration = exact, regardless of
        // filename/codec/container (re-encoded copy).
        MatchQuality::Exact
    } else if filename_match && size_match && duration_close {
        // Filename + size + duration is essentially zero false-positive
        // territory — accept as Exact even if codec / container / pHash
        // weren't recorded (e.g. autosaved profile for a file whose
        // demuxer parsing failed on the transient libmpv).
        MatchQuality::Exact
    } else if duration_close && (codec_match || container_match) && !filename_match {
        MatchQuality::Soft
    } else if phash_soft && duration_close {
        MatchQuality::Soft
    } else if duration_close {
        MatchQuality::Weak
    } else {
        MatchQuality::NoMatch
    };

    MatchScore { quality, reasons }
}

/// Mean Hamming distance across matching-position pHash samples, or None
/// when either side has no samples.
fn average_phash_distance(a: &Fingerprint, b: &Fingerprint) -> Option<f64> {
    if a.phash_samples.is_empty() || b.phash_samples.is_empty() {
        return None;
    }
    let mut distances: Vec<u32> = Vec::new();
    for sa in &a.phash_samples {
        // Find the closest-position sample on the other side.
        let Some(sb) = b
            .phash_samples
            .iter()
            .min_by(|x, y| {
                (x.position - sa.position)
                    .abs()
                    .partial_cmp(&(y.position - sa.position).abs())
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        else {
            continue;
        };
        // Only compare if the matched position is reasonably close.
        if (sb.position - sa.position).abs() > 0.1 {
            continue;
        }
        let Some(ha) = phash::parse_hex_hash(&sa.hash) else { continue };
        let Some(hb) = phash::parse_hex_hash(&sb.hash) else { continue };
        distances.push(phash::hamming_distance(ha, hb));
    }
    if distances.is_empty() {
        return None;
    }
    let sum: u32 = distances.iter().sum();
    Some(sum as f64 / distances.len() as f64)
}

/// Scan a folder for `.free` files and score each against the given video fingerprint.
/// Returns results sorted best-match first; `NoMatch` entries are excluded.
///
/// Special case for autosave files: `<stem>.fvp-autosave.free` is paired with
/// its video by name convention, not by fingerprint — autosave can fire before
/// fingerprint computation finishes, so the stored fingerprint may be empty.
/// When the basename matches we accept it as Exact and skip fingerprint scoring
/// entirely. Without this the autosave wouldn't be detected on reopen even
/// though `load_draft` (which keys by filename) still restores the snips.
pub fn scan_folder(folder: &Path, video: &Fingerprint) -> Vec<MatchResult> {
    let mut results = Vec::new();
    let entries = match std::fs::read_dir(folder) {
        Ok(e) => e,
        Err(_) => return results,
    };
    // Video stem the autosave sidecar would be paired with. `video.filename`
    // already excludes the directory, so strip the extension.
    let video_stem: Option<String> = std::path::Path::new(&video.filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned());
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("free") {
            continue;
        }
        let file = match io::load(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        // Autosave sidecar: file stem is `<videoStem>.fvp-autosave`.
        let is_autosave_for_this_video = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|stem| stem.strip_suffix(".fvp-autosave"))
            .zip(video_stem.as_deref())
            .map(|(a, b)| a == b)
            .unwrap_or(false);

        let score = if is_autosave_for_this_video {
            MatchScore {
                quality: MatchQuality::Exact,
                reasons: vec!["paired by autosave filename convention".into()],
            }
        } else {
            score_against(&file.payload.fingerprint, video)
        };
        if score.quality == MatchQuality::NoMatch {
            continue;
        }
        results.push(MatchResult {
            path: path.to_string_lossy().into_owned(),
            profile: file,
            score,
        });
    }
    results.sort_by(|a, b| b.score.quality.cmp(&a.score.quality));
    results
}

#[allow(dead_code)]
fn _matchresult_path(p: &PathBuf) -> String {
    p.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp(filename: &str, size: u64, codec: &str, container: &str, dur: u64) -> Fingerprint {
        Fingerprint {
            filename: filename.into(),
            size_bytes: size,
            codec: codec.into(),
            container: container.into(),
            duration_ms: dur,
            phash_samples: vec![],
        }
    }

    #[test]
    fn exact_match_all_fields_equal() {
        let a = fp("movie.mkv", 1000, "hevc", "matroska", 60_000);
        let b = a.clone();
        assert_eq!(score_against(&a, &b).quality, MatchQuality::Exact);
    }

    #[test]
    fn soft_match_filename_differs() {
        let a = fp("movie.mkv", 1000, "hevc", "matroska", 60_000);
        let b = fp("movie-1080p.mkv", 1000, "hevc", "matroska", 60_000);
        assert_eq!(score_against(&a, &b).quality, MatchQuality::Soft);
    }

    #[test]
    fn weak_match_only_duration_close() {
        let a = fp("a.mkv", 1000, "hevc", "matroska", 60_000);
        let b = fp("b.mp4", 2000, "h264", "mov", 60_100);
        assert_eq!(score_against(&a, &b).quality, MatchQuality::Weak);
    }

    #[test]
    fn no_match_duration_off() {
        let a = fp("movie.mkv", 1000, "hevc", "matroska", 60_000);
        let b = fp("movie.mkv", 1000, "hevc", "matroska", 90_000);
        assert_eq!(score_against(&a, &b).quality, MatchQuality::NoMatch);
    }

    #[test]
    fn duration_tolerance_2_seconds() {
        let a = fp("a.mkv", 1, "hevc", "matroska", 60_000);
        let b_just_inside = fp("a.mkv", 1, "hevc", "matroska", 62_000);
        let b_just_outside = fp("a.mkv", 1, "hevc", "matroska", 62_500);
        assert_eq!(score_against(&a, &b_just_inside).quality, MatchQuality::Exact);
        assert_ne!(score_against(&a, &b_just_outside).quality, MatchQuality::Exact);
    }
}
