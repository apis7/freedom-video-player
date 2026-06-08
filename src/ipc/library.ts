import { invoke } from "@tauri-apps/api/core";

export interface WatchedFolder {
  id: number;
  path: string;
  recursive: boolean;
  added_at: number;
  scan_on_startup: boolean;
}

export interface LibraryFile {
  id: number;
  path: string;
  watched_folder_id: number;
  identity_id: number;
  size_bytes: number;
  modified_unix: number;
  resolution: string | null;
  codec: string | null;
  is_missing: boolean;
  watch_progress_ms: number;
  last_watched_at: number | null;
  watched: boolean;
  added_at: number;
  drift_warning: boolean;
  has_free_sibling: boolean | null;
  has_subtitle: boolean | null;
}

export interface LibraryIdentity {
  id: number;
  cheap_fingerprint: string;
  strong_fingerprint: string | null;
  duration_ms: number;
  tmdb_id: number | null;
  movie_title: string | null;
  movie_year: number | null;
  movie_director: string | null;
  movie_plot: string | null;
  movie_stars: string[];
  genres: string[];
  mpaa_rating: string | null;
  imdb_id: string | null;
  imdb_rating: number | null;
  poster_url: string | null;
  poster_local_path: string | null;
  custom_thumbnail_path: string | null;
  notes: string | null;
  family_rating: number | null;
  non_family_friendly: boolean;
  priority_for_profile: boolean;
  no_profile_necessary: boolean;
  is_3d: boolean;
  manual_title: boolean;
  manual_year: boolean;
  manual_thumbnail: boolean;
  manual_director: boolean;
  manual_plot: boolean;
  first_seen_at: number;
  last_updated_at: number;
  maps_filtered_tier: string | null;
  maps_filtered_summary: string | null;
  maps_unfiltered_tier: string | null;
  maps_unfiltered_summary: string | null;
}

export type ProfileStatus = "has_profile" | "no_profile_necessary" | "missing";

export interface CollectionMembership {
  collection_id: number;
  collection_name: string;
  position: number;
}

export interface SeriesMembership {
  series_id: number;
  series_name: string;
  has_seasons: boolean;
  season: number | null;
  position: number;
}

export interface SyntheticSeriesInfo {
  series_id: number;
  series_name: string;
  episode_count: number;
  watched_count: number;
  has_seasons: boolean;
}

export interface LibraryRow {
  file: LibraryFile;
  identity: LibraryIdentity;
  tags: string[];
  profile_status: ProfileStatus;
  collections: CollectionMembership[];
  series: SeriesMembership | null;
  /** When set, this row REPRESENTS an entire series and is not a real
   *  file in the DB. The `file` and `identity` numeric fields are
   *  placeholders; do NOT send them to backend commands. Clicking such
   *  a row should scope into the series rather than play it.
   *
   *  The renderers detect this and use the series_name + per-series
   *  poster (chosen from the first member) for display.
   */
  __synthetic_series?: SyntheticSeriesInfo;
}

export type ManualMetadataField =
  | "title"
  | "year"
  | "director"
  | "plot"
  | "thumbnail"
  | "genres"
  | "stars";

