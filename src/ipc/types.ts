// TypeScript mirrors of the Rust profile/fingerprint types.
// Keep in sync with src-tauri/src/profile/format.rs and src-tauri/src/fingerprint/scoring.rs.

export interface Fingerprint {
  filename: string;
  size_bytes: number;
  container: string;
  codec: string;
  duration_ms: number;
  phash_samples: PhashSample[];
}

export interface PhashSample {
  position: number;
  hash: string;
}

export interface ProfileMetadata {
  name: string;
  movie_title: string | null;
  movie_year: number | null;
  version: number;
  notes: string | null;
  /** Unix epoch seconds. */
  created: number;
  /** Unix epoch seconds. */
  modified: number;
  /** Optional URL to the movie's IMDb parental guide page. */
  imdb_url?: string | null;
  /** Override aspect ratio applied to the video. null/undefined = use
   *  video's native. Values are strings like "16:9", "4:3", "2.35:1". */
  aspect_ratio?: string | null;
  /** MAPS rating with FVP filtering applied. */
  maps_filtered?: MapsRating | null;
  /** MAPS rating for the raw movie (no profile). */
  maps_unfiltered?: MapsRating | null;
  movie_director?: string | null;
  movie_stars?: string[];
  movie_plot?: string | null;
  imdb_rating?: number | null;
  imdb_id?: string | null;
}

export type MapsTier =
  | "family"
  | "teen"
  | "adult"
  | "married_adult"
  | "degrading";

export interface MapsRating {
  tier: MapsTier;
  summary: string;
}

export const MAPS_TIERS: { value: MapsTier; label: string; color: string }[] = [
  { value: "family",        label: "Family",        color: "#22c55e" }, // green
  { value: "teen",          label: "Teen",          color: "#eab308" }, // yellow
  { value: "adult",         label: "Adult",         color: "#f97316" }, // orange
  { value: "married_adult", label: "Married Adult", color: "#ef4444" }, // red
  { value: "degrading",     label: "Degrading",     color: "#1f2937" }, // black-ish
];

export const MAX_MAPS_SUMMARY_LEN = 200;
export const MAX_MOVIE_PLOT_LEN = 5000;
export const MAX_STARS_PER_MOVIE = 10;

export interface TmdbSearchResult {
  tmdb_id: number;
  title: string;
  original_title: string;
  release_year: number | null;
  overview: string;
  poster_url: string | null;
}

export interface TmdbMovieDetails {
  tmdb_id: number;
  imdb_id: string | null;
  title: string;
  release_year: number | null;
  runtime_minutes: number | null;
  vote_average: number | null;
  director: string | null;
  top_cast: string[];
  overview: string;
  poster_url: string | null;
}

/** Built-in aspect-ratio presets surfaced in the menu. The empty-string
 *  value maps to libmpv's "no" (clear override). */
export const ASPECT_RATIO_PRESETS: { label: string; value: string }[] = [
  { label: "Auto (video's native)", value: "" },
  { label: "16:9 — widescreen", value: "16:9" },
  { label: "4:3 — classic TV", value: "4:3" },
  { label: "21:9 — ultrawide", value: "21:9" },
  { label: "1.85:1 — flat", value: "1.85:1" },
  { label: "2.35:1 — CinemaScope", value: "2.35:1" },
  { label: "2.39:1 — modern CinemaScope", value: "2.39:1" },
  { label: "1:1 — square", value: "1:1" },
];

export const AUDIO_REPLACE_DEFAULT_CROSSFADE_MS = 1500;

export const MAX_BEEP_DURATION_MS = 3000;
export const BEEP_DEFAULT_FREQ_HZ = 1000;
export const BEEP_DEFAULT_LEVEL_DB = -22;

export type SnipAction =
  | { type: "skip" }
  | { type: "silence" }
  | { type: "freeze_frame" }
  | {
      type: "audio_replace";
      from_before: boolean;
      /** Shifts the source range away from the snip in the chosen direction.
       *  from_before: must be ≤ 0 (slide source earlier).
       *  from_after:  must be ≥ 0 (slide source later).
       *  Clamped so source range never overlaps the snip itself. */
      offset_ms: number;
      /** Fade in/out duration at the snip edges. Default 1500ms. */
      crossfade_ms: number;
    }
  | {
      type: "beep";
      /** Sine tone frequency in Hz. Default 1000 Hz (classic censoring beep). */
      freq_hz: number;
      /** Tone level in dB relative to full scale. Default -22 dB (subtle,
       *  audible but not jarring). */
      level_db: number;
    };

export interface Snip {
  id: string;
  start_ms: number;
  end_ms: number;
  categories: string[];
  action: SnipAction;
  group_id: string | null;
  note: string | null;
}

export interface SnipGroup {
  id: string;
  name: string;
}

export interface Payload {
  fingerprint: Fingerprint;
  metadata: ProfileMetadata;
  snips: Snip[];
  groups: SnipGroup[];
  /** Optional in older .free files (Rust uses serde(default)). */
  markers: Marker[];
  /** Append-only edit log keyed off the local Settings author handle.
   *  Optional in older .free files; new exports always include the
   *  current edit as the latest entry. */
  authorship_history: AuthorshipEvent[];
}

export interface AuthorshipEvent {
  /** Unix epoch seconds. */
  at: number;
  /** null = anonymous edit (no handle configured in Settings). */
  handle: string | null;
  kind: "created" | "modified";
}

export const MAX_AUTHOR_HANDLE_LEN = 64;

export interface Marker {
  ms: number;
  name: string;
}

export interface FreeFile {
  schema: number;
  signature: string | null;
  pubkey: string | null;
  uploader: string | null;
  payload: Payload;
}

export type MatchQuality = "no_match" | "weak" | "soft" | "exact";

export interface MatchScore {
  quality: MatchQuality;
  reasons: string[];
}

export interface MatchResult {
  path: string;
  profile: FreeFile;
  score: MatchScore;
}
