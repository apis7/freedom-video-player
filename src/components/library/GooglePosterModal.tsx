import { useEffect, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type GoogleImage, type LibraryRow } from "../../ipc/library";
import { displayTitle } from "./titleDisplay";

interface Props {
  row: LibraryRow;
  onResolved: () => void;
  onClose: () => void;
}

/**
 * "Find alt poster on Google" picker. Uses the user-configured Google
 * Custom Search API key + Search Engine ID (set in Settings). Initial
 * query is the movie's title + year + "movie poster"; user can edit
 * and re-search before picking.
 *
 * Picking an image downloads it via the backend, caches it in the
 * poster-cache dir, and sets it as the identity's
 * `custom_thumbnail_path` (which takes precedence over the TMDb
 * poster on every render).
 */
export function GooglePosterModal({ row, onResolved, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const apiKey = useAppStore((s) => s.googleCseApiKey);
  const cx = useAppStore((s) => s.googleCseId);

  const initialQuery = (() => {
    const title = row.identity.movie_title ?? "";
    const year = row.identity.movie_year ?? "";
    return `${title} ${year} movie poster`.trim();
  })();
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<GoogleImage[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !applying) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applying, onClose]);

  const runSearch = async () => {
    if (!apiKey || !cx) {
      setError(
        "Google API key + Search Engine ID not configured. Set them in Settings → Google Image Search.",
      );
      return;
    }
    setSearching(true);
    setError(null);
    setResults(null);
    try {
      const hits = await libraryIpc.googleImageSearch(query, apiKey, cx);
      setResults(hits);
      if (hits.length === 0) {
        setError("No images returned for that query.");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSearching(false);
    }
  };

  // Auto-run the first search on open so the user sees results
  // immediately instead of a blank state.
  useEffect(() => {
    if (apiKey && cx) {
      void runSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const apply = async (img: GoogleImage) => {
    setApplying(true);
    try {
      await libraryIpc.applyImageUrl(row.identity.id, img.url);
      showToast("Poster set from Google.", "info", 2500);
      onResolved();
      onClose();
    } catch (err) {
      showToast(`Couldn't download poster: ${err}`, "error", 5000);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={() => !applying && onClose()}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-fvp-text">
              Find alt poster on Google
            </div>
            <div className="text-[11px] text-fvp-muted truncate max-w-md">
              {displayTitle(row)}
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={applying}
            className="text-fvp-muted hover:text-fvp-text text-lg leading-none"
          >
            ×
          </button>
        </header>

        <div className="px-5 py-3 border-b border-fvp-border flex gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !searching) {
                e.preventDefault();
                void runSearch();
              }
            }}
            placeholder="movie title + year + poster"
            className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-1.5 text-sm text-fvp-text outline-none"
            disabled={searching || applying}
          />
          <button
            onClick={() => void runSearch()}
            disabled={searching || applying || !apiKey || !cx}
            className="px-4 py-1.5 bg-fvp-accent text-white text-sm rounded hover:opacity-90 disabled:opacity-50"
          >
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 min-h-[200px]">
          {!apiKey || !cx ? (
            <div className="text-center text-fvp-muted text-sm py-12">
              <div className="mb-2">Google search isn't configured.</div>
              <div className="text-[11px]">
                Open Settings → Google Image Search and paste in your API
                key + Search Engine ID. Free tier at console.cloud.google.com.
              </div>
            </div>
          ) : searching ? (
            <div className="text-center text-fvp-muted text-sm py-12">
              Searching Google…
            </div>
          ) : error ? (
            <div className="text-center text-fvp-err text-sm py-12 max-w-md mx-auto break-words">
              {error}
            </div>
          ) : results && results.length > 0 ? (
            <div className="grid grid-cols-4 gap-2">
              {results.map((img) => (
                <button
                  key={img.url}
                  onClick={() => void apply(img)}
                  disabled={applying}
                  className="group relative bg-fvp-bg border border-fvp-border hover:border-fvp-accent rounded overflow-hidden flex flex-col disabled:opacity-50 transition-colors"
                  title={`${img.width}×${img.height} · ${img.source_page}`}
                >
                  <img
                    src={img.thumb_url}
                    alt=""
                    className="w-full h-32 object-contain bg-black/30"
                    referrerPolicy="no-referrer"
                  />
                  <div className="text-[9px] text-fvp-muted px-1.5 py-1 truncate text-left">
                    {img.width}×{img.height}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="text-center text-fvp-muted text-sm py-12">
              Enter a query above and hit Search.
            </div>
          )}
        </div>

        <footer className="px-5 py-2 border-t border-fvp-border text-[10px] text-fvp-muted flex justify-between">
          <span>
            {results
              ? `${results.length} result${results.length === 1 ? "" : "s"}`
              : ""}
          </span>
          <span>
            Free Google quota: 100 image searches per day. Pick → downloads
            + sets as custom thumbnail.
          </span>
        </footer>
      </div>
    </div>
  );
}
