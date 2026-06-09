import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";

const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

/**
 * Bottom-right footer badge that pops up after a Full Metadata Refresh
 * finishes. Click → modal with a recap of what was queued, completed,
 * and skipped. OK button dismisses. The badge also auto-dismisses 8
 * hours after the tool was kicked off — at that point the user has
 * either acted on it or moved on, and a stale badge would just be
 * noise.
 *
 * Visibility is driven entirely by `state.fmrSummary` (persisted in
 * localStorage by useSettingsPersist). Setting it to `null` makes the
 * badge + modal disappear; setting it to a fresh summary re-shows.
 */
export function FmrSummaryBadge() {
  const summary = useAppStore((s) => s.fmrSummary);
  const setSummary = useAppStore((s) => s.setFmrSummary);
  const [open, setOpen] = useState(false);
  // Force re-evaluation of the expiry check every minute. Cheap; the
  // single setInterval lifecycle is tied to this component.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  if (!summary) return null;

  // Expiry check: 8h after the tool was first run.
  if (Date.now() - summary.ranAtMs > EIGHT_HOURS_MS) {
    // Clear in a microtask so we don't setState during render.
    queueMicrotask(() => setSummary(null));
    return null;
  }

  const ageMin = Math.max(1, Math.round((Date.now() - summary.ranAtMs) / 60_000));
  const ageLabel =
    ageMin < 60
      ? `${ageMin} min ago`
      : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`Full Metadata Refresh summary — ran ${ageLabel}`}
        className="fixed bottom-3 right-3 z-40 bg-fvp-surface border border-fvp-accent/60 hover:border-fvp-accent text-fvp-text text-[11px] px-3 py-1.5 rounded-full shadow-lg flex items-center gap-2"
      >
        <span className="text-fvp-accent">✓</span>
        <span>Metadata refresh complete</span>
        <span className="text-fvp-muted text-[10px]">({ageLabel})</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/60 z-[70] flex items-center justify-center"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="px-5 py-3 border-b border-fvp-border">
              <div className="text-sm font-semibold text-fvp-text">
                Full Metadata Refresh — Summary
              </div>
              <div className="text-[11px] text-fvp-muted">Ran {ageLabel}</div>
            </header>
            <div className="px-5 py-4 text-xs space-y-3">
              {summary.posterTotal > 0 ? (
                <SummaryRow
                  label="TMDb metadata refresh"
                  completed={summary.posterCompleted}
                  total={summary.posterTotal}
                  unit="items"
                  detail="posters, runtime, year, cast, etc."
                />
              ) : (
                <div className="text-fvp-muted italic">
                  No items needed TMDb refresh.
                </div>
              )}
              {summary.probeTotal > 0 ? (
                <SummaryRow
                  label="File probe"
                  completed={summary.probeFilled}
                  total={summary.probeTotal}
                  unit="files"
                  detail="resolution and/or runtime filled in"
                />
              ) : (
                <div className="text-fvp-muted italic">
                  No files needed a technical probe.
                </div>
              )}
              {summary.posterTotal === 0 && summary.probeTotal === 0 && (
                <div className="text-fvp-muted italic">
                  Nothing was queued — your library was already fully
                  populated.
                </div>
              )}
            </div>
            <footer className="px-5 py-3 border-t border-fvp-border flex justify-end">
              <button
                onClick={() => {
                  setOpen(false);
                  setSummary(null);
                }}
                className="px-4 py-1.5 bg-fvp-accent text-white text-sm rounded hover:opacity-90"
              >
                OK
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

function SummaryRow({
  label,
  completed,
  total,
  unit,
  detail,
}: {
  label: string;
  completed: number;
  total: number;
  unit: string;
  detail: string;
}) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const incomplete = completed < total;
  return (
    <div>
      <div className="flex justify-between items-baseline">
        <span className="text-fvp-text font-medium">{label}</span>
        <span
          className={
            "text-[11px] tabular-nums " +
            (incomplete ? "text-fvp-warn" : "text-fvp-ok")
          }
        >
          {completed} / {total} {unit}
        </span>
      </div>
      <div className="h-1.5 bg-fvp-surface2 rounded mt-1 overflow-hidden">
        <div
          className={
            "h-full rounded " + (incomplete ? "bg-fvp-warn" : "bg-fvp-ok")
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-[10px] text-fvp-muted mt-1">{detail}</div>
      {incomplete && (
        <div className="text-[10px] text-fvp-warn mt-0.5">
          {total - completed} not completed (failures, TMDb misses, or files
          mpv couldn't read)
        </div>
      )}
    </div>
  );
}
