//! `.free` file schema. Versioned. Signed via Ed25519 over the canonical
//! serialization of the `payload` field (see `signing.rs`).

use serde::{Deserialize, Serialize};

/// Current schema version. Bump on any breaking change.
pub const SCHEMA_VERSION: u32 = 1;

/// Top-level `.free` file structure. Persisted as JSON.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FreeFile {
    pub schema: u32,
    /// Base64-encoded Ed25519 signature over the canonical bytes of `payload`.
    /// `None` for unsigned local profiles.
    pub signature: Option<String>,
    /// Base64-encoded Ed25519 verifying key. `None` for unsigned.
    pub pubkey: Option<String>,
    /// Optional uploader handle (only set if signed with a registered key).
    pub uploader: Option<String>,
    pub payload: Payload,
}

/// Everything inside the signature envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Payload {
    pub fingerprint: Fingerprint,
    pub metadata: ProfileMetadata,
    pub snips: Vec<Snip>,
    pub groups: Vec<SnipGroup>,
    /// User-defined named markers on the timeline. `#[serde(default)]` so
    /// older `.free` files (pre-marker schema) load with an empty list.
    #[serde(default)]
    pub markers: Vec<Marker>,
    /// Append-only log of author edits — every save tacks on an entry if
    /// the (handle, day) tuple doesn't match the last one (dedup keeps
    /// the log short). Trivially altered by anyone with a text editor,
    /// so think of this as a courtesy "who's been touching this file?"
    /// not a tamper-proof audit trail. `#[serde(default)]` so older
    /// `.free` files (pre-history schema) load with an empty list.
    #[serde(default)]
    pub authorship_history: Vec<AuthorshipEvent>,
}

