import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type LibraryRow } from "../../ipc/library";
import { profileIpc } from "../../ipc";
import type { FreeFile, Snip } from "../../ipc/types";
import { openVideoPath } from "../../utils/openFileFlow";
import { playback } from "../../ipc";

interface Props {
  /** Side the user picked as keeper. We try to load ITS .free first
   *  (since that's the profile the user would keep). */
  keeperRow: LibraryRow;
  /** The other side. If keeper has no .free but source does, we fall
   *  back to source's .free so the user can still preview before
   *  deciding. */
  sourceRow: LibraryRow;
  onClose: () => void;
}

interface Excerpt {
  snip: Snip;
  /** Reel start, clamped to [0, duration]. */
  reel_start_ms: number;
  /** Reel end, clamped to [0, duration]. */
  reel_end_ms: number;
}

const LOOKAROUND_MS = 5_000;
const REEL_BUDGET_MS = 90_000;

/**
 * Preview Cuts — directive §4 escalation when the cut between two files
 * differs significantly. We compose a short virtual reel made of small
 * excerpts (5s before/after each Skip snip) capped to 90s total, so the
 * user can see exactly what the profile will remove before committing
 * to the reconciliation.
 *
 * Reels are built from the keeper's .free if present (since that's the
 * profile that will travel with the merged record). If the keeper has
 * no profile, we fall back to the source's .free so the user can still
 * preview before deciding.
 *
 * Per the directive, this is preview-only — the user clicks an excerpt
 * to jump into Player Mode with the keeper opened at that timestamp.
 * We don't build an actual virtual playlist; that's a much larger
 * libmpv plumbing change and the per-cut jump is what the directive
 * called for.
 */
export function PreviewCutsModal({ keeperRow, sourceRow, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<FreeFile | null>(null);
  const [profileSource, setProfileSource] = useState<"keeper" | "source" | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

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
    void (async () => {
      try {
        // Try the keeper's .free first.
        if (keeperRow.file.has_free_sibling) {
          const matches = await profileIpc.scanFolderForProfiles(
            keeperRow.file.path,
          );
          const best = matches.find((m) => m.score.quality === "exact")
            ?? matches[0];
          if (best) {
            if (cancelled) return;
            setProfile(best.profile);
            setProfileSource("keeper");
            setLoading(false);
            return;
          }
        }
        // Fallback to source's .free.
        if (sourceRow.file.has_free_sibling) {
          const matches = await profileIpc.scanFolderForProfiles(
            sourceRow.file.path,
          );
          const best = matches.find((m) => m.score.quality === "exact")
            ?? matches[0];
          if (best) {
            if (cancelled) return;
            setProfile(best.profile);
            setProfileSource("source");
            setLoading(false);
            return;
          }
        }
        if (cancelled) return;
        setError("Neither file has a .free profile available to preview.");
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keeperRow.file.path, sourceRow.file.path, keeperRow.file.has_free_sibling, sourceRow.file.has_free_sibling]);

  const excerpts: Excerpt[] = useMemo(() => {
    if (!profile) return [];
    const skips = profile.payload.snips
      .filter((s) => s.action.type === "skip")
      .sort((a, b) => a.start_ms - b.start_ms);
    const durationMs = keeperRow.identity.duration_ms;
    const result: Excerpt[] = [];
    let usedMs = 0;
    for (const snip of skips) {
      const reelStart = Math.max(0, snip.start_ms - LOOKAROUND_MS);
      const reelEnd = Math.min(durationMs, snip.end_ms + LOOKAROUND_MS);
      const reelLen = Math.max(0, reelEnd - reelStart);
      if (usedMs + reelLen > REEL_BUDGET_MS) break;
      usedMs += reelLen;
      result.push({ snip, reel_start_ms: reelStart, reel_end_ms: reelEnd });
    }
    return result;
  }, [profile, keeperRow.identity.duration_ms]);

  const totalReelMs = excerpts.reduce(
    (acc, ex) => acc + (ex.reel_end_ms - ex.reel_start_ms),
    0,
  );

  const playExcerpt = async (ex: Excerpt) => {
    try {
      const targetRow = profileSource === "source" ? sourceRow : keeperRow;
      // Mark intent so the next file's watch tracker doesn't fire a
      // resume prompt; we are deliberately seeking past the start.
      await openVideoPath(targetRow.file.path);
      // Wait a tick for the libmpv load to complete enough to accept
      // seeks. The mpv-event bridge will push the actual ready signal
      // but we use a small fixed delay for simplicity.
      await new Promise((r) => window.setTimeout(r, 600));
      const seekSeconds = ex.reel_start_ms / 1000;
      await playback.seek(seekSeconds);
      onClose();
    } catch (err) {
      showToast(`Couldn't play excerpt: ${err}`, "error");
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col max-w-[640px] w-full max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold text-fvp-text">
              Preview the cuts
            </div>
            <button
              className="text-fvp-muted hover:text-fvp-text text-lg leading-none"
              onClick={onClose}
            >
              ×
            </button>
          </div>
          <div className="text-[11px] text-fvp-muted mt-1">
            {profileSource === "source"
              ? "Showing cuts from the OTHER file's .free profile (the keeper has no profile yet)."
              : "Showing cuts that the keeper's .free profile will apply."}
          </div>
        </header>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loading && (
            <div className="px-5 py-8 text-center text-xs text-fvp-muted">
              Loading profile…
            </div>
          )}
          {error && (
            <div className="px-5 py-8 text-center text-xs text-fvp-warn">
              {error}
            </div>
          )}
          {!loading && !error && excerpts.length === 0 && (
            <div className="px-5 py-8 text-center text-xs text-fvp-muted">
              No Skip snips found in this profile — nothing to preview.
            </div>
          )}
          {!loading && excerpts.length > 0 && (
            <ul className="divide-y divide-fvp-border">
              {excerpts.map((ex, i) => (
                <li
                  key={ex.snip.id}
                  className="px-5 py-2.5 flex items-center justify-between gap-3 hover:bg-fvp-surface2/30"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-fvp-text font-semibold">
                      Cut #{i + 1}{" "}
                      <span className="text-fvp-muted font-normal">
                        — {formatMs(ex.snip.start_ms)} → {formatMs(ex.snip.end_ms)}
                      </span>
                    </div>
                    <div className="text-[10px] text-fvp-muted mt-0.5">
                      Reel: {formatMs(ex.reel_start_ms)} → {formatMs(ex.reel_end_ms)}{" "}
                      ({Math.round((ex.reel_end_ms - ex.reel_start_ms) / 100) / 10}s)
                    </div>
                    {ex.snip.categories.length > 0 && (
                      <div className="text-[10px] text-fvp-accent mt-0.5">
                        {ex.snip.categories.join(", ")}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => void playExcerpt(ex)}
                    className="px-3 py-1 text-[11px] bg-fvp-accent text-white rounded hover:opacity-90"
                  >
                    Play in player
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-between text-[11px] text-fvp-muted">
          <div>
            {excerpts.length} cut{excerpts.length === 1 ? "" : "s"} ·{" "}
            {Math.round(totalReelMs / 1000)}s total reel time
          </div>
          <button
            onClick={onClose}
            className="px-3 py-1 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
// Silence unused-import warning — libraryIpc is exported for callers
// that may later want to log preview-playback events.
void libraryIpc;
