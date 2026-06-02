import { open } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../state/appStore";
import { playback, profileIpc } from "../ipc";
import { loadDraftForFile } from "../hooks/useAutosaveDraft";
import { hasUnsavedWork, confirmDiscardUnsaved } from "./unsavedWork";
import { refreshSubtitleTracks } from "./addSubtitleFlow";
import { pushRecentFile } from "./recentFiles";

const VIDEO_EXTENSIONS = [
  "mkv", "mp4", "avi", "mov", "m4v", "webm", "wmv", "flv", "mpg", "mpeg", "ts", "m2ts",
];
const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac"];
const LOADING_FALLBACK_MS = 4000;
const LOADING_TIMEOUT_MS = 10_000;

// Module-level gate so rapid double-clicks of "Open file" don't fire two
// dialogs / two concurrent libmpv opens.
let openInProgress = false;

export async function openFileFlow(): Promise<void> {
  if (openInProgress) return;
  openInProgress = true;
  try {
    if (hasUnsavedWork()) {
      if (!confirmDiscardUnsaved("Opening another file")) return;
    }

    const selected = await open({
      multiple: false,
      filters: [
        { name: "Video", extensions: VIDEO_EXTENSIONS },
        { name: "Audio", extensions: AUDIO_EXTENSIONS },
        { name: "FVP Profile", extensions: ["free"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof selected !== "string" || selected.length === 0) return;

    // .free files route through the resolve-then-load helper instead of
    // straight-to-libmpv — a profile by itself is meaningless without a
    // video to apply it to.
    if (selected.toLowerCase().endsWith(".free")) {
      await openFreeFile(selected);
      return;
    }

    await openVideoPath(selected);
  } finally {
    openInProgress = false;
  }
}

/**
 * Load a `.free` profile, then open the video it was authored against.
 *
 * Resolution order for the video:
 *   1. Same folder as the .free, filename from `payload.fingerprint.filename`
 *   2. Failing that, prompt the user with a file picker — they must
 *      select a video for the profile to apply to. A profile is
 *      worthless on its own; we never silently no-op.
 *
 * The video, once opened, fires the normal profile-scan path which will
 * detect the .free and auto-activate it (if the fingerprint matches).
 *
 * Used by both the cli-open-file event (file association) and the
 * "Open file…" dialog when the user picks a .free directly.
 */
export async function openFreeFile(freePath: string): Promise<void> {
  console.log(`[fvp:open] openFreeFile: ${freePath}`);

  // Step 1: load the profile.
  let profile;
  try {
    profile = await profileIpc.loadProfile(freePath);
  } catch (err) {
    alert(
      `Could not read the profile file:\n\n${freePath}\n\nError: ${err}\n\n` +
        `The file may be corrupted or saved by an incompatible version of FVP.`,
    );
    return;
  }

  // Step 2: try to find the associated video next to the .free.
  const freeDir = freePath.replace(/[\\/][^\\/]+$/, "");
  const declaredFilename = profile.payload.fingerprint.filename;
  const sep = freePath.includes("\\") ? "\\" : "/";
  let videoPath: string | null = null;

  if (declaredFilename && declaredFilename.length > 0) {
    const candidate = `${freeDir}${sep}${declaredFilename}`;
    try {
      const exists = await profileIpc.fileExists(candidate);
      if (exists) {
        console.log(`[fvp:open] resolved video next to .free: ${candidate}`);
        videoPath = candidate;
      } else {
        console.log(
          `[fvp:open] declared filename "${declaredFilename}" not found in ${freeDir} — will prompt user`,
        );
      }
    } catch {
      // file_exists shouldn't throw — fall through to prompt.
    }
  }

  // Step 3: prompt for video if not auto-resolved.
  if (!videoPath) {
    const profileName = profile.payload.metadata.name || "(unnamed)";
    const declared = declaredFilename || "(unknown filename)";
    alert(
      `Profile "${profileName}" loaded — but its video isn't where the profile expected.\n\n` +
        `Expected next to the profile:\n  ${declared}\n\n` +
        `Pick the video file the profile should apply to.`,
    );
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Video", extensions: VIDEO_EXTENSIONS },
        { name: "Audio", extensions: AUDIO_EXTENSIONS },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof picked !== "string" || picked.length === 0) {
      // User cancelled — leave the app in whatever state it was in.
      console.log("[fvp:open] user cancelled video picker for .free");
      return;
    }
    if (picked.toLowerCase().endsWith(".free")) {
      alert("That's another profile file. Please pick a video.");
      return;
    }
    videoPath = picked;
  }

  // Step 4: open the video. The normal scan-folder flow inside
  // openVideoPath will find the .free and auto-detect it. If the user
  // picked a video from a DIFFERENT folder than the .free, the scanner
  // won't find this .free — but the user can re-export from Creator
  // mode if they want a sidecar at the new location.
  await openVideoPath(videoPath);
}

/**
 * Shared open-file routine used by both the Open File dialog and drag-drop.
 * Clears per-file state, kicks libmpv, schedules the load-timeout prompt,
 * then restores draft + scans for .free profiles.
 */
export async function openVideoPath(selected: string): Promise<void> {
  console.log(`[fvp:open] openVideoPath: ${selected}`);
  // Reset fingerprint cache — we'll recompute for the new file below.
  useAppStore.setState({ currentFileFingerprint: null });
  useAppStore.setState({
    loading: true,
    loadingTimedOut: false,
    autosaveErrorShown: false,
    detectedProfiles: [],
    snips: [],
    selectedSnipId: null,
    selectedSnipIds: [],
    activeSnipEdge: null,
    snipLanes: {},
    markers: [],
    flags: [],
    past: [],
    future: [],
    skipThatPendingStartMs: null,
    skipThatTrayActiveAt: null,
    freezeFrameSrc: null,
    subtitleTracks: [],
    subtitleEntries: [],
    audioTracks: [],
    videoTracks: [],
    deinterlaceOn: false,
    imdbUrl: null,
    groups: [],
    authorshipHistory: [],
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
  // Clear any aspect override from a previous file before the new file
  // gets a chance to set its own (or fall back to native).
  void playback.setAspectRatio("").catch(() => {});

  // Load timeout: if `loading` is still true after LOADING_TIMEOUT_MS, ask
  // the user whether to keep waiting or cancel. Fires once per open.
  const timeoutTimer = setTimeout(() => {
    const s = useAppStore.getState();
    if (s.loading && s.currentFile === selected) {
      useAppStore.setState({ loadingTimedOut: true });
    }
  }, LOADING_TIMEOUT_MS);

  try {
    await playback.openFile(selected);
    useAppStore.setState({ currentFile: selected, playing: true });
    pushRecentFile(selected);
    setTimeout(() => {
      // Belt-and-suspenders — clear loading if no event fired by now.
      if (useAppStore.getState().currentFile === selected) {
        useAppStore.setState({ loading: false });
      }
    }, LOADING_FALLBACK_MS);

    // Subtitle tracks aren't available immediately — give libmpv a beat to
    // demux, then snapshot what's there.
    setTimeout(() => {
      if (useAppStore.getState().currentFile === selected) {
        void refreshSubtitleTracks();
      }
    }, 1500);

    // Restore saved draft (precedence over auto-loading a detected .free).
    void loadDraftForFile(selected).then((draft) => {
      if (!draft) return;
      if (useAppStore.getState().currentFile !== selected) return;
      applyDraft(draft, selected);
    });

    // Compute fingerprint in background and cache on the store so the
    // autosave can embed it in the `.fvp-autosave.free` sidecar.
    void (async () => {
      try {
        const fp = await profileIpc.computeFingerprint(selected);
        if (useAppStore.getState().currentFile === selected) {
          useAppStore.setState({ currentFileFingerprint: fp });
          console.log(
            `[fvp:open] fingerprint cached (duration_ms=${fp.duration_ms}, size=${fp.size_bytes}, phash_samples=${fp.phash_samples.length})`,
          );
        }
      } catch (err) {
        console.warn("[fvp:open] computeFingerprint failed:", err);
      }
    })();

    void (async () => {
      try {
        const matches = await profileIpc.scanFolderForProfiles(selected);
        const detected = matches.map((m) => ({
          ...m,
          active: m.score.quality === "exact",
        }));
        const activeCount = detected.filter((d) => d.active).length;
        console.log(
          `[fvp:open] profile scan returned ${matches.length} match(es), ` +
            `${activeCount} auto-active (exact). Detected:`,
          detected.map((d) => ({
            path: d.path,
            quality: d.score.quality,
            snips: d.profile.payload.snips.length,
            active: d.active,
          })),
        );
        if (useAppStore.getState().currentFile === selected) {
          useAppStore.setState({ detectedProfiles: detected });
          // Now that scan finished, evaluate whether to surface the
          // safety banner. Triggered AFTER scan so detectedProfiles
          // reflects reality.
          const { evaluateSafetyBanner } = await import("./safetyBanner");
          evaluateSafetyBanner();
        }
      } catch (err) {
        console.error("[fvp:open] scan_folder_for_profiles FAILED:", err);
      }
    })();
  } catch (err) {
    useAppStore.setState({ loading: false, loadingTimedOut: false });
    console.error("openFile failed:", err);
    alert(`Failed to open file:\n${err}`);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/** Apply a loaded draft to the store, warning if any snip extends past
 *  the current video's duration (likely a fingerprint mismatch). */
function applyDraft(
  draft: import("../hooks/useAutosaveDraft").DraftFile,
  selected: string,
): void {
  // Pull groups + imdbUrl + authorship history from the wrapped FreeFile
  // when present (new `.fvp-autosave.free` format). Legacy
  // `.fvp-draft.json` files don't carry those, so we leave them at
  // defaults in that case.
  const groups = draft.freeFile?.payload.groups ?? [];
  const meta = draft.freeFile?.payload.metadata;
  const imdbUrl = meta?.imdb_url ?? null;
  const authorshipHistory = draft.freeFile?.payload.authorship_history ?? [];
  const aspectRatio = meta?.aspect_ratio ?? "";
  useAppStore.setState({
    snips: draft.snips,
    markers: draft.markers,
    snipLanes: draft.snipLanes,
    customCategories: draft.customCategories,
    groups,
    imdbUrl,
    authorshipHistory,
    aspectRatio,
    movieTitle: meta?.movie_title ?? null,
    movieYear: meta?.movie_year ?? null,
    mapsFiltered: meta?.maps_filtered ?? null,
    mapsUnfiltered: meta?.maps_unfiltered ?? null,
    movieDirector: meta?.movie_director ?? null,
    movieStars: meta?.movie_stars ?? [],
    moviePlot: meta?.movie_plot ?? null,
    imdbRating: meta?.imdb_rating ?? null,
    imdbId: meta?.imdb_id ?? null,
    selectedSnipId: null,
    selectedSnipIds: [],
    past: [],
    future: [],
  });
  // Push the aspect override to libmpv. Empty string clears (uses native).
  if (aspectRatio.length > 0) {
    void playback.setAspectRatio(aspectRatio).catch(() => {});
  }

  // Defer the out-of-bounds check until libmpv has reported duration.
  const start = Date.now();
  const check = () => {
    if (useAppStore.getState().currentFile !== selected) return;
    const dur = useAppStore.getState().duration;
    if (dur > 0) {
      const limitMs = dur * 1000;
      const outOfBounds = draft.snips.filter((s) => s.end_ms > limitMs + 50).length;
      if (outOfBounds > 0) {
        useAppStore
          .getState()
          .showToast(
            `Restored draft has ${outOfBounds} snip${outOfBounds === 1 ? "" : "s"} ` +
              `past this video's duration. Was the draft made against a different cut?`,
            "warn",
            10_000,
          );
      }
      return;
    }
    if (Date.now() - start > 15_000) return; // give up
    setTimeout(check, 250);
  };
  setTimeout(check, 500);
}
