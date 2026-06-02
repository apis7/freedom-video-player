import { useEffect, type RefObject } from "react";
import { fvpWindow } from "../ipc";
import { useAppStore } from "../state/appStore";

/**
 * Reports the given element's pixel rect (× devicePixelRatio for physical
 * pixels) to the Rust backend, which resizes libmpv's embedded render window
 * to match. Updates on element resize, window resize, or current-file change.
 *
 * Attach this to whatever DOM element should host the video output in the
 * current mode (e.g., the central area in Player Mode; the small preview
 * region in Profile Creator).
 */
export function useVideoAreaReporter(ref: RefObject<HTMLElement | null>) {
  const currentFile = useAppStore((s) => s.currentFile);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const report = () => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      void fvpWindow.setVideoArea(
        Math.round(rect.left * dpr),
        Math.round(rect.top * dpr),
        Math.round(rect.width * dpr),
        Math.round(rect.height * dpr),
      );
    };

    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    window.addEventListener("resize", report);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [ref, currentFile]);
}
