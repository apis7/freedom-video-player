import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { playerController } from "../controller/playerController";
import { playback, subtitlesIpc } from "../ipc";
import { openFileFlow } from "../utils/openFileFlow";
import { markUserNavigation } from "../utils/navGuard";
import { matchesHotkey } from "../state/hotkeys";

const VOL_STEP = 5;
const SEEK_SMALL = 5;
const SEEK_MEDIUM = 10;
const SEEK_LARGE = 60;
const EDGE_NUDGE_SMALL_MS = 5_000;
const EDGE_NUDGE_MEDIUM_MS = 10_000;
const EDGE_NUDGE_LARGE_MS = 60_000;
const EDGE_NUDGE_FRAME_MS = 33; // ≈ 1 frame @ 30fps
const MIN_SNIP_LEN_MS = 100;
const ZOOM_FACTOR_KEY = 1.15; // gentler per keystroke
const MIN_VIEW_MS = 1000;

function isInputLike(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}


/** Nudge the active snip edge. Snaps to frame boundaries on tight nudges,
 *  but no longer snaps to other snips' edges — that was preventing users from
 *  nudging an edge past another snip. Lane auto-resolve handles the overlap. */
function nudgeActiveEdge(deltaMs: number) {
  const state = useAppStore.getState();
  const active = state.activeSnipEdge;
  if (!active) return;
  const snip = state.snips.find((s) => s.id === active.snipId);
  if (!snip) return;
  const durationMs = state.duration * 1000;

  let newMs: number;
  if (active.edge === "start") {
    newMs = Math.max(0, Math.min(snip.end_ms - MIN_SNIP_LEN_MS, snip.start_ms + deltaMs));
  } else {
    newMs = Math.max(
      snip.start_ms + MIN_SNIP_LEN_MS,
      Math.min(durationMs > 0 ? durationMs : snip.end_ms + deltaMs, snip.end_ms + deltaMs),
    );
  }

  // Frame-snap on small nudges only.
  if (Math.abs(deltaMs) <= EDGE_NUDGE_FRAME_MS * 2) {
    newMs = Math.round(newMs / EDGE_NUDGE_FRAME_MS) * EDGE_NUDGE_FRAME_MS;
  }

  const rounded = Math.round(newMs);
  state.commitToHistory();
  if (active.edge === "start") state.updateSnip(snip.id, { start_ms: rounded });
  else state.updateSnip(snip.id, { end_ms: rounded });
  void playback.seek(rounded / 1000);
}

function clampView(start: number, duration: number, totalMs: number) {
  const startC = Math.max(0, Math.min(totalMs - duration, start));
  return { startMs: startC, endMs: startC + duration };
}

