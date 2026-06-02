import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { profileIpc } from "../ipc";
import type { Marker, HistorySnapshot } from "../state/types";
import type { Snip, FreeFile, Fingerprint } from "../ipc/types";
import { appendAuthorshipEvent } from "../utils/authorship";

const DEBOUNCE_MS = 500;

/** Shape returned by `loadDraftForFile` — flattened for the caller. */
export interface DraftFile {
  schema: 1;
  snips: Snip[];
  markers: Marker[];
  snipLanes: Record<string, number>;
  customCategories: string[];
  /** Present when the source was a FreeFile (new format). Lets the caller
   *  hydrate metadata / groups too. */
  freeFile?: FreeFile;
}

/** Empty/placeholder fingerprint used until the real one is computed. The
 *  scanner's loosened scoring (filename+size+duration → Exact) handles the
 *  case where libmpv-based fingerprinting failed for a file. */
function emptyFingerprint(): Fingerprint {
  return {
    filename: "",
    size_bytes: 0,
    container: "",
    codec: "",
    duration_ms: 0,
    phash_samples: [],
  };
}

/**
 * Watches Creator's working state and autosaves to a sidecar
 * `.fvp-autosave.free` next to the video on every change (debounced ~500ms).
 *
 * The autosave payload is a full `FreeFile` (same schema as a manually-
 * exported profile) so the profile scanner picks it up alongside any user-
 * exported `.free` files. The autosave file's name (`*.fvp-autosave.free`)
 * keeps it distinguishable from manual exports.
 *
 * Only writes when `autosaveDraft` is on and a file is loaded.
 */
export function useAutosaveDraft() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSerialized = "";

    const flush = (videoPath: string, json: string) => {
      if (json === lastSerialized) return;
      lastSerialized = json;
      profileIpc.saveDraft(videoPath, json).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("autosave failed:", err);
        const s = useAppStore.getState();
        if (!s.autosaveErrorShown) {
          useAppStore.setState({ autosaveErrorShown: true });
          s.showToast(
            "Autosave failed — edits aren't being saved to disk. " +
              "Check that the video's folder is writable, or turn off Autosave to silence this.",
            "error",
            10_000,
          );
        }
      });
    };

    const unsub = useAppStore.subscribe((state, prev) => {
      const changed =
        state.snips !== prev.snips ||
        state.markers !== prev.markers ||
        state.snipLanes !== prev.snipLanes ||
        state.customCategories !== prev.customCategories ||
        state.groups !== prev.groups ||
        state.imdbUrl !== prev.imdbUrl ||
        state.aspectRatio !== prev.aspectRatio ||
        state.movieTitle !== prev.movieTitle ||
        state.movieYear !== prev.movieYear ||
        state.mapsFiltered !== prev.mapsFiltered ||
        state.mapsUnfiltered !== prev.mapsUnfiltered ||
        state.movieDirector !== prev.movieDirector ||
        state.movieStars !== prev.movieStars ||
        state.moviePlot !== prev.moviePlot ||
        state.imdbRating !== prev.imdbRating ||
        state.imdbId !== prev.imdbId ||
        state.currentFile !== prev.currentFile ||
        state.currentFileFingerprint !== prev.currentFileFingerprint ||
        state.autosaveDraft !== prev.autosaveDraft;
      if (!changed) return;
      if (!state.autosaveDraft || !state.currentFile) return;

      const videoPath = state.currentFile;
      const nowSecs = Math.floor(Date.now() / 1000);
      // Append an authorship event (dedup'd by handle+day so we don't
      // accumulate hundreds of identical entries during one editing
      // session). Updates the store so the next render reflects it.
      const history = appendAuthorshipEvent(
        state.authorshipHistory,
        state.authorHandle,
        nowSecs,
      );
      if (history !== state.authorshipHistory) {
        useAppStore.setState({ authorshipHistory: history });
      }
      const free: FreeFile = {
        schema: 1,
        signature: null,
        pubkey: null,
        uploader: null,
        payload: {
          fingerprint: state.currentFileFingerprint ?? emptyFingerprint(),
          metadata: {
            name: "(autosaved)",
            movie_title: state.movieTitle,
            movie_year: state.movieYear,
            version: 1,
            notes: null,
            created: nowSecs,
            modified: nowSecs,
            imdb_url: state.imdbUrl,
            aspect_ratio: state.aspectRatio.length > 0 ? state.aspectRatio : null,
            maps_filtered: state.mapsFiltered,
            maps_unfiltered: state.mapsUnfiltered,
            movie_director: state.movieDirector,
            movie_stars: state.movieStars,
            movie_plot: state.moviePlot,
            imdb_rating: state.imdbRating,
            imdb_id: state.imdbId,
          },
          snips: state.snips,
          groups: state.groups,
          markers: state.markers,
          authorship_history: history,
        },
      };
      const json = JSON.stringify(free);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => flush(videoPath, json), DEBOUNCE_MS);
    });

    return () => {
      if (timer) clearTimeout(timer);
      unsub();
    };
  }, []);
}

/**
 * Try to load a saved draft/autosave for a video. Returns null if none
 * exists or the file is unreadable. Handles BOTH formats:
 *   - New: `.fvp-autosave.free` → JSON FreeFile
 *   - Legacy: `.fvp-draft.json` → JSON DraftFile (pre-rename)
 *
 * The Tauri backend's `load_draft` already falls back to the legacy path
 * when the new one is missing, so we just need to detect the shape here.
 */
export async function loadDraftForFile(videoPath: string): Promise<DraftFile | null> {
  try {
    const json = await profileIpc.loadDraft(videoPath);
    if (!json) return null;
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;

    // FreeFile shape: { schema, payload: { snips, markers, groups, ... } }
    if (
      "payload" in parsed &&
      typeof (parsed as { payload?: unknown }).payload === "object"
    ) {
      const ff = parsed as FreeFile;
      return {
        schema: 1,
        snips: ff.payload.snips ?? [],
        markers: ff.payload.markers ?? [],
        snipLanes: {},
        customCategories: [],
        freeFile: ff,
      };
    }

    // Legacy DraftFile shape: { schema: 1, snips, markers, snipLanes, customCategories }
    const draft = parsed as DraftFile;
    if (draft.schema !== 1 || !Array.isArray(draft.snips)) return null;
    return {
      schema: 1,
      snips: draft.snips,
      markers: draft.markers ?? [],
      snipLanes: draft.snipLanes ?? {},
      customCategories: draft.customCategories ?? [],
    };
  } catch {
    return null;
  }
}

export type { HistorySnapshot };
