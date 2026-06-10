import { useEffect, useRef } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";
import type { Snip } from "../ipc/types";

/**
 * Engages the libmpv lavfi-complex overlay for **Remove-Dialogue** and
 * **Audio-Blur** snips.
 *
 * Background — what's enabled vs. what's not (v1):
 *   - **audio_replace** is currently a Skip fallback (the apply engine
 *     jumps past the snip). The PTS-alignment problem in our original
 *     amix design isn't solved yet; until it is, audio_replace snips
 *     don't engage the overlay. THIS HOOK SKIPS PROFILES WHOSE SNIPS
 *     INCLUDE audio_replace so we don't ship a half-working graph.
 *   - **mute_dialogue / audio_blur** DO work — they derive entirely
 *     from the main audio stream with no shifted PTS. Backend
 *     audio_filter::build produces a graph that gates the main
 *     branch and crossfades to processed effect branches across the
 *     snip windows.
 *
 * Behavior:
 *   - On currentFile change: clears any leftover graph, resets
 *     audioOverlayActive=false.
 *   - On snips OR currentFile OR duration change (debounced): if the
 *     active set contains at least one mute_dialogue / audio_blur snip
 *     AND no audio_replace snips, call apply_audio_overlay. Backend
 *     builds + applies the graph; we set audioOverlayActive=true on
 *     success so useProfileApplication knows to NOT use the silence
 *     fallback.
 *   - On unmount / file unload: clear.
 *
 * The previous version of this hook unconditionally cleared on every
 * file open and NEVER re-engaged — that's the root cause of the
 * reported "Remove Dialogue / Audio Blur just silence" bug.
 */
export function useAudioReplaceOverlay() {
  const currentFile = useAppStore((s) => s.currentFile);
  const snips = useAppStore((s) => s.snips);
  const duration = useAppStore((s) => s.duration);
  const applyTimerRef = useRef<number | null>(null);

  // 1. On file change: clear, then schedule a fresh apply attempt
  //    once snips have settled.
  useEffect(() => {
    if (!currentFile) {
      void playback
        .clearAudioOverlay()
        .catch(() => {});
      useAppStore.setState({ audioOverlayActive: false });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await playback.clearAudioOverlay();
        if (!cancelled) {
          useAppStore.setState({ audioOverlayActive: false });
        }
      } catch {
        /* file might not be loaded yet — apply step below will retry */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentFile]);

  // 2. On snips/duration change: debounce, then build + apply the
  //    effect graph if applicable. Debounce prevents reload-thrashing
  //    while the user is dragging a snip edge.
  useEffect(() => {
    if (!currentFile || duration <= 0) return;
    if (applyTimerRef.current != null) {
      window.clearTimeout(applyTimerRef.current);
    }
    applyTimerRef.current = window.setTimeout(() => {
      void applyOrClear(snips, duration);
    }, 350);
    return () => {
      if (applyTimerRef.current != null) {
        window.clearTimeout(applyTimerRef.current);
        applyTimerRef.current = null;
      }
    };
  }, [currentFile, snips, duration]);
}

async function applyOrClear(snips: Snip[], durationSec: number): Promise<void> {
  const hasAudioReplace = snips.some((s) => s.action.type === "audio_replace");
  const hasEffect = snips.some(
    (s) =>
      s.action.type === "mute_dialogue" || s.action.type === "audio_blur",
  );

  // V1 limitation: if a profile mixes audio_replace WITH mute/blur,
  // the audio_replace path wins on the backend (and is currently a
  // Skip fallback). Don't engage the overlay at all in that case —
  // engine's silence fallback handles the mute/blur snips.
  if (hasAudioReplace) {
    try {
      await playback.clearAudioOverlay();
    } catch {
      /* swallow */
    }
    useAppStore.setState({ audioOverlayActive: false });
    return;
  }

  if (!hasEffect) {
    try {
      await playback.clearAudioOverlay();
    } catch {
      /* swallow */
    }
    useAppStore.setState({ audioOverlayActive: false });
    return;
  }

  const fileDurationMs = Math.max(1, Math.round(durationSec * 1000));
  try {
    const applied = await playback.applyAudioOverlay(snips, fileDurationMs);
    useAppStore.setState({ audioOverlayActive: applied });
    if (applied) {
      console.log(
        `[fvp:overlay] effect-filter overlay ENGAGED (snips=${snips.length} duration=${fileDurationMs}ms)`,
      );
    } else {
      console.log(
        "[fvp:overlay] effect-filter overlay declined to engage (no usable snips after backend validation)",
      );
    }
  } catch (err) {
    console.log(`[fvp:overlay] apply failed: ${err}`);
    useAppStore.setState({ audioOverlayActive: false });
  }
}
