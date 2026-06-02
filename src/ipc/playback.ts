import { invoke } from "@tauri-apps/api/core";
import type { Snip } from "./types";

export interface PlayerState {
  position: number;
  duration: number;
  paused: boolean;
  volume: number;
  muted: boolean;
  has_file: boolean;
  speed: number;
}

export const playback = {
  openFile: (path: string) => invoke<void>("open_file", { path }),
  play: () => invoke<void>("play"),
  pause: () => invoke<void>("pause"),
  togglePause: () => invoke<boolean>("toggle_pause"),
  setPlayDirection: (direction: "forward" | "backward") =>
    invoke<void>("set_play_direction", { direction }),
  getPlayDirection: () => invoke<"forward" | "backward">("get_play_direction"),
  /** Override video aspect ratio. Pass empty string to clear (use native). */
  setAspectRatio: (value: string) =>
    invoke<void>("set_aspect_ratio", { value }),
  setVolume: (volume: number) => invoke<void>("set_volume", { volume }),
  setMuted: (muted: boolean) => invoke<void>("set_muted", { muted }),
  setSpeed: (rate: number) => invoke<void>("set_speed", { rate }),
  seek: (seconds: number) => invoke<void>("seek", { seconds }),
  frameStepForward: () => invoke<void>("frame_step_forward"),
  frameStepBack: () => invoke<void>("frame_step_back"),
  stop: () => invoke<void>("stop"),
  screenshot: () => invoke<string>("screenshot"),
  getState: () => invoke<PlayerState>("get_state"),

  /** Build & apply the audio-replace overlay graph from the supplied snips.
   *  Triggers a file reload behind the scenes. Resolves to `true` if a graph
   *  was actually applied, `false` if there was nothing to apply (cleared). */
  applyAudioOverlay: (snips: Snip[], fileDurationMs: number) =>
    invoke<boolean>("apply_audio_overlay", {
      snips,
      fileDurationMs,
    }),

  /** Tear down the overlay without rebuilding from snips. */
  clearAudioOverlay: () => invoke<void>("clear_audio_overlay"),
};
