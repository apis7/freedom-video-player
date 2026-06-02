import { useEffect, useRef } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";
import { recentlyNavigated } from "../utils/navGuard";
import { beepPlayer } from "../utils/beepPlayer";
import { MAX_BEEP_DURATION_MS } from "../ipc/types";
import type { Snip, SnipAction } from "../ipc/types";

// With event-driven position updates (useMpvEventBridge), state.position is
// now fresh at libmpv's frame cadence (~16ms). The remaining latency we need
// to compensate for is just the IPC round-trip on the action itself.
const LATENCY_BUDGET_MS = 20;
const FREEZE_LATENCY_MS = 80;

function actionPriority(a: SnipAction): number {
  switch (a.type) {
    case "skip":
      return 5;
    case "freeze_frame":
      return 4;
    case "silence":
      return 3;
    case "beep":
      return 2;
    case "audio_replace":
      return 1;
  }
}

/**
 * Apply Engine — rAF tick that watches the playhead (read straight from
 * state.position, which is push-updated by useMpvEventBridge) and applies
 * Skip / Silence / Freeze-frame at the right snip boundaries.
 *
 * Skip only fires while playing AND when the user isn't actively navigating.
 * Freeze pre-triggers with a larger lookahead so the screenshot capture
 * completes before the snip starts. Audio-replace is a no-op for now.
 */
