import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { normalizeEvent } from "../state/hotkeys";

interface Props {
  current: string;
  onCapture: (key: string) => void;
  onCancel: () => void;
}

/**
 * Modal that captures the next non-modifier keypress and reports the
 * canonical combo string ("Ctrl+Shift+a", "Space", "f"). Escape cancels.
 */
export function HotkeyRecorder({ current, onCapture, onCancel }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cancel on plain Escape.
      if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
        return;
      }
      // Ignore standalone modifier presses — we want the actual key combo.
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      onCapture(normalizeEvent(e));
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onCapture, onCancel]);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-fvp-surface border-2 border-fvp-accent rounded-lg shadow-2xl p-6 min-w-[360px] max-w-[460px] text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-2">
          Press a key…
        </div>
        <div className="text-[11px] text-fvp-muted mb-4">
          Press any key (with optional Ctrl / Shift / Alt) to bind. Press{" "}
          <kbd className="px-1 py-0.5 bg-fvp-bg border border-fvp-border rounded font-mono">
            Esc
          </kbd>{" "}
          to cancel.
        </div>
        <div className="text-xs text-fvp-muted mb-2">Current binding:</div>
        <div className="text-base font-mono text-fvp-accent">{current}</div>
      </div>
    </div>
  );
}
