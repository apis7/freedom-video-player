import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { libraryIpc, profileIpc } from "../ipc";
import { openVideoPath } from "../utils/openFileFlow";
import { hasUnsavedWork, confirmDiscardUnsaved } from "../utils/unsavedWork";
import { pushRecentFile } from "../utils/recentFiles";

const VIDEO_EXTENSIONS = [
  "mkv", "mp4", "avi", "mov", "m4v", "webm", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts",
];
const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac"];
const SUPPORTED = new Set([...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS]);

/**
 * Drag-and-drop target for files dropped FROM EXPLORER INTO the FVP
 * window. Uses HTML5 drop events on the window rather than Tauri's
 * onDragDropEvent because tauri.conf.json now has dragDropEnabled=false
 * (Tauri's native drag-drop hook on Windows was swallowing the entire
 * OS-level drop chain, which killed HTML5 drag-receive INSIDE the
 * WebView - including the user's drag of library tiles into sidebar
 * collections / series. Disabling it re-enables HTML5; we just have to
 * hand-roll the Explorer-file-drop branch ourselves here).
 *
 * WebView2 specifically exposes the underlying filesystem path on
 * dropped File objects via a non-standard `.path` property. That's how
 * we recover the real path the user dragged from Explorer. The .path
 * property is not part of the W3C File spec - it's a WebView2 / Tauri
 * convenience - which is why we cast through (file as any).path.
 *
 * The window-level dragover handler is required: without preventDefault
 * the browser refuses to fire drop, and the file silently bounces.
 * We're careful to ONLY preventDefault when the drag carries the
 * 'Files' MIME type - otherwise we'd accidentally swallow all the
 * intra-app HTML5 drags (library tile to sidebar) that this whole
 * exercise was about enabling in the first place.
 */
export function useFileDropTarget() {
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
      if (types.includes("Files")) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (e: DragEvent) => {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
      if (!types.includes("Files")) return;
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const f = files.item(i);
        if (!f) continue;
        // WebView2 / Tauri populate .path with the real filesystem path
        // for files dropped from Explorer. Standard browsers wouldn't.
        const p = (f as unknown as { path?: string }).path;
        if (typeof p === "string" && p.length > 0) {
          paths.push(p);
        }
      }
      if (paths.length === 0) {
        useAppStore
          .getState()
          .showToast(
            "Couldn't read dropped file paths. Try opening via the file picker.",
            "warn",
            4000,
          );
        return;
      }
      void handleDrop(paths);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);
}

async function handleDrop(paths: string[]): Promise<void> {
  // Library mode: treat drops as "add to library" operations. Folders
  // get registered as watched folders; individual files are added via
  // their parent folder so the existing indexer can pick them up. Per
  // directive Phase 11.
  const mode = useAppStore.getState().mode;
  if (mode === "library") {
    await handleLibraryDrop(paths);
    return;
  }
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

/**
 * In Library mode, dropping from Explorer adds the dropped paths to the
 * library:
 *   - A folder → registered as a watched folder (recursive=true) and
 *     immediately indexed.
 *   - Video files → grouped by their parent directories; each parent is
 *     added as a watched folder (recursive=false). Avoids the awkward
 *     "drop one file → indexer scans your entire Movies tree" surprise.
 *   - Anything else (audio, .free, unsupported) → skipped with a toast.
 */
async function handleLibraryDrop(paths: string[]): Promise<void> {
  const { showToast } = useAppStore.getState();
  let addedFolders = 0;
  const directorySet = new Set<string>();

  for (const p of paths) {
    try {
      if (await profileIpc.isDirectory(p)) {
        try {
          await libraryIpc.addFolder(p, true);
          addedFolders++;
        } catch (err) {
          showToast(`Couldn't add folder "${p}": ${err}`, "warn", 4000);
        }
      } else {
        const ext = p.toLowerCase().split(".").pop() ?? "";
        if (!VIDEO_EXTENSIONS.includes(ext)) continue;
        // Add parent dir as a watched folder. Library mode users dropping
        // a single video probably expect "I just want this one", but the
        // indexer can't track an individual file outside a watched folder.
        const parent = p.replace(/[\\/][^\\/]+$/, "");
        directorySet.add(parent);
      }
    } catch {
      // Best-effort — skip files we can't classify.
    }
  }
  for (const dir of directorySet) {
    try {
      await libraryIpc.addFolder(dir, false);
      addedFolders++;
    } catch {
      // Already a watched folder is fine — just kick a rescan instead.
    }
  }
  if (addedFolders > 0) {
    showToast(
      `Added ${addedFolders} folder${addedFolders === 1 ? "" : "s"} to library. Indexing…`,
      "info",
      3500,
    );
  } else {
    showToast("Nothing to add (drop a video file or folder).", "warn", 3000);
  }
}