export function useProfileApplication() {
  const ownership = useRef<{
    mutedByUs: boolean;
    lastSkipFromMs: number | null;
    freezeSnipId: string | null;
    prevPlaying: boolean;
    /** Track the currently-winning snip so we log enter/exit transitions
     *  exactly once (not on every rAF tick while inside the snip). */
    activeSnipId: string | null;
    /** When non-null, the Beep oscillator is running for this snip. We
     *  stop the oscillator + unmute libmpv when exiting the snip window. */
    beepSnipId: string | null;
  }>({
    mutedByUs: false,
    lastSkipFromMs: null,
    freezeSnipId: null,
    prevPlaying: false,
    activeSnipId: null,
    beepSnipId: null,
  });

  useEffect(() => {
    let frame = 0;

    const restore = async () => {
      const own = ownership.current;
      if (own.beepSnipId) {
        beepPlayer.stop();
        own.beepSnipId = null;
      }
      if (own.mutedByUs) {
        try { await playback.setMuted(false); } catch {}
        own.mutedByUs = false;
      }
      if (own.freezeSnipId) {
        useAppStore.setState({ freezeFrameSrc: null });
        own.freezeSnipId = null;
      }
      own.lastSkipFromMs = null;
      own.activeSnipId = null;
    };

    const tick = async () => {
      const state = useAppStore.getState();
      // state.position is push-fresh; no rAF projection / speed compensation
      // needed — what we read here is what libmpv reported on its last frame.
      const currentMs = state.position * 1000;
      const probeMs = currentMs + (state.playing ? LATENCY_BUDGET_MS : 0);
      const freezeProbeMs = currentMs + (state.playing ? FREEZE_LATENCY_MS : 0);

      const playingJustStarted = !ownership.current.prevPlaying && state.playing;
      const playingJustStopped = ownership.current.prevPlaying && !state.playing;
      ownership.current.prevPlaying = state.playing;
      if (playingJustStarted) {
        console.log(`[fvp:engine] ▶ PLAY at ${currentMs.toFixed(0)}ms`);
        ownership.current.lastSkipFromMs = null;
      }
      if (playingJustStopped) {
        console.log(`[fvp:engine] ⏸ PAUSE at ${currentMs.toFixed(0)}ms`);
      }


      if (!state.currentFile || !state.abToggleOn) {
        if (
          ownership.current.mutedByUs ||
          ownership.current.freezeSnipId ||
          ownership.current.lastSkipFromMs !== null
        ) {
          await restore();
        }
        frame = requestAnimationFrame(tick);
        return;
      }

      let activeSnips: Snip[] = [];
      if (state.mode === "creator") {
        activeSnips = state.snips;
      } else if (state.mode === "player") {
        for (const p of state.detectedProfiles) {
          if (p.active) activeSnips = activeSnips.concat(p.profile.payload.snips);
        }
      }

      // Freeze pre-trigger (larger lookahead for screenshot capture).
      if (activeSnips.length > 0) {
        const upcomingFreeze = activeSnips.find(
          (s) =>
            s.action.type === "freeze_frame" &&
            freezeProbeMs >= s.start_ms &&
            freezeProbeMs < s.end_ms,
        );
        const skipOverrides =
          upcomingFreeze &&
          activeSnips.some(
            (s) =>
              s.action.type === "skip" &&
              freezeProbeMs >= s.start_ms &&
              freezeProbeMs < s.end_ms,
          );
        if (
          upcomingFreeze &&
          !skipOverrides &&
          ownership.current.freezeSnipId !== upcomingFreeze.id
        ) {
          if (ownership.current.freezeSnipId) {
            useAppStore.setState({ freezeFrameSrc: null });
          }
          ownership.current.freezeSnipId = upcomingFreeze.id;
          const targetId = upcomingFreeze.id;
          playback
            .screenshot()
            .then((src) => {
              if (ownership.current.freezeSnipId === targetId) {
                useAppStore.setState({ freezeFrameSrc: src });
              }
            })
            .catch(() => {
              if (ownership.current.freezeSnipId === targetId) {
                ownership.current.freezeSnipId = null;
              }
            });
        }
      }

      if (activeSnips.length === 0) {
        if (
          ownership.current.mutedByUs ||
          ownership.current.freezeSnipId !== null
        ) {
          await restore();
        }
        frame = requestAnimationFrame(tick);
        return;
      }

      const containing = activeSnips.filter(
        (s) => probeMs >= s.start_ms && probeMs < s.end_ms,
      );

      if (containing.length === 0) {
        // Exit-snip transition.
        if (ownership.current.activeSnipId) {
          console.log(
            `[fvp:engine] ⬅ EXIT snip ${ownership.current.activeSnipId} at ${currentMs.toFixed(0)}ms`,
          );
          ownership.current.activeSnipId = null;
        }
        if (ownership.current.beepSnipId) {
          beepPlayer.stop();
          ownership.current.beepSnipId = null;
        }
        if (ownership.current.mutedByUs) {
          try { await playback.setMuted(false); } catch {}
          ownership.current.mutedByUs = false;
        }
        if (ownership.current.freezeSnipId) {
          const stillFreezing = activeSnips.some(
            (s) =>
              s.id === ownership.current.freezeSnipId &&
              freezeProbeMs >= s.start_ms &&
              freezeProbeMs < s.end_ms,
          );
          if (!stillFreezing) {
            useAppStore.setState({ freezeFrameSrc: null });
            ownership.current.freezeSnipId = null;
          }
        }
        ownership.current.lastSkipFromMs = null;
        frame = requestAnimationFrame(tick);
        return;
      }

      const winner = containing.reduce((best, s) =>
        actionPriority(s.action) > actionPriority(best.action) ? s : best,
      );

      // Enter-snip / winner-change transition: log exactly once per change
      // with a clear description of what's happening to VIDEO and AUDIO.
      if (ownership.current.activeSnipId !== winner.id) {
        const prev = ownership.current.activeSnipId;
        const a = winner.action;
        const len = winner.end_ms - winner.start_ms;
        const head = `[fvp:engine] ➡ ENTER snip ${winner.id} at ${currentMs.toFixed(0)}ms ` +
          `[${winner.start_ms}-${winner.end_ms}ms, ${len}ms, action=${a.type}]`;
        let what: string;
        switch (a.type) {
          case "skip":
            what = "VIDEO: jump past to end • AUDIO: skipped along with video";
            break;
          case "silence":
            what = "VIDEO: plays through normally • AUDIO: muted for duration";
            break;
          case "freeze_frame":
            what = "VIDEO: hold last frame as still image • AUDIO: plays through normally";
            break;
          case "audio_replace":
            if (state.audioOverlayActive) {
              what =
                `VIDEO: plays through normally • AUDIO: libmpv overlay crossfade ` +
                `(from_${a.from_before ? "before" : "after"}, offset=${a.offset_ms}ms, xfade=${a.crossfade_ms}ms)`;
            } else {
              what = "VIDEO: jump past to end (overlay off — Skip fallback) • AUDIO: skipped along with video";
            }
            break;
          case "beep":
            what =
              `VIDEO: plays through normally • AUDIO: muted + ${a.freq_hz}Hz sine ` +
              `overlay @ ${a.level_db}dB (capped at ${MAX_BEEP_DURATION_MS}ms if snip is longer)`;
            break;
        }
        console.log(`${head}\n            ${what}${prev ? ` (was in snip ${prev})` : ""}`);
        ownership.current.activeSnipId = winner.id;
      }

      // ── Skip ──
      if (winner.action.type === "skip") {
        // Stop any active beep — skip jumps past, no audio overlay needed.
        if (ownership.current.beepSnipId) {
          beepPlayer.stop();
          ownership.current.beepSnipId = null;
        }
        if (state.playing && !recentlyNavigated()) {
          const skips = containing.filter((s) => s.action.type === "skip");
          const endMs = Math.max(...skips.map((s) => s.end_ms));
          const skipStart = Math.min(...skips.map((s) => s.start_ms));
          if (ownership.current.lastSkipFromMs !== skipStart) {
            console.log(
              `[fvp:engine] 🎬 SKIP fired: seek ${currentMs.toFixed(0)}ms → ${endMs}ms ` +
                `(jumped ${(endMs - currentMs).toFixed(0)}ms forward)`,
            );
            try { await playback.seek(endMs / 1000); } catch {}
            ownership.current.lastSkipFromMs = skipStart;
          }
        }
        if (ownership.current.mutedByUs) {
          try { await playback.setMuted(false); } catch {}
          ownership.current.mutedByUs = false;
        }
        if (ownership.current.freezeSnipId) {
          useAppStore.setState({ freezeFrameSrc: null });
          ownership.current.freezeSnipId = null;
        }
        frame = requestAnimationFrame(tick);
        return;
      }

      ownership.current.lastSkipFromMs = null;

      // ── Freeze-frame (winner) ──
      if (winner.action.type === "freeze_frame") {
        if (ownership.current.freezeSnipId !== winner.id) {
          if (ownership.current.freezeSnipId) {
            useAppStore.setState({ freezeFrameSrc: null });
          }
          ownership.current.freezeSnipId = winner.id;
          const targetId = winner.id;
          console.log(
            `[fvp:engine] 🖼 FREEZE fired: capturing screenshot for snip ${winner.id}`,
          );
          try {
            const src = await playback.screenshot();
            if (ownership.current.freezeSnipId === targetId) {
              useAppStore.setState({ freezeFrameSrc: src });
              console.log(`[fvp:engine] 🖼 FREEZE active: still image displayed`);
            }
          } catch (err) {
            console.warn(`[fvp:engine] 🖼 FREEZE screenshot failed:`, err);
            ownership.current.freezeSnipId = null;
          }
        }
        if (ownership.current.mutedByUs) {
          try { await playback.setMuted(false); } catch {}
          ownership.current.mutedByUs = false;
        }
        frame = requestAnimationFrame(tick);
        return;
      }

      if (ownership.current.freezeSnipId) {
        const stillFreezing = activeSnips.some(
          (s) =>
            s.id === ownership.current.freezeSnipId &&
            freezeProbeMs >= s.start_ms &&
            freezeProbeMs < s.end_ms,
        );
        if (!stillFreezing) {
          useAppStore.setState({ freezeFrameSrc: null });
          ownership.current.freezeSnipId = null;
        }
      }

      // ── Silence ──
      if (winner.action.type === "silence") {
        // Stop any active beep — silence overrides beep.
        if (ownership.current.beepSnipId) {
          beepPlayer.stop();
          ownership.current.beepSnipId = null;
        }
        if (!state.muted && !ownership.current.mutedByUs) {
          console.log(
            `[fvp:engine] 🔇 SILENCE fired: muting libmpv (will unmute on snip exit)`,
          );
          try {
            await playback.setMuted(true);
            ownership.current.mutedByUs = true;
          } catch {}
        }
        frame = requestAnimationFrame(tick);
        return;
      }

      // ── Beep ──
      // Mute libmpv's audio for the snip window and overlay a sine tone via
      // Web Audio. Apply-engine enforces the 3s cap as a safety net (UI
      // already shortens long snips on action change, but a profile loaded
      // from disk might somehow contain a longer Beep snip).
      //
      // Beep only plays while ACTIVELY PLAYING. If the user is paused — or
      // selects a snip in the list (which auto-seeks the playhead into the
      // snip window) — we stay silent. Beep also stops on pause and resumes
      // on play if the playhead is still inside the snip window.
      if (winner.action.type === "beep") {
        const beepEnd = Math.min(
          winner.end_ms,
          winner.start_ms + MAX_BEEP_DURATION_MS,
        );
        const inWindow = currentMs >= winner.start_ms && currentMs < beepEnd;
        const shouldBeep = inWindow && state.playing;

        if (shouldBeep) {
          if (!state.muted && !ownership.current.mutedByUs) {
            try {
              await playback.setMuted(true);
              ownership.current.mutedByUs = true;
            } catch {}
          }
          if (ownership.current.beepSnipId !== winner.id) {
            console.log(
              `[fvp:engine] 🔔 BEEP fired: ${winner.action.freq_hz}Hz @ ${winner.action.level_db}dB for snip ${winner.id}`,
            );
            beepPlayer.start(winner.action.freq_hz, winner.action.level_db);
            ownership.current.beepSnipId = winner.id;
          } else {
            // Same snip but settings may have changed (live tuning in
            // Creator) — push updates to the running oscillator.
            beepPlayer.start(winner.action.freq_hz, winner.action.level_db);
          }
        } else {
          // Paused, past beep end, or outside the snip — release everything.
          if (ownership.current.beepSnipId) {
            beepPlayer.stop();
            ownership.current.beepSnipId = null;
          }
          if (ownership.current.mutedByUs) {
            try { await playback.setMuted(false); } catch {}
            ownership.current.mutedByUs = false;
          }
        }
        frame = requestAnimationFrame(tick);
        return;
      }

      // Winner is not a beep snip — make sure no leftover beep is running.
      if (ownership.current.beepSnipId) {
        beepPlayer.stop();
        ownership.current.beepSnipId = null;
      }

      // ── Audio-replace ──
      // When the libmpv lavfi-complex overlay is engaged (Player Mode with
      // an active profile, or Creator with AB-toggle ON), libmpv is already
      // crossfading source audio over the snip window — we just keep our
      // hands off. When the overlay is NOT engaged, fall back to Skip: jump
      // past the snip so offensive audio isn't heard. The snip's direction /
      // offset / crossfade settings persist in the .free file either way.
      if (winner.action.type === "audio_replace") {
        if (!state.audioOverlayActive) {
          if (state.playing && !recentlyNavigated()) {
            if (ownership.current.lastSkipFromMs !== winner.start_ms) {
              console.log(
                `[fvp:engine] 🔁 AUDIO-REPLACE (overlay off — Skip fallback) fired: ` +
                  `seek ${currentMs.toFixed(0)}ms → ${winner.end_ms}ms`,
              );
              try { await playback.seek(winner.end_ms / 1000); } catch {}
              ownership.current.lastSkipFromMs = winner.start_ms;
            }
          }
        }
        if (ownership.current.mutedByUs) {
          try { await playback.setMuted(false); } catch {}
          ownership.current.mutedByUs = false;
        }
        frame = requestAnimationFrame(tick);
        return;
      }

      if (ownership.current.mutedByUs) {
        try { await playback.setMuted(false); } catch {}
        ownership.current.mutedByUs = false;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      void restore();
    };
  }, []);
}
