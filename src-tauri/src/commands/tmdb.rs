//! Tauri commands for TMDb metadata lookup.
//!
//! Sync `ureq` calls are dispatched on the Tokio blocking pool so the
//! UI thread keeps responding (~10s HTTP timeout). Errors come back as
//! human-readable strings the frontend can toast.

use crate::tmdb::{
    self, TmdbMovieDetails, TmdbSearchResult, TmdbTvSearchResult, TmdbTvSeasonEpisode,
};

#[tauri::command]
pub async fn tmdb_search(query: String) -> Result<Vec<TmdbSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || tmdb::search(&query))
        .await
        .map_err(|e| format!("tmdb search join: {e}"))?
}

#[tauri::command]
pub async fn tmdb_movie_details(tmdb_id: u32) -> Result<TmdbMovieDetails, String> {
    tauri::async_runtime::spawn_blocking(move || tmdb::details(tmdb_id))
        .await
        .map_err(|e| format!("tmdb details join: {e}"))?
}

#[tauri::command]
pub async fn tmdb_tv_search(query: String) -> Result<Vec<TmdbTvSearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || tmdb::search_tv(&query))
        .await
        .map_err(|e| format!("tmdb tv search join: {e}"))?
}

#[tauri::command]
pub async fn tmdb_tv_season(
    tmdb_tv_id: u32,
    season_number: u32,
) -> Result<Vec<TmdbTvSeasonEpisode>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        tmdb::tv_season(tmdb_tv_id, season_number)
    })
    .await
    .map_err(|e| format!("tmdb tv season join: {e}"))?
}
