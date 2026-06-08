import { invoke } from "@tauri-apps/api/core";

/**
 * Action log — routes a one-line description of a user-initiated event
 * (click, key press, drag start/drop, scope change, refresh, etc.) to
 * the Rust [fvp:ui] log channel so the terminal-attached console shows
 * causal traces alongside backend events.
 *
 * Per house rules:
 *   - Log USER ACTIONS, not per-frame events. Clicks fine; mousemove no.
 *   - Never include file paths beyond the basename, never include the
 *     content of notes/tags/PINs/etc. Action TYPE and ids are enough.
 *   - Calls are fire-and-forget; failure to log never affects the app.
 *
 * Adds a `library_dbg` Tauri command on the backend? No — we reuse the
 * existing `library_dbg` channel via a renamed command. To avoid adding
 * a new command, the actlog backend reuses `library_dbg` which already
 * exists in dev builds. If not registered, the call no-ops silently.
 *
 * The helper writes to console.log too so dev-tools users can read it
 * without needing the terminal.
 */
export function actlog(area: string, msg: string): void {
  const line = `[${area}] ${msg}`;
  // eslint-disable-next-line no-console
  console.log("[fvp:ui]", line);
  void invoke("library_dbg", { msg: line }).catch(() => {
    /* command not registered in this build — ignore */
  });
}
