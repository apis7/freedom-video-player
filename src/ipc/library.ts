import { invoke } from "@tauri-apps/api/core";
import { libInvoke } from "./libraryHostClient";

export {
  setHostEndpoint,
  setLibraryMode,
  getLibraryMode,
  getHostEndpoint,
  getHostHealth,
  getHostConnectivity,
  resetHostHealth,
  subscribeHostState,
  getHostStateVersion,
  readHomeDiscovery,
  type HomeDiscoverySnapshot,
  type HostConnectivity,
} from "./libraryHostClient";

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
  is_extended: boolean;
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
  // Folder management — paths are Host-machine paths in Client mode
  // (the Host's filesystem is the source of truth). Clients pass UNC
  // paths the Host can resolve.
  addFolder: (path: string, recursive: boolean) =>
    libInvoke<WatchedFolder>("add_folder", { path, recursive }),
  removeFolder: (folderId: number, deleteItems: boolean) =>
    libInvoke<void>("remove_folder", { folderId, deleteItems }),
  listFolders: () => libInvoke<WatchedFolder[]>("list_folders"),
  setFolderScanOnStartup: (folderId: number, value: boolean) =>
    libInvoke<void>("set_folder_scan_on_startup", { folderId, value }),
  rescanAll: () => libInvoke<void>("rescan_all"),
  scanCancel: () => libInvoke<void>("scan_cancel"),
  scanThrottle: (on: boolean) => libInvoke<void>("scan_throttle", { on }),
  rescanFolder: (folderId: number) =>
    libInvoke<void>("rescan_folder", { folderId }),
  listItems: () => libInvoke<LibraryRow[]>("list_items"),
  getRow: (fileId: number) =>
    libInvoke<LibraryRow | null>("get_row", { fileId }),
  getPosterBytes: (path: string) =>
    invoke<number[]>("library_get_poster_bytes", { path }),
  refreshMetadata: (identityId: number) =>
    libInvoke<void>("refresh_metadata", { identityId }),
  searchByFilenameLocal: (filename: string) =>
    invoke<string[]>("library_search_by_filename", { filename }),
  relocateFile: (fileId: number, newPath: string) =>
    libInvoke<void>("relocate_file", { fileId, newPath }),
  removeBrokenLinks: () =>
    libInvoke<number>("remove_broken_links"),
  findPossibleDuplicates: () =>
    invoke<FuzzyDupPair[]>("library_find_possible_duplicates"),
  renameFile: (fileId: number, newBasename: string) =>
    libInvoke<string>("rename_file", { fileId, newBasename }),
  probeFile: (fileId: number) =>
    invoke<boolean>("library_probe_file", { fileId }),
  googleImageSearch: (query: string, apiKey: string, cx: string) =>
    invoke<GoogleImage[]>("library_google_image_search", { query, apiKey, cx }),
  applyImageUrl: (identityId: number, imageUrl: string) =>
    invoke<string>("library_apply_image_url", { identityId, imageUrl }),
  setScopeNff: (kind: "collection" | "series", id: number, value: boolean) =>
    libInvoke<void>("set_scope_nff", {
      kind,
      id,
      nonFamilyFriendly: value,
    }),
  setFlags: (
    identityId: number,
    flags: {
      noProfileNecessary?: boolean;
      priorityForProfile?: boolean;
      nonFamilyFriendly?: boolean;
      is3d?: boolean;
      isExtended?: boolean;
    },
  ) =>
    libInvoke<void>("set_flags", {
      identityId,
      noProfileNecessary: flags.noProfileNecessary ?? null,
      priorityForProfile: flags.priorityForProfile ?? null,
      nonFamilyFriendly: flags.nonFamilyFriendly ?? null,
      is3d: flags.is3d ?? null,
      isExtended: flags.isExtended ?? null,
    }),
  setTags: (identityId: number, tags: string[]) =>
    libInvoke<void>("set_tags", { identityId, tags }),
  setNotes: (identityId: number, notes: string) =>
    libInvoke<void>("set_notes", { identityId, notes }),
  setFamilyRating: (identityId: number, rating: number | null) =>
    libInvoke<void>("set_family_rating", { identityId, rating }),
  setManualMetadata: (
    identityId: number,
    field: ManualMetadataField,
    value: string | null,
  ) =>
    libInvoke<void>("set_manual_metadata", { identityId, field, value }),
  roulettePick: (fileIds: number[], familyViewOn: boolean) =>
    libInvoke<LibraryRow | null>("roulette_pick", { fileIds, familyViewOn }),
  suggestNext: (familyViewOn: boolean) =>
    libInvoke<LibraryRow | null>("suggest_next", { familyViewOn }),
  dismissSuggestion: (identityId: number) =>
    libInvoke<void>("dismiss_suggestion", { identityId }),
  profileCreatorSuggest: (familyViewOn: boolean) =>
    libInvoke<LibraryRow | null>("profile_creator_suggest", { familyViewOn }),
  clearDriftWarning: (fileId: number) =>
    libInvoke<void>("clear_drift_warning", { fileId }),
  findFileByPath: (path: string) =>
    libInvoke<number | null>("find_file_by_path", { path }),
  setWatchProgress: (fileId: number, progressMs: number) =>
    libInvoke<void>("set_watch_progress", { fileId, progressMs }),
  markWatched: (fileId: number) =>
    libInvoke<void>("mark_watched", { fileId }),
  resetProgress: (fileId: number) =>
    libInvoke<void>("reset_progress", { fileId }),
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
    libInvoke<void>("set_clock_format", { format }),
  setDeleteDefault: (deleteDefault: "remove" | "recycle") =>
    libInvoke<void>("set_delete_default", { default: deleteDefault }),
  setPosterCacheCap: (capBytes: number) =>
    libInvoke<void>("set_poster_cache_cap", { capBytes }),
  setMode: (mode: LibraryMode) =>
    invoke<void>("library_set_mode", { mode }),
  setHomeFolder: (path: string | null) =>
    invoke<void>("library_set_home_folder", { path }),
  setHostAddress: (address: string | null) =>
    invoke<void>("library_set_host_address", { address }),
  rotateAuthToken: () => invoke<string>("library_rotate_auth_token"),
  snapshotStatus: () => invoke<SnapshotStatus>("library_snapshot_status"),
  snapshotSetEnabled: (enabled: boolean) =>
    invoke<void>("library_snapshot_set_enabled", { enabled }),
  snapshotSetKeepCount: (count: number) =>
    invoke<void>("library_snapshot_set_keep_count", { count }),
  snapshotSetCadenceDays: (days: number) =>
    invoke<void>("library_snapshot_set_cadence_days", { days }),
  snapshotTakeNow: () => invoke<string>("library_snapshot_take_now"),
  snapshotRevealDir: () => invoke<void>("library_snapshot_reveal_dir"),
  snapshotScheduleRestore: (snapshotPath: string) =>
    invoke<void>("library_snapshot_schedule_restore", { snapshotPath }),
  hostServerStatus: () =>
    invoke<HostServerStatus>("library_host_server_status"),
  testHostConnection: (url: string, token: string | null) =>
    invoke<HostConnectionTestResult>("library_test_host_connection", {
      url,
      token,
    }),
  findProbablePairs: () =>
    libInvoke<ProbablePair[]>("find_probable_pairs"),
  transferCuration: (
    fromIdentity: number,
    toIdentity: number,
    checklist: TransferChecklist,
  ) =>
    libInvoke<void>("transfer_curation", {
      fromIdentity,
      toIdentity,
      checklist,
    }),
  dismissPair: (fingerprintA: string, fingerprintB: string) =>
    libInvoke<void>("dismiss_pair", { fingerprintA, fingerprintB }),
  snoozePair: (fingerprintA: string, fingerprintB: string, hours?: number) =>
    libInvoke<void>("snooze_pair", {
      fingerprintA,
      fingerprintB,
      hours: hours ?? 24,
    }),
  findDuplicates: () =>
    libInvoke<DuplicateCluster[]>("find_duplicates"),
  // setCustomThumbnail: routes through libInvoke so it hits the Host's
  // disk in Client mode (the Host copies the picked image to sibling
  // `.fvp-thumb.<ext>` files next to each video). The PATH the Client
  // sends must be reachable from the HOST — typically a UNC path on the
  // same network share. A local-to-the-Client path will fail with a
  // clear "source not found" from the Host.
  setCustomThumbnail: (identityId: number, path: string | null) =>
    libInvoke<void>("set_custom_thumbnail", { identityId, path }),
  // revealInExplorer stays local — opens the Client's Explorer to the
  // (likely UNC) path. If the Client doesn't have the share mounted,
  // Explorer surfaces its own error; we don't redirect this to the Host.
  revealInExplorer: (path: string) =>
    invoke<void>("library_reveal_in_explorer", { path }),
  searchByFilename: (filename: string) =>
    libInvoke<string[]>("search_by_filename", { filename }),
  applyTmdbId: (identityId: number, tmdbId: number) =>
    libInvoke<void>("apply_tmdb_id", { identityId, tmdbId }),
  smartTmdbSearch: (groupKind: "collection" | "series", groupId: number) =>
    libInvoke<SmartTmdbCandidate[]>("smart_tmdb_search", {
      groupKind,
      groupId,
    }),
  removeFiles: (fileIds: number[]) =>
    libInvoke<DeleteSummary>("remove_files", { fileIds }),
  trashFiles: (fileIds: number[]) =>
    libInvoke<DeleteSummary>("trash_files", { fileIds }),
  logOpen: (fileId: number) =>
    libInvoke<void>("log_open", { fileId }),
  reorderCollections: (orderedIds: number[]) =>
    libInvoke<void>("reorder_collection", { orderedIds }),
  reorderSeriesList: (orderedIds: number[]) =>
    libInvoke<void>("reorder_series", { orderedIds }),
  reorderCollectionItems: (collectionId: number, orderedIdentityIds: number[]) =>
    libInvoke<void>("reorder_collection_items", {
      collectionId,
      orderedIdentityIds,
    }),
  reorderSeriesItems: (seriesId: number, orderedIdentityIds: number[]) =>
    libInvoke<void>("reorder_series_items", {
      seriesId,
      orderedIdentityIds,
    }),
  setSeriesHasSeasons: (seriesId: number, hasSeasons: boolean) =>
    libInvoke<void>("set_series_has_seasons", { seriesId, hasSeasons }),
  analytics: (days: number, tag: string | null) =>
    libInvoke<AnalyticsSnapshot>("analytics", { days, tag }),
  setSeriesItemSeason: (
    seriesId: number,
    identityId: number,
    season: number | null,
  ) =>
    libInvoke<void>("set_series_item_season", {
      seriesId,
      identityId,
      season,
    }),
  refreshProfileStatus: (videoPath: string) =>
    libInvoke<void>("refresh_profile_status", { videoPath }),
  listCollections: () =>
    libInvoke<CollectionRow[]>("list_collections"),
  createCollection: (name: string) =>
    libInvoke<number>("create_collection", { name }),
  renameCollection: (collectionId: number, newName: string) =>
    libInvoke<void>("rename_collection", { collectionId, newName }),
  deleteCollection: (collectionId: number) =>
    libInvoke<void>("delete_collection", { collectionId }),
  addToCollection: (collectionId: number, identityIds: number[]) =>
    libInvoke<void>("add_to_collection", { collectionId, identityIds }),
  removeFromCollection: (collectionId: number, identityIds: number[]) =>
    libInvoke<void>("remove_from_collection", { collectionId, identityIds }),
  listSeries: () => libInvoke<SeriesRow[]>("list_series"),
  createSeries: (name: string, hasSeasons: boolean) =>
    libInvoke<number>("create_series", { name, hasSeasons }),
  renameSeries: (seriesId: number, newName: string) =>
    libInvoke<void>("rename_series", { seriesId, newName }),
  deleteSeries: (seriesId: number) =>
    libInvoke<void>("delete_series", { seriesId }),
  addToSeries: (seriesId: number, identityIds: number[]) =>
    libInvoke<void>("add_to_series", { seriesId, identityIds }),
  removeFromSeries: (seriesId: number, identityIds: number[]) =>
    libInvoke<void>("remove_from_series", { seriesId, identityIds }),
};