export const libraryIpc = {
  addFolder: (path: string, recursive: boolean) =>
    invoke<WatchedFolder>("library_add_folder", { path, recursive }),
  removeFolder: (folderId: number, deleteItems: boolean) =>
    invoke<void>("library_remove_folder", { folderId, deleteItems }),
  listFolders: () => invoke<WatchedFolder[]>("library_list_folders"),
  setFolderScanOnStartup: (folderId: number, value: boolean) =>
    invoke<void>("library_set_folder_scan_on_startup", { folderId, value }),
  rescanAll: () => invoke<void>("library_rescan_all"),
  scanCancel: () => invoke<void>("library_scan_cancel"),
  scanThrottle: (on: boolean) => invoke<void>("library_scan_throttle", { on }),
  rescanFolder: (folderId: number) =>
    invoke<void>("library_rescan_folder", { folderId }),
  listItems: () => invoke<LibraryRow[]>("library_list_items"),
  getRow: (fileId: number) =>
    invoke<LibraryRow | null>("library_get_row", { fileId }),
  getPosterBytes: (path: string) =>
    invoke<number[]>("library_get_poster_bytes", { path }),
  refreshMetadata: (identityId: number) =>
    invoke<void>("library_refresh_metadata", { identityId }),
  searchByFilename: (filename: string) =>
    invoke<string[]>("library_search_by_filename", { filename }),
  relocateFile: (fileId: number, newPath: string) =>
    invoke<void>("library_relocate_file", { fileId, newPath }),
  setFlags: (
    identityId: number,
    flags: {
      noProfileNecessary?: boolean;
      priorityForProfile?: boolean;
      nonFamilyFriendly?: boolean;
      is3d?: boolean;
    },
  ) =>
    invoke<void>("library_set_flags", {
      identityId,
      noProfileNecessary: flags.noProfileNecessary ?? null,
      priorityForProfile: flags.priorityForProfile ?? null,
      nonFamilyFriendly: flags.nonFamilyFriendly ?? null,
      is3d: flags.is3d ?? null,
    }),
  setTags: (identityId: number, tags: string[]) =>
    invoke<void>("library_set_tags", { identityId, tags }),
  setNotes: (identityId: number, notes: string) =>
    invoke<void>("library_set_notes", { identityId, notes }),
  setFamilyRating: (identityId: number, rating: number | null) =>
    invoke<void>("library_set_family_rating", { identityId, rating }),
  setManualMetadata: (
    identityId: number,
    field: ManualMetadataField,
    value: string | null,
  ) =>
    invoke<void>("library_set_manual_metadata", { identityId, field, value }),
  roulettePick: (fileIds: number[], familyViewOn: boolean) =>
    invoke<LibraryRow | null>("library_roulette_pick", { fileIds, familyViewOn }),
  suggestNext: (familyViewOn: boolean) =>
    invoke<LibraryRow | null>("library_suggest_next", { familyViewOn }),
  dismissSuggestion: (identityId: number) =>
    invoke<void>("library_dismiss_suggestion", { identityId }),
  profileCreatorSuggest: (familyViewOn: boolean) =>
    invoke<LibraryRow | null>("library_profile_creator_suggest", { familyViewOn }),
  clearDriftWarning: (fileId: number) =>
    invoke<void>("library_clear_drift_warning", { fileId }),
  findFileByPath: (path: string) =>
    invoke<number | null>("library_find_file_by_path", { path }),
  setWatchProgress: (fileId: number, progressMs: number) =>
    invoke<void>("library_set_watch_progress", { fileId, progressMs }),
  markWatched: (fileId: number) =>
    invoke<void>("library_mark_watched", { fileId }),
  resetProgress: (fileId: number) =>
    invoke<void>("library_reset_progress", { fileId }),
  hasPin: () => invoke<boolean>("library_has_pin"),
  verifyPin: (pin: string) => invoke<boolean>("library_verify_pin", { pin }),
  setPin: (newPin: string | null, currentPin: string | null) =>
    invoke<void>("library_set_pin", { newPin, currentPin }),
  setFamilyViewAllowed: (allowed: boolean) =>
    invoke<void>("library_set_family_view_allowed", { allowed }),
  setFamilyViewEnabled: (enabled: boolean) =>
    invoke<void>("library_set_family_view_enabled", { enabled }),
  getSettings: () => invoke<LibrarySettingsSnapshot>("library_get_settings"),
  setClockFormat: (format: "12h" | "24h") =>
    invoke<void>("library_set_clock_format", { format }),
  setDeleteDefault: (deleteDefault: "remove" | "recycle") =>
    invoke<void>("library_set_delete_default", { default: deleteDefault }),
  setPosterCacheCap: (capBytes: number) =>
    invoke<void>("library_set_poster_cache_cap", { capBytes }),
  findProbablePairs: () =>
    invoke<ProbablePair[]>("library_find_probable_pairs"),
  transferCuration: (
    fromIdentity: number,
    toIdentity: number,
    checklist: TransferChecklist,
  ) =>
    invoke<void>("library_transfer_curation", {
      fromIdentity,
      toIdentity,
      checklist,
    }),
  dismissPair: (fingerprintA: string, fingerprintB: string) =>
    invoke<void>("library_dismiss_pair", { fingerprintA, fingerprintB }),
  snoozePair: (fingerprintA: string, fingerprintB: string, hours?: number) =>
    invoke<void>("library_snooze_pair", {
      fingerprintA,
      fingerprintB,
      hours: hours ?? 24,
    }),
  findDuplicates: () =>
    invoke<DuplicateCluster[]>("library_find_duplicates"),
  setCustomThumbnail: (identityId: number, path: string | null) =>
    invoke<void>("library_set_custom_thumbnail", { identityId, path }),
  revealInExplorer: (path: string) =>
    invoke<void>("library_reveal_in_explorer", { path }),
  applyTmdbId: (identityId: number, tmdbId: number) =>
    invoke<void>("library_apply_tmdb_id", { identityId, tmdbId }),
  smartTmdbSearch: (groupKind: "collection" | "series", groupId: number) =>
    invoke<SmartTmdbCandidate[]>("library_smart_tmdb_search", {
      groupKind,
      groupId,
    }),
  removeFiles: (fileIds: number[]) =>
    invoke<DeleteSummary>("library_remove_files", { fileIds }),
  trashFiles: (fileIds: number[]) =>
    invoke<DeleteSummary>("library_trash_files", { fileIds }),
  logOpen: (fileId: number) =>
    invoke<void>("library_log_open", { fileId }),
  reorderCollections: (orderedIds: number[]) =>
    invoke<void>("library_reorder_collection", { orderedIds }),
  reorderSeriesList: (orderedIds: number[]) =>
    invoke<void>("library_reorder_series", { orderedIds }),
  reorderCollectionItems: (collectionId: number, orderedIdentityIds: number[]) =>
    invoke<void>("library_reorder_collection_items", {
      collectionId,
      orderedIdentityIds,
    }),
  reorderSeriesItems: (seriesId: number, orderedIdentityIds: number[]) =>
    invoke<void>("library_reorder_series_items", {
      seriesId,
      orderedIdentityIds,
    }),
  setSeriesHasSeasons: (seriesId: number, hasSeasons: boolean) =>
    invoke<void>("library_set_series_has_seasons", { seriesId, hasSeasons }),
  analytics: (days: number, tag: string | null) =>
    invoke<AnalyticsSnapshot>("library_analytics", { days, tag }),
  setSeriesItemSeason: (
    seriesId: number,
    identityId: number,
    season: number | null,
  ) =>
    invoke<void>("library_set_series_item_season", {
      seriesId,
      identityId,
      season,
    }),
  refreshProfileStatus: (videoPath: string) =>
    invoke<void>("library_refresh_profile_status", { videoPath }),
  listCollections: () =>
    invoke<CollectionRow[]>("library_list_collections"),
  createCollection: (name: string) =>
    invoke<number>("library_create_collection", { name }),
  renameCollection: (collectionId: number, newName: string) =>
    invoke<void>("library_rename_collection", { collectionId, newName }),
  deleteCollection: (collectionId: number) =>
    invoke<void>("library_delete_collection", { collectionId }),
  addToCollection: (collectionId: number, identityIds: number[]) =>
    invoke<void>("library_add_to_collection", { collectionId, identityIds }),
  removeFromCollection: (collectionId: number, identityIds: number[]) =>
    invoke<void>("library_remove_from_collection", { collectionId, identityIds }),
  listSeries: () => invoke<SeriesRow[]>("library_list_series"),
  createSeries: (name: string, hasSeasons: boolean) =>
    invoke<number>("library_create_series", { name, hasSeasons }),
  renameSeries: (seriesId: number, newName: string) =>
    invoke<void>("library_rename_series", { seriesId, newName }),
  deleteSeries: (seriesId: number) =>
    invoke<void>("library_delete_series", { seriesId }),
  addToSeries: (seriesId: number, identityIds: number[]) =>
    invoke<void>("library_add_to_series", { seriesId, identityIds }),
  removeFromSeries: (seriesId: number, identityIds: number[]) =>
    invoke<void>("library_remove_from_series", { seriesId, identityIds }),
};

