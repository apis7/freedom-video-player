import { invoke } from "@tauri-apps/api/core";
import type { LoadedPeaks } from "./types";

interface LoadedPeaksDto {
  peaks_per_second: number;
  duration_ms: number;
  // Tauri encodes the Rust Vec<u8> as a JS number[] over JSON. We convert to
  // Uint8Array right at the boundary so downstream consumers (canvas
  // rendering) don't have to deal with the slower / heavier number-array.
  peaks: number[];
}

export const peaksIpc = {
  /** Read the existing peaks sidecar if it's present and not stale. Returns
   *  null when missing — caller should then fire {@link buildPeaks}. */
  load: async (videoPath: string): Promise<LoadedPeaks | null> => {
    const dto = await invoke<LoadedPeaksDto | null>("load_peaks", {
      videoPath,
    });
    if (!dto) return null;
    return {
      peaks_per_second: dto.peaks_per_second,
      duration_ms: dto.duration_ms,
      peaks: new Uint8Array(dto.peaks),
    };
  },
  /** Kick off the background build. Returns immediately; progress and
   *  completion arrive via `fvp:peaks-progress` / `fvp:peaks-done` /
   *  `fvp:peaks-failed` Tauri events. */
  build: (videoPath: string): Promise<void> =>
    invoke<void>("build_peaks", { videoPath }),
};

export interface PeaksProgressEvent {
  video_path: string;
  percent: number;
}
export interface PeaksDoneEvent {
  video_path: string;
}
export interface PeaksFailedEvent {
  video_path: string;
  error: string;
}
