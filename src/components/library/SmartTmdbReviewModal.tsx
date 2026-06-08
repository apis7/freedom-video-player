import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type SmartTmdbCandidate } from "../../ipc/library";

interface Props {
  groupKind: "collection" | "series";
  groupId: number;
  groupName: string;
  onResolved: () => void;
}

/**
 * Review + apply UI for Smart TMDb Search. Calls the backend to compute
 * proposed matches for every unmatched member of a collection or series,
 * then shows the proposals with per-row checkboxes so the user can
 * uncheck wrong picks before applying.
 *
 * Apply loops `library_apply_tmdb_id` per checked row. Progress is
 * surfaced via a toast count after the full batch finishes; per-row
 * results are tallied so partial failures are visible.
 */
export function SmartTmdbReviewModal({
  groupKind,
  groupId,
  groupName,
  onResolved,
}: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);

  const [stage, setStage] = useState<"loading" | "review" | "applying" | "error">(
    "loading",
  );
  const [candidates, setCandidates] = useState<SmartTmdbCandidate[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await libraryIpc.smartTmdbSearch(groupKind, groupId);
        if (cancelled) return;
        setCandidates(list);
        // All candidates checked by default — user unchecks the wrong ones.
        setChecked(new Set(list.map((c) => c.identity_id)));
        setStage("review");
      } catch (e) {
        if (cancelled) return;
        setErr(`${e}`);
        setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupKind, groupId]);

  const toggle = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = (val: boolean) => {
    setChecked(val ? new Set(candidates.map((c) => c.identity_id)) : new Set());
  };

  const apply = async () => {
    if (stage !== "review") return;
    setStage("applying");
    const toApply = candidates.filter((c) => checked.has(c.identity_id));
    let ok = 0;
    let fail = 0;
    for (const c of toApply) {
      try {
        await libraryIpc.applyTmdbId(c.identity_id, c.proposed_tmdb_id);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    if (fail > 0) {
      showToast(`Applied ${ok}; ${fail} failed`, "warn", 3500);
    } else {
      showToast(`Applied ${ok} TMDb match${ok === 1 ? "" : "es"}`, "info", 3000);
    }
    onResolved();
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={() => stage !== "applying" && onResolved()}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col max-w-[640px] w-full max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border">
          <div className="text-sm font-semibold text-fvp-text">
            Smart TMDb search — {groupKind}: {groupName}
          </div>
          <div className="text-[11px] text-fvp-muted mt-0.5 leading-relaxed">
            Tries common title cleanups (strips leading numbers / episode
            tags) and proposes a TMDb match for every member not already
            matched. Review + uncheck wrong picks before applying.
          </div>
        </header>

        {stage === "loading" && (
          <div className="px-5 py-10 text-center text-fvp-muted text-sm">
            Searching TMDb for {groupName} members…
          </div>
        )}

        {stage === "error" && (
          <div className="px-5 py-6">
            <div className="text-fvp-err text-sm mb-3">{err}</div>
            <button
              onClick={onResolved}
              className="px-3 py-1.5 bg-fvp-bg border border-fvp-border rounded text-xs"
            >
              Close
            </button>
          </div>
        )}

        {(stage === "review" || stage === "applying") && (
          <>
            <div className="px-5 py-2 border-b border-fvp-border flex items-center justify-between text-[11px]">
              <span className="text-fvp-muted">
                {candidates.length} match{candidates.length === 1 ? "" : "es"} proposed
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => selectAll(true)}
                  className="text-fvp-accent hover:underline"
                >
                  Check all
                </button>
                <button
                  onClick={() => selectAll(false)}
                  className="text-fvp-muted hover:text-fvp-text"
                >
                  Uncheck all
                </button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 px-3 py-2 space-y-1">
              {candidates.length === 0 && (
                <div className="text-center text-fvp-muted text-xs py-8">
                  No TMDb hits for any unmatched member. Try matching one or
                  two manually first — Smart Search uses your manual picks
                  as hints.
                </div>
              )}
              {candidates.map((c) => {
                const isChecked = checked.has(c.identity_id);
                return (
                  <label
                    key={c.identity_id}
                    className={
                      "flex gap-3 p-2 rounded cursor-pointer text-xs " +
                      (isChecked
                        ? "bg-fvp-accent/10"
                        : "bg-transparent opacity-60")
                    }
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggle(c.identity_id)}
                      className="mt-0.5 accent-fvp-accent"
                    />
                    {c.proposed_poster_url ? (
                      <img
                        src={c.proposed_poster_url}
                        alt=""
                        width={40}
                        height={60}
                        className="object-cover bg-fvp-bg rounded shrink-0"
                        style={{ width: 40, height: 60 }}
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.visibility = "hidden";
                        }}
                      />
                    ) : (
                      <div
                        className="bg-fvp-bg rounded shrink-0"
                        style={{ width: 40, height: 60 }}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-fvp-muted text-[10px] truncate">
                        was: <span className="font-mono">{c.current_title}</span>
                      </div>
                      <div className="text-fvp-text font-semibold text-[12px]">
                        → {c.proposed_title}
                        {c.proposed_year && (
                          <span className="text-fvp-muted font-normal ml-1">
                            ({c.proposed_year})
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-fvp-muted">
                        tmdb:{c.proposed_tmdb_id}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>

            <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-between text-xs">
              <span className="text-fvp-muted">
                {checked.size} of {candidates.length} selected
              </span>
              <div className="flex gap-2">
                <button
                  onClick={onResolved}
                  disabled={stage === "applying"}
                  className="px-3 py-1 text-fvp-text hover:bg-fvp-surface2 rounded disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void apply()}
                  disabled={stage === "applying" || checked.size === 0}
                  className="px-4 py-1 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-50"
                >
                  {stage === "applying"
                    ? "Applying…"
                    : `Apply ${checked.size}`}
                </button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
