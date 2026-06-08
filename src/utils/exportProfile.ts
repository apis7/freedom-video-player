import { useAppStore } from "../state/appStore";
import { playback, profileIpc } from "../ipc";
import type { FreeFile } from "../ipc/types";
import { snapshotKey } from "./snapshotKey";

export interface ExportResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/** Strip filesystem-forbidden characters so user-supplied names are safe
 *  to use as filenames. Also collapses runs of spaces and trims edges. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
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

/** Default save filename for a video (without directory). Just `<stem>.free`
 *  — clean and matches what the user expects when hitting Ctrl+S for the
 *  first time on a new video. */
export function defaultFilenameFor(videoPath: string): string {
  const { base } = dirAndBase(videoPath);
  return `${base}.free`;
}

/** Take a raw user-typed filename, sanitize it, and guarantee the `.free`
 *  extension. "Movie" → "Movie.free"; "Movie.free" → "Movie.free";
 *  "Movie.Family" → "Movie.Family.free". */
export function ensureFreeExtension(rawFilename: string): string {
  const safe = sanitizeFilename(rawFilename);
  if (safe.length === 0) return "";
  return safe.toLowerCase().endsWith(".free") ? safe : `${safe}.free`;
}

/** Resolve the full save path: video's folder + a sanitized + .free-suffixed
 *  filename. Pure (no I/O), used by the modal to check overwrite. */
export function computeExportPath(videoPath: string, filename: string): string {
  const { dir } = dirAndBase(videoPath);
  return `${dir}${ensureFreeExtension(filename)}`;
}

interface BuildFreeFileResult {
  file: FreeFile;
  /** History as appended (may differ from state.authorshipHistory). The
   *  caller is expected to push this back to the store so subsequent
   *  saves dedupe against it. */
  history: import("../ipc/types").AuthorshipEvent[];
}

/** Construct the FreeFile payload from current store state. Pulled out so
 *  both the "save to chosen filename" and "save to lastSavedPath" paths
 *  use exactly the same serialization. */
async function buildFreeFileFromState(): Promise<
  { ok: true; result: BuildFreeFileResult } | { ok: false; error: string }
> {
  const state = useAppStore.getState();
  if (!state.currentFile) return { ok: false, error: "No file loaded." };

  let fingerprint;
  try {
    fingerprint = await profileIpc.computeFingerprint(state.currentFile);
  } catch (err) {
    return { ok: false, error: `Fingerprint failed: ${err}` };
  }
  const now = Math.floor(Date.now() / 1000);
  const { appendAuthorshipEvent } = await import("./authorship");
  const history = appendAuthorshipEvent(
    state.authorshipHistory,
    state.authorHandle,
    now,
  );

  // Metadata `name` field is purely cosmetic at this point — the file's
  // identity comes from the on-disk filename + fingerprint. We store the
  // basename-without-extension so it's still meaningful for any consumer
  // that displays metadata.name (e.g. the profile picker).
  const file: FreeFile = {
    schema: 1,
    signature: null,
    pubkey: null,
    uploader: null,
    payload: {
      fingerprint,
      metadata: {
        name: state.movieTitle ?? "Profile",
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
  return { ok: true, result: { file, history } };
}

/** Apply post-save side effects: mark snapshot saved, refresh detected
 *  profiles, restore mute. Shared by both save paths. */
async function applyPostSaveSideEffects(savePath: string): Promise<void> {
  const state = useAppStore.getState();
  useAppStore.setState({
    lastSavedSnapshot: snapshotKey(state),
    unsavedSinceExport: false,
    lastSavedPath: savePath,
  });
  if (!state.currentFile) return;
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
  // Tell the library cache the .free presence flipped so the icon
  // updates immediately in Library Mode (without waiting for the next
  // folder rescan). Cheap, fire-and-forget; failure is non-fatal.
  try {
    const { libraryIpc } = await import("../ipc/library");
    await libraryIpc.refreshProfileStatus(state.currentFile);
  } catch {}
  try {
    await playback.setMuted(useAppStore.getState().muted);
  } catch {}
}

/** Sanity check shared by both save paths: bail with a friendly error when
 *  we'd produce an invalid .free file. Callers SHOULD surface a richer
 *  uncategorized-snips modal BEFORE reaching here; this is a backstop. */
function preflightSaveOrError(): string | null {
  const state = useAppStore.getState();
  if (!state.currentFile) return "No file loaded.";
  if (state.snips.length === 0) return "No snips to export.";
  const uncategorized = state.snips.filter((s) => s.categories.length === 0).length;
  if (uncategorized > 0) {
    return `${uncategorized} snip(s) need a category before export.`;
  }
  return null;
}

/** Save the current Creator state to the user-chosen filename. The file
 *  ends up at `<video-folder>/<sanitized-filename>.free`. Adds `.free` to
 *  the filename automatically if the user didn't include it. */
export async function exportCurrentProfile(filename: string): Promise<ExportResult> {
  const err = preflightSaveOrError();
  if (err) return { ok: false, error: err };
  const cleanName = ensureFreeExtension(filename);
  if (!cleanName) return { ok: false, error: "Filename is required." };

  const state = useAppStore.getState();
  if (!state.currentFile) return { ok: false, error: "No file loaded." };
  const savePath = computeExportPath(state.currentFile, cleanName);

  const built = await buildFreeFileFromState();
  if (!built.ok) return { ok: false, error: built.error };
  if (built.result.history !== state.authorshipHistory) {
    useAppStore.setState({ authorshipHistory: built.result.history });
  }

  try {
    await profileIpc.saveProfile(savePath, built.result.file);
  } catch (e) {
    return { ok: false, error: `Save failed: ${e}` };
  }
  await applyPostSaveSideEffects(savePath);
  return { ok: true, path: savePath };
}

/** Silent overwrite save to an EXACT path — used by Ctrl+S when the user
 *  has already saved this profile once in the current session
 *  (`lastSavedPath` is set). Skips the filename dialog entirely. The
 *  backend still does the rolling .bak rotation on the target. */
export async function saveProfileToExactPath(savePath: string): Promise<ExportResult> {
  const err = preflightSaveOrError();
  if (err) return { ok: false, error: err };

  const built = await buildFreeFileFromState();
  if (!built.ok) return { ok: false, error: built.error };
  const state = useAppStore.getState();
  if (built.result.history !== state.authorshipHistory) {
    useAppStore.setState({ authorshipHistory: built.result.history });
  }

  try {
    await profileIpc.saveProfile(savePath, built.result.file);
  } catch (e) {
    return { ok: false, error: `Save failed: ${e}` };
  }
  await applyPostSaveSideEffects(savePath);
  return { ok: true, path: savePath };
}
