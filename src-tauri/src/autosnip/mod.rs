//! AutoSnip — subtitle-driven flag + snip generation.
//!
//! The wordlist is bundled at compile time via `include_str!`. Editing
//! `src-tauri/assets/autosnip_wordlist.md` requires a backend rebuild.
//!
//! Pipeline:
//!   1. Load wordlist (parsed once, cached for the session).
//!   2. Find a subtitle file in the video's folder (`.srt` for now).
//!   3. Parse subs.
//!   4. For each subtitle entry, scan its text against every wordlist
//!      keyword; produce a `Match` per hit.
//!   5. Frontend renders matches in a preview modal; user applies a subset.

pub mod srt;
pub mod wordlist;

use serde::Serialize;
use std::path::Path;

pub use wordlist::{Bucket, Category, SnipActionKind, WordList};

#[derive(Serialize, Clone, Debug)]
pub struct AutoSnipMatch {
    pub category: String,
    /// "flag" or one of the snip actions ("skip", "silence", "freeze", "replace").
    pub bucket: String,
    pub keyword: String,
    pub subtitle_index: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Locate a subtitle sidecar next to the given video file. Looks for:
///   * `<video-basename>.srt`
///   * `<video-basename>.<anything>.srt`  (e.g. .en.srt, .English.srt)
/// Returns the first match in lexicographic order.
pub fn find_subtitle_file(video_path: &Path) -> Option<std::path::PathBuf> {
    let folder = video_path.parent()?;
    let video_stem = video_path.file_stem()?.to_str()?.to_lowercase();
    let mut candidates: Vec<std::path::PathBuf> = std::fs::read_dir(folder)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            let Some(ext) = p.extension().and_then(|e| e.to_str()) else {
                return false;
            };
            if !ext.eq_ignore_ascii_case("srt") {
                return false;
            }
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                return false;
            };
            let stem_lower = stem.to_lowercase();
            stem_lower == video_stem || stem_lower.starts_with(&format!("{video_stem}."))
        })
        .collect();
    candidates.sort();
    candidates.into_iter().next()
}

/// End-to-end: read external subs from disk, match against the bundled
/// wordlist for `lang_code`, return the flat list of matches. `lang_code`
/// defaults to "en" when None / unknown.
pub fn run_for_video(
    video_path: &Path,
    lang_code: Option<&str>,
) -> Result<Vec<AutoSnipMatch>, String> {
    let subs_path = find_subtitle_file(video_path)
        .ok_or_else(|| "no subtitle file found".to_string())?;
    let content = std::fs::read_to_string(&subs_path)
        .map_err(|e| format!("read {}: {e}", subs_path.display()))?;
    let subs = srt::parse(&content).map_err(|e| format!("parse srt: {e}"))?;
    let wl = wordlist::parse_for(lang_code.unwrap_or("en"));
    Ok(matches(&wl, &subs))
}

/// Match pre-parsed subtitle entries against the wordlist. Used by the
/// embedded-subs fallback flow where the frontend already extracted entries.
pub fn run_for_entries(
    entries: &[srt::SubtitleEntry],
    lang_code: Option<&str>,
) -> Vec<AutoSnipMatch> {
    let wl = wordlist::parse_for(lang_code.unwrap_or("en"));
    matches(&wl, entries)
}

/// Scan every subtitle entry against every keyword in the wordlist.
fn matches(wl: &WordList, subs: &[srt::SubtitleEntry]) -> Vec<AutoSnipMatch> {
    let mut out = Vec::new();
    for (idx, entry) in subs.iter().enumerate() {
        let text_lower = entry.text.to_lowercase();
        for cat in &wl.categories {
            for kw in &cat.keywords {
                if !word_matches(&text_lower, kw) {
                    continue;
                }
                let bucket = match &cat.bucket {
                    Bucket::Flag => "flag".to_string(),
                    Bucket::Snip(a) => match a {
                        SnipActionKind::Skip => "skip".to_string(),
                        SnipActionKind::Silence => "silence".to_string(),
                        SnipActionKind::Freeze => "freeze".to_string(),
                        SnipActionKind::Replace => "replace".to_string(),
                    },
                };
                out.push(AutoSnipMatch {
                    category: cat.name.clone(),
                    bucket,
                    keyword: kw.clone(),
                    subtitle_index: idx,
                    start_ms: entry.start_ms,
                    end_ms: entry.end_ms,
                    text: entry.text.clone(),
                });
            }
        }
    }
    out
}

/// Word-boundary-aware match. Single-word keywords ALWAYS match only whole
/// tokens (split on anything that isn't alphanumeric or apostrophe), so
/// short words like "ass" can't false-positive on "assess" or "assignment".
/// Multi-word phrases match as substrings (so a phrase like "in bed with"
/// catches the phrase exactly).
fn word_matches(text_lower: &str, keyword: &str) -> bool {
    let kw = keyword.to_lowercase();
    if kw.is_empty() {
        return false;
    }
    if kw.contains(char::is_whitespace) {
        return text_lower.contains(&kw);
    }
    text_lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .any(|w| w == kw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autosnip::srt::SubtitleEntry;

    #[test]
    fn whole_word_match_only() {
        let text = "she had a passion for it".to_lowercase();
        assert!(!word_matches(&text, "ass"));
        assert!(word_matches(&text, "passion"));
    }

    #[test]
    fn short_word_does_not_false_positive_on_compound() {
        // The user-facing reason this matters: "ass" must NOT match inside
        // "assess", "assignment", "assassin", etc. Single-word matching is
        // already whole-token-only, but lock it in with a test.
        let cases = ["she assessed the room", "his assignment is due", "the assassin fled"];
        for c in cases {
            assert!(!word_matches(&c.to_lowercase(), "ass"), "false positive on {c}");
        }
        // But should still match the standalone word.
        assert!(word_matches(&"kick his ass".to_lowercase(), "ass"));
    }

    #[test]
    fn multiword_phrase_substring() {
        let text = "i had a one night stand last weekend".to_lowercase();
        assert!(word_matches(&text, "one night stand"));
        assert!(!word_matches(&text, "one night stands"));
    }

    #[test]
    fn case_insensitive() {
        assert!(word_matches(&"FUCK off".to_lowercase(), "fuck"));
    }

    #[test]
    fn matches_against_wordlist() {
        let wl = wordlist::parse(
            "## language : snip : skip\nfuck\nshit\n\n## sex : snip : silence\nnaked",
        );
        let subs = vec![
            SubtitleEntry { start_ms: 100, end_ms: 200, text: "Oh shit".to_string() },
            SubtitleEntry { start_ms: 300, end_ms: 400, text: "I was NAKED".to_string() },
            SubtitleEntry { start_ms: 500, end_ms: 600, text: "perfectly fine".to_string() },
        ];
        let m = matches(&wl, &subs);
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].keyword, "shit");
        assert_eq!(m[1].keyword, "naked");
    }
}
