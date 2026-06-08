import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc } from "../../ipc/library";
import type { LibraryRow } from "../../ipc/library";
import { openVideoPath } from "../../utils/openFileFlow";

/**
 * Themed modal shown when the user tries to open a library file whose
 * path no longer exists on disk. Replaces the old native `alert()`.
 *
 * On open, kicks off a watched-folders search by filename. Three
 * outcomes the user can act on:
 *
 *   1. Search finds exactly one new location → big "Update path and
 *      play" button auto-relocates the DB row, refreshes the library,
 *      and starts playback.
 *   2. Search finds 2+ matches → list of candidate paths the user
 *      clicks one of to disambiguate.
 *   3. Search finds nothing → "Browse for file…" opens the OS picker.
 *      The picked path is saved as the new file location.
 *
 * In every case the existing identity / tags / series / collection
 * memberships survive — we update `library_files.path` in place.
 */
export function BrokenFileModal({
  row,
  onClose,
  onResolved,
}: {
  row: LibraryRow;
  onClose: () => void;
  onResolved: () => void;
}) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);

  const [searching, setSearching] = useState(true);
  const [hits, setHits] = useState<string[]>([]);
  const filename = row.file.path.split(/[\\/]/).pop() ?? row.file.path;

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const found = await libraryIpc.searchByFilename(filename);
        if (cancelled) return;
        setHits(found);
      } catch (err) {
        if (cancelled) return;
        showToast(`Search failed: ${err}`, "error", 4000);
      } finally {
        if (!cancelled) setSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filename, showToast]);

  const relocateTo = async (newPath: string) => {
    try {
      await libraryIpc.relocateFile(row.file.id, newPath);
      showToast("File location updated.", "info", 2500);
      onResolved();
      onClose();
      // Auto-switch to player and start playback at the new location.
      useAppStore.setState({ mode: "player" });
      void openVideoPath(newPath);
    } catch (err) {
      showToast(`Relocate failed: ${err}`, "error", 4000);
    }
  };

  const browseForFile = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({
        multiple: false,
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
      if (typeof picked !== "string") return;
      await relocateTo(picked);
    } catch (err) {
      showToast(`Couldn't open file picker: ${err}`, "error", 4000);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-fvp-border flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-fvp-err/20 border border-fvp-err/60 flex items-center justify-center text-fvp-err text-lg shrink-0">
            ✕
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-fvp-text">
              File location is broken
            </div>
            <div className="text-[11px] text-fvp-muted truncate" title={row.file.path}>
              {row.file.path}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 flex-1 overflow-y-auto text-xs space-y-3">
          {searching && (
            <div className="text-fvp-muted">
              Searching your watched folders for{" "}
              <span className="font-mono text-fvp-text">{filename}</span>…
            </div>
          )}

          {!searching && hits.length === 0 && (
            <div className="space-y-2">
              <div className="text-fvp-muted">
                No matching files found in your watched folders.
              </div>
              <div className="text-fvp-muted">
                If you moved this file outside of any watched folder,
                browse to its new location so the library can re-link it.
                Your tags, profile, and series membership will survive.
              </div>
            </div>
          )}

          {!searching && hits.length === 1 && (
            <div className="space-y-2">
              <div className="text-fvp-muted">Found a match:</div>
              <div className="bg-fvp-bg border border-fvp-border rounded px-2 py-1.5 font-mono text-[11px] break-all">
                {hits[0]}
              </div>
            </div>
          )}

          {!searching && hits.length > 1 && (
            <div className="space-y-2">
              <div className="text-fvp-muted">
                Found {hits.length} possible matches — pick the right one:
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {hits.map((h) => (
                  <button
                    key={h}
                    onClick={() => void relocateTo(h)}
                    className="block w-full text-left bg-fvp-bg border border-fvp-border hover:border-fvp-accent rounded px-2 py-1.5 font-mono text-[11px] break-all"
                  >
                    {h}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-fvp-border flex gap-2 justify-end">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => void browseForFile()}
            className="px-3 py-1.5 text-xs bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded"
          >
            Browse for file…
          </button>
          {!searching && hits.length === 1 && (
            <button
              onClick={() => void relocateTo(hits[0]!)}
              className="px-3 py-1.5 text-xs bg-fvp-accent text-white rounded hover:opacity-90"
            >
              Update path and play
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
