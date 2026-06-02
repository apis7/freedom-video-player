import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";

/**
 * ⚠ AUDIO-REPLACE OVERLAY IS CURRENTLY DISABLED.
 *
 * The lavfi-complex graph we designed (asplit → atrim → asetpts → amix) is
 * blocked by amix's PTS-alignment behaviour: amix waits for ALL inputs to
 * produce a frame at the current output PTS before mixing. Our source
 * branches emit frames at SHIFTED PTS (1129s, 3314s, etc.), so at PTS=0
 * amix has no source frames and never advances. Audio drains, video stacks
 * up against the demuxer cap, and playback stutters / freezes on a white
 * screen.
 *
 * Until we redesign (likely: pre-pad source branches with anullsrc silence,
 * or pre-render replacement audio to a sidecar WAV, or move to a real
 * audio-overdub library), the runtime overlay is OFF. The Profile schema,
 * UI controls in SnipDetailPanel, and 5-second cap all stay — those edits
 * persist in `.free` so they're ready when the overlay works. The apply
 * engine falls back to Skip behavior (jump past the snip) for every
 * audio_replace snip.
 *
 * If a file already has an overlay applied from a previous session, this
 * hook clears it on mount so the user gets clean playback.
 */
export function useAudioReplaceOverlay() {
  const currentFile = useAppStore((s) => s.currentFile);

  // On file change (and on first mount), make sure any leftover lavfi-complex
  // graph is cleared and the audioOverlayActive flag is false. Then never
  // engage anything.
  useEffect(() => {
    if (!currentFile) return;
    let cancelled = false;
    void (async () => {
      try {
        await playback.clearAudioOverlay();
      } catch {
        // Swallow — file might not be loaded yet, or already clear.
      }
      if (!cancelled) {
        useAppStore.setState({ audioOverlayActive: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentFile]);
}

