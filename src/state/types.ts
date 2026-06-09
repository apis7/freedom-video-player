import type { FreeFile, MatchScore, Snip } from "../ipc/types";
import type { SubtitleTrack } from "../ipc/subtitles";
export type { FreeFile } from "../ipc/types";

export type AppMode = "player" | "creator" | "library" | "settings";

/** Persistent summary of a Full Metadata Refresh run. Drives the
 *  bottom-right footer badge + the detail popup. Auto-clears 8h
 *  after the run, or when the user explicitly dismisses. */
export interface FmrSummary {
  /** Unix ms — when the FMR tool was kicked off. The 8-hour
   *  auto-dismiss clock runs from here, NOT from completion. */
  ranAtMs: number;
  /** Count of identities queued for TMDb metadata refresh. */
  posterTotal: number;
  /** Count of identities that finished the TMDb refresh (got the
   *  identity-updated event before the safety timeout). */
  posterCompleted: number;
  /** Count of files queued for libmpv probe (missing res/runtime). */
  probeTotal: number;
  /** Count of files that actually had something filled in by the
   *  probe pass — files where mpv couldn't read either property
   *  count toward `probeTotal` but NOT `probeFilled`. */
  probeFilled: number;
}

export interface DetectedProfile {
  path: string;
  profile: FreeFile;
  score: MatchScore;
  /** True if this profile is currently applied to playback. */
  active: boolean;
}

