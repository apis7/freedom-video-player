import { create } from "zustand";
import type { AppActions, AppState } from "./types";
import type { FreeFile, Snip } from "../ipc/types";
import { DEFAULT_CATEGORIES } from "./categories";

const MAX_LANES = 10;

/** Find the lowest lane index where no existing snip on that lane overlaps the
 *  given time range. Used at snip-creation time so lanes are stable. */
function findLowestFreeLane(
  snips: Snip[],
  snipLanes: Record<string, number>,
  startMs: number,
  endMs: number,
  excludeId?: string,
): number {
  const occupied = new Set<number>();
  for (const s of snips) {
    if (s.id === excludeId) continue;
    if (s.end_ms <= startMs || s.start_ms >= endMs) continue;
    const lane = snipLanes[s.id] ?? 0;
    occupied.add(lane);
  }
  for (let i = 0; i < MAX_LANES; i++) {
    if (!occupied.has(i)) return i;
  }
  return 0; // overflow
}

/** After a snip has been moved/resized, push any OTHER snips that now overlap
 *  it (on the same lane) to a fresh free lane. The actively-edited snip never
 *  moves — passive snips yield. */
function resolveCollisionsFor(
  snips: Snip[],
  snipLanes: Record<string, number>,
  activeId: string,
): Record<string, number> {
  const active = snips.find((s) => s.id === activeId);
  if (!active) return snipLanes;
  const activeLane = snipLanes[activeId] ?? 0;
  let working = { ...snipLanes };

  for (const other of snips) {
    if (other.id === activeId) continue;
    if ((working[other.id] ?? 0) !== activeLane) continue;
    // Overlap test
    if (other.end_ms <= active.start_ms || other.start_ms >= active.end_ms) continue;

    // Find a free lane for `other` that doesn't conflict with anyone else.
    const tempLanes = { ...working };
    delete tempLanes[other.id];
    const newLane = findLowestFreeLane(snips, tempLanes, other.start_ms, other.end_ms, other.id);
    working = { ...working, [other.id]: newLane };
  }
  return working;
}

