import { invoke } from "@tauri-apps/api/core";

export interface SubtitleTrack {
  id: number;
  title: string | null;
  lang: string | null;
  selected: boolean;
  external: boolean;
}

export interface SubtitleEntry {
  start_ms: number;
  end_ms: number;
  text: string;
}

export const subtitlesIpc = {
  add: (path: string) => invoke<void>("add_subtitle", { path }),
  setTrack: (id: number | null) => invoke<void>("set_subtitle_track", { id }),
  toggleVisibility: () => invoke<void>("toggle_subtitle_visibility"),
  setVisibility: (visible: boolean) =>
    invoke<void>("set_subtitle_visibility", { visible }),
  getVisibility: () => invoke<boolean>("get_subtitle_visibility"),
  tracks: () => invoke<SubtitleTrack[]>("subtitle_tracks"),
  parseFile: (path: string) =>
    invoke<SubtitleEntry[]>("parse_subtitle_file", { path }),
  extractEmbedded: (videoPath: string, trackId: number) =>
    invoke<SubtitleEntry[]>("extract_embedded_subtitle", { videoPath, trackId }),
};
