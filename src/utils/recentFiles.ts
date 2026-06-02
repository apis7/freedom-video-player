const KEY = "fvp.recentFiles.v1";
const MAX_RECENT = 10;

/** Recently-opened video file paths, persisted to localStorage so the
 *  File → Open recent menu can list them across sessions. */
export function getRecentFiles(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function pushRecentFile(path: string): void {
  if (!path) return;
  try {
    const list = getRecentFiles().filter((p) => p !== path);
    list.unshift(path);
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // localStorage full / disabled — silent fail.
  }
}

export function clearRecentFiles(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {}
}
