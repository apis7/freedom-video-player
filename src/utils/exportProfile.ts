import { useAppStore } from "../state/appStore";
import { playback, profileIpc } from "../ipc";
import type { FreeFile } from "../ipc/types";

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Strip filesystem-forbidden characters so user-supplied names are safe to use as filenames. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim();
}

function dirAndBase(path: string): { dir: string; base: string } {
  const norm = path.replace(/\\/g, "/");
  const lastSlash = norm.lastIndexOf("/");
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : "";
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  return { dir, base };
}

/** Resolve where the export would write — given the video path and a
 *  profile name. Pure (no I/O), used by the modal to check overwrite. */
export function computeExportPath(videoPath: string, profileName: string): string {
  const { dir, base } = dirAndBase(videoPath);
  const safeName = sanitizeFilename(profileName);
  return `${dir}${base}.${safeName}.free`;
}

/** Save the current Creator draft (snips + markers) as a .free file next to
 *  the loaded video, named "<videoBase>.<profileName>.free". Refreshes the
 *  detected-profiles list after save so Player Mode picks it up. */
export async function exportCurrentProfile(profileName: string): Promise<ExportResult> {
  const state = useAppStore.getState();
  if (!state.currentFile) {
    return { ok: false, error: "No file loaded." };
  }
  if (state.snips.length === 0) {
    return { ok: false, error: "No snips to export." };
  }

  const uncategorized = state.snips.filter((s) => s.categories.length === 0);
  if (uncategorized.length > 0) {
    return {
      ok: false,
      error: `${uncategorized.length} snip(s) need a category before export.`,
    };
  }

  const trimmed = profileName.trim();
  if (!trimmed) {
    return { ok: false, error: "Profile name is required." };
  }

  // Compute fingerprint via the libmpv-backed backend command (transient instance).
  let fingerprint;
  try {
    fingerprint = await profileIpc.computeFingerprint(state.currentFile);
  } catch (err) {
    return { ok: false, error: `Fingerprint failed: ${err}` };
  }

  const now = Math.floor(Date.now() / 1000);
  // Append the export event to the authorship history (dedup'd by
  // handle+day with the autosave-side appender).
  const { appendAuthorshipEvent } = await import("./authorship");
  const history = appendAuthorshipEvent(
    state.authorshipHistory,
    state.authorHandle,
    now,
  );
  if (history !== state.authorshipHistory) {
    useAppStore.setState({ authorshipHistory: history });
  }
  const file: FreeFile = {
    schema: 1,
    signature: null,
    pubkey: null,
    uploader: null,
    payload: {
      fingerprint,
      metadata: {
        name: trimmed,
        movie_title: state.movieTitle,
        movie_year: state.movieYear,
        version: 1,
        notes: null,
        created: now,
        modified: now,
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

  const savePath = computeExportPath(state.currentFile, trimmed);

  try {
    await profileIpc.saveProfile(savePath, file);
  } catch (err) {
    return { ok: false, error: `Save failed: ${err}` };
  }

  // Refresh detected profiles so the new file shows up in the Player chip / switcher.
  try {
    const matches = await profileIpc.scanFolderForProfiles(state.currentFile);
    const detected = matches.map((m) => ({
      ...m,
      active: m.score.quality === "exact",
    }));
    useAppStore.setState({ detectedProfiles: detected });
  } catch {
    // Non-fatal — save succeeded.
  }

  // Reset playback's mute (apply engine may have set it during preview).
  try {
    await playback.setMuted(useAppStore.getState().muted);
  } catch {}

  return { ok: true, path: savePath };
}