export interface AppState {
  mode: AppMode;
  libraryEnabled: boolean;
  currentFile: string | null;
  loading: boolean;
  playing: boolean;
  fullscreen: boolean;
  chromeVisible: boolean;
  cheatsheetVisible: boolean;
  switcherOpen: boolean;
  volume: number;
  muted: boolean;
  abToggleOn: boolean;
  streamInfo: string | null;
  detectedProfiles: DetectedProfile[];
  cutTotalText: string;
  position: number;
  duration: number;
  // Profile Creator working state — in-memory until exported to .free
  snips: Snip[];
  /** "Primary" selected snip — drives the SnipDetailPanel and hotkey nudge
   *  target. When the selection is multi (selectedSnipIds.length > 1), this
   *  is the most recently clicked / range-anchor snip. */
  selectedSnipId: string | null;
  /** Full multi-selection. Always includes selectedSnipId when non-null. */
  selectedSnipIds: string[];
  /** When set, hotkey nudges target this edge instead of playback seek. */
  activeSnipEdge: { snipId: string; edge: "start" | "end" } | null;
  /** Per-snip lane assignment (frontend-only, not persisted to .free yet).
   *  Assigned at snip creation, preserved across edits so lanes don't swap. */
  snipLanes: Record<string, number>;
  /** User-defined categories (in addition to the bundled defaults). */
  customCategories: string[];
  /** When set, an <img> overlay is rendered over the video area (freeze-frame). */
  freezeFrameSrc: string | null;
  /** When true, clicking a snip auto-seeks playhead to its start. */
  jumpPlayheadOnSnipSelect: boolean;
  /** Current playback rate multiplier (1.0 = normal). */
  playbackSpeed: number;
  /** When true, Creator's working state autosaves to a sidecar .fvp-draft.json
   *  next to the video file on every change (debounced). */
  autosaveDraft: boolean;
  /** Player setting — when true, a small FVP icon shows in the corner of
   *  the video while a profile is actively applying. Default off. */
  playerShowProfileIcon: boolean;
  /** Player setting — when true, the movie's file path briefly fades in
   *  over the bottom of the video on play, but only when starting from
   *  the very beginning (<1s in). Default off. */
  playerShowPathOnStart: boolean;
  /** Google Custom Search JSON API key (user-supplied). Enables the
   *  "Find alt poster on Google" right-click action. Stored in
   *  localStorage; treated as a personal secret (the user's own
   *  Google Cloud project key). */
  googleCseApiKey: string;
  /** Google Custom Search Engine ID (cx parameter). Required alongside
   *  the API key — both must be set for the feature to activate. */
  googleCseId: string;
  /** Persistent summary of the most-recent Full Metadata Refresh run.
   *  Surfaced as a small clickable badge in the bottom-right footer.
   *  Auto-clears 8h after `ranAtMs`, or when the user clicks "OK" in
   *  the popup detail. Survives restarts via useSettingsPersist. */
  fmrSummary: FmrSummary | null;
  /** Active category filter for the Snip rail. null = show all. */
  snipFilterCategory: string | null;
  /** One-at-a-time transient toast (info / warn / error). */
  toast: Toast | null;
  /** Persistent bottom-of-screen progress banner for long-running bulk
   *  operations (e.g. "Refreshing metadata 12/50"). null when idle. */
  bulkProgress: { label: string; completed: number; total: number } | null;
  /** Open modal counter — incremented/decremented by modals on mount/unmount.
   *  The document-level right-click handler bails when this is > 0 so menus
   *  don't open under modals. */
  openModalCount: number;
  /** When a file open is taking too long, this becomes true and the
   *  LoadTimeoutModal asks the user whether to keep waiting or cancel. */
  loadingTimedOut: boolean;
  /** Tracks whether the autosave-failure toast has been shown this session,
   *  so we don't spam the user every 500ms when the disk is read-only. */
  autosaveErrorShown: boolean;
  /** Snapshot of libmpv's subtitle track list (refreshed on file open and
   *  after adding an external sub). */
  subtitleTracks: SubtitleTrack[];
  /** Are subtitles currently being rendered? (sub-visibility mpv property) */
  subtitleVisible: boolean;
  /** Parsed entries from the most-recently-added external subtitle file,
   *  rendered as blocks on the Profile Creator's Subs row. Empty for
   *  embedded-sub-only files. */
  subtitleEntries: import("../ipc/subtitles").SubtitleEntry[];
  /** True while a transient libmpv is extracting an embedded subtitle track
   *  in the background. The Subs row shows a pulsing indicator. */
  extractingSubtitles: boolean;
  /** About modal visibility — shown via Help → About FVP. */
  aboutVisible: boolean;
  /** Audio + video track snapshots (similar to subtitleTracks). */
  audioTracks: import("../ipc/subtitles").SubtitleTrack[];
  videoTracks: import("../ipc/subtitles").SubtitleTrack[];
  /** Current deinterlace state. */
  deinterlaceOn: boolean;
  /** ISO-639-1 code of the wordlist AutoSnip uses. Defaults to "en". */
  autoSnipLanguage: string;
  /** AutoSnip default padding (ms) applied before / after each subtitle
   *  entry when creating an auto-snip. Configurable in Settings. */
  autoSnipPadBeforeMs: number;
  autoSnipPadAfterMs: number;
  /** Audio output devices snapshot — populated on file open. */
  audioDevices: import("../ipc/tracks").AudioDevice[];
  /** IMDb parental guide URL stored on the working profile. Persisted in
   *  the .free file's metadata. */
  imdbUrl: string | null;
  /** Snip groups (a way to bundle related snips, e.g. "Act 2 fight scene"
   *  containing multiple snips). Persisted in the .free file. */
  groups: import("../ipc/types").SnipGroup[];
  /** User-overridden hotkey bindings, keyed by hotkey id from HOTKEYS
   *  registry. Empty value means use the default. */
  customHotkeys: Record<string, string>;
  /** Skip-That: when set, the user pressed `\` to start an open snip. Stays
   *  open until `]` closes it. ms-into-the-video at which it was opened. */
  skipThatPendingStartMs: number | null;
  /** Skip-That tray visibility (auto-fades 8s after last Skip-That activity). */
  skipThatTrayActiveAt: number | null;
  /** Visible window on the timeline (ms). endMs=0 → not yet initialized. */
  timelineView: { startMs: number; endMs: number };
  /** Timeline markers (user-placed), sorted ascending by ms. */
  markers: Marker[];
  /** AutoSnip-generated flags. Same visual + nav as markers; distinct in
   *  storage so we can re-run / clear AutoSnip without nuking user markers. */
  flags: Flag[];
  /** Undo history (LIFO). Each snapshot captures undoable state. */
  past: HistorySnapshot[];
  /** Redo stack (LIFO). */
  future: HistorySnapshot[];
  /** True when the libmpv audio-replace overlay (lavfi-complex graph) is
   *  currently applied. Set by useAudioReplaceOverlay; read by the apply
   *  engine to suppress its degrade-to-Skip fallback for audio_replace. */
  audioOverlayActive: boolean;
  /** Direction libmpv is currently playing in. Forward is the default;
   *  backward is engaged by Creator-mode's reverse-play button and reverts
   *  to forward whenever the user presses Space or hits play-forward. */
  playDirection: "forward" | "backward";
  /** Computed fingerprint of the currently-loaded video, cached so the
   *  autosave can embed it in the `.fvp-autosave.free` sidecar without
   *  re-running libmpv each time. Null until computed (or if compute
   *  failed). Cleared on file change. */
  currentFileFingerprint: import("../ipc/types").Fingerprint | null;
  /** Top-right safety banner shown when the user is about to play a
   *  video that either has an unloaded profile (`inactive-profile`) or
   *  has no profile yet (`no-profile`). Fades out after 10s + 5s fade.
   *  Cleared on click, dismiss, or expiry. */
  safetyBanner: {
    kind: "inactive-profile" | "no-profile";
    shownAt: number;
  } | null;
  /** Author handle the user has chosen to be attributed on profiles they
   *  create. `null` means anonymous — exported `.free` files will record
   *  edits without a handle. Persisted in localStorage. */
  authorHandle: string | null;
  /** Append-only edit log for the currently-loaded profile, kept in sync
   *  with the FreeFile's `authorship_history` field. Cleared on file
   *  change; appended to on save / export. */
  authorshipHistory: import("../ipc/types").AuthorshipEvent[];
  /** Override aspect ratio currently applied to playback. Empty string =
   *  use video's native ratio (libmpv's "no"). Persisted to the .free
   *  profile so the same override applies on every reopen of this file. */
  aspectRatio: string;
  /** Per-video metadata edited in Creator Mode's Movie Info panel and
   *  surfaced (read-only) in Player Mode's Description modal. All
   *  optional; persisted in the `.free` file's metadata block. */
  movieTitle: string | null;
  movieYear: number | null;
  mapsFiltered: import("../ipc/types").MapsRating | null;
  mapsUnfiltered: import("../ipc/types").MapsRating | null;
  movieDirector: string | null;
  movieStars: string[];
  moviePlot: string | null;
  imdbRating: number | null;
  imdbId: string | null;
  /** When true, designating a >3s snip as Beep silently shortens it
   *  without showing the confirmation popup. Suppressed via the "don't
   *  show this again" checkbox on the popup. Persisted in localStorage. */
  dontShowBeepShortenWarning: boolean;
  /** Audio waveform peaks for the currently-loaded file. Null until the
   *  sidecar is loaded or built. Used by Creator's ghost waveform layer. */
  audioPeaks: import("../ipc/types").LoadedPeaks | null;
  /** True while a background peak-build is in flight for the current file.
   *  Drives the small "building waveform" badge. Pointer-events:none — must
   *  never block the user's timeline interactions. */
  peaksBuilding: boolean;
  /** 0–100 progress for the in-flight build, or null when not building. */
  peaksBuildPercent: number | null;
  /** Snapshot key of the persistence-relevant state at the time of the last
   *  manual export. Null when the user hasn't exported in this session.
   *  Compared against the current snapshot to derive `unsavedSinceExport`. */
  lastSavedSnapshot: string | null;
  /** Derived: true when there's unsaved editing work since the last manual
   *  `.free` export. Drives the saved-status pill next to Autosave. */
  unsavedSinceExport: boolean;
  /** Absolute path of the last successful manual export for the current
   *  file. Set after every successful save; cleared on file open. Ctrl+S
   *  silently overwrites this path; Ctrl+Shift+S always opens the Save As
   *  modal regardless of whether this is set. */
  lastSavedPath: string | null;
}

