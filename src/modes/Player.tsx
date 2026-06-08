import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../state/appStore";
import { TransportBar } from "../components/TransportBar";
import { ContextMenu, type MenuItem } from "../components/ContextMenu";
import { ProfileChip } from "../components/ProfileChip";
import { ProfileActiveIcon, MoviePathOverlay } from "../components/PlayerOverlays";
import { ProfileSwitcher } from "../components/ProfileSwitcher";
import { SkipThatTray } from "../components/SkipThatTray";
import { openFileFlow } from "../utils/openFileFlow";
import { addSubtitleFlow } from "../utils/addSubtitleFlow";
import { subtitlesIpc } from "../ipc";
import { playerController } from "../controller/playerController";
import { useVideoAreaReporter } from "../hooks/useVideoAreaReporter";
import { RateMovieModal } from "../components/RateMovieModal";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { ResumeOrStartOverModal } from "../components/ResumeOrStartOverModal";
import { useLibraryWatchTracker } from "../hooks/useLibraryWatchTracker";

export function PlayerMode() {
  const currentFile = useAppStore((s) => s.currentFile);
  const loading = useAppStore((s) => s.loading);
  const playing = useAppStore((s) => s.playing);
  const muted = useAppStore((s) => s.muted);
  const fullscreen = useAppStore((s) => s.fullscreen);
  const chromeVisible = useAppStore((s) => s.chromeVisible);
  const subtitleVisible = useAppStore((s) => s.subtitleVisible);

  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const [rating, setRating] = useState(false);
  const videoAreaRef = useRef<HTMLDivElement>(null);
  useVideoAreaReporter(videoAreaRef);
  const { resumePrompt, dismissResume } = useLibraryWatchTracker();

  // Document-level contextmenu handler (capture phase) — catches every right
  // click that produces a DOM event, regardless of which element it lands on
  // or what stops its propagation. Suppressed while a modal is open so menus
  // don't appear under the modal backdrop.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      e.preventDefault();
      if (useAppStore.getState().openModalCount > 0) return;
      setCtx({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("contextmenu", handler, true);
    return () => document.removeEventListener("contextmenu", handler, true);
  }, []);

  // Right-clicks that land on libmpv's HWND don't produce a DOM contextmenu
  // event at all (the OS routes them to libmpv's child window before they
  // reach the webview). The Rust WNDPROC subclass forwards those as a Tauri
  // event with intermediate-local PHYSICAL pixel coords. Convert to page
  // coords (CSS pixels, offset by the video area's position in the viewport).
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

  // Left-click on the libmpv HWND → toggle pause/play in Player Mode.
  // The click lands on libmpv's native child window, never reaches the
  // DOM, so we rely on the Rust WNDPROC subclass forwarding it as the
  // `video-click` Tauri event. Suppressed while any modal is open so
  // a backdrop click doesn't also pause playback.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("video-click", () => {
      if (useAppStore.getState().openModalCount > 0) return;
      if (!useAppStore.getState().currentFile) return;
      void playerController.togglePause();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

  const showTransport = !fullscreen || chromeVisible;

  const buildMenuItems = (): MenuItem[] => [
    { kind: "item", label: "Open file…", hotkey: "Ctrl+O", onClick: () => void openFileFlow() },
    { kind: "separator" },
    {
      kind: "item",
      label: playing ? "Pause" : "Play",
      hotkey: "Space",
      disabled: !currentFile,
      onClick: () => void playerController.togglePause(),
    },
    {
      kind: "item",
      label: "Stop",
      disabled: !currentFile,
      onClick: () => void playerController.stop(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: muted ? "Unmute" : "Mute",
      hotkey: "M",
      disabled: !currentFile,
      onClick: () => void playerController.toggleMute(),
    },
    {
      kind: "item",
      label: fullscreen ? "Exit fullscreen" : "Fullscreen",
      hotkey: "F",
      onClick: () => void playerController.toggleFullscreen(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Seek −10s",
      hotkey: "Ctrl + ←",
      disabled: !currentFile,
      onClick: () => void playerController.seekRelative(-10),
    },
    {
      kind: "item",
      label: "Seek +10s",
      hotkey: "Ctrl + →",
      disabled: !currentFile,
      onClick: () => void playerController.seekRelative(10),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Profile switcher…",
      disabled: !currentFile,
      onClick: () => useAppStore.setState({ switcherOpen: true }),
    },
    {
      kind: "item",
      label: "Rate this movie…",
      disabled: !currentFile,
      onClick: () => setRating(true),
    },
    {
      kind: "item",
      label: "Hotkey cheatsheet…",
      hotkey: "?",
      onClick: () => useAppStore.setState({ cheatsheetVisible: true }),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Add subtitle file…",
      disabled: !currentFile,
      onClick: () => void addSubtitleFlow(),
    },
    {
      kind: "item",
      label: `${subtitleVisible ? "✓ " : "    "}Enable subtitles`,
      disabled: !currentFile,
      onClick: () => {
        const v = !subtitleVisible;
        void subtitlesIpc.setVisibility(v).then(() =>
          useAppStore.setState({ subtitleVisible: v }),
        );
      },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Edit profile…",
      title: "Switch to Profile Creator with the current file loaded",
      disabled: !currentFile,
      onClick: () => useAppStore.setState({ mode: "creator" }),
    },
    {
      kind: "item",
      label: "Save Now Playing as .m3u…",
      disabled: !currentFile,
      onClick: () => void import("../utils/savePlaylist").then((m) => m.savePlaylistFlow()),
    },
  ];

  return (
    <div className="h-full flex flex-col">
      <div ref={videoAreaRef} className="flex-1 min-h-0 relative" style={{ background: "transparent" }}>
        <FreezeFrameOverlay />
        {/* Loading takes precedence over no-file (a fresh load wants to
            show the spinner, not the empty-state pitch). The spinner
            overlay is opaque black, so it also hides the libmpv HWND
            during the brief render gap when a new file is attaching —
            this is what kills the white flash on file open. */}
        {loading ? (
          <LoadingOverlay />
        ) : (
          !currentFile && (
            <div className="absolute inset-0 bg-fvp-bg flex items-center justify-center text-fvp-muted text-sm">
              <div className="text-center">
                <img
                  src="/icon_96px.png"
                  alt="Freedom Video Player"
                  width={96}
                  height={96}
                  className="mx-auto mb-4 select-none"
                  draggable={false}
                  style={{ width: 96, height: 96 }}
                />
                <div className="text-fvp-text text-lg mb-2">No file loaded</div>
                <div className="text-xs mb-6">Pick a video or audio file to begin</div>
                <button
                  onClick={() => void openFileFlow()}
                  className="px-4 py-2 bg-fvp-accent text-white text-sm rounded hover:opacity-90"
                  title="Open a file (Ctrl+O)"
                >
                  Open file…
                </button>
              </div>
            </div>
          )
        )}
        <ProfileChip />
        <ProfileActiveIcon />
        <MoviePathOverlay />
      </div>
      <SkipThatTray onViewDraft={() => useAppStore.setState({ mode: "creator" })} />
      {showTransport && <TransportBar onOpenFile={() => void openFileFlow()} />}
      {ctx && <ContextMenu x={ctx.x} y={ctx.y} items={buildMenuItems()} onClose={() => setCtx(null)} />}
      <ProfileSwitcher />
      {rating && currentFile && (
        <RateMovieModal
          movieTitle={currentFile.split(/[\\/]/).pop() ?? currentFile}
          onClose={() => setRating(false)}
        />
      )}
      {resumePrompt && (
        <ResumeOrStartOverModal
          progressMs={resumePrompt.progressMs}
          durationMs={resumePrompt.durationMs}
          title={resumePrompt.title}
          onResolved={dismissResume}
        />
      )}
    </div>
  );
}

function FreezeFrameOverlay() {
  const src = useAppStore((s) => s.freezeFrameSrc);
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      className="absolute inset-0 w-full h-full object-contain bg-black pointer-events-none z-10"
    />
  );
}
