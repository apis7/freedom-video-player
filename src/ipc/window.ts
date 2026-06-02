import { invoke } from "@tauri-apps/api/core";

export const fvpWindow = {
  setFullscreen: (fullscreen: boolean) =>
    invoke<void>("set_fullscreen", { fullscreen }),
  isFullscreen: () => invoke<boolean>("is_fullscreen"),
  setVideoArea: (x: number, y: number, width: number, height: number) =>
    invoke<void>("set_video_area", { x, y, width, height }),
};
