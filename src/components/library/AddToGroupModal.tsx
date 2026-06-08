import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  type CollectionRow,
  type SeriesRow,
} from "../../ipc/library";

interface Props {
  kind: "collection" | "series";
  /** Identity ids to add to the chosen group. */
  identityIds: number[];
  onResolved: () => void;
}

/**
 * "Add N selected to a collection / series" picker. Lists existing groups
 * + a "Create new…" entry that prompts for a name inline. One click on
 * an existing row adds the identities and closes; a separate path
 * creates a new group then adds to it.
 */
export function AddToGroupModal({ kind, identityIds, onResolved }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);

  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (kind === "collection") {
          const c = await libraryIpc.listCollections();
          if (!cancelled) setCollections(c);
        } else {
          const s = await libraryIpc.listSeries();
          if (!cancelled) setSeries(s);
        }
      } catch (err) {
        if (!cancelled) showToast(`Load failed: ${err}`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, showToast]);

  const addExisting = async (groupId: number, label: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (kind === "collection") {
        await libraryIpc.addToCollection(groupId, identityIds);
      } else {
        await libraryIpc.addToSeries(groupId, identityIds);
      }
      showToast(
        `Added ${identityIds.length} item${identityIds.length === 1 ? "" : "s"} to "${label}"`,
        "info",
        2500,
      );
      onResolved();
    } catch (err) {
      showToast(`Add failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const createAndAdd = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    try {
      const id =
        kind === "collection"
          ? await libraryIpc.createCollection(name)
          : await libraryIpc.createSeries(name, false);
      if (kind === "collection") {
        await libraryIpc.addToCollection(id, identityIds);
      } else {
        await libraryIpc.addToSeries(id, identityIds);
      }
      showToast(
        `Created "${name}" with ${identityIds.length} item${identityIds.length === 1 ? "" : "s"}`,
        "info",
        2500,
      );
      onResolved();
    } catch (err) {
      showToast(`Create failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const heading = kind === "collection" ? "Add to collection" : "Add to series";
  const items: { id: number; name: string; count: number }[] =
    kind === "collection"
      ? collections.map((c) => ({ id: c.id, name: c.name, count: c.item_count }))
      : series.map((s) => ({ id: s.id, name: s.name, count: s.item_count }));

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[60] flex items-center justify-center"
      onClick={onResolved}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-4 min-w-[380px] max-w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-3">
          {heading} ({identityIds.length} movie
          {identityIds.length === 1 ? "" : "s"})
        </div>

        <div className="max-h-[280px] overflow-y-auto space-y-0.5 mb-3">
          {items.length === 0 && (
            <div className="text-[11px] text-fvp-muted italic px-2 py-1">
              No {kind === "collection" ? "collections" : "series"} yet —
              create one below.
            </div>
          )}
          {items.map((g) => (
            <button
              key={g.id}
              onClick={() => void addExisting(g.id, g.name)}
              disabled={busy}
              className="w-full flex items-center justify-between px-2 py-1 rounded hover:bg-fvp-surface2/60 text-xs text-fvp-text"
            >
              <span>{g.name}</span>
              <span className="text-[10px] text-fvp-muted">{g.count}</span>
            </button>
          ))}
        </div>

        {creating ? (
          <div className="flex gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createAndAdd();
                }
              }}
              placeholder={`New ${kind} name`}
              className="flex-1 bg-fvp-bg border border-fvp-accent rounded px-2 py-1 text-xs outline-none"
            />
            <button
              onClick={() => void createAndAdd()}
              disabled={busy}
              className="px-3 py-1 bg-fvp-accent text-white text-xs rounded"
            >
              Create + add
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="w-full px-2 py-1.5 bg-fvp-bg border border-fvp-border hover:border-fvp-accent rounded text-xs text-fvp-accent"
          >
            + Create new {kind}…
          </button>
        )}

        <div className="flex justify-end mt-3">
          <button
            onClick={onResolved}
            disabled={busy}
            className="px-3 py-1 text-fvp-text hover:bg-fvp-surface2 rounded text-xs"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
