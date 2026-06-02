import { useAppStore } from "../state/appStore";

/**
 * True when Creator has work that would be lost on close/file-switch:
 * autosave is OFF, a file is loaded, and there are snips or markers.
 *
 * Markers without snips still count — the user explicitly placed them,
 * losing them would be surprising.
 */
export function hasUnsavedWork(): boolean {
  const s = useAppStore.getState();
  if (s.autosaveDraft) return false;
  if (!s.currentFile) return false;
  return s.snips.length > 0 || s.markers.length > 0;
}

/** Synchronous confirm asking the user whether to discard unsaved work.
 *  Returns true if the user wants to continue (discard), false to abort. */
export function confirmDiscardUnsaved(actionDescription: string): boolean {
  const s = useAppStore.getState();
  const counts = [];
  if (s.snips.length > 0) counts.push(`${s.snips.length} snip${s.snips.length === 1 ? "" : "s"}`);
  if (s.markers.length > 0)
    counts.push(`${s.markers.length} marker${s.markers.length === 1 ? "" : "s"}`);
  return window.confirm(
    `Autosave is OFF and you have unsaved work (${counts.join(", ")}).\n\n` +
      `${actionDescription} will discard it.\n\nContinue?`,
  );
}
