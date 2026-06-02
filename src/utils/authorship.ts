import type { AuthorshipEvent } from "../ipc/types";

const MAX_HISTORY = 1000; // matches Rust-side MAX_AUTHORSHIP_EVENTS cap

/**
 * Append an authorship event to a profile's history, deduplicating
 * against the previous entry: if the most-recent entry is by the same
 * handle on the same UTC day, we DON'T add a new one. Keeps the log
 * compact during long editing sessions (autosave fires hundreds of times
 * — without dedup, we'd accumulate one entry per save).
 *
 * Returns a NEW array if appended, or the same reference if no change
 * was needed (lets the caller short-circuit `useAppStore.setState`).
 */
export function appendAuthorshipEvent(
  history: AuthorshipEvent[],
  handle: string | null,
  atSecs: number,
): AuthorshipEvent[] {
  const kind: AuthorshipEvent["kind"] =
    history.length === 0 ? "created" : "modified";
  const newEvent: AuthorshipEvent = {
    at: atSecs,
    handle,
    kind,
  };
  const last = history[history.length - 1];
  if (last && sameDay(last.at, atSecs) && (last.handle ?? null) === handle) {
    // Same author, same day — no new entry. Reuse the existing array.
    return history;
  }
  const next = [...history, newEvent];
  // Hard cap: if somehow the dedup is bypassed (e.g. handle flipped
  // hourly), keep only the most recent N events.
  if (next.length > MAX_HISTORY) {
    return next.slice(next.length - MAX_HISTORY);
  }
  return next;
}

function sameDay(a: number, b: number): boolean {
  const da = new Date(a * 1000);
  const db = new Date(b * 1000);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}
