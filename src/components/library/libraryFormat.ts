/**
 * Shared formatters for the Library views — kept in one place so the
 * thumbnail card, column row, and detail panel all show units the same
 * way (no "1.4 MB" here and "1.4MB" there).
 */

export function formatBytes(n: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatRuntime(durationMs: number): string {
  if (!durationMs || durationMs <= 0) return "—";
  const totalMin = Math.round(durationMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m`;
}

export function formatDateShort(unix: number | null): string {
  if (!unix) return "—";
  const d = new Date(unix * 1000);
  return d.toLocaleDateString();
}

export function formatPct(progressMs: number, durationMs: number): string {
  if (!durationMs || durationMs <= 0) return "—";
  const pct = Math.round((progressMs / durationMs) * 100);
  return `${Math.min(100, Math.max(0, pct))}%`;
}

export function isInResumeRange(progressMs: number, durationMs: number): boolean {
  if (durationMs <= 0) return false;
  const pct = (progressMs / durationMs) * 100;
  return pct >= 5 && pct <= 90;
}

/** Parse a "WxH" string (e.g. "1920x816") into [w, h]. Returns null
 *  when the string isn't in that form — falls back gracefully for
 *  marketing labels like "720p" that haven't been re-probed yet. */
export function parseResolution(s: string | null | undefined): [number, number] | null {
  if (!s) return null;
  const m = s.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
  if (!m) return null;
  const w = parseInt(m[1]!, 10);
  const h = parseInt(m[2]!, 10);
  if (!w || !h) return null;
  return [w, h];
}

/** Render an aspect ratio for a resolution string. Snaps to common
 *  named ratios when within 2% (1.85:1, 2.35:1, 16:9, 4:3, 21:9);
 *  otherwise formats as a decimal "N.NN:1". Returns null when the
 *  resolution string can't be parsed. */
export function formatAspectRatio(resolution: string | null | undefined): string | null {
  const dims = parseResolution(resolution);
  if (!dims) return null;
  const [w, h] = dims;
  const r = w / h;
  const named: Array<[number, string]> = [
    [16 / 9, "16:9"],
    [4 / 3, "4:3"],
    [21 / 9, "21:9"],
    [2.35, "2.35:1"],
    [2.39, "2.39:1"],
    [1.85, "1.85:1"],
    [1.66, "1.66:1"],
    [1, "1:1"],
  ];
  for (const [val, label] of named) {
    if (Math.abs(r - val) / val < 0.02) return label;
  }
  return `${r.toFixed(2)}:1`;
}
