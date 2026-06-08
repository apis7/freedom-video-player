import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type LibraryRow } from "../../ipc/library";

interface Props {
  rows: LibraryRow[];
  /** The current "remember default" setting (from library_get_settings).
   *  We pre-select that option and persist any change after the user
   *  confirms — directive's "remember this selection next time" rule. */
  defaultChoice: "remove" | "recycle";
  onResolved: () => void;
}

/**
 * Two-stage delete confirmation. Per directive:
 *   - Pressing Delete (or right-clicking → Delete) on a multi-selection
 *     asks "Remove from Library" vs "Delete permanently (send to
 *     Recycle Bin)"
 *   - Remembered default for next time — stored as a Library setting
 *   - File delete (recycle bin) is explicit, confirmed, visually
 *     distinct from the safer "remove from library only" option
 *
 * Backend does the actual work via `library_remove_files` (DB only) or
 * `library_trash_files` (recycle bin + DB). The trash crate handles
 * per-OS specifics so this UI doesn't need to care about platform.
 */
export function DeleteConfirmModal({
  rows,
  defaultChoice,
  onResolved,
}: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [choice, setChoice] = useState<"remove" | "recycle">(defaultChoice);
  const [rememberDefault, setRememberDefault] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  // Esc closes; Enter confirms.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onResolved();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void confirm();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, choice]);

  const fileIds = rows.map((r) => r.file.id);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (rememberDefault) {
        await libraryIpc.setDeleteDefault(choice);
      }
      const result =
        choice === "recycle"
          ? await libraryIpc.trashFiles(fileIds)
          : await libraryIpc.removeFiles(fileIds);
      const ok = result.removed + result.trashed;
      const failCount = result.failed.length;
      const verb = choice === "recycle" ? "moved to Recycle Bin" : "removed from library";
      if (failCount > 0) {
        showToast(
          `${ok} ${verb}, ${failCount} failed (${result.failed[0]}…)`,
          "warn",
          5000,
        );
      } else {
        showToast(
          `${ok} movie${ok === 1 ? "" : "s"} ${verb}`,
          "info",
          3000,
        );
      }
      onResolved();
    } catch (err) {
      showToast(`Delete failed: ${err}`, "error");
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={() => !busy && onResolved()}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col max-w-[520px] w-full"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border">
          <div className="text-sm font-semibold text-fvp-text">
            Delete {rows.length} movie{rows.length === 1 ? "" : "s"}?
          </div>
        </header>

        <div className="px-5 py-3 max-h-[180px] overflow-y-auto text-[11px] text-fvp-muted space-y-0.5">
          {rows.slice(0, 8).map((r) => (
            <div key={r.file.id} className="truncate font-mono">
              {r.identity.movie_title ?? r.file.path.split(/[\\/]/).pop()}
            </div>
          ))}
          {rows.length > 8 && (
            <div className="italic">+ {rows.length - 8} more…</div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-fvp-border space-y-2">
          <label className="flex items-start gap-3 cursor-pointer p-2 rounded hover:bg-fvp-surface2/40">
            <input
              type="radio"
              checked={choice === "remove"}
              onChange={() => setChoice("remove")}
              className="accent-fvp-accent mt-0.5"
            />
            <div className="flex-1">
              <div className="text-fvp-text text-xs font-semibold">
                Remove from Library
              </div>
              <div className="text-[11px] text-fvp-muted">
                Drops the library record only. The video file stays on
                disk; you can re-add it later by rescanning the folder.
              </div>
            </div>
          </label>

          <label
            className={
              "flex items-start gap-3 cursor-pointer p-2 rounded border " +
              (choice === "recycle"
                ? "bg-fvp-err/10 border-fvp-err"
                : "border-transparent hover:bg-fvp-surface2/40")
            }
          >
            <input
              type="radio"
              checked={choice === "recycle"}
              onChange={() => setChoice("recycle")}
              className="accent-fvp-err mt-0.5"
            />
            <div className="flex-1">
              <div className="text-fvp-err text-xs font-semibold">
                Delete permanently (send to Recycle Bin)
              </div>
              <div className="text-[11px] text-fvp-muted">
                Moves the video file to the OS Recycle Bin and drops
                the library record. Recoverable from Recycle Bin until
                you empty it.
              </div>
            </div>
          </label>
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-between text-xs">
          <label className="flex items-center gap-1.5 cursor-pointer text-fvp-muted text-[10px]">
            <input
              type="checkbox"
              checked={rememberDefault}
              onChange={(e) => setRememberDefault(e.target.checked)}
              className="accent-fvp-accent"
            />
            Remember as default for next time
          </label>
          <div className="flex gap-2">
            <button
              onClick={onResolved}
              disabled={busy}
              className="px-3 py-1 text-fvp-text hover:bg-fvp-surface2 rounded disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={() => void confirm()}
              disabled={busy}
              className={
                "px-4 py-1 rounded text-white " +
                (choice === "recycle"
                  ? "bg-fvp-err hover:opacity-90"
                  : "bg-fvp-accent hover:opacity-90")
              }
            >
              {busy
                ? "Working…"
                : choice === "recycle"
                  ? "Send to Recycle Bin"
                  : "Remove from library"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
