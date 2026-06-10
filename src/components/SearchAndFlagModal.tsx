import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import type { Flag } from "../state/types";

interface Props {
  onClose: () => void;
}

/**
 * Search & Flag — augments AutoSnip.
 *
 * The bundled AutoSnip wordlists only catch known terms. Some content
 * uses local slang or in-universe euphemisms (the user mentioned "lady
 * suck-suck", "dickenson", etc.) that don't appear in any standard list.
 *
 * This modal lets the user type ANY substring, scans the loaded
 * subtitleEntries, and drops a Flag at the start time of every matching
 * cue. NO snips are created — Flags are review-only markers. The user
 * decides whether to snip around each one manually.
 *
 * Case-insensitive substring match. Multiple search terms can be entered
 * (one per line) so a single pass catches all the unique-to-this-video
 * terms the user knows about.
 */
export function SearchAndFlagModal({ onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const entries = useAppStore((s) => s.subtitleEntries);
  const addFlags = useAppStore((s) => s.addFlags);
  const commitToHistory = useAppStore((s) => s.commitToHistory);
  const showToast = useAppStore((s) => s.showToast);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<
    Array<{ term: string; ms: number; text: string }>
  >([]);

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

  // Recompute preview matches as the user types.
  useEffect(() => {
    const terms = query
      .split("\n")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    if (terms.length === 0) {
      setPreview([]);
      return;
    }
    const out: Array<{ term: string; ms: number; text: string }> = [];
    for (const e of entries) {
      const haystack = e.text.toLowerCase();
      for (const term of terms) {
        if (haystack.includes(term)) {
          out.push({ term, ms: e.start_ms, text: e.text });
          break;
        }
      }
    }
    setPreview(out);
  }, [query, entries]);

  const apply = () => {
    if (preview.length === 0) return;
    commitToHistory();
    const flags: Flag[] = preview.map((m) => ({
      ms: m.ms,
      name: m.term,
      category: "search",
      keyword: m.term,
      subtitleText: m.text,
      linkedSnipId: null,
    }));
    addFlags(flags);
    showToast(
      `Search & Flag: added ${flags.length} flag${flags.length === 1 ? "" : "s"}.`,
      "info",
      3500,
    );
    onClose();
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-fvp-text">
              Search & Flag
            </h3>
            <p className="text-[11px] text-fvp-muted mt-0.5">
              Augments AutoSnip. Drops a flag wherever your term appears in the
              subtitles. <strong>No snips created</strong> — just flags, for
              manual review.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-fvp-muted hover:text-fvp-text text-sm"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>

        {entries.length === 0 ? (
          <div className="bg-fvp-warn/10 border border-fvp-warn text-fvp-warn text-xs p-3 rounded">
            No subtitles loaded. Add a subtitle file first (right-click the
            timeline → "Add subtitle file…") before searching.
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <label className="block text-[11px] text-fvp-muted">
                Search terms — one per line. Case-insensitive substring match.
              </label>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  "lady suck-suck\ndickenson\nfrak\n…"
                }
                rows={4}
                autoFocus
                className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-2 text-sm text-fvp-text outline-none font-mono"
              />
              <div className="text-[10px] text-fvp-muted">
                Scanning {entries.length} subtitle entries.
              </div>
            </div>

            <div className="mt-3 flex-1 min-h-0 flex flex-col">
              <div className="text-[11px] uppercase tracking-wider text-fvp-muted mb-1">
                Preview · {preview.length} match
                {preview.length === 1 ? "" : "es"}
              </div>
              <div className="flex-1 overflow-y-auto bg-fvp-bg border border-fvp-border rounded p-2 text-[11px] space-y-1 max-h-[200px]">
                {preview.length === 0 ? (
                  <div className="text-fvp-muted italic">
                    {query.trim().length === 0
                      ? "Type a term above to preview matches."
                      : "No matches yet — try a different term or fragment."}
                  </div>
                ) : (
                  preview.slice(0, 200).map((m, i) => (
                    <div
                      key={`${m.ms}-${i}`}
                      className="flex gap-2 border-b border-fvp-border/30 last:border-0 py-0.5"
                    >
                      <span className="text-fvp-muted font-mono tabular-nums shrink-0 w-16">
                        {formatTime(m.ms)}
                      </span>
                      <span className="text-fvp-accent font-mono shrink-0">
                        {m.term}
                      </span>
                      <span className="text-fvp-text/85 line-clamp-1 flex-1 min-w-0">
                        {m.text}
                      </span>
                    </div>
                  ))
                )}
                {preview.length > 200 && (
                  <div className="text-fvp-muted italic text-center pt-1">
                    + {preview.length - 200} more…
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 text-xs mt-4">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
              >
                Cancel
              </button>
              <button
                onClick={apply}
                disabled={preview.length === 0}
                className="px-3 py-1.5 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-50"
              >
                Add {preview.length} flag{preview.length === 1 ? "" : "s"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m}:${ss.toString().padStart(2, "0")}`;
}