export function useHotkeys() {
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (isInputLike(e.target)) return;

      const state = useAppStore.getState();

      // Cheatsheet — global
      if (e.key === "?" || (e.shiftKey && e.key === "/")) {
        e.preventDefault();
        useAppStore.setState({ cheatsheetVisible: !state.cheatsheetVisible });
        return;
      }

      if (e.key === "Escape") {
        if (state.activeSnipEdge) {
          e.preventDefault();
          useAppStore.setState({ activeSnipEdge: null });
          return;
        }
        if (state.cheatsheetVisible) {
          e.preventDefault();
          useAppStore.setState({ cheatsheetVisible: false });
          return;
        }
      }

      if (e.key === "o" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void openFileFlow();
        return;
      }

      // Ctrl+S — Save (Creator only). Silently overwrites the last save
      // path when one exists, otherwise opens the Save modal pre-filled
      // with the video stem. Ctrl+Shift+S — Save As: always opens the
      // modal so you can pick a new filename (versioning).
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "s" || e.key === "S") &&
        !e.altKey
      ) {
        if (state.mode !== "creator" || !state.currentFile) return;
        e.preventDefault();
        const evt = e.shiftKey ? "fvp:request-export-as" : "fvp:request-export";
        window.dispatchEvent(new CustomEvent(evt));
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab — Creator-only. Jump between snips that
      // still need a category. Wraps around at the ends. Mirrors the
      // hotkey advertised by the "uncategorized snips" save-blocker modal.
      if ((e.ctrlKey || e.metaKey) && e.key === "Tab" && !e.altKey) {
        if (state.mode !== "creator") return;
        const uncategorized = state.snips
          .filter((s) => s.categories.length === 0)
          .sort((a, b) => a.start_ms - b.start_ms);
        if (uncategorized.length === 0) {
          state.showToast("No uncategorized snips remaining.", "info", 2000);
          e.preventDefault();
          return;
        }
        e.preventDefault();
        const currentId = state.selectedSnipId;
        const currentIdx = currentId
          ? uncategorized.findIndex((s) => s.id === currentId)
          : -1;
        let nextIdx: number;
        if (e.shiftKey) {
          // Previous: if not currently on an uncategorized snip, jump to the
          // LAST uncategorized snip before the playhead (else last overall).
          if (currentIdx < 0) {
            const posMs = state.position * 1000;
            const before = [...uncategorized].reverse().find((s) => s.start_ms < posMs);
            nextIdx = before
              ? uncategorized.findIndex((s) => s.id === before.id)
              : uncategorized.length - 1;
          } else {
            nextIdx = (currentIdx - 1 + uncategorized.length) % uncategorized.length;
          }
        } else {
          if (currentIdx < 0) {
            const posMs = state.position * 1000;
            const after = uncategorized.find((s) => s.start_ms > posMs);
            nextIdx = after ? uncategorized.findIndex((s) => s.id === after.id) : 0;
          } else {
            nextIdx = (currentIdx + 1) % uncategorized.length;
          }
        }
        const target = uncategorized[nextIdx]!;
        state.selectSnip(target.id);
        markUserNavigation();
        void playback.seek(target.start_ms / 1000);
        return;
      }

      // ── Undo / Redo (global where applicable) ──
      const isUndo =
        (e.ctrlKey || e.metaKey) &&
        (e.key === "z" || e.key === "Z") &&
        !e.shiftKey &&
        !e.altKey;
      const isRedo =
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        (((e.key === "z" || e.key === "Z") && e.shiftKey) || e.key === "y" || e.key === "Y");
      if (isUndo) {
        e.preventDefault();
        state.undo();
        return;
      }
      if (isRedo) {
        e.preventDefault();
        state.redo();
        return;
      }

      // Playback / editing hotkeys: Player and Creator only.
      if (state.mode !== "player" && state.mode !== "creator") return;

      const edgeActive = state.mode === "creator" && state.activeSnipEdge !== null;
      const totalMs = state.duration * 1000;

      const hk = state.customHotkeys;

      // Space — always toggles play/pause when in Player/Creator. If a button
      // is focused (e.g., user just clicked Play/Open file), blur it first so
      // browser default activation doesn't fight us.
      if (matchesHotkey("play-pause", e, hk)) {
        if (!state.currentFile) return;
        if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") {
          e.target.blur();
        }
        e.preventDefault();
        void playerController.togglePause();
        return;
      }

      if (e.key === "f" || e.key === "F") {
        if (state.mode !== "player") return;
        e.preventDefault();
        void playerController.toggleFullscreen();
        return;
      }

      if (e.key === "m" || e.key === "M") {
        if (!state.currentFile) return;
        e.preventDefault();
        void playerController.toggleMute();
        return;
      }

      // T — A/B / preview toggle. Works in Player AND Creator (Creator uses it
      // to preview the in-memory snips on/off without saving).
      if (e.key === "t" || e.key === "T") {
        if (!state.currentFile) return;
        e.preventDefault();
        useAppStore.setState({ abToggleOn: !state.abToggleOn });
        return;
      }
      // V — toggle subtitle visibility (mpv standard hotkey).
      if (e.key === "v" || e.key === "V") {
        if (!state.currentFile) return;
        e.preventDefault();
        const next = !state.subtitleVisible;
        void subtitlesIpc
          .setVisibility(next)
          .then(() => useAppStore.setState({ subtitleVisible: next }));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        void playerController.setVolume(state.volume + VOL_STEP);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        void playerController.setVolume(state.volume - VOL_STEP);
        return;
      }

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (!state.currentFile) return;
        e.preventDefault();
        const dir = e.key === "ArrowLeft" ? -1 : 1;
        const stepSec = e.shiftKey ? SEEK_LARGE : (e.ctrlKey || e.metaKey) ? SEEK_MEDIUM : SEEK_SMALL;
        if (edgeActive) {
          const stepMs = e.shiftKey
            ? EDGE_NUDGE_LARGE_MS
            : (e.ctrlKey || e.metaKey)
              ? EDGE_NUDGE_MEDIUM_MS
              : EDGE_NUDGE_SMALL_MS;
          nudgeActiveEdge(dir * stepMs);
        } else {
          markUserNavigation();
          void playerController.seekRelative(dir * stepSec);
        }
        return;
      }

      if (e.key === ",") {
        if (!state.currentFile) return;
        e.preventDefault();
        if (edgeActive) nudgeActiveEdge(-EDGE_NUDGE_FRAME_MS);
        else void playerController.frameStepBack();
        return;
      }
      if (e.key === ".") {
        if (!state.currentFile) return;
        e.preventDefault();
        if (edgeActive) nudgeActiveEdge(EDGE_NUDGE_FRAME_MS);
        else void playerController.frameStepForward();
        return;
      }

      // ── Timeline view navigation (Creator-focused but available in Player too) ──

      if (e.key === "Home") {
        if (!state.currentFile) return;
        e.preventDefault();
        markUserNavigation();
        void playback.seek(0);
        if (state.mode === "creator") {
          const vd = state.timelineView.endMs - state.timelineView.startMs;
          if (vd > 0) state.setTimelineView({ startMs: 0, endMs: vd });
        }
        return;
      }
      if (e.key === "End") {
        if (!state.currentFile || state.duration <= 0) return;
        e.preventDefault();
        markUserNavigation();
        void playback.seek(state.duration);
        if (state.mode === "creator") {
          const vd = state.timelineView.endMs - state.timelineView.startMs;
          if (vd > 0) state.setTimelineView(clampView(totalMs - vd, vd, totalMs));
        }
        return;
      }
      if (e.key === "PageUp" || e.key === "PageDown") {
        if (!state.currentFile || state.mode !== "creator") return;
        e.preventDefault();
        markUserNavigation();
        const v = state.timelineView;
        const vd = v.endMs - v.startMs;
        if (vd <= 0) return;
        const dir = e.key === "PageUp" ? -1 : 1;
        state.setTimelineView(clampView(v.startMs + dir * vd, vd, totalMs));
        return;
      }

      if (e.key === "0") {
        if (state.mode !== "creator" || totalMs <= 0) return;
        e.preventDefault();
        state.setTimelineView({ startMs: 0, endMs: totalMs });
        return;
      }

      // = (no shift) → incremental zoom in, centered on the selected snip if
      // one is selected, otherwise on the playhead.
      if (e.key === "=" && !e.shiftKey) {
        if (state.mode !== "creator" || totalMs <= 0) return;
        e.preventDefault();
        const v = state.timelineView;
        const vd = v.endMs - v.startMs;
        const newDur = Math.max(MIN_VIEW_MS, vd / ZOOM_FACTOR_KEY);
        const snip = state.selectedSnipId
          ? state.snips.find((s) => s.id === state.selectedSnipId)
          : null;
        const centerMs = snip
          ? (snip.start_ms + snip.end_ms) / 2
          : state.position * 1000;
        state.setTimelineView(clampView(centerMs - newDur / 2, newDur, totalMs));
        return;
      }

      // + / Shift+= → zoom in (centered on playhead)
      if (e.key === "+" || (e.shiftKey && e.key === "=")) {
        if (state.mode !== "creator" || totalMs <= 0) return;
        e.preventDefault();
        const v = state.timelineView;
        const vd = v.endMs - v.startMs;
        const newDur = Math.max(MIN_VIEW_MS, vd / ZOOM_FACTOR_KEY);
        const playheadMs = state.position * 1000;
        state.setTimelineView(clampView(playheadMs - newDur / 2, newDur, totalMs));
        return;
      }

      // - or _ → zoom out (centered on playhead)
      if (e.key === "-" || e.key === "_") {
        if (state.mode !== "creator" || totalMs <= 0) return;
        e.preventDefault();
        const v = state.timelineView;
        const vd = v.endMs - v.startMs;
        const newDur = Math.min(totalMs, vd * ZOOM_FACTOR_KEY);
        const playheadMs = state.position * 1000;
        state.setTimelineView(clampView(playheadMs - newDur / 2, newDur, totalMs));
        return;
      }

      // ── Markers (B drops, [ / ] navigate) ──

      // Delete key — remove the entire snip selection (Creator only).
      // Bulk-delete confirmation kicks in for selections > 10.
      if (e.key === "Delete") {
        if (state.mode !== "creator" || state.selectedSnipIds.length === 0) return;
        e.preventDefault();
        const ids = state.selectedSnipIds;
        if (
          ids.length > 10 &&
          !window.confirm(`Delete ${ids.length} selected snips?\n\nYou can undo with Ctrl+Z.`)
        ) {
          return;
        }
        state.commitToHistory();
        state.removeSnips(ids);
        return;
      }
      // Ctrl+A — select all snips when in Creator. Doesn't fight with text
      // input because isInputLike(target) bails earlier in this handler.
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        if (state.mode !== "creator" || state.snips.length === 0) return;
        e.preventDefault();
        state.selectAllSnips();
        return;
      }
      // Enter — preview selected snip (Creator only). Seeks 2s before the
      // snip's start and plays through with the apply engine active so the
      // user sees+hears exactly what the snip will do.
      if (matchesHotkey("snip-preview", e, hk)) {
        if (state.mode !== "creator" || !state.currentFile) return;
        if (!state.selectedSnipId) return;
        const snip = state.snips.find((s) => s.id === state.selectedSnipId);
        if (!snip) return;
        e.preventDefault();
        const previewStartMs = Math.max(0, snip.start_ms - 2000);
        markUserNavigation();
        useAppStore.setState({ abToggleOn: true });
        void playback.seek(previewStartMs / 1000).then(() => playback.play());
        return;
      }
      // Tab / Shift+Tab — context-dependent navigation:
      //   Player Mode: jump between active-profile snip starts (audit playback)
      //   Creator Mode: jump between markers + flags (both are nav points)
      if (e.key === "Tab") {
        if (!state.currentFile) return;
        let targets: number[] = [];
        if (state.mode === "player") {
          targets = state.detectedProfiles
            .filter((p) => p.active)
            .flatMap((p) => p.profile.payload.snips.map((s) => s.start_ms));
        } else if (state.mode === "creator") {
          targets = [
            ...state.markers.map((m) => m.ms),
            ...state.flags.map((f) => f.ms),
          ];
        }
        if (targets.length === 0) return;
        e.preventDefault();
        targets.sort((a, b) => a - b);
        const posMs = state.position * 1000;
        markUserNavigation();
        if (e.shiftKey) {
          const prev = [...targets].reverse().find((t) => t < posMs - 250);
          if (prev !== undefined) void playback.seek(prev / 1000);
        } else {
          const next = targets.find((t) => t > posMs + 250);
          if (next !== undefined) void playback.seek(next / 1000);
        }
        return;
      }

      if (matchesHotkey("marker-drop", e, hk)) {
        if (!state.currentFile) return;
        e.preventDefault();
        state.commitToHistory();
        state.addMarker(Math.round(state.position * 1000));
        return;
      }
      // Player-mode Skip-That hotkeys (separate from Creator marker jumps
      // which share the same default keys — gated by mode).
      if (state.mode === "player" && state.currentFile) {
        if (matchesHotkey("skipthat-back", e, hk)) {
          e.preventDefault();
          state.skipThatBackAnchored(state.position * 1000);
          return;
        }
        if (matchesHotkey("skipthat-open", e, hk)) {
          e.preventDefault();
          state.skipThatOpen(state.position * 1000);
          return;
        }
        if (matchesHotkey("skipthat-close", e, hk)) {
          e.preventDefault();
          state.skipThatClose(state.position * 1000);
          return;
        }
        if (matchesHotkey("skipthat-quick", e, hk)) {
          e.preventDefault();
          state.skipThatQuick(state.position * 1000);
          return;
        }
      }
      // Creator-mode marker jumps.
      if (state.mode === "creator" && state.currentFile && state.markers.length > 0) {
        if (matchesHotkey("marker-prev", e, hk)) {
          e.preventDefault();
          const pos = state.position * 1000;
          const prev = [...state.markers].reverse().find((m) => m.ms < pos - 100);
          if (prev) {
            markUserNavigation();
            void playback.seek(prev.ms / 1000);
          }
          return;
        }
        if (matchesHotkey("marker-next", e, hk)) {
          e.preventDefault();
          const pos = state.position * 1000;
          const next = state.markers.find((m) => m.ms > pos + 100);
          if (next) {
            markUserNavigation();
            void playback.seek(next.ms / 1000);
          }
          return;
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}
