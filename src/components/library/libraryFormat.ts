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
