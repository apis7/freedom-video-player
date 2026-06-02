import { invoke } from "@tauri-apps/api/core";
import type { SubtitleTrack } from "./subtitles";

/** Track-selection IPC for audio + video tracks. Subtitle tracks have their
 *  own module (subtitles.ts) since they predate this one. Shape is identical. */
export interface AudioDevice {
  name: string;
  description: string;
  selected: boolean;
}

export const tracksIpc = {
  audio: () => invoke<SubtitleTrack[]>("audio_tracks"),
  video: () => invoke<SubtitleTrack[]>("video_tracks"),
  setAudio: (id: number | null) => invoke<void>("set_audio_track", { id }),
  setVideo: (id: number | null) => invoke<void>("set_video_track", { id }),
  setDeinterlace: (on: boolean) => invoke<void>("set_deinterlace", { on }),
  getDeinterlace: () => invoke<boolean>("get_deinterlace"),
  audioDevices: () => invoke<AudioDevice[]>("audio_devices"),
  setAudioDevice: (name: string) => invoke<void>("set_audio_device", { name }),
};
