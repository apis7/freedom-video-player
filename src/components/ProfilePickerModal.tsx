import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import type { DetectedProfile } from "../state/types";

interface ProfilePickerModalProps {
  profiles: DetectedProfile[];
  onClose: () => void;
}

/**
 * Modal shown when the user enters Creator Mode with multiple detected
 * profiles for the current file. Picking one loads it as the working draft;
 * "Start fresh" leaves the draft empty.
 */
export function ProfilePickerModal({ profiles, onClose }: ProfilePickerModalProps) {
  const load = useAppStore((s) => s.loadProfileAsDraft);
  const duration = useAppStore((s) => s.duration);
  const showToast = useAppStore((s) => s.showToast);
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  const pickProfile = (p: DetectedProfile) => {
    load(p.profile);
    // Warn if any of the profile's snips extend past this video's duration —
    // a strong signal that the fingerprint match was wrong or the user is
    // editing against a different cut of the film.
    if (duration > 0) {
      const limit = duration * 1000;
      const outOfBounds = p.profile.payload.snips.filter((s) => s.end_ms > limit + 50).length;
      if (outOfBounds > 0) {
        showToast(
          `This profile has ${outOfBounds} snip${outOfBounds === 1 ? "" : "s"} past ` +
            `this video's duration — fingerprint match may be wrong.`,
          "warn",
          10_000,
        );
      }
    }
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[480px] max-w-[640px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-1">
          {profiles.length} profiles found for this video
        </div>
        <div className="text-[11px] text-fvp-muted mb-4">
          Pick one to load into the editor, or start a fresh draft. Loading
          replaces any in-memory snips you haven't exported yet.
        </div>

        <div className="space-y-1 max-h-[320px] overflow-y-auto mb-4">
          {profiles.map((p) => {
            const meta = p.profile.payload.metadata;
            const snipCount = p.profile.payload.snips.length;
            const markerCount = p.profile.payload.markers?.length ?? 0;
            return (
              <button
                key={p.path}
                onClick={() => pickProfile(p)}
                className="w-full text-left px-3 py-2 rounded border border-fvp-border hover:border-fvp-accent hover:bg-fvp-surface2 cursor-pointer"
              >
                <div className="text-sm text-fvp-text">{meta.name}</div>
                <div className="text-[10px] text-fvp-muted mt-0.5 truncate">
                  v{meta.version} · {snipCount} snip{snipCount === 1 ? "" : "s"} · {markerCount} marker{markerCount === 1 ? "" : "s"} · match: {p.score.quality}
                </div>
                <div className="text-[10px] text-fvp-muted/70 mt-0.5 font-mono truncate">
                  {p.path}
                </div>
              </button>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Start fresh
          </button>
        </div>
      </div>
    </div>
  );
}
