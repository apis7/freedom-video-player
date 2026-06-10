import { useCallback, useEffect, useMemo, useState } from "react";
import { LibraryNetworkingBanner } from "../components/library/LibraryNetworkingBanner";
import {
  LibraryLockoutOverlay,
  useShouldLockLibrary,
} from "../components/library/LibraryLockoutOverlay";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/appStore";
import {
  libraryIpc,
  type IdentityUpdatedEvent,
  type LibraryRow,
  type ScanDoneEvent,
  type ScanProgressEvent,
  type WatchedFolder,
} from "../ipc/library";
import { openVideoPath } from "../utils/openFileFlow";
import { actlog } from "../utils/actlog";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import {
  ALL_COLUMNS,
  DEFAULT_VISIBLE_COLUMNS,
  LibraryColumnView,
  type ColumnId,
} from "../components/library/LibraryColumnView";
import { LibraryThumbnailView } from "../components/library/LibraryThumbnailView";
import {
  LibraryFilters,
  EMPTY_FILTERS,
  applyFilters,
  type LibraryFilterState,
} from "../components/library/LibraryFilters";
import { LibraryDetailsPanel } from "../components/library/LibraryDetailsPanel";
import { LibrarySuggestionRail } from "../components/library/LibrarySuggestionRail";
import { ProfileCreatorNudge } from "../components/library/ProfileCreatorNudge";
import { MovieRouletteModal } from "../components/library/MovieRouletteModal";
import { PinPromptModal } from "../components/library/PinPromptModal";
import { ReconciliationDialog } from "../components/library/ReconciliationDialog";
import { DuplicateCatcherModal } from "../components/library/DuplicateCatcherModal";
import { PossibleDuplicatesModal } from "../components/library/PossibleDuplicatesModal";
import { GooglePosterModal } from "../components/library/GooglePosterModal";
import { FmrSummaryBadge } from "../components/library/FmrSummaryBadge";
import { AnalyticsDashboard } from "../components/library/AnalyticsDashboard";
import { AutoDetectSeriesModal } from "../components/library/AutoDetectSeriesModal";
import { BrokenFileModal } from "../components/library/BrokenFileModal";
import { AutoDetectSeasonsModal } from "../components/library/AutoDetectSeasonsModal";
import { RwbSpinner } from "../components/LoadingOverlay";
import { TmdbReplacePicker } from "../components/library/TmdbReplacePicker";
import {
  CollectionsSeriesPanel,
  type ActiveScope,
} from "../components/library/CollectionsSeriesPanel";
import { AddToGroupModal } from "../components/library/AddToGroupModal";
import { DeleteConfirmModal } from "../components/library/DeleteConfirmModal";
import { FEATURE_GOOGLE_POSTER_SEARCH } from "../featureFlags";
import type {
  DuplicateCluster,
  FuzzyDupPair,
  LibrarySettingsSnapshot,
  ProbablePair,
} from "../ipc/library";

type ViewMode = "thumbnail" | "column";

interface LibraryUiPrefs {
  viewMode: ViewMode;
  visibleColumns: ColumnId[];
  columnWidths: Partial<Record<ColumnId, number>>;
  sortBy: { column: ColumnId; ascending: boolean };
  use24hClock: boolean;
}

const PREFS_KEY = "fvp.library.ui.v1";
const DEFAULT_PREFS: LibraryUiPrefs = {
  viewMode: "thumbnail",
  visibleColumns: DEFAULT_VISIBLE_COLUMNS,
  columnWidths: {},
  sortBy: { column: "title", ascending: true },
  use24hClock: false,
};

function loadPrefs(): LibraryUiPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<LibraryUiPrefs>;
    return {
      viewMode: parsed.viewMode ?? DEFAULT_PREFS.viewMode,
      visibleColumns: parsed.visibleColumns ?? DEFAULT_PREFS.visibleColumns,
      columnWidths: parsed.columnWidths ?? DEFAULT_PREFS.columnWidths,
      sortBy: parsed.sortBy ?? DEFAULT_PREFS.sortBy,
      use24hClock: parsed.use24hClock ?? DEFAULT_PREFS.use24hClock,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: LibraryUiPrefs) {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage unavailable — non-fatal, prefs just don't persist this session.
  }
}

/**
 * Library Mode shell. Owns:
 *   - folders + items state (mirrored from the SQLite store via IPC)
 *   - multi-selection (selectedFileIds + primarySelectedId for shift-range anchor)
 *   - filters (search, profile, watch state, tags, genres, etc.)
 *   - UI prefs (view mode, column layout, sort) — persisted to localStorage
 *   - context menus
 *   - scan-progress display
 *
 * Splits into 3 columns: filters | content | details. Content swaps
 * between thumbnail grid and column table based on viewMode.
 */
