import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAppStore } from "../state/appStore";
import { profileIpc } from "../ipc";
import { openVideoPath } from "../utils/openFileFlow";
import { hasUnsavedWork, confirmDiscardUnsaved } from "../utils/unsavedWork";
import { pushRecentFile } from "../utils/recentFiles";

const VIDEO_EXTENSIONS = [
  "mkv", "mp4", "avi", "mov", "m4v", "webm", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts",
];
const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac"];
const SUPPORTED = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

/** Drag-and-drop target. Handles folders, multi-file drops, .free rejects,
 *  and unsaved-work confirmation before opening. */
export function useFileDropTarget() {
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;

    win
      .onDragDropEvent((e) => {
        if (e.payload.type !== "drop") return;
        const paths = e.payload.paths;
        if (!paths || paths.length === 0) return;
        void handleDrop(paths);
      })
      .then((fn) => {
        unlisten = fn;
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);
}

async function handleDrop(paths: string[]): Promise<void> {
  if (paths.length > 1) {
    useAppStore
      .getState()
      .showToast(
        `Dropped ${paths.length} files; opening the first one. ` +
          `Multi-file queues aren't supported yet.`,
        "info",
        6000,
      );
  }
  const dropped = paths[0]!;
  const lower = dropped.toLowerCase();

  if (lower.endsWith(".free")) {
    alert(
      "That's a profile file (.free), not a video.\n\n" +
        "Open the matching video first — FVP will auto-detect any .free " +
        "profiles in the same folder.",
    );
    return;
  }

  // Folder check via backend (drag-drop can deliver directory paths).
  try {
    if (await profileIpc.isDirectory(dropped)) {
      alert(
        `Can't open "${dropped}".\n\n` +
          `Folders aren't supported yet — drop a single video file instead.`,
      );
      return;
    }
  } catch {
    // Backend check failed — fall through to the extension check below.
  }

  const ext = lower.split(".").pop() ?? "";
  if (!SUPPORTED.has(ext)) {
    alert(`Can't open "${dropped}".\nUnsupported file type: .${ext}`);
    return;
  }

  if (hasUnsavedWork()) {
    if (!confirmDiscardUnsaved("Opening the dropped file")) return;
  }

  await openVideoPath(dropped);
  pushRecentFile(dropped);
}
