//! Minimal SRT parser. Tolerates BOM, blank lines, CRLF, and missing
//! sequence numbers. Output is `{ start_ms, end_ms, text }` ordered by
//! start time.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubtitleEntry {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

pub fn parse(input: &str) -> Result<Vec<SubtitleEntry>, String> {
    // Strip UTF-8 BOM if present.
    let s = input.trim_start_matches('\u{FEFF}');

    let lines: Vec<&str> = s.lines().collect();
    let mut entries = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        // Skip blank lines.
        while i < lines.len() && lines[i].trim().is_empty() {
            i += 1;
        }
        if i >= lines.len() {
            break;
        }
        // Optional sequence number.
        let next = lines[i].trim();
        if next.parse::<u32>().is_ok() {
            i += 1;
            if i >= lines.len() {
                break;
            }
        }
        // Timestamp line: "00:00:01,500 --> 00:00:04,000"
        let ts = lines[i].trim();
        let Some((start, end)) = parse_timestamp_line(ts) else {
            // Skip malformed entry by advancing to next blank.
            while i < lines.len() && !lines[i].trim().is_empty() {
                i += 1;
            }
            continue;
        };
        i += 1;
        // Text lines until next blank.
        let mut text_lines = Vec::new();
        while i < lines.len() && !lines[i].trim().is_empty() {
            text_lines.push(lines[i].trim_end_matches('\r'));
            i += 1;
        }
        let text = text_lines.join(" ");
        let cleaned = strip_html(&text);
        if !cleaned.trim().is_empty() {
            entries.push(SubtitleEntry {
                start_ms: start,
                end_ms: end,
                text: cleaned,
            });
        }
    }
    entries.sort_by_key(|e| e.start_ms);
    Ok(entries)
}

fn parse_timestamp_line(line: &str) -> Option<(u64, u64)> {
    let mut parts = line.split("-->");
    let lhs = parts.next()?.trim();
    let rhs = parts.next()?.trim();
    Some((parse_timestamp(lhs)?, parse_timestamp(rhs)?))
}

/// Parses "HH:MM:SS,mmm" (SRT) or "HH:MM:SS.mmm" (VTT-ish) to milliseconds.
fn parse_timestamp(ts: &str) -> Option<u64> {
    let cleaned = ts.replace(',', ".");
    let mut hms_ms = cleaned.split('.');
    let hms = hms_ms.next()?;
    let ms_str = hms_ms.next().unwrap_or("0");
    let ms: u64 = ms_str.parse().ok()?;
    let mut bits = hms.split(':');
    let h: u64 = bits.next()?.parse().ok()?;
    let m: u64 = bits.next()?.parse().ok()?;
    let s: u64 = bits.next()?.parse().ok()?;
    Some(h * 3_600_000 + m * 60_000 + s * 1_000 + ms)
}

/// Strip common SRT formatting tags: <i>, <b>, <u>, <font ...>, {...}.
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    let mut in_brace = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            '{' => in_brace = true,
            '}' if in_brace => in_brace = false,
            _ if !in_tag && !in_brace => out.push(ch),
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_srt() {
        let input = "1\n00:00:01,500 --> 00:00:04,000\nHello world\n\n2\n00:00:05,000 --> 00:00:06,500\nSecond line";
        let entries = parse(input).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].start_ms, 1500);
        assert_eq!(entries[0].end_ms, 4000);
        assert_eq!(entries[0].text, "Hello world");
        assert_eq!(entries[1].start_ms, 5000);
    }

    #[test]
    fn handles_html_tags() {
        let input = "1\n00:00:01,000 --> 00:00:02,000\n<i>tilted</i> and <b>bold</b>";
        let entries = parse(input).unwrap();
        assert_eq!(entries[0].text, "tilted and bold");
    }

    #[test]
    fn handles_bom_and_crlf() {
        let input = "\u{FEFF}1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n";
        let entries = parse(input).unwrap();
        assert_eq!(entries[0].text, "Hi");
    }

    #[test]
    fn skips_malformed_entries() {
        let input = "garbage\n\n2\n00:00:05,000 --> 00:00:06,500\nValid";
        let entries = parse(input).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "Valid");
    }
}
