import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";
import { markUserNavigation } from "../utils/navGuard";

interface Props {
  onClose: () => void;
}

/**
 * Shown when the user tries to save but has snips with no categories.
 * Categories are required for export — a snip with no category has no
 * meaningful action semantics. Modal walks the user to the first
 * uncategorized snip and reminds them of the navigation hotkey so they
 * can keep fixing the rest without leaving the keyboard.
 */
export function UncategorizedSnipsModal({ onClose }: Props) {
  const snips = useAppStore((s) => s.snips);
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
        onClose();
      } else if (e.key === "Enter") {
        e.preventDefault();
        jumpToFirst();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose]);

  // Sorted to give "first" a stable meaning (timeline order, not insertion).
  const uncategorized = [...snips]
    .filter((s) => s.categories.length === 0)
    .sort((a, b) => a.start_ms - b.start_ms);
  const count = uncategorized.length;

  const jumpToFirst = () => {
    const first = uncategorized[0];
    if (!first) {
      onClose();
      return;
    }
    useAppStore.getState().selectSnip(first.id);
    markUserNavigation();
    void playback.seek(first.start_ms / 1000);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[440px] max-w-[560px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-2">
          Can&apos;t save — uncategorized snips
        </div>
        <div className="text-[12px] text-fvp-muted mb-3 leading-relaxed">
          {count} snip{count === 1 ? "" : "s"} {count === 1 ? "needs" : "need"} at
          least one category before this profile can be saved. (A snip without a
          category has no meaningful action.)
        </div>
        <div className="text-[11px] text-fvp-muted mb-4 leading-relaxed border-l-2 border-fvp-border pl-3">
          Tip: press <kbd className="font-mono bg-fvp-bg border border-fvp-border rounded px-1">Ctrl</kbd>+
          <kbd className="font-mono bg-fvp-bg border border-fvp-border rounded px-1">Tab</kbd> /
          {" "}<kbd className="font-mono bg-fvp-bg border border-fvp-border rounded px-1">Ctrl</kbd>+
          <kbd className="font-mono bg-fvp-bg border border-fvp-border rounded px-1">Shift</kbd>+
          <kbd className="font-mono bg-fvp-bg border border-fvp-border rounded px-1">Tab</kbd>
          {" "}to jump between uncategorized snips without leaving the keyboard.
        </div>
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Cancel
          </button>
          <button
            onClick={jumpToFirst}
            autoFocus
            className="px-3 py-1.5 bg-fvp-accent text-white rounded hover:opacity-90"
          >
            Jump to first uncategorized →
          </button>
        </div>
      </div>
    </div>
  );
}
