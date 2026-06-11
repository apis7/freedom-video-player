import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";

interface Props {
  onClose: () => void;
}

const STORAGE_KEY = "fvp:freeform_notes";
const AUTOSAVE_DELAY_MS = 500;

/**
 * Library Tools → Freeform Notes. A no-frills, always-on scratchpad
 * for the user's own thinking — outline a profile they want to make,
 * jot down where they paused last night, list movies they want to add
 * next, whatever. Not tied to any specific file, identity, profile, or
 * library row.
 *
 * Storage: localStorage. Survives app restarts. Per-install (does NOT
 * sync via the library-sync.db mirror — these are private to this
 * machine by design; the notes can mention things the user wouldn't
 * want pushed to their NAS for other devices to read).
 *
 * Autosave: debounced ~500 ms after the last keystroke. A tiny
 * indicator in the footer flips Saved → Saving… → Saved so the user
 * can see it's been captured.
 */
export function FreeformNotesModal({ onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const [value, setValue] = useState<string>(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const debounceRef = useRef<number | null>(null);

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

  // Debounced autosave. We never block the keystroke — the textarea
  // updates immediately and the save happens 500 ms after the user
  // stops typing.
  useEffect(() => {
    if (debounceRef.current != null) {
      window.clearTimeout(debounceRef.current);
    }
    setSaving(true);
    debounceRef.current = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, value);
        setSavedAt(Date.now());
      } catch {
        // localStorage can fail on private-mode or quota-exceeded;
        // fail silently and keep the in-memory value so the user
        // doesn't lose what they typed.
      }
      setSaving(false);
    }, AUTOSAVE_DELAY_MS);
    return () => {
      if (debounceRef.current != null) {
        window.clearTimeout(debounceRef.current);
      }
    };
  }, [value]);

  const wordCount = value.trim().length === 0
    ? 0
    : value.trim().split(/\s+/).length;

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 w-full max-w-3xl h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="text-sm font-semibold text-fvp-text">
              Freeform Notes
            </h3>
            <p className="text-[11px] text-fvp-muted mt-0.5 leading-relaxed">
              Scratchpad for organizing your thoughts and profile-creation
              work. Outline a profile, list movies to revisit, jot down where
              you left off — anything. Autosaves as you type; stays on this
              machine (never synced).
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

        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoFocus
          placeholder="Type anything…"
          className="flex-1 w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-2 text-sm text-fvp-text outline-none font-mono resize-none leading-relaxed"
          spellCheck
        />

        <div className="flex items-center justify-between mt-3 text-[11px] text-fvp-muted">
          <div className="flex items-center gap-3">
            <span>
              {value.length} char{value.length === 1 ? "" : "s"} ·{" "}
              {wordCount} word{wordCount === 1 ? "" : "s"}
            </span>
          </div>
          <SaveStatus saving={saving} savedAt={savedAt} />
        </div>
      </div>
    </div>
  );
}

function SaveStatus({
  saving,
  savedAt,
}: {
  saving: boolean;
  savedAt: number | null;
}) {
  if (saving) {
    return <span className="text-fvp-muted italic">Saving…</span>;
  }
  if (savedAt == null) {
    return <span className="text-fvp-muted">Autosave on</span>;
  }
  return (
    <span className="text-fvp-accent">
      Saved {relativeTime(savedAt)}
    </span>
  );
}

function relativeTime(then: number): string {
  const diffMs = Date.now() - then;
  const s = Math.round(diffMs / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}
