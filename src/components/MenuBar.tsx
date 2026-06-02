import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/appStore";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { playerController } from "../controller/playerController";
import { openFileFlow } from "../utils/openFileFlow";
import { addSubtitleFlow, refreshSubtitleTracks, refreshTracks } from "../utils/addSubtitleFlow";
import { subtitlesIpc, tracksIpc, playback } from "../ipc";
import { ASPECT_RATIO_PRESETS } from "../ipc/types";
import { getRecentFiles, clearRecentFiles } from "../utils/recentFiles";
import { openVideoPath } from "../utils/openFileFlow";

/**
 * Top menu bar. Clicking a label opens the corresponding dropdown anchored
 * below the button. Hovering another label while a menu is open switches
 * the dropdown (Win/Mac-style). Items invoke real handlers — entries that
 * don't have backing yet are shown as disabled.
 */
export function MenuBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const openAt = (name: string) => {
    const btn = refs.current[name];
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom });
    setOpenMenu(name);
  };

  const close = () => {
    setOpenMenu(null);
    setAnchor(null);
  };

  // Close on Escape (also handled by ContextMenu, but belt-and-suspenders).
  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openMenu]);

  const items = openMenu ? buildItemsFor(openMenu) : [];

  return (
    <div className="flex items-center h-7 px-1 bg-fvp-surface border-b border-fvp-border text-xs select-none">
      {MENUS.map((m) => (
        <button
          key={m}
          ref={(el) => {
            refs.current[m] = el;
          }}
          onClick={(e) => {
            e.currentTarget.blur();
            if (openMenu === m) close();
            else openAt(m);
          }}
          onMouseEnter={() => {
            if (openMenu && openMenu !== m) openAt(m);
          }}
          className={
            "px-2 py-1 text-fvp-text hover:bg-fvp-surface2 rounded-sm " +
            (openMenu === m ? "bg-fvp-surface2" : "")
          }
        >
          {m}
        </button>
      ))}
      {openMenu && anchor && items.length > 0 && (
        <ContextMenu x={anchor.x} y={anchor.y} items={items} onClose={close} />
      )}
    </div>
  );
}

// "Tools" was redundant with the top-tab mode switcher (Player / Profile
// Creator / Settings live there), so it's been removed from the menu bar.
const MENUS = ["File", "Video Playback", "Video", "Audio", "Subtitle", "View", "Help"];