export interface CollectionRow {
  id: number;
  name: string;
  created_at: number;
  item_count: number;
  non_family_friendly: boolean;
}

export interface SeriesRow {
  id: number;
  name: string;
  has_seasons: boolean;
  created_at: number;
  item_count: number;
  watched_count: number;
  non_family_friendly: boolean;
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

export interface FuzzyDupPair {
  a: { row: LibraryRow };
  b: { row: LibraryRow };
  /** 0..=100, rounded. Used to sort high-confidence pairs first. */
  score: number;
}

export interface GoogleImage {
  url: string;
  thumb_url: string;
  width: number;
  height: number;
  mime: string;
  source_page: string;
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

export type LibraryMode = "standalone" | "host" | "client";

/** Live status of the LAN HTTP server when this install is the Host.
 *  Used by Settings to show "Host running on 192.168.x.y:42171". */
export interface HostServerStatus {
  running: boolean;
  bound_address: string | null;
  lan_ip: string;
  port: number;
  protocol_version: number;
}

/** One snapshot file in the snapshots directory. */
export interface SnapshotEntry {
  filename: string;
  path: string;
  size_bytes: number;
  modified_unix: number;
}

/** Snapshot backup configuration + current state. */
export interface SnapshotStatus {
  enabled: boolean;
  keep_count: number;
  cadence_days: number;
  last_at: number;
  effective_dir: string;
  entries: SnapshotEntry[];
}

/** Result of probing a Host URL from a Client. `reachable` reports
 *  whether /v1/health returned anything; `authenticated` reports
 *  whether an auth-protected endpoint accepted the token (None if no
 *  token was supplied). */
export interface HostConnectionTestResult {
  reachable: boolean;
  authenticated: boolean | null;
  product: string | null;
  fvp_version: string | null;
  protocol: number | null;
  elapsed_ms: number;
  error: string | null;
}

export interface LibrarySettingsSnapshot {
  has_pin: boolean;
  family_view_allowed: boolean;
  family_view_enabled: boolean;
  clock_format: "12h" | "24h";
  delete_default: "remove" | "recycle";
  poster_cache_cap_bytes: number;
  poster_cache_size_bytes: number;
  // Networked-Library (Phase 1: persistence + UI only; networking lands in Phase 2).
  library_mode: LibraryMode;
  home_folder_path: string | null;
  home_folder_exists: boolean;
  host_address: string | null;
  host_auth_token: string | null;
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
