//! Wordlist parser. The wordlist .md is bundled via `include_str!`; this
//! parser turns it into typed `Category` records.

use std::sync::OnceLock;

const BUNDLED_EN: &str = include_str!("../../assets/autosnip_wordlist.md");
const BUNDLED_ES: &str = include_str!("../../assets/autosnip_wordlist_es.md");
const BUNDLED_FR: &str = include_str!("../../assets/autosnip_wordlist_fr.md");
const BUNDLED_DE: &str = include_str!("../../assets/autosnip_wordlist_de.md");

pub static WORDLIST: OnceLock<WordList> = OnceLock::new();

/// Look up a bundled wordlist by ISO-639-1 language code. Falls back to
/// English when the code is unknown.
pub fn bundled_for(lang_code: &str) -> &'static str {
    match lang_code.to_lowercase().as_str() {
        "es" => BUNDLED_ES,
        "fr" => BUNDLED_FR,
        "de" => BUNDLED_DE,
        _ => BUNDLED_EN,
    }
}

#[derive(Debug, Clone)]
pub enum SnipActionKind {
    Skip,
    Silence,
    Freeze,
    Replace,
}

#[derive(Debug, Clone)]
pub enum Bucket {
    Flag,
    Snip(SnipActionKind),
}

#[derive(Debug, Clone)]
pub struct Category {
    pub name: String,
    pub bucket: Bucket,
    pub keywords: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct WordList {
    pub categories: Vec<Category>,
}

pub fn parse_bundled() -> WordList {
    parse(BUNDLED_EN)
}

/// Parse the bundled wordlist for a specific language. Currently used by the
/// AutoSnip backend command when a non-default language is requested.
pub fn parse_for(lang_code: &str) -> WordList {
    parse(bundled_for(lang_code))
}

pub fn parse(text: &str) -> WordList {
    let mut categories: Vec<Category> = Vec::new();
    let mut current: Option<Category> = None;

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("##") {
            // Header line: "<name> : <bucket> [: <action>]"
            let header = rest.trim();
            if let Some(cat) = parse_header(header) {
                if let Some(done) = current.take() {
                    if !done.keywords.is_empty() {
                        categories.push(done);
                    }
                }
                current = Some(cat);
            }
            continue;
        }
        if line.starts_with('#') {
            continue; // comment
        }
        // Body line: comma-separated keywords.
        if let Some(cat) = current.as_mut() {
            for piece in line.split(',') {
                let kw = piece.trim();
                if kw.is_empty() || kw.starts_with('#') {
                    continue;
                }
                cat.keywords.push(kw.to_string());
            }
        }
    }
    if let Some(done) = current.take() {
        if !done.keywords.is_empty() {
            categories.push(done);
        }
    }
    WordList { categories }
}

/// Parse a header like:
///   "language : snip : skip"             → name "language", Snip(Skip)
///   "agenda: feminism : flag"            → name "agenda: feminism", Flag
///   "agenda: socialism : snip : silence" → name "agenda: socialism", Snip(Silence)
///
/// Category names may contain colons, so we detect the bucket and action by
/// matching known keywords from the right side rather than by index.
fn parse_header(header: &str) -> Option<Category> {
    let parts: Vec<&str> = header.split(':').map(|s| s.trim()).collect();
    if parts.len() < 2 {
        return None;
    }

    fn is_action(s: &str) -> bool {
        matches!(
            s.to_lowercase().as_str(),
            "skip"
                | "silence"
                | "freeze"
                | "freeze_frame"
                | "freeze-frame"
                | "replace"
                | "audio_replace"
                | "audio-replace"
        )
    }
    fn is_bucket(s: &str) -> bool {
        matches!(s.to_lowercase().as_str(), "snip" | "flag")
    }

    let last = parts.last()?;
    let (bucket_idx, action_part): (usize, Option<&str>) =
        if is_action(last) && parts.len() >= 3 {
            (parts.len() - 2, Some(*last))
        } else {
            (parts.len() - 1, None)
        };

    let bucket_part = parts[bucket_idx];
    if !is_bucket(bucket_part) {
        return None;
    }

    let name = parts[..bucket_idx].join(": ");
    let bucket = match bucket_part.to_lowercase().as_str() {
        "flag" => Bucket::Flag,
        "snip" => {
            let action = match action_part.unwrap_or("skip").to_lowercase().as_str() {
                "silence" => SnipActionKind::Silence,
                "freeze" | "freeze_frame" | "freeze-frame" => SnipActionKind::Freeze,
                "replace" | "audio_replace" | "audio-replace" => SnipActionKind::Replace,
                _ => SnipActionKind::Skip,
            };
            Bucket::Snip(action)
        }
        _ => return None,
    };
    Some(Category {
        name: name.trim().to_string(),
        bucket,
        keywords: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_simple_section() {
        let wl = parse("## language : snip : skip\nfuck, shit\ndamn");
        assert_eq!(wl.categories.len(), 1);
        let c = &wl.categories[0];
        assert_eq!(c.name, "language");
        assert_eq!(c.keywords, vec!["fuck", "shit", "damn"]);
        assert!(matches!(c.bucket, Bucket::Snip(SnipActionKind::Skip)));
    }

    #[test]
    fn flag_bucket_no_action() {
        let wl = parse("## violence : flag\nkill, murder");
        assert!(matches!(wl.categories[0].bucket, Bucket::Flag));
    }

    #[test]
    fn category_name_with_colon() {
        let wl = parse("## agenda: feminism : flag\npatriarchy");
        assert_eq!(wl.categories[0].name, "agenda: feminism");
    }

    #[test]
    fn comments_and_blank_lines_ignored() {
        let wl = parse("# top comment\n## x : flag\n# inner comment\nfoo\n\n  \n");
        assert_eq!(wl.categories[0].keywords, vec!["foo"]);
    }

    #[test]
    fn bundled_file_parses() {
        let wl = parse_bundled();
        // Should have at least a handful of categories from the seed.
        assert!(wl.categories.len() >= 5, "categories = {}", wl.categories.len());
        // language must be a snip bucket per the seed file.
        let lang = wl.categories.iter().find(|c| c.name == "language");
        assert!(lang.is_some());
    }
}