function buildItemsFor(menu: string): MenuItem[] {
  const state = useAppStore.getState();
  const hasFile = state.currentFile !== null;
  const mode = state.mode;

  switch (menu) {
    case "File": {
      const items: MenuItem[] = [
        {
          kind: "item",
          label: "Open file…",
          hotkey: "Ctrl+O",
          onClick: () => void openFileFlow(),
        },
        {
          kind: "item",
          label: "Open folder…",
          title: "Library Mode: scan a folder for videos and detect their profiles",
          onClick: () => {
            // Enable + switch to Library mode; Library handles the picker UI.
            useAppStore.setState({ libraryEnabled: true, mode: "library" });
          },
        },
      ];
      // Open recent — flatten to top level (ContextMenu doesn't support submenus).
      const recent = getRecentFiles();
      if (recent.length > 0) {
        items.push({ kind: "separator" });
        for (const path of recent.slice(0, 8)) {
          const label = path.split(/[\\/]/).pop() ?? path;
          items.push({
            kind: "item",
            label: `↻ ${label}`,
            title: path,
            onClick: () => void openVideoPath(path),
          });
        }
        items.push({
          kind: "item",
          label: "Clear recent files",
          onClick: () => {
            clearRecentFiles();
            useAppStore.getState().showToast("Recent files cleared.", "info");
          },
        });
      }
      items.push({ kind: "separator" });
      items.push({
        kind: "item",
        label: "Save Now Playing as .m3u…",
        disabled: !hasFile,
        onClick: () => void import("../utils/savePlaylist").then((m) => m.savePlaylistFlow()),
      });
      items.push({
        kind: "item",
        label: "Settings",
        onClick: () => useAppStore.setState({ mode: "settings" }),
      });
      items.push({ kind: "separator" });
      items.push({
        kind: "item",
        label: "Exit",
        onClick: () => {
          void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
            void getCurrentWebviewWindow().close();
          });
        },
      });
      return items;
    }

    case "Video Playback":
      return [
        {
          kind: "item",
          label: state.playing ? "Pause" : "Play",
          hotkey: "Space",
          disabled: !hasFile,
          onClick: () => void playerController.togglePause(),
        },
        {
          kind: "item",
          label: "Stop",
          disabled: !hasFile,
          onClick: () => void playerController.stop(),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "Jump to start",
          hotkey: "Home",
          disabled: !hasFile,
          onClick: () => void playerController.seekTo(0),
        },
        {
          kind: "item",
          label: "Jump to end",
          hotkey: "End",
          disabled: !hasFile || state.duration <= 0,
          onClick: () => void playerController.seekTo(state.duration),
        },
      ];

    case "Video": {
      // Fullscreen is intentionally Player-only — Profile Creator has no
      // sensible fullscreen UX (the timeline / rails / panels need chrome).
      const items: MenuItem[] = [];
      if (mode !== "creator") {
        items.push({
          kind: "item",
          label: state.fullscreen ? "Exit fullscreen" : "Fullscreen",
          hotkey: "F",
          disabled: !hasFile,
          onClick: () => void playerController.toggleFullscreen(),
        });
        items.push({ kind: "separator" });
      }
      // Video tracks list
      const videoTracks = state.videoTracks;
      if (videoTracks.length > 1) {
        items.push({ kind: "separator" });
        for (const t of videoTracks) {
          items.push({
            kind: "item",
            label: `${t.selected ? "✓ " : "    "}Video: ${subtitleLabel(t)}`,
            onClick: () =>
              tracksIpc
                .setVideo(t.id)
                .then(() => refreshTracks())
                .catch((err) =>
                  useAppStore.getState().showToast(`Set video failed: ${err}`, "error"),
                ),
          });
        }
      }
      // Aspect ratio presets in a hover-submenu (compact, one parent row
      // in the Video menu). The currently-applied preset gets a ✓ on its
      // submenu entry so the user can see at a glance what's active.
      items.push({ kind: "separator" });
      const currentAspect = state.aspectRatio;
      const currentAspectLabel =
        ASPECT_RATIO_PRESETS.find((p) => p.value === currentAspect)?.label ??
        "Custom";
      items.push({
        kind: "submenu",
        label: `Aspect ratio  (${currentAspectLabel})`,
        disabled: !hasFile,
        items: ASPECT_RATIO_PRESETS.map((preset) => ({
          kind: "item" as const,
          label: `${preset.value === currentAspect ? "✓ " : "    "}${preset.label}`,
          onClick: () => {
            useAppStore.setState({ aspectRatio: preset.value });
            void playback.setAspectRatio(preset.value).catch((err) =>
              useAppStore
                .getState()
                .showToast(`Set aspect ratio failed: ${err}`, "error"),
            );
          },
        })),
      });
      // Deinterlace toggle
      items.push({ kind: "separator" });
      items.push({
        kind: "item",
        label: `${state.deinterlaceOn ? "✓ " : "    "}Deinterlace`,
        disabled: !hasFile,
        onClick: () => {
          const next = !state.deinterlaceOn;
          void tracksIpc
            .setDeinterlace(next)
            .then(() => useAppStore.setState({ deinterlaceOn: next }))
            .catch((err) =>
              useAppStore.getState().showToast(`Deinterlace failed: ${err}`, "error"),
            );
        },
      });
      return items;
    }

    case "Audio": {
      const items: MenuItem[] = [
        {
          kind: "item",
          label: state.muted ? "Unmute" : "Mute",
          hotkey: "M",
          disabled: !hasFile,
          onClick: () => void playerController.toggleMute(),
        },
      ];
      const audioTracks = state.audioTracks;
      if (audioTracks.length > 1) {
        items.push({ kind: "separator" });
        items.push({
          kind: "item",
          label: `${audioTracks.every((t) => !t.selected) ? "✓ " : "    "}Off — no audio`,
          onClick: () =>
            tracksIpc
              .setAudio(null)
              .then(() => refreshTracks())
              .catch((err) =>
                useAppStore.getState().showToast(`Set audio failed: ${err}`, "error"),
              ),
        });
        for (const t of audioTracks) {
          items.push({
            kind: "item",
            label: `${t.selected ? "✓ " : "    "}Audio: ${subtitleLabel(t)}`,
            onClick: () =>
              tracksIpc
                .setAudio(t.id)
                .then(() => refreshTracks())
                .catch((err) =>
                  useAppStore.getState().showToast(`Set audio failed: ${err}`, "error"),
                ),
          });
        }
      }
      // Audio device picker (mpv's audio-device-list).
      const devices = state.audioDevices;
      if (devices.length > 0) {
        items.push({ kind: "separator" });
        for (const d of devices) {
          // Cap label length so the menu doesn't go off-screen with long
          // Windows device names ("Speakers (4-USB Audio Device) [...]").
          const label = d.description || d.name;
          const truncated = label.length > 60 ? label.slice(0, 57) + "…" : label;
          items.push({
            kind: "item",
            label: `${d.selected ? "✓ " : "    "}Device: ${truncated}`,
            title: d.name,
            onClick: () =>
              tracksIpc
                .setAudioDevice(d.name)
                .then(() => refreshTracks())
                .catch((err) =>
                  useAppStore
                    .getState()
                    .showToast(`Set audio device failed: ${err}`, "error"),
                ),
          });
        }
      }
      return items;
    }

    case "Subtitle": {
      const tracks = state.subtitleTracks;
      const visible = state.subtitleVisible;
      const items: MenuItem[] = [
        {
          kind: "item",
          label: "Add subtitle file…",
          disabled: !hasFile,
          onClick: () => void addSubtitleFlow(),
        },
        {
          kind: "item",
          label: `${visible ? "✓ " : "    "}Enable subtitles`,
          disabled: !hasFile,
          title: "Toggles whether subtitles are rendered without unselecting the track.",
          onClick: () =>
            subtitlesIpc
              .setVisibility(!visible)
              .then(() => useAppStore.setState({ subtitleVisible: !visible }))
              .catch((err) =>
                useAppStore.getState().showToast(`Toggle sub failed: ${err}`, "error"),
              ),
        },
        {
          kind: "item",
          label: "Refresh subtitle track list",
          disabled: !hasFile,
          onClick: () => void refreshSubtitleTracks(),
        },
      ];
      if (tracks.length > 0) {
        items.push({ kind: "separator" });
        const anySelected = tracks.some((t) => t.selected);
        items.push({
          kind: "item",
          label: `${anySelected ? "    " : "✓ "}Off — no subtitles`,
          onClick: () =>
            subtitlesIpc
              .setTrack(null)
              .then(() => refreshSubtitleTracks())
              .catch((err) =>
                useAppStore.getState().showToast(`Set sub failed: ${err}`, "error"),
              ),
        });
        for (const t of tracks) {
          const label = subtitleLabel(t);
          items.push({
            kind: "item",
            label: `${t.selected ? "✓ " : "    "}${label}`,
            onClick: () =>
              subtitlesIpc
                .setTrack(t.id)
                .then(() => refreshSubtitleTracks())
                .catch((err) =>
                  useAppStore.getState().showToast(`Set sub failed: ${err}`, "error"),
                ),
          });
        }
      } else if (hasFile) {
        items.push({ kind: "separator" });
        items.push({
          kind: "item",
          label: "(no subtitle tracks detected — try Add subtitle file…)",
          disabled: true,
          onClick: () => {},
        });
      }
      return items;
    }

    case "View":
      return [
        {
          kind: "item",
          label: "Player Mode",
          disabled: mode === "player",
          onClick: () => useAppStore.setState({ mode: "player" }),
        },
        {
          kind: "item",
          label: "Profile Creator",
          disabled: mode === "creator",
          onClick: () => useAppStore.setState({ mode: "creator" }),
        },
        {
          kind: "item",
          label: "Library",
          disabled: !state.libraryEnabled || mode === "library",
          title: state.libraryEnabled
            ? undefined
            : "Library mode is off — enable in Settings",
          onClick: () => useAppStore.setState({ mode: "library" }),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: state.abToggleOn ? "Turn profile preview OFF" : "Turn profile preview ON",
          hotkey: "T",
          disabled: !hasFile,
          onClick: () => useAppStore.setState({ abToggleOn: !state.abToggleOn }),
        },
      ];

    case "Help":
      return [
        {
          kind: "item",
          label: "Keyboard shortcuts…",
          hotkey: "?",
          onClick: () => useAppStore.setState({ cheatsheetVisible: true }),
        },
        { kind: "separator" },
        {
          kind: "item",
          label: "About FVP",
          onClick: () => useAppStore.setState({ aboutVisible: true }),
        },
      ];

    default:
      return [];
  }
}

function subtitleLabel(t: { id: number; title: string | null; lang: string | null; external: boolean }): string {
  const parts: string[] = [`Track ${t.id}`];
  if (t.title) parts.push(t.title);
  if (t.lang) parts.push(`[${t.lang}]`);
  if (t.external) parts.push("(external)");
  return parts.join(" ");
}
