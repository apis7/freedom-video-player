//! Metadata helpers — filename parsing + TMDb enrichment.
//!
//! Filename parsing covers the common scene-release patterns:
//!   "Movie.Title.2020.1080p.x264-GROUP.mkv"          → "Movie Title", 2020
//!   "Movie Title (2020).mkv"                          → "Movie Title", 2020
//!   "Movie Title 2020 1080p.mkv"                      → "Movie Title", 2020
//!   "Movie Title.mkv"                                 → "Movie Title", None
//!
//! When the parsed title is later swapped for a real TMDb match, the
//! `manual_title` flag stays unset so a re-scan can replace it. Once the
//! user edits the title manually, the flag flips and auto-metadata
//! never clobbers it.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFilename {
    pub title: String,
    pub year: Option<i64>,
}

/// Parse a video filename into a best-guess title + year. Pure string
/// manipulation — never touches disk or network.
pub fn parse_filename(path: &Path) -> ParsedFilename {
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    parse_stem(&stem)
}

fn parse_stem(stem: &str) -> ParsedFilename {
    // Strip leading "[GROUP]" or "(Group)" tags scene releases sometimes use.
    let mut s = stem.trim().to_string();
    while s.starts_with('[') || s.starts_with('(') {
        let close = if s.starts_with('[') { ']' } else { ')' };
        if let Some(end) = s.find(close) {
            s = s[end + 1..].trim_start().to_string();
        } else {
            break;
        }
    }
    // Replace separator dots/underscores with spaces so the year regex
    // catches "Movie.Title.2020" as well as "Movie Title 2020".
    let normalized: String = s
        .chars()
        .map(|c| match c {
            '.' | '_' => ' ',
            _ => c,
        })
        .collect();

    // Walk tokens, find the FIRST 4-digit year between 1900 and 2099 that's
    // a standalone token. Title is everything before; trailing junk
    // (resolution, codec, group, etc.) is discarded.
    let tokens: Vec<&str> = normalized.split_whitespace().collect();
    let mut year_idx: Option<usize> = None;
    for (i, t) in tokens.iter().enumerate() {
        // Allow trailing punctuation glued to the year (rare but happens).
        let cleaned: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
        if cleaned.len() == 4 {
            if let Ok(y) = cleaned.parse::<i64>() {
                if (1900..=2099).contains(&y) {
                    year_idx = Some(i);
                    break;
                }
            }
        }
    }
    let (title_tokens, year) = match year_idx {
        Some(i) => (
            tokens[..i].to_vec(),
            tokens[i]
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<i64>()
                .ok(),
        ),
        None => {
            // No year. Drop the trailing tech-spec tokens we recognize
            // (resolution like "1080p", codec tags, group suffixes) so the
            // title isn't "Movie Title 1080p x265 GROUP".
            let mut cut = tokens.len();
            for (i, t) in tokens.iter().enumerate() {
                let lower = t.to_lowercase();
                if is_techspec_token(&lower) {
                    cut = i;
                    break;
                }
            }
            (tokens[..cut].to_vec(), None)
        }
    };

    // Strip any wrapping parens/brackets from individual title tokens
    // (e.g. "Moana (2016).mkv" → tokens included "(2016)").
    let title = title_tokens
        .iter()
        .map(|t| t.trim_matches(|c: char| matches!(c, '(' | ')' | '[' | ']' | '-' | ',')))
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string();

    ParsedFilename { title, year }
}

fn is_techspec_token(lower: &str) -> bool {
    // Resolutions
    if matches!(lower, "480p" | "576p" | "720p" | "1080p" | "1440p" | "2160p" | "4k" | "uhd")
    {
        return true;
    }
    // Source / encoding hints commonly appearing in filenames
    matches!(
        lower,
        "bluray"
            | "blu-ray"
            | "brrip"
            | "bdrip"
            | "webrip"
            | "web-dl"
            | "webdl"
            | "hdtv"
            | "dvdrip"
            | "remux"
            | "x264"
            | "x265"
            | "h264"
            | "h265"
            | "hevc"
            | "10bit"
            | "8bit"
            | "hdr"
            | "hdr10"
            | "dts"
            | "dts-hd"
            | "aac"
            | "ac3"
            | "atmos"
            | "5.1"
            | "7.1"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(stem: &str) -> ParsedFilename {
        parse_stem(stem)
    }

    #[test]
    fn dot_separated_with_year() {
        let r = p("Moana.2016.1080p.BluRay.x264-GROUP");
        assert_eq!(r.title, "Moana");
        assert_eq!(r.year, Some(2016));
    }

    #[test]
    fn parens_year() {
        let r = p("Moana (2016)");
        assert_eq!(r.title, "Moana");
        assert_eq!(r.year, Some(2016));
    }

    #[test]
    fn space_separated_with_year() {
        let r = p("Moana 2016 1080p");
        assert_eq!(r.title, "Moana");
        assert_eq!(r.year, Some(2016));
    }

    #[test]
    fn no_year_strips_techspec() {
        let r = p("My Home Video 1080p x265");
        assert_eq!(r.title, "My Home Video");
        assert_eq!(r.year, None);
    }

    #[test]
    fn group_prefix() {
        let r = p("[GROUP] Some Movie 2020");
        assert_eq!(r.title, "Some Movie");
        assert_eq!(r.year, Some(2020));
    }

    #[test]
    fn date_token_is_recognized_as_year() {
        // 2023-08-14 lands first → "2023" is the only standalone 4-digit
        // group, but the trailing -08-14 sticks to it as one token. The
        // filename digit-extraction collapses to "20230814" which isn't
        // 4 chars long, so the year regex skips it. End result: title
        // includes the whole date and no year is extracted.
        let r = p("Family Reunion 2023-08-14");
        assert_eq!(r.title, "Family Reunion 2023-08-14");
        assert_eq!(r.year, None);
    }
}
