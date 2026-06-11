import { useEffect, useRef } from "react";
import { useAppStore } from "../state/appStore";
import { libraryIpc } from "../ipc/library";

/**
 * Auto-populate the Creator-mode "Movie Info" fields from the
 * library DB when the currently-loaded video already has metadata
 * there. Saves the user from re-running TMDb auto-fill for a
 * movie the library already knows about.
 *
 * Trigger:
 *   - currentFile changes (a new video loads)
 *   - mode is "creator" (we only need this in the editor)
 *
 * Behavior:
 *   - Look up the library row by file path.
 *   - For each Movie Info field, fill ONLY when the Zustand value is
 *     null/empty. Never clobbers values the .free profile autoload
 *     already filled OR that the user has typed manually since the
 *     file opened.
 *   - Fires once per file path. A ref tracks the last-prefilled
 *     path so re-renders don't re-prefill (which would re-fill a
 *     field the user just cleared).
 */
export function useLibraryMetadataPrefill(): void {
  const currentFile = useAppStore((s) => s.currentFile);
  const mode = useAppStore((s) => s.mode);
  const prefilledFor = useRef<string | null>(null);

  useEffect(() => {
    if (!currentFile) {
      prefilledFor.current = null;
      return;
    }
    if (mode !== "creator") {
      console.log(
        `[fvp:creator] metadata-prefill: skip (mode=${mode}, need creator)`,
      );
      return;
    }
    if (prefilledFor.current === currentFile) {
      console.log(
        "[fvp:creator] metadata-prefill: skip (already prefilled for this file)",
      );
      return;
    }
    console.log(
      `[fvp:creator] metadata-prefill: scheduling prefill for ${currentFile}`,
    );

    // Delay slightly so the .free autoload (which runs straight from
    // openVideoPath's profile-resolver) has a chance to fill fields
    // first. Without the delay, our prefill races and we'd clobber
    // ourselves a moment later when the autoload writes its values.
    const handle = window.setTimeout(() => {
      void (async () => {
        try {
          const fileId = await libraryIpc.findFileByPath(currentFile);
          if (fileId == null) {
            console.log(
              `[fvp:creator] metadata-prefill: no library row found for ${currentFile} — abandoning`,
            );
            return;
          }
          if (useAppStore.getState().currentFile !== currentFile) return;
          const row = await libraryIpc.getRow(fileId);
          if (!row) {
            console.log(
              `[fvp:creator] metadata-prefill: getRow returned null for file_id=${fileId}`,
            );
            return;
          }
          if (useAppStore.getState().currentFile !== currentFile) return;
          console.log(
            `[fvp:creator] metadata-prefill: file_id=${fileId} identity has movie_title=${row.identity.movie_title ?? "(null)"}, director=${row.identity.movie_director ?? "(null)"}, plot=${row.identity.movie_plot ? "yes" : "(null)"}`,
          );

          const id = row.identity;
          const s = useAppStore.getState();
          const patch: Partial<typeof s> = {};

          if (!s.movieTitle && id.movie_title) patch.movieTitle = id.movie_title;
          if (s.movieYear == null && id.movie_year != null)
            patch.movieYear = id.movie_year;
          if (!s.movieDirector && id.movie_director)
            patch.movieDirector = id.movie_director;
          if (!s.moviePlot && id.movie_plot) patch.moviePlot = id.movie_plot;
          if (
            (!s.movieStars || s.movieStars.length === 0) &&
            id.movie_stars &&
            id.movie_stars.length > 0
          ) {
            patch.movieStars = id.movie_stars;
          }
          if (!s.imdbId && id.imdb_id) patch.imdbId = id.imdb_id;
          if (s.imdbRating == null && id.imdb_rating != null) {
            patch.imdbRating = id.imdb_rating;
          }
          if (!s.imdbUrl && id.imdb_id) {
            patch.imdbUrl = `https://www.imdb.com/title/${id.imdb_id}/`;
          }
          // MAPS ratings: library stores filtered / unfiltered as
          // tier + summary pairs. Translate to the Creator-store
          // shape (MapsRating = { tier, summary }). Backend stores
          // tier as a raw string; guard with a runtime check.
          const validTier = (
            t: string | null,
          ): t is import("../ipc/types").MapsTier =>
            t === "family" ||
            t === "teen" ||
            t === "adult" ||
            t === "married_adult" ||
            t === "degrading";
          if (!s.mapsFiltered && validTier(id.maps_filtered_tier)) {
            patch.mapsFiltered = {
              tier: id.maps_filtered_tier,
              summary: id.maps_filtered_summary ?? "",
            };
          }
          if (!s.mapsUnfiltered && validTier(id.maps_unfiltered_tier)) {
            patch.mapsUnfiltered = {
              tier: id.maps_unfiltered_tier,
              summary: id.maps_unfiltered_summary ?? "",
            };
          }

          if (Object.keys(patch).length > 0) {
            useAppStore.setState(patch);
            console.log(
              `[fvp:creator] metadata-prefill: APPLIED file_id=${fileId} fields=${Object.keys(patch).join(",")}`,
            );
          } else {
            console.log(
              `[fvp:creator] metadata-prefill: nothing to apply (library row has no metadata OR Zustand already populated by .free autoload)`,
            );
          }
          prefilledFor.current = currentFile;
        } catch (err) {
          console.log(`[fvp:creator] library prefill failed: ${err}`);
        }
      })();
    }, 350);

    return () => window.clearTimeout(handle);
  }, [currentFile, mode]);
}
