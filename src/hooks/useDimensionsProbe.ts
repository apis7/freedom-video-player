import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { libraryIpc } from "../ipc/library";

interface DimsEvent {
  path: string;
  width: number;
  height: number;
}

/**
 * When libmpv successfully loads a file, the backend probes its
 * actual pixel dimensions (`dwidth` / `dheight`) at ~1.5s and emits a
 * `playback:dimensions-probed` event. We use it to upgrade the
 * library's resolution column from a filename label ("1080p") or
 * NULL to the real WxH form.
 *
 * Skipped silently when the file isn't in the library (e.g. user
 * opened it via File → Open without adding the folder); the backend
 * IPC will just return false.
 */
export function useDimensionsProbe() {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<DimsEvent>("playback:dimensions-probed", (e) => {
      const { path, width, height } = e.payload;
      if (!path || width <= 0 || height <= 0) return;
      void libraryIpc
        .saveActualResolution(path, width, height)
        .then((updated) => {
          if (updated) {
            console.log(
              `[fvp:library] saved actual resolution ${width}x${height} for ${path}`,
            );
          }
        })
        .catch((err) => {
          console.log(`[fvp:library] save resolution failed: ${err}`);
        });
    }).then((un) => {
      if (cancelled) un();
      else unlisten = un;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
