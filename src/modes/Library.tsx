import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/appStore";
import { libraryIpc } from "../ipc";
import { openVideoPath } from "../utils/openFileFlow";

/**
 * Library Mode (Chapter 3 of the build, first pass).
 *
 * User picks a folder; FVP scans it (optionally recursively) for video
 * files and shows each one with a count of `.free` profiles found
 * alongside it. Double-click a row to open in Player Mode.
 *
 * Deferred: folder-watching (notify crate), card / grid views, batch
 * profile management, orphan-profile detection.
 */
export function LibraryMode() {
  const folder = useAppStore((s) => s.libraryFolder);
  const items = useAppStore((s) => s.libraryItems);
  const recursive = useAppStore((s) => s.libraryRecursive);
  const scanning = useAppStore((s) => s.libraryScanning);

  useEffect(() => {
    if (!folder) return;
    void doScan();
    // Start watching this folder; backend emits `library-changed` whenever
    // files appear / change / disappear (debounced 500ms).
    void libraryIpc.watch(folder).catch(() => {});
    return () => {
      void libraryIpc.unwatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, recursive]);

  // Subscribe to library-changed pings → auto-rescan.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    void listen("library-changed", () => {
      if (folder) void doScan();
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      if (unlisten) unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  const pickFolder = async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked === "string") {
      useAppStore.setState({ libraryFolder: picked });
    }
  };

  const doScan = async () => {
    if (!folder) return;
    useAppStore.setState({ libraryScanning: true });
    try {
      const result = await libraryIpc.scan(folder, recursive);
      useAppStore.setState({ libraryItems: result });
    } catch (err) {
      useAppStore.getState().showToast(`Library scan failed: ${err}`, "error", 8000);
    } finally {
      useAppStore.setState({ libraryScanning: false });
    }
  };

  return (
    <div className="h-full bg-fvp-bg text-fvp-text flex flex-col">
      <header className="px-5 py-4 border-b border-fvp-border bg-fvp-surface flex items-center gap-3">
        <h2 className="text-base font-semibold">Library</h2>
        <button
          onClick={() => void pickFolder()}
          className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded cursor-pointer hover:opacity-90"
        >
          {folder ? "Change folder…" : "Pick folder…"}
        </button>
        {folder && (
          <>
            <label className="flex items-center gap-1 text-[11px] text-fvp-muted cursor-pointer">
              <input
                type="checkbox"
                checked={recursive}
                onChange={(e) =>
                  useAppStore.setState({ libraryRecursive: e.target.checked })
                }
                className="accent-fvp-accent"
              />
              Recursive (up to 6 levels)
            </label>
            <button
              onClick={() => void doScan()}
              disabled={scanning}
              className="px-2 py-1 text-xs text-fvp-muted hover:text-fvp-text rounded cursor-pointer disabled:opacity-50"
              title="Re-scan the folder"
            >
              ↻ Rescan
            </button>
          </>
        )}
        <div className="flex-1" />
        {folder && (
          <span
            className="text-[11px] text-fvp-muted font-mono truncate max-w-[480px]"
            title={folder}
          >
            {folder}
          </span>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {!folder ? (
          <EmptyState onPick={pickFolder} />
        ) : scanning ? (
          <div className="p-8 text-center text-fvp-muted text-sm">
            <div className="inline-block w-8 h-8 border-2 border-fvp-border border-t-fvp-accent rounded-full animate-spin mb-3" />
            <div>Scanning {folder}…</div>
          </div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-fvp-muted text-sm">
            No video files found in this folder.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-fvp-surface border-b border-fvp-border text-[10px] uppercase tracking-wider text-fvp-muted">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Filename</th>
                <th className="text-right px-4 py-2 font-medium">Size</th>
                <th className="text-center px-4 py-2 font-medium">Profiles</th>
                <th className="text-right px-4 py-2 font-medium">Modified</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.path}
                  onDoubleClick={() => {
                    useAppStore.setState({ mode: "player" });
                    void openVideoPath(item.path);
                  }}
                  className="border-b border-fvp-border/40 hover:bg-fvp-surface2 cursor-pointer"
                  title={`Double-click to open in Player\n${item.path}`}
                >
                  <td className="px-4 py-2 text-fvp-text truncate max-w-[420px]">
                    {item.filename}
                  </td>
                  <td className="px-4 py-2 text-right text-fvp-muted font-mono tabular-nums">
                    {formatSize(item.size_bytes)}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {item.profile_count > 0 ? (
                      <span className="px-2 py-0.5 text-[10px] bg-fvp-accent/20 text-fvp-accent rounded-full">
                        {item.profile_count}
                      </span>
                    ) : (
                      <span className="text-[10px] text-fvp-muted/60">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-fvp-muted text-[11px] font-mono">
                    {formatDate(item.modified_unix)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <footer className="px-5 py-2 border-t border-fvp-border text-[11px] text-fvp-muted bg-fvp-surface">
        {items.length} video{items.length === 1 ? "" : "s"} ·{" "}
        {items.reduce((s, i) => s + i.profile_count, 0)} profile
        {items.reduce((s, i) => s + i.profile_count, 0) === 1 ? "" : "s"} found ·
        double-click to open
      </footer>
    </div>
  );
}

function EmptyState({ onPick }: { onPick: () => Promise<void> }) {
  return (
    <div className="h-full flex flex-col items-center justify-center text-fvp-muted text-sm">
      <div className="mb-2 text-base text-fvp-text">No folder selected</div>
      <div className="mb-4 text-[12px]">
        Pick a folder containing your video collection.
      </div>
      <button
        onClick={() => void onPick()}
        className="px-4 py-2 bg-fvp-accent text-white text-sm rounded hover:opacity-90 cursor-pointer"
      >
        Pick folder…
      </button>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatDate(unix: number): string {
  if (unix === 0) return "—";
  const d = new Date(unix * 1000);
  return (
    d.toLocaleDateString() +
    " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}
