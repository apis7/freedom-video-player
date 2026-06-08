import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { tmdbIpc } from "../../ipc/tmdb";
import { libraryIpc } from "../../ipc/library";
import type { TmdbSearchResult } from "../../ipc/types";

const SEARCH_DEBOUNCE_MS = 600;

interface Props {
  identityId: number;
  /** Pre-fills the search input so the user can immediately Enter. */
  initialQuery: string;
  onResolved: () => void;
}

/**
 * "Replace metadata from TMDb…" modal. Free-text TMDb search, list of
 * candidates with poster + year + plot snippet. Picking one writes the
 * chosen TMDb id onto the identity (with manual_* flags set so future
 * auto-enrichment leaves it alone). The user gets out of the
 * "auto-picked the wrong movie" trap without hand-editing fields.
 */
export function TmdbReplacePicker({ identityId, initialQuery, onResolved }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<TmdbSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  // Debounced auto-search: fire ~600ms after the user stops typing.
  // Cancels prior pending searches so we don't flood TMDb if the user
  // is mid-type. The ref keeps the timeout id across renders.
  const searchTimer = useRef<number | null>(null);
  const lastSearchedQuery = useRef<string>("");

  useEffect(() => {
    // Initial mount: fire immediately with the pre-filled query.
    void runSearch(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // On every keystroke after mount, schedule a debounced search.
    if (searchTimer.current !== null) {
      window.clearTimeout(searchTimer.current);
    }
    if (query.trim() === lastSearchedQuery.current.trim()) {
      // No change since last search — skip the debounce work.
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      void runSearch(query);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current !== null) {
        window.clearTimeout(searchTimer.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const runSearch = async (q: string) => {
    lastSearchedQuery.current = q;
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      setResults(await tmdbIpc.search(q));
    } catch (e) {
      setErr(`${e}`);
      setResults([]);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (r: TmdbSearchResult) => {
    setBusy(true);
    try {
      await libraryIpc.applyTmdbId(identityId, r.tmdb_id);
      showToast(`Metadata replaced with "${r.title}"`, "info", 3000);
      onResolved();
    } catch (e) {
      showToast(`Apply failed: ${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={onResolved}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col max-w-[640px] w-full max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border">
          <div className="text-sm font-semibold text-fvp-text mb-2">
            Replace metadata from TMDb
          </div>
          <div className="relative">
            {/* Magnifying-glass icon → reinforces "this is a search
                field" while showing a spinner state when actively
                searching. Auto-searches as you type (600 ms debounce);
                Enter still works for impatient users. */}
            <span
              className="absolute left-2 top-1/2 -translate-y-1/2 text-fvp-muted pointer-events-none"
              aria-hidden="true"
            >
              {busy ? (
                <span className="inline-block w-3.5 h-3.5 border-2 border-fvp-muted border-t-fvp-accent rounded-full animate-spin" />
              ) : (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="8.5" cy="8.5" r="5.5" />
                  <path d="m13 13 4 4" />
                </svg>
              )}
            </span>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void runSearch(query);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onResolved();
                }
              }}
              placeholder="Search TMDb…"
              className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded pl-8 pr-2 py-1.5 text-sm text-fvp-text outline-none"
            />
          </div>
        </header>

        <div className="overflow-y-auto px-2 py-2 flex-1">
          {err && (
            <div className="text-[11px] text-fvp-err px-3 py-2">{err}</div>
          )}
          {busy && results.length === 0 && (
            <div className="text-[11px] text-fvp-muted text-center py-6">
              Searching…
            </div>
          )}
          {!busy && results.length === 0 && !err && query.trim() && (
            <div className="text-[11px] text-fvp-muted text-center py-6">
              No matches.
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.tmdb_id}
              onClick={() => void apply(r)}
              disabled={busy}
              className="w-full flex gap-3 p-2 rounded hover:bg-fvp-surface2/60 text-left disabled:opacity-50"
            >
              <img
                src={r.poster_url ?? ""}
                alt=""
                width={56}
                height={84}
                className="object-cover bg-fvp-bg rounded shrink-0"
                style={{ width: 56, height: 84 }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.visibility = "hidden";
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-fvp-text">
                  {r.title}
                  {r.release_year && (
                    <span className="text-fvp-muted font-normal ml-2">
                      ({r.release_year})
                    </span>
                  )}
                </div>
                {r.original_title &&
                  r.original_title !== r.title && (
                    <div className="text-[10px] text-fvp-muted italic">
                      {r.original_title}
                    </div>
                  )}
                <div className="text-[11px] text-fvp-muted line-clamp-3 mt-0.5">
                  {r.overview || "No plot description on TMDb."}
                </div>
              </div>
            </button>
          ))}
        </div>

        <footer className="px-5 py-2 border-t border-fvp-border text-xs flex justify-end">
          <button
            onClick={onResolved}
            disabled={busy}
            className="px-3 py-1 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}
