import { invoke } from "@tauri-apps/api/core";
import type { TmdbSearchResult, TmdbMovieDetails } from "./types";

export const tmdbIpc = {
  search: (query: string) =>
    invoke<TmdbSearchResult[]>("tmdb_search", { query }),
  details: (tmdbId: number) =>
    invoke<TmdbMovieDetails>("tmdb_movie_details", { tmdbId }),
};