export interface Marker {
  ms: number;
  name: string;
}

/**
 * Flag = an AutoSnip-generated marker. Visually identical to a Marker on
 * the timeline; behaviorally identical for tab-navigation. The extra
 * `category` + `keyword` fields let us show why it's there and filter.
 *
 * When AutoSnip drops a flag in the `snip` bucket, it also creates a Snip
 * and stores its ID here so removing the flag can cascade to the snip.
 */
export interface Flag {
  ms: number;
  name: string;
  category: string;
  keyword: string;
  subtitleText: string;
  linkedSnipId: string | null;
}

export interface Toast {
  id: string;
  message: string;
  kind: "info" | "warn" | "error";
  /** Duration in ms before auto-dismiss. */
  durationMs: number;
}

export interface HistorySnapshot {
  snips: Snip[];
  markers: Marker[];
  flags: Flag[];
  snipLanes: Record<string, number>;
}

export interface AppActions {
  setMode: (mode: AppMode) => void;
  setLibraryEnabled: (v: boolean) => void;
  togglePlay: () => void;
  toggleMute: () => void;
  toggleFullscreen: () => void;
  toggleAB: () => void;
  setVolume: (v: number) => void;
  setCurrentFile: (path: string | null) => void;
  setCheatsheetVisible: (v: boolean) => void;
  setSwitcherOpen: (v: boolean) => void;
  setDetectedProfiles: (p: DetectedProfile[]) => void;
  toggleProfileActive: (path: string) => void;
  addDetectedProfile: (p: DetectedProfile) => void;
  addSnip: (snip: Snip) => void;
  updateSnip: (id: string, updates: Partial<Snip>) => void;
  removeSnip: (id: string) => void;
  selectSnip: (id: string | null) => void;
  toggleSnipSelection: (id: string) => void;
  selectSnipRange: (id: string) => void;
  selectAllSnips: () => void;
  removeSnips: (ids: string[]) => void;
  /** Shift every snip in `ids` by `dxMs` (move). Non-selected snips that end
   *  up colliding on the same lane as a moved snip get bumped to a free lane.
   *  Moved snips never bump each other (they keep their relative layout). */
  moveSnipsBy: (ids: string[], dxMs: number) => void;
  /** Set each snip's start_ms/end_ms to a specific value (absolute). Used by
   *  the group-drag handler so it can clamp the WHOLE group against the
   *  timeline edges (instead of clamping per-snip, which collapses the group
   *  at the boundary). Non-selected colliding snips get bumped. */
  setSnipsBatch: (updates: Array<{ id: string; start_ms: number; end_ms: number }>) => void;
  duplicateSnips: (ids: string[]) => string[];
  clearSnips: () => void;
  setActiveSnipEdge: (edge: { snipId: string; edge: "start" | "end" } | null) => void;
  setTimelineView: (view: { startMs: number; endMs: number }) => void;
  addCustomCategory: (name: string) => void;
  removeCustomCategory: (name: string) => void;
  toggleJumpPlayheadOnSnipSelect: () => void;
  skipThatQuick: (currentMs: number) => void;
  skipThatBackAnchored: (currentMs: number) => void;
  skipThatOpen: (currentMs: number) => void;
  skipThatClose: (currentMs: number) => void;
  skipThatTrayPing: () => void;
  loadProfileAsDraft: (profile: FreeFile) => void;
  addGroup: (name: string) => string;
  renameGroup: (id: string, name: string) => void;
  removeGroup: (id: string) => void;
  setSnipGroup: (snipId: string, groupId: string | null) => void;
  setAutosaveDraft: (v: boolean) => void;
  setPlayerShowProfileIcon: (v: boolean) => void;
  setPlayerShowPathOnStart: (v: boolean) => void;
  setGoogleCseApiKey: (v: string) => void;
  setGoogleCseId: (v: string) => void;
  setFmrSummary: (s: FmrSummary | null) => void;
  setSnipFilterCategory: (c: string | null) => void;
  showToast: (message: string, kind?: Toast["kind"], durationMs?: number) => void;
  dismissToast: () => void;
  setBulkProgress: (p: { label: string; completed: number; total: number } | null) => void;
  incrementOpenModalCount: () => void;
  decrementOpenModalCount: () => void;
  addMarker: (ms: number, name?: string) => void;
  renameMarker: (ms: number, name: string) => void;
  removeMarker: (ms: number) => void;
  clearMarkers: () => void;
  addFlags: (flags: Flag[]) => void;
  renameFlag: (ms: number, name: string) => void;
  removeFlag: (ms: number) => void;
  clearFlags: () => void;
  commitToHistory: () => void;
  undo: () => void;
  redo: () => void;
}
