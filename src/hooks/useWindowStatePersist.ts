import { useEffect } from "react";
import {
  getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

const KEY = "fvp.windowState.v1";
const DEBOUNCE_MS = 500;

interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Hand-rolled window position + size persistence using localStorage.
 *
 * Restores last-known geometry on mount (one-time application — user sees
 * a brief flicker if the window starts at default size first). Saves
 * geometry on resize/move, debounced 500ms so we don't write per pixel.
 *
 * Falls back silently if Tauri rejects the position/size calls (permission
 * issues, weird multi-monitor states, etc.).
 */
export function useWindowStatePersist() {
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisteners: Array<() => void> = [];

    // Restore — apply once on mount.
    try {
      const raw = window.localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as WindowState;
        if (
          Number.isFinite(parsed.x) &&
          Number.isFinite(parsed.y) &&
          Number.isFinite(parsed.width) &&
          Number.isFinite(parsed.height) &&
          parsed.width > 200 &&
          parsed.height > 150
        ) {
          void win
            .setPosition(new LogicalPosition(parsed.x, parsed.y))
            .catch(() => {});
          void win
            .setSize(new LogicalSize(parsed.width, parsed.height))
            .catch(() => {});
        }
      }
    } catch {
      // localStorage unavailable / parse failed — start with default geometry.
    }

    const save = async () => {
      if (cancelled) return;
      try {
        const pos = await win.outerPosition();
        const sz = await win.outerSize();
        // Convert physical → logical pixels for consistency across DPI.
        const scale = (await win.scaleFactor()) || 1;
        const state: WindowState = {
          x: pos.x / scale,
          y: pos.y / scale,
          width: sz.width / scale,
          height: sz.height / scale,
        };
        window.localStorage.setItem(KEY, JSON.stringify(state));
      } catch {
        // Silent — nothing to do if the calls fail.
      }
    };

    const debounced = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void save(), DEBOUNCE_MS);
    };

    void win.onResized(debounced).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });
    void win.onMoved(debounced).then((fn) => {
      if (cancelled) fn();
      else unlisteners.push(fn);
    });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      for (const fn of unlisteners) fn();
    };
  }, []);
}
