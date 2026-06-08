import { useCallback, useEffect, useRef, useState } from "react";
import { libraryIpc, type LibraryRow } from "../../ipc/library";
import { LibraryPoster } from "./LibraryPoster";
import { openVideoPath } from "../../utils/openFileFlow";
import { useAppStore } from "../../state/appStore";

interface Props {
  /** Re-fetched whenever the library list changes — keeps the rail in
   *  sync with watch/dismiss updates without manual coordination. */
  refreshToken: number;
  familyViewOn: boolean;
}

/** Auto-rotate cadence: pull a fresh suggestion every 5 min, with a
 *  visible circular countdown next to the Next button so the user sees
 *  when the next change is coming. */
const ROTATE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * "Suggested Movie" rail — sits at the top of the filters sidebar.
 * Pulls one weighted-random pick from the full library and shows its
 * poster + title. Auto-rotates every 5 minutes; user can also click
 * Next to dismiss + see another (dismissed for 7 days).
 */
export function LibrarySuggestionRail({ refreshToken, familyViewOn }: Props) {
  const [row, setRow] = useState<LibraryRow | null>(null);
  const [loading, setLoading] = useState(false);
  // Track the wall-clock time the current suggestion was shown so the
  // countdown ring can render the right elapsed-fraction without
  // requiring per-frame state writes.
  const [rotateAnchor, setRotateAnchor] = useState<number>(() => Date.now());
  const showToast = useAppStore((s) => s.showToast);

  const fetchNext = useCallback(
    async (reason: "rotate" | "manual" | "dismiss" | "refresh") => {
      setLoading(true);
      try {
        const next = await libraryIpc.suggestNext(familyViewOn);
        setRow(next);
        setRotateAnchor(Date.now());
        // Quiet log so the terminal shows when auto-rotation fires.
        // eslint-disable-next-line no-console
        console.log(`[fvp:suggest] fetched (reason=${reason})`);
      } catch (err) {
        showToast(`Suggestion failed: ${err}`, "error");
      } finally {
        setLoading(false);
      }
    },
    [familyViewOn, showToast],
  );

  useEffect(() => {
    void fetchNext("refresh");
  }, [fetchNext, refreshToken]);

  // Auto-rotate every 5 minutes (re-armed by every fetch via rotateAnchor).
  useEffect(() => {
    if (!row) return;
    const t = window.setTimeout(() => {
      void fetchNext("rotate");
    }, ROTATE_INTERVAL_MS);
    return () => window.clearTimeout(t);
  }, [row, rotateAnchor, fetchNext]);

  if (!row && !loading) return null;

  return (
    <div className="px-3 py-2 border-b border-fvp-border bg-fvp-bg">
      <div className="text-[9px] uppercase tracking-wider text-fvp-muted mb-2">
        Suggested
      </div>
      {loading && !row && (
        <div className="text-fvp-muted text-[11px]">Picking…</div>
      )}
      {row && (
        <div className="flex gap-2">
          <button
            onClick={() => void openVideoPath(row.file.path)}
            title="Play this"
            className="shrink-0 cursor-pointer hover:opacity-90"
          >
            <LibraryPoster
              customThumbnailPath={row.identity.custom_thumbnail_path}
              posterLocalPath={row.identity.poster_local_path}
              widthPx={56}
              alt={row.identity.movie_title ?? ""}
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold text-fvp-text leading-tight line-clamp-2">
              {row.identity.movie_title ??
                row.file.path.split(/[\\/]/).pop() ??
                "(untitled)"}
            </div>
            {row.identity.movie_year && (
              <div className="text-[10px] text-fvp-muted">
                {row.identity.movie_year}
              </div>
            )}
            <div className="flex items-center gap-1 mt-1.5">
              <button
                onClick={() => void openVideoPath(row.file.path)}
                className="text-[10px] px-1.5 py-0.5 bg-fvp-accent text-white rounded hover:opacity-90"
              >
                Play
              </button>
              <button
                onClick={() => {
                  void libraryIpc
                    .dismissSuggestion(row.identity.id)
                    .then(() => fetchNext("dismiss"));
                }}
                className="text-[10px] px-1.5 py-0.5 bg-fvp-bg border border-fvp-border text-fvp-muted hover:text-fvp-text rounded"
                title="Don't suggest for 7 days"
              >
                Next →
              </button>
              <CountdownRing
                resetAt={rotateAnchor}
                durationMs={ROTATE_INTERVAL_MS}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Small light-gray-to-dark-gray circular countdown that fills as time
 * progresses toward the next auto-rotate. No text — just a visual
 * indicator. Uses requestAnimationFrame for smooth motion; sleeps when
 * the tab is hidden so it doesn't burn CPU in the background.
 */
function CountdownRing({
  resetAt,
  durationMs,
}: {
  resetAt: number;
  durationMs: number;
}) {
  const [pct, setPct] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - resetAt;
      const next = Math.min(1, elapsed / durationMs);
      setPct(next);
      if (next < 1) {
        rafRef.current = window.requestAnimationFrame(tick);
      }
    };
    rafRef.current = window.requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
      }
    };
  }, [resetAt, durationMs]);

  // 14x14 SVG with two arcs: a faint base ring + a stroked arc that
  // grows as pct increases. The arc is drawn via stroke-dasharray on
  // the full circumference so it animates as a swept fill.
  const size = 14;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="ml-1 shrink-0"
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        className="text-fvp-border"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        className="text-fvp-muted"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct)}
        // Start the arc at 12 o'clock and sweep clockwise.
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
