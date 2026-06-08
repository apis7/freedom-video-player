import type { AppState } from "../state/types";

/**
 * Stable string snapshot of the persistence-relevant slice of state — the
 * exact fields written to a `.free` profile. Used by the saved-status pill
 * to detect whether the Creator's current work matches what was last
 * exported. Excludes ephemeral things (selection, view, history, transient
 * playback state) so cursoring around doesn't flip the indicator.
 *
 * The shape of this string is opaque — never persist it; only compare it
 * against another snapshotKey() computed in the same session.
 */
export function snapshotKey(state: AppState): string {
  return JSON.stringify({
    snips: state.snips,
    markers: state.markers,
    groups: state.groups,
    customCategories: state.customCategories,
    imdbUrl: state.imdbUrl,
    aspectRatio: state.aspectRatio,
    movieTitle: state.movieTitle,
    movieYear: state.movieYear,
    mapsFiltered: state.mapsFiltered,
    mapsUnfiltered: state.mapsUnfiltered,
    movieDirector: state.movieDirector,
    movieStars: state.movieStars,
    moviePlot: state.moviePlot,
    imdbRating: state.imdbRating,
    imdbId: state.imdbId,
  });
}

/** Snapshot of a fresh, empty Creator state. Anything different means the
 *  user has done some editing or loaded a draft — and therefore has work
 *  worth saving if it doesn't match `lastSavedSnapshot`. */
export const EMPTY_SNAPSHOT: string = (() => {
  // Mirror snapshotKey() with all-default values so future fields stay in
  // sync as long as they're added in both places (TypeScript will scream
  // if AppState gains a required field used in snapshotKey).
  return JSON.stringify({
    snips: [],
    markers: [],
    groups: [],
    customCategories: [],
    imdbUrl: null,
    aspectRatio: "",
    movieTitle: null,
    movieYear: null,
    mapsFiltered: null,
    mapsUnfiltered: null,
    movieDirector: null,
    movieStars: [],
    moviePlot: null,
    imdbRating: null,
    imdbId: null,
  });
})();
