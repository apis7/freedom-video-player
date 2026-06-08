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
use std::io::Read;

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
    /// Genre names ("Drama", "Comedy", ...). May be empty if TMDb has none.
    pub genres: Vec<String>,
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
    #[serde(default)]
    genres: Vec<RawGenre>,
}

#[derive(Debug, Deserialize)]
struct RawGenre {
    name: String,
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
    search_with_year(query, None)
}

/// Search with an optional `year` filter. When passed, TMDb restricts
/// results to films released that year (much more precise than tacking
/// the year onto the query string, which TMDb tends to ignore or
/// mis-rank). Used by the library enrichment worker to disambiguate
/// common titles ("Frozen" 2013 vs other "Frozen" movies).
pub fn search_with_year(
    query: &str,
    year: Option<u32>,
) -> Result<Vec<TmdbSearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let tok = tmdb_token();
    let url = format!("{BASE_URL}/search/movie");
    let mut req = ureq::get(&url)
        .set("Authorization", &format!("Bearer {tok}"))
        .set("Accept", "application/json")
        .query("query", q)
        .query("include_adult", "false")
        .timeout(std::time::Duration::from_secs(10));
    if let Some(y) = year {
        // Both year and primary_release_year limit by year; primary_*
        // requires it to be the FIRST release. We use the looser `year`
        // so re-releases / festival cuts still match.
        req = req.query("year", &y.to_string());
    }
    let raw: RawSearchResponse = req
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

    let genres = raw.genres.into_iter().map(|g| g.name).collect();
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
        genres,
    })
}

/// Fetch the raw bytes for a TMDb image URL. Tiny wrapper so the poster
/// cache doesn't duplicate the request boilerplate. Times out at 15s
/// (posters can be a few hundred KB on slow connections).
pub fn fetch_image(url: &str) -> Result<Vec<u8>, String> {
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("TMDb image request failed: {e}"))?;
    let mut buf = Vec::new();
    resp.into_reader()
        .read_to_end(&mut buf)
        .map_err(|e| format!("TMDb image read failed: {e}"))?;
    Ok(buf)
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

// ────────────────────────────────────────────────────────────────────
// TV series API — search + per-season episodes. Used by the
// "Auto-name episodes from TMDb" flow in Auto-detect seasons.
// ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TmdbTvSearchResult {
    pub tmdb_tv_id: u32,
    pub name: String,
    pub original_name: String,
    pub first_air_year: Option<u32>,
    pub overview: String,
    pub poster_url: Option<String>,
    pub number_of_seasons: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TmdbTvSeasonEpisode {
    pub season_number: u32,
    pub episode_number: u32,
    pub name: String,
    pub overview: String,
    pub air_date: Option<String>,
}

#[derive(Deserialize)]
struct RawTvSearchResponse {
    results: Vec<RawTvSearchHit>,
}
#[derive(Deserialize)]
struct RawTvSearchHit {
    id: u32,
    name: String,
    #[serde(default)]
    original_name: String,
    #[serde(default)]
    first_air_date: String,
    #[serde(default)]
    overview: String,
    poster_path: Option<String>,
}

#[derive(Deserialize)]
struct RawTvDetails {
    number_of_seasons: Option<u32>,
}

#[derive(Deserialize)]
struct RawTvSeason {
    episodes: Vec<RawTvSeasonEpisode>,
}
#[derive(Deserialize)]
struct RawTvSeasonEpisode {
    #[serde(default)]
    season_number: u32,
    #[serde(default)]
    episode_number: u32,
    #[serde(default)]
    name: String,
    #[serde(default)]
    overview: String,
    #[serde(default)]
    air_date: Option<String>,
}

pub fn search_tv(query: &str) -> Result<Vec<TmdbTvSearchResult>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let tok = tmdb_token();
    let url = format!("{BASE_URL}/search/tv");
    let raw: RawTvSearchResponse = ureq::get(&url)
        .set("Authorization", &format!("Bearer {tok}"))
        .set("Accept", "application/json")
        .query("query", q)
        .query("include_adult", "false")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("TMDb TV search failed: {e}"))?
        .into_json()
        .map_err(|e| format!("TMDb TV search not JSON: {e}"))?;
    let mut mapped: Vec<TmdbTvSearchResult> = raw
        .results
        .into_iter()
        .take(SEARCH_LIMIT)
        .map(|h| TmdbTvSearchResult {
            tmdb_tv_id: h.id,
            name: h.name,
            original_name: h.original_name,
            first_air_year: extract_year(&h.first_air_date),
            overview: h.overview,
            poster_url: h.poster_path.as_deref().map(|p| poster_url(p, "w185")),
            number_of_seasons: None,
        })
        .collect();
    // Look up details for each candidate to populate number_of_seasons.
    // We only do this for the first 5 results to keep latency bounded.
    for hit in mapped.iter_mut().take(5) {
        if let Ok(d) = tv_details_lookup(hit.tmdb_tv_id) {
            hit.number_of_seasons = d.number_of_seasons;
        }
    }
    Ok(mapped)
}

fn tv_details_lookup(tmdb_tv_id: u32) -> Result<RawTvDetails, String> {
    let tok = tmdb_token();
    let url = format!("{BASE_URL}/tv/{tmdb_tv_id}");
    ureq::get(&url)
        .set("Authorization", &format!("Bearer {tok}"))
        .set("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("TMDb TV details: {e}"))?
        .into_json::<RawTvDetails>()
        .map_err(|e| format!("TMDb TV details not JSON: {e}"))
}

/// Fetch a single TV season's episode list. season=0 means "specials".
pub fn tv_season(
    tmdb_tv_id: u32,
    season_number: u32,
) -> Result<Vec<TmdbTvSeasonEpisode>, String> {
    let tok = tmdb_token();
    let url = format!("{BASE_URL}/tv/{tmdb_tv_id}/season/{season_number}");
    let raw: RawTvSeason = ureq::get(&url)
        .set("Authorization", &format!("Bearer {tok}"))
        .set("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("TMDb season fetch: {e}"))?
        .into_json()
        .map_err(|e| format!("TMDb season not JSON: {e}"))?;
    Ok(raw
        .episodes
        .into_iter()
        .map(|e| TmdbTvSeasonEpisode {
            season_number: e.season_number,
            episode_number: e.episode_number,
            name: e.name,
            overview: e.overview,
            air_date: e.air_date,
        })
        .collect())
}
