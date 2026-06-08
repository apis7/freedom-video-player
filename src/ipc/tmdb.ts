import { invoke } from "@tauri-apps/api/core";
import type { TmdbSearchResult, TmdbMovieDetails } from "./types";

export interface TmdbTvSearchResult {
  tmdb_tv_id: number;
  name: string;
  original_name: string;
  first_air_year: number | null;
  overview: string;
  poster_url: string | null;
  number_of_seasons: number | null;
}

export interface TmdbTvSeasonEpisode {
  season_number: number;
  episode_number: number;
  name: string;
  overview: string;
  air_date: string | null;
}

export const tmdbIpc = {
  search: (query: string) =>
    invoke<TmdbSearchResult[]>("tmdb_search", { query }),
  details: (tmdbId: number) =>
    invoke<TmdbMovieDetails>("tmdb_movie_details", { tmdbId }),
  tvSearch: (query: string) =>
    invoke<TmdbTvSearchResult[]>("tmdb_tv_search", { query }),
  tvSeason: (tmdbTvId: number, seasonNumber: number) =>
    invoke<TmdbTvSeasonEpisode[]>("tmdb_tv_season", {
      tmdbTvId,
      seasonNumber,
    }),
};
