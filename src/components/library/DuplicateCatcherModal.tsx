import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  type DuplicateCluster,
} from "../../ipc/library";
import { LibraryPoster } from "./LibraryPoster";
import { formatBytes } from "./libraryFormat";

interface Props {
  /** Pre-loaded clusters from `library_find_duplicates`. The host fires
   *  this when the user clicks the "Duplicate Catcher" header button so
   *  the modal opens instantly instead of showing a spinner. */
  clusters: DuplicateCluster[];
  /** Refresh + close — called after any destructive action so the
   *  parent can re-fetch the library. */
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}

/**
 * Duplicate Catcher — library_directive §3 "Same-fingerprint clusters".
 * Files that share a strong_fingerprint are confirmed identical content
 * (same byte stream). The user picks one to keep and chooses what to do
 * with the rest:
 *   - Remove from library (DB record only)
 *   - Delete from disk (sends loser files to Recycle Bin via trash crate)
 *
 * No PROBABLE / quality-variant reasoning here — that's the
 * ReconciliationDialog's job. This modal is for files we're sure are
 * duplicates.
 */
export function DuplicateCatcherModal({ clusters, onChanged, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [keeperIdx, setKeeperIdx] = useState(0);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const cluster = clusters[active];

  // Reset keeper choice when switching clusters — the biggest file is
  // usually the keeper (no quality loss), so prefer that as default.
  useEffect(() => {
    if (!cluster) return;
    let best = 0;
    let bestSize = -1;
    cluster.files.forEach((row, i) => {
      if (row.file.size_bytes > bestSize) {
        bestSize = row.file.size_bytes;
        best = i;
      }
    });
    setKeeperIdx(best);
  }, [active, cluster]);

  const losers = useMemo(() => {
    if (!cluster) return [];
    return cluster.files.filter((_, i) => i !== keeperIdx);
  }, [cluster, keeperIdx]);

  const act = async (mode: "remove" | "trash") => {
    if (!cluster || busy) return;
    setBusy(true);
    try {
      const loserFileIds = losers.map((r) => r.file.id);
      if (loserFileIds.length === 0) {
        showToast("Nothing to do — keeper is the only file.", "info", 2000);
        setBusy(false);
        return;
      }
      const result =
        mode === "trash"
          ? await libraryIpc.trashFiles(loserFileIds)
          : await libraryIpc.removeFiles(loserFileIds);
      const ok = result.removed + result.trashed;
      const verb = mode === "trash" ? "sent to Recycle Bin" : "removed";
      showToast(
        `${ok} duplicate${ok === 1 ? "" : "s"} ${verb}${result.failed.length ? ` (${result.failed.length} failed)` : ""}`,
        result.failed.length > 0 ? "warn" : "info",
        3000,
      );
      // Advance to next cluster — the current cluster's file rows are
      // now stale but we won't re-fetch; the parent will refresh on close.
      if (active < clusters.length - 1) {
        setActive(active + 1);
      } else {
        await onChanged();
        onClose();
      }
    } catch (err) {
      showToast(`Action failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  if (!cluster) {
    return (
      <div
        className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
        onClick={onClose}
      >
        <div
          className="bg-fvp-surface border border-fvp-border rounded-lg p-6 max-w-md"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-fvp-text font-semibold mb-2">
            No duplicate clusters found.
          </div>
          <div className="text-xs text-fvp-muted mb-4">
            Files only appear here when two or more share a strong (BLAKE3)
            fingerprint — same exact bytes.
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1 bg-fvp-accent text-white rounded text-xs"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col max-w-[720px] w-full max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold text-fvp-text">
              Duplicate Catcher
            </div>
            <span className="text-[11px] text-fvp-muted">
              Cluster {active + 1} of {clusters.length}
            </span>
          </div>
          <button
            className="text-fvp-muted hover:text-fvp-text text-lg leading-none"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="px-5 py-3 border-b border-fvp-border bg-fvp-bg/40">
          <div className="text-[11px] text-fvp-muted">
            {cluster.files.length} file{cluster.files.length === 1 ? "" : "s"}{" "}
            share the same strong fingerprint — identical content. Pick one
            to keep:
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          <ul className="divide-y divide-fvp-border">
            {cluster.files.map((row, i) => (
              <li
                key={row.file.id}
                onClick={() => setKeeperIdx(i)}
                className={
                  "px-5 py-3 cursor-pointer flex items-center gap-3 " +
                  (i === keeperIdx
                    ? "bg-fvp-accent/10 border-l-4 border-fvp-accent"
                    : "hover:bg-fvp-surface2/30 border-l-4 border-transparent")
                }
              >
                <input
                  type="radio"
                  checked={i === keeperIdx}
                  onChange={() => setKeeperIdx(i)}
                  className="accent-fvp-accent"
                />
                <LibraryPoster
                  customThumbnailPath={row.identity.custom_thumbnail_path}
                  posterLocalPath={row.identity.poster_local_path}
                  widthPx={56}
                  alt={row.identity.movie_title ?? ""}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-fvp-text truncate">
                    {row.identity.movie_title ?? "(no title)"}
                  </div>
                  <div className="text-[10px] text-fvp-muted font-mono truncate">
                    {row.file.path}
                  </div>
                  <div className="text-[10px] text-fvp-muted">
                    {row.file.resolution ?? "—"} ·{" "}
                    {formatBytes(row.file.size_bytes)}
                    {row.profile_status === "has_profile" && (
                      <span className="text-fvp-accent ml-2">★ .free</span>
                    )}
                  </div>
                </div>
                {i === keeperIdx && (
                  <span className="text-[10px] text-fvp-accent font-bold uppercase tracking-wider">
                    Keep
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center gap-2 text-xs">
          <button
            onClick={() => active > 0 && setActive(active - 1)}
            disabled={active === 0 || busy}
            className="px-2 py-1 text-fvp-muted hover:text-fvp-text rounded disabled:opacity-30"
          >
            ‹ Prev
          </button>
          <button
            onClick={() => active < clusters.length - 1 && setActive(active + 1)}
            disabled={active === clusters.length - 1 || busy}
            className="px-2 py-1 text-fvp-muted hover:text-fvp-text rounded disabled:opacity-30"
          >
            Skip ›
          </button>
          <div className="flex-1" />
          <button
            onClick={() => void act("remove")}
            disabled={busy || losers.length === 0}
            className="px-3 py-1 bg-fvp-surface2 text-fvp-text rounded hover:bg-fvp-surface2/70 disabled:opacity-50"
            title="Remove the non-keeper files from the library; videos stay on disk."
          >
            Keep one · remove others from library
          </button>
          <button
            onClick={() => void act("trash")}
            disabled={busy || losers.length === 0}
            className="px-3 py-1 bg-fvp-err text-white rounded hover:opacity-90 disabled:opacity-50"
            title="Move non-keeper video files to OS Recycle Bin."
          >
            Keep one · delete others from disk
          </button>
        </footer>
      </div>
    </div>
  );
}

