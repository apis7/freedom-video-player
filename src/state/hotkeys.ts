/**
 * Hotkey registry + key matching.
 *
 * Hotkeys are identified by stable `id` strings. Each has a default key
 * combo; users can override individual ones via Settings. The matcher
 * normalizes browser KeyboardEvents to a canonical "Mod+Mod+Key" string
 * so comparison is straightforward.
 *
 * Not every hotkey in the app is customizable — modifier-heavy combos
 * (Ctrl+O, Ctrl+A, Ctrl+Z, etc.) stay hardcoded because remapping them
 * risks colliding with browser/OS shortcuts. The single-key hotkeys that
 * users most often want to change ARE customizable.
 */

export interface HotkeySpec {
  id: string;
  label: string;
  defaultKey: string;
  /** Mode the hotkey applies in (or "both"). */
  scope: "both" | "player" | "creator";
}

export const HOTKEYS: HotkeySpec[] = [
  // ── Both modes ──
  { id: "play-pause", label: "Play / Pause", defaultKey: "Space", scope: "both" },
  { id: "mute", label: "Mute", defaultKey: "m", scope: "both" },
  { id: "sub-visibility", label: "Toggle subtitle visibility", defaultKey: "v", scope: "both" },
  { id: "ab-toggle", label: "Profile preview (A/B) toggle", defaultKey: "t", scope: "both" },

  // ── Player Mode ──
  { id: "fullscreen", label: "Fullscreen", defaultKey: "f", scope: "player" },
  { id: "skipthat-back", label: "Skip-That: snip from 10s ago", defaultKey: "[", scope: "player" },
  { id: "skipthat-open", label: "Skip-That: start open snip", defaultKey: "\\", scope: "player" },
  { id: "skipthat-close", label: "Skip-That: close open snip", defaultKey: "]", scope: "player" },
  { id: "skipthat-quick", label: "Skip-That: quick 10s snip", defaultKey: "q", scope: "player" },

  // ── Creator Mode ──
  { id: "marker-drop", label: "Drop marker at playhead", defaultKey: "b", scope: "creator" },
  { id: "snip-preview", label: "Preview selected snip", defaultKey: "Enter", scope: "creator" },
  { id: "marker-prev", label: "Jump to previous marker", defaultKey: "[", scope: "creator" },
  { id: "marker-next", label: "Jump to next marker", defaultKey: "]", scope: "creator" },
];

/** Normalize a KeyboardEvent into a canonical "Ctrl+Shift+Alt+Key" string. */
export function normalizeEvent(e: KeyboardEvent | React.KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  let key = e.key;
  if (key === " ") key = "Space";
  parts.push(key);
  return parts.join("+");
}

/** Resolve the active key combo for a hotkey, honoring user overrides. */
export function keyFor(id: string, overrides: Record<string, string>): string {
  const spec = HOTKEYS.find((h) => h.id === id);
  return overrides[id] ?? spec?.defaultKey ?? "";
}

/** True if the KeyboardEvent matches the resolved key for `id`. */
export function matchesHotkey(
  id: string,
  e: KeyboardEvent,
  overrides: Record<string, string>,
): boolean {
  const target = keyFor(id, overrides).toLowerCase();
  return normalizeEvent(e).toLowerCase() === target;
}