export const useAppStore = create<AppState & AppActions>((set) => ({
  mode: "player",
  // Library Mode on by default per librrary_directive.md ("By default it's
  // on, but can be disabled in Settings"). Users with no library use case
  // can flip it off; everyone else gets the Library tab automatically.
  libraryEnabled: true,
  thumbnailRefreshEpoch: 0,
  currentFile: null,
  loading: false,
  playing: false,
  fullscreen: false,
  chromeVisible: true,
  cheatsheetVisible: false,
  switcherOpen: false,
  volume: 100,
  muted: false,
  abToggleOn: true,
  streamInfo: null,
  detectedProfiles: [],
  cutTotalText: "—",
  position: 0,
  duration: 0,
  snips: [],
  selectedSnipId: null,
  selectedSnipIds: [],
  activeSnipEdge: null,
  snipLanes: {},
  customCategories: [],
  freezeFrameSrc: null,
  jumpPlayheadOnSnipSelect: false,
  playbackSpeed: 1.0,
  skipThatPendingStartMs: null,
  skipThatTrayActiveAt: null,
  autosaveDraft: true,
  playerShowProfileIcon: false,
  playerShowPathOnStart: false,
  googleCseApiKey: "",
  googleCseId: "",
  fmrSummary: null,
  snipFilterCategory: null,
  toast: null,
  bulkProgress: null,
  openModalCount: 0,
  loadingTimedOut: false,
  autosaveErrorShown: false,
  subtitleTracks: [],
  subtitleVisible: true,
  subtitleEntries: [],
  extractingSubtitles: false,
  aboutVisible: false,
  audioTracks: [],
  videoTracks: [],
  deinterlaceOn: false,
  autoSnipLanguage: "en",
  autoSnipPadBeforeMs: 200,
  autoSnipPadAfterMs: 300,
  audioDevices: [],
  imdbUrl: null,
  groups: [],
  customHotkeys: {},
  timelineView: { startMs: 0, endMs: 0 },
  markers: [],
  flags: [],
  past: [],
  future: [],
  audioOverlayActive: false,
  playDirection: "forward",
  dontShowBeepShortenWarning: false,
  currentFileFingerprint: null,
  safetyBanner: null,
  authorHandle: null,
  authorshipHistory: [],
  aspectRatio: "",
  movieTitle: null,
  movieYear: null,
  mapsFiltered: null,
  mapsUnfiltered: null,
  movieDirector: null,
  movieStars: [],
  moviePlot: null,
  imdbRating: null,
  imdbId: null,
  audioPeaks: null,
  peaksBuilding: false,
  peaksBuildPercent: null,
  lastSavedSnapshot: null,
  unsavedSinceExport: false,
  lastSavedPath: null,

  setMode: (mode) =>
    set((s) => {
      if (s.mode !== mode) {
        console.log(`[fvp] mode → ${mode} (was ${s.mode})`);
      }
      return { mode };
    }),
  setLibraryEnabled: (libraryEnabled) => set({ libraryEnabled }),
  bumpThumbnailRefreshEpoch: () =>
    set((s) => ({ thumbnailRefreshEpoch: s.thumbnailRefreshEpoch + 1 })),
  togglePlay: () => set((s) => ({ playing: !s.playing })),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  toggleFullscreen: () => set((s) => ({ fullscreen: !s.fullscreen })),
  toggleAB: () =>
    set((s) => {
      const next = !s.abToggleOn;
      console.log(`[fvp] AB-toggle → ${next ? "ON (preview/apply)" : "OFF (raw playback)"}`);
      return { abToggleOn: next };
    }),
  setVolume: (volume) => set({ volume, muted: false }),
  setCurrentFile: (currentFile) => set({ currentFile }),
  setCheatsheetVisible: (cheatsheetVisible) => set({ cheatsheetVisible }),
  setSwitcherOpen: (switcherOpen) => set({ switcherOpen }),
  setDetectedProfiles: (detectedProfiles) => set({ detectedProfiles }),
  toggleProfileActive: (path) =>
    set((s) => ({
      detectedProfiles: s.detectedProfiles.map((p) =>
        p.path === path ? { ...p, active: !p.active } : p,
      ),
    })),
  addDetectedProfile: (p) =>
    set((s) => ({
      detectedProfiles: [...s.detectedProfiles, p],
    })),
  addSnip: (snip) =>
    set((s) => {
      const lane = findLowestFreeLane(s.snips, s.snipLanes, snip.start_ms, snip.end_ms);
      return {
        snips: [...s.snips, snip].sort((a, b) => a.start_ms - b.start_ms),
        selectedSnipId: snip.id,
        selectedSnipIds: [snip.id],
        snipLanes: { ...s.snipLanes, [snip.id]: lane },
      };
    }),
  updateSnip: (id, updates) =>
    set((s) => {
      const newSnips = s.snips
        .map((sn) => (sn.id === id ? { ...sn, ...updates } : sn))
        .sort((a, b) => a.start_ms - b.start_ms);
      // Active snip keeps its lane; passive snips that now collide get bumped
      // to the next free lane.
      const newLanes = resolveCollisionsFor(newSnips, s.snipLanes, id);
      return { snips: newSnips, snipLanes: newLanes };
    }),
  removeSnip: (id) =>
    set((s) => {
      const { [id]: _removed, ...rest } = s.snipLanes;
      const usedLanes = Array.from(new Set(Object.values(rest))).sort((a, b) => a - b);
      const remap = new Map<number, number>();
      usedLanes.forEach((oldLane, idx) => remap.set(oldLane, idx));
      const compacted: Record<string, number> = {};
      for (const [snipId, lane] of Object.entries(rest)) {
        compacted[snipId] = remap.get(lane) ?? 0;
      }
      const remainingIds = s.selectedSnipIds.filter((x) => x !== id);
      return {
        snips: s.snips.filter((sn) => sn.id !== id),
        selectedSnipId: s.selectedSnipId === id ? null : s.selectedSnipId,
        selectedSnipIds: remainingIds,
        snipLanes: compacted,
      };
    }),
  removeSnips: (ids) =>
    set((s) => {
      const idSet = new Set(ids);
      const remaining = s.snips.filter((sn) => !idSet.has(sn.id));
      const remainingLanes: Record<string, number> = {};
      for (const sn of remaining) {
        if (s.snipLanes[sn.id] !== undefined) remainingLanes[sn.id] = s.snipLanes[sn.id]!;
      }
      const usedLanes = Array.from(new Set(Object.values(remainingLanes))).sort((a, b) => a - b);
      const remap = new Map<number, number>();
      usedLanes.forEach((oldLane, idx) => remap.set(oldLane, idx));
      const compacted: Record<string, number> = {};
      for (const [snipId, lane] of Object.entries(remainingLanes)) {
        compacted[snipId] = remap.get(lane) ?? 0;
      }
      return {
        snips: remaining,
        selectedSnipId: s.selectedSnipId && idSet.has(s.selectedSnipId) ? null : s.selectedSnipId,
        selectedSnipIds: s.selectedSnipIds.filter((x) => !idSet.has(x)),
        snipLanes: compacted,
      };
    }),
  selectSnip: (id) =>
    set({
      selectedSnipId: id,
      selectedSnipIds: id ? [id] : [],
    }),
  toggleSnipSelection: (id) =>
    set((s) => {
      if (s.selectedSnipIds.includes(id)) {
        const remaining = s.selectedSnipIds.filter((x) => x !== id);
        const newPrimary = remaining[remaining.length - 1] ?? null;
        return { selectedSnipIds: remaining, selectedSnipId: newPrimary };
      }
      return {
        selectedSnipIds: [...s.selectedSnipIds, id],
        selectedSnipId: id,
      };
    }),
  selectSnipRange: (id) =>
    set((s) => {
      if (!s.selectedSnipId) {
        return { selectedSnipIds: [id], selectedSnipId: id };
      }
      // Sort snip ids by start_ms, find anchor + clicked indices, take inclusive range.
      const sortedIds = [...s.snips]
        .sort((a, b) => a.start_ms - b.start_ms)
        .map((sn) => sn.id);
      const i1 = sortedIds.indexOf(s.selectedSnipId);
      const i2 = sortedIds.indexOf(id);
      if (i1 < 0 || i2 < 0) {
        return { selectedSnipIds: [id], selectedSnipId: id };
      }
      const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
      const range = sortedIds.slice(lo, hi + 1);
      return { selectedSnipIds: range, selectedSnipId: id };
    }),
  selectAllSnips: () =>
    set((s) => {
      if (s.snips.length === 0) return s;
      const sortedIds = [...s.snips]
        .sort((a, b) => a.start_ms - b.start_ms)
        .map((sn) => sn.id);
      return {
        selectedSnipIds: sortedIds,
        selectedSnipId: sortedIds[sortedIds.length - 1] ?? null,
      };
    }),
  moveSnipsBy: (ids, dxMs) =>
    set((s) => {
      if (ids.length === 0 || dxMs === 0) return s;
      const idSet = new Set(ids);
      const newSnips = s.snips
        .map((sn) =>
          idSet.has(sn.id)
            ? {
                ...sn,
                start_ms: Math.max(0, Math.round(sn.start_ms + dxMs)),
                end_ms: Math.max(0, Math.round(sn.end_ms + dxMs)),
              }
            : sn,
        )
        .sort((a, b) => a.start_ms - b.start_ms);

      // Bump non-selected snips off lanes occupied by any moved snip they now
      // collide with. Selected snips never bump each other.
      let workingLanes: Record<string, number> = { ...s.snipLanes };
      for (const id of ids) {
        const active = newSnips.find((sn) => sn.id === id);
        if (!active) continue;
        const activeLane = workingLanes[id] ?? 0;
        for (const other of newSnips) {
          if (other.id === id || idSet.has(other.id)) continue;
          if ((workingLanes[other.id] ?? 0) !== activeLane) continue;
          if (other.end_ms <= active.start_ms || other.start_ms >= active.end_ms) continue;
          const tempLanes = { ...workingLanes };
          delete tempLanes[other.id];
          const newLane = findLowestFreeLane(
            newSnips,
            tempLanes,
            other.start_ms,
            other.end_ms,
            other.id,
          );
          workingLanes = { ...workingLanes, [other.id]: newLane };
        }
      }
      return { snips: newSnips, snipLanes: workingLanes };
    }),
  setSnipsBatch: (updates) =>
    set((s) => {
      if (updates.length === 0) return s;
      const idSet = new Set(updates.map((u) => u.id));
      const updateMap = new Map(updates.map((u) => [u.id, u]));
      const newSnips = s.snips
        .map((sn) => {
          const upd = updateMap.get(sn.id);
          return upd ? { ...sn, start_ms: upd.start_ms, end_ms: upd.end_ms } : sn;
        })
        .sort((a, b) => a.start_ms - b.start_ms);

      let workingLanes: Record<string, number> = { ...s.snipLanes };
      for (const upd of updates) {
        const active = newSnips.find((sn) => sn.id === upd.id);
        if (!active) continue;
        const activeLane = workingLanes[upd.id] ?? 0;
        for (const other of newSnips) {
          if (other.id === upd.id || idSet.has(other.id)) continue;
          if ((workingLanes[other.id] ?? 0) !== activeLane) continue;
          if (other.end_ms <= active.start_ms || other.start_ms >= active.end_ms) continue;
          const tempLanes = { ...workingLanes };
          delete tempLanes[other.id];
          const newLane = findLowestFreeLane(
            newSnips,
            tempLanes,
            other.start_ms,
            other.end_ms,
            other.id,
          );
          workingLanes = { ...workingLanes, [other.id]: newLane };
        }
      }
      return { snips: newSnips, snipLanes: workingLanes };
    }),
  duplicateSnips: (ids) => {
    const newIds: string[] = [];
    if (ids.length === 0) return newIds;
    const state = useAppStore.getState();
    const sourceSnips = state.snips.filter((sn) => ids.includes(sn.id));
    if (sourceSnips.length === 0) return newIds;
    set((s) => {
      let working = [...s.snips];
      let workingLanes: Record<string, number> = { ...s.snipLanes };
      let lastId: string | null = null;
      // Clone each source snip with a tiny stagger (so the playhead+duplicate
      // doesn't sit perfectly on top of the original).
      const STAGGER_MS = 500;
      sourceSnips.forEach((src) => {
        const clone: Snip = {
          ...src,
          id: crypto.randomUUID(),
          start_ms: src.start_ms + STAGGER_MS,
          end_ms: src.end_ms + STAGGER_MS,
        };
        newIds.push(clone.id);
        lastId = clone.id;
        const lane = findLowestFreeLane(working, workingLanes, clone.start_ms, clone.end_ms);
        working = [...working, clone];
        workingLanes = { ...workingLanes, [clone.id]: lane };
      });
      working.sort((a, b) => a.start_ms - b.start_ms);
      return {
        snips: working,
        snipLanes: workingLanes,
        selectedSnipIds: newIds,
        selectedSnipId: lastId,
      };
    });
    return newIds;
  },
  clearSnips: () =>
    set({
      snips: [],
      selectedSnipId: null,
      selectedSnipIds: [],
      activeSnipEdge: null,
      snipLanes: {},
    }),
  setActiveSnipEdge: (activeSnipEdge) => set({ activeSnipEdge }),
  setTimelineView: (timelineView) => set({ timelineView }),
  addCustomCategory: (name) =>
    set((s) => {
      const trimmed = name.trim();
      if (!trimmed || s.customCategories.includes(trimmed)) return s;
      return { customCategories: [...s.customCategories, trimmed] };
    }),
  removeCustomCategory: (name) =>
    set((s) => ({ customCategories: s.customCategories.filter((c) => c !== name) })),
  toggleJumpPlayheadOnSnipSelect: () =>
    set((s) => ({ jumpPlayheadOnSnipSelect: !s.jumpPlayheadOnSnipSelect })),
  setAutosaveDraft: (v) => set({ autosaveDraft: v }),
  setPlayerShowProfileIcon: (v) => set({ playerShowProfileIcon: v }),
  setPlayerShowPathOnStart: (v) => set({ playerShowPathOnStart: v }),
  setGoogleCseApiKey: (v) => set({ googleCseApiKey: v }),
  setGoogleCseId: (v) => set({ googleCseId: v }),
  setFmrSummary: (s) => set({ fmrSummary: s }),
  setSnipFilterCategory: (c) => set({ snipFilterCategory: c }),
  showToast: (message, kind = "info", durationMs = 5000) =>
    set({
      toast: {
        id:
          (globalThis.crypto?.randomUUID?.() as string | undefined) ??
          `toast-${Date.now()}`,
        message,
        kind,
        durationMs,
      },
    }),
  dismissToast: () => set({ toast: null }),
  setBulkProgress: (bulkProgress) => set({ bulkProgress }),
  incrementOpenModalCount: () =>
    set((s) => ({ openModalCount: s.openModalCount + 1 })),
  decrementOpenModalCount: () =>
    set((s) => ({ openModalCount: Math.max(0, s.openModalCount - 1) })),

  // ── Skip-That (Player Mode passive profile building) ──
  // All snips dropped via these actions start uncategorized — the Creator
  // shows the "needs review" badge and blocks export until categorized.
  skipThatQuick: (currentMs) => {
    const start = Math.max(0, Math.round(currentMs - 5000));
    const end = Math.round(currentMs + 5000);
    if (end <= start) return;
    const snip: Snip = {
      id: crypto.randomUUID(),
      start_ms: start,
      end_ms: end,
      categories: [],
      action: { type: "skip" },
      group_id: null,
      note: null,
    };
    set((s) => {
      const lane = findLowestFreeLane(s.snips, s.snipLanes, snip.start_ms, snip.end_ms);
      return {
        snips: [...s.snips, snip].sort((a, b) => a.start_ms - b.start_ms),
        snipLanes: { ...s.snipLanes, [snip.id]: lane },
        skipThatTrayActiveAt: Date.now(),
      };
    });
  },
  skipThatBackAnchored: (currentMs) => {
    const start = Math.max(0, Math.round(currentMs - 10000));
    const end = Math.round(currentMs);
    if (end <= start) return;
    const snip: Snip = {
      id: crypto.randomUUID(),
      start_ms: start,
      end_ms: end,
      categories: [],
      action: { type: "skip" },
      group_id: null,
      note: null,
    };
    set((s) => {
      const lane = findLowestFreeLane(s.snips, s.snipLanes, snip.start_ms, snip.end_ms);
      return {
        snips: [...s.snips, snip].sort((a, b) => a.start_ms - b.start_ms),
        snipLanes: { ...s.snipLanes, [snip.id]: lane },
        skipThatTrayActiveAt: Date.now(),
      };
    });
  },
  skipThatOpen: (currentMs) =>
    set({
      skipThatPendingStartMs: Math.max(0, Math.round(currentMs)),
      skipThatTrayActiveAt: Date.now(),
    }),
  skipThatClose: (currentMs) =>
    set((s) => {
      if (s.skipThatPendingStartMs == null) {
        return { skipThatTrayActiveAt: Date.now() };
      }
      const start = s.skipThatPendingStartMs;
      const end = Math.round(currentMs);
      if (end <= start) {
        return { skipThatPendingStartMs: null, skipThatTrayActiveAt: Date.now() };
      }
      const snip: Snip = {
        id: crypto.randomUUID(),
        start_ms: start,
        end_ms: end,
        categories: [],
        action: { type: "skip" },
        group_id: null,
        note: null,
      };
      const lane = findLowestFreeLane(s.snips, s.snipLanes, snip.start_ms, snip.end_ms);
      return {
        snips: [...s.snips, snip].sort((a, b) => a.start_ms - b.start_ms),
        snipLanes: { ...s.snipLanes, [snip.id]: lane },
        skipThatPendingStartMs: null,
        skipThatTrayActiveAt: Date.now(),
      };
    }),
  skipThatTrayPing: () => set({ skipThatTrayActiveAt: Date.now() }),

  /** Load a .free profile's snips + markers into the Creator's working state.
   *  Categories used by the profile that aren't in DEFAULT_CATEGORIES are
   *  added to customCategories so their chips render. Clears undo history —
   *  the loaded profile is the baseline. */
  loadProfileAsDraft: (profile: FreeFile) =>
    set((s) => {
      const snips = [...profile.payload.snips].sort((a, b) => a.start_ms - b.start_ms);
      const lanes: Record<string, number> = {};
      for (const sn of snips) {
        lanes[sn.id] = findLowestFreeLane(snips, lanes, sn.start_ms, sn.end_ms);
      }
      const defaultsSet = new Set(DEFAULT_CATEGORIES);
      const existingCustoms = new Set(s.customCategories);
      const mergedCustoms = [...s.customCategories];
      for (const sn of snips) {
        for (const c of sn.categories) {
          if (!defaultsSet.has(c) && !existingCustoms.has(c)) {
            mergedCustoms.push(c);
            existingCustoms.add(c);
          }
        }
      }
      return {
        snips,
        markers: profile.payload.markers ?? [],
        snipLanes: lanes,
        past: [],
        future: [],
        selectedSnipId: null,
        activeSnipEdge: null,
        customCategories: mergedCustoms,
        imdbUrl: profile.payload.metadata.imdb_url ?? null,
        groups: profile.payload.groups ?? [],
        authorshipHistory: profile.payload.authorship_history ?? [],
        aspectRatio: profile.payload.metadata.aspect_ratio ?? "",
        movieTitle: profile.payload.metadata.movie_title ?? null,
        movieYear: profile.payload.metadata.movie_year ?? null,
        mapsFiltered: profile.payload.metadata.maps_filtered ?? null,
        mapsUnfiltered: profile.payload.metadata.maps_unfiltered ?? null,
        movieDirector: profile.payload.metadata.movie_director ?? null,
        movieStars: profile.payload.metadata.movie_stars ?? [],
        moviePlot: profile.payload.metadata.movie_plot ?? null,
        imdbRating: profile.payload.metadata.imdb_rating ?? null,
        imdbId: profile.payload.metadata.imdb_id ?? null,
      };
    }),
  addGroup: (name) => {
    const id =
      (globalThis.crypto?.randomUUID?.() as string | undefined) ??
      `grp-${Date.now()}`;
    useAppStore.setState((s) => ({
      groups: [...s.groups, { id, name: name.slice(0, 64) }],
    }));
    return id;
  },
  renameGroup: (id, name) =>
    set((s) => ({
      groups: s.groups.map((g) =>
        g.id === id ? { ...g, name: name.slice(0, 64) } : g,
      ),
    })),
  removeGroup: (id) =>
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      // Detach any snips that were in this group.
      snips: s.snips.map((sn) => (sn.group_id === id ? { ...sn, group_id: null } : sn)),
    })),
  setSnipGroup: (snipId, groupId) =>
    set((s) => ({
      snips: s.snips.map((sn) => (sn.id === snipId ? { ...sn, group_id: groupId } : sn)),
    })),
  addMarker: (ms, name) =>
    set((s) => {
      const rounded = Math.round(ms);
      const filtered = s.markers.filter((m) => Math.abs(m.ms - rounded) > 500);
      const rawName = name ?? `Marker ${s.markers.length + 1}`;
      const defaultName = rawName.slice(0, 64);
      const next = [...filtered, { ms: rounded, name: defaultName }].sort((a, b) => a.ms - b.ms);
      return { markers: next };
    }),
  renameMarker: (ms, name) =>
    set((s) => ({
      markers: s.markers.map((m) => (m.ms === ms ? { ...m, name: name.slice(0, 64) } : m)),
    })),
  removeMarker: (ms) => set((s) => ({ markers: s.markers.filter((m) => m.ms !== ms) })),
  clearMarkers: () => set({ markers: [] }),

  addFlags: (newFlags) =>
    set((s) => {
      const merged = [...s.flags, ...newFlags].sort((a, b) => a.ms - b.ms);
      return { flags: merged };
    }),
  renameFlag: (ms, name) =>
    set((s) => ({
      flags: s.flags.map((f) => (f.ms === ms ? { ...f, name } : f)),
    })),
  removeFlag: (ms) =>
    set((s) => {
      // If the flag has a linked snip, remove the snip too (cascade).
      const f = s.flags.find((x) => x.ms === ms);
      const newSnips = f?.linkedSnipId
        ? s.snips.filter((sn) => sn.id !== f.linkedSnipId)
        : s.snips;
      const newLanes: Record<string, number> = {};
      for (const sn of newSnips) {
        if (s.snipLanes[sn.id] !== undefined) newLanes[sn.id] = s.snipLanes[sn.id]!;
      }
      return {
        flags: s.flags.filter((x) => x.ms !== ms),
        snips: newSnips,
        snipLanes: newLanes,
      };
    }),
  clearFlags: () =>
    set((s) => {
      // Also clear any snips that were auto-created from flags.
      const linkedIds = new Set(
        s.flags.map((f) => f.linkedSnipId).filter((id): id is string => id != null),
      );
      const newSnips = s.snips.filter((sn) => !linkedIds.has(sn.id));
      const newLanes: Record<string, number> = {};
      for (const sn of newSnips) {
        if (s.snipLanes[sn.id] !== undefined) newLanes[sn.id] = s.snipLanes[sn.id]!;
      }
      return { flags: [], snips: newSnips, snipLanes: newLanes };
    }),
  commitToHistory: () =>
    set((s) => ({
      past: [
        ...s.past,
        { snips: s.snips, markers: s.markers, flags: s.flags, snipLanes: s.snipLanes },
      ].slice(-100),
      future: [],
    })),
  undo: () =>
    set((s) => {
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1]!;
      const validSelection = prev.snips.some((sn) => sn.id === s.selectedSnipId)
        ? s.selectedSnipId
        : null;
      return {
        past: s.past.slice(0, -1),
        future: [
          ...s.future,
          { snips: s.snips, markers: s.markers, flags: s.flags, snipLanes: s.snipLanes },
        ],
        snips: prev.snips,
        markers: prev.markers,
        flags: prev.flags ?? [],
        snipLanes: prev.snipLanes,
        activeSnipEdge: null,
        selectedSnipId: validSelection,
      };
    }),
  redo: () =>
    set((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[s.future.length - 1]!;
      const validSelection = next.snips.some((sn) => sn.id === s.selectedSnipId)
        ? s.selectedSnipId
        : null;
      return {
        past: [
          ...s.past,
          { snips: s.snips, markers: s.markers, flags: s.flags, snipLanes: s.snipLanes },
        ],
        future: s.future.slice(0, -1),
        snips: next.snips,
        markers: next.markers,
        flags: next.flags ?? [],
        snipLanes: next.snipLanes,
        activeSnipEdge: null,
        selectedSnipId: validSelection,
      };
    }),
}));
