import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import {
  exportCurrentProfile,
  computeExportPath,
  ensureFreeExtension,
  defaultFilenameFor,
} from "../utils/exportProfile";
import { profileIpc } from "../ipc";

interface ExportProfileModalProps {
  /** Pre-fill the filename input. Pass the video's stem (e.g. "Movie") for
   *  Ctrl+S; pass the previously-saved filename for Save-As to make
   *  versioning easy ("Movie Family.free" → tweak suffix → "Movie Strict"). */
  initialName?: string;
  /** True when this is "Save As" (Ctrl+Shift+S). Just changes the header
   *  copy + button label; everything else works the same. */
  saveAsMode?: boolean;
  onCancel: () => void;
  onSuccess: (path: string) => void;
}

/**
 * Filename picker for `.free` export. Defaults to the video's stem so the
 * common case (one profile per video) is one Enter press away. Auto-
 * appends `.free` if the user omitted it. Pre-checks for an existing file
 * at the resulting path and warns about overwrite.
 */
export function ExportProfileModal({
  initialName = "",
  saveAsMode = false,
  onCancel,
  onSuccess,
}: ExportProfileModalProps) {
  const snips = useAppStore((s) => s.snips);
  const currentFile = useAppStore((s) => s.currentFile);
  const uncategorized = snips.filter((s) => s.categories.length === 0).length;
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  // initialName arrives without ".free"; the input shows what the user
  // typed (or the default) verbatim, the .free is auto-appended in the
  // resulting path preview.
  const defaultName = initialName || (currentFile ? defaultFilenameFor(currentFile).replace(/\.free$/i, "") : "My Profile");
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  // Re-check overwrite status whenever the filename (or file) changes.
  useEffect(() => {
    let cancelled = false;
    setOverwriteTarget(null);
    if (!currentFile || !name.trim()) return;
    const target = computeExportPath(currentFile, name);
    profileIpc
      .fileExists(target)
      .then((exists) => {
        if (!cancelled && exists) setOverwriteTarget(target);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentFile, name]);

  const dirty = name !== defaultName;
  const tryClose = () => {
    if (busy) return;
    if (dirty && !window.confirm("Discard this export and close?")) return;
    onCancel();
  };

  const handleSave = async () => {
    if (busy) return;
    if (overwriteTarget) {
      if (
        !window.confirm(
          `A profile already exists at:\n${overwriteTarget}\n\nOverwrite it?`,
        )
      ) {
        return;
      }
    }
    setBusy(true);
    setError(null);
    const result = await exportCurrentProfile(name);
    setBusy(false);
    if (result.ok && result.path) {
      onSuccess(result.path);
    } else {
      setError(result.error ?? "Export failed.");
    }
  };

  const finalFilename = ensureFreeExtension(name);
  const finalPath =
    currentFile && finalFilename
      ? computeExportPath(currentFile, finalFilename)
      : null;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
      onClick={tryClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[460px] max-w-[600px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-1">
          {saveAsMode ? "Save profile as…" : "Save profile to .free"}
        </div>
        <div className="text-[11px] text-fvp-muted mb-4">
          Saves alongside the video file. <span className="font-mono">.free</span> is
          appended automatically if you leave it off.
        </div>

        <label className="block text-[10px] uppercase tracking-wider text-fvp-muted mb-1">
          Filename
        </label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void handleSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              tryClose();
            }
          }}
          className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-sm text-fvp-text outline-none mb-2 font-mono"
          placeholder="e.g. Movie  (becomes Movie.free)"
        />

        {finalPath && (
          <div className="text-[10px] text-fvp-muted mb-3 font-mono break-all">
            → {finalPath}
          </div>
        )}

        <div className="text-[11px] text-fvp-muted mb-4 space-y-1">
          <div>
            {snips.length} snip{snips.length === 1 ? "" : "s"} · {uncategorized} need review
          </div>
          {uncategorized > 0 && (
            <div className="text-fvp-warn">
              ⚠ {uncategorized} snip(s) need at least one category before this profile can be saved.
            </div>
          )}
          {overwriteTarget && (
            <div className="text-fvp-warn">
              ⚠ A file with this name already exists — saving will overwrite it (a backup is kept).
            </div>
          )}
        </div>

        {error && (
          <div className="text-[11px] text-fvp-err bg-fvp-err/10 border border-fvp-err/40 rounded px-2 py-1.5 mb-3">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={tryClose}
            disabled={busy}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={busy || uncategorized > 0 || snips.length === 0 || !finalFilename}
            className="px-3 py-1.5 bg-fvp-accent hover:opacity-90 text-white rounded disabled:opacity-50"
          >
            {busy ? "Saving…" : overwriteTarget ? "Overwrite" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
