import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import { invoke } from "@tauri-apps/api/core";

interface ImdbLinkModalProps {
  initial: string | null;
  onClose: () => void;
}

/**
 * IMDb parental-guide URL editor. Two-step soft validation:
 *
 * 1) Hard reject if the URL doesn't contain "imdb.com" — these are obvious
 *    mistakes (a Wikipedia link, a random pasted URL, etc.).
 * 2) If it does contain imdb.com but NOT "/parentalguide", warn the user
 *    via window.confirm — common case is they pasted the movie's main page
 *    instead of the parental-guide subpage. They can confirm-anyway.
 *
 * Empty input clears the saved URL.
 */
export function ImdbLinkModal({ initial, onClose }: ImdbLinkModalProps) {
  const [value, setValue] = useState(initial ?? "");
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
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    const trimmed = value.trim();
    setError(null);

    if (!trimmed) {
      useAppStore.setState({ imdbUrl: null });
      onClose();
      return;
    }

    // Hard rule: must look like an IMDb URL.
    if (!/imdb\.com/i.test(trimmed)) {
      setError(
        "Doesn't look like an IMDb URL — the link must contain \"imdb.com\". " +
          "Paste from the movie's parental-guide page on https://imdb.com .",
      );
      return;
    }

    // Soft rule: warn if not the /parentalguide subpage.
    if (!/\/parentalguide(\/|\?|#|$)/i.test(trimmed)) {
      const ok = window.confirm(
        "That looks like an IMDb link, but it's not pointing to the " +
          "/parentalguide subpage for a movie.\n\n" +
          "Are you sure this is the parental guide page?\n\n" +
          "Click OK to save anyway, or Cancel to fix it.",
      );
      if (!ok) return;
    }

    useAppStore.setState({ imdbUrl: trimmed });
    onClose();
  };

  const openInBrowser = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    void invoke("open_external_url", { url: trimmed }).catch((err) =>
      useAppStore.getState().showToast(`Couldn't open URL: ${err}`, "error"),
    );
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[480px] max-w-[640px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-1">
          IMDb parental guide link
        </div>
        <div className="text-[11px] text-fvp-muted mb-4">
          Optional URL pointing at the movie's parental-guide page on IMDb.
          Saved with the .free profile — useful as a one-click reference when
          categorizing snips, or for anyone viewing your profile later.
        </div>

        <label className="block text-[10px] uppercase tracking-wider text-fvp-muted mb-1">
          URL
        </label>
        <div className="flex gap-2 mb-2">
          <input
            autoFocus
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
            }}
            className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-sm text-fvp-text outline-none font-mono"
            placeholder="https://www.imdb.com/title/tt.../parentalguide"
          />
          <button
            onClick={openInBrowser}
            disabled={!value.trim()}
            title="Open URL in default browser"
            className="px-3 py-1.5 text-xs text-fvp-text bg-fvp-surface2 border border-fvp-border rounded hover:opacity-90 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Open ↗
          </button>
        </div>

        {error && (
          <div className="text-[11px] text-fvp-err bg-fvp-err/10 border border-fvp-err/40 rounded px-2 py-1.5 mb-3">
            {error}
          </div>
        )}

        <div className="text-[10px] text-fvp-muted/70 mb-4">
          Example: <span className="font-mono">https://www.imdb.com/title/tt0117500/parentalguide/</span>
        </div>

        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="px-3 py-1.5 bg-fvp-accent text-white rounded cursor-pointer"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
