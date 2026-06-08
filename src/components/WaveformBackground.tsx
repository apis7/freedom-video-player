import { useEffect, useLayoutEffect, useRef } from "react";
import { useAppStore } from "../state/appStore";

interface Props {
  /** Visible window into the timeline, in ms. */
  viewStartMs: number;
  viewEndMs: number;
}

/**
 * Ghost waveform painted as a background under the snip lane. Reads peaks
 * from the store; renders to a 1-row-tall canvas sized to the container.
 *
 * Pure visual layer — pointer-events:none so clicks pass through to the snip
 * lane underneath. The snip lane keeps full mouse control of selection,
 * drag-create, edge-resize, etc. (per user spec).
 *
 * Repaints on: peak data change, viewport range change, container resize,
 * and devicePixelRatio change. Resampling collapses N peaks/pixel to a per-
 * pixel max — much faster than per-peak draw calls.
 */
export function WaveformBackground({ viewStartMs, viewEndMs }: Props) {
  const peaks = useAppStore((s) => s.audioPeaks);
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef<{ w: number; h: number; dpr: number }>({
    w: 0,
    h: 0,
    dpr: 1,
  });

  // Track container size so we can keep the canvas backing pixels matched
  // to the rendered CSS size at the current DPR (sharp lines at any zoom).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      if (
        sizeRef.current.w !== w ||
        sizeRef.current.h !== h ||
        sizeRef.current.dpr !== dpr
      ) {
        sizeRef.current = { w, h, dpr };
        draw();
      }
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
    // draw is stable — it reads refs/props at call time. ESLint can't see
    // through that; intentionally not in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Repaint when peaks or viewport change.
  useEffect(() => {
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, viewStartMs, viewEndMs]);

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h, dpr } = sizeRef.current;
    if (w === 0 || h === 0) return;

    // Resize backing buffer to physical pixels; keep CSS size in logical px.
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    if (!peaks || peaks.peaks.length === 0) return;
    const viewMs = viewEndMs - viewStartMs;
    if (viewMs <= 0) return;

    const { peaks: data, peaks_per_second: pps } = peaks;
    const halfH = h / 2;

    // Ghost wash. Deliberately faint — the waveform is informational only,
    // and snip blocks (which carry the user's actual data) must always be
    // the dominant element in the snip lane.
    ctx.fillStyle = "rgba(220, 230, 245, 0.045)";

    // For each output pixel column, find the max amplitude in the peaks
    // that fall in [t0, t1) where t = viewStartMs + (px / w) * viewMs.
    // Loop in physical bins but write to logical (DPR transform handles the
    // sub-pixel scaling).
    const msPerPx = viewMs / w;
    for (let px = 0; px < w; px++) {
      const t0 = viewStartMs + px * msPerPx;
      const t1 = t0 + msPerPx;
      const i0 = Math.max(0, Math.floor((t0 / 1000) * pps));
      const i1 = Math.min(data.length, Math.ceil((t1 / 1000) * pps));
      if (i1 <= i0) continue;
      let max = 0;
      for (let i = i0; i < i1; i++) {
        const v = data[i]!;
        if (v > max) max = v;
      }
      if (max === 0) continue;
      // Boost low end a touch with a gentle sqrt so quiet passages are still
      // visible without making loud passages saturate. (Audio is perceptually
      // logarithmic.)
      const norm = Math.sqrt(max / 255);
      const bar = norm * (halfH - 1);
      ctx.fillRect(px, halfH - bar, 1, bar * 2);
    }
  }

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      aria-hidden="true"
    >
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
}
