import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { MovieInfoPanel } from "./MovieInfoPanel";

interface Props {
  /** "edit" for Creator Mode (text inputs + TMDb auto-fill);
   *  "view" for Player Mode (read-only display). */
  mode: "edit" | "view";
  onClose: () => void;
}

/** Modal wrapper around MovieInfoPanel — same chrome whether you're
 *  editing in Creator or just looking in Player. Escape closes. */
export function MovieInfoModal({ mode, onClose }: Props) {
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
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[480px] max-w-[640px] max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-fvp-text">
            {mode === "edit" ? "Movie info" : "Movie info"}
          </h3>
          <button
            onClick={onClose}
            className="text-fvp-muted hover:text-fvp-text text-sm"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        <MovieInfoPanel mode={mode} />
      </div>
    </div>
  );
}
