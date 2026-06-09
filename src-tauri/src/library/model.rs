//! Library Rust types — mirrored to TypeScript via Tauri command serialization.
//!
//! Each struct here corresponds to a row (or query projection) in the
//! library SQLite store. Field naming uses snake_case to match the SQL
//! columns; serde will emit the same in JSON for the frontend, which
//! follows the same snake_case convention seen elsewhere in this codebase
//! (see ProfileMetadata).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchedFolder {
    pub id: i64,
    pub path: String,
    pub recursive: bool,
    pub added_at: i64,
    /// When true, the orchestrator scans this folder during app
    /// startup. Defaults to false — slow shares would block boot.
    pub scan_on_startup: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryIdentity {
    pub id: i64,
    pub cheap_fingerprint: String,
    pub strong_fingerprint: Option<String>,
    pub duration_ms: i64,
    pub tmdb_id: Option<i64>,
    pub movie_title: Option<String>,
    pub movie_year: Option<i64>,
    pub movie_director: Option<String>,
    pub movie_plot: Option<String>,
    pub movie_stars: Vec<String>,
    pub genres: Vec<String>,
    pub mpaa_rating: Option<String>,
    pub imdb_id: Option<String>,
    pub imdb_rating: Option<f64>,
    pub poster_url: Option<String>,
    pub poster_local_path: Option<String>,
    pub custom_thumbnail_path: Option<String>,
    pub notes: Option<String>,
    pub family_rating: Option<i64>,
    pub non_family_friendly: bool,
    pub priority_for_profile: bool,
    pub no_profile_necessary: bool,
    pub is_3d: bool,
    pub is_extended: bool,
    pub manual_title: bool,
    pub manual_year: bool,
    pub manual_thumbnail: bool,
    pub manual_director: bool,
    pub manual_plot: bool,
    pub first_seen_at: i64,
    pub last_updated_at: i64,
    /// MAPS (Media Audience Prudence Standard) ratings cached from the
    /// associated .free profile metadata. _filtered_ = the post-filter
    /// rating (only meaningful when a .free exists for this title);
    /// _unfiltered_ = the raw movie rating. tier values match the enum
    /// in `profile::format::MapsTier`. None when no .free or no MAPS
    /// data was recorded.
    pub maps_filtered_tier: Option<String>,
    pub maps_filtered_summary: Option<String>,
    pub maps_unfiltered_tier: Option<String>,
    pub maps_unfiltered_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryFile {
    pub id: i64,
    pub path: String,
    pub watched_folder_id: i64,
    pub identity_id: i64,
    pub size_bytes: i64,
    pub modified_unix: i64,
    pub resolution: Option<String>,
    pub codec: Option<String>,
    pub is_missing: bool,
    pub watch_progress_ms: i64,
    pub last_watched_at: Option<i64>,
    pub watched: bool,
    pub added_at: i64,
    pub drift_warning: bool,
    /// Cached "is there a .free profile next to this video on disk?"
    /// Maintained by the indexer (refresh_free_siblings) so list_items
    /// doesn't have to walk the parent directory per row. `None` =
    /// never computed (legacy row); treat as Missing until refreshed.
    pub has_free_sibling: Option<bool>,
    /// Cached "is there subtitle data for this file?" — either a sibling
    /// .srt or an embedded subtitle track in the container. Maintained
    /// during the indexer's refresh pass.
    pub has_subtitle: Option<bool>,
}

/// The shape the frontend Library list works with — joins file + identity
/// into a single row. One per file (true duplicates show as multiple
/// rows pointing to the same identity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LibraryRow {
    pub file: LibraryFile,
    pub identity: LibraryIdentity,
    pub tags: Vec<String>,
    /// Profile presence is computed at query time from the file's folder
    /// (it depends on the `.free` files sitting beside the video, not on
    /// anything stored in the library DB). Tri-state: HasProfile,
    /// NoProfileNecessary, Missing.
    pub profile_status: ProfileStatus,
    pub collections: Vec<CollectionMembership>,
    pub series: Option<SeriesMembership>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileStatus {
    /// At least one `.free` file is present next to the video.
    HasProfile,
    /// User explicitly marked "no profile necessary" (clean movie).
    NoProfileNecessary,
    /// No `.free` and not explicitly marked.
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionMembership {
    pub collection_id: i64,
    pub collection_name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SeriesMembership {
    pub series_id: i64,
    pub series_name: String,
    pub has_seasons: bool,
    pub season: Option<i64>,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Collection {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub item_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Series {
    pub id: i64,
    pub name: String,
    pub has_seasons: bool,
    pub created_at: i64,
    pub item_count: i64,
    pub watched_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchLogEntry {
    pub id: i64,
    pub file_id: i64,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub end_progress_ms: Option<i64>,
}
