import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/appStore";
import { subtitlesIpc } from "../ipc";

const SUBTITLE_EXTENSIONS = ["srt", "vtt", "ass", "ssa", "sub", "txt"];

/** Strip the trailing filename + separator from a path. Falls back
 *  to `undefined` when the input is null / empty / has no separator
 *  — Tauri's dialog API treats `undefined` defaultPath as "use the
 *  OS default", which is the desired behavior in that edge case. */
export function parentDirOf(path: string | null): string | undefined {
  if (!path) return undefined;
  const lastSep = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  if (lastSep <= 0) return undefined;
  return path.slice(0, lastSep);
}

/** Open the file picker filtered to subtitle formats; load whatever the user
 *  chooses via libmpv's sub-add command. Surfaces success/failure via toast. */
export async function addSubtitleFlow(): Promise<void> {
  if (!useAppStore.getState().currentFile) {
    useAppStore.getState().showToast(
      "Open a video first — then add a subtitle file for it.",
      "warn",
      6000,
    );
    return;
  }
  const picked = await open({
    multiple: false,
    // Default the picker to the video's own directory so the user
    // doesn't have to navigate every time they pick a sub file.
    defaultPath: parentDirOf(useAppStore.getState().currentFile),
    filters: [
      { name: "Subtitles", extensions: SUBTITLE_EXTENSIONS },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (typeof picked !== "string" || picked.length === 0) return;

  try {
    await subtitlesIpc.add(picked);
    const filename = picked.split(/[\\/]/).pop() ?? picked;
    useAppStore
      .getState()
      .showToast(`Added subtitle: ${filename}`, "info", 4000);
    await refreshSubtitleTracks();
    // Parse the file's entries so the Profile Creator's Subs row can render them.
    try {
      const entries = await subtitlesIpc.parseFile(picked);
      useAppStore.setState({ subtitleEntries: entries });
    } catch {
      // Non-fatal — entries just won't show on the timeline.
    }
  } catch (err) {
    useAppStore
      .getState()
      .showToast(`Failed to add subtitle:\n${err}`, "error", 8000);
  }
}

/** Re-query libmpv for the current subtitle track list + visibility flag.
 *  Also refreshes audio + video track lists + deinterlace state (Track menus
 *  read from the same store fields).
 *  If the currently-selected sub track is EMBEDDED, spawn a background
 *  extraction to populate subtitleEntries. */
export async function refreshSubtitleTracks(): Promise<void> {
  try {
    const [tracks, visible] = await Promise.all([
      subtitlesIpc.tracks(),
      subtitlesIpc.getVisibility(),
    ]);
    useAppStore.setState({ subtitleTracks: tracks, subtitleVisible: visible });

    const selected = tracks.find((t) => t.selected);
    if (selected) {
      if (selected.external && selected.external_filename) {
        // mpv autoloaded an external .srt next to the video — parse it
        // so the Creator subs row gets cue blocks. Without this, the
        // movie plays with subs but the Creator timeline shows
        // "No subtitles loaded" and autosnip / Search-and-Flag have
        // nothing to scan.
        await parseAndStoreExternal(selected.external_filename);
      } else if (!selected.external) {
        await extractAndStoreEmbedded(selected.id);
      }
    }
  } catch {
    useAppStore.setState({ subtitleTracks: [] });
  }
  void refreshTracks();
}

/** Refresh audio + video track lists, audio device list, and deinterlace
 *  state — kept separate so menus can refresh them after track-set calls
 *  without re-extracting subs. */
export async function refreshTracks(): Promise<void> {
  try {
    const { tracksIpc } = await import("../ipc");
    const [audio, video, devices, deint] = await Promise.all([
      tracksIpc.audio(),
      tracksIpc.video(),
      tracksIpc.audioDevices(),
      tracksIpc.getDeinterlace(),
    ]);
    useAppStore.setState({
      audioTracks: audio,
      videoTracks: video,
      audioDevices: devices,
      deinterlaceOn: deint,
    });
  } catch {
    // No file or libmpv not ready.
  }
}

/** Parse an autoloaded external sub file and store its entries.
 *  Idempotent — skips when subtitleEntries is already populated
 *  (avoids re-parsing on every refreshSubtitleTracks call). */
async function parseAndStoreExternal(path: string): Promise<void> {
  if (useAppStore.getState().subtitleEntries.length > 0) return;
  const videoPath = useAppStore.getState().currentFile;
  if (!videoPath) return;
  try {
    const entries = await subtitlesIpc.parseFile(path);
    // Guard against the file having changed during the async parse.
    if (useAppStore.getState().currentFile !== videoPath) return;
    useAppStore.setState({ subtitleEntries: entries });
  } catch {
    // Non-fatal — entries just won't show on the timeline.
  }
}

/** Spawn a backend extraction for the named embedded sub track, then store
 *  the resulting entries. Sets `extractingSubtitles` true while running so
 *  the Subs row shows a pulsing indicator (visible feedback that something's
 *  happening). Toast-driven progress for the macro updates. */
async function extractAndStoreEmbedded(trackId: number): Promise<void> {
  const videoPath = useAppStore.getState().currentFile;
  if (!videoPath) return;
  if (useAppStore.getState().subtitleEntries.length > 0) return;
  if (useAppStore.getState().extractingSubtitles) return; // already running

  const showToast = useAppStore.getState().showToast;
  useAppStore.setState({ extractingSubtitles: true });
  showToast(
    "Extracting embedded subtitles… (this can take a few seconds for long videos)",
    "info",
    6000,
  );
  try {
    const entries = await subtitlesIpc.extractEmbedded(videoPath, trackId);
    if (useAppStore.getState().currentFile !== videoPath) return;
    useAppStore.setState({ subtitleEntries: entries });
    if (entries.length > 0) {
      showToast(
        `Loaded ${entries.length} subtitle entries from embedded track ${trackId}.`,
        "info",
        4000,
      );
    } else {
      showToast(
        "Embedded subtitle track is empty (or scan returned nothing).",
        "warn",
        5000,
      );
    }
  } catch (err) {
    showToast(`Embedded subtitle extraction failed: ${err}`, "error", 8000);
  } finally {
    useAppStore.setState({ extractingSubtitles: false });
  }
}
