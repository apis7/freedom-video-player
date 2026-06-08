import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { snapshotKey, EMPTY_SNAPSHOT } from "../utils/snapshotKey";

/**
 * Maintains `state.unsavedSinceExport` by snapshotting persistence-relevant
 * state on every change and comparing against `state.lastSavedSnapshot`.
 *
 * - After a successful export, callers set `lastSavedSnapshot` directly
 *   (see exportProfile.ts). The next subscriber fire sees the match and
 *   flips `unsavedSinceExport` back to false.
 * - On file open, openVideoPath clears `lastSavedSnapshot` to null. We then
 *   treat the empty state as "clean" (nothing to save) and any non-empty
 *   state as "unsaved" (the autosave is keeping you safe but you haven't
 *   created a real .free file yet).
 *
 * Cheap guard up front: short-circuit when no persistence-relevant field
 * changed, so volume / playhead / selection updates don't pay the JSON cost.
 */
export function useSavedStatusTracker() {
  useEffect(() => {
    const unsub = useAppStore.subscribe((state, prev) => {
      const relevantChanged =
        state.snips !== prev.snips ||
        state.markers !== prev.markers ||
        state.groups !== prev.groups ||
        state.customCategories !== prev.customCategories ||
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
        state.lastSavedSnapshot !== prev.lastSavedSnapshot;
      if (!relevantChanged) return;

      const cur = snapshotKey(state);
      // Two paths to "clean":
      //   - We have a saved snapshot and current matches it → user has
      //     no unsaved edits since their last export.
      //   - There's no saved snapshot AND the state is empty → fresh
      //     file, nothing to lose, nothing to show.
      const dirty =
        state.lastSavedSnapshot !== null
          ? cur !== state.lastSavedSnapshot
          : cur !== EMPTY_SNAPSHOT;
      if (state.unsavedSinceExport !== dirty) {
        useAppStore.setState({ unsavedSinceExport: dirty });
      }
    });
    return unsub;
  }, []);
}
