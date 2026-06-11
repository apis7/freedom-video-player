import React, { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../state/appStore";
import { TransportBar } from "../components/TransportBar";
import { HotkeyTicker } from "../components/HotkeyTicker";
import { CropOverlay } from "../components/CropOverlay";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { ExportProfileModal } from "../components/ExportProfileModal";
import { ProfilePickerModal } from "../components/ProfilePickerModal";
import { TypedConfirmModal } from "../components/TypedConfirmModal";
import { addSubtitleFlow } from "../utils/addSubtitleFlow";
import { subtitlesIpc } from "../ipc";
import { ImdbLinkModal } from "../components/ImdbLinkModal";
import { SearchAndFlagModal } from "../components/SearchAndFlagModal";
import { FindInSubsBar } from "../components/FindInSubsBar";
import { SnipGroupsModal } from "../components/SnipGroupsModal";
import { BeepShortenModal } from "../components/BeepShortenModal";
import { MovieInfoModal } from "../components/MovieInfoModal";
import { UncategorizedSnipsModal } from "../components/UncategorizedSnipsModal";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { WaveformBackground } from "../components/WaveformBackground";
import { PeaksBuildingBadge } from "../components/PeaksBuildingBadge";
import { useAudioPeaks } from "../hooks/useAudioPeaks";
import { useSavedStatusTracker } from "../hooks/useSavedStatusTracker";
import {
  AutoSnipRunningModal,
  AutoSnipNoSubsModal,
  AutoSnipPreviewModal,
} from "../components/AutoSnipModals";
import { runAutoSnip } from "../utils/autoSnipFlow";
import type { AutoSnipMatch } from "../ipc";
import { openFileFlow } from "../utils/openFileFlow";
import { useVideoAreaReporter } from "../hooks/useVideoAreaReporter";
import { playback } from "../ipc";
import { playerController } from "../controller/playerController";
import type { Snip, SnipAction } from "../ipc/types";
import {
  MAX_BEEP_DURATION_MS,
  BEEP_DEFAULT_FREQ_HZ,
  BEEP_DEFAULT_LEVEL_DB,
  MUTE_DIALOGUE_MODE_LABELS,
  AUDIO_BLUR_MODE_LABELS,
  AUDIO_BLUR_MODE_DESCRIPTIONS,
  type MuteDialogueMode,
  type AudioBlurMode,
} from "../ipc/types";
import type { Marker } from "../state/types";
import { formatTime, formatDuration } from "../utils/format";
import { sanitizeForDisplay } from "../utils/sanitize";

/* ───────────────────────── Categories ───────────────────────── */

import { DEFAULT_CATEGORIES, CATEGORY_COLOR } from "../state/categories";

function colorForSnip(snip: Snip): string {
  if (snip.categories.length === 0) return "#8a8f9c";
  return CATEGORY_COLOR[snip.categories[0]!] ?? "#4f8cff";
}

/* ───────────────────────── Mode root ───────────────────────── */

export function CreatorMode() {
  const currentFile = useAppStore((s) => s.currentFile);
  const videoAreaRef = useRef<HTMLDivElement>(null);
  useVideoAreaReporter(videoAreaRef);

  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [ctxMarker, setCtxMarker] = useState<Marker | null>(null);
  const [ctxFlag, setCtxFlag] = useState<import("../state/types").Flag | null>(null);
  const [renamingMarker, setRenamingMarker] = useState<Marker | null>(null);
  const [exporting, setExporting] = useState(false);
  const [saveAsMode, setSaveAsMode] = useState(false);
  const [showUncategorizedModal, setShowUncategorizedModal] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showClearAllConfirm, setShowClearAllConfirm] = useState(false);
  const [showImdbModal, setShowImdbModal] = useState(false);
  const [showGroupsModal, setShowGroupsModal] = useState(false);
  const imdbUrl = useAppStore((s) => s.imdbUrl);
  const [autoSnipState, setAutoSnipState] = useState<
    | { stage: "idle" }
    | { stage: "running" }
    | { stage: "preview"; matches: AutoSnipMatch[] }
    | { stage: "no-subs"; videoPath: string }
  >({ stage: "idle" });
  const [showSearchAndFlag, setShowSearchAndFlag] = useState(false);
  useEffect(() => {
    const handler = () => setShowSearchAndFlag(true);
    window.addEventListener("fvp:request-search-and-flag", handler);
    return () =>
      window.removeEventListener("fvp:request-search-and-flag", handler);
  }, []);
  const [showFindInSubs, setShowFindInSubs] = useState(false);
  useEffect(() => {
    const handler = () => setShowFindInSubs(true);
    window.addEventListener("fvp:request-find-in-subs", handler);
    return () =>
      window.removeEventListener("fvp:request-find-in-subs", handler);
  }, []);
  const detectedProfiles = useAppStore((s) => s.detectedProfiles);
  const snipCount = useAppStore((s) => s.snips.length);

  // Background waveform: load existing peaks sidecar (or kick off a build)
  // whenever a file is loaded in Creator mode. Fully non-blocking; rendered
  // by WaveformBackground inside the snip lane.
  useAudioPeaks();

  // Track whether the current editing state has been exported to a `.free`
  // file since the last edit. Drives the green/orange pill next to Autosave.
  useSavedStatusTracker();

  // Toolbar's Clear All button bubbles up via a window event so the modal
  // (owned at this level) can render — keeps toolbar component simple.
  useEffect(() => {
    const handler = () => setShowClearAllConfirm(true);
    window.addEventListener("fvp:request-clear-all", handler);
    return () => window.removeEventListener("fvp:request-clear-all", handler);
  }, []);

  useEffect(() => {
    const handler = () => setShowImdbModal(true);
    window.addEventListener("fvp:request-imdb-link", handler);
    return () => window.removeEventListener("fvp:request-imdb-link", handler);
  }, []);

  // Ctrl+S — Save. Silent overwrite when lastSavedPath is set; otherwise
  // open the Save modal with the video stem as the default filename.
  // Ctrl+Shift+S — Save As. Always opens the Save modal regardless.
  // Uncategorized snips block both paths with the UncategorizedSnipsModal.
  useEffect(() => {
    const openSaveModal = (saveAs: boolean) => {
      setSaveAsMode(saveAs);
      setExporting(true);
    };
    const handleSave = async () => {
      const s = useAppStore.getState();
      if (!s.currentFile) return;
      if (s.snips.length === 0) {
        s.showToast("No snips to save.", "info");
        return;
      }
      const uncategorized = s.snips.filter((sn) => sn.categories.length === 0).length;
      if (uncategorized > 0) {
        setShowUncategorizedModal(true);
        return;
      }
      // Silent overwrite when we know where to write.
      if (s.lastSavedPath) {
        const { saveProfileToExactPath } = await import("../utils/exportProfile");
        const result = await saveProfileToExactPath(s.lastSavedPath);
        if (result.ok && result.path) {
          const name = result.path.split(/[\\/]/).pop() ?? result.path;
          s.showToast(`Saved → ${name}`, "info", 2500);
        } else {
          s.showToast(`Save failed: ${result.error ?? "unknown"}`, "error");
        }
        return;
      }
      openSaveModal(false);
    };
    const handleSaveAs = () => {
      const s = useAppStore.getState();
      if (!s.currentFile) return;
      const uncategorized = s.snips.filter((sn) => sn.categories.length === 0).length;
      if (uncategorized > 0) {
        setShowUncategorizedModal(true);
        return;
      }
      openSaveModal(true);
    };
    const saveListener = () => void handleSave();
    window.addEventListener("fvp:request-export", saveListener);
    window.addEventListener("fvp:request-export-as", handleSaveAs);
    return () => {
      window.removeEventListener("fvp:request-export", saveListener);
      window.removeEventListener("fvp:request-export-as", handleSaveAs);
    };
  }, []);

  useEffect(() => {
    const handler = () => setShowGroupsModal(true);
    window.addEventListener("fvp:request-groups", handler);
    return () => window.removeEventListener("fvp:request-groups", handler);
  }, []);

  // AutoSnip button click → run pipeline. Falls back to embedded subs (already
  // extracted into state.subtitleEntries) when no external .srt is found.
  useEffect(() => {
    const handler = async () => {
      const file = useAppStore.getState().currentFile;
      if (!file) return;
      // Upfront short-circuit: if there are NO embedded subs loaded AND
      // the user hasn't loaded an external .srt yet, jump straight to
      // the no-subs modal so the user can pick a file or hop to
      // OpenSubtitles. Without this, the user clicks AutoSnip and gets
      // a vague error toast after a delay — worse UX.
      const entriesNow = useAppStore.getState().subtitleEntries;
      if (entriesNow.length === 0) {
        setAutoSnipState({ stage: "no-subs", videoPath: file });
        return;
      }
      setAutoSnipState({ stage: "running" });
      const { runAutoSnipOnEntries } = await import("../utils/autoSnipFlow");
      try {
        const plan = await runAutoSnip(file);
        if (plan.matches.length === 0) {
          useAppStore
            .getState()
            .showToast(
              "AutoSnip found no flagged words in the subtitles. " +
                "Either the wordlist needs more entries, or the subs are clean.",
              "info",
              8000,
            );
          setAutoSnipState({ stage: "idle" });
        } else {
          setAutoSnipState({ stage: "preview", matches: plan.matches });
        }
      } catch (err) {
        const msg = String(err);
        if (msg.includes("no subtitle file found")) {
          // No .srt — fall back to already-extracted embedded sub entries
          // (refreshSubtitleTracks pulls these in when a video opens).
          const entries = useAppStore.getState().subtitleEntries;
          if (entries.length > 0) {
            try {
              const plan = await runAutoSnipOnEntries(entries, file);
              if (plan.matches.length === 0) {
                useAppStore
                  .getState()
                  .showToast(
                    "AutoSnip found no flagged words in the embedded subtitles.",
                    "info",
                    6000,
                  );
                setAutoSnipState({ stage: "idle" });
              } else {
                setAutoSnipState({ stage: "preview", matches: plan.matches });
              }
              return;
            } catch (e2) {
              useAppStore.getState().showToast(`AutoSnip failed: ${e2}`, "error", 8000);
              setAutoSnipState({ stage: "idle" });
              return;
            }
          }
          setAutoSnipState({ stage: "no-subs", videoPath: file });
        } else {
          useAppStore.getState().showToast(`AutoSnip failed: ${msg}`, "error", 8000);
          setAutoSnipState({ stage: "idle" });
        }
      }
    };
    window.addEventListener("fvp:request-autosnip", handler);
    return () => window.removeEventListener("fvp:request-autosnip", handler);
  }, []);

  // Auto-load .free profile into the Creator when entering this mode (or when
  // the detected profile list changes) — but only if the user hasn't already
  // started a draft (snipCount === 0). Multi-profile case shows a picker.
  useEffect(() => {
    if (snipCount > 0) return;
    if (detectedProfiles.length === 0) return;
    if (detectedProfiles.length === 1) {
      useAppStore.getState().loadProfileAsDraft(detectedProfiles[0]!.profile);
    } else {
      setShowPicker(true);
    }
    // Intentionally only re-run when the file/profile list itself changes —
    // not on every snip add. Once the user has snips, this effect bails on
    // the snipCount check above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFile, detectedProfiles.length]);

  // Document-level right-click (works for any UI region). Marker right-click
  // handlers (RulerMarkers below) populate `ctxMarker` *before* this fires
  // (synchronously in the same tick), so menu items can specialize. Bails
  // when a modal is open so the menu doesn't appear under the modal backdrop.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      if (useAppStore.getState().openModalCount > 0) return;
      setCtx({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("contextmenu", handler, true);
    return () => document.removeEventListener("contextmenu", handler, true);
  }, []);

  // Right-clicks on libmpv's HWND come through as a Tauri event with
  // intermediate-local physical-pixel coords. Convert + offset by the video
  // area's viewport position.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ x: number; y: number }>("video-context-menu", (e) => {
      const rect = videoAreaRef.current?.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const offsetX = rect ? rect.left : 0;
      const offsetY = rect ? rect.top : 0;
      setCtx({
        x: offsetX + e.payload.x / dpr,
        y: offsetY + e.payload.y / dpr,
      });
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  // Click anywhere outside a snip-edge handle deactivates the active edge.
  // Capture phase so we run before button onClick handlers.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const isHandle = target?.dataset.snipHandle === "true";
      if (!isHandle && useAppStore.getState().activeSnipEdge) {
        useAppStore.setState({ activeSnipEdge: null });
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, []);

  const buildMenuItems = (): MenuItem[] => {
    const state = useAppStore.getState();
    const { currentFile: cf, snips, selectedSnipId, position, duration } = state;
    const playing = state.playing;
    const muted = state.muted;
    const selectedSnip = snips.find((s) => s.id === selectedSnipId) ?? null;
    const canUndo = state.past.length > 0;
    const canRedo = state.future.length > 0;
    const jumpOn = state.jumpPlayheadOnSnipSelect;

    return [
      {
        kind: "item",
        label: playing ? "Pause" : "Play",
        hotkey: "Space",
        disabled: !cf,
        onClick: () => void playerController.togglePause(),
      },
      {
        kind: "item",
        label: muted ? "Unmute" : "Mute",
        hotkey: "M",
        disabled: !cf,
        onClick: () => void playerController.toggleMute(),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Seek −10s",
        hotkey: "Ctrl + ←",
        disabled: !cf,
        onClick: () => void playerController.seekRelative(-10),
      },
      {
        kind: "item",
        label: "Seek +10s",
        hotkey: "Ctrl + →",
        disabled: !cf,
        onClick: () => void playerController.seekRelative(10),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Add 10s snip at playhead",
        disabled: !cf || duration <= 0,
        onClick: () => {
          const startMs = Math.max(0, Math.round((position - 5) * 1000));
          const endMs = Math.min(Math.round(duration * 1000), startMs + 10_000);
          if (endMs > startMs) {
            const id =
              (globalThis.crypto?.randomUUID?.() as string | undefined) ??
              `snip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            state.commitToHistory();
            state.addSnip({
              id,
              start_ms: startMs,
              end_ms: endMs,
              categories: [],
              action: { type: "skip" },
              group_id: null,
              note: null,
            });
          }
        },
      },
      {
        kind: "item",
        label:
          state.selectedSnipIds.length > 1
            ? `Delete ${state.selectedSnipIds.length} selected snips`
            : "Delete selected snip",
        disabled: state.selectedSnipIds.length === 0,
        onClick: () => {
          const ids = state.selectedSnipIds;
          if (ids.length === 0) return;
          // Confirm bulk deletes — undo works, but losing 10+ snips by accident is bad UX.
          if (ids.length > 10) {
            if (
              !window.confirm(
                `Delete ${ids.length} selected snips?\n\nYou can undo with Ctrl+Z.`,
              )
            ) {
              return;
            }
          }
          state.commitToHistory();
          state.removeSnips(ids);
        },
      },
      {
        kind: "item",
        label:
          state.selectedSnipIds.length > 1
            ? `Duplicate ${state.selectedSnipIds.length} snips`
            : "Duplicate snip",
        disabled: state.selectedSnipIds.length === 0,
        onClick: () => {
          const ids = state.selectedSnipIds;
          if (ids.length === 0) return;
          state.commitToHistory();
          state.duplicateSnips(ids);
        },
      },
      {
        kind: "item",
        label: "Select all snips",
        hotkey: "Ctrl+A",
        disabled: snips.length === 0,
        onClick: () => state.selectAllSnips(),
      },
      {
        kind: "item",
        label: "Extend snip to playhead",
        disabled: !selectedSnip,
        onClick: () => {
          if (!selectedSnip) return;
          const playheadMs = Math.round(state.position * 1000);
          if (playheadMs < selectedSnip.start_ms) {
            state.commitToHistory();
            state.updateSnip(selectedSnip.id, { start_ms: playheadMs });
          } else if (playheadMs > selectedSnip.end_ms) {
            state.commitToHistory();
            state.updateSnip(selectedSnip.id, { end_ms: playheadMs });
          }
          // Playhead inside snip → no-op (snip already contains the playhead).
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Undo",
        hotkey: "Ctrl + Z",
        disabled: !canUndo,
        onClick: () => state.undo(),
      },
      {
        kind: "item",
        label: "Redo",
        hotkey: "Ctrl + Shift + Z",
        disabled: !canRedo,
        onClick: () => state.redo(),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Drop marker at playhead",
        hotkey: "B",
        disabled: !cf,
        onClick: () => {
          state.commitToHistory();
          state.addMarker(Math.round(state.position * 1000));
        },
      },
      {
        kind: "item",
        label: "Clear all markers",
        disabled: state.markers.length === 0,
        onClick: () => {
          state.commitToHistory();
          state.clearMarkers();
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Add subtitle file…",
        disabled: !cf,
        title:
          "Loads an external .srt / .vtt / .ass file. Subtitle entries appear " +
          "as blocks on the Subs row of the timeline.",
        onClick: () => void addSubtitleFlow(),
      },
      {
        kind: "item",
        label: "Search & Find in Subs…",
        disabled: !cf || state.subtitleEntries.length === 0,
        title:
          "Word-find for subtitles. Type any term and use ← / → arrows " +
          "(or Enter / Shift+Enter) to jump the playhead to each occurrence " +
          "in the subtitle track. Useful for verifying AutoSnip caught " +
          "everything, or finding a specific line of dialogue.",
        onClick: () =>
          window.dispatchEvent(new CustomEvent("fvp:request-find-in-subs")),
      },
      {
        kind: "item",
        label: `${state.subtitleVisible ? "✓ " : "    "}Enable subtitles`,
        disabled: !cf,
        onClick: () => {
          const v = !state.subtitleVisible;
          void subtitlesIpc.setVisibility(v).then(() =>
            useAppStore.setState({ subtitleVisible: v }),
          );
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Zoom to fit",
        hotkey: "0",
        disabled: !cf || state.duration <= 0,
        onClick: () => state.setTimelineView({ startMs: 0, endMs: state.duration * 1000 }),
      },
      {
        kind: "item",
        label: "Zoom to selected snip",
        hotkey: "=",
        disabled: !selectedSnip,
        onClick: () => {
          if (!selectedSnip) return;
          const totalMs = state.duration * 1000;
          const dur = selectedSnip.end_ms - selectedSnip.start_ms;
          const target = Math.max(1000, Math.min(totalMs, dur * 1.6));
          const center = (selectedSnip.start_ms + selectedSnip.end_ms) / 2;
          const newStart = Math.max(0, Math.min(totalMs - target, center - target / 2));
          state.setTimelineView({ startMs: newStart, endMs: newStart + target });
        },
      },
      ...(ctxMarker
        ? [
            { kind: "separator" as const },
            {
              kind: "item" as const,
              label: `Rename marker (${ctxMarker.name})`,
              onClick: () => setRenamingMarker(ctxMarker),
            },
            {
              kind: "item" as const,
              label: `Delete marker (${ctxMarker.name})`,
              onClick: () => {
                state.commitToHistory();
                state.removeMarker(ctxMarker.ms);
              },
            },
          ]
        : []),
      ...(ctxFlag
        ? [
            { kind: "separator" as const },
            {
              kind: "item" as const,
              label: `Delete flag (${ctxFlag.name})`,
              onClick: () => {
                state.commitToHistory();
                state.removeFlag(ctxFlag.ms);
              },
            },
            {
              kind: "item" as const,
              label: `Add "${ctxFlag.keyword}" to AutoSnip whitelist`,
              title:
                "Excludes this keyword from future AutoSnip runs for THIS " +
                "video only. Saves to a .fvp-whitelist.json sidecar next to " +
                "the video.",
              onClick: () =>
                void import("../utils/autoSnipFlow").then((m) =>
                  m.whitelistKeyword(ctxFlag.keyword),
                ),
            },
          ]
        : []),
      { kind: "separator" },
      {
        kind: "item",
        label: `${jumpOn ? "✓ " : "    "}Jump playhead to selected snip`,
        title:
          "When ON, clicking any snip auto-seeks the playhead to that snip's start. " +
          "When OFF, clicking a snip just selects it — Ctrl+Shift+click overrides and " +
          "seeks regardless. (Plain Ctrl+click is reserved for multi-select toggle.)",
        onClick: () => state.toggleJumpPlayheadOnSnipSelect(),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Hotkey cheatsheet…",
        hotkey: "?",
        onClick: () => useAppStore.setState({ cheatsheetVisible: true }),
      },
    ];
  };

  return (
    <div className="h-full flex flex-col">
      <CreatorTopToolbar
        hasFile={!!currentFile}
        onExportClick={() =>
          window.dispatchEvent(new CustomEvent("fvp:request-export"))
        }
      />

      {/* Upper region: rails + video. Timeline is BELOW, spanning full width. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 flex">
          <SnipListRail />

          <div className="flex-1 min-w-0 flex flex-col">
            <VideoPreviewArea hasFile={!!currentFile} videoRef={videoAreaRef} />
            <TransportBar onOpenFile={() => void openFileFlow()} variant="creator" />
          </div>

          <SnipDetailPanel />
        </div>

        <TimelinePanel />
      </div>

      <CreatorStatusBar />
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={buildMenuItems()}
          onClose={() => {
            setCtx(null);
            setCtxMarker(null);
          }}
        />
      )}
      {renamingMarker && (
        <RenameMarkerModal
          marker={renamingMarker}
          onCancel={() => setRenamingMarker(null)}
          onSubmit={(name) => {
            const trimmed = name.trim();
            useAppStore.getState().commitToHistory();
            if (!trimmed) useAppStore.getState().removeMarker(renamingMarker.ms);
            else useAppStore.getState().renameMarker(renamingMarker.ms, trimmed);
            setRenamingMarker(null);
          }}
        />
      )}
      <RulerMarkerRightClickBridge
        onMarkerRightClick={setCtxMarker}
        onFlagRightClick={setCtxFlag}
      />
      {exporting && (
        <ExportProfileModal
          saveAsMode={saveAsMode}
          onCancel={() => {
            setExporting(false);
            setSaveAsMode(false);
          }}
          onSuccess={(path) => {
            setExporting(false);
            setSaveAsMode(false);
            const name = path.split(/[\\/]/).pop() ?? path;
            useAppStore.getState().showToast(`Saved → ${name}`, "info", 3000);
          }}
        />
      )}
      {showUncategorizedModal && (
        <UncategorizedSnipsModal onClose={() => setShowUncategorizedModal(false)} />
      )}
      {showPicker && (
        <ProfilePickerModal
          profiles={detectedProfiles}
          onClose={() => setShowPicker(false)}
        />
      )}
      {autoSnipState.stage === "running" && <AutoSnipRunningModal />}
      {autoSnipState.stage === "preview" && (
        <AutoSnipPreviewModal
          matches={autoSnipState.matches}
          onClose={() => setAutoSnipState({ stage: "idle" })}
        />
      )}
      {autoSnipState.stage === "no-subs" && (
        <AutoSnipNoSubsModal
          videoPath={autoSnipState.videoPath}
          onClose={() => setAutoSnipState({ stage: "idle" })}
        />
      )}
      {showImdbModal && (
        <ImdbLinkModal initial={imdbUrl} onClose={() => setShowImdbModal(false)} />
      )}
      {showGroupsModal && (
        <SnipGroupsModal onClose={() => setShowGroupsModal(false)} />
      )}
      {showSearchAndFlag && (
        <SearchAndFlagModal onClose={() => setShowSearchAndFlag(false)} />
      )}
      {showFindInSubs && (
        <FindInSubsBar onClose={() => setShowFindInSubs(false)} />
      )}
      {showClearAllConfirm && (
        <TypedConfirmModal
          title="Clear all snips and markers?"
          message={
            `This will delete ALL ${snipCount} snip${snipCount === 1 ? "" : "s"} ` +
            `and any markers in this working profile.\n\n` +
            `You can undo this with Ctrl+Z, but if you close the file or app ` +
            `(or autosave fires) the data will be gone for good.`
          }
          requiredText="delete"
          confirmLabel="Clear all"
          onCancel={() => setShowClearAllConfirm(false)}
          onConfirm={() => {
            const store = useAppStore.getState();
            store.commitToHistory();
            store.clearSnips();
            store.clearMarkers();
            setShowClearAllConfirm(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Invisible bridge: the RulerMarkers component fires a custom event when
 * right-clicked. We listen for it here and update CreatorMode's local state.
 * (Avoids prop-drilling and avoids ref-passing for this niche interaction.)
 */
function RulerMarkerRightClickBridge({
  onMarkerRightClick,
  onFlagRightClick,
}: {
  onMarkerRightClick: (m: Marker | null) => void;
  onFlagRightClick: (f: import("../state/types").Flag | null) => void;
}) {
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { kind?: string; ms?: number } | null;
      if (!detail) {
        onMarkerRightClick(null);
        onFlagRightClick(null);
        return;
      }
      if (detail.kind === "flag") {
        // Look up the full Flag object from store by ms.
        const f = useAppStore.getState().flags.find((x) => x.ms === detail.ms) ?? null;
        onFlagRightClick(f);
        onMarkerRightClick(null);
      } else {
        const m = useAppStore.getState().markers.find((x) => x.ms === detail.ms) ?? null;
        onMarkerRightClick(m);
        onFlagRightClick(null);
      }
    };
    window.addEventListener("fvp:marker-right-click", handler);
    return () => window.removeEventListener("fvp:marker-right-click", handler);
  }, [onMarkerRightClick, onFlagRightClick]);
  return null;
}

/* ───────────────────────── Rename Marker modal ───────────────────────── */

function RenameMarkerModal({
  marker,
  onCancel,
  onSubmit,
}: {
  marker: Marker;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(marker.name);
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);
  const dirty = name !== marker.name;
  const tryClose = () => {
    if (dirty && !window.confirm("Discard unsaved marker name change?")) return;
    onCancel();
  };
  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={tryClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[340px] max-w-[420px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-1">Rename marker</div>
        <div className="text-[11px] text-fvp-muted mb-3">
          At {formatTime(marker.ms / 1000)} · clear the name to delete the marker
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onSubmit(name);
            } else if (e.key === "Escape") {
              e.preventDefault();
              tryClose();
            }
          }}
          className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-sm text-fvp-text outline-none mb-4"
        />
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={tryClose}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(name)}
            className="px-3 py-1.5 bg-fvp-accent hover:opacity-90 text-white rounded"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Top toolbar ───────────────────────── */

function CreatorTopToolbar({
  hasFile,
  onExportClick,
}: {
  hasFile: boolean;
  onExportClick: () => void;
}) {
  const snipCount = useAppStore((s) => s.snips.length);
  const canUndo = useAppStore((s) => s.past.length > 0);
  const canRedo = useAppStore((s) => s.future.length > 0);
  const undo = useAppStore((s) => s.undo);
  const redo = useAppStore((s) => s.redo);
  const autosaveDraft = useAppStore((s) => s.autosaveDraft);
  const setAutosaveDraft = useAppStore((s) => s.setAutosaveDraft);
  const flagCount = useAppStore((s) => s.flags.length);
  const clearFlags = useAppStore((s) => s.clearFlags);
  const commitToHistory = useAppStore((s) => s.commitToHistory);

  return (
    <div className="h-10 bg-fvp-surface border-b border-fvp-border flex items-center px-3 gap-1 text-xs select-none">
      <ToolbarButton title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>↶ Undo</ToolbarButton>
      <ToolbarButton title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>↷ Redo</ToolbarButton>
      <label
        className="flex items-center gap-1 px-2 py-1 text-fvp-muted hover:text-fvp-text cursor-pointer"
        title={
          "Auto-save the current draft to a .fvp-draft.json sidecar next to the " +
          "video. When ON, every edit is persisted (debounced); the draft is " +
          "restored automatically the next time you open this video."
        }
      >
        <input
          type="checkbox"
          checked={autosaveDraft}
          onChange={(e) => setAutosaveDraft(e.target.checked)}
          className="accent-fvp-accent"
        />
        Autosave
      </label>
      <SaveStatusPill />
      <Sep />
      <ToolbarButton
        title="Export to a .free file next to the video"
        disabled={!hasFile || snipCount === 0}
        onClick={onExportClick}
      >
        Export…
      </ToolbarButton>
      <Sep />
      <ToolbarButton
        title="AutoSnip — scan subtitles for flagged words, drop flags + auto-snips"
        disabled={!hasFile}
        onClick={() => window.dispatchEvent(new CustomEvent("fvp:request-autosnip"))}
      >
        AutoSnip…
      </ToolbarButton>
      <ToolbarButton
        title={
          "Search & Flag — augments AutoSnip. Type any term (sexual slang, " +
          "in-universe euphemisms, character names, etc.) and FVP drops " +
          "a flag wherever it appears in the subtitles. No snips are " +
          "created — just flags, so you can review and snip manually."
        }
        disabled={!hasFile}
        onClick={() =>
          window.dispatchEvent(new CustomEvent("fvp:request-search-and-flag"))
        }
        aria-label="Search & Flag"
      >
        {/* Magnifying glass + small flag overlay icon. Single-color
            stroke so it inherits the toolbar button's currentColor. */}
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <circle cx="10" cy="10" r="6" />
          <path d="M14.5 14.5L20 20" />
          <path d="M13 6 v6 M13 6 l4 1 l-4 1" />
        </svg>
      </ToolbarButton>
      {flagCount > 0 && (
        <ToolbarButton
          title={`Remove all ${flagCount} AutoSnip flag${flagCount === 1 ? "" : "s"} (and any auto-created snips linked to them)`}
          onClick={() => {
            commitToHistory();
            clearFlags();
          }}
        >
          Clear flags ({flagCount})
        </ToolbarButton>
      )}
      <Sep />
      <MovieInfoButton />
      <ImdbLinkButton />
      <AuthorHandleIconButton />
      <Sep />
      <ToolbarButton
        title="Clear all snips from the working profile (requires typed confirmation)"
        disabled={snipCount === 0}
        onClick={() => {
          // Defer to Creator-level state so the typed-confirm modal can render.
          window.dispatchEvent(new CustomEvent("fvp:request-clear-all"));
        }}
      >
        Clear all
      </ToolbarButton>
      <div className="flex-1" />
      <ToolbarButton title="A/B preview toggle (T)" disabled={!hasFile}>A/B</ToolbarButton>
      <ToolbarButton title="Snip preset hotkeys — coming soon" disabled>
        Preset hotkeys…
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  children,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        "px-2 py-1 rounded text-xs",
        disabled
          ? "text-fvp-muted/60 cursor-not-allowed"
          : "text-fvp-text hover:bg-fvp-surface2 cursor-pointer",
      )}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-fvp-border mx-1" />;
}

/**
 * Small pill next to the Autosave checkbox that shows whether the current
 * editing state has been exported to a `.free` file since the last edit.
 *   - green check ✓ ("Saved"): current snapshot matches last manual export
 *   - orange circle ●  ("Unsaved"): edits since last export, or never exported
 * Hidden when no file is loaded, or when the state is empty (nothing to
 * save yet — first-open of a fresh file, before any work).
 */
function SaveStatusPill() {
  const hasFile = useAppStore((s) => s.currentFile !== null);
  const unsaved = useAppStore((s) => s.unsavedSinceExport);
  const hasSavedSnapshot = useAppStore((s) => s.lastSavedSnapshot !== null);
  const snipCount = useAppStore((s) => s.snips.length);
  const markerCount = useAppStore((s) => s.markers.length);

  if (!hasFile) return null;
  // Empty file, no save history → nothing meaningful to indicate.
  if (!hasSavedSnapshot && snipCount === 0 && markerCount === 0) return null;

  if (unsaved) {
    return (
      <span
        className="inline-block w-3 h-3 rounded-full bg-fvp-warn shadow-inner mx-1 select-none"
        title={
          hasSavedSnapshot
            ? "Unsaved changes since the last .free export. Press Ctrl+S to export."
            : "Not yet exported to a .free file. Autosave is keeping your work safe, but press Ctrl+S to create a real profile."
        }
        aria-label="Unsaved changes"
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center w-3 h-3 rounded-full bg-fvp-ok text-white mx-1 select-none"
      style={{ fontSize: 9, lineHeight: 1 }}
      title="Saved to a .free file. No edits since the last export."
      aria-label="Saved"
    >
      ✓
    </span>
  );
}

/** Toolbar button → opens the Movie Info modal in edit mode. */
function MovieInfoButton() {
  const [open, setOpen] = useState(false);
  const movieTitle = useAppStore((s) => s.movieTitle);
  const hasInfo = movieTitle != null && movieTitle.length > 0;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={
          hasInfo
            ? `Movie info: ${movieTitle}\nClick to edit (MAPS rating, plot, cast, etc.)`
            : "Add movie info — title, MAPS rating, plot, cast, etc. Auto-fillable from TMDb."
        }
        className={clsx(
          "px-2 py-1 rounded text-[11px] cursor-pointer border",
          hasInfo
            ? "bg-fvp-accent/15 text-fvp-accent hover:bg-fvp-accent/25 border-transparent"
            : "bg-fvp-warn/10 text-fvp-warn hover:bg-fvp-warn/20 border-dashed border-fvp-warn/40",
        )}
      >
        {hasInfo ? "🎬 Movie info" : "+ Movie info…"}
      </button>
      {open && <MovieInfoModal mode="edit" onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * Toolbar icon that takes the user to Settings → Author handle. Compact
 * (matches the visual weight of other toolbar icons) so it doesn't crowd
 * the bar. When the user hasn't set a handle yet, the icon turns amber to
 * nudge them — same visual language as the IMDb-link button.
 */
function AuthorHandleIconButton() {
  const authorHandle = useAppStore((s) => s.authorHandle);
  const setMode = useAppStore((s) => s.setMode);
  const handleSet = authorHandle != null && authorHandle.length > 0;
  return (
    <button
      onClick={() => {
        setMode("settings");
        // Scroll the relevant Settings section into view once it's
        // mounted. 50ms is a safe defer past React's commit cycle.
        window.setTimeout(() => {
          document
            .getElementById("settings-section-author-handle")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 60);
      }}
      title={
        handleSet
          ? `Author handle: "${authorHandle}" — click to edit in Settings.`
          : "Set an anonymous author handle. Saved with each profile's edit history so people who like your profiles can find more of your work."
      }
      className={clsx(
        "px-2 py-1 rounded text-[11px] cursor-pointer border",
        handleSet
          ? "bg-fvp-accent/15 text-fvp-accent hover:bg-fvp-accent/25 border-transparent"
          : "bg-fvp-warn/10 text-fvp-warn hover:bg-fvp-warn/20 border-dashed border-fvp-warn/40",
      )}
      aria-label="Set author handle"
    >
      {handleSet ? `✓ ${authorHandle}` : "+ author handle…"}
    </button>
  );
}

function ImdbLinkButton() {
  const imdbUrl = useAppStore((s) => s.imdbUrl);
  const set = imdbUrl != null;
  return (
    <button
      onClick={() =>
        window.dispatchEvent(new CustomEvent("fvp:request-imdb-link"))
      }
      title={
        set
          ? `IMDb parental guide: ${imdbUrl}\nClick to edit or remove.`
          : "Add an IMDb parental-guide URL. Saved with the .free profile as a categorization reference."
      }
      // When empty: amber dashed border to nudge "fill me in".
      // When set: subdued accent fill to fade into the toolbar.
      className={clsx(
        "px-2 py-1 rounded text-[11px] cursor-pointer border",
        set
          ? "bg-fvp-accent/15 text-fvp-accent hover:bg-fvp-accent/25 border-transparent"
          : "bg-fvp-warn/10 text-fvp-warn hover:bg-fvp-warn/20 border-dashed border-fvp-warn/40",
      )}
    >
      {set ? "✓ IMDb link" : "+ IMDb link…"}
    </button>
  );
}

/* ───────────────────────── Snip list rail (left) ───────────────────────── */

function SnipListRail() {
  const snips = useAppStore((s) => s.snips);
  const selectedSnipIds = useAppStore((s) => s.selectedSnipIds);
  const selectSnip = useAppStore((s) => s.selectSnip);
  const toggleSnipSelection = useAppStore((s) => s.toggleSnipSelection);
  const selectSnipRange = useAppStore((s) => s.selectSnipRange);
  const filter = useAppStore((s) => s.snipFilterCategory);
  const setFilter = useAppStore((s) => s.setSnipFilterCategory);
  const needsReview = snips.filter((s) => s.categories.length === 0).length;

  // Tally snips per category so the rail shows "language · 5, sex · 3, …"
  const categoryCounts = (() => {
    const map = new Map<string, number>();
    for (const s of snips) {
      if (s.categories.length === 0) {
        map.set("(uncategorized)", (map.get("(uncategorized)") ?? 0) + 1);
      }
      for (const c of s.categories) map.set(c, (map.get(c) ?? 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  })();

  const visibleSnips = filter
    ? snips.filter((s) =>
        filter === "(uncategorized)"
          ? s.categories.length === 0
          : s.categories.includes(filter),
      )
    : snips;

  return (
    <aside className="w-60 shrink-0 bg-fvp-surface border-r border-fvp-border overflow-auto select-none flex flex-col">
      <header className="px-3 py-2 border-b border-fvp-border shrink-0">
        <div className="text-xs font-semibold text-fvp-text">Snips</div>
      </header>
      <div className="px-3 py-2 text-[11px] text-fvp-muted border-b border-fvp-border shrink-0">
        {snips.length} snip{snips.length === 1 ? "" : "s"} · {needsReview} need review
      </div>
      {categoryCounts.length > 0 && (
        <div className="px-2 py-2 border-b border-fvp-border shrink-0 flex flex-wrap gap-1">
          {categoryCounts.map(([cat, count]) => {
            const active = filter === cat;
            const color =
              cat === "(uncategorized)" ? "#8a8f9c" : CATEGORY_COLOR[cat] ?? "#79c0ff";
            return (
              <button
                key={cat}
                onClick={() => setFilter(active ? null : cat)}
                title={
                  active
                    ? `Clear filter (showing ${count} ${cat})`
                    : `Filter to ${count} ${cat} snip${count === 1 ? "" : "s"}`
                }
                className={clsx(
                  "px-1.5 py-0.5 rounded-full text-[10px] border whitespace-nowrap",
                  active
                    ? "border-transparent text-white"
                    : "bg-fvp-bg border-fvp-border text-fvp-muted hover:text-fvp-text",
                )}
                style={active ? { backgroundColor: color } : undefined}
              >
                {cat} · {count}
              </button>
            );
          })}
          {filter && (
            <button
              onClick={() => setFilter(null)}
              className="px-1.5 py-0.5 text-[10px] text-fvp-muted hover:text-fvp-err"
              title="Clear category filter"
            >
              ✕ clear
            </button>
          )}
        </div>
      )}
      {snips.length === 0 ? (
        <div className="p-4 text-xs text-fvp-muted">
          <div className="mb-2">No snips yet.</div>
          <div className="text-[11px] leading-relaxed">
            Drag horizontally on the <strong>Snips</strong> row of the timeline below to create one.
          </div>
        </div>
      ) : visibleSnips.length === 0 ? (
        <div className="p-4 text-xs text-fvp-muted">
          No snips match this filter.
        </div>
      ) : (
        <ul className="divide-y divide-fvp-border/50">
          {visibleSnips.map((snip) => {
            const selected = selectedSnipIds.includes(snip.id);
            return (
              <li key={snip.id}>
                <button
                  onClick={(e) => {
                    // Same modifier matrix as the timeline snip click.
                    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
                      if (!selectedSnipIds.includes(snip.id)) selectSnip(snip.id);
                      void playback.seek(snip.start_ms / 1000);
                      return;
                    }
                    if (e.ctrlKey || e.metaKey) {
                      toggleSnipSelection(snip.id);
                      return;
                    }
                    if (e.shiftKey) {
                      selectSnipRange(snip.id);
                      return;
                    }
                    selectSnip(snip.id);
                    if (useAppStore.getState().jumpPlayheadOnSnipSelect) {
                      void playback.seek(snip.start_ms / 1000);
                    }
                  }}
                  className={clsx(
                    "w-full text-left px-3 py-2 flex items-start gap-2 text-xs cursor-pointer",
                    selected
                      ? "bg-fvp-accent/15 border-l-2 border-fvp-accent"
                      : "hover:bg-fvp-surface2 border-l-2 border-transparent",
                  )}
                >
                  <span
                    className="mt-1 inline-block w-2 h-2 rounded-sm shrink-0"
                    style={{ backgroundColor: colorForSnip(snip) }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1 text-fvp-text font-mono tabular-nums text-[11px]">
                      <span>
                        {formatTime(snip.start_ms / 1000)} → {formatTime(snip.end_ms / 1000)}
                      </span>
                      {snip.note && snip.note.length > 0 && (
                        <span
                          className="text-fvp-muted"
                          title={`Note: ${snip.note}`}
                          aria-label="Has note"
                        >
                          📝
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-fvp-muted mt-0.5 truncate">
                      {snip.categories.length > 0
                        ? snip.categories.map(sanitizeForDisplay).join(", ")
                        : "uncategorized"}
                      {" · "}
                      {actionLabel(snip.action)}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

/* ───────────────────────── Snip detail panel (right) ───────────────────────── */

function SnipDetailPanel() {
  const selectedSnipId = useAppStore((s) => s.selectedSnipId);
  const snip = useAppStore((s) => s.snips.find((x) => x.id === selectedSnipId) ?? null);
  const updateSnip = useAppStore((s) => s.updateSnip);
  const removeSnip = useAppStore((s) => s.removeSnip);
  const selectSnip = useAppStore((s) => s.selectSnip);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const dontShowBeepShortenWarning = useAppStore(
    (s) => s.dontShowBeepShortenWarning,
  );
  // When the user picks "Beep" for a snip longer than 3s, hold the pending
  // action here until they confirm the shorten-modal. Cleared on confirm /
  // cancel.
  const [pendingBeep, setPendingBeep] = useState<
    Extract<SnipAction, { type: "beep" }> | null
  >(null);

  return (
    <aside className="w-72 shrink-0 bg-fvp-surface border-l border-fvp-border overflow-auto select-none">
      <header className="px-3 py-2 border-b border-fvp-border text-xs font-semibold text-fvp-text">
        Snip detail
      </header>
      {!snip ? (
        <div className="p-4 text-xs text-fvp-muted">
          <div className="mb-2">No snip selected.</div>
          <div className="text-[11px] leading-relaxed">
            Click a snip in the list or on the timeline to edit it.
          </div>
        </div>
      ) : (
        <div className="p-4 space-y-4">
          <TimeFields
            startMs={snip.start_ms}
            endMs={snip.end_ms}
            onChange={(start_ms, end_ms) => {
              commitToHistory();
              updateSnip(snip.id, { start_ms, end_ms });
            }}
          />
          <ActionPicker
            value={snip.action}
            snipDurationMs={snip.end_ms - snip.start_ms}
            onChange={(action) => {
              const dur = snip.end_ms - snip.start_ms;
              console.log(
                `[fvp:action-picker] onChange: action.type=${action.type}, ` +
                  `snip_duration_ms=${dur}, MAX_BEEP=${MAX_BEEP_DURATION_MS}, ` +
                  `dontShowBeepShortenWarning=${dontShowBeepShortenWarning}`,
              );
              // Beep snips are capped at 3s. For longer snips, either
              // silently auto-shorten (preference suppressed) or open the
              // confirmation modal.
              if (action.type === "beep" && dur > MAX_BEEP_DURATION_MS) {
                if (dontShowBeepShortenWarning) {
                  console.log(
                    `[fvp:action-picker] long beep, suppressed → silent shorten`,
                  );
                  commitToHistory();
                  updateSnip(snip.id, {
                    action,
                    end_ms: snip.start_ms + MAX_BEEP_DURATION_MS,
                  });
                } else {
                  console.log(`[fvp:action-picker] long beep → opening modal`);
                  setPendingBeep(action);
                }
                return;
              }
              console.log(`[fvp:action-picker] applying action directly`);
              commitToHistory();
              updateSnip(snip.id, { action });
            }}
          />
          {pendingBeep && (
            <BeepShortenModal
              currentDurationMs={snip.end_ms - snip.start_ms}
              onConfirm={(suppress) => {
                commitToHistory();
                updateSnip(snip.id, {
                  action: pendingBeep,
                  end_ms: snip.start_ms + MAX_BEEP_DURATION_MS,
                });
                if (suppress) {
                  useAppStore.setState({ dontShowBeepShortenWarning: true });
                }
                setPendingBeep(null);
              }}
              onCancel={() => setPendingBeep(null)}
            />
          )}
          <CategoryPicker
            value={snip.categories}
            onChange={(categories) => {
              commitToHistory();
              updateSnip(snip.id, { categories });
            }}
          />
          <GroupPicker
            value={snip.group_id ?? null}
            onChange={(groupId) => {
              commitToHistory();
              useAppStore.getState().setSnipGroup(snip.id, groupId);
            }}
          />
          <NoteField
            snipId={snip.id}
            value={snip.note ?? ""}
            onChange={(note) =>
              updateSnip(snip.id, { note: note.length > 0 ? note : null })
            }
            onSessionStart={commitToHistory}
          />
          <button
            onClick={() => {
              commitToHistory();
              removeSnip(snip.id);
              selectSnip(null);
            }}
            className="w-full px-3 py-1.5 bg-fvp-err/20 hover:bg-fvp-err text-fvp-err hover:text-white border border-fvp-err/40 rounded text-xs"
            title="Delete this snip"
          >
            Delete snip
          </button>
        </div>
      )}
    </aside>
  );
}

function GroupPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (groupId: string | null) => void;
}) {
  const groups = useAppStore((s) => s.groups);
  return (
    <div className="space-y-1">
      <Label>Group</Label>
      <div className="flex items-center gap-2">
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
          className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text outline-none"
        >
          <option value="">— Ungrouped —</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
        <button
          onClick={() =>
            window.dispatchEvent(new CustomEvent("fvp:request-groups"))
          }
          title="Manage groups (add, rename, delete)"
          className="px-2 py-1 text-[10px] text-fvp-muted hover:text-fvp-text border border-fvp-border rounded cursor-pointer"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}

function TimeFields({
  startMs,
  endMs,
  onChange,
}: {
  startMs: number;
  endMs: number;
  onChange: (start_ms: number, end_ms: number) => void;
}) {
  return (
    <div className="space-y-2">
      <Label>Time range</Label>
      <div className="flex items-center gap-2">
        <TimeInput value={startMs} onChange={(v) => onChange(v, Math.max(v + 100, endMs))} />
        <span className="text-fvp-muted text-xs">→</span>
        <TimeInput value={endMs} onChange={(v) => onChange(Math.min(startMs, v - 100), v)} />
      </div>
      <div className="text-[10px] text-fvp-muted">Duration: {formatTime((endMs - startMs) / 1000)}</div>
    </div>
  );
}

function TimeInput({ value, onChange }: { value: number; onChange: (ms: number) => void }) {
  const [text, setText] = useState(formatTimeMs(value));
  const [editing, setEditing] = useState(false);
  if (!editing && text !== formatTimeMs(value)) setText(formatTimeMs(value));
  return (
    <input
      value={text}
      onFocus={() => setEditing(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const ms = parseTimeMs(text);
        if (ms !== null) onChange(ms);
        else setText(formatTimeMs(value));
        setEditing(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          setText(formatTimeMs(value));
          setEditing(false);
          e.currentTarget.blur();
        }
      }}
      className="bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text font-mono tabular-nums w-24 outline-none"
    />
  );
}

function ActionPicker({
  value,
  snipDurationMs,
  onChange,
}: {
  value: SnipAction;
  snipDurationMs: number;
  onChange: (a: SnipAction) => void;
}) {
  const current = value.type;
  const types = [
    "skip",
    "silence",
    "freeze_frame",
    "audio_replace",
    "beep",
    "mute_dialogue",
    "audio_blur",
    "crop_video",
  ] as const;
  return (
    <div className="space-y-2">
      <Label>Action</Label>
      <div className="grid grid-cols-2 gap-1">
        {types.map((t) => (
          <button
            key={t}
            onClick={() => {
              if (t === "audio_replace") {
                onChange({
                  type: "audio_replace",
                  from_before: true,
                  offset_ms: 0,
                  crossfade_ms: 1500,
                });
              } else if (t === "beep") {
                onChange({
                  type: "beep",
                  freq_hz: BEEP_DEFAULT_FREQ_HZ,
                  level_db: BEEP_DEFAULT_LEVEL_DB,
                });
              } else if (t === "mute_dialogue") {
                onChange({
                  type: "mute_dialogue",
                  mode: "auto",
                  intensity: 100,
                });
              } else if (t === "audio_blur") {
                onChange({
                  type: "audio_blur",
                  mode: "muffled",
                  intensity: 70,
                });
              } else if (t === "crop_video") {
                // Default to a centered 50% rect — gives the user a
                // visible starting handle they can drag from. The
                // CropOverlay then lets them refine on the actual
                // frame.
                onChange({
                  type: "crop_video",
                  x_pct: 0.25,
                  y_pct: 0.25,
                  w_pct: 0.5,
                  h_pct: 0.5,
                });
              } else {
                onChange({ type: t } as SnipAction);
              }
            }}
            className={clsx(
              "px-2 py-1.5 rounded text-xs border",
              current === t
                ? "bg-fvp-accent border-fvp-accent text-white"
                : "bg-fvp-bg border-fvp-border text-fvp-text hover:border-fvp-muted",
            )}
          >
            {actionLabelByType(t)}
          </button>
        ))}
      </div>
      {value.type === "audio_replace" && (
        <AudioReplaceSettings
          value={value}
          snipDurationMs={snipDurationMs}
          onChange={onChange}
        />
      )}
      {value.type === "beep" && (
        <BeepSettings value={value} onChange={onChange} />
      )}
      {value.type === "mute_dialogue" && (
        <MuteDialogueSettings value={value} onChange={onChange} />
      )}
      {value.type === "audio_blur" && (
        <AudioBlurSettings value={value} onChange={onChange} />
      )}
      {value.type === "crop_video" && (
        <CropVideoSettings value={value} onChange={onChange} />
      )}
    </div>
  );
}

/**
 * Settings panel for a crop_video snip. Surfaces the four percentages
 * read-only — the user adjusts the crop by dragging the rectangle on
 * the video itself (CropOverlay). This panel is just feedback +
 * "Reset to centered 50%" button so they always have an out.
 */
function CropVideoSettings({
  value,
  onChange,
}: {
  value: Extract<SnipAction, { type: "crop_video" }>;
  onChange: (a: SnipAction) => void;
}) {
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-fvp-muted leading-relaxed">
        Drag the rectangle on the video to set the crop region. During
        the snip, the rectangle is zoomed to fill the player. Outside
        the snip the video plays uncropped.
      </div>
      <div className="grid grid-cols-2 gap-1 text-[11px] font-mono text-fvp-text">
        <div>x: {pct(value.x_pct)}</div>
        <div>y: {pct(value.y_pct)}</div>
        <div>w: {pct(value.w_pct)}</div>
        <div>h: {pct(value.h_pct)}</div>
      </div>
      <button
        className="text-[11px] px-2 py-1 bg-fvp-bg border border-fvp-border rounded hover:border-fvp-muted text-fvp-text"
        onClick={() =>
          onChange({
            type: "crop_video",
            x_pct: 0.25,
            y_pct: 0.25,
            w_pct: 0.5,
            h_pct: 0.5,
          })
        }
        title="Restore the default centered 50% rectangle"
      >
        Reset to centered 50%
      </button>
    </div>
  );
}

/**
 * Settings panel for a beep snip. Frequency (200-3000 Hz) + level (-40
 * to 0 dB). Sensible defaults keep the tone audible but not jarring.
 * Changes update the running oscillator in real-time via the apply
 * engine's "same snip, refresh settings" path.
 */
function BeepSettings({
  value,
  onChange,
}: {
  value: Extract<SnipAction, { type: "beep" }>;
  onChange: (a: SnipAction) => void;
}) {
  const setFreq = (freq_hz: number) => {
    const clamped = Math.max(200, Math.min(3000, Math.round(freq_hz)));
    onChange({ ...value, freq_hz: clamped });
  };
  const setLevel = (level_db: number) => {
    const clamped = Math.max(-40, Math.min(0, Math.round(level_db)));
    onChange({ ...value, level_db: clamped });
  };

  return (
    <div className="pt-2 space-y-3 border-t border-fvp-border/50">
      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-fvp-muted">Frequency</span>
          <span className="font-mono tabular-nums text-fvp-text">
            {value.freq_hz} Hz
          </span>
        </div>
        <input
          type="range"
          min={200}
          max={3000}
          step={50}
          value={value.freq_hz}
          onChange={(e) => setFreq(parseInt(e.target.value, 10))}
          className="w-full accent-fvp-accent"
        />
        <div className="text-[10px] text-fvp-muted leading-tight">
          1000 Hz is the classic censoring beep. Lower = warmer / less
          piercing, higher = harsher.
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-fvp-muted">Level</span>
          <span className="font-mono tabular-nums text-fvp-text">
            {value.level_db} dB
          </span>
        </div>
        <input
          type="range"
          min={-40}
          max={0}
          step={1}
          value={value.level_db}
          onChange={(e) => setLevel(parseInt(e.target.value, 10))}
          className="w-full accent-fvp-accent"
        />
        <div className="text-[10px] text-fvp-muted leading-tight">
          -22 dB is subtle (default). Anything above ~-12 dB is broadcast-loud
          and uncomfortable in a quiet room.
        </div>
      </div>

      <div className="text-[10px] text-fvp-muted leading-snug bg-fvp-bg/60 border border-fvp-border/50 rounded px-2 py-1.5">
        Beep snips are capped at {MAX_BEEP_DURATION_MS / 1000}s. During the
        snip, the original audio is muted and a sine tone plays in its place.
        Video keeps playing normally.
      </div>
    </div>
  );
}

/**
 * Settings panel for a mute_dialogue snip. Mode picker + intensity slider.
 * No real-time preview — the user has to use the snip's regular AB-toggle
 * play preview to hear the result (per directive: keep the picker
 * lightweight; preview lives in the existing AB-loop infrastructure).
 */
function MuteDialogueSettings({
  value,
  onChange,
}: {
  value: Extract<SnipAction, { type: "mute_dialogue" }>;
  onChange: (a: SnipAction) => void;
}) {
  return (
    <div className="space-y-3 mt-2 p-2 bg-fvp-bg/40 border border-fvp-border rounded">
      <div className="text-[10px] text-fvp-muted leading-relaxed">
        Best-effort. Works well on 5.1+ surround (center channel mute) and
        on stereo with centered dialogue. <strong>Mono sources can&apos;t be
        cleanly separated</strong> — the effect will produce silence in that
        case. Use AB-preview to verify before saving.
      </div>
      <div className="space-y-1">
        <Label>Mode</Label>
        {(Object.entries(MUTE_DIALOGUE_MODE_LABELS) as [MuteDialogueMode, string][]).map(
          ([mode, label]) => (
            <label
              key={mode}
              className={clsx(
                "flex items-start gap-2 cursor-pointer p-1.5 rounded border text-[11px]",
                value.mode === mode
                  ? "border-fvp-accent bg-fvp-accent/10"
                  : "border-fvp-border hover:bg-fvp-surface2/40",
              )}
            >
              <input
                type="radio"
                checked={value.mode === mode}
                onChange={() => onChange({ ...value, mode })}
                className="accent-fvp-accent mt-0.5"
              />
              <span className="text-fvp-text">{label}</span>
            </label>
          ),
        )}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label>
            Intensity{" "}
            <span className="text-fvp-muted text-[10px]">
              (subtract amount for stereo-cancel)
            </span>
          </Label>
          <span className="text-[11px] text-fvp-text tabular-nums">
            {value.intensity}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={value.intensity}
          onChange={(e) =>
            onChange({ ...value, intensity: parseInt(e.target.value, 10) })
          }
          className="w-full accent-fvp-accent"
          disabled={value.mode === "center_channel"}
          title={
            value.mode === "center_channel"
              ? "Center-channel mode doesn't use intensity (mute is binary)."
              : ""
          }
        />
      </div>
    </div>
  );
}

/**
 * Settings panel for an audio_blur snip. Three presets + intensity. Each
 * preset sounds quite different; the descriptions help the user pick
 * before they have to actually listen.
 */
function AudioBlurSettings({
  value,
  onChange,
}: {
  value: Extract<SnipAction, { type: "audio_blur" }>;
  onChange: (a: SnipAction) => void;
}) {
  return (
    <div className="space-y-3 mt-2 p-2 bg-fvp-bg/40 border border-fvp-border rounded">
      <div className="text-[10px] text-fvp-muted leading-relaxed">
        Destroys speech intelligibility while keeping the soundscape. Use
        the snip&apos;s AB-toggle preview to A/B the presets and pick
        whichever sounds best for this scene.
      </div>
      <div className="space-y-1">
        <Label>Preset</Label>
        {(Object.entries(AUDIO_BLUR_MODE_LABELS) as [AudioBlurMode, string][]).map(
          ([mode, label]) => (
            <label
              key={mode}
              className={clsx(
                "flex items-start gap-2 cursor-pointer p-1.5 rounded border text-[11px]",
                value.mode === mode
                  ? "border-fvp-accent bg-fvp-accent/10"
                  : "border-fvp-border hover:bg-fvp-surface2/40",
              )}
            >
              <input
                type="radio"
                checked={value.mode === mode}
                onChange={() => onChange({ ...value, mode })}
                className="accent-fvp-accent mt-0.5"
              />
              <div>
                <div className="text-fvp-text">{label}</div>
                <div className="text-fvp-muted text-[10px] leading-snug">
                  {AUDIO_BLUR_MODE_DESCRIPTIONS[mode]}
                </div>
              </div>
            </label>
          ),
        )}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <Label>
            Intensity{" "}
            <span className="text-fvp-muted text-[10px]">
              {value.mode === "muffled"
                ? "(lowpass cutoff)"
                : value.mode === "garbled_grain"
                  ? "(modulation depth)"
                  : "(phase scramble)"}
            </span>
          </Label>
          <span className="text-[11px] text-fvp-text tabular-nums">
            {value.intensity}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={value.intensity}
          onChange={(e) =>
            onChange({ ...value, intensity: parseInt(e.target.value, 10) })
          }
          className="w-full accent-fvp-accent"
        />
      </div>
    </div>
  );
}

/**
 * Settings panel for an audio_replace snip. Lets the user pick whether the
 * replacement audio comes from before or after the snip, shift the source
 * range with an offset slider (clamped so the source can't overlap the snip
 * itself), and tune the crossfade length.
 *
 * NOTE: the Apply Engine currently degrades audio_replace to Skip — the
 * settings here ARE persisted in the .free file and will be honored once
 * true audio overlay lands (requires ffmpeg / lavfi-complex work).
 */
function AudioReplaceSettings({
  value,
  snipDurationMs,
  onChange,
}: {
  value: Extract<SnipAction, { type: "audio_replace" }>;
  snipDurationMs: number;
  onChange: (a: SnipAction) => void;
}) {
  // Bound for how far the source can slide AWAY from the snip. Generous
  // upper bound; the actual constraint that matters is "can't slide INTO
  // the snip", which clamping enforces directionally.
  const MAX_OFFSET_SECS = 30;

  // For from_before, offset ≤ 0. For from_after, offset ≥ 0.
  // Re-clamp on every direction flip so a leftover positive offset from
  // from_before doesn't immediately overlap when switched to from_after
  // (and vice versa).
  const clampOffset = (raw: number, fromBefore: boolean): number => {
    const max = MAX_OFFSET_SECS * 1000;
    if (fromBefore) {
      // Source spans [snip.start - duration + offset, snip.start + offset]
      // Must have snip.start + offset ≤ snip.start → offset ≤ 0.
      return Math.max(-max, Math.min(0, raw));
    } else {
      // Source spans [snip.end + offset, snip.end + duration + offset]
      // Must have snip.end + offset ≥ snip.end → offset ≥ 0.
      return Math.max(0, Math.min(max, raw));
    }
  };

  const setDirection = (fromBefore: boolean) => {
    onChange({
      type: "audio_replace",
      from_before: fromBefore,
      offset_ms: clampOffset(value.offset_ms, fromBefore),
      crossfade_ms: value.crossfade_ms,
    });
  };

  const setOffset = (offsetMs: number) => {
    onChange({
      ...value,
      offset_ms: clampOffset(offsetMs, value.from_before),
    });
  };

  const setCrossfade = (xfMs: number) => {
    const clamped = Math.max(0, Math.min(5000, xfMs));
    onChange({ ...value, crossfade_ms: clamped });
  };

  const offsetSecs = value.offset_ms / 1000;
  const durationSecs = snipDurationMs / 1000;
  const sliderMin = value.from_before ? -MAX_OFFSET_SECS : 0;
  const sliderMax = value.from_before ? 0 : MAX_OFFSET_SECS;

  return (
    <div className="pt-2 space-y-3 border-t border-fvp-border/50">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="text-fvp-muted shrink-0">Source:</span>
        <button
          onClick={() => setDirection(true)}
          className={clsx(
            "px-2 py-0.5 rounded text-[11px] border",
            value.from_before
              ? "bg-fvp-accent border-fvp-accent text-white"
              : "bg-fvp-bg border-fvp-border text-fvp-text hover:border-fvp-muted",
          )}
        >
          Before snip
        </button>
        <button
          onClick={() => setDirection(false)}
          className={clsx(
            "px-2 py-0.5 rounded text-[11px] border",
            !value.from_before
              ? "bg-fvp-accent border-fvp-accent text-white"
              : "bg-fvp-bg border-fvp-border text-fvp-text hover:border-fvp-muted",
          )}
        >
          After snip
        </button>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-fvp-muted">
            Source offset {value.from_before ? "(earlier)" : "(later)"}
          </span>
          <span className="font-mono tabular-nums text-fvp-text">
            {offsetSecs >= 0 ? "+" : ""}
            {offsetSecs.toFixed(1)}s
          </span>
        </div>
        <input
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={0.1}
          value={offsetSecs}
          onChange={(e) => setOffset(Math.round(parseFloat(e.target.value) * 1000))}
          className="w-full accent-fvp-accent"
        />
        <div className="text-[10px] text-fvp-muted leading-tight">
          Source range: {durationSecs.toFixed(1)}s of audio from{" "}
          {value.from_before
            ? `just before the snip${offsetSecs < 0 ? `, shifted ${Math.abs(offsetSecs).toFixed(1)}s earlier` : ""}`
            : `just after the snip${offsetSecs > 0 ? `, shifted ${offsetSecs.toFixed(1)}s later` : ""}`}
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-fvp-muted">Crossfade</span>
          <span className="font-mono tabular-nums text-fvp-text">
            {(value.crossfade_ms / 1000).toFixed(2)}s
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={5000}
          step={100}
          value={value.crossfade_ms}
          onChange={(e) => setCrossfade(parseInt(e.target.value, 10))}
          className="w-full accent-fvp-accent"
        />
      </div>

      <div className="text-[10px] text-fvp-muted leading-snug bg-fvp-bg/60 border border-fvp-border/50 rounded px-2 py-1.5">
        ⚠ Audio-replace playback is currently <strong>disabled</strong> —
        the live-overlay implementation hit dead-ends (libavfilter PTS-sync
        issues with shifted source streams) and we've bookmarked it for a
        future redesign. Your direction / offset / crossfade settings ARE
        saved in the .free file and will start working once overlay lands.
        For now, audio-replace snips play as Skip (jump past the snip).
      </div>
    </div>
  );
}

/**
 * Free-form text notes for a snip. Saves IMMEDIATELY to the store on
 * every keystroke (cheap, in-memory) — so a fast click-away or window
 * close can't lose work. The store-side autosave already debounces disk
 * writes, so we're not hammering the filesystem.
 *
 * History is bookmarked once per editing session: `onSessionStart` fires
 * on the first keystroke of a session, capturing the pre-edit state in
 * one undo snapshot. Sessions end on blur or when the snip changes, so
 * typing a whole note is one undo step (not one per keystroke).
 *
 * Empty strings are stored as `null` to keep round-tripped .free files
 * clean (matches the Rust schema's `Option<String>`).
 */
function NoteField({
  snipId,
  value,
  onChange,
  onSessionStart,
}: {
  snipId: string;
  value: string;
  onChange: (next: string) => void;
  onSessionStart: () => void;
}) {
  // Session = a continuous block of edits the user is making. Resets when
  // they switch snips, blur the textarea, or load a different file.
  const sessionActive = useRef(false);

  useEffect(() => {
    sessionActive.current = false;
  }, [snipId]);

  return (
    <div className="space-y-1">
      <Label>Note</Label>
      <textarea
        value={value}
        onChange={(e) => {
          if (!sessionActive.current) {
            onSessionStart();
            sessionActive.current = true;
          }
          onChange(e.target.value);
        }}
        onBlur={() => {
          sessionActive.current = false;
        }}
        placeholder="Free-form notes for this snip (visible to you only — saved with the .free file)"
        rows={3}
        className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-xs text-fvp-text outline-none resize-y min-h-[48px] max-h-[200px] leading-relaxed"
      />
      <div className="text-[10px] text-fvp-muted">
        Saved instantly as you type. Persisted in the .free file and the
        per-file draft.
      </div>
    </div>
  );
}

function CategoryPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (categories: string[]) => void;
}) {
  const customCategories = useAppStore((s) => s.customCategories);
  const addCustomCategory = useAppStore((s) => s.addCustomCategory);
  const removeCustomCategory = useAppStore((s) => s.removeCustomCategory);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const allCategories = [...DEFAULT_CATEGORIES, ...customCategories];

  const commitNew = () => {
    const trimmed = newName.trim();
    if (trimmed) {
      addCustomCategory(trimmed);
      // Auto-add the new category to this snip's selection.
      if (!value.includes(trimmed)) onChange([...value, trimmed]);
    }
    setNewName("");
    setAdding(false);
  };

  return (
    <div className="space-y-2">
      <Label>Categories</Label>
      <div className="flex flex-wrap gap-1 items-center">
        {allCategories.map((cat) => {
          const on = value.includes(cat);
          const isCustom = customCategories.includes(cat);
          const color = CATEGORY_COLOR[cat] ?? "#79c0ff";
          return (
            <span key={cat} className="relative inline-flex">
              <button
                onClick={() => onChange(on ? value.filter((c) => c !== cat) : [...value, cat])}
                title={isCustom ? "Custom category" : undefined}
                className={clsx(
                  "px-2 py-0.5 rounded-full text-[10px] border",
                  on
                    ? "border-transparent text-white"
                    : "bg-fvp-bg border-fvp-border text-fvp-muted hover:text-fvp-text",
                )}
                style={on ? { backgroundColor: color } : undefined}
              >
                {cat}
              </button>
              {isCustom && (
                <button
                  onClick={() => {
                    onChange(value.filter((c) => c !== cat));
                    removeCustomCategory(cat);
                  }}
                  title={`Delete custom category "${cat}"`}
                  className="ml-px text-[10px] text-fvp-muted hover:text-fvp-err px-1"
                >
                  ✕
                </button>
              )}
            </span>
          );
        })}
        {adding ? (
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitNew();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setNewName("");
                setAdding(false);
              }
            }}
            onBlur={commitNew}
            placeholder="New category…"
            className="bg-fvp-bg border border-fvp-accent rounded-full px-2 py-0.5 text-[10px] text-fvp-text outline-none w-32"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="px-2 py-0.5 rounded-full text-[10px] border border-dashed border-fvp-muted/60 text-fvp-muted hover:border-fvp-accent hover:text-fvp-accent"
            title="Add a custom category"
          >
            + Custom…
          </button>
        )}
      </div>
      {value.length === 0 && (
        <div className="text-[10px] text-fvp-warn">⚠ Uncategorized — required before export</div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] text-fvp-muted uppercase tracking-wider font-semibold">
      {children}
    </div>
  );
}

/* ───────────────────────── Video preview ───────────────────────── */

/**
 * Brief opaque-black overlay shown for ~700 ms while libmpv's filter
 * graph is being swapped. Without it the transparent webview region
 * over the video shows through the empty mpv HWND during reload
 * (visible as a white-with-ghost-terminal flash). Pointer events pass
 * through so the user can keep clicking timeline controls.
 */
function FiltergraphReloadMask() {
  const reloading = useAppStore((s) => s.mpvFiltergraphReloading);
  if (!reloading) return null;
  return (
    <div
      className="absolute inset-0 bg-black pointer-events-none z-[5]"
      aria-hidden
    />
  );
}

function VideoPreviewArea({
  hasFile,
  videoRef,
}: {
  hasFile: boolean;
  videoRef: React.RefObject<HTMLDivElement | null>;
}) {
  const freezeFrameSrc = useAppStore((s) => s.freezeFrameSrc);
  const loading = useAppStore((s) => s.loading);
  return (
    <div
      ref={videoRef as React.RefObject<HTMLDivElement>}
      // MUST stay transparent (no bg-* class). The intermediate libmpv
      // HWND sits BEHIND the WebView2 in the sibling z-order on the
      // Tauri window. An opaque background here covers the video.
      // LoadingOverlay still paints on top of this when state.loading
      // is true to mask the brief HWND-clear gap on file open.
      className="flex-1 min-h-0 relative"
      style={{ background: "transparent" }}
    >
      {freezeFrameSrc && (
        <img
          src={freezeFrameSrc}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-contain bg-black pointer-events-none z-10"
        />
      )}
      {/* Lavfi-complex reload mask. When applyAudioOverlay /
          clearAudioOverlay tells libmpv to swap the filter graph,
          mpv reloads the file; for ~half a second its child HWND
          can be blank and the user sees through the transparent
          webview to the terminal / desktop. The mask covers that
          window with a solid black div until the reload settles. */}
      {hasFile && <FiltergraphReloadMask />}
      {/* Crop editor overlay — only renders when the primary-selected
          snip is a crop_video. Pointer events pass through outside the
          rect + handles, so the rest of the video area still receives
          clicks normally. */}
      {hasFile && <CropOverlay />}
      {/* Loading takes precedence over no-file (same precedence as
          Player Mode). Black overlay + spinner masks the libmpv HWND
          during the attach gap, killing the white flash. */}
      {loading ? (
        <LoadingOverlay />
      ) : (
        !hasFile && (
          <div className="absolute inset-0 bg-fvp-bg flex items-center justify-center text-fvp-muted text-sm">
            <div className="text-center">
              <div className="text-fvp-text text-base mb-2">No file loaded</div>
              <div className="text-xs mb-4">Open a file to start editing snips.</div>
              <button
                onClick={() => void openFileFlow()}
                className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded hover:opacity-90"
              >
                Open file…
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
}

/* ───────────────────────── Timeline (full width below rails) ───────────────────────── */

const LABEL_COL_PX = 44;
const RESIZE_HANDLE_PX = 5;
const LANE_HEIGHT_PX = 22;
const VISIBLE_LANES = 5; // snip area shows ~5 lanes before scrolling
const MIN_VIEW_MS = 1000; // can't zoom in tighter than 1 second
const ZOOM_FACTOR = 1.25;

// Lane assignment is stored per-snip in appStore.snipLanes and assigned at
// creation time (see appStore.findLowestFreeLane). The timeline reads from
// snipLanes directly so resizing/moving doesn't shuffle lanes.

function TimelinePanel() {
  const duration = useAppStore((s) => s.duration);
  const currentFile = useAppStore((s) => s.currentFile);
  const snips = useAppStore((s) => s.snips);
  const selectedSnipId = useAppStore((s) => s.selectedSnipId);
  const activeSnipEdge = useAppStore((s) => s.activeSnipEdge);
  const view = useAppStore((s) => s.timelineView);
  const selectSnip = useAppStore((s) => s.selectSnip);
  const addSnip = useAppStore((s) => s.addSnip);
  const setTimelineView = useAppStore((s) => s.setTimelineView);

  const trackRef = useRef<HTMLDivElement>(null);
  const snipLayerRef = useRef<HTMLDivElement>(null);
  const wheelTargetRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ startMs: number; endMs: number } | null>(null);
  const snipLanes = useAppStore((s) => s.snipLanes);

  const totalDurationMs = duration * 1000;

  // Reset view to fit-all when the loaded file (and therefore duration) changes.
  const prevFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentFile !== prevFileRef.current) {
      prevFileRef.current = currentFile;
      setTimelineView({ startMs: 0, endMs: 0 });
    }
  }, [currentFile, setTimelineView]);
  useEffect(() => {
    if (totalDurationMs > 0 && view.endMs === 0) {
      setTimelineView({ startMs: 0, endMs: totalDurationMs });
    }
  }, [totalDurationMs, view.endMs, setTimelineView]);

  const viewDurationMs = Math.max(1, view.endMs - view.startMs);

  // Playhead = state.position straight from the push-event bridge. No rAF
  // interpolation: libmpv tells us the actual frame time on every frame so we
  // just render that. Speed changes, pauses, seeks — all reflected immediately.
  const playheadPos = useAppStore((s) => s.position);

  // Playhead-follow auto-scroll: subscribe to position changes via zustand and
  // nudge the timeline view to keep the playhead in frame while playing.
  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prev) => {
      if (!state.playing || state.position === prev.position) return;
      if (state.duration <= 0) return;
      const total = state.duration * 1000;
      const v = state.timelineView;
      const vd = v.endMs - v.startMs;
      if (vd <= 0 || vd >= total) return;
      const head = state.position * 1000;
      const ratio = (head - v.startMs) / vd;
      if (ratio > 0.85 || ratio < -0.05) {
        const newStart = Math.max(0, Math.min(total - vd, head - vd * 0.15));
        if (Math.abs(newStart - v.startMs) > 2) {
          state.setTimelineView({ startMs: newStart, endMs: newStart + vd });
        }
      }
    });
    return unsub;
  }, []);

  const playheadMs = playheadPos * 1000;
  const playheadPct = viewDurationMs > 0 ? ((playheadMs - view.startMs) / viewDurationMs) * 100 : 0;
  const playheadInView = playheadPct >= 0 && playheadPct <= 100;

  const msFromX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || totalDurationMs <= 0) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return view.startMs + ratio * viewDurationMs;
  };

  // Middle-click drag to pan the timeline view (Vegas-style).
  const handleRootMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const startX = e.clientX;
    const startView = useAppStore.getState().timelineView;
    const trackWidth = trackRef.current?.getBoundingClientRect().width ?? 1;
    const vd = startView.endMs - startView.startMs;
    const total = useAppStore.getState().duration * 1000;
    if (vd <= 0 || total <= 0) return;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const panMs = -dx * (vd / trackWidth);
      const newStart = Math.max(0, Math.min(total - vd, startView.startMs + panMs));
      useAppStore.getState().setTimelineView({ startMs: newStart, endMs: newStart + vd });
    };
    const onUp = (ev: MouseEvent) => {
      if (ev.button !== 1) return;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Wheel: pan / zoom / vertical scroll. Must be non-passive to preventDefault.
  useEffect(() => {
    const el = wheelTargetRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      const state = useAppStore.getState();
      const v = state.timelineView;
      const total = state.duration * 1000;
      if (total <= 0) return;
      const vd = Math.max(1, v.endMs - v.startMs);

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Zoom centered on cursor X. Negative deltaY = scroll up = zoom in.
        const rect = trackRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cursorX = e.clientX - rect.left;
        const ratio = Math.min(1, Math.max(0, cursorX / rect.width));
        const cursorMs = v.startMs + ratio * vd;
        const factor = e.deltaY < 0 ? ZOOM_FACTOR : 1 / ZOOM_FACTOR;
        let newDuration = Math.min(total, Math.max(MIN_VIEW_MS, vd / factor));
        let newStart = cursorMs - ratio * newDuration;
        newStart = Math.max(0, Math.min(total - newDuration, newStart));
        setTimelineView({ startMs: newStart, endMs: newStart + newDuration });
        return;
      }

      if (e.shiftKey) {
        // Vertical scroll inside the snip layer (lanes).
        e.preventDefault();
        if (snipLayerRef.current) {
          snipLayerRef.current.scrollTop += e.deltaY;
        }
        return;
      }

      // Plain wheel: horizontal pan. Use whichever axis the device reports.
      e.preventDefault();
      const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      const panMs = (delta / 100) * vd * 0.25;
      const newStart = Math.max(0, Math.min(total - vd, v.startMs + panMs));
      setTimelineView({ startMs: newStart, endMs: newStart + vd });
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [setTimelineView]);

  const handleRulerMouseDown = (e: React.MouseEvent) => {
    if (totalDurationMs <= 0) return;
    e.preventDefault();
    void playback.seek(msFromX(e.clientX) / 1000);
    // Ruler interactions also deselect the currently selected snip — the user
    // is navigating away from the snip context.
    useAppStore.getState().selectSnip(null);
    useAppStore.setState({ activeSnipEdge: null });
    const onMove = (ev: MouseEvent) => void playback.seek(msFromX(ev.clientX) / 1000);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleSnipLayerMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Gate on currentFile, not just totalDurationMs — state.duration can be
    // stale from a previously-loaded file. Without a real video loaded,
    // creating a snip makes no sense (and has no fingerprint to anchor to).
    if (!useAppStore.getState().currentFile || totalDurationMs <= 0) return;
    if ((e.target as HTMLElement).dataset.snipBlock || (e.target as HTMLElement).dataset.snipHandle) return;
    e.preventDefault();
    const startMs = msFromX(e.clientX);
    const startClientX = e.clientX;
    setDrag({ startMs, endMs: startMs });
    let didMove = false;
    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startClientX) > 3) didMove = true;
      setDrag({ startMs, endMs: msFromX(ev.clientX) });
    };
    const onUp = (ev: MouseEvent) => {
      const endMs = msFromX(ev.clientX);
      const lo = Math.min(startMs, endMs);
      const hi = Math.max(startMs, endMs);
      if (didMove && hi - lo >= 250) {
        const id =
          (globalThis.crypto?.randomUUID?.() as string | undefined) ??
          `snip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        useAppStore.getState().commitToHistory();
        addSnip({
          id,
          start_ms: Math.round(lo),
          end_ms: Math.round(hi),
          categories: [],
          action: { type: "skip" },
          group_id: null,
          note: null,
        });
      } else if (!didMove) {
        // Plain click on empty timeline → deselect any selected snip / edge.
        useAppStore.getState().selectSnip(null);
        useAppStore.setState({ activeSnipEdge: null });
      }
      setDrag(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Edge interaction:
  //   • Click          → activate edge, seek playhead to the edge.
  //   • Drag           → scrubs video to the new edge position in real time.
  //   • Ctrl-drag      → 4× slower for precision.
  //   • Shift-drag     → 16× slower for very fine control.
  // After drag the edge stays active so hotkey nudging continues.
  const handleEdgeMouseDown =
    (snip: Snip, edge: "start" | "end") => (e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      e.preventDefault();

      useAppStore.setState({
        activeSnipEdge: { snipId: snip.id, edge },
        selectedSnipId: snip.id,
      });
      useAppStore.getState().commitToHistory();

      const initialEdgeMs = edge === "start" ? snip.start_ms : snip.end_ms;
      void playback.seek(initialEdgeMs / 1000);

      const startX = e.clientX;
      let prevX = startX;
      let accumMs = 0;
      let dragged = false;

      const onMove = (ev: MouseEvent) => {
        if (!dragged && Math.abs(ev.clientX - startX) < 3) return;
        dragged = true;
        const trackRect = trackRef.current?.getBoundingClientRect();
        if (!trackRect) return;
        const msPerPx = viewDurationMs / trackRect.width;
        const slow = ev.shiftKey ? 16 : ev.ctrlKey || ev.metaKey ? 4 : 1;
        const dxFrame = ev.clientX - prevX;
        prevX = ev.clientX;
        accumMs += (dxFrame / slow) * msPerPx;
        const newMs = initialEdgeMs + accumMs;

        const current = useAppStore.getState().snips.find((s) => s.id === snip.id);
        if (!current) return;
        if (edge === "start") {
          const newStart = Math.max(0, Math.min(newMs, current.end_ms - 100));
          useAppStore.getState().updateSnip(snip.id, { start_ms: Math.round(newStart) });
          void playback.seek(newStart / 1000);
        } else {
          const newEnd = Math.min(totalDurationMs, Math.max(newMs, current.start_ms + 100));
          useAppStore.getState().updateSnip(snip.id, { end_ms: Math.round(newEnd) });
          void playback.seek(newEnd / 1000);
        }
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    };

  const dragPct = useMemo(() => {
    if (!drag || viewDurationMs <= 0) return null;
    const lo = Math.min(drag.startMs, drag.endMs);
    const hi = Math.max(drag.startMs, drag.endMs);
    return {
      leftPct: ((lo - view.startMs) / viewDurationMs) * 100,
      widthPct: ((hi - lo) / viewDurationMs) * 100,
    };
  }, [drag, viewDurationMs, view.startMs]);

  const laneCount = useMemo(
    () => Math.max(1, ...Object.values(snipLanes).map((v) => v + 1), 1),
    [snipLanes],
  );

  // Snip layer is up to VISIBLE_LANES tall before scroll. Scrollable when more.
  // Snip area grows to fit all lanes with VISIBLE_LANES as a minimum. NOT a
  // scrolling box — a scrollbar would reserve ~15px on the right and break
  // pixel-perfect alignment between the snip body and the playhead (which
  // lives in a separate non-scrolling container).
  const snipLayerHeight =
    Math.max(VISIBLE_LANES, Math.max(1, laneCount)) * LANE_HEIGHT_PX + 4;
  const snipLayerVisibleHeight = snipLayerHeight;
  const snipLayerContentHeight = snipLayerHeight;

  return (
    <div
      ref={wheelTargetRef}
      onMouseDown={handleRootMouseDown}
      onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }}
      className="shrink-0 bg-fvp-surface2 border-t border-fvp-border overflow-hidden select-none flex flex-col"
    >
      {/* Ruler row */}
      <div className="flex h-8 bg-fvp-surface border-b border-fvp-border shrink-0">
        <div
          className="shrink-0 border-r border-fvp-border flex items-center justify-center text-[10px] text-fvp-muted"
          style={{ width: LABEL_COL_PX }}
          title="Scroll: pan · Ctrl+scroll: zoom · Shift+scroll: scroll lanes"
        >
          {formatTimeShort(view.startMs)}
        </div>
        <div
          ref={trackRef}
          onMouseDown={handleRulerMouseDown}
          className="flex-1 relative cursor-pointer"
          title={totalDurationMs > 0 ? "Click or drag to scrub · scroll to pan · Ctrl+scroll to zoom · middle-click drag to pan" : ""}
        >
          <TickMarks viewStartMs={view.startMs} viewEndMs={view.endMs} />
          <RulerMarkers
            viewStartMs={view.startMs}
            viewEndMs={view.endMs}
          />
        </div>
      </div>

      {/* Layers area. WF (waveform) and Sc (scene-cut) placeholders used to
          sit above the snip lanes here; they were never wired to real data
          and took vertical space. Snips lane is the only meaningful row,
          with the waveform planned to overlay it as ghost background. */}
      <div className="flex flex-col relative">
        <SnipLayer
          ref={snipLayerRef}
          snips={snips}
          snipLanes={snipLanes}
          selectedId={selectedSnipId}
          activeEdge={activeSnipEdge}
          viewStartMs={view.startMs}
          viewDurationMs={viewDurationMs}
          totalDurationMs={totalDurationMs}
          dragPct={dragPct}
          visibleHeight={snipLayerVisibleHeight}
          contentHeight={snipLayerContentHeight}
          msFromX={msFromX}
          onMouseDown={handleSnipLayerMouseDown}
          onSelect={selectSnip}
          onEdgeMouseDown={handleEdgeMouseDown}
        />
        <SubsLayer viewStartMs={view.startMs} viewEndMs={view.endMs} />

        {/* Playhead — track-only sub-region. Outside view → hidden. */}
        {totalDurationMs > 0 && playheadInView && (
          <div
            className="absolute pointer-events-none top-0 bottom-0"
            style={{ left: LABEL_COL_PX, right: 0 }}
          >
            {/* 0-width anchor at playheadPct% — children are positioned with
                negative offsets so they're geometrically centered on the position
                regardless of their own widths. */}
            <div
              className="absolute top-0 bottom-0"
              style={{ left: `${playheadPct}%`, width: 0 }}
            >
              <div
                className="absolute top-0 bottom-0 bg-fvp-accent"
                style={{ left: -1, width: 2 }}
              />
              <div
                className="absolute bg-fvp-accent rotate-45"
                style={{ left: -6, top: -2, width: 12, height: 12 }}
              />
            </div>
          </div>
        )}
      </div>

      <MiniMap totalMs={totalDurationMs} playheadMs={playheadMs} />
    </div>
  );
}

/* ───────────────────────── Markers on ruler ───────────────────────── */

function RulerMarkers({
  viewStartMs,
  viewEndMs,
}: {
  viewStartMs: number;
  viewEndMs: number;
}) {
  const markers = useAppStore((s) => s.markers);
  const flags = useAppStore((s) => s.flags);
  const viewDurationMs = viewEndMs - viewStartMs;
  if (viewDurationMs <= 0) return null;
  // Flags and markers render IDENTICALLY (per spec — flags are just
  // auto-created markers). We tag the flag's color a touch dimmer so the
  // user can distinguish "I placed this" vs "AutoSnip placed this" if they
  // squint, but the affordances and tab-nav treat them the same.
  type Item =
    | { kind: "marker"; ms: number; name: string }
    | { kind: "flag"; ms: number; name: string; category: string; keyword: string; text: string };
  const items: Item[] = [
    ...markers.map((m): Item => ({ kind: "marker", ms: m.ms, name: m.name })),
    ...flags.map((f): Item => ({
      kind: "flag",
      ms: f.ms,
      name: f.name,
      category: f.category,
      keyword: f.keyword,
      text: f.subtitleText,
    })),
  ];
  return (
    <>
      {items.map((item, idx) => {
        if (item.ms < viewStartMs || item.ms > viewEndMs) return null;
        const pct = ((item.ms - viewStartMs) / viewDurationMs) * 100;
        const color = item.kind === "flag" ? "bg-fvp-accent/80 hover:bg-fvp-accent" : "bg-fvp-warn/90 hover:bg-fvp-warn";
        const labelColor = item.kind === "flag" ? "text-fvp-accent" : "text-fvp-warn";
        const tooltip =
          item.kind === "flag"
            ? `${item.name} · ${formatTime(item.ms / 1000)}\n"${item.text}"\nRight-click for options`
            : `${item.name} · ${formatTime(item.ms / 1000)} · right-click for options`;
        return (
          // Include index — multiple flags can share the same `ms` (one
          // subtitle entry with several keyword matches all generate
          // flags at the entry's start_ms). Keying by ms alone collided
          // on those duplicates and React's reconciliation reused DOM
          // nodes across renders, leaving "ghost" copies stuck at old
          // pixel positions after zoom/pan.
          <div
            key={`${item.kind}-${idx}-${item.ms}`}
            className="absolute top-0 bottom-0 pointer-events-none"
            style={{ left: `${pct}%` }}
          >
            <div
              onClick={(e) => {
                e.stopPropagation();
                void playback.seek(item.ms / 1000);
              }}
              onContextMenu={() => {
                window.dispatchEvent(
                  new CustomEvent("fvp:marker-right-click", { detail: item }),
                );
              }}
              className={`absolute top-0 bottom-0 w-1 -translate-x-1/2 cursor-pointer pointer-events-auto ${color}`}
              title={tooltip}
            />
            <div
              className={`absolute top-1/2 -translate-y-1/2 left-1.5 px-1 py-px text-[9px] bg-fvp-surface/80 rounded-sm whitespace-nowrap pointer-events-none ${labelColor}`}
            >
              {item.name}
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ───────────────────────── Mini-map (overview bar) ───────────────────────── */

function MiniMap({
  totalMs,
  playheadMs,
}: {
  totalMs: number;
  playheadMs: number;
}) {
  const view = useAppStore((s) => s.timelineView);
  const snips = useAppStore((s) => s.snips);
  const markers = useAppStore((s) => s.markers);
  const setTimelineView = useAppStore((s) => s.setTimelineView);
  const barRef = useRef<HTMLDivElement>(null);

  if (totalMs <= 0) return null;
  const vd = view.endMs - view.startMs;
  const viewLeftPct = (view.startMs / totalMs) * 100;
  const viewWidthPct = (vd / totalMs) * 100;

  const recenterAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const center = ratio * totalMs;
    const newStart = Math.max(0, Math.min(totalMs - vd, center - vd / 2));
    setTimelineView({ startMs: newStart, endMs: newStart + vd });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    recenterAt(e.clientX);
    const onMove = (ev: MouseEvent) => recenterAt(ev.clientX);
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const jumpToStart = () => {
    void playback.seek(0);
    setTimelineView({ startMs: 0, endMs: vd });
  };
  const jumpToEnd = () => {
    void playback.seek(totalMs / 1000);
    setTimelineView({ startMs: Math.max(0, totalMs - vd), endMs: totalMs });
  };

  return (
    <div className="flex h-5 bg-fvp-bg border-t border-fvp-border shrink-0">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          jumpToStart();
        }}
        title="Jump to start (Home)"
        className="shrink-0 border-r border-fvp-border bg-fvp-surface hover:bg-fvp-surface2 text-fvp-muted hover:text-fvp-text text-[11px] flex items-center justify-center cursor-pointer"
        style={{ width: LABEL_COL_PX }}
      >
        «
      </button>
      <div
        ref={barRef}
        onMouseDown={handleMouseDown}
        className="flex-1 relative cursor-pointer"
        title="Mini-map · click or drag to pan view"
      >
        {snips.map((s) => {
          const pct = (s.start_ms / totalMs) * 100;
          return (
            <div
              key={s.id}
              className="absolute top-0 bottom-0 w-px bg-fvp-muted/50"
              style={{ left: `${pct}%` }}
            />
          );
        })}
        {markers.map((m, idx) => (
          <div
            key={`marker-${idx}-${m.ms}`}
            className="absolute top-0 bottom-0 w-px bg-fvp-warn"
            style={{ left: `${(m.ms / totalMs) * 100}%` }}
            title={m.name}
          />
        ))}
        <div
          className="absolute top-0 bottom-0 bg-fvp-accent/25 border border-fvp-accent/70 pointer-events-none"
          style={{ left: `${viewLeftPct}%`, width: `${Math.max(0.5, viewWidthPct)}%` }}
        />
        <div
          className="absolute top-0 bottom-0 w-px bg-fvp-accent pointer-events-none"
          style={{ left: `${(playheadMs / totalMs) * 100}%` }}
        />
      </div>
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          jumpToEnd();
        }}
        title="Jump to end (End)"
        className="shrink-0 border-l border-fvp-border bg-fvp-surface hover:bg-fvp-surface2 text-fvp-muted hover:text-fvp-text text-[11px] flex items-center justify-center cursor-pointer"
        style={{ width: LABEL_COL_PX }}
      >
        »
      </button>
    </div>
  );
}

function TickMarks({
  viewStartMs,
  viewEndMs,
}: {
  viewStartMs: number;
  viewEndMs: number;
}) {
  const viewDurationMs = viewEndMs - viewStartMs;
  if (viewDurationMs <= 0) return null;
  const viewMinutes = viewDurationMs / 60_000;
  // When zoomed in (< 10 min visible): per-minute labels + 10-sec sub-ticks.
  // Otherwise: per-10-minute labels + per-minute sub-ticks (no labels on subs).
  const labelEveryMin = viewMinutes < 10 ? 1 : 10;
  const subTickStepMs = viewMinutes < 10 ? 10_000 : 60_000;

  const nodes: React.ReactNode[] = [];

  // Minute marks (with labels every labelEveryMin)
  const firstMinute = Math.floor(viewStartMs / 60_000);
  const lastMinute = Math.ceil(viewEndMs / 60_000);
  for (let m = firstMinute; m <= lastMinute; m++) {
    const tMs = m * 60_000;
    if (tMs < viewStartMs || tMs > viewEndMs) continue;
    const pct = ((tMs - viewStartMs) / viewDurationMs) * 100;
    const labeled = m % labelEveryMin === 0;
    nodes.push(
      <div
        key={`m-${m}`}
        className="absolute top-0 pointer-events-none"
        style={{ left: `${pct}%` }}
      >
        <div className={labeled ? "w-px h-3 bg-fvp-text" : "w-px h-1.5 bg-fvp-muted"} />
        {labeled && (
          <div className="absolute top-3 left-0 text-[9px] text-fvp-muted whitespace-nowrap -translate-x-1/2">
            {m}m
          </div>
        )}
      </div>,
    );
  }

  // Sub-ticks at subTickStepMs (skip those that align with minute marks).
  const firstSub = Math.floor(viewStartMs / subTickStepMs);
  const lastSub = Math.ceil(viewEndMs / subTickStepMs);
  for (let i = firstSub; i <= lastSub; i++) {
    const tMs = i * subTickStepMs;
    if (tMs < viewStartMs || tMs > viewEndMs) continue;
    if (tMs % 60_000 === 0) continue; // already drawn as minute mark
    const pct = ((tMs - viewStartMs) / viewDurationMs) * 100;
    nodes.push(
      <div
        key={`s-${i}`}
        className="absolute top-0 pointer-events-none w-px h-1 bg-fvp-muted/60"
        style={{ left: `${pct}%` }}
      />,
    );
  }

  return <>{nodes}</>;
}

function formatTimeShort(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Renders subtitle entries with filter-chain awareness — entries that fall
 *  entirely inside a Skip snip are drawn in red (they'd be dropped per
 *  directives.md's "Skip snips: any subtitle entry whose time range falls
 *  inside the cut is dropped" rule). Entries partially inside are drawn in
 *  warn-orange. Untouched entries are muted gray as before. */
function SubEntriesWithFilter({
  entries,
  viewStartMs,
  viewEndMs,
  viewDurationMs,
}: {
  entries: import("../ipc/subtitles").SubtitleEntry[];
  viewStartMs: number;
  viewEndMs: number;
  viewDurationMs: number;
}) {
  const snips = useAppStore((s) => s.snips);
  const skipSnips = snips.filter((s) => s.action.type === "skip");
  return (
    <>
      {entries.map((e, i) => {
        if (e.end_ms < viewStartMs || e.start_ms > viewEndMs) return null;
        const leftPct = ((e.start_ms - viewStartMs) / viewDurationMs) * 100;
        const widthPct = ((e.end_ms - e.start_ms) / viewDurationMs) * 100;
        const insideSkip = skipSnips.some(
          (s) => s.start_ms <= e.start_ms && e.end_ms <= s.end_ms,
        );
        const partialSkip =
          !insideSkip &&
          skipSnips.some(
            (s) => s.end_ms > e.start_ms && s.start_ms < e.end_ms,
          );
        const color = insideSkip
          ? "bg-fvp-err/60 hover:bg-fvp-err"
          : partialSkip
            ? "bg-fvp-warn/50 hover:bg-fvp-warn"
            : "bg-fvp-muted/40 hover:bg-fvp-muted/80";
        const status = insideSkip
          ? "\n⚠ Dropped by Skip snip"
          : partialSkip
            ? "\n⚠ Partially overlapped by Skip snip"
            : "";
        return (
          <div
            key={i}
            className={`absolute top-1 bottom-1 rounded-sm pointer-events-auto ${color}`}
            style={{
              left: `${leftPct}%`,
              width: `${Math.max(widthPct, 0.1)}%`,
            }}
            title={`${e.text}\n${(e.start_ms / 1000).toFixed(1)}s → ${(e.end_ms / 1000).toFixed(1)}s${status}`}
          />
        );
      })}
    </>
  );
}

/** Subs row that renders subtitle entries (from an external .srt loaded via
 *  Add subtitle file) as thin blocks on the timeline. Also handles its own
 *  right-click → "Add subtitle file" menu request (the document handler
 *  catches it; we just need the menu to know we right-clicked here). */
function SubsLayer({
  viewStartMs,
  viewEndMs,
}: {
  viewStartMs: number;
  viewEndMs: number;
}) {
  const entries = useAppStore((s) => s.subtitleEntries);
  const hasFile = useAppStore((s) => s.currentFile !== null);
  const extracting = useAppStore((s) => s.extractingSubtitles);
  const viewDurationMs = Math.max(1, viewEndMs - viewStartMs);
  return (
    <div className="h-6 flex border-b border-fvp-border/40">
      <div
        className={clsx(
          "shrink-0 px-1 text-[9px] text-fvp-muted border-r border-fvp-border h-full flex items-center justify-center bg-fvp-surface relative",
          hasFile && !extracting ? "cursor-pointer hover:bg-fvp-surface2" : "cursor-help",
        )}
        style={{ width: LABEL_COL_PX }}
        title={
          extracting
            ? "Extracting embedded subtitles…"
            : entries.length > 0
              ? `${entries.length} subtitle entries loaded · double-click to load a different file · right-click for menu`
              : "No subtitles loaded · double-click to pick a subtitle file · or right-click for menu"
        }
        onDoubleClick={() => {
          if (hasFile && !extracting) void addSubtitleFlow();
        }}
      >
        {extracting ? (
          <span className="inline-block w-3 h-3 border border-fvp-accent border-t-transparent rounded-full animate-spin" />
        ) : (
          <>Subs</>
        )}
      </div>
      <div
        className="flex-1 h-full relative overflow-hidden"
        title={
          hasFile
            ? entries.length > 0
              ? "Double-click to load a different subtitle file · right-click for menu"
              : "Double-click to pick a subtitle file · right-click for menu"
            : ""
        }
        onDoubleClick={() => {
          // Double-clicking ANY part of the subs row (empty area OR an
          // existing subtitle entry block) opens the file picker. Lets the
          // user swap out the loaded subs without going through the menu.
          if (hasFile && !extracting) void addSubtitleFlow();
        }}
      >
        {extracting && (
          // Animated "working" indicator: a soft sweeping accent bar across
          // the whole row plus a centered status line. The pulsing background
          // makes it obvious that something's happening (not frozen).
          <>
            <div className="absolute inset-0 bg-fvp-accent/10 animate-pulse pointer-events-none" />
            <div className="absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-fvp-accent/40 to-transparent animate-[slide_1.4s_ease-in-out_infinite] pointer-events-none" />
            <div className="absolute inset-0 flex items-center justify-center text-[9px] text-fvp-accent font-medium pointer-events-none">
              Extracting embedded subtitles…
            </div>
          </>
        )}
        {!extracting && entries.length === 0 && hasFile && (
          <div className="absolute inset-0 flex items-center text-[9px] text-fvp-muted/60 px-1 pointer-events-none">
            (no subs loaded — right-click to add)
          </div>
        )}
        {!extracting && <SubEntriesWithFilter
          entries={entries}
          viewStartMs={viewStartMs}
          viewEndMs={viewEndMs}
          viewDurationMs={viewDurationMs}
        />}
      </div>
    </div>
  );
}

const SnipLayer = React.forwardRef<
  HTMLDivElement,
  {
    snips: Snip[];
    snipLanes: Record<string, number>;
    selectedId: string | null;
    activeEdge: { snipId: string; edge: "start" | "end" } | null;
    viewStartMs: number;
    viewDurationMs: number;
    totalDurationMs: number;
    dragPct: { leftPct: number; widthPct: number } | null;
    visibleHeight: number;
    contentHeight: number;
    msFromX: (clientX: number) => number;
    onMouseDown: (e: React.MouseEvent) => void;
    onSelect: (id: string) => void;
    onEdgeMouseDown: (snip: Snip, edge: "start" | "end") => (e: React.MouseEvent) => void;
  }
>(function SnipLayer(
  {
    snips,
    snipLanes,
    activeEdge,
    viewStartMs,
    viewDurationMs,
    totalDurationMs,
    dragPct,
    visibleHeight,
    contentHeight,
    msFromX,
    onMouseDown,
    onEdgeMouseDown,
  },
  ref,
) {
  const laneCount = Math.max(1, ...Object.values(snipLanes).map((v) => v + 1), 1);
  const selectedSnipIds = useAppStore((s) => s.selectedSnipIds);

  // Modifier matrix on snip body left-click (Option A multi-select):
  //   Plain               → single-select (replaces any existing selection)
  //   Ctrl+click          → toggle this snip in/out of the multi-selection
  //   Shift+click         → range-select from primary to this snip
  //   Ctrl+Shift+click    → "jump-on-select" override (seek playhead even when
  //                         the global toggle is off)
  //   Alt+click+drag      → clone this snip (or all selected) and drag the clone
  //
  // Drag rules:
  //   - Clicking a snip ALREADY in the selection: drag moves the whole selection.
  //   - Clicking a snip NOT in selection: single-selects without dragging.
  const handleSnipBodyMouseDown = (snip: Snip) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).dataset.snipHandle === "true") return; // edge handle
    e.stopPropagation();
    e.preventDefault();

    const state = useAppStore.getState();

    // Ctrl+Shift = jump override (seek even if toggle off). Selects the snip if not already.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
      if (!state.selectedSnipIds.includes(snip.id)) state.selectSnip(snip.id);
      void playback.seek(snip.start_ms / 1000);
      return;
    }
    // Ctrl-only = toggle in/out of selection.
    if (e.ctrlKey || e.metaKey) {
      state.toggleSnipSelection(snip.id);
      return;
    }
    // Shift = range select.
    if (e.shiftKey) {
      state.selectSnipRange(snip.id);
      return;
    }

    // Alt = clone-on-drag. Clone immediately, then drag the clone(s).
    if (e.altKey) {
      const sourceIds = state.selectedSnipIds.includes(snip.id) && state.selectedSnipIds.length > 0
        ? state.selectedSnipIds
        : [snip.id];
      state.commitToHistory();
      const newIds = state.duplicateSnips(sourceIds);
      startMoveDrag(newIds, e.clientX);
      return;
    }

    const wasInSelection = state.selectedSnipIds.includes(snip.id);

    if (!wasInSelection) {
      // Plain click on un-selected snip: single-select. No drag this click —
      // user can click again to drag (prevents accidental moves on first touch).
      state.selectSnip(snip.id);
      if (state.jumpPlayheadOnSnipSelect) {
        void playback.seek(snip.start_ms / 1000);
      }
      return;
    }

    // Already in selection — drag the entire selection together.
    startMoveDrag(state.selectedSnipIds, e.clientX);
  };

  const startMoveDrag = (ids: string[], startClientX: number) => {
    if (ids.length === 0) return;
    // Snapshot original positions on drag start. We treat the group as a
    // single rigid unit: on each frame we compute desired dx, clamp it
    // against the timeline edges based on the WHOLE group's bounding box,
    // then set each snip to (original + clamped_dx). This preserves
    // relative offsets when the group hits 0 or duration — the group stops
    // moving entirely instead of collapsing snip-by-snip.
    const originals = new Map<string, { start: number; end: number }>();
    for (const id of ids) {
      const sn = useAppStore.getState().snips.find((s) => s.id === id);
      if (sn) originals.set(id, { start: sn.start_ms, end: sn.end_ms });
    }
    if (originals.size === 0) return;
    const origValues = Array.from(originals.values());
    const minStart = Math.min(...origValues.map((p) => p.start));
    const maxEnd = Math.max(...origValues.map((p) => p.end));

    const startMs = msFromX(startClientX);
    let dragged = false;
    let committed = false;

    const onMove = (ev: MouseEvent) => {
      if (!dragged && Math.abs(ev.clientX - startClientX) < 3) return;
      if (!committed) {
        useAppStore.getState().commitToHistory();
        committed = true;
      }
      dragged = true;
      const nowMs = msFromX(ev.clientX);
      let dx = nowMs - startMs;
      if (dx < 0) dx = Math.max(dx, -minStart);
      if (dx > 0 && totalDurationMs > 0) {
        dx = Math.min(dx, totalDurationMs - maxEnd);
      }
      const rounded = Math.round(dx);
      const updates: Array<{ id: string; start_ms: number; end_ms: number }> = [];
      for (const [id, orig] of originals) {
        updates.push({
          id,
          start_ms: orig.start + rounded,
          end_ms: orig.end + rounded,
        });
      }
      useAppStore.getState().setSnipsBatch(updates);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  const viewEndMs = viewStartMs + viewDurationMs;
  return (
    <div className="flex border-b border-fvp-border/40 grow-0 shrink-0" style={{ height: visibleHeight }}>
      <div
        className="shrink-0 flex flex-col items-center justify-center bg-fvp-surface border-r border-fvp-border h-full text-fvp-muted cursor-help"
        style={{ width: LABEL_COL_PX }}
        title="Snips can overlap. Drag another snip onto the timeline and a new lane row will be created automatically (up to 10 lanes)."
      >
        <div className="text-[9px] leading-tight">Snips</div>
        <div className="text-[8px] leading-tight opacity-70">
          {laneCount} {laneCount === 1 ? "lane" : "lanes"}
        </div>
      </div>
      <div
        ref={ref}
        onMouseDown={onMouseDown}
        className={clsx(
          // No overflow-y-auto here — a vertical scrollbar would reserve ~15px
          // on the right and misalign the snip body from the playhead (see
          // TimelinePanel's snipLayerHeight comment).
          "flex-1 h-full relative",
          viewDurationMs > 0 ? "cursor-crosshair" : "cursor-not-allowed",
        )}
        title={
          viewDurationMs > 0
            ? "Drag to create · drag a snip edge to resize · click an edge then arrows / , / . to nudge · overlapping snips auto-stack into lanes (up to 10)"
            : ""
        }
      >
        <div className="relative" style={{ height: contentHeight }}>
          {/* Ghost waveform behind everything. Pointer-events:none — the snip
              lane keeps full control of drag-create / select / nudge. */}
          <WaveformBackground viewStartMs={viewStartMs} viewEndMs={viewStartMs + viewDurationMs} />
          {/* Lane dividers — subtle horizontal lines so multi-lane stacking is visible */}
          {Array.from({ length: laneCount }).map((_, i) => (
            <div
              key={`lane-${i}`}
              className="absolute left-0 right-0 border-b border-fvp-border/30 pointer-events-none"
              style={{ top: (i + 1) * LANE_HEIGHT_PX - 1, height: 1 }}
            />
          ))}
          {snips.map((snip) => {
            if (viewDurationMs <= 0) return null;
            if (snip.end_ms < viewStartMs || snip.start_ms > viewEndMs) return null;
            const leftPct = ((snip.start_ms - viewStartMs) / viewDurationMs) * 100;
            const widthPct = ((snip.end_ms - snip.start_ms) / viewDurationMs) * 100;
            const selected = selectedSnipIds.includes(snip.id);
            const startActive = activeEdge?.snipId === snip.id && activeEdge.edge === "start";
            const endActive = activeEdge?.snipId === snip.id && activeEdge.edge === "end";
            const lane = snipLanes[snip.id] ?? 0;
            return (
              <div
                key={snip.id}
                data-snip-block
                onMouseDown={handleSnipBodyMouseDown(snip)}
                className={clsx(
                  "absolute rounded overflow-hidden",
                  // ring-inset keeps the ring INSIDE the rect, so the visual
                  // edge of the snip lines up exactly with snip.start_ms /
                  // snip.end_ms in pixel space (matching the playhead).
                  selected
                    ? "ring-2 ring-inset ring-white cursor-move"
                    : "hover:ring-1 hover:ring-inset hover:ring-white/60 cursor-pointer",
                )}
                style={{
                  left: `${leftPct}%`,
                  width: `${Math.max(widthPct, 0.2)}%`,
                  top: lane * LANE_HEIGHT_PX + 2,
                  height: LANE_HEIGHT_PX - 4,
                  backgroundColor: colorForSnip(snip),
                  opacity: snip.categories.length === 0 ? 0.55 : 0.85,
                }}
                title={
                  `${formatTime(snip.start_ms / 1000)} → ${formatTime(snip.end_ms / 1000)} ` +
                  `(${formatDuration(snip.end_ms - snip.start_ms)})\n` +
                  `Action: ${actionLabel(snip.action)}\n` +
                  `Categories: ${snip.categories.length > 0 ? snip.categories.map(sanitizeForDisplay).join(", ") : "(uncategorized)"}\n` +
                  `Lane ${lane + 1}` +
                  (snip.note ? `\nNote: ${snip.note}` : "")
                }
              >
                <EdgeHandle side="left" active={startActive} onMouseDown={onEdgeMouseDown(snip, "start")} />
                <EdgeHandle side="right" active={endActive} onMouseDown={onEdgeMouseDown(snip, "end")} />
              </div>
            );
          })}
          {dragPct && (
            <div
              className="absolute rounded bg-fvp-accent/60 border border-fvp-accent pointer-events-none"
              style={{
                left: `${dragPct.leftPct}%`,
                width: `${Math.max(dragPct.widthPct, 0.2)}%`,
                top: 2,
                height: LANE_HEIGHT_PX - 4,
              }}
            />
          )}
        </div>
        {/* Background-build indicator — pointer-events:none so it can't
            intercept clicks on the snip lane behind it. */}
        <PeaksBuildingBadge />
      </div>
    </div>
  );
});

function EdgeHandle({
  side,
  active,
  onMouseDown,
}: {
  side: "left" | "right";
  active: boolean;
  onMouseDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      data-snip-handle="true"
      onMouseDown={onMouseDown}
      title={
        active
          ? "Edge active — drag to resize, or use ← / → (Ctrl / Shift) / , / . to nudge. Click elsewhere to commit."
          : "Click to activate (then arrows nudge) · drag to resize directly"
      }
      className={clsx(
        "absolute top-0 bottom-0 cursor-ew-resize",
        active ? "bg-fvp-accent ring-2 ring-fvp-accent" : "bg-white/30 hover:bg-white/60",
      )}
      style={{
        [side]: 0,
        width: active ? RESIZE_HANDLE_PX * 2 : RESIZE_HANDLE_PX,
      }}
    />
  );
}

/* ───────────────────────── Status bar ───────────────────────── */

function CreatorStatusBar() {
  const snips = useAppStore((s) => s.snips);
  const markers = useAppStore((s) => s.markers);
  const flags = useAppStore((s) => s.flags);
  const abToggleOn = useAppStore((s) => s.abToggleOn);
  const autosaveDraft = useAppStore((s) => s.autosaveDraft);
  const needsReview = snips.filter((s) => s.categories.length === 0).length;
  // Compute total time saved by skip snips — useful "what does this profile do?" stat.
  const totalSkipMs = snips
    .filter((s) => s.action.type === "skip")
    .reduce((sum, s) => sum + (s.end_ms - s.start_ms), 0);
  const totalText =
    totalSkipMs >= 60_000
      ? `${Math.floor(totalSkipMs / 60_000)}m ${Math.round((totalSkipMs % 60_000) / 1000)}s`
      : `${Math.round(totalSkipMs / 1000)}s`;
  return (
    <footer className="h-6 bg-fvp-surface border-t border-fvp-border flex items-center gap-2 px-3 text-[11px] text-fvp-muted select-none">
      <span>Mode: Profile Creator</span>
      <span>·</span>
      <span>Draft (in-memory)</span>
      <span>·</span>
      <span>
        {snips.length} snip{snips.length === 1 ? "" : "s"} · {needsReview} need review
      </span>
      <span>·</span>
      <span>
        {markers.length} marker{markers.length === 1 ? "" : "s"} · {flags.length} flag
        {flags.length === 1 ? "" : "s"}
      </span>
      {totalSkipMs > 0 && (
        <>
          <span>·</span>
          <span>Skips will save {totalText}</span>
        </>
      )}
      <span>·</span>
      <span>Preview (T): {abToggleOn ? "ON" : "OFF"}</span>
      <span className="flex-1" />
      <HotkeyTicker />
      <span>autosave: {autosaveDraft ? "on" : "off"}</span>
    </footer>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */

function actionLabel(a: SnipAction): string {
  return actionLabelByType(a.type);
}

function actionLabelByType(t: SnipAction["type"]): string {
  switch (t) {
    case "skip":
      return "Skip";
    case "silence":
      return "Silence";
    case "freeze_frame":
      return "Freeze";
    case "audio_replace":
      return "Audio-replace";
    case "beep":
      return "Beep";
    case "mute_dialogue":
      return "Remove dialogue";
    case "audio_blur":
      return "Audio blur";
    case "crop_video":
      return "Crop video";
  }
}

function formatTimeMs(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const msPart = total % 1000;
  const mm = m.toString().padStart(2, "0");
  const ss = s.toString().padStart(2, "0");
  const mmm = msPart.toString().padStart(3, "0");
  if (h > 0) return `${h}:${mm}:${ss}.${mmm}`;
  return `${m}:${ss}.${mmm}`;
}

function parseTimeMs(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(":");
  const last = parts[parts.length - 1]!;
  const [secStr, msStr = "0"] = last.split(".");
  const sec = Number(secStr);
  const msPart = Number(msStr.padEnd(3, "0").slice(0, 3));
  if (!Number.isFinite(sec) || !Number.isFinite(msPart) || sec < 0 || msPart < 0) return null;
  let totalSeconds = sec;
  if (parts.length >= 2) {
    const m = Number(parts[parts.length - 2]);
    if (!Number.isFinite(m) || m < 0) return null;
    totalSeconds += m * 60;
  }
  if (parts.length >= 3) {
    const h = Number(parts[parts.length - 3]);
    if (!Number.isFinite(h) || h < 0) return null;
    totalSeconds += h * 3600;
  }
  return Math.round(totalSeconds * 1000 + msPart);
}
