//! TMDb (The Movie Database) v3 client for the Movie Info auto-fill flow.
//!
//! Single read access token is embedded in the binary. TMDb allows this
//! for read-only desktop apps. All requests are blocking (`ureq`) and
//! wrapped in `spawn_blocking` at the Tauri-command layer so the UI
//! thread never stalls.
//!
//! Two operations:
//!   - `search` — query string → top-N candidate matches for the picker
//!   - `details` — TMDb id → full movie record (cast, crew, plot, etc.)

use serde::{Deserialize, Serialize};

// Read access token is held in a gitignored sidecar file
// (`src-tauri/.tmdb_token`) so it's embedded in the binary at build
// time without ever appearing in the public source tree. Callers use
// `.trim()` to strip any trailing newline the file may carry.
const TMDB_READ_TOKEN_RAW: &str = include_str!("../../.tmdb_token");
fn tmdb_token() -> &'static str {
    TMDB_READ_TOKEN_RAW.trim()
}
const BASE_URL: &str = "https://api.themoviedb.org/3";
/// TMDb image base. Posters returned as relative paths (e.g.
/// `/abc.jpg`); concatenate with this + a size segment (`w92`, `w185`,
/// `w342`, `w500`, `original`) to get a working URL.
const IMG_BASE: &str = "https://image.tmdb.org/t/p";
const SEARCH_LIMIT: usize = 5;

#[derive(Debug, Serialize, Clone)]
pub struct TmdbSearchResult {
    pub tmdb_id: u32,
    pub title: String,
    pub original_title: String,
    pub release_year: Option<u32>,
    /// First sentence-ish of the plot, for the picker preview.
    pub overview: String,
    /// Full URL to a small poster (w185), or None if no poster available.
    pub poster_url: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TmdbMovieDetails {
    pub tmdb_id: u32,
    pub imdb_id: Option<String>,
    pub title: String,
    pub release_year: Option<u32>,
    pub runtime_minutes: Option<u32>,
    /// TMDb's own 0-10 vote average. Close to IMDb's but not identical.
    pub vote_average: Option<f64>,
    pub director: Option<String>,
    /// Top 5 cast members in billing order.
    pub top_cast: Vec<String>,
    /// Full plot text from TMDb.
    pub overview: String,
    /// Full URL to a medium poster (w342), or None.
    pub poster_url: Option<String>,
}

// ────────────────────────────────────────────────────────────────────
// Raw TMDb response types — internal, mapped to the public shapes above.
// ────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct RawSearchResponse {
    results: Vec<RawSearchHit>,
}

#[derive(Debug, Deserialize)]
struct RawSearchHit {
    id: u32,
    title: String,
    #[serde(default)]
    original_title: String,
    #[serde(default)]
    release_date: String,
    #[serde(default)]
    overview: String,
    poster_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawMovieDetails {
    id: u32,
    imdb_id: Option<String>,
    title: String,
    #[serde(default)]
    release_date: String,
    runtime: Option<u32>,
    vote_average: Option<f64>,
    overview: String,
    poster_path: Option<String>,
    credits: Option<RawCredits>,
}

#[derive(Debug, Deserialize)]
struct RawCredits {
    cast: Vec<RawCastMember>,
    crew: Vec<RawCrewMember>,
}

#[derive(Debug, Deserialize)]
struct RawCastMember {
    name: String,
    #[serde(default)]
    order: u32,
}

#[derive(Debug, Deserialize)]
struct RawCrewMember {
    name: String,
    job: String,
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

pub fn search(query: &str) -> Result<Vec<TmdbSearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let tok = tmdb_token();
    let url = format!("{BASE_URL}/search/movie");
    let raw: RawSearchResponse = ureq::get(&url)
        .set("Authorization", &format!("Bearer {tok}"))
        .set("Accept", "application/json")
        .query("query", q)
        .query("include_adult", "false")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("TMDb search request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("TMDb search response wasn't JSON: {e}"))?;

    let mapped: Vec<TmdbSearchResult> = raw
        .results
        .into_iter()
        .take(SEARCH_LIMIT)
        .map(|h| TmdbSearchResult {
            tmdb_id: h.id,
            title: h.title,
            original_title: h.original_title,
            release_year: extract_year(&h.release_date),
            overview: h.overview,
            poster_url: h.poster_path.as_deref().map(|p| poster_url(p, "w185")),
        })
        .collect();
    Ok(mapped)
}

pub fn details(tmdb_id: u32) -> Result<TmdbMovieDetails, String> {
    let tok = tmdb_token();
    let url = format!("{BASE_URL}/movie/{tmdb_id}");
    let raw: RawMovieDetails = ureq::get(&url)
        .set("Authorization", &format!("Bearer {tok}"))
        .set("Accept", "application/json")
        .query("append_to_response", "credits")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("TMDb details request failed: {e}"))?
        .into_json()
        .map_err(|e| format!("TMDb details response wasn't JSON: {e}"))?;

    let director = raw.credits.as_ref().and_then(|c| {
        c.crew
            .iter()
            .find(|m| m.job.eq_ignore_ascii_case("Director"))
            .map(|m| m.name.clone())
    });
    let top_cast = raw
        .credits
        .as_ref()
        .map(|c| {
            let mut cast: Vec<&RawCastMember> = c.cast.iter().collect();
            cast.sort_by_key(|m| m.order);
            cast.into_iter().take(5).map(|m| m.name.clone()).collect()
        })
        .unwrap_or_default();

    Ok(TmdbMovieDetails {
        tmdb_id: raw.id,
        imdb_id: raw.imdb_id,
        title: raw.title,
        release_year: extract_year(&raw.release_date),
        runtime_minutes: raw.runtime,
        vote_average: raw.vote_average,
        director,
        top_cast,
        overview: raw.overview,
        poster_url: raw.poster_path.as_deref().map(|p| poster_url(p, "w342")),
    })
}

fn extract_year(release_date: &str) -> Option<u32> {
    // TMDb dates: "1996-06-07" — first 4 chars are the year.
    if release_date.len() < 4 {
        return None;
    }
    release_date[..4].parse().ok()
}

fn poster_url(path: &str, size: &str) -> String {
    format!("{IMG_BASE}/{size}{path}")
}
