import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import { MAX_BEEP_DURATION_MS } from "../ipc/types";

interface Props {
  /** ms — the snip's current duration before shortening. */
  currentDurationMs: number;
  onConfirm: (suppressFuturePopups: boolean) => void;
  onCancel: () => void;
}

/**
 * Confirmation popup shown when the user assigns the Beep action to a
 * snip longer than 3 seconds. The snip is shortened from the END (start
 * stays fixed) so they don't lose their alignment with the offensive
 * content's onset. A "don't show this warning again" checkbox suppresses
 * future popups (silently auto-shortens), preference persisted via
 * useSettingsPersist.
 */
export function BeepShortenModal({
  currentDurationMs,
  onConfirm,
  onCancel,
}: Props) {
  const [suppress, setSuppress] = useState(false);
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
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm(suppress);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm, suppress]);

  const currentSecs = (currentDurationMs / 1000).toFixed(2);
  const capSecs = (MAX_BEEP_DURATION_MS / 1000).toFixed(0);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-6"
      onClick={onCancel}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[420px] max-w-[520px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-fvp-text mb-3">
          Beep snips are capped at {capSecs}s
        </h3>
        <p className="text-xs text-fvp-muted mb-3 leading-relaxed">
          This snip is <strong className="text-fvp-text">{currentSecs}s</strong>{" "}
          long. Beep snips are limited to{" "}
          <strong className="text-fvp-text">{capSecs} seconds</strong> — longer
          ones get cumbersome and the tone overstays its welcome.
        </p>
        <p className="text-xs text-fvp-muted mb-4 leading-relaxed">
          If you continue, the snip will be shortened to{" "}
          <strong className="text-fvp-text">{capSecs}s</strong>. The{" "}
          <strong className="text-fvp-text">start time stays the same</strong>;
          the end gets pulled back. Use Silence or Skip instead if you need
          to cover a longer span.
        </p>

        <label className="flex items-center gap-2 text-[11px] text-fvp-muted mb-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={suppress}
            onChange={(e) => setSuppress(e.target.checked)}
            className="accent-fvp-accent"
          />
          Don&apos;t show this warning again
        </label>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs bg-fvp-bg border border-fvp-border text-fvp-text hover:border-fvp-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(suppress)}
            className="px-3 py-1.5 rounded text-xs bg-fvp-accent text-white hover:opacity-90"
            autoFocus
          >
            Shorten and set to Beep
          </button>
        </div>
      </div>
    </div>
  );
}