export function LibraryMode() {
  const showToast = useAppStore((s) => s.showToast);
  // Client-mode safety gate: when we can't reach the Host, show a
  // full-area lockout instead of broken-link rows. Player Mode and
  // Profile Creator still work because mode switching is outside
  // this component's tree.
  const shouldLock = useShouldLockLibrary();

  const [folders, setFolders] = useState<WatchedFolder[]>([]);
  const [rows, setRows] = useState<LibraryRow[]>([]);
  // True after the FIRST listItems call resolves (success or failure).
  // Used to distinguish "still loading" (show spinner) from "loaded and
  // truly empty" (show EmptyState). Without this, slower computers can
  // sit on the empty-state for several seconds and look like the
  // library was wiped.
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [filters, setFilters] = useState<LibraryFilterState>(EMPTY_FILTERS);
  const [prefs, setPrefs] = useState<LibraryUiPrefs>(loadPrefs);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<number>>(new Set());
  const [primarySelectedId, setPrimarySelectedId] = useState<number | null>(null);
  const [scanProgress, setScanProgress] = useState<{
    folder_id: number;
    scanned: number;
    total: number;
  } | null>(null);
  // Folder IDs that currently have an active scan in flight. While a
  // folder is being scanned every row in it is transiently flagged
  // is_missing=1 by mark_folder_files_missing, then re-flagged as the
  // walker finds each file. If the user happens to look at the library
  // during that window every poster would render a red "broken" X. We
  // suppress the broken-X visuals for any file whose watched_folder_id
  // is in this set until the scan-done event arrives.
  const [scanningFolderIds, setScanningFolderIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [clock, setClock] = useState(() => new Date());
  const [rouletteOpen, setRouletteOpen] = useState(false);
  // Bumps every time the list changes — child rails use it to refetch.
  const [listRefreshToken, setListRefreshToken] = useState(0);
  const [librarySettings, setLibrarySettings] =
    useState<LibrarySettingsSnapshot | null>(null);
  const [pinPrompt, setPinPrompt] = useState<{
    reason: string;
    onSuccess: () => void;
  } | null>(null);
  const [probablePairs, setProbablePairs] = useState<ProbablePair[]>([]);
  const [activePairIdx, setActivePairIdx] = useState<number | null>(null);
  const [duplicateClusters, setDuplicateClusters] = useState<DuplicateCluster[] | null>(null);
  const [possibleDupPairs, setPossibleDupPairs] = useState<FuzzyDupPair[] | null>(null);
  const [googlePosterFor, setGooglePosterFor] = useState<LibraryRow | null>(null);
  const [familyExplainerOpen, setFamilyExplainerOpen] = useState(false);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [autoSeriesOpen, setAutoSeriesOpen] = useState(false);
  const [autoSeasonsOpen, setAutoSeasonsOpen] = useState<{
    seriesId: number;
    seriesName: string;
  } | null>(null);
  // Right-click "Auto-find others in this series…" opens the same
  // AutoDetect modal but seeded with only the rows that share the
  // clicked file's parent folder. Saves the user a manual hunt.
  const [autoFindFor, setAutoFindFor] = useState<LibraryRow | null>(null);
  const [brokenFileRow, setBrokenFileRow] = useState<LibraryRow | null>(null);
  // "Jump to season" sets this; views' useEffect reacts to the bumping
  // n counter and calls scrollToItem. Counter so consecutive jumps to
  // the same idx re-fire.
  const [jumpToRowIndex, setJumpToRowIndex] = useState<{ idx: number; n: number }>(
    { idx: -1, n: 0 },
  );
  // Identity-ids whose TMDb refresh we've requested but haven't yet
  // received a `library:identity-updated` event for. Drives the per-row
  // spinner so the user sees that something is happening on slow
  // network fetches. Cleared when the event arrives (in the listener
  // below) or after a 30s safety timeout in case the refresh errored
  // silently.
  const [refreshingIdentityIds, setRefreshingIdentityIds] = useState<
    Set<number>
  >(() => new Set());
  const markRefreshing = (identityId: number) => {
    setRefreshingIdentityIds((prev) => {
      const next = new Set(prev);
      next.add(identityId);
      return next;
    });
    window.setTimeout(() => {
      setRefreshingIdentityIds((prev) => {
        if (!prev.has(identityId)) return prev;
        const next = new Set(prev);
        next.delete(identityId);
        return next;
      });
    }, 30_000);
  };
  // Filters & Search section in the sidebar — collapsed by default so
  // the eye lands on All Movies / Collections / Series first. The user
  // expands explicitly; any sidebar scope click also auto-collapses it
  // (handled inline at the onScopeChange call site).
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [tmdbPicker, setTmdbPicker] = useState<{
    identityId: number;
    query: string;
  } | null>(null);
  const [addToGroup, setAddToGroup] = useState<{
    kind: "collection" | "series";
    identityIds: number[];
  } | null>(null);
  const [deletePrompt, setDeletePrompt] = useState<LibraryRow[] | null>(null);
  const [activeScope, setActiveScope] = useState<ActiveScope>({
    kind: "all",
    id: null,
    name: null,
  });

  const refreshProbablePairs = useCallback(async () => {
    try {
      const fresh = await libraryIpc.findProbablePairs();
      setProbablePairs(fresh);
      return fresh;
    } catch {
      // Non-fatal — engine might fail on a malformed identity; we just
      // skip the badge instead of showing an error toast.
      return null;
    }
  }, []);

  const reloadSettings = useCallback(async () => {
    try {
      const snap = await libraryIpc.getSettings();
      setLibrarySettings(snap);
    } catch (err) {
      showToast(`Load settings failed: ${err}`, "error");
    }
  }, [showToast]);

  useEffect(() => {
    void reloadSettings();
  }, [reloadSettings]);

  // Recompute probable pairs only when a scan actually completes — not
  // on every list refresh. Previously this fired every time the user
  // toggled a flag (each refresh cost 700ms for ~1200 identities).
  // refreshProbablePairs is NO LONGER auto-run on scan-done or on
  // mount. Earlier versions auto-ran it every time the library
  // refreshed, producing 21k+ "probable" pairs from a 1200-item
  // library (the matcher was too permissive and the volume drowned
  // out real matches). The matcher itself has been tightened, but
  // even with tight matching there's no reason to spend 4 seconds
  // scoring identities on every list refresh — users open
  // Tools → "Look for upgrades" when they want to review pairs.

  const familyViewOn = librarySettings?.family_view_enabled ?? false;
  void (librarySettings?.family_view_allowed ?? false); // kept for now — may re-introduce

  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await libraryIpc.listFolders());
    } catch (err) {
      showToast(`List folders failed: ${err}`, "error");
    }
  }, [showToast]);

  const refreshItems = useCallback(async () => {
    try {
      setRows(await libraryIpc.listItems());
      setListRefreshToken((n) => n + 1);
    } catch (err) {
      showToast(`List items failed: ${err}`, "error");
    } finally {
      setInitialLoadComplete(true);
    }
  }, [showToast]);

  // Initial load + persist prefs whenever they change.
  useEffect(() => {
    void refreshFolders();
    void refreshItems();
  }, [refreshFolders, refreshItems]);

  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  // Clock tick — once a minute is enough at this granularity.
  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // Backend event subscriptions.
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    const guard = (un: UnlistenFn) => {
      if (cancelled) un();
      else unlisteners.push(un);
    };
    listen<{ folder_id: number }>("library:scan-started", (e) => {
      setScanningFolderIds((prev) => {
        const next = new Set(prev);
        next.add(e.payload.folder_id);
        return next;
      });
    }).then(guard);
    listen<ScanProgressEvent>("library:scan-progress", (e) =>
      setScanProgress(e.payload),
    ).then(guard);
    listen<{ folder_id?: number }>("library:scan-cancelled", (e) => {
      setScanProgress(null);
      if (typeof e.payload.folder_id === "number") {
        const id = e.payload.folder_id;
        setScanningFolderIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
      showToast("Scan cancelled.", "info", 2500);
    }).then(guard);
    listen<ScanDoneEvent>("library:scan-done", (e) => {
      setScanProgress(null);
      setScanningFolderIds((prev) => {
        if (!prev.has(e.payload.folder_id)) return prev;
        const next = new Set(prev);
        next.delete(e.payload.folder_id);
        return next;
      });
      if (e.payload.new_items > 0) {
        showToast(
          `Indexed ${e.payload.new_items} new item${e.payload.new_items === 1 ? "" : "s"}`,
          "info",
          3000,
        );
      }
      void refreshItems();
    }).then(guard);
    listen("library:list-changed", () => {
      void refreshItems();
    }).then(guard);
    // identity-updated fires once per TMDb enrichment completion — up
    // to N times in rapid succession during the initial backlog. We
    // collect touched identity_ids in a Set, debounce 500 ms, then
    // surgically patch only those rows in state via library_get_row.
    // No full list_items reload; no full re-render of unrelated rows.
    const pendingIds = new Set<number>();
    let flushTimer: number | null = null;
    const flush = async () => {
      flushTimer = null;
      if (pendingIds.size === 0) return;
      const ids = Array.from(pendingIds);
      pendingIds.clear();
      // Snapshot CURRENT rows via the setter to get the latest values.
      const fileIds: number[] = [];
      setRows((prev) => {
        for (const r of prev) {
          if (ids.includes(r.identity.id)) fileIds.push(r.file.id);
        }
        return prev;
      });
      if (fileIds.length === 0) return;
      const fresh = await Promise.all(
        fileIds.map((id) =>
          libraryIpc.getRow(id).catch(() => null as LibraryRow | null),
        ),
      );
      const byFileId = new Map<number, LibraryRow>();
      for (const r of fresh) {
        if (r) byFileId.set(r.file.id, r);
      }
      if (byFileId.size === 0) return;
      setRows((older) =>
        older.map((row) => byFileId.get(row.file.id) ?? row),
      );
      setListRefreshToken((n) => n + 1);
    };
    const scheduleFlush = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(() => void flush(), 500);
    };
    listen<IdentityUpdatedEvent>("library:identity-updated", (e) => {
      pendingIds.add(e.payload.identity_id);
      scheduleFlush();
      // Refresh complete for this identity — drop it from the
      // "spinning" set so the per-row indicator goes away.
      const id = e.payload.identity_id;
      setRefreshingIdentityIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }).then(guard);
    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
      if (flushTimer !== null) window.clearTimeout(flushTimer);
    };
  }, [refreshItems, showToast]);

  // Multi-select hotkeys (Ctrl+A, Delete) — bound at the document level
  // while Library is mounted. We bail early when focus is in an input
  // (the filter search field shouldn't swallow keystrokes).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (inField) return;
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        setSelectedFileIds(new Set(filteredRows.map((r) => r.file.id)));
        setPrimarySelectedId(
          filteredRows.length > 0 ? filteredRows[0]!.file.id : null,
        );
      } else if (
        (e.key === "Delete" || e.key === "Del") &&
        selectedFileIds.size > 0
      ) {
        e.preventDefault();
        const targets = rows.filter((r) => selectedFileIds.has(r.file.id));
        if (targets.length > 0) {
          actlog(
            "menu",
            `delete-key prompt for ${targets.length} item${targets.length === 1 ? "" : "s"}`,
          );
          setDeletePrompt(targets);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, filters, selectedFileIds]);

  // Derived: filtered & ordered rows the views render.
  // Active scope (collection / series) narrows the pool BEFORE the
  // user's filters apply — picking a collection from the sidebar then
  // toggling watch-state on shows only watched items in that collection.
  //
  // All Movies behavior: per directive, a movie that has been added to
  // any series is hidden from the main library list — only its series
  // entry represents it. This dedup keeps Series acting like a
  // collection-style grouping, not a duplicate row.
  const filteredRows = useMemo(() => {
    let pool = rows;
    if (activeScope.kind === "collection" && activeScope.id !== null) {
      pool = rows.filter((r) =>
        r.collections.some((c) => c.collection_id === activeScope.id),
      );
      // Sort by the user's drag-reorder position (CollectionMembership.position)
      // so dragging actually MOVES things visually. Falls back to title for
      // anything that doesn't have a position yet (legacy rows pre-reorder).
      pool = [...pool].sort((a, b) => {
        const aMembership = a.collections.find(
          (c) => c.collection_id === activeScope.id,
        );
        const bMembership = b.collections.find(
          (c) => c.collection_id === activeScope.id,
        );
        const aPos = aMembership?.position ?? Number.MAX_SAFE_INTEGER;
        const bPos = bMembership?.position ?? Number.MAX_SAFE_INTEGER;
        if (aPos !== bPos) return aPos - bPos;
        return (a.identity.movie_title ?? a.file.path).localeCompare(
          b.identity.movie_title ?? b.file.path,
        );
      });
    } else if (activeScope.kind === "series" && activeScope.id !== null) {
      pool = rows.filter(
        (r) => r.series?.series_id === activeScope.id,
      );
      // Always sort by series-membership position so drag-reorder works.
      // When seasons are enabled, the season number takes precedence so
      // episodes stay grouped per-season.
      const seriesHasSeasons = pool.some((r) => r.series?.has_seasons);
      pool = [...pool].sort((a, b) => {
        if (seriesHasSeasons) {
          const aSeason = a.series?.season ?? Number.MAX_SAFE_INTEGER;
          const bSeason = b.series?.season ?? Number.MAX_SAFE_INTEGER;
          if (aSeason !== bSeason) return aSeason - bSeason;
        }
        const aPos = a.series?.position ?? Number.MAX_SAFE_INTEGER;
        const bPos = b.series?.position ?? Number.MAX_SAFE_INTEGER;
        if (aPos !== bPos) return aPos - bPos;
        return (a.identity.movie_title ?? a.file.path).localeCompare(
          b.identity.movie_title ?? b.file.path,
        );
      });
    } else {
      // All Movies → series acts as a single-entity per directive:
      // hide individual episode rows and emit one synthetic row per
      // distinct series. Synthetic rows render with the series name
      // and a representative poster; clicking scopes into the series.
      const standalone = rows.filter((r) => r.series == null);
      const seriesGroups = new Map<number, LibraryRow[]>();
      for (const r of rows) {
        if (r.series == null) continue;
        const list = seriesGroups.get(r.series.series_id) ?? [];
        list.push(r);
        seriesGroups.set(r.series.series_id, list);
      }
      const synthetics: LibraryRow[] = [];
      const synthMembers = new Map<number, LibraryRow[]>(); // synth.file.id → members
      for (const [seriesId, members] of seriesGroups) {
        const head = members.find(
          (m) => m.identity.custom_thumbnail_path || m.identity.poster_local_path,
        ) ?? members[0]!;
        const watched = members.filter((m) => m.file.watched).length;
        const name = members[0]!.series!.series_name;
        const hasSeasons = members[0]!.series!.has_seasons;
        const synth = buildSyntheticSeriesRow(seriesId, name, members.length, watched, hasSeasons, head);
        synthetics.push(synth);
        synthMembers.set(synth.file.id, members);
      }
      // Filter standalones normally.
      const filteredStandalones = applyFilters(standalone, filters, familyViewOn);
      // Synthetic series: include if EITHER the synthetic itself matches
      // (matches by series name) OR any of its members matches (so a
      // search for "Winter" surfaces the "Captain America" series when
      // it contains "Winter Soldier"). Without this, hidden members are
      // unsearchable from the All Movies view.
      const synthMatchSet = new Set(
        applyFilters(synthetics, filters, familyViewOn).map((r) => r.file.id),
      );
      const filteredSynthetics: LibraryRow[] = [];
      for (const synth of synthetics) {
        if (synthMatchSet.has(synth.file.id)) {
          filteredSynthetics.push(synth);
          continue;
        }
        const members = synthMembers.get(synth.file.id) ?? [];
        if (applyFilters(members, filters, familyViewOn).length > 0) {
          filteredSynthetics.push(synth);
        }
      }
      // Merge standalone movies and series tiles into a single list
      // sorted by title (case-insensitive). Earlier behavior appended
      // every series tile at the END so an "X-Men" series synth
      // landed after every standalone, even ones whose title sorted
      // later than "X". Now series tiles interleave alphabetically
      // with the rest, matching the column view's natural sort.
      const merged = [...filteredStandalones, ...filteredSynthetics];
      const titleKey = (r: LibraryRow): string => {
        if (r.__synthetic_series) return r.__synthetic_series.series_name;
        return r.identity.movie_title ?? r.file.path;
      };
      merged.sort((a, b) =>
        titleKey(a).localeCompare(titleKey(b), undefined, {
          sensitivity: "base",
        }),
      );
      return merged;
    }
    return applyFilters(pool, filters, familyViewOn);
  }, [rows, filters, familyViewOn, activeScope]);

  // Visual-only mask: while a folder is being scanned, every row in
  // it is transiently marked is_missing=1 by the orchestrator before
  // the walker un-flags each found file. Without this layer the user
  // sees every poster get a red broken-file X for the duration of
  // the scan. We clear is_missing here so the views never paint that
  // false-positive. The underlying DB row is unchanged; the next
  // scan-done event triggers a refreshItems that fetches the
  // post-scan truth.
  const maskedFilteredRows = useMemo(() => {
    if (scanningFolderIds.size === 0) return filteredRows;
    return filteredRows.map((r) =>
      r.file.is_missing && scanningFolderIds.has(r.file.watched_folder_id)
        ? { ...r, file: { ...r.file, is_missing: false } }
        : r,
    );
  }, [filteredRows, scanningFolderIds]);

  // Cache row index for fast shift-range pick.
  const filteredIndex = useMemo(() => {
    const map = new Map<number, number>();
    filteredRows.forEach((r, i) => map.set(r.file.id, i));
    return map;
  }, [filteredRows]);

  /**
   * Series layout — fires for ANY series scope (with or without
   * seasons). Always produces a per-row label map and a season-group
   * list. When seasons are on, labels are "S.E" (e.g. "1.3") and the
   * column view inserts header rows between groups. When seasons are
   * off, labels are bare 1-based sequence ("1", "2", "3"…) regardless
   * of the underlying DB position values — that way legacy series
   * whose positions in the DB don't start at 0 still DISPLAY a clean
   * 1-based numbering.
   */
  const seasonLayout = useMemo(() => {
    // Labels keyed by FILE id (not identity) so duplicate-identity rows
    // each render their own label. The "primary" copy of an identity
    // (first seen in display order) gets the bare position number; any
    // subsequent file row sharing the same identity gets ".Dup", ".Dup2",
    // ".Dup3", … so the user can see at a glance that an episode has
    // multiple copies on disk. The duplicate copies do NOT increment the
    // primary position counter (it advances by IDENTITY, not by row).
    const labels = new Map<number, string>();
    const groups: { season: number; firstRowIndex: number; count: number }[] = [];
    if (activeScope.kind !== "series") {
      return { labels, groups, active: false, hasSeasons: false };
    }
    const hasSeasons = filteredRows.some((r) => r.series?.has_seasons);
    /** identity_id → 0-based count of duplicate copies emitted so far. */
    const dupCount = new Map<number, number>();
    /** identity_id → the position string the primary copy received. */
    const primaryLabel = new Map<number, string>();
    if (!hasSeasons) {
      let nextPos = 1;
      filteredRows.forEach((r) => {
        const seen = dupCount.get(r.identity.id) ?? 0;
        if (seen === 0) {
          const lbl = String(nextPos);
          primaryLabel.set(r.identity.id, lbl);
          labels.set(r.file.id, lbl);
          dupCount.set(r.identity.id, 1);
          nextPos += 1;
        } else {
          const base = primaryLabel.get(r.identity.id) ?? "";
          const suffix = seen === 1 ? "Dup" : `Dup${seen}`;
          labels.set(r.file.id, `${base}.${suffix}`);
          dupCount.set(r.identity.id, seen + 1);
        }
      });
      return { labels, groups, active: true, hasSeasons: false };
    }
    let currentSeason: number | null = null;
    let inSeasonCounter = 0;
    filteredRows.forEach((r, i) => {
      const season = r.series?.season ?? null;
      if (season !== currentSeason) {
        currentSeason = season;
        inSeasonCounter = 0;
        groups.push({
          season: season ?? 0,
          firstRowIndex: i,
          count: 0,
        });
      }
      const seasonLabel = season ?? 0;
      const seen = dupCount.get(r.identity.id) ?? 0;
      if (seen === 0) {
        inSeasonCounter += 1;
        groups[groups.length - 1]!.count = inSeasonCounter;
        const lbl = `${seasonLabel}.${inSeasonCounter}`;
        primaryLabel.set(r.identity.id, lbl);
        labels.set(r.file.id, lbl);
        dupCount.set(r.identity.id, 1);
      } else {
        const base = primaryLabel.get(r.identity.id) ?? `${seasonLabel}.?`;
        const suffix = seen === 1 ? "Dup" : `Dup${seen}`;
        labels.set(r.file.id, `${base}.${suffix}`);
        dupCount.set(r.identity.id, seen + 1);
      }
    });
    return { labels, groups, active: true, hasSeasons: true };
  }, [activeScope, filteredRows]);
  const primaryRow = useMemo(
    () =>
      maskedFilteredRows.find((r) => r.file.id === primarySelectedId) ?? null,
    [maskedFilteredRows, primarySelectedId],
  );

  const handlePick = useCallback(
    (fileId: number, mods: { ctrl: boolean; shift: boolean }) => {
      setSelectedFileIds((prev) => {
        const next = new Set(prev);
        if (mods.shift && primarySelectedId !== null) {
          const a = filteredIndex.get(primarySelectedId) ?? 0;
          const b = filteredIndex.get(fileId) ?? 0;
          const [lo, hi] = a < b ? [a, b] : [b, a];
          if (!mods.ctrl) next.clear();
          for (let i = lo; i <= hi; i++) {
            const r = filteredRows[i];
            if (r) next.add(r.file.id);
          }
          return next;
        }
        if (mods.ctrl) {
          if (next.has(fileId)) next.delete(fileId);
          else next.add(fileId);
          return next;
        }
        // Plain click — single select.
        return new Set([fileId]);
      });
      // Anchor moves on every non-shift click.
      if (!mods.shift) {
        setPrimarySelectedId(fileId);
      }
    },
    [primarySelectedId, filteredIndex, filteredRows],
  );

  const handlePlay = useCallback(
    (row: LibraryRow) => {
      if (row.__synthetic_series) {
        const s = row.__synthetic_series;
        actlog(
          "library",
          `play synth-series series_id=${s.series_id} → scoping`,
        );
        setActiveScope({ kind: "series", id: s.series_id, name: s.series_name });
        return;
      }
      // If we already know the file is missing (flagged by the indexer
      // on its last scan), short-circuit straight to the themed recovery
      // modal instead of letting the player-side load fail with a generic
      // alert. Saves the user a round-trip through the player.
      if (row.file.is_missing) {
        actlog("library", `play broken file_id=${row.file.id} → recovery modal`);
        setBrokenFileRow(row);
        return;
      }
      actlog(
        "library",
        `play identity_id=${row.identity.id} file_id=${row.file.id}`,
      );
      useAppStore.setState({ mode: "player" });
      void openVideoPath(row.file.path);
    },
    [],
  );

  // Bulk metadata refresh. Single-item case keeps the original flow
  // (single toast, no progress banner). Multi-item case enqueues all
  // jobs immediately (backend has its own throttle) and tracks
  // completion via the `library:identity-updated` event the enricher
  // emits after each TMDb fetch. Progress banner clears when the
  // pending set drains; safety timeout prevents a stuck banner if the
  // backend silently drops an enrichment (e.g. TMDb 404 with no
  // identity-updated emission).
  const refreshManyMetadata = useCallback(
    async (
      identityIds: number[],
    ): Promise<{ completed: number; total: number }> => {
      const ids = Array.from(new Set(identityIds));
      if (ids.length === 0) return { completed: 0, total: 0 };
      const setBulkProgress = useAppStore.getState().setBulkProgress;
      if (ids.length === 1) {
        markRefreshing(ids[0]!);
        await libraryIpc.refreshMetadata(ids[0]!);
        showToast("Metadata refresh queued.", "info", 2000);
        // Single-shot: we don't await the identity-updated event for the
        // FMR summary's sake; treat as completed for reporting.
        return { completed: 1, total: 1 };
      }
      return await new Promise<{ completed: number; total: number }>((resolve) => {
        const pending = new Set(ids);
        setBulkProgress({
          label: "Refreshing metadata from TMDb",
          completed: 0,
          total: ids.length,
        });
        for (const id of ids) markRefreshing(id);
        let resolved = false;
        const settle = () => {
          if (resolved) return;
          resolved = true;
          setBulkProgress(null);
          resolve({ completed: ids.length - pending.size, total: ids.length });
        };
        const unlistenPromise = listen<{ identity_id: number }>(
          "library:identity-updated",
          (e) => {
            const id = e.payload.identity_id;
            if (!pending.has(id)) return;
            pending.delete(id);
            const completed = ids.length - pending.size;
            if (pending.size === 0) {
              showToast(
                `Refreshed metadata for ${ids.length} items.`,
                "info",
                3000,
              );
              void unlistenPromise.then((u) => u());
              settle();
            } else {
              setBulkProgress({
                label: "Refreshing metadata from TMDb",
                completed,
                total: ids.length,
              });
            }
          },
        );
        (async () => {
          for (const id of ids) {
            try {
              await libraryIpc.refreshMetadata(id);
            } catch {
              // Soft-fail; safety timeout below catches stuck ones.
            }
          }
        })();
        window.setTimeout(
          () => {
            if (pending.size === 0) return;
            void unlistenPromise.then((u) => u());
            showToast(
              `Metadata refresh finished with ${pending.size} item${pending.size === 1 ? "" : "s"} unverified.`,
              "warn",
              5000,
            );
            settle();
          },
          Math.max(120_000, ids.length * 60_000),
        );
      });
    },
    [showToast],
  );

  // Backfill probe runner. Serial; throttles itself between items so a
  // big batch doesn't saturate the SMB pipe. Uses the same bottom
  // BulkProgressBar slot as refreshManyMetadata — if both run at once
  // the user sees whichever updated most recently. (Acceptable
  // trade-off; both ARE running and both will finish.)
  const runProbeBackfill = useCallback(
    async (fileIds: number[]): Promise<{ filled: number; total: number }> => {
      const ids = Array.from(new Set(fileIds));
      if (ids.length === 0) return { filled: 0, total: 0 };
      const setBulkProgress = useAppStore.getState().setBulkProgress;
      setBulkProgress({
        label: "Probing files for runtime / resolution",
        completed: 0,
        total: ids.length,
      });
      let filled = 0;
      for (let i = 0; i < ids.length; i += 1) {
        try {
          const changed = await libraryIpc.probeFile(ids[i]!);
          if (changed) filled += 1;
        } catch {
          // Soft-fail per-file; keep going.
        }
        setBulkProgress({
          label: "Probing files for runtime / resolution",
          completed: i + 1,
          total: ids.length,
        });
      }
      setBulkProgress(null);
      void refreshItems();
      showToast(
        `Probe done — ${filled} of ${ids.length} got new runtime/resolution data.`,
        "info",
        4000,
      );
      return { filled, total: ids.length };
    },
    [refreshItems, showToast],
  );

  const buildItemMenu = useCallback(
    (row: LibraryRow): MenuItem[] => {
      // Synthetic series rows get a minimal menu — most per-file
      // operations don't apply at the series level (no profile, no
      // path on disk, etc.). The user opens the series scope to act
      // on individual episodes.
      if (row.__synthetic_series) {
        const s = row.__synthetic_series;
        return [
          {
            kind: "item",
            label: `Open "${s.series_name}" (${s.episode_count} item${s.episode_count === 1 ? "" : "s"})`,
            onClick: () => handlePlay(row),
          },
          { kind: "separator" },
          {
            kind: "item",
            label: "Rename series…",
            onClick: () => {
              const next = window.prompt("New series name:", s.series_name);
              if (!next || next.trim() === s.series_name) return;
              void libraryIpc
                .renameSeries(s.series_id, next.trim())
                .then(refreshItems)
                .catch((err) => showToast(`Rename failed: ${err}`, "error"));
            },
          },
          {
            kind: "item",
            label: "Delete series (keeps the movies)",
            onClick: () => {
              if (
                !window.confirm(
                  `Delete series "${s.series_name}"? Movies stay in the library; they'll just be ungrouped.`,
                )
              )
                return;
              void libraryIpc
                .deleteSeries(s.series_id)
                .then(refreshItems)
                .catch((err) => showToast(`Delete failed: ${err}`, "error"));
            },
          },
        ];
      }
      // Determine effective target set. When the user right-clicks an
      // item that IS in the current multi-selection, most actions apply
      // to the whole selection. The exceptions (Play / Edit profile /
      // Show in Explorer / per-item operations like Replace metadata,
      // Custom thumbnail upload, Auto-find others) gray out when multi
      // since they only make sense per-item.
      const rowInSelection = selectedFileIds.has(row.file.id);
      const targets =
        rowInSelection && selectedFileIds.size > 1
          ? rows.filter((r) => selectedFileIds.has(r.file.id))
          : [row];
      const isMulti = targets.length > 1;
      const targetIdentityIds = Array.from(
        new Set(targets.map((t) => t.identity.id)),
      );
      const targetFileIds = targets.map((t) => t.file.id);
      const isPriority = row.identity.priority_for_profile;
      const isClean = row.identity.no_profile_necessary;
      const isNff = row.identity.non_family_friendly;
      const N = targets.length;
      const multiSuffix = isMulti ? ` (${N} selected)` : "";
      const singleOnlyTitle = isMulti
        ? "Select a single item to use this action"
        : undefined;
      // Multi flag-toggle helper. The clicked row's current value
      // determines the NEW value applied to all selected (so the menu's
      // check mark is predictive: clicking "✓ Priority" turns Priority
      // OFF for every selected item).
      const applyFlagToAll = (
        flag: "priorityForProfile" | "noProfileNecessary" | "nonFamilyFriendly",
        newValue: boolean,
      ) => {
        void Promise.all(
          targetIdentityIds.map((id) =>
            libraryIpc.setFlags(id, { [flag]: newValue }),
          ),
        ).then(refreshItems);
      };
      return [
        {
          kind: "item",
          label: "Play",
          disabled: isMulti,
          title: singleOnlyTitle,
          onClick: () => handlePlay(row),
        },
        {
          kind: "item",
          label: "Edit profile…",
          disabled: isMulti,
          title: isMulti
            ? singleOnlyTitle
            : "Switch to Profile Creator with this video loaded",
          onClick: () => {
            useAppStore.setState({ mode: "creator" });
            void openVideoPath(row.file.path);
          },
        },
        { kind: "separator" },
        {
          kind: "item",
          label: `${isPriority ? "✓ " : "    "}Priority for profile creation${multiSuffix}`,
          onClick: () => applyFlagToAll("priorityForProfile", !isPriority),
        },
        {
          kind: "item",
          label: `${isClean ? "✓ " : "    "}No profile necessary${multiSuffix}`,
          onClick: () => applyFlagToAll("noProfileNecessary", !isClean),
        },
        {
          kind: "item",
          label: `${isNff ? "✓ " : "    "}Non-family-friendly${multiSuffix}`,
          onClick: () => applyFlagToAll("nonFamilyFriendly", !isNff),
        },
        { kind: "separator" },
        {
          kind: "item",
          label:
            (row.file.watched ? "Mark as unwatched (reset progress)" : "Mark as watched") +
            multiSuffix,
          onClick: () => {
            const shouldMarkWatched = !row.file.watched;
            void Promise.all(
              targetFileIds.map((fid) =>
                shouldMarkWatched
                  ? libraryIpc.markWatched(fid)
                  : libraryIpc.resetProgress(fid),
              ),
            ).then(refreshItems);
          },
        },
        {
          kind: "item",
          label: `Reset watch progress${multiSuffix}`,
          disabled:
            !isMulti && row.file.watch_progress_ms === 0 && !row.file.watched,
          onClick: () => {
            void Promise.all(
              targetFileIds.map((fid) => libraryIpc.resetProgress(fid)),
            ).then(refreshItems);
          },
        },
        ...(targets.some((t) => t.file.drift_warning)
          ? [
              { kind: "separator" as const },
              {
                kind: "item" as const,
                label: `Dismiss drift warning${isMulti ? ` for ${targets.filter((t) => t.file.drift_warning).length} item(s)` : " (I've re-verified)"}`,
                onClick: () => {
                  void Promise.all(
                    targets
                      .filter((t) => t.file.drift_warning)
                      .map((t) => libraryIpc.clearDriftWarning(t.file.id)),
                  ).then(refreshItems);
                },
              },
            ]
          : []),
        { kind: "separator" },
        {
          kind: "item",
          label: `Refresh metadata from TMDb${multiSuffix}`,
          onClick: () => {
            actlog(
              "menu",
              `refresh-metadata count=${targetIdentityIds.length}`,
            );
            void refreshManyMetadata(targetIdentityIds);
          },
        },
        {
          kind: "item",
          label: "Replace metadata from TMDb…",
          disabled: isMulti,
          title: isMulti
            ? singleOnlyTitle
            : "Search TMDb and manually pick the right movie",
          onClick: () => {
            actlog(
              "menu",
              `open TMDb-picker identity_id=${row.identity.id}`,
            );
            setTmdbPicker({
              identityId: row.identity.id,
              query:
                row.identity.movie_title ??
                row.file.path.split(/[\\/]/).pop() ??
                "",
            });
          },
        },
        ...(FEATURE_GOOGLE_POSTER_SEARCH &&
        useAppStore.getState().googleCseApiKey &&
        useAppStore.getState().googleCseId
          ? [
              {
                kind: "item" as const,
                label: "Find alt poster on Google…",
                disabled: isMulti,
                title: isMulti
                  ? singleOnlyTitle
                  : "Search Google for poster art and pick one to use as a custom thumbnail (uses your configured API key)",
                onClick: () => {
                  actlog(
                    "menu",
                    `google-poster identity_id=${row.identity.id}`,
                  );
                  setGooglePosterFor(row);
                },
              },
            ]
          : []),
        { kind: "separator" },
        {
          kind: "item",
          label: isMulti
            ? `Add ${N} selected to collection…`
            : "Add to collection…",
          onClick: () => {
            setAddToGroup({
              kind: "collection",
              identityIds: targetIdentityIds,
            });
          },
        },
        {
          kind: "item",
          label: isMulti ? `Add ${N} selected to series…` : "Add to series…",
          onClick: () => {
            setAddToGroup({ kind: "series", identityIds: targetIdentityIds });
          },
        },
        ...(row.series == null
          ? [
              {
                kind: "item" as const,
                label: "Auto-find others in this series…",
                disabled: isMulti,
                title: isMulti
                  ? singleOnlyTitle
                  : "Look for other movies in the same folder (or matching the same pattern) and propose grouping them as a series.",
                onClick: () => {
                  actlog(
                    "menu",
                    `auto-find others for identity_id=${row.identity.id}`,
                  );
                  setAutoFindFor(row);
                },
              },
            ]
          : []),
        ...(selectedFileIds.size === 2 && selectedFileIds.has(row.file.id)
          ? buildTwoFileTransferItems(row, rows, selectedFileIds, refreshItems, showToast)
          : []),
        {
          kind: "item",
          label: row.identity.custom_thumbnail_path
            ? "Change custom thumbnail…"
            : "Upload custom thumbnail…",
          disabled: isMulti,
          title: singleOnlyTitle,
          onClick: () => {
            void (async () => {
              actlog(
                "menu",
                `custom-thumbnail dialog open identity_id=${row.identity.id}`,
              );
              const { open } = await import("@tauri-apps/plugin-dialog");
              const picked = await open({
                multiple: false,
                filters: [
                  { name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] },
                ],
              });
              if (typeof picked !== "string") {
                actlog("menu", "custom-thumbnail dialog cancelled");
                return;
              }
              actlog(
                "menu",
                `custom-thumbnail apply identity_id=${row.identity.id}`,
              );
              await libraryIpc.setCustomThumbnail(row.identity.id, picked);
              await refreshItems();
              showToast("Custom thumbnail set.", "info", 2000);
            })();
          },
        },
        ...(row.identity.custom_thumbnail_path
          ? [
              {
                kind: "item" as const,
                label: "Clear custom thumbnail",
                disabled: isMulti,
                title: singleOnlyTitle,
                onClick: () => {
                  actlog(
                    "menu",
                    `custom-thumbnail clear identity_id=${row.identity.id}`,
                  );
                  void libraryIpc
                    .setCustomThumbnail(row.identity.id, null)
                    .then(refreshItems);
                },
              },
            ]
          : []),
        ...(activeScope.kind !== "all" && activeScope.id != null
          ? buildReorderMenuItems(
              row,
              activeScope.kind,
              activeScope.id,
              filteredRows,
              refreshItems,
              showToast,
            )
          : []),
        { kind: "separator" },
        {
          kind: "item",
          label: "Show in Explorer",
          disabled: isMulti,
          title: singleOnlyTitle,
          onClick: () => {
            // Show toast immediately — Windows Explorer can take a
            // beat to open on first hit of a network share, and silent
            // delays read as "did anything happen?"
            showToast("Opening in Explorer…", "info", 1500);
            void libraryIpc.revealInExplorer(row.file.path).catch((err) => {
              showToast(`Couldn't open: ${err}`, "error");
            });
          },
        },
        { kind: "separator" },
        {
          kind: "item",
          label: isMulti ? `Delete ${N} selected…` : "Delete…",
          onClick: () => {
            actlog(
              "menu",
              `delete prompt ${targets.length} item${targets.length === 1 ? "" : "s"}`,
            );
            setDeletePrompt(targets);
          },
        },
        {
          kind: "item",
          label: "Search FVP website for this profile",
          title: "Stub — Hub integration ships in Chapter 2",
          onClick: () => {
            showToast(
              "FVP website integration coming soon (Chapter 2).",
              "info",
              3500,
            );
          },
        },
      ];
    },
    [handlePlay, refreshItems, selectedFileIds, showToast, activeScope, filteredRows, rows, refreshManyMetadata],
  );

  // Add all the videos under a chosen directory (recursively) to the
  // currently-active collection / series. Used by the empty-state CTA
  // and the right-click "Add folder" menu. Files NOT yet in the library
  // get inserted via add_folder so they end up indexed under the same
  // watched-folder rules.
  const addFolderToActiveScope = useCallback(async () => {
    if (activeScope.kind === "all" || activeScope.id == null) return;
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      // Make sure the folder is indexed first so the videos inside it
      // become identities we can wire to the collection/series.
      try {
        await libraryIpc.addFolder(picked, true);
        showToast(
          `Indexing ${picked} — will add to ${activeScope.kind} when ready.`,
          "info",
          3500,
        );
      } catch {
        // Already a watched folder — fine; rows for those files already exist.
      }
      // Pull the fresh row list + filter to identities under `picked`.
      const fresh = await libraryIpc.listItems();
      const norm = picked.replace(/\\/g, "/").toLowerCase();
      const identityIds = Array.from(
        new Set(
          fresh
            .filter((r) =>
              r.file.path
                .replace(/\\/g, "/")
                .toLowerCase()
                .startsWith(norm),
            )
            .map((r) => r.identity.id),
        ),
      );
      if (identityIds.length === 0) {
        showToast(
          "No videos found in that folder yet — try again after scanning completes.",
          "warn",
          4000,
        );
        return;
      }
      if (activeScope.kind === "collection") {
        await libraryIpc.addToCollection(activeScope.id, identityIds);
      } else {
        await libraryIpc.addToSeries(activeScope.id, identityIds);
      }
      showToast(
        `Added ${identityIds.length} movie${identityIds.length === 1 ? "" : "s"} to "${activeScope.name}"`,
        "info",
        3000,
      );
      void refreshItems();
    } catch (err) {
      showToast(`Add folder failed: ${err}`, "error");
    }
  }, [activeScope, refreshItems, showToast]);

  // Right-click menu shown on the empty/background area of a scoped
  // view (Collection or Series with no items). Mirrors the sidebar
  // right-click menu but without "rename".
  const buildEmptyScopeMenu = useCallback((): MenuItem[] => {
    if (activeScope.kind === "all" || activeScope.id == null) return [];
    const kind = activeScope.kind;
    return [
      {
        kind: "item",
        label: "Add files…",
        onClick: () => {
          void (async () => {
            const picked = await open({
              multiple: true,
              filters: [
                {
                  name: "Video",
                  extensions: [
                    "mkv", "mp4", "avi", "mov", "m4v", "webm",
                    "wmv", "flv", "mpg", "mpeg", "ts", "m2ts",
                  ],
                },
              ],
            });
            const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
            if (paths.length === 0) return;
            // Match library rows by path; only known files can be added.
            const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
            const wanted = new Set(paths.map(norm));
            const matching = Array.from(
              new Set(
                rows
                  .filter((r) => wanted.has(norm(r.file.path)))
                  .map((r) => r.identity.id),
              ),
            );
            if (matching.length === 0) {
              showToast(
                "Pick files already indexed in your library. To add new files first, add the folder via Settings.",
                "warn",
                5000,
              );
              return;
            }
            const id = activeScope.id!;
            if (kind === "collection") {
              await libraryIpc.addToCollection(id, matching);
            } else {
              await libraryIpc.addToSeries(id, matching);
            }
            showToast(
              `Added ${matching.length} movie${matching.length === 1 ? "" : "s"} to "${activeScope.name}"`,
              "info",
              3000,
            );
            void refreshItems();
          })();
        },
      },
      {
        kind: "item",
        label: "Add folder & subfolders…",
        onClick: () => void addFolderToActiveScope(),
      },
    ];
  }, [activeScope, rows, refreshItems, showToast, addFolderToActiveScope]);

  const buildHeaderMenu = useCallback((): MenuItem[] => {
    const visibleSet = new Set(prefs.visibleColumns);
    return ALL_COLUMNS.map((c) => ({
      kind: "item" as const,
      label: `${visibleSet.has(c.id) ? "✓ " : "    "}${c.label}`,
      onClick: () => {
        setPrefs((p) => {
          const isOn = p.visibleColumns.includes(c.id);
          const next: ColumnId[] = isOn
            ? p.visibleColumns.filter((x) => x !== c.id)
            : [...p.visibleColumns, c.id];
          return { ...p, visibleColumns: next };
        });
      },
    }));
  }, [prefs.visibleColumns]);

  // pickFolder used to live here; folder management moved to Settings →
  // Library. The header's folder-plus icon now opens Settings.

  if (shouldLock) {
    return (
      <div className="h-full bg-fvp-bg text-fvp-text flex flex-col">
        <LibraryLockoutOverlay onResolved={() => void refreshItems()} />
      </div>
    );
  }

  return (
    <div className="h-full bg-fvp-bg text-fvp-text flex flex-col">
      <LibraryNetworkingBanner />
      <header className="px-4 py-2 border-b border-fvp-border bg-fvp-surface flex items-center gap-2 flex-wrap text-xs">
        <h2 className="text-sm font-semibold mr-2">Library</h2>
        <button
          onClick={() => useAppStore.setState({ mode: "settings" })}
          className="px-2 py-1 text-fvp-muted hover:text-fvp-text rounded cursor-pointer"
          title="Manage watched library folders (opens Settings → Library)"
          aria-label="Add or manage watched folders"
        >
          {/* Folder + plus icon */}
          <svg
            viewBox="0 0 20 20"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M2 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z" />
            <path d="M10 9v5M7.5 11.5h5" />
          </svg>
        </button>
        <button
          onClick={() => {
            void libraryIpc.rescanAll().then(() =>
              showToast("Rescan queued", "info", 1500),
            );
          }}
          className="px-2 py-1 text-fvp-muted hover:text-fvp-text rounded cursor-pointer"
          title="Rescan every watched folder"
          aria-label="Rescan all"
        >
          {/* Circular arrow icon */}
          <svg
            viewBox="0 0 20 20"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 10a7 7 0 0 1 12-4.95L17 7" />
            <path d="M17 3v4h-4" />
            <path d="M17 10a7 7 0 0 1-12 4.95L3 13" />
            <path d="M3 17v-4h4" />
          </svg>
        </button>
        {/* Family Mode toggle. Always visible. PIN required to flip
            OFF once enabled — PIN setup is in Settings. Clicking when
            no PIN configured surfaces the explainer modal. */}
        <button
          onClick={() => {
            if (!librarySettings?.has_pin) {
              setFamilyExplainerOpen(true);
              return;
            }
            if (!familyViewOn) {
              void libraryIpc
                .setFamilyViewEnabled(true)
                .then(reloadSettings)
                .catch((err) => showToast(`${err}`, "error"));
            } else {
              setPinPrompt({
                reason: "Family Mode is on. Enter the PIN to turn it off.",
                onSuccess: () => {
                  void libraryIpc
                    .setFamilyViewEnabled(false)
                    .then(reloadSettings)
                    .catch((err) => showToast(`${err}`, "error"));
                },
              });
            }
          }}
          className={
            "px-2 py-1 rounded cursor-pointer border " +
            (familyViewOn
              ? "bg-fvp-ok/20 border-fvp-ok text-fvp-ok"
              : "border-fvp-border text-fvp-muted hover:text-fvp-text")
          }
          title={
            familyViewOn
              ? "Family Mode ON — non-family-friendly titles hidden. PIN required to disable."
              : librarySettings?.has_pin
                ? "Turn Family Mode on (hides non-family-friendly titles; PIN required to turn off)"
                : "Family Mode — click to learn how to set up"
          }
          aria-label="Family Mode"
        >
          {familyViewOn ? "🛡 Family Mode" : "🛡"}
        </button>
        <button
          onClick={() => {
            actlog("header", "open Roulette");
            setRouletteOpen(true);
          }}
          disabled={rows.length === 0}
          className="px-2 py-1 text-fvp-text hover:bg-fvp-surface2 rounded cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          title="Movie Roulette — random pick from the (selected or full) library"
        >
          🎬 Roulette
        </button>
        {/* The "review pairs" alert badge was removed — duplicated
            the Tools → "Look for upgrades" surface. Run that menu
            item explicitly when you want to review possible-same-
            movie pairs. */}
        <LibraryToolsMenu
          onRunDuplicates={() => {
            actlog("tools", "run duplicates scan");
            void (async () => {
              try {
                const clusters = await libraryIpc.findDuplicates();
                actlog(
                  "tools",
                  `duplicates result: ${clusters.length} cluster${clusters.length === 1 ? "" : "s"}`,
                );
                setDuplicateClusters(clusters);
              } catch (err) {
                showToast(`Duplicate scan failed: ${err}`, "error");
              }
            })();
          }}
          onRunUpgrades={() => {
            actlog("tools", "run upgrades scan");
            void (async () => {
              try {
                const pairs = await libraryIpc.findProbablePairs();
                actlog(
                  "tools",
                  `upgrades result: ${pairs.length} pair${pairs.length === 1 ? "" : "s"}`,
                );
                setProbablePairs(pairs);
                if (pairs.length === 0) {
                  showToast("No upgrade candidates found.", "info", 2500);
                } else {
                  setActivePairIdx(0);
                }
              } catch (err) {
                showToast(`Upgrade scan failed: ${err}`, "error");
              }
            })();
          }}
          onOpenAnalytics={() => {
            actlog("tools", "open analytics");
            setAnalyticsOpen(true);
          }}
          onOpenDetectSeries={() => {
            actlog("tools", "open detect-series");
            setAutoSeriesOpen(true);
          }}
          onRunPossibleDuplicates={() => {
            actlog("tools", "run possible-duplicates scan");
            void (async () => {
              try {
                const pairs = await libraryIpc.findPossibleDuplicates();
                actlog(
                  "tools",
                  `possible-duplicates result: ${pairs.length} pair${pairs.length === 1 ? "" : "s"}`,
                );
                setPossibleDupPairs(pairs);
              } catch (err) {
                showToast(`Possible-duplicate scan failed: ${err}`, "error");
              }
            })();
          }}
          onRunFullMetadataRefresh={() => {
            actlog("tools", "run full metadata refresh");
            const posterTargets = Array.from(
              new Set(
                rows
                  .filter(
                    (r) =>
                      !r.identity.poster_local_path &&
                      !r.identity.custom_thumbnail_path &&
                      !r.file.is_missing,
                  )
                  .map((r) => r.identity.id),
              ),
            );
            const probeTargets = rows
              .filter((r) => {
                if (r.file.is_missing) return false;
                const res = r.file.resolution?.trim() ?? "";
                const needRes = res === "" || !res.includes("x");
                const needDur = r.identity.duration_ms <= 0;
                return needRes || needDur;
              })
              .map((r) => r.file.id);
            if (posterTargets.length === 0 && probeTargets.length === 0) {
              showToast(
                "Every item already has a poster, runtime, and resolution — nothing to do.",
                "info",
                3500,
              );
              return;
            }
            const summary: string[] = [];
            if (posterTargets.length > 0) {
              summary.push(
                `${posterTargets.length} item${posterTargets.length === 1 ? "" : "s"} for TMDb metadata refresh (posters / title / cast / etc.)`,
              );
            }
            if (probeTargets.length > 0) {
              summary.push(
                `${probeTargets.length} file${probeTargets.length === 1 ? "" : "s"} for technical probe (missing runtime or resolution)`,
              );
            }
            if (
              !window.confirm(
                `Full Metadata Refresh will queue:\n\n• ${summary.join("\n• ")}\n\nBoth pass through one-at-a-time throttles. Progress shows at the bottom. You can keep using the app while it runs.`,
              )
            )
              return;
            // Seed the bottom-right summary badge immediately so the
            // user knows the tool fired. The two backfill helpers
            // update poster / probe counts as they finish.
            useAppStore.getState().setFmrSummary({
              ranAtMs: Date.now(),
              posterTotal: posterTargets.length,
              posterCompleted: 0,
              probeTotal: probeTargets.length,
              probeFilled: 0,
            });
            if (posterTargets.length > 0) {
              void refreshManyMetadata(posterTargets).then((result) => {
                const cur = useAppStore.getState().fmrSummary;
                if (!cur) return;
                useAppStore
                  .getState()
                  .setFmrSummary({ ...cur, posterCompleted: result.completed });
              });
            }
            if (probeTargets.length > 0) {
              void runProbeBackfill(probeTargets).then((result) => {
                const cur = useAppStore.getState().fmrSummary;
                if (!cur) return;
                useAppStore
                  .getState()
                  .setFmrSummary({ ...cur, probeFilled: result.filled });
              });
            }
          }}
        />
        <Divider />
        <ViewModeToggle
          mode={prefs.viewMode}
          onChange={(m) => setPrefs((p) => ({ ...p, viewMode: m }))}
        />
        {/* Old "Family View" button removed — folded into the header
            icon between Rescan and Roulette so it's always visible. */}
        <div className="ml-auto flex items-center gap-3">
          {scanProgress && (
            <ScanProgressBadge progress={scanProgress} />
          )}
          <span className="text-[11px] text-fvp-muted tabular-nums" title={clock.toDateString()}>
            {formatClock(clock, prefs.use24hClock)}
          </span>
        </div>
      </header>

      <DriftBanner rows={rows} onRefresh={refreshItems} />

      <div className="flex-1 flex min-h-0">
        <div className="w-56 shrink-0 flex flex-col border-r border-fvp-border overflow-y-auto">
          <LibrarySuggestionRail
            refreshToken={listRefreshToken}
            familyViewOn={familyViewOn}
          />
          <CollectionsSeriesPanel
            refreshToken={listRefreshToken}
            activeScope={activeScope}
            onScopeChange={(s) => {
              // Diagnostic: log scope + member count so we can see at
              // a glance which identities the new scope thinks belong
              // to it. Catches "I scoped into series 25, why does it
              // show Transformers?" — the log will show whether the
              // backend actually thinks Transformers is in series 25.
              let memberCount = 0;
              let memberIds: number[] = [];
              if (s.kind === "series" && s.id != null) {
                const members = rows.filter(
                  (r) => r.series?.series_id === s.id,
                );
                memberCount = members.length;
                memberIds = members.map((r) => r.identity.id);
              } else if (s.kind === "collection" && s.id != null) {
                const members = rows.filter((r) =>
                  r.collections.some((c) => c.collection_id === s.id),
                );
                memberCount = members.length;
                memberIds = members.map((r) => r.identity.id);
              }
              actlog(
                "library",
                `scope-change → kind=${s.kind} id=${s.id ?? "null"} name="${s.name ?? ""}" member_count=${memberCount}` +
                  (memberIds.length > 0 && memberIds.length <= 30
                    ? ` identity_ids=[${memberIds.join(",")}]`
                    : ""),
              );
              setFiltersExpanded(false);
              setActiveScope(s);
            }}
            rows={rows}
            onMembershipChanged={refreshItems}
            familyViewOn={familyViewOn}
            onRescanLibrary={() => {
              void libraryIpc.rescanAll().then(() =>
                showToast("Rescan queued", "info", 1500),
              );
            }}
            onRemoveBrokenLinks={() => {
              const brokenCount = rows.filter((r) => r.file.is_missing).length;
              if (brokenCount === 0) {
                showToast("No broken links to remove.", "info", 2500);
                return;
              }
              if (
                !window.confirm(
                  `Remove ${brokenCount} broken library entr${brokenCount === 1 ? "y" : "ies"} (files that no longer exist on disk)?\n\nNothing is deleted from disk — this only drops the library rows.`,
                )
              )
                return;
              void libraryIpc
                .removeBrokenLinks()
                .then((n) => {
                  showToast(
                    `Removed ${n} broken link${n === 1 ? "" : "s"}.`,
                    "info",
                    3000,
                  );
                  void refreshItems();
                })
                .catch((err) =>
                  showToast(`Remove broken links failed: ${err}`, "error"),
                );
            }}
            onOpenAnalytics={() => setAnalyticsOpen(true)}
            onOpenFvpWebsite={() => {
              void import("../utils/openExternalUrl").then((m) =>
                m.openExternalUrl("https://freedomvideoplayer.com", {
                  trustedHostSuffixes: ["freedomvideoplayer.com"],
                }),
              );
            }}
            onRefreshScopeMetadata={(kind, id) => {
              const memberRows = rows.filter((r) => {
                if (kind === "collection") {
                  return r.collections.some((c) => c.collection_id === id);
                }
                return r.series?.series_id === id;
              });
              const identityIds = Array.from(
                new Set(memberRows.map((r) => r.identity.id)),
              );
              if (identityIds.length === 0) {
                showToast(
                  "No members to refresh in this scope.",
                  "warn",
                  3000,
                );
                return;
              }
              actlog(
                "scope-refresh",
                `kind=${kind} id=${id} count=${identityIds.length}`,
              );
              void refreshManyMetadata(identityIds);
            }}
            onRescanScope={(kind, id) => {
              // Resolve the unique set of watched-folder roots that own
              // a member identity, then re-enqueue each. The orchestrator
              // serializes them.
              const memberRows = rows.filter((r) => {
                if (kind === "collection") {
                  return r.collections.some((c) => c.collection_id === id);
                }
                return r.series?.series_id === id;
              });
              const folderIds = Array.from(
                new Set(memberRows.map((r) => r.file.watched_folder_id)),
              );
              if (folderIds.length === 0) {
                showToast(
                  "No watched folders to rescan for this scope.",
                  "warn",
                  3000,
                );
                return;
              }
              void Promise.all(
                folderIds.map((fid) => libraryIpc.rescanFolder(fid)),
              )
                .then(() =>
                  showToast(
                    `Rescan queued for ${folderIds.length} folder${folderIds.length === 1 ? "" : "s"}.`,
                    "info",
                    2500,
                  ),
                )
                .catch((err) =>
                  showToast(`Rescan failed: ${err}`, "error", 4000),
                );
            }}
          />
          <div className="flex-1 min-h-0">
            <LibraryFilters
              rows={rows}
              filters={filters}
              onChange={setFilters}
              expanded={filtersExpanded}
              onToggle={() => setFiltersExpanded((v) => !v)}
            />
          </div>
        </div>

        <main
          className="flex-1 min-w-0 overflow-hidden bg-fvp-bg flex flex-col"
          onContextMenu={(e) => {
            // Right-click on empty area of a scoped view → open the
            // scope's "add to this collection/series" menu.
            if (
              filteredRows.length === 0 &&
              activeScope.kind !== "all" &&
              activeScope.id !== null
            ) {
              e.preventDefault();
              setContextMenu({
                x: e.clientX,
                y: e.clientY,
                items: buildEmptyScopeMenu(),
              });
            }
          }}
        >
          {activeScope.kind !== "all" && (
            <ScopeIndicator scope={activeScope} count={filteredRows.length} />
          )}
          {activeScope.kind === "series" && activeScope.id != null && (
            <SeriesScopeBar
              seriesId={activeScope.id}
              seriesName={activeScope.name ?? "Series"}
              filteredRows={filteredRows}
              onChanged={refreshItems}
              onOpenSeasonsModal={() =>
                setAutoSeasonsOpen({
                  seriesId: activeScope.id!,
                  seriesName: activeScope.name ?? "Series",
                })
              }
              seasonGroups={seasonLayout.active ? seasonLayout.groups : undefined}
              onJumpToRow={(idx) => {
                actlog("series", `jump to row idx=${idx}`);
                setJumpToRowIndex({ idx, n: jumpToRowIndex.n + 1 });
              }}
            />
          )}
          {!initialLoadComplete ? (
            <LibraryLoadingState />
          ) : folders.length === 0 ? (
            <EmptyState
              title="No watched folders yet"
              message="Add a folder in Settings → Library to start indexing your collection."
              actionLabel="Open Library settings"
              onAction={() => useAppStore.setState({ mode: "settings" })}
            />
          ) : filteredRows.length === 0 ? (
            // Context-aware empty state. Empty collection/series gets a
            // useful "add a folder" CTA; filter-mismatch gets a "clear
            // filters" hint.
            activeScope.kind !== "all" ? (
              <EmptyState
                title={`No media in ${activeScope.kind === "collection" ? "this collection" : "this series"} yet`}
                message="Right-click here, or use the button below, to add files or a folder."
                actionLabel="Add folder to this group…"
                onAction={() => void addFolderToActiveScope()}
              />
            ) : (
              <EmptyState
                title="No items match the current filters"
                message="Try clearing one or more filters in the sidebar."
              />
            )
          ) : prefs.viewMode === "thumbnail" ? (
            <div className="flex-1 min-h-0">
              <LibraryThumbnailView
                rows={maskedFilteredRows}
                selectedFileIds={selectedFileIds}
                primarySelectedId={primarySelectedId}
                refreshingIdentityIds={refreshingIdentityIds}
                episodeLabels={seasonLayout.active ? seasonLayout.labels : undefined}
                seasonGroups={seasonLayout.active ? seasonLayout.groups : undefined}
                jumpToRowIndex={jumpToRowIndex}
                reorderMode={
                  activeScope.kind === "collection"
                    ? "collection"
                    : activeScope.kind === "series"
                      ? "series-numbered"
                      : null
                }
                onReorderRows={(orderedIds) => {
                  if (
                    activeScope.kind === "collection" &&
                    activeScope.id != null
                  ) {
                    void libraryIpc
                      .reorderCollectionItems(activeScope.id, orderedIds)
                      .then(() => void refreshItems())
                      .catch((err) =>
                        showToast(`Reorder failed: ${err}`, "error"),
                      );
                  } else if (
                    activeScope.kind === "series" &&
                    activeScope.id != null
                  ) {
                    void libraryIpc
                      .reorderSeriesItems(activeScope.id, orderedIds)
                      .then(() => void refreshItems())
                      .catch((err) =>
                        showToast(`Reorder failed: ${err}`, "error"),
                      );
                  }
                }}
                onPick={handlePick}
                onPlay={handlePlay}
                onContextMenu={(row, x, y) =>
                  setContextMenu({ x, y, items: buildItemMenu(row) })
                }
                onRefreshMetadata={(row) => {
                  actlog(
                    "thumb-view",
                    `refresh-metadata badge identity_id=${row.identity.id}`,
                  );
                  void refreshManyMetadata([row.identity.id]);
                }}
              />
            </div>
          ) : (
            <div className="flex-1 min-h-0">
              <LibraryColumnView
                rows={maskedFilteredRows}
                selectedFileIds={selectedFileIds}
                primarySelectedId={primarySelectedId}
                refreshingIdentityIds={refreshingIdentityIds}
                episodeLabels={seasonLayout.active ? seasonLayout.labels : undefined}
                seasonGroups={seasonLayout.active ? seasonLayout.groups : undefined}
                jumpToRowIndex={jumpToRowIndex}
                visibleColumns={prefs.visibleColumns}
                columnWidths={prefs.columnWidths}
                sortBy={prefs.sortBy}
                // Inside a series or collection scope the parent already
                // sorts by user-controlled membership.position (which
                // backs drag-reorder), so the column view must NOT
                // re-sort by column. Outside scopes, column sort is the
                // source of truth.
                respectIncomingOrder={
                  activeScope.kind === "series" ||
                  activeScope.kind === "collection"
                }
                // Show drag-handle (+ # column for series) when scoped
                // into a collection or series, and wire reorder so the
                // user can drag rows to change their position. Backend
                // reorderCollectionItems / reorderSeriesItems take a
                // full ordered identity-id list and overwrite the
                // sort_position column atomically.
                reorderMode={
                  activeScope.kind === "collection"
                    ? "collection"
                    : activeScope.kind === "series"
                      ? "series-numbered"
                      : null
                }
                onReorderRows={(orderedIds) => {
                  if (
                    activeScope.kind === "collection" &&
                    activeScope.id != null
                  ) {
                    void libraryIpc
                      .reorderCollectionItems(activeScope.id, orderedIds)
                      .then(() => void refreshItems())
                      .catch((err) =>
                        showToast(`Reorder failed: ${err}`, "error"),
                      );
                  } else if (
                    activeScope.kind === "series" &&
                    activeScope.id != null
                  ) {
                    void libraryIpc
                      .reorderSeriesItems(activeScope.id, orderedIds)
                      .then(() => void refreshItems())
                      .catch((err) =>
                        showToast(`Reorder failed: ${err}`, "error"),
                      );
                  }
                }}
                onSortByChange={(sortBy) => setPrefs((p) => ({ ...p, sortBy }))}
                onColumnWidthChange={(id, width) =>
                  setPrefs((p) => ({
                    ...p,
                    columnWidths: { ...p.columnWidths, [id]: width },
                  }))
                }
                onColumnReorder={(visibleColumns) =>
                  setPrefs((p) => ({ ...p, visibleColumns }))
                }
                onPick={handlePick}
                onPlay={handlePlay}
                onContextMenu={(row, x, y) =>
                  setContextMenu({ x, y, items: buildItemMenu(row) })
                }
                onHeaderContextMenu={(x, y) =>
                  setContextMenu({ x, y, items: buildHeaderMenu() })
                }
              />
            </div>
          )}
        </main>

        <LibraryDetailsPanel
          row={primaryRow}
          selectedRows={maskedFilteredRows.filter((r) =>
            selectedFileIds.has(r.file.id),
          )}
          onRefreshList={() => void refreshItems()}
        />
      </div>

      <ProfileCreatorNudge
        totalItems={rows.length}
        profiledItems={rows.filter((r) => r.profile_status === "has_profile").length}
        familyViewOn={familyViewOn}
        refreshToken={listRefreshToken}
      />

      {rouletteOpen && (() => {
        // Pool resolution priority:
        //   1. User has a selection → only those files
        //   2. Active scope is a series or collection → only that
        //      group's members (so spinning inside "Indiana Jones"
        //      can't surprise the user with The Terminator)
        //   3. Fallback: the whole library (already-filtered for the
        //      view, which includes Family Mode masking)
        let poolRows: LibraryRow[];
        if (selectedFileIds.size > 0) {
          poolRows = rows.filter((r) => selectedFileIds.has(r.file.id));
        } else if (
          activeScope.kind === "series" &&
          activeScope.id != null
        ) {
          poolRows = rows.filter(
            (r) => r.series?.series_id === activeScope.id,
          );
        } else if (
          activeScope.kind === "collection" &&
          activeScope.id != null
        ) {
          poolRows = rows.filter((r) =>
            r.collections.some((c) => c.collection_id === activeScope.id),
          );
        } else {
          poolRows = filteredRows;
        }
        const poolFileIds = poolRows.map((r) => r.file.id);
        return (
          <MovieRouletteModal
            fileIds={poolFileIds}
            poolRows={poolRows}
            familyViewOn={familyViewOn}
            onClose={() => setRouletteOpen(false)}
          />
        );
      })()}

      {pinPrompt && (
        <PinPromptModal
          reason={pinPrompt.reason}
          onSuccess={() => {
            const cb = pinPrompt.onSuccess;
            setPinPrompt(null);
            cb();
          }}
          onCancel={() => setPinPrompt(null)}
        />
      )}

      {tmdbPicker && (
        <TmdbReplacePicker
          identityId={tmdbPicker.identityId}
          initialQuery={tmdbPicker.query}
          onResolved={() => {
            setTmdbPicker(null);
            void refreshItems();
          }}
        />
      )}

      {addToGroup && (
        <AddToGroupModal
          kind={addToGroup.kind}
          identityIds={addToGroup.identityIds}
          onResolved={() => {
            setAddToGroup(null);
            void refreshItems();
          }}
        />
      )}

      {deletePrompt && (
        <DeleteConfirmModal
          rows={deletePrompt}
          defaultChoice={librarySettings?.delete_default ?? "remove"}
          onResolved={() => {
            setDeletePrompt(null);
            setSelectedFileIds(new Set());
            setPrimarySelectedId(null);
            void refreshItems();
            void reloadSettings();
          }}
        />
      )}

      {duplicateClusters !== null && (
        <DuplicateCatcherModal
          clusters={duplicateClusters}
          onChanged={refreshItems}
          onClose={() => setDuplicateClusters(null)}
        />
      )}

      {possibleDupPairs !== null && (
        <PossibleDuplicatesModal
          pairs={possibleDupPairs}
          onResolved={refreshItems}
          onClose={() => setPossibleDupPairs(null)}
        />
      )}

      {googlePosterFor && (
        <GooglePosterModal
          row={googlePosterFor}
          onResolved={refreshItems}
          onClose={() => setGooglePosterFor(null)}
        />
      )}
      <FmrSummaryBadge />

      {familyExplainerOpen && (
        <FamilyModeExplainerModal
          onClose={() => setFamilyExplainerOpen(false)}
          onGoToSettings={() => {
            setFamilyExplainerOpen(false);
            useAppStore.setState({ mode: "settings" });
          }}
        />
      )}
      {analyticsOpen && (
        <AnalyticsDashboard
          rows={rows}
          onClose={() => setAnalyticsOpen(false)}
        />
      )}
      {autoSeriesOpen && (
        <AutoDetectSeriesModal
          rows={rows}
          existingSeriesNames={Array.from(
            new Set(
              rows
                .map((r) => r.series?.series_name)
                .filter((n): n is string => !!n),
            ),
          )}
          existingCollectionNames={Array.from(
            new Set(
              rows.flatMap((r) => r.collections.map((c) => c.collection_name)),
            ),
          )}
          onChanged={refreshItems}
          onClose={() => setAutoSeriesOpen(false)}
        />
      )}
      {brokenFileRow && (
        <BrokenFileModal
          row={brokenFileRow}
          onClose={() => setBrokenFileRow(null)}
          onResolved={refreshItems}
        />
      )}
      {autoFindFor && (
        <AutoDetectSeriesModal
          sourceIdentityId={autoFindFor.identity.id}
          /* Seed with rows that share the clicked file's parent folder
             OR its parent's parent (covers the nested Season folders
             case). The modal's own algorithm then proposes a series. */
          rows={(() => {
            const segs = autoFindFor.file.path.split(/[\\/]/);
            const parent = segs.slice(0, -1).join("\\");
            const grandparent = segs.slice(0, -2).join("\\");
            return rows.filter((r) => {
              const p = r.file.path.split(/[\\/]/).slice(0, -1).join("\\");
              const gp = r.file.path
                .split(/[\\/]/)
                .slice(0, -2)
                .join("\\");
              return (
                p === parent ||
                p === grandparent ||
                gp === parent ||
                gp === grandparent
              );
            });
          })()}
          existingSeriesNames={Array.from(
            new Set(
              rows
                .map((r) => r.series?.series_name)
                .filter((n): n is string => !!n),
            ),
          )}
          existingCollectionNames={Array.from(
            new Set(
              rows.flatMap((r) => r.collections.map((c) => c.collection_name)),
            ),
          )}
          onChanged={refreshItems}
          onClose={() => setAutoFindFor(null)}
        />
      )}
      {autoSeasonsOpen && (
        <AutoDetectSeasonsModal
          seriesId={autoSeasonsOpen.seriesId}
          seriesName={autoSeasonsOpen.seriesName}
          rows={filteredRows.filter(
            (r) => r.series?.series_id === autoSeasonsOpen.seriesId,
          )}
          onChanged={refreshItems}
          onClose={() => setAutoSeasonsOpen(null)}
        />
      )}

      {activePairIdx !== null && probablePairs[activePairIdx] && (
        <ReconciliationDialog
          pair={probablePairs[activePairIdx]!}
          onResolved={() => {
            // Pull a fresh list and advance to its first entry. Using
            // the returned `fresh` rather than the closure's stale
            // `probablePairs` reference avoids a bug where the user
            // would get stuck on a single pair (stale length always
            // looked the same → loop never advanced).
            void refreshProbablePairs().then((fresh) => {
              if (!fresh || fresh.length === 0) {
                setActivePairIdx(null);
              } else {
                setActivePairIdx(0);
              }
            });
            void refreshItems();
          }}
          onClose={() => setActivePairIdx(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

function Divider() {
  return <span className="w-px h-5 bg-fvp-border mx-1" />;
}

/**
 * Standardized empty state for the main pane. Optional action button
 * lets the user take the most likely next step right from the message
 * (e.g. "open Settings" when no folders are watched, "add a folder to
 * this series" when the scope is empty).
 */
/**
 * Tools dropdown in the library header. Bundles Duplicates, Look for
 * upgrades, Analytics, and Detect series into one button so the header
 * stays uncluttered. The (!) review badge sits outside the dropdown
 * because it's a high-attention indicator that should always be visible.
 */
function LibraryToolsMenu({
  onRunDuplicates,
  onRunUpgrades,
  onOpenAnalytics,
  onOpenDetectSeries,
  onRunPossibleDuplicates,
  onRunFullMetadataRefresh,
}: {
  onRunDuplicates: () => void;
  onRunUpgrades: () => void;
  onOpenAnalytics: () => void;
  onOpenDetectSeries: () => void;
  onRunPossibleDuplicates: () => void;
  onRunFullMetadataRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Close on Esc + outside-click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-library-tools]")) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    // Use a microtask delay so the click that opened the menu doesn't
    // immediately close it.
    const id = window.setTimeout(
      () => window.addEventListener("click", onClick),
      0,
    );
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(id);
      window.removeEventListener("click", onClick);
    };
  }, [open]);
  const item = (label: string, hint: string, onClick: () => void) => (
    <button
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      className="w-full text-left px-3 py-2 hover:bg-fvp-surface2/60 flex flex-col gap-0.5"
    >
      <span className="text-xs text-fvp-text">{label}</span>
      <span className="text-[10px] text-fvp-muted">{hint}</span>
    </button>
  );
  return (
    <div className="relative" data-library-tools>
      <button
        onClick={() => setOpen((v) => !v)}
        className={
          "px-2 py-1 border border-fvp-border rounded " +
          (open
            ? "bg-fvp-surface2 text-fvp-text"
            : "bg-fvp-surface2/40 text-fvp-text hover:bg-fvp-surface2/70")
        }
        title="Library tools"
      >
        🧰 Tools ▾
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 z-30 w-72 bg-fvp-surface border border-fvp-border rounded shadow-2xl divide-y divide-fvp-border/60"
          onClick={(e) => e.stopPropagation()}
        >
          {item("🧹 Clean duplicates", "Files that share identical content (same strong fingerprint) — review and delete the extra copies", onRunDuplicates)}
          {item("🔎 Find possible duplicates", "Fuzzy match — titles that LOOK like the same movie but aren't byte-identical (different size, slightly different filename). Excludes 3D / Extended variants.", onRunPossibleDuplicates)}
          {item("⬆ Look for upgrades", "Re-scan for likely higher-quality copies of existing titles", onRunUpgrades)}
          {item("📺 Detect series", "Scan folders and propose series groupings", onOpenDetectSeries)}
          {item("↻ Full metadata refresh", "Queue a TMDb refresh for every item without a poster. Backend throttles to one request at a time.", onRunFullMetadataRefresh)}
          {item("📊 Analytics", "Watch patterns by tag, time window, and movie", onOpenAnalytics)}
        </div>
      )}
    </div>
  );
}

