import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import { tmdbIpc } from "../ipc";
import type { TmdbSearchResult, TmdbMovieDetails } from "../ipc/types";

interface Props {
  /** Pre-fills the search box; usually the current movie title or
   *  the filename stem if nothing's set yet. */
  initialQuery: string;
  /** Fires when the user picks a result and we've fetched details. */
  onPicked: (details: TmdbMovieDetails) => void;
  onCancel: () => void;
}

/**
 * Modal flow: enter query → search TMDb → pick from top-5 result list
 * → fetch full details → hand back to caller. Caller decides which
 * fields to populate (we just deliver the data).
 */
export function TmdbAutoFillModal({ initialQuery, onPicked, onCancel }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<TmdbSearchResult[]>([]);
  const [loading, setLoading] = useState<"search" | "details" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Auto-search once on mount when we have an initial query.
  useEffect(() => {
    if (initialQuery.trim().length > 0) {
      void runSearch(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSearch = async (q: string) => {
    setError(null);
    setResults([]);
    setLoading("search");
    try {
      const hits = await tmdbIpc.search(q);
      setResults(hits);
      if (hits.length === 0) setError("No matches on TMDb for that query.");
    } catch (err) {
      setError(`Search failed: ${err}`);
    } finally {
      setLoading(null);
    }
  };

  const pickResult = async (hit: TmdbSearchResult) => {
    setLoading("details");
    setError(null);
    try {
      const details = await tmdbIpc.details(hit.tmdb_id);
      onPicked(details);
    } catch (err) {
      setError(`Couldn't fetch details: ${err}`);
      setLoading(null);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[560px] max-w-[720px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-fvp-text mb-1">
          Auto-fill from TMDb
        </h3>
        <p className="text-[11px] text-fvp-muted mb-3">
          Search The Movie Database for this movie. Picking a result will
          fill in title / year / director / cast / plot / IMDb rating.
          You can still edit anything afterward.
        </p>

        <div className="flex gap-2 mb-3">
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch(query);
              }
            }}
            placeholder="Movie title…"
            className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-sm text-fvp-text outline-none"
          />
          <button
            onClick={() => void runSearch(query)}
            disabled={loading !== null || query.trim().length === 0}
            className="px-3 py-1.5 rounded text-xs bg-fvp-accent text-white hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            {loading === "search" ? "Searching…" : "Search"}
          </button>
        </div>

        {error && (
          <div className="text-[11px] text-fvp-err bg-fvp-err/10 border border-fvp-err/40 rounded px-2 py-1.5 mb-3">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-auto -mx-2 px-2">
          {results.length > 0 && (
            <ul className="space-y-1">
              {results.map((r) => (
                <li key={r.tmdb_id}>
                  <button
                    onClick={() => void pickResult(r)}
                    disabled={loading !== null}
                    className="w-full flex gap-3 p-2 rounded border border-fvp-border bg-fvp-bg hover:border-fvp-accent text-left disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    {r.poster_url ? (
                      <img
                        src={r.poster_url}
                        alt=""
                        width={46}
                        height={69}
                        className="rounded-sm shrink-0 bg-fvp-surface2"
                      />
                    ) : (
                      <div className="w-[46px] h-[69px] rounded-sm bg-fvp-surface2 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-fvp-text truncate">
                        {r.title}{" "}
                        {r.release_year && (
                          <span className="text-fvp-muted font-normal">
                            ({r.release_year})
                          </span>
                        )}
                      </div>
                      {r.original_title && r.original_title !== r.title && (
                        <div className="text-[10px] text-fvp-muted italic truncate">
                          {r.original_title}
                        </div>
                      )}
                      <div className="text-[11px] text-fvp-muted leading-snug mt-0.5 line-clamp-3">
                        {r.overview || "(no plot summary on TMDb)"}
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {loading === "details" && (
            <div className="text-center text-xs text-fvp-muted py-2">
              Loading details…
            </div>
          )}
        </div>

        <div className="flex justify-end mt-3">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs bg-fvp-bg border border-fvp-border text-fvp-text hover:border-fvp-muted"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
