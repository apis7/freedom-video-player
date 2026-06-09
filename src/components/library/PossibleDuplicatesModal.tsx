import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type FuzzyDupPair, type LibraryRow } from "../../ipc/library";
import { LibraryPoster } from "./LibraryPoster";
import { displayTitle } from "./titleDisplay";
import { formatBytes } from "./libraryFormat";

interface Props {
  pairs: FuzzyDupPair[];
  onResolved: () => void;
  onClose: () => void;
}

/**
 * "Find possible duplicates" review modal. Side-by-side compare for one
 * pair at a time; user can:
 *   - Keep both (advance to next pair, no DB change)
 *   - Remove from library on either side (drops the row, leaves file)
 *   - Delete from disk on either side (trash + drop row)
 *   - Rename either file inline (rename on disk + update row)
 *
 * Unlike Clean Duplicates these are NOT byte-identical — they're titles
 * that look the same. The user is the final arbiter; we just surface
 * the suspects.
 */
export function PossibleDuplicatesModal({ pairs, onResolved, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  if (pairs.length === 0) {
    return (
      <div
        className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
        onClick={onClose}
      >
        <div
          className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-6 max-w-sm text-center"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-sm text-fvp-text mb-3">
            No possible duplicates found.
          </div>
          <div className="text-[11px] text-fvp-muted mb-4">
            Your library doesn't have any titles that look like potential
            same-movie pairs (95%+ name similarity, same year, same 3D /
            Extended status).
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1 bg-fvp-accent text-white rounded hover:opacity-90"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  const advance = () => {
    if (active >= pairs.length - 1) {
      onClose();
    } else {
      setActive(active + 1);
    }
  };

  const pair = pairs[active]!;

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={() => !busy && onClose()}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl max-w-4xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-fvp-text">
              Possible duplicate ({active + 1} of {pairs.length})
            </div>
            <div className="text-[11px] text-fvp-muted">
              Similarity score: {pair.score}% — these LOOK like the same movie
              but the files aren't byte-identical. Same 3D / Extended status,
              year within ±1.
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-fvp-muted hover:text-fvp-text text-lg leading-none"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 grid grid-cols-2 gap-4 min-h-0">
          <CompareSide
            row={pair.a.row}
            disabled={busy}
            onResolved={() => {
              advance();
              onResolved();
            }}
            setBusy={setBusy}
          />
          <CompareSide
            row={pair.b.row}
            disabled={busy}
            onResolved={() => {
              advance();
              onResolved();
            }}
            setBusy={setBusy}
          />
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-between text-xs">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 text-fvp-muted hover:text-fvp-text rounded"
          >
            Cancel
          </button>
          <div className="text-[10px] text-fvp-muted">
            Tip: pairs are sorted highest confidence first.
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => active > 0 && setActive(active - 1)}
              disabled={active === 0 || busy}
              className="px-2 py-1 text-fvp-muted hover:text-fvp-text rounded disabled:opacity-30"
            >
              ‹ Prev
            </button>
            <button
              onClick={advance}
              disabled={busy}
              className="px-3 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded text-fvp-text"
              title="Both copies are legitimate / different — move on."
            >
              Keep both ›
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function CompareSide({
  row,
  disabled,
  setBusy,
  onResolved,
}: {
  row: LibraryRow;
  disabled: boolean;
  setBusy: (b: boolean) => void;
  onResolved: () => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(
    row.file.path.split(/[\\/]/).pop() ?? "",
  );
  useEffect(() => {
    setRenameDraft(row.file.path.split(/[\\/]/).pop() ?? "");
    setRenaming(false);
  }, [row.file.id]);

  const removeFromLibrary = async () => {
    if (!window.confirm(`Remove "${displayTitle(row)}" from library?\nFile stays on disk.`))
      return;
    setBusy(true);
    try {
      await libraryIpc.removeFiles([row.file.id]);
      showToast("Removed from library.", "info", 2500);
      onResolved();
    } catch (err) {
      showToast(`Remove failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const deleteFromDisk = async () => {
    if (
      !window.confirm(
        `Delete "${displayTitle(row)}" from disk?\nThis sends the file to the Recycle Bin (or permanently deletes if it's on a network share).`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await libraryIpc.trashFiles([row.file.id]);
      if (result.failed.length > 0) {
        showToast(`Couldn't delete: ${result.failed[0]}`, "warn", 4000);
      } else {
        showToast("Deleted from disk.", "info", 2500);
      }
      onResolved();
    } catch (err) {
      showToast(`Delete failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const commitRename = async () => {
    const newName = renameDraft.trim();
    const oldName = row.file.path.split(/[\\/]/).pop() ?? "";
    if (newName === oldName || newName.length === 0) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      await libraryIpc.renameFile(row.file.id, newName);
      showToast("File renamed.", "info", 2500);
      setRenaming(false);
      onResolved();
    } catch (err) {
      showToast(`Rename failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const id = row.identity;
  const f = row.file;

  return (
    <div className="border border-fvp-border rounded p-3 flex flex-col gap-2">
      <div className="flex gap-3">
        <LibraryPoster
          customThumbnailPath={id.custom_thumbnail_path}
          posterLocalPath={id.poster_local_path}
          widthPx={80}
          alt={displayTitle(row)}
          isMissing={f.is_missing}
        />
        <div className="flex-1 min-w-0 text-xs">
          <div className="font-semibold text-fvp-text">{displayTitle(row)}</div>
          {id.movie_year && (
            <div className="text-fvp-muted">{id.movie_year}</div>
          )}
          <div className="text-fvp-muted text-[10px] mt-1">
            {f.resolution ?? "—"} · {formatBytes(f.size_bytes)}
          </div>
          {id.movie_director && (
            <div className="text-fvp-muted text-[10px] mt-1">
              Dir. {id.movie_director}
            </div>
          )}
        </div>
      </div>

      <div className="text-[10px] text-fvp-muted font-mono break-all bg-fvp-bg/40 p-1.5 rounded">
        {f.path}
      </div>

      {renaming ? (
        <div className="flex gap-1">
          <input
            autoFocus
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRenaming(false);
              }
            }}
            disabled={disabled}
            className="flex-1 bg-fvp-bg border border-fvp-accent rounded px-2 py-1 text-xs font-mono outline-none"
          />
          <button
            onClick={() => void commitRename()}
            disabled={disabled}
            className="px-2 py-1 bg-fvp-accent text-white text-xs rounded hover:opacity-90 disabled:opacity-50"
          >
            OK
          </button>
          <button
            onClick={() => setRenaming(false)}
            disabled={disabled}
            className="px-2 py-1 bg-fvp-bg border border-fvp-border text-xs rounded hover:border-fvp-muted disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-1 text-[10px]">
          <button
            onClick={() => setRenaming(true)}
            disabled={disabled}
            className="px-1.5 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded disabled:opacity-50"
          >
            ✎ Rename
          </button>
          <button
            onClick={() => void removeFromLibrary()}
            disabled={disabled}
            className="px-1.5 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded disabled:opacity-50"
          >
            Remove from lib
          </button>
          <button
            onClick={() => void deleteFromDisk()}
            disabled={disabled}
            className="px-1.5 py-1 bg-fvp-bg border border-fvp-err/40 text-fvp-err hover:bg-fvp-err/10 rounded disabled:opacity-50"
          >
            🗑 Delete from disk
          </button>
        </div>
      )}
    </div>
  );
}