export interface CollectionRow {
  id: number;
  name: string;
  created_at: number;
  item_count: number;
}

export interface SeriesRow {
  id: number;
  name: string;
  has_seasons: boolean;
  created_at: number;
  item_count: number;
  watched_count: number;
}

export interface DeleteSummary {
  removed: number;
  trashed: number;
  failed: string[];
}

export interface SmartTmdbCandidate {
  identity_id: number;
  current_title: string;
  proposed_tmdb_id: number;
  proposed_title: string;
  proposed_year: number | null;
  proposed_poster_url: string | null;
}

export interface ProbablePair {
  left: LibraryRow;
  right: LibraryRow;
  signals: string[];
  is_likely_cut_difference: boolean;
}

export interface DuplicateCluster {
  identity_id: number;
  files: LibraryRow[];
}

export interface AnalyticsDailyBucket {
  day: string;
  opens: number;
  distinct_files: number;
  watched_ms: number;
}

export interface AnalyticsTopRow {
  identity_id: number;
  movie_title: string | null;
  opens: number;
  watched_ms: number;
}

export interface AnalyticsTagSlice {
  tag: string;
  opens: number;
  distinct_files: number;
}

export interface AnalyticsSnapshot {
  daily: AnalyticsDailyBucket[];
  top_movies: AnalyticsTopRow[];
  by_tag: AnalyticsTagSlice[];
  total_opens: number;
  total_watched_ms: number;
  total_distinct_files: number;
}

export interface TransferChecklist {
  tags: boolean;
  notes: boolean;
  family_rating: boolean;
  custom_thumbnail: boolean;
  non_family_friendly: boolean;
  priority_for_profile: boolean;
  no_profile_necessary: boolean;
  collections: boolean;
  series_membership: boolean;
  profile_link: boolean;
  watch_history: boolean;
}

export interface LibrarySettingsSnapshot {
  has_pin: boolean;
  family_view_allowed: boolean;
  family_view_enabled: boolean;
  clock_format: "12h" | "24h";
  delete_default: "remove" | "recycle";
  poster_cache_cap_bytes: number;
  poster_cache_size_bytes: number;
}

/** Emitted when a TMDb enrichment pass completes for one identity.
 *  Frontend can re-pull the row to show new poster / metadata. */
export interface IdentityUpdatedEvent {
  identity_id: number;
}

// Tauri event payloads emitted by the orchestrator.
export interface ScanStartedEvent {
  folder_id: number;
}
export interface ScanProgressEvent {
  folder_id: number;
  scanned: number;
  total: number;
}
export interface ScanDoneEvent {
  folder_id: number;
  scanned: number;
  new_items: number;
  duration_ms: number;
}
