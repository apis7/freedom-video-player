import { useAppStore } from "../state/appStore";

/**
 * Small "Building waveform…" pill shown in the bottom-right of the snip
 * lane while the backend is computing peaks. Strictly informational:
 *   - pointer-events: none → never intercepts clicks or hovers
 *   - z-index above waveform, below modals
 *   - fades in once a percent arrives (avoids flashing for cache hits)
 *
 * Disappears the moment the build completes.
 */
export function PeaksBuildingBadge() {
  const building = useAppStore((s) => s.peaksBuilding);
  const pct = useAppStore((s) => s.peaksBuildPercent);
  if (!building) return null;

  const label =
    pct !== null && pct > 0
      ? `Building waveform… ${pct}%`
      : "Building waveform…";

  return (
    <div
      className="absolute bottom-1.5 right-2 pointer-events-none z-20 select-none"
      aria-hidden="true"
      title="Audio waveform is being computed in the background — you can keep working."
    >
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-fvp-surface/85 border border-fvp-border text-[10px] text-fvp-muted shadow backdrop-blur-sm">
        <span className="inline-block w-2 h-2 rounded-full bg-fvp-accent animate-pulse" />
        <span>{label}</span>
      </div>
    </div>
  );
}
