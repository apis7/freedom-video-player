import { useEffect, useState } from "react";
import {
  libraryIpc,
  type ShareCandidate,
  type ShareScanResult,
} from "../../ipc/library";
import { useAppStore } from "../../state/appStore";

/**
 * Modal that pops up after the user picks a home folder. Asks two
 * things:
 *
 *   1. "Also watch this home folder for videos?" — defaults on unless
 *      the folder is already in watched_folders.
 *   2. If the home folder is on a UNC share (\\server\share\...), the
 *      backend scans sibling dirs at the share root and offers any that
 *      look like media dirs as additional watched-folder candidates.
 *      Pre-checked when the heuristic says "looks like media."
 *
 * One-shot per pick — closes itself after Add Selected / Skip. The
 * parent controls visibility by setting `homePath` to a non-null path
 * after each successful set_home_folder / set_home_folder_from_marker.
 */
export function WatchHomeFolderPrompt({
  homePath,
  onClose,
}: {
  homePath: string;
  onClose: () => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [scan, setScan] = useState<ShareScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [watchHome, setWatchHome] = useState(true);
  const [selectedSiblings, setSelectedSiblings] = useState<Set<string>>(
    new Set(),
  );
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setScan(null);
    setScanError(null);
    libraryIpc
      .scanShareForWatchableDirs(homePath)
      .then((r) => {
        if (cancelled) return;
        setScan(r);
        setWatchHome(!r.home_already_watched);
        // Pre-select siblings the backend flagged as media-looking.
        setSelectedSiblings(
          new Set(
            r.candidates
              .filter((c) => c.looks_like_media)
              .map((c) => c.path),
          ),
        );
      })
      .catch((err) => {
        if (cancelled) return;
        // Failure here isn't fatal — user can still skip / pick "watch
        // the home folder" without sibling probing. We just surface it.
        setScanError(String(err));
        setScan({
          home_path: homePath,
          share_root: null,
          candidates: [],
          home_already_watched: false,
        });
        setWatchHome(true);
      });
    return () => {
      cancelled = true;
    };
  }, [homePath]);

  const toggleSibling = (path: string) => {
    setSelectedSiblings((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const nothingToAdd =
    !watchHome && selectedSiblings.size === 0;

  const onAdd = async () => {
    if (nothingToAdd) {
      onClose();
      return;
    }
    setAdding(true);
    const toAdd: string[] = [];
    if (watchHome && scan && !scan.home_already_watched) {
      toAdd.push(homePath);
    }
    for (const c of selectedSiblings) toAdd.push(c);

    let ok = 0;
    const failures: { path: string; error: string }[] = [];
    for (const p of toAdd) {
      try {
        await libraryIpc.addFolder(p, true);
        ok += 1;
      } catch (err) {
        failures.push({ path: p, error: String(err) });
      }
    }
    setAdding(false);

    if (ok > 0) {
      showToast(
        `Now watching ${ok} folder${ok === 1 ? "" : "s"} for videos.`,
        "info",
        3000,
      );
    }
    for (const f of failures) {
      showToast(`Couldn't watch "${f.path}": ${f.error}`, "error", 5000);
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[min(560px,90vw)] max-h-[85vh] overflow-y-auto rounded-lg border border-fvp-line bg-fvp-bg p-5 text-sm text-fvp-fg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1">
          Watch folders for videos?
        </h2>
        <p className="text-xs text-fvp-muted mb-4">
          FVP only indexes folders you tell it to. Pick which folders
          to scan — you can change this any time in Settings.
        </p>

        {scan === null && !scanError && (
          <div className="py-8 text-center text-xs text-fvp-muted">
            Looking for shared folders…
          </div>
        )}

        {scan !== null && (
          <>
            <label className="flex items-start gap-2 p-2 rounded hover:bg-fvp-bg-alt cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={watchHome}
                disabled={scan.home_already_watched}
                onChange={(e) => setWatchHome(e.target.checked)}
              />
              <span className="flex-1">
                <span className="font-medium">
                  {scan.home_already_watched
                    ? "Home folder (already watched)"
                    : "Watch the home folder itself"}
                </span>
                <br />
                <code className="text-[11px] text-fvp-muted break-all">
                  {homePath}
                </code>
              </span>
            </label>

            {scan.share_root && scan.candidates.length > 0 && (
              <>
                <div className="mt-4 mb-2 text-xs text-fvp-muted">
                  Folders on the same share{" "}
                  <code className="text-[11px]">{scan.share_root}</code>:
                </div>
                <div className="space-y-1">
                  {scan.candidates.map((c: ShareCandidate) => (
                    <label
                      key={c.path}
                      className="flex items-start gap-2 p-2 rounded hover:bg-fvp-bg-alt cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={selectedSiblings.has(c.path)}
                        onChange={() => toggleSibling(c.path)}
                      />
                      <span className="flex-1">
                        <code className="text-[11px] break-all">
                          {c.path}
                        </code>
                        {c.looks_like_media && (
                          <span className="ml-2 text-[10px] text-fvp-accent">
                            ★ has videos
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {scan.share_root && scan.candidates.length === 0 && (
              <div className="mt-4 text-xs text-fvp-muted">
                No other unwatched folders found on{" "}
                <code className="text-[11px]">{scan.share_root}</code>.
              </div>
            )}

            {!scan.share_root && (
              <div className="mt-4 text-xs text-fvp-muted">
                Home folder is on a local drive, so no cross-device
                siblings to auto-suggest.
              </div>
            )}

            {scanError && (
              <div className="mt-3 text-[11px] text-fvp-warning">
                Couldn't scan share: {scanError}
              </div>
            )}
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-1.5 text-xs rounded border border-fvp-line hover:bg-fvp-bg-alt"
            onClick={onClose}
            disabled={adding}
          >
            Skip
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-xs rounded bg-fvp-accent text-white hover:bg-fvp-accent/90 disabled:opacity-50"
            onClick={onAdd}
            disabled={adding || nothingToAdd}
          >
            {adding
              ? "Adding…"
              : nothingToAdd
                ? "Nothing selected"
                : `Add selected (${
                    (watchHome && !scan?.home_already_watched ? 1 : 0) +
                    selectedSiblings.size
                  })`}
          </button>
        </div>
      </div>
    </div>
  );
}
