import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";

interface Props {
  onClose: () => void;
}

/**
 * Snip groups manager. Lets the user create / rename / delete named groups,
 * which can then be assigned to snips via the Snip Detail panel. Groups
 * persist into the .free profile.
 *
 * Per directives, groups are mainly a sharing/organization concept (e.g.
 * "Act 1 violence", "End credits"); they don't change playback behavior on
 * their own.
 */
export function SnipGroupsModal({ onClose }: Props) {
  const groups = useAppStore((s) => s.groups);
  const snips = useAppStore((s) => s.snips);
  const addGroup = useAppStore((s) => s.addGroup);
  const removeGroup = useAppStore((s) => s.removeGroup);
  const renameGroup = useAppStore((s) => s.renameGroup);
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);

  const [newName, setNewName] = useState("");

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    addGroup(trimmed);
    setNewName("");
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[460px] max-w-[600px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-1">
          Snip groups
        </div>
        <div className="text-[11px] text-fvp-muted mb-4">
          Bundle related snips under named groups for sharing and organization.
          Assign a group from each snip's detail panel. Groups don't affect
          playback — they're metadata that travels with the .free profile.
        </div>

        <div className="flex gap-2 mb-4">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder="New group name…"
            className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-sm text-fvp-text outline-none"
          />
          <button
            onClick={create}
            disabled={!newName.trim()}
            className="px-3 py-1.5 bg-fvp-accent text-white text-xs rounded cursor-pointer hover:opacity-90 disabled:opacity-30"
          >
            Add
          </button>
        </div>

        <div className="max-h-[300px] overflow-y-auto space-y-1 mb-4">
          {groups.length === 0 ? (
            <div className="text-[11px] text-fvp-muted text-center py-4">
              No groups yet.
            </div>
          ) : (
            groups.map((g) => {
              const count = snips.filter((s) => s.group_id === g.id).length;
              return (
                <div
                  key={g.id}
                  className="flex items-center gap-2 px-2 py-1.5 border border-fvp-border rounded bg-fvp-bg"
                >
                  <input
                    value={g.name}
                    onChange={(e) => renameGroup(g.id, e.target.value)}
                    className="flex-1 bg-transparent text-sm text-fvp-text outline-none focus:outline focus:outline-fvp-accent rounded px-1"
                  />
                  <span className="text-[10px] text-fvp-muted whitespace-nowrap">
                    {count} snip{count === 1 ? "" : "s"}
                  </span>
                  <button
                    onClick={() => removeGroup(g.id)}
                    className="text-[11px] text-fvp-muted hover:text-fvp-err px-1"
                    title="Delete group (snips in it are kept but unassigned)"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-fvp-accent text-white rounded cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
