import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";

const BUILD_MS = 1500;

/**
 * Brief animated indicator that fires when the user enters fullscreen
 * in Player Mode. Shows a fullscreen icon bottom-right that "builds"
 * a circular progress ring over BUILD_MS. When the ring fills, the
 * useChromeAutoHide reducer (which we override to BUILD_MS on the
 * fullscreen-entry edge) hides all chrome and the indicator fades
 * itself out. Net effect: clear visual feedback that fullscreen is
 * about to take over, instead of the silent N-second wait the user
 * was complaining about.
 *
 * Skipped for keyboard-only fullscreen exits and re-entries within
 * the same playback session — only the first frame of `fullscreen=true`
 * triggers the indicator.
 */
export function FullscreenTransitionIndicator() {
  const fullscreen = useAppStore((s) => s.fullscreen);
  const mode = useAppStore((s) => s.mode);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!fullscreen || mode !== "player") return;
    setActive(true);
    const hide = window.setTimeout(() => setActive(false), BUILD_MS + 200);
    return () => window.clearTimeout(hide);
  }, [fullscreen, mode]);

  if (!active) return null;

  // SVG-based ring that fills over BUILD_MS using stroke-dashoffset
  // animation. Foreground icon = a "fullscreen" four-corner glyph.
  const ringSize = 44;
  const ringRadius = 18;
  const ringCircumference = 2 * Math.PI * ringRadius;
  return (
    <div className="fixed bottom-6 right-6 z-[60] pointer-events-none animate-fade-in">
      <div
        className="relative bg-black/70 rounded-full p-1.5 shadow-2xl"
        style={{ width: ringSize, height: ringSize }}
      >
        <svg
          width={ringSize}
          height={ringSize}
          viewBox={`0 0 ${ringSize} ${ringSize}`}
          className="absolute inset-0"
        >
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={ringRadius}
            fill="none"
            stroke="rgba(255,255,255,0.15)"
            strokeWidth={2}
          />
          <circle
            cx={ringSize / 2}
            cy={ringSize / 2}
            r={ringRadius}
            fill="none"
            stroke="white"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={ringCircumference}
            strokeDashoffset={ringCircumference}
            transform={`rotate(-90 ${ringSize / 2} ${ringSize / 2})`}
            style={{
              animation: `fvp-ring-fill ${BUILD_MS}ms linear forwards`,
            }}
          />
        </svg>
        <svg
          viewBox="0 0 24 24"
          className="relative w-full h-full text-white"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* Fullscreen-enter glyph: four L-shapes pointing outward. */}
          <path d="M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15" />
        </svg>
      </div>
      <style>{`
        @keyframes fvp-ring-fill {
          from { stroke-dashoffset: ${ringCircumference}; }
          to   { stroke-dashoffset: 0; }
        }
        .animate-fade-in { animation: fvp-fade-in 200ms ease-out; }
        @keyframes fvp-fade-in {
          from { opacity: 0; transform: scale(0.85); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
