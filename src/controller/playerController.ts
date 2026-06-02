import { useAppStore } from "../state/appStore";
import { playback, fvpWindow } from "../ipc";

/**
 * Shared playback actions — single source of truth for what the transport bar,
 * hotkeys, and right-click menu all invoke. Each action updates the store
 * after a successful IPC call.
 */
export const playerController = {
  async togglePause() {
    // Spacebar / generic play-pause always normalises to FORWARD direction.
    // If reverse playback was active, this both flips direction and plays
    // — matching the user's expectation that Space "just plays".
    try {
      const s = useAppStore.getState();
      if (s.playDirection !== "forward") {
        await playback.setPlayDirection("forward");
        useAppStore.setState({ playDirection: "forward" });
        // After switching direction while paused, play. After switching while
        // playing-backward, also play (forward) — net effect: Space is "play
        // forward" unless we were already going forward, in which case toggle.
        if (!s.playing) {
          await playback.play();
          useAppStore.setState({ playing: true });
        }
        return;
      }
      const nowPlaying = await playback.togglePause();
      useAppStore.setState({ playing: nowPlaying });
    } catch (err) {
      console.error("togglePause:", err);
    }
  },

  /** Click-toggle for the play-forward button in Creator. If already playing
   *  forward, this pauses. Otherwise, ensures forward direction and plays. */
  async playForwardToggle() {
    try {
      const s = useAppStore.getState();
      if (s.playing && s.playDirection === "forward") {
        await playback.pause();
        useAppStore.setState({ playing: false });
        return;
      }
      if (s.playDirection !== "forward") {
        await playback.setPlayDirection("forward");
        useAppStore.setState({ playDirection: "forward" });
      }
      await playback.play();
      useAppStore.setState({ playing: true });
    } catch (err) {
      console.error("playForwardToggle:", err);
    }
  },

  /** Click-toggle for the play-backward button in Creator. If already playing
   *  backward, this pauses. Otherwise, ensures backward direction and plays.
   *  NOTE: libmpv reverse playback is CPU-heavy and best for short bursts. */
  async playBackwardToggle() {
    try {
      const s = useAppStore.getState();
      if (s.playing && s.playDirection === "backward") {
        await playback.pause();
        useAppStore.setState({ playing: false });
        return;
      }
      if (s.playDirection !== "backward") {
        await playback.setPlayDirection("backward");
        useAppStore.setState({ playDirection: "backward" });
      }
      await playback.play();
      useAppStore.setState({ playing: true });
    } catch (err) {
      console.error("playBackwardToggle:", err);
    }
  },

  async stop() {
    try {
      await playback.seek(0);
      await playback.pause();
      useAppStore.setState({ playing: false, position: 0 });
    } catch (err) {
      console.error("stop:", err);
    }
  },

  async toggleMute() {
    const next = !useAppStore.getState().muted;
    useAppStore.setState({ muted: next });
    try {
      await playback.setMuted(next);
    } catch (err) {
      console.error("toggleMute:", err);
    }
  },

  async toggleFullscreen() {
    const next = !useAppStore.getState().fullscreen;
    try {
      await fvpWindow.setFullscreen(next);
      useAppStore.setState({ fullscreen: next });
      // Going INTO fullscreen is a moment-of-truth event — same as
      // hitting play. Re-check the safety banner so the user is
      // reminded that snips aren't on (if they aren't).
      if (next) {
        void import("../utils/safetyBanner").then(
          ({ evaluateSafetyBanner }) => evaluateSafetyBanner(),
        );
      }
    } catch (err) {
      console.error("toggleFullscreen:", err);
    }
  },

  async setVolume(volume: number) {
    const v = Math.max(0, Math.min(125, volume));
    useAppStore.setState({ volume: v, muted: false });
    try {
      await playback.setVolume(v);
    } catch (err) {
      console.error("setVolume:", err);
    }
  },

  async seekTo(seconds: number) {
    try {
      await playback.seek(Math.max(0, seconds));
    } catch (err) {
      console.error("seekTo:", err);
    }
  },

  async seekRelative(deltaSeconds: number) {
    const state = useAppStore.getState();
    if (!state.currentFile) return;
    const target = Math.max(0, Math.min(state.duration || Number.MAX_SAFE_INTEGER, state.position + deltaSeconds));
    return this.seekTo(target);
  },

  async frameStepForward() {
    try {
      await playback.frameStepForward();
    } catch (err) {
      console.error("frameStepForward:", err);
    }
  },

  async frameStepBack() {
    try {
      await playback.frameStepBack();
    } catch (err) {
      console.error("frameStepBack:", err);
    }
  },
};
