import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  getLibraryMode,
  libraryIpc,
  type LibraryRow,
} from "../../ipc/library";

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
  // Detect shared-membership situations among the rows about to be
  // "deleted" so we can offer softer options: just drop the
  // series / collection membership and leave the movies in the
  // library. Visible only when EVERY selected row is in that same
  // membership - mixed-membership selections see only the two
  // original options (the user would have to do them per-membership
  // via the right-click menu).
  const commonSeries = (() => {
    const first = rows[0]?.series;
    if (!first) return null;
    return rows.every((r) => r.series?.series_id === first.series_id)
      ? { id: first.series_id, name: first.series_name }
      : null;
  })();
  // Collections the user is a member of in EVERY selected row.
  // Multiple shared collections produce multiple soft options.
  const commonCollections = (() => {
    const first = rows[0];
    if (!first || first.collections.length === 0) return [];
    return first.collections.filter((c) =>
      rows.every((r) =>
        r.collections.some((rc) => rc.collection_id === c.collection_id),
      ),
    );
  })();
  // Soft choices are encoded as composite strings so the radio
  // group is exhaustive without needing a separate sub-state for
  // "which collection?". 'remove_from_collection:<id>' picks the
  // exact collection from commonCollections.
  type Choice =
    | "remove"
    | "recycle"
    | "remove_from_series"
    | `remove_from_collection:${number}`;
  const isSoftChoice = (c: Choice): boolean =>
    c === "remove_from_series" || c.startsWith("remove_from_collection:");
  const [choice, setChoice] = useState<Choice>(defaultChoice);
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

  // Files on UNC / network shares can't be sent to the Recycle Bin —
  // Windows requires a per-volume $RECYCLE.BIN that doesn't exist on
  // SMB. For those, the "recycle" choice falls back to permanent
  // deletion; warn the user up-front so they know "recycle bin" isn't
  // an undo path here.
  const networkRows = rows.filter(
    (r) => r.file.path.startsWith("\\\\") || r.file.path.startsWith("//"),
  );
  const hasNetworkFiles = networkRows.length > 0;
  const allNetworkFiles = networkRows.length === rows.length;
  // Client mode: the actual deletion runs on the HOST'S machine. Make
  // sure the user understands that — file paths displayed here are
  // Host-perspective paths, and "send to Recycle Bin" lands in the
  // HOST'S recycle bin, not theirs. Surface a banner so this isn't
  // silent.
  const isClient = getLibraryMode() === "client";

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Soft membership-removal options ('remove_from_series',
      // 'remove_from_collection:<id>') are non-destructive and
      // context-dependent. We don't persist them as a "delete
      // default" - the persisted default only covers the actual
      // delete branches ('remove', 'recycle').
      if (rememberDefault && !isSoftChoice(choice)) {
        await libraryIpc.setDeleteDefault(choice as "remove" | "recycle");
      }
      if (choice === "remove_from_series") {
        if (!commonSeries) {
          showToast(
            "Mixed-series selection — pick the series-removal action from the right-click menu instead.",
            "warn",
            4000,
          );
          setBusy(false);
          return;
        }
        const identityIds = Array.from(
          new Set(rows.map((r) => r.identity.id)),
        );
        await libraryIpc.removeFromSeries(commonSeries.id, identityIds);
        showToast(
          `Removed ${identityIds.length} movie${identityIds.length === 1 ? "" : "s"} from "${commonSeries.name}". Movies stay in your library.`,
          "info",
          3500,
        );
        onResolved();
        return;
      }
      if (choice.startsWith("remove_from_collection:")) {
        const cid = Number(choice.slice("remove_from_collection:".length));
        const targetCollection = commonCollections.find(
          (c) => c.collection_id === cid,
        );
        if (!targetCollection) {
          showToast(
            "Selection no longer matches that collection — refresh and try again.",
            "warn",
            4000,
          );
          setBusy(false);
          return;
        }
        const identityIds = Array.from(
          new Set(rows.map((r) => r.identity.id)),
        );
        await libraryIpc.removeFromCollection(cid, identityIds);
        showToast(
          `Removed ${identityIds.length} movie${identityIds.length === 1 ? "" : "s"} from "${targetCollection.collection_name}". Movies stay in your library.`,
          "info",
          3500,
        );
        onResolved();
        return;
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

        {isClient && (
          <div className="mx-5 mt-3 px-3 py-2 bg-fvp-warn/10 border border-fvp-warn text-fvp-warn text-[11px] rounded">
            <strong>Client mode:</strong> this delete runs on the{" "}
            <strong>Host machine</strong>. "Send to Recycle Bin" lands in the
            HOST's recycle bin, not yours. "Remove from Library" drops the
            row from the Host's DB.
          </div>
        )}
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
          {/* Softest options, shown first when applicable: just drop
              the series / collection membership. The movies STAY in
              the library, their files stay on disk - only the
              membership link goes away. Visible only when EVERY
              selected movie shares that same membership. Multiple
              shared collections produce multiple options - the user
              picks the one they want to leave. */}
          {commonSeries && (
            <label className="flex items-start gap-3 cursor-pointer p-2 rounded hover:bg-fvp-surface2/40">
              <input
                type="radio"
                checked={choice === "remove_from_series"}
                onChange={() => setChoice("remove_from_series")}
                className="accent-fvp-accent mt-0.5"
              />
              <div className="flex-1">
                <div className="text-fvp-text text-xs font-semibold">
                  Remove from Series "{commonSeries.name}" — keep in
                  Library
                </div>
                <div className="text-[11px] text-fvp-muted">
                  Drops only the series membership. The movies stay in
                  your library and stay on disk. They go back to showing
                  individually in All Movies.
                </div>
              </div>
            </label>
          )}
          {commonCollections.map((c) => {
            const value: Choice = `remove_from_collection:${c.collection_id}`;
            return (
              <label
                key={c.collection_id}
                className="flex items-start gap-3 cursor-pointer p-2 rounded hover:bg-fvp-surface2/40"
              >
                <input
                  type="radio"
                  checked={choice === value}
                  onChange={() => setChoice(value)}
                  className="accent-fvp-accent mt-0.5"
                />
                <div className="flex-1">
                  <div className="text-fvp-text text-xs font-semibold">
                    Remove from Collection "{c.collection_name}" — keep in
                    Library
                  </div>
                  <div className="text-[11px] text-fvp-muted">
                    Drops only the collection membership. The movies stay
                    in your library and on disk.
                  </div>
                </div>
              </label>
            );
          })}
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
                {allNetworkFiles
                  ? "Delete permanently from network share (no recycle bin)"
                  : "Delete permanently (send to Recycle Bin)"}
              </div>
              <div className="text-[11px] text-fvp-muted">
                {allNetworkFiles
                  ? "Network shares (SMB) don't have a Recycle Bin — the file will be permanently deleted from the server with no undo. Make sure you've got a backup if you need one."
                  : "Moves the video file to the OS Recycle Bin and drops the library record. Recoverable from Recycle Bin until you empty it."}
              </div>
              {hasNetworkFiles && !allNetworkFiles && (
                <div className="text-[10px] text-fvp-warn mt-1">
                  ⚠ {networkRows.length} of {rows.length} are on a network
                  share and will be permanently deleted with no recycle-bin
                  fallback.
                </div>
              )}
            </div>
          </label>
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-between text-xs">
          {/* "Remember default" is meaningless for the soft
              membership-removal options (those are explicit,
              context-dependent actions - the user wouldn't want every
              future Delete to default to "remove from Shaun the
              Sheep"). Disable while any soft option is selected. */}
          <label
            className={
              "flex items-center gap-1.5 cursor-pointer text-fvp-muted text-[10px] " +
              (isSoftChoice(choice) ? "opacity-40 cursor-not-allowed" : "")
            }
          >
            <input
              type="checkbox"
              checked={rememberDefault}
              disabled={isSoftChoice(choice)}
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
                  ? allNetworkFiles
                    ? "Delete permanently"
                    : "Send to Recycle Bin"
                  : choice === "remove_from_series"
                    ? "Remove from Series"
                    : choice.startsWith("remove_from_collection:")
                      ? "Remove from Collection"
                      : "Remove from library"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
