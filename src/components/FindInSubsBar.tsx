import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";

interface Props {
  onClose: () => void;
}

/**
 * Word-find toolbar for subtitles. Floats over the player at the top
 * of the screen (like browser Ctrl+F) and lets the user step through
 * every occurrence of a substring in the loaded subtitleEntries.
 *
 * UX:
 *   - Input on the left, "M of N" indicator + ◄ / ► arrows + ✕ close
 *     on the right.
 *   - Enter / ► / ArrowDown → next match
 *   - Shift+Enter / ◄ / ArrowUp → previous match
 *   - Esc → close
 *   - Each step seeks the player to the matching cue's start time.
 *   - "Not found" surfaces inline (red text, no toast spam).
 *   - Auto-focuses on mount; user can type immediately.
 */
export function FindInSubsBar({ onClose }: Props) {
  const entries = useAppStore((s) => s.subtitleEntries);
  const showToast = useAppStore((s) => s.showToast);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<
    { ms: number; text: string }[]
  >([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Recompute matches whenever query or entries change.
  useEffect(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) {
      setMatches([]);
      setActiveIdx(0);
      return;
    }
    const found = entries
      .filter((e) => e.text.toLowerCase().includes(needle))
      .map((e) => ({ ms: e.start_ms, text: e.text }));
    setMatches(found);
    setActiveIdx(0);
  }, [query, entries]);

  // Esc closes; ↑↓ + Enter move between matches (in addition to the
  // button clicks).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      // Only handle navigation when the find input has focus —
      // otherwise we'd hijack the user's normal text editing.
      if (document.activeElement !== inputRef.current) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) goPrev();
        else goNext();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, activeIdx, onClose]);

  const seekToActive = (idx: number) => {
    const m = matches[idx];
    if (!m) return;
    void playback.seek(m.ms / 1000).catch(() => {
      showToast("Seek failed", "error", 3000);
    });
    // Pause is helpful when the user wants to study a specific line.
    // Mirrors the behavior of clicking a snip in the timeline.
    void playback.pause().catch(() => {});
  };

  const goNext = () => {
    if (matches.length === 0) return;
    const next = (activeIdx + 1) % matches.length;
    setActiveIdx(next);
    seekToActive(next);
  };
  const goPrev = () => {
    if (matches.length === 0) return;
    const prev = (activeIdx - 1 + matches.length) % matches.length;
    setActiveIdx(prev);
    seekToActive(prev);
  };

  // Auto-seek on the FIRST match for a fresh query so the user sees
  // immediate feedback. Subsequent steps are explicit (arrow / Enter).
  useEffect(() => {
    if (matches.length > 0 && query.trim().length > 0) {
      seekToActive(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches.length > 0 ? matches[0]?.ms : -1]);

  const noResults = query.trim().length > 0 && matches.length === 0;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[60] bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl px-3 py-2 flex items-center gap-2 min-w-[440px]">
      <span className="text-[10px] uppercase tracking-wider text-fvp-muted shrink-0">
        Find in subs
      </span>
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type to search subtitles…"
        className={
          "flex-1 bg-fvp-bg border rounded px-2 py-1 text-xs text-fvp-text outline-none font-mono " +
          (noResults
            ? "border-fvp-err focus:border-fvp-err"
            : "border-fvp-border focus:border-fvp-accent")
        }
      />
      <span
        className={
          "text-[11px] tabular-nums shrink-0 min-w-[60px] text-center " +
          (noResults
            ? "text-fvp-err"
            : matches.length > 0
              ? "text-fvp-text"
              : "text-fvp-muted")
        }
      >
        {noResults
          ? "no match"
          : matches.length > 0
            ? `${activeIdx + 1} of ${matches.length}`
            : "—"}
      </span>
      <button
        onClick={goPrev}
        disabled={matches.length === 0}
        title="Previous match (Shift+Enter / ↑)"
        className="px-2 py-1 text-xs bg-fvp-bg border border-fvp-border rounded hover:border-fvp-muted disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ◄
      </button>
      <button
        onClick={goNext}
        disabled={matches.length === 0}
        title="Next match (Enter / ↓)"
        className="px-2 py-1 text-xs bg-fvp-bg border border-fvp-border rounded hover:border-fvp-muted disabled:opacity-40 disabled:cursor-not-allowed"
      >
        ►
      </button>
      <button
        onClick={onClose}
        title="Close (Esc)"
        className="px-2 py-1 text-xs text-fvp-muted hover:text-fvp-text"
      >
        ✕
      </button>
    </div>
  );
}
