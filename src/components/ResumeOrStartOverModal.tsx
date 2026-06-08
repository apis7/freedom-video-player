import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";
import { formatTime } from "../utils/format";

interface Props {
  /** Last saved watch progress in milliseconds. */
  progressMs: number;
  /** Total movie duration in milliseconds (for percentage display). */
  durationMs: number;
  /** Movie title to show in the prompt. */
  title: string;
  onResolved: () => void;
}

/**
 * "Resume or start over?" modal — shown after a partially-watched movie
 * loads in Player Mode (within the 5–90 % range; outside that range we
 * don't pester). Hands off the seek decision and closes itself.
 */
export function ResumeOrStartOverModal({
  progressMs,
  durationMs,
  title,
  onResolved,
}: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onResolved();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void resume();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onResolved]);

  const pct =
    durationMs > 0 ? Math.round((progressMs / durationMs) * 100) : 0;
  const resume = async () => {
    try {
      await playback.seek(progressMs / 1000);
    } catch {
      // Ignored — playback will start at 0 if seek fails, no big deal.
    }
    onResolved();
  };
  const startOver = async () => {
    try {
      await playback.seek(0);
    } catch {}
    onResolved();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center"
      onClick={onResolved}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[400px] max-w-[520px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-2">
          Resume {title}?
        </div>
        <div className="text-[12px] text-fvp-muted mb-4 leading-relaxed">
          You stopped at{" "}
          <span className="font-mono text-fvp-text">
            {formatTime(progressMs / 1000)}
          </span>{" "}
          ({pct}% in).
        </div>
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={() => void startOver()}
            className="px-3 py-1.5 bg-fvp-bg border border-fvp-border hover:border-fvp-muted text-fvp-text rounded"
          >
            Start over
          </button>
          <button
            onClick={() => void resume()}
            autoFocus
            className="px-4 py-1.5 bg-fvp-accent text-white rounded hover:opacity-90 font-semibold"
          >
            Resume
          </button>
        </div>
      </div>
    </div>
  );
}
