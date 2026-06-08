import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../state/appStore";
import { peaksIpc } from "../ipc";
import { actlog } from "../utils/actlog";
import type {
  PeaksProgressEvent,
  PeaksDoneEvent,
  PeaksFailedEvent,
} from "../ipc";

/**
 * Manages the lifecycle of the audio-peaks sidecar for the currently-loaded
 * file in Creator mode:
 *   1. On file open, try to load the existing `.fvp-peaks.bin` sidecar.
 *   2. If it's missing/stale, kick off a background build (non-blocking).
 *   3. Listen for backend progress events and reflect them in the store so
 *      the WaveformBackground / PeaksBuildingBadge components update.
 *   4. On build completion, re-load the sidecar.
 *
 * Only runs in Creator mode — Player mode has no timeline, so spending CPU
 * on the waveform would be wasted. Switching modes mid-build leaves the
 * backend job running in the background; we just stop listening.
 */
export function useAudioPeaks() {
  const mode = useAppStore((s) => s.mode);
  const currentFile = useAppStore((s) => s.currentFile);

  // (1)+(2) — react to file changes by loading or kicking off a build.
  useEffect(() => {
    if (mode !== "creator" || !currentFile) {
      actlog("peaks", `hook idle (mode=${mode}, file=${currentFile ?? "null"})`);
      useAppStore.setState({
        audioPeaks: null,
        peaksBuilding: false,
        peaksBuildPercent: null,
      });
      return;
    }

    let cancelled = false;
    const target = currentFile;
    actlog("peaks", `hook fired for creator mode, file=${target}`);

    (async () => {
      try {
        actlog("peaks", `calling load for ${target}`);
        const existing = await peaksIpc.load(target);
        if (cancelled || useAppStore.getState().currentFile !== target) {
          actlog("peaks", `load returned but file changed/cancelled — abort`);
          return;
        }
        if (existing) {
          actlog("peaks", `load HIT, ${existing.peaks.length} peaks loaded`);
          useAppStore.setState({
            audioPeaks: existing,
            peaksBuilding: false,
            peaksBuildPercent: null,
          });
          return;
        }
        actlog("peaks", `load MISS — kicking off build for ${target}`);
        useAppStore.setState({
          audioPeaks: null,
          peaksBuilding: true,
          peaksBuildPercent: 0,
        });
        await peaksIpc.build(target);
        actlog("peaks", `build IPC returned (worker continues in background)`);
      } catch (err) {
        if (cancelled) return;
        actlog("peaks", `build kickoff THREW: ${String(err)}`);
        useAppStore.setState({
          peaksBuilding: false,
          peaksBuildPercent: null,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mode, currentFile]);

  // (3)+(4) — listen to Tauri events for the duration of Creator mode.
  useEffect(() => {
    if (mode !== "creator") return;
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    const matchesCurrent = (eventPath: string) =>
      useAppStore.getState().currentFile === eventPath;

    listen<PeaksProgressEvent>("fvp:peaks-progress", (e) => {
      if (!matchesCurrent(e.payload.video_path)) return;
      useAppStore.setState({ peaksBuildPercent: e.payload.percent });
    }).then((un) => {
      if (cancelled) un();
      else unlisteners.push(un);
    });

    listen<PeaksDoneEvent>("fvp:peaks-done", async (e) => {
      const path = e.payload.video_path;
      if (!matchesCurrent(path)) return;
      try {
        const loaded = await peaksIpc.load(path);
        if (!matchesCurrent(path)) return;
        useAppStore.setState({
          audioPeaks: loaded,
          peaksBuilding: false,
          peaksBuildPercent: null,
        });
      } catch {
        useAppStore.setState({
          peaksBuilding: false,
          peaksBuildPercent: null,
        });
      }
    }).then((un) => {
      if (cancelled) un();
      else unlisteners.push(un);
    });

    listen<PeaksFailedEvent>("fvp:peaks-failed", (e) => {
      if (!matchesCurrent(e.payload.video_path)) return;
      // eslint-disable-next-line no-console
      console.warn("[fvp:peaks] build failed:", e.payload.error);
      useAppStore.setState({
        peaksBuilding: false,
        peaksBuildPercent: null,
      });
    }).then((un) => {
      if (cancelled) un();
      else unlisteners.push(un);
    });

    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
    };
  }, [mode]);
}