/**
 * Loading shimmer for the initial library list fetch. Shown only until
 * the first `library_list_items` call resolves. On fast machines this
 * flashes for ~100 ms (barely visible); on slower machines or large
 * libraries it can stay up several seconds — the spinner + "loading
 * your library" message prevents the user from thinking the library was
 * wiped during what's actually a normal DB join.
 */
function LibraryLoadingState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fvp-muted gap-3">
      <RwbSpinner />
      <div className="text-sm text-fvp-text font-semibold">
        Loading library…
      </div>
    </div>
  );
}

function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
}: {
  title: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-md">
        <div className="text-fvp-text text-base font-semibold mb-1">{title}</div>
        <div className="text-fvp-muted text-xs mb-4 leading-relaxed">
          {message}
        </div>
        {actionLabel && onAction && (
          <button
            onClick={onAction}
            className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90 cursor-pointer"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Header strip shown above the main pane whenever the user has scoped
 * to a specific collection or series. Per directive: collections feel
 * like a playlist, series feel like a single bundled entity. The user
 * navigates BACK by clicking "All Movies" in the sidebar — no explicit
 * "clear scope" button (which read as a filter chip and undercut the
 * "this is its own thing" feel).
 */
function ScopeIndicator({
  scope,
  count,
}: {
  scope: ActiveScope;
  count: number;
}) {
  const kindLabel = scope.kind === "collection" ? "Collection" : "Series";
  return (
    <div className="px-4 py-1.5 bg-fvp-accent/10 border-b border-fvp-accent/40 flex items-center gap-2 text-[11px]">
      <span className="text-fvp-accent font-semibold">{kindLabel}:</span>
      <span className="text-fvp-text">{scope.name}</span>
      <span className="text-fvp-muted">
        ({count} item{count === 1 ? "" : "s"})
      </span>
    </div>
  );
}

/**
 * Profile Drift Sentinel — banner across the top when any indexed file
 * has `drift_warning = 1`. Says "N file(s) changed since their profile
 * was created — re-verify." Click → filters to drift-warning rows.
 * Per the directive this needs to be loud + active, not a quiet badge.
 */
function DriftBanner({
  rows,
  onRefresh,
}: {
  rows: LibraryRow[];
  onRefresh: () => void;
}) {
  const drifted = rows.filter((r) => r.file.drift_warning);
  const showToast = useAppStore((s) => s.showToast);
  const setMode = useAppStore((s) => s.setMode);
  const [expanded, setExpanded] = useState(false);
  if (drifted.length === 0) return null;
  return (
    <div className="bg-fvp-warn/15 border-b-2 border-fvp-warn text-fvp-warn text-xs">
      <div className="px-4 py-2 flex items-center gap-3">
        <WarningTriangle className="w-4 h-4 fill-fvp-warn" />
        <span className="flex-1">
          <strong>
            {drifted.length} file{drifted.length === 1 ? "" : "s"} changed
          </strong>{" "}
          on disk since their <span className="font-mono">.free</span> profile
          was created. Skip / silence timings may now mis-align with the new
          content.
        </span>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="px-2 py-1 text-fvp-warn hover:bg-fvp-warn/20 rounded"
        >
          {expanded ? "Hide list" : `What can I do?`}
        </button>
      </div>
      {expanded && (
        <div className="px-4 pb-3 border-t border-fvp-warn/40 bg-fvp-warn/5">
          <div className="py-2 text-fvp-text/90 leading-relaxed">
            <strong>What this means:</strong> The video file on disk has a
            different size or modification date than when its{" "}
            <span className="font-mono">.free</span> profile was made. The
            file was re-encoded, edited, or replaced — the snip timestamps in
            the profile may now hit the wrong scenes. Watch the file with the
            profile applied; if cuts still land where intended, you can dismiss
            the warning. If cuts are off, open Profile Creator and re-time them.
          </div>
          <div className="max-h-[200px] overflow-y-auto bg-fvp-bg/60 border border-fvp-warn/40 rounded mb-2">
            <table className="w-full text-[11px]">
              <thead className="bg-fvp-bg sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1 text-fvp-muted">Movie</th>
                  <th className="text-left px-2 py-1 text-fvp-muted w-64">
                    Path
                  </th>
                  <th className="text-left px-2 py-1 text-fvp-muted w-44">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {drifted.map((r) => (
                  <tr
                    key={r.file.id}
                    className="border-t border-fvp-border/40 text-fvp-text"
                  >
                    <td className="px-2 py-1 truncate">
                      {r.identity.movie_title ??
                        r.file.path.split(/[\\/]/).pop() ??
                        "?"}
                    </td>
                    <td className="px-2 py-1 truncate font-mono text-[10px] text-fvp-muted">
                      {r.file.path}
                    </td>
                    <td className="px-2 py-1 flex gap-1">
                      <button
                        onClick={() => {
                          setMode("creator");
                          void openVideoPath(r.file.path);
                        }}
                        className="px-1.5 py-0.5 bg-fvp-accent/20 text-fvp-accent text-[10px] rounded hover:bg-fvp-accent/40"
                        title="Open in Profile Creator to re-time the snips"
                      >
                        Re-verify
                      </button>
                      <button
                        onClick={() => {
                          void libraryIpc
                            .revealInExplorer(r.file.path)
                            .catch(() => {});
                        }}
                        className="px-1.5 py-0.5 bg-fvp-bg border border-fvp-border text-fvp-muted text-[10px] rounded hover:text-fvp-text"
                        title="Open the parent folder in Explorer"
                      >
                        📂
                      </button>
                      <button
                        onClick={() => {
                          void libraryIpc
                            .clearDriftWarning(r.file.id)
                            .then(onRefresh)
                            .catch((err) =>
                              showToast(`Clear failed: ${err}`, "error"),
                            );
                        }}
                        className="px-1.5 py-0.5 bg-fvp-bg border border-fvp-border text-fvp-muted text-[10px] rounded hover:text-fvp-text"
                        title="I've checked this one — clear its warning"
                      >
                        ✓
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            onClick={() => {
              Promise.all(
                drifted.map((r) => libraryIpc.clearDriftWarning(r.file.id)),
              )
                .then(() => {
                  onRefresh();
                  showToast("Drift warnings cleared.", "info", 2000);
                  setExpanded(false);
                })
                .catch((err) => showToast(`Clear failed: ${err}`, "error"));
            }}
            className="px-2 py-1 bg-fvp-warn/30 hover:bg-fvp-warn/50 rounded text-fvp-warn text-[11px]"
          >
            I&apos;ve reviewed all — dismiss
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Compact scan-progress badge with an inline spinner + cancel + throttle
 * controls. Shown in the library header whenever the orchestrator is
 * actively scanning a folder. Cancel halts the current scan immediately;
 * Throttle sleeps 30 ms between files (the user can flip it back off if
 * they want full speed again). The badge auto-hides when the scan ends.
 */
function ScanProgressBadge({
  progress,
}: {
  progress: { folder_id: number; scanned: number; total: number };
}) {
  const [throttled, setThrottled] = useState(false);
  const pct =
    progress.total > 0
      ? Math.min(100, Math.round((progress.scanned / progress.total) * 100))
      : 0;
  return (
    <div className="flex items-center gap-2 bg-fvp-surface2/80 border border-fvp-border rounded px-2 py-1">
      <span
        className="inline-block w-2.5 h-2.5 border-2 border-fvp-accent border-t-transparent rounded-full animate-spin"
        aria-hidden
      />
      <span className="text-[11px] text-fvp-text tabular-nums">
        Scanning {progress.scanned}/{progress.total}
      </span>
      <span className="text-[10px] text-fvp-muted tabular-nums">({pct}%)</span>
      <button
        onClick={() => {
          const next = !throttled;
          actlog("scan", `throttle → ${next}`);
          setThrottled(next);
          void libraryIpc.scanThrottle(next);
        }}
        className={
          "text-[10px] px-1.5 py-0.5 rounded border " +
          (throttled
            ? "border-fvp-ok text-fvp-ok bg-fvp-ok/10"
            : "border-fvp-border text-fvp-muted hover:text-fvp-text")
        }
        title={
          throttled
            ? "Throttling on — scan sleeps 30 ms between files. Click to resume full speed."
            : "Slow scan down to reduce disk / network pressure"
        }
      >
        🐢 {throttled ? "Throttled" : "Throttle"}
      </button>
      <button
        onClick={() => {
          actlog("scan", "cancel requested");
          void libraryIpc.scanCancel();
        }}
        className="text-[10px] px-1.5 py-0.5 rounded border border-fvp-err/40 text-fvp-err hover:bg-fvp-err/10"
        title="Stop the current scan immediately"
      >
        ✕ Cancel
      </button>
    </div>
  );
}

/** Themed popup shown when the user clicks the Family Mode icon but
 *  hasn't set up a PIN yet. Explains what Family Mode does and routes
 *  them to Settings to configure one. Brand-consistent with the other
 *  modals (BrokenFileModal, GooglePosterModal, etc.). */
function FamilyModeExplainerModal({
  onClose,
  onGoToSettings,
}: {
  onClose: () => void;
  onGoToSettings: () => void;
}) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);
  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl max-w-md w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-fvp-ok/20 border border-fvp-ok/60 flex items-center justify-center text-fvp-ok text-xl">
            🛡
          </div>
          <div className="text-sm font-semibold text-fvp-text">
            Family Mode — set up a PIN first
          </div>
        </header>
        <div className="px-5 py-4 text-xs text-fvp-text space-y-2">
          <p>
            <strong>Family Mode</strong> hides every movie, collection,
            and series flagged "Non-family-friendly" — kids browsing the
            library only see what's appropriate. Filters, search,
            Roulette, Suggestions, and the per-scope views (All Movies,
            Collections, Series) all respect it.
          </p>
          <p>
            Once turned on, a PIN is required to turn it off. That's the
            only way to make sure Family Mode actually sticks.
          </p>
          <p className="text-fvp-muted">
            You haven't set a PIN yet — without one Family Mode would be
            trivially defeated. Set a 4-digit PIN in Settings → Library
            → Family Mode, then come back here to enable it.
          </p>
        </div>
        <footer className="px-5 py-3 border-t border-fvp-border flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Cancel
          </button>
          <button
            onClick={onGoToSettings}
            className="px-4 py-1.5 text-xs bg-fvp-accent text-white rounded hover:opacity-90"
          >
            Open Settings
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Small warning triangle icon — used everywhere we previously used a
 *  plain "(!)" or "⚠" emoji. Inline SVG so it scales cleanly and we can
 *  re-tint via `fill` classes. */
function WarningTriangle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path d="M12 2 L22 21 L2 21 Z" />
      <path
        d="M12 9 L12 14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
        style={{ stroke: "white" }}
      />
      <circle cx="12" cy="17.5" r="1.3" fill="white" />
    </svg>
  );
}

function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div className="inline-flex border border-fvp-border rounded overflow-hidden">
      <button
        onClick={() => onChange("thumbnail")}
        className={
          "px-2 py-1 " +
          (mode === "thumbnail" ? "bg-fvp-accent text-white" : "text-fvp-muted hover:text-fvp-text")
        }
        title="Thumbnail view"
      >
        ▦
      </button>
      <button
        onClick={() => onChange("column")}
        className={
          "px-2 py-1 " +
          (mode === "column" ? "bg-fvp-accent text-white" : "text-fvp-muted hover:text-fvp-text")
        }
        title="Column view"
      >
        ☰
      </button>
    </div>
  );
}

function formatClock(now: Date, use24h: boolean): string {
  if (use24h) {
    const hh = now.getHours().toString().padStart(2, "0");
    const mm = now.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  }
  let h = now.getHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  const mm = now.getMinutes().toString().padStart(2, "0");
  return `${h}:${mm} ${ampm}`;
}

/**
 * Series scope bar — seasons toggle + auto-detect button. Shown only
 * when the user has scoped into a series. Per directive Phase 7:
 *   - Toggle "Group by seasons" → persists on series.has_seasons
 *   - When toggle on, "Auto-detect seasons" parses S01E03 / 1x03 / 01x03
 *     patterns out of filenames and writes the season number to each
 *     series item. Files that don't match get left at season=null and
 *     fall into an "Ungrouped" bucket the user can hand-edit later.
 */
function SeriesScopeBar({
  seriesId,
  seriesName,
  filteredRows,
  onChanged,
  onOpenSeasonsModal,
  seasonGroups,
  onJumpToRow,
}: {
  seriesId: number;
  seriesName: string;
  filteredRows: LibraryRow[];
  onChanged: () => void | Promise<void>;
  onOpenSeasonsModal: () => void;
  seasonGroups?: { season: number; firstRowIndex: number; count: number }[];
  onJumpToRow?: (rowIndex: number) => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  // The has_seasons flag lives on each row's SeriesMembership. Any row
  // inside this series has the same value, so we read it from the first.
  const hasSeasons =
    filteredRows.find((r) => r.series?.series_id === seriesId)?.series
      ?.has_seasons ?? false;
  const [busy, setBusy] = useState(false);

  const toggleSeasons = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await libraryIpc.setSeriesHasSeasons(seriesId, !hasSeasons);
      await onChanged();
      showToast(
        !hasSeasons
          ? `Seasons enabled for "${seriesName}".`
          : `Seasons disabled for "${seriesName}".`,
        "info",
        2500,
      );
    } catch (err) {
      showToast(`Toggle failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-4 py-1.5 bg-fvp-surface2/60 border-b border-fvp-border flex items-center gap-3 text-[11px]">
      <label className="flex items-center gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          checked={hasSeasons}
          onChange={() => void toggleSeasons()}
          disabled={busy}
          className="accent-fvp-accent"
        />
        <span className="text-fvp-text">Group by seasons</span>
      </label>
      {hasSeasons && (
        <button
          onClick={onOpenSeasonsModal}
          disabled={busy}
          className="px-2 py-0.5 bg-fvp-accent/20 hover:bg-fvp-accent/40 text-fvp-accent rounded text-[10px] disabled:opacity-50"
          title="Walks you through detecting + assigning seasons; also offers TMDb episode naming."
        >
          Auto-detect seasons…
        </button>
      )}
      {hasSeasons && (
        <select
          disabled={!seasonGroups || seasonGroups.length < 2}
          onChange={(e) => {
            const idx = parseInt(e.target.value, 10);
            if (Number.isFinite(idx) && idx >= 0) {
              onJumpToRow?.(idx);
            }
            // Reset to placeholder so the same season can be re-selected.
            e.currentTarget.value = "";
          }}
          defaultValue=""
          className="px-2 py-0.5 bg-fvp-bg border border-fvp-border text-fvp-text rounded text-[10px] disabled:opacity-40"
          title={
            seasonGroups && seasonGroups.length >= 2
              ? "Scroll to the first episode of a season"
              : "Only one season detected — nothing to jump between."
          }
        >
          <option value="" disabled>
            Jump to season…
          </option>
          {(seasonGroups ?? []).map((g) => (
            <option key={g.season} value={g.firstRowIndex}>
              Season {g.season} ({g.count} item{g.count === 1 ? "" : "s"})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * Build a synthetic LibraryRow that represents an entire series in the
 * All Movies view. The numeric ids (file.id, identity.id) are negative
 * to avoid colliding with real rows in any selection set. Calling code
 * recognizes this row via the __synthetic_series field and routes
 * interactions (play, right-click, details panel) to series-level
 * handlers instead of file-level ones.
 *
 * Many display fields (movie_title, poster, watched flag) are copied
 * from the chosen "head" member so the renderer doesn't need to know
 * about the synth shape — it just sees a row whose title is the
 * series name.
 */
function buildSyntheticSeriesRow(
  seriesId: number,
  seriesName: string,
  episodeCount: number,
  watchedCount: number,
  hasSeasons: boolean,
  head: LibraryRow,
): LibraryRow {
  const syntheticFileId = -100_000 - seriesId;
  const syntheticIdentityId = -200_000 - seriesId;
  return {
    file: {
      ...head.file,
      id: syntheticFileId,
      path: `(series:${seriesId})`,
      // Treat the series as "watched" when every episode is watched.
      watched: watchedCount === episodeCount && episodeCount > 0,
      watch_progress_ms: 0,
      drift_warning: false,
    },
    identity: {
      ...head.identity,
      id: syntheticIdentityId,
      movie_title: seriesName,
      // Force the renderer to use the head's poster but with the series
      // name. Year stays from head — useful when a series uses release
      // year in its branding.
    },
    tags: [],
    profile_status: "no_profile_necessary",
    collections: [],
    series: null,
    __synthetic_series: {
      series_id: seriesId,
      series_name: seriesName,
      episode_count: episodeCount,
      watched_count: watchedCount,
      has_seasons: hasSeasons,
    },
  };
}

/**
 * Two-file manual transfer right-click items. When the user has exactly
 * two rows selected, they can transfer curation between them without
 * waiting for the auto-PROBABLE matcher to notice. Both directions are
 * offered so the user picks which one is the keeper.
 *
 * Uses a default "everything except identity" checklist — the user can
 * always run the proper ReconciliationDialog afterward for fine-grained
 * control, but most manual transfers are "this video replaces that one;
 * keep all the tags + collections + .free profile."
 */
function buildTwoFileTransferItems(
  row: LibraryRow,
  rows: LibraryRow[],
  selectedFileIds: Set<number>,
  refreshItems: () => void | Promise<void>,
  showToast: (msg: string, level?: "info" | "warn" | "error", ttl?: number) => void,
): MenuItem[] {
  const other = rows.find(
    (r) => selectedFileIds.has(r.file.id) && r.identity.id !== row.identity.id,
  );
  if (!other) return [];
  const otherTitle =
    other.identity.movie_title ?? other.file.path.split(/[\\/]/).pop() ?? "(other)";
  const doTransfer = (fromId: number, toId: number, fromLabel: string, toLabel: string) => {
    void libraryIpc
      .transferCuration(fromId, toId, {
        tags: true,
        notes: true,
        family_rating: true,
        custom_thumbnail: true,
        non_family_friendly: true,
        priority_for_profile: true,
        no_profile_necessary: true,
        collections: true,
        series_membership: true,
        profile_link: true,
        watch_history: false,
      })
      .then(() => {
        showToast(`Transferred curation from "${fromLabel}" to "${toLabel}".`, "info", 3000);
        return refreshItems();
      })
      .catch((err) => showToast(`Transfer failed: ${err}`, "error"));
  };
  const thisTitle = row.identity.movie_title ?? row.file.path.split(/[\\/]/).pop() ?? "(this)";
  return [
    { kind: "separator" as const },
    {
      kind: "item" as const,
      label: `Transfer curation: this → "${otherTitle}"`,
      title: "Move tags / collections / series / .free link / notes onto the other file. Origin keeps file-level state only.",
      onClick: () =>
        doTransfer(row.identity.id, other.identity.id, thisTitle, otherTitle),
    },
    {
      kind: "item" as const,
      label: `Transfer curation: "${otherTitle}" → this`,
      onClick: () =>
        doTransfer(other.identity.id, row.identity.id, otherTitle, thisTitle),
    },
  ];
}

/**
 * Build the "Move up / Move down / Move to top / Move to bottom" right-click
 * items for a row that's currently being viewed inside a collection or series
 * scope. Per directive: lets the user curate display order without needing a
 * full drag-reorder UI on the virtualized grid.
 */
function buildReorderMenuItems(
  row: LibraryRow,
  scopeKind: "collection" | "series",
  scopeId: number,
  filteredRows: LibraryRow[],
  refreshItems: () => void | Promise<void>,
  showToast: (msg: string, level?: "info" | "warn" | "error", ttl?: number) => void,
): MenuItem[] {
  const orderedIds = filteredRows.map((r) => r.identity.id);
  const here = orderedIds.indexOf(row.identity.id);
  if (here < 0) return [];
  const apply = (ordered: number[]): Promise<void> =>
    scopeKind === "collection"
      ? libraryIpc.reorderCollectionItems(scopeId, ordered)
      : libraryIpc.reorderSeriesItems(scopeId, ordered);
  const move = (toIdx: number) => {
    if (toIdx < 0 || toIdx >= orderedIds.length || toIdx === here) return;
    const next = orderedIds.slice();
    next.splice(here, 1);
    next.splice(toIdx, 0, row.identity.id);
    void apply(next)
      .then(() => void refreshItems())
      .catch((err) => showToast(`Reorder failed: ${err}`, "error"));
  };
  return [
    { kind: "separator" as const },
    {
      kind: "item" as const,
      label: "Move up in this list",
      disabled: here === 0,
      onClick: () => move(here - 1),
    },
    {
      kind: "item" as const,
      label: "Move down in this list",
      disabled: here === orderedIds.length - 1,
      onClick: () => move(here + 1),
    },
    {
      kind: "item" as const,
      label: "Move to top",
      disabled: here === 0,
      onClick: () => move(0),
    },
    {
      kind: "item" as const,
      label: "Move to bottom",
      disabled: here === orderedIds.length - 1,
      onClick: () => move(orderedIds.length - 1),
    },
  ];
}