/// One entry in the `authorship_history` log. The handle is the author's
/// chosen alias (configured in Settings); `None` means "anonymous edit"
/// from a user who hasn't set one. The `kind` is "created" for the very
/// first entry on a brand-new profile, "modified" for everything after.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuthorshipEvent {
    /// Unix epoch seconds.
    pub at: u64,
    pub handle: Option<String>,
    pub kind: AuthorshipKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AuthorshipKind {
    Created,
    Modified,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Marker {
    pub ms: u64,
    pub name: String,
}

/// File-to-profile matching fingerprint (see directives.md "File-to-Profile matching").
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Fingerprint {
    pub filename: String,
    pub size_bytes: u64,
    /// libmpv-reported container short name, e.g. "matroska".
    pub container: String,
    /// libmpv-reported video codec, e.g. "hevc".
    pub codec: String,
    pub duration_ms: u64,
    /// Perceptual hashes sampled at fixed % marks of duration.
    pub phash_samples: Vec<PhashSample>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhashSample {
    /// Sample position, 0.0–1.0 (fraction of total duration).
    pub position: f64,
    /// Base64-encoded pHash bytes.
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProfileMetadata {
    /// Profile name as the author sees it ("Family Friendly", "No Filler", etc.).
    pub name: String,
    /// Optional movie metadata for sharing-site discovery.
    pub movie_title: Option<String>,
    pub movie_year: Option<u32>,
    /// Profile version. Increment on edits worth surfacing as an update.
    pub version: u32,
    pub notes: Option<String>,
    /// Unix epoch seconds.
    pub created: u64,
    pub modified: u64,
    /// Optional URL to the movie's IMDb parental guide. The Profile Creator
    /// surfaces this as a one-click reference for the categorization pass.
    /// `#[serde(default)]` so older `.free` files (pre–IMDb-link schema)
    /// load with `None`.
    #[serde(default)]
    pub imdb_url: Option<String>,
    /// Override aspect ratio applied to the video. `None` (or "auto")
    /// means use the video's native ratio. Values are strings libmpv
    /// understands as `video-aspect-override` — e.g. "16:9", "4:3",
    /// "2.35:1", "1.85:1", "21:9", "1:1". Persisted in the profile so
    /// users who set "this movie is mastered wrong, force 2.35:1" once
    /// get it back automatically on every reopen.
    #[serde(default)]
    pub aspect_ratio: Option<String>,
    /// MAPS rating — Media Audience Prudence Standard — for the movie
    /// played WITH this profile applied. `None` means the profile
    /// author hasn't rated it yet. The crowdsourced server rating
    /// (when the FVP sharing site exists) overrides this on display
    /// but is NOT stored locally; this field is always the embedded
    /// author rating.
    #[serde(default)]
    pub maps_filtered: Option<MapsRating>,
    /// MAPS rating for the RAW movie (no FVP profile applied). Lets
    /// users see "this movie is X without filtering, Y with the profile"
    /// at a glance.
    #[serde(default)]
    pub maps_unfiltered: Option<MapsRating>,
    /// Movie director name. ≤ 200 chars.
    #[serde(default)]
    pub movie_director: Option<String>,
    /// Top-billed cast members. ≤ 10 entries, each ≤ 200 chars.
    #[serde(default)]
    pub movie_stars: Vec<String>,
    /// Plot summary. ≤ 5000 chars.
    #[serde(default)]
    pub movie_plot: Option<String>,
    /// IMDb rating (0.0-10.0). Populated from TMDb's `vote_average`
    /// on auto-fill; user can override manually.
    #[serde(default)]
    pub imdb_rating: Option<f64>,
    /// IMDb identifier, e.g. "tt0117500". Stored so the eventual
    /// sharing site can cross-reference ratings across sources.
    #[serde(default)]
    pub imdb_id: Option<String>,
}

/// MAPS — Media Audience Prudence Standard — tier + summary.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MapsRating {
    pub tier: MapsTier,
    /// Short free-text explanation of WHY it's at this tier.
    /// ≤ `MAX_MAPS_SUMMARY_LEN` chars.
    pub summary: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MapsTier {
    Family,
    Teen,
    Adult,
    MarriedAdult,
    Degrading,
}

/// A single edit decision. See directives.md for action semantics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Snip {
    pub id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub categories: Vec<String>,
    pub action: SnipAction,
    pub group_id: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SnipAction {
    Skip,
    Silence,
    FreezeFrame,
    /// Audio-replace: copy audio from a region adjacent to the snip and
    /// crossfade it over the snip. Length auto-calculated from snip length.
    ///
    /// - `from_before` true → source range is just before the snip start.
    ///   false → source range is just after the snip end.
    /// - `offset_ms` shifts the source range away from the snip in the
    ///   chosen direction. For from_before this should be ≤ 0 (slides earlier),
    ///   for from_after ≥ 0 (slides later). Frontend clamps so the source
    ///   range can never overlap the snip itself.
    /// - `crossfade_ms` is the fade in/out duration at the snip's edges.
    ///   Default 1500 ms.
    ///
    /// NOTE: as of v0.1 the runtime degrades audio-replace to Skip because
    /// proper audio overlay needs ffmpeg/lavfi-complex work. These settings
    /// ARE persisted in .free files so they're ready when overlay lands.
    AudioReplace {
        from_before: bool,
        #[serde(default)]
        offset_ms: i32,
        #[serde(default = "default_crossfade_ms")]
        crossfade_ms: u32,
    },
    /// Beep: mute original audio for the snip window and overlay a subtle
    /// sine tone (think "radio broadcast bleep"). Video keeps playing
    /// normally. The runtime enforces a 3-second cap on Beep snips — the
    /// frontend warns the user when designating a longer snip as Beep and
    /// shortens it from the END (start stays put).
    ///
    /// Defaults: 1000 Hz, -22 dB (subtle, not jarring). Adjustable per snip.
    Beep {
        #[serde(default = "default_beep_freq_hz")]
        freq_hz: u32,
        #[serde(default = "default_beep_level_db")]
        level_db: i32,
    },
}

fn default_crossfade_ms() -> u32 {
    1500
}
fn default_beep_freq_hz() -> u32 {
    1000
}
fn default_beep_level_db() -> i32 {
    -22
}

/// Hard cap on Beep snip duration. Enforced by the frontend's action picker
/// (which offers to shorten longer snips) and by the apply engine as a
/// safety net.
pub const MAX_BEEP_DURATION_MS: u64 = 3000;

// ────────────────────────────────────────────────────────────────────────
// Validation limits — enforced at load-time in `validate()`. These exist
// so a maliciously-crafted `.free` (or just one written by a buggy tool)
// can't OOM us, run pathological filter expressions, or smuggle URL/HTML
// payloads through the UI. None of these are arbitrary — they're each
// generous enough that legitimate profiles never hit them.
// ────────────────────────────────────────────────────────────────────────

pub const MAX_FREE_FILE_BYTES: u64 = 10 * 1024 * 1024; // 10 MB
pub const MAX_SNIPS_PER_PROFILE: usize = 10_000;
pub const MAX_MARKERS_PER_PROFILE: usize = 10_000;
pub const MAX_GROUPS_PER_PROFILE: usize = 1_000;
pub const MAX_PROFILE_NAME_LEN: usize = 500;
pub const MAX_PROFILE_NOTES_LEN: usize = 50_000;
pub const MAX_SNIP_NOTE_LEN: usize = 50_000;
pub const MAX_CATEGORY_LEN: usize = 200;
pub const MAX_CATEGORIES_PER_SNIP: usize = 64;
pub const MAX_URL_LEN: usize = 2_000;
pub const MAX_GROUP_NAME_LEN: usize = 200;
pub const MAX_MARKER_NAME_LEN: usize = 200;
pub const MAX_FILENAME_LEN: usize = 1_000;
pub const MAX_AUTHORSHIP_EVENTS: usize = 1_000;
pub const MAX_AUTHOR_HANDLE_LEN: usize = 64;
pub const MAX_MAPS_SUMMARY_LEN: usize = 200;
pub const MAX_MOVIE_PLOT_LEN: usize = 5_000;
pub const MAX_PERSON_NAME_LEN: usize = 200;
pub const MAX_STARS_PER_MOVIE: usize = 10;
pub const MAX_IMDB_ID_LEN: usize = 32;

/// Audio-replace value ranges. Crossfade is bounded so it can't span
/// minutes; offset is bounded to ±5 minutes so the source range stays
/// in a sensible neighborhood of the snip.
pub const MAX_AUDIO_REPLACE_CROSSFADE_MS: u32 = 30_000;
pub const MIN_AUDIO_REPLACE_OFFSET_MS: i32 = -300_000;
pub const MAX_AUDIO_REPLACE_OFFSET_MS: i32 = 300_000;

/// Beep value ranges. Frequency caps stay inside human-audible bounds;
/// level cap prevents accidental ear-blasting from a hostile profile.
pub const MIN_BEEP_FREQ_HZ: u32 = 20;
pub const MAX_BEEP_FREQ_HZ: u32 = 20_000;
pub const MIN_BEEP_LEVEL_DB: i32 = -60;
pub const MAX_BEEP_LEVEL_DB: i32 = 0;

/// Errors produced when a deserialized `FreeFile` fails post-parse
/// validation. The variant carries enough context to surface a useful
/// error to the user in the UI.
#[derive(Debug, thiserror::Error)]
pub enum ValidationError {
    #[error("file too large: {actual} bytes (max {max})")]
    FileTooLarge { actual: u64, max: u64 },
    #[error("too many snips: {actual} (max {max})")]
    TooManySnips { actual: usize, max: usize },
    #[error("too many markers: {actual} (max {max})")]
    TooManyMarkers { actual: usize, max: usize },
    #[error("too many groups: {actual} (max {max})")]
    TooManyGroups { actual: usize, max: usize },
    #[error("field \"{field}\" too long: {actual} chars (max {max})")]
    FieldTooLong { field: String, actual: usize, max: usize },
    #[error("snip {snip_id}: invalid time range (start={start_ms}, end={end_ms})")]
    InvalidSnipRange { snip_id: String, start_ms: u64, end_ms: u64 },
    #[error("snip {snip_id}: too many categories ({actual}, max {max})")]
    TooManyCategories { snip_id: String, actual: usize, max: usize },
    #[error("snip {snip_id}: audio-replace value out of range ({reason})")]
    AudioReplaceOutOfRange { snip_id: String, reason: String },
    #[error("snip {snip_id}: beep value out of range ({reason})")]
    BeepOutOfRange { snip_id: String, reason: String },
    #[error("imdb_url must start with https:// and reference imdb.com (got {url:?})")]
    BadImdbUrl { url: String },
}

impl FreeFile {
    /// Post-parse validation. Call after `serde_json::from_str` on any
    /// profile that came from outside this process — file load, IPC,
    /// downloaded payload, etc. Returns `Ok(())` if the profile is safe
    /// to operate on, or a `ValidationError` describing the first
    /// problem found.
    pub fn validate(&self) -> Result<(), ValidationError> {
        let p = &self.payload;

        // Top-level collection caps.
        if p.snips.len() > MAX_SNIPS_PER_PROFILE {
            return Err(ValidationError::TooManySnips {
                actual: p.snips.len(),
                max: MAX_SNIPS_PER_PROFILE,
            });
        }
        if p.markers.len() > MAX_MARKERS_PER_PROFILE {
            return Err(ValidationError::TooManyMarkers {
                actual: p.markers.len(),
                max: MAX_MARKERS_PER_PROFILE,
            });
        }
        if p.groups.len() > MAX_GROUPS_PER_PROFILE {
            return Err(ValidationError::TooManyGroups {
                actual: p.groups.len(),
                max: MAX_GROUPS_PER_PROFILE,
            });
        }

        // Metadata field lengths.
        check_field_len("metadata.name", &p.metadata.name, MAX_PROFILE_NAME_LEN)?;
        if let Some(s) = &p.metadata.notes {
            check_field_len("metadata.notes", s, MAX_PROFILE_NOTES_LEN)?;
        }
        if let Some(s) = &p.metadata.movie_title {
            check_field_len("metadata.movie_title", s, MAX_PROFILE_NAME_LEN)?;
        }
        if let Some(s) = &p.metadata.imdb_url {
            check_field_len("metadata.imdb_url", s, MAX_URL_LEN)?;
            validate_imdb_url(s)?;
        }
        if let Some(s) = &p.metadata.aspect_ratio {
            // Aspect ratio strings are tiny ("21:9", "2.35:1"). Cap at 32
            // chars as a sanity check; the libmpv property would reject
            // garbage anyway, but we don't want to forward megabytes.
            check_field_len("metadata.aspect_ratio", s, 32)?;
        }
        // MAPS ratings — summary length, sane IMDb rating range.
        if let Some(r) = &p.metadata.maps_filtered {
            check_field_len("metadata.maps_filtered.summary", &r.summary, MAX_MAPS_SUMMARY_LEN)?;
        }
        if let Some(r) = &p.metadata.maps_unfiltered {
            check_field_len("metadata.maps_unfiltered.summary", &r.summary, MAX_MAPS_SUMMARY_LEN)?;
        }
        if let Some(s) = &p.metadata.movie_director {
            check_field_len("metadata.movie_director", s, MAX_PERSON_NAME_LEN)?;
        }
        if p.metadata.movie_stars.len() > MAX_STARS_PER_MOVIE {
            return Err(ValidationError::FieldTooLong {
                field: "metadata.movie_stars".to_string(),
                actual: p.metadata.movie_stars.len(),
                max: MAX_STARS_PER_MOVIE,
            });
        }
        for s in &p.metadata.movie_stars {
            check_field_len("metadata.movie_stars[]", s, MAX_PERSON_NAME_LEN)?;
        }
        if let Some(s) = &p.metadata.movie_plot {
            check_field_len("metadata.movie_plot", s, MAX_MOVIE_PLOT_LEN)?;
        }
        if let Some(r) = p.metadata.imdb_rating {
            if !(0.0..=10.0).contains(&r) || r.is_nan() {
                return Err(ValidationError::FieldTooLong {
                    field: "metadata.imdb_rating".to_string(),
                    actual: r as usize,
                    max: 10,
                });
            }
        }
        if let Some(s) = &p.metadata.imdb_id {
            check_field_len("metadata.imdb_id", s, MAX_IMDB_ID_LEN)?;
        }

        // Fingerprint sanity.
        check_field_len(
            "fingerprint.filename",
            &p.fingerprint.filename,
            MAX_FILENAME_LEN,
        )?;
        check_field_len(
            "fingerprint.container",
            &p.fingerprint.container,
            MAX_FILENAME_LEN,
        )?;
        check_field_len(
            "fingerprint.codec",
            &p.fingerprint.codec,
            MAX_FILENAME_LEN,
        )?;

        // Snip validation.
        for snip in &p.snips {
            if snip.end_ms <= snip.start_ms {
                return Err(ValidationError::InvalidSnipRange {
                    snip_id: snip.id.clone(),
                    start_ms: snip.start_ms,
                    end_ms: snip.end_ms,
                });
            }
            if snip.categories.len() > MAX_CATEGORIES_PER_SNIP {
                return Err(ValidationError::TooManyCategories {
                    snip_id: snip.id.clone(),
                    actual: snip.categories.len(),
                    max: MAX_CATEGORIES_PER_SNIP,
                });
            }
            for cat in &snip.categories {
                check_field_len("snip.category", cat, MAX_CATEGORY_LEN)?;
            }
            if let Some(note) = &snip.note {
                check_field_len("snip.note", note, MAX_SNIP_NOTE_LEN)?;
            }
            validate_action(&snip.id, &snip.action)?;
        }

        // Groups + markers.
        for g in &p.groups {
            check_field_len("group.name", &g.name, MAX_GROUP_NAME_LEN)?;
        }
        for m in &p.markers {
            check_field_len("marker.name", &m.name, MAX_MARKER_NAME_LEN)?;
        }

        // Authorship history.
        if p.authorship_history.len() > MAX_AUTHORSHIP_EVENTS {
            return Err(ValidationError::FieldTooLong {
                field: "authorship_history".to_string(),
                actual: p.authorship_history.len(),
                max: MAX_AUTHORSHIP_EVENTS,
            });
        }
        for ev in &p.authorship_history {
            if let Some(h) = &ev.handle {
                check_field_len("authorship_event.handle", h, MAX_AUTHOR_HANDLE_LEN)?;
            }
        }

        Ok(())
    }
}

fn check_field_len(field: &str, s: &str, max: usize) -> Result<(), ValidationError> {
    if s.chars().count() > max {
        return Err(ValidationError::FieldTooLong {
            field: field.to_string(),
            actual: s.chars().count(),
            max,
        });
    }
    Ok(())
}

fn validate_action(snip_id: &str, action: &SnipAction) -> Result<(), ValidationError> {
    match action {
        SnipAction::Skip | SnipAction::Silence | SnipAction::FreezeFrame => Ok(()),
        SnipAction::AudioReplace {
            offset_ms,
            crossfade_ms,
            ..
        } => {
            if *crossfade_ms > MAX_AUDIO_REPLACE_CROSSFADE_MS {
                return Err(ValidationError::AudioReplaceOutOfRange {
                    snip_id: snip_id.to_string(),
                    reason: format!(
                        "crossfade_ms={crossfade_ms} > max {MAX_AUDIO_REPLACE_CROSSFADE_MS}"
                    ),
                });
            }
            if *offset_ms < MIN_AUDIO_REPLACE_OFFSET_MS
                || *offset_ms > MAX_AUDIO_REPLACE_OFFSET_MS
            {
                return Err(ValidationError::AudioReplaceOutOfRange {
                    snip_id: snip_id.to_string(),
                    reason: format!(
                        "offset_ms={offset_ms} outside [{MIN_AUDIO_REPLACE_OFFSET_MS}, {MAX_AUDIO_REPLACE_OFFSET_MS}]"
                    ),
                });
            }
            Ok(())
        }
        SnipAction::Beep {
            freq_hz,
            level_db,
        } => {
            if *freq_hz < MIN_BEEP_FREQ_HZ || *freq_hz > MAX_BEEP_FREQ_HZ {
                return Err(ValidationError::BeepOutOfRange {
                    snip_id: snip_id.to_string(),
                    reason: format!(
                        "freq_hz={freq_hz} outside [{MIN_BEEP_FREQ_HZ}, {MAX_BEEP_FREQ_HZ}]"
                    ),
                });
            }
            if *level_db < MIN_BEEP_LEVEL_DB || *level_db > MAX_BEEP_LEVEL_DB {
                return Err(ValidationError::BeepOutOfRange {
                    snip_id: snip_id.to_string(),
                    reason: format!(
                        "level_db={level_db} outside [{MIN_BEEP_LEVEL_DB}, {MAX_BEEP_LEVEL_DB}]"
                    ),
                });
            }
            Ok(())
        }
    }
}

fn validate_imdb_url(url: &str) -> Result<(), ValidationError> {
    // The real security concern is non-http schemes (javascript:, data:,
    // file:) being smuggled in. http:// vs https:// is just a transport
    // issue; we accept both so existing profiles with http URLs round-trip.
    // We also require the host to be *.imdb.com or imdb.com so a hostile
    // profile can't redirect the user to attacker.example through what
    // claims to be "the IMDb parental guide for this movie."
    let after_scheme = if let Some(rest) = url.strip_prefix("https://") {
        rest
    } else if let Some(rest) = url.strip_prefix("http://") {
        rest
    } else {
        return Err(ValidationError::BadImdbUrl {
            url: url.to_string(),
        });
    };
    let host_end = after_scheme.find('/').unwrap_or(after_scheme.len());
    let host = &after_scheme[..host_end];
    let host_lower = host.to_ascii_lowercase();
    let is_imdb = host_lower == "imdb.com" || host_lower.ends_with(".imdb.com");
    if !is_imdb {
        return Err(ValidationError::BadImdbUrl {
            url: url.to_string(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SnipGroup {
    pub id: String,
    pub name: String,
}

impl FreeFile {
    /// Build a new unsigned `.free` for the given file fingerprint and metadata.
    pub fn new(fingerprint: Fingerprint, name: impl Into<String>) -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        Self {
            schema: SCHEMA_VERSION,
            signature: None,
            pubkey: None,
            uploader: None,
            payload: Payload {
                fingerprint,
                metadata: ProfileMetadata {
                    name: name.into(),
                    movie_title: None,
                    movie_year: None,
                    version: 1,
                    notes: None,
                    created: now,
                    modified: now,
                    imdb_url: None,
                    aspect_ratio: None,
                    maps_filtered: None,
                    maps_unfiltered: None,
                    movie_director: None,
                    movie_stars: Vec::new(),
                    movie_plot: None,
                    imdb_rating: None,
                    imdb_id: None,
                },
                snips: Vec::new(),
                groups: Vec::new(),
                markers: Vec::new(),
                authorship_history: Vec::new(),
            },
        }
    }

    pub fn add_snip(&mut self, snip: Snip) {
        self.payload.snips.push(snip);
        self.touch_modified();
    }

    fn touch_modified(&mut self) {
        self.payload.metadata.modified = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(self.payload.metadata.modified);
    }
}

impl Snip {
    /// Build a snip with a fresh UUID v4 ID.
    pub fn new(
        start_ms: u64,
        end_ms: u64,
        categories: Vec<String>,
        action: SnipAction,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            start_ms,
            end_ms,
            categories,
            action,
            group_id: None,
            note: None,
        }
    }
}

impl SnipGroup {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_fingerprint() -> Fingerprint {
        Fingerprint {
            filename: "movie.mkv".into(),
            size_bytes: 42_000_000,
            container: "matroska".into(),
            codec: "hevc".into(),
            duration_ms: 7_320_000,
            phash_samples: vec![],
        }
    }

    #[test]
    fn roundtrips_through_json() {
        let mut file = FreeFile::new(sample_fingerprint(), "Family Friendly");
        file.add_snip(Snip::new(
            60_000,
            68_000,
            vec!["language".into()],
            SnipAction::Skip,
        ));
        file.add_snip(Snip::new(
            300_000,
            330_000,
            vec!["agenda:atheism".into()],
            SnipAction::Silence,
        ));
        file.add_snip(Snip::new(
            900_000,
            905_000,
            vec!["sex".into()],
            SnipAction::AudioReplace {
                from_before: true,
                offset_ms: 0,
                crossfade_ms: 1500,
            },
        ));

        let json = serde_json::to_string_pretty(&file).expect("serialize");
        let parsed: FreeFile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(file, parsed);
    }

    #[test]
    fn new_snip_has_fresh_id() {
        let a = Snip::new(0, 100, vec![], SnipAction::Skip);
        let b = Snip::new(0, 100, vec![], SnipAction::Skip);
        assert_ne!(a.id, b.id);
        assert_eq!(a.id.len(), 36); // UUID v4
    }

    #[test]
    fn action_serializes_with_type_tag() {
        let json = serde_json::to_string(&SnipAction::Skip).unwrap();
        assert_eq!(json, r#"{"type":"skip"}"#);

        let json = serde_json::to_string(&SnipAction::AudioReplace {
            from_before: false,
            offset_ms: 0,
            crossfade_ms: 1500,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"audio_replace","from_before":false,"offset_ms":0,"crossfade_ms":1500}"#
        );
    }

    #[test]
    fn beep_serializes_with_type_tag_and_fields() {
        let json = serde_json::to_string(&SnipAction::Beep {
            freq_hz: 1000,
            level_db: -22,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"beep","freq_hz":1000,"level_db":-22}"#
        );
    }

    #[test]
    fn validate_rejects_inverted_snip_range() {
        let mut file = FreeFile::new(sample_fingerprint(), "Test");
        file.add_snip(Snip::new(1000, 500, vec![], SnipAction::Skip));
        let err = file.validate().unwrap_err();
        assert!(matches!(err, ValidationError::InvalidSnipRange { .. }));
    }

    #[test]
    fn validate_rejects_oversized_note() {
        let mut file = FreeFile::new(sample_fingerprint(), "Test");
        let big = "x".repeat(MAX_SNIP_NOTE_LEN + 1);
        let mut snip = Snip::new(100, 200, vec![], SnipAction::Skip);
        snip.note = Some(big);
        file.add_snip(snip);
        let err = file.validate().unwrap_err();
        assert!(matches!(err, ValidationError::FieldTooLong { .. }));
    }

    #[test]
    fn validate_rejects_beep_out_of_range() {
        let mut file = FreeFile::new(sample_fingerprint(), "Test");
        file.add_snip(Snip::new(
            100,
            200,
            vec![],
            SnipAction::Beep { freq_hz: 99_999, level_db: 0 },
        ));
        let err = file.validate().unwrap_err();
        assert!(matches!(err, ValidationError::BeepOutOfRange { .. }));
    }

    #[test]
    fn validate_rejects_javascript_imdb_url() {
        let mut file = FreeFile::new(sample_fingerprint(), "Test");
        file.payload.metadata.imdb_url =
            Some("javascript:alert('pwn')//imdb.com".to_string());
        let err = file.validate().unwrap_err();
        assert!(matches!(err, ValidationError::BadImdbUrl { .. }));
    }

    #[test]
    fn validate_rejects_off_domain_url() {
        let mut file = FreeFile::new(sample_fingerprint(), "Test");
        file.payload.metadata.imdb_url =
            Some("https://attacker.example/imdb.com/fake".to_string());
        let err = file.validate().unwrap_err();
        assert!(matches!(err, ValidationError::BadImdbUrl { .. }));
    }

    #[test]
    fn validate_accepts_http_and_https_imdb_subdomains() {
        let mut file = FreeFile::new(sample_fingerprint(), "Test");
        for url in [
            "https://www.imdb.com/title/tt0117500/parentalguide/",
            "http://imdb.com/title/x",
            "https://m.imdb.com/title/x",
            "https://pro.imdb.com/title/x",
        ] {
            file.payload.metadata.imdb_url = Some(url.to_string());
            assert!(file.validate().is_ok(), "should accept {url}");
        }
    }

    #[test]
    fn validate_rejects_too_many_snips() {
        let mut file = FreeFile::new(sample_fingerprint(), "Test");
        for i in 0..MAX_SNIPS_PER_PROFILE + 1 {
            file.payload.snips.push(Snip::new(
                i as u64 * 10,
                i as u64 * 10 + 5,
                vec![],
                SnipAction::Skip,
            ));
        }
        let err = file.validate().unwrap_err();
        assert!(matches!(err, ValidationError::TooManySnips { .. }));
    }

    #[test]
    fn validate_accepts_well_formed_profile() {
        let mut file = FreeFile::new(sample_fingerprint(), "Family Friendly");
        file.add_snip(Snip::new(
            10_000,
            12_000,
            vec!["language".into()],
            SnipAction::Skip,
        ));
        file.add_snip(Snip::new(
            30_000,
            32_000,
            vec!["sex".into()],
            SnipAction::Beep { freq_hz: 1000, level_db: -22 },
        ));
        file.payload.metadata.imdb_url =
            Some("https://www.imdb.com/title/tt0117500/parentalguide/".to_string());
        assert!(file.validate().is_ok());
    }

    #[test]
    fn beep_deserializes_with_defaults_when_fields_missing() {
        // A `.free` file written by a future / lossy producer that only
        // emits the type tag should still load with sensible defaults.
        let json = r#"{"type":"beep"}"#;
        let action: SnipAction = serde_json::from_str(json).unwrap();
        match action {
            SnipAction::Beep { freq_hz, level_db } => {
                assert_eq!(freq_hz, 1000);
                assert_eq!(level_db, -22);
            }
            _ => panic!("expected Beep"),
        }
    }

    #[test]
    fn audio_replace_deserializes_old_files_without_new_fields() {
        // Profiles saved before offset_ms / crossfade_ms existed must still
        // load — serde(default) supplies sensible defaults.
        let json = r#"{"type":"audio_replace","from_before":true}"#;
        let action: SnipAction = serde_json::from_str(json).unwrap();
        match action {
            SnipAction::AudioReplace { from_before, offset_ms, crossfade_ms } => {
                assert_eq!(from_before, true);
                assert_eq!(offset_ms, 0);
                assert_eq!(crossfade_ms, 1500);
            }
            _ => panic!("expected AudioReplace"),
        }
    }
}
