import { useEffect } from "react";
import { useAppStore } from "../state/appStore";

const KEY = "fvp.settings.v1";
const DEBOUNCE_MS = 400;

interface PersistedSettings {
  autosaveDraft?: boolean;
  jumpPlayheadOnSnipSelect?: boolean;
  libraryEnabled?: boolean;
  libraryFolder?: string | null;
  libraryRecursive?: boolean;
  customCategories?: string[];
  autoSnipLanguage?: string;
  autoSnipPadBeforeMs?: number;
  autoSnipPadAfterMs?: number;
  customHotkeys?: Record<string, string>;
  dontShowBeepShortenWarning?: boolean;
  authorHandle?: string | null;
}

/**
 * Persist a small slice of app state to localStorage so user preferences
 * survive restarts: autosave toggle, jump-on-snip-select preference, library
 * folder + recursive flag, custom categories.
 *
 * Per-file working state (snips, markers, flags, current file) is NOT
 * persisted here — those have their own sidecar files (.fvp-draft.json).
 */
export function useSettingsPersist() {
  useEffect(() => {
    // Load + apply on mount.
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedSettings;
        useAppStore.setState((s) => ({
          autosaveDraft: parsed.autosaveDraft ?? s.autosaveDraft,
          jumpPlayheadOnSnipSelect:
            parsed.jumpPlayheadOnSnipSelect ?? s.jumpPlayheadOnSnipSelect,
          libraryEnabled: parsed.libraryEnabled ?? s.libraryEnabled,
          libraryFolder: parsed.libraryFolder ?? s.libraryFolder,
          libraryRecursive: parsed.libraryRecursive ?? s.libraryRecursive,
          customCategories: parsed.customCategories ?? s.customCategories,
          autoSnipLanguage: parsed.autoSnipLanguage ?? s.autoSnipLanguage,
          autoSnipPadBeforeMs:
            parsed.autoSnipPadBeforeMs ?? s.autoSnipPadBeforeMs,
          autoSnipPadAfterMs: parsed.autoSnipPadAfterMs ?? s.autoSnipPadAfterMs,
          customHotkeys: parsed.customHotkeys ?? s.customHotkeys,
          dontShowBeepShortenWarning:
            parsed.dontShowBeepShortenWarning ?? s.dontShowBeepShortenWarning,
          authorHandle: parsed.authorHandle ?? s.authorHandle,
        }));
      }
    } catch {
      // localStorage unavailable / parse failed — keep defaults.
    }

    // Save on change (debounced).
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSerialized = "";
    const unsub = useAppStore.subscribe((state, prev) => {
      const relevantChanged =
        state.autosaveDraft !== prev.autosaveDraft ||
        state.jumpPlayheadOnSnipSelect !== prev.jumpPlayheadOnSnipSelect ||
        state.libraryEnabled !== prev.libraryEnabled ||
        state.libraryFolder !== prev.libraryFolder ||
        state.libraryRecursive !== prev.libraryRecursive ||
        state.customCategories !== prev.customCategories ||
        state.autoSnipLanguage !== prev.autoSnipLanguage ||
        state.autoSnipPadBeforeMs !== prev.autoSnipPadBeforeMs ||
        state.autoSnipPadAfterMs !== prev.autoSnipPadAfterMs ||
        state.customHotkeys !== prev.customHotkeys ||
        state.dontShowBeepShortenWarning !== prev.dontShowBeepShortenWarning ||
        state.authorHandle !== prev.authorHandle;
      if (!relevantChanged) return;

      const payload: PersistedSettings = {
        autosaveDraft: state.autosaveDraft,
        jumpPlayheadOnSnipSelect: state.jumpPlayheadOnSnipSelect,
        libraryEnabled: state.libraryEnabled,
        libraryFolder: state.libraryFolder,
        libraryRecursive: state.libraryRecursive,
        customCategories: state.customCategories,
        autoSnipLanguage: state.autoSnipLanguage,
        autoSnipPadBeforeMs: state.autoSnipPadBeforeMs,
        autoSnipPadAfterMs: state.autoSnipPadAfterMs,
        customHotkeys: state.customHotkeys,
        dontShowBeepShortenWarning: state.dontShowBeepShortenWarning,
        authorHandle: state.authorHandle,
      };
      const json = JSON.stringify(payload);
      if (json === lastSerialized) return;
      lastSerialized = json;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          window.localStorage.setItem(KEY, json);
        } catch {}
      }, DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, []);
}
