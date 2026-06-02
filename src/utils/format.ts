/**
 * Parse a user-typed time string into seconds. Accepts:
 *   "30"        → 30 seconds
 *   "1:23"      → 1m 23s
 *   "1:23:45"   → 1h 23m 45s
 *   "1:23.500"  → 1m 23.5s
 * Returns null if the input is malformed or negative.
 */
export function parseTime(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  const parts = s.split(":");
  if (parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let total: number;
  if (nums.length === 1) total = nums[0]!;
  else if (nums.length === 2) total = nums[0]! * 60 + nums[1]!;
  else total = nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
  return total >= 0 ? total : null;
}

/** Format seconds as H:MM:SS (or M:SS when under an hour). */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = s.toString().padStart(2, "0");
  if (h > 0) {
    const mm = m.toString().padStart(2, "0");
    return `${h}:${mm}:${ss}`;
  }
  return `${m}:${ss}`;
}

/** Format a millisecond duration as a compact human-readable string:
 *   "850ms", "3.4s", "1m 23s", "1h 15m" */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = ms / 1000;
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  if (totalSeconds < 60) return `${Math.round(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
}
