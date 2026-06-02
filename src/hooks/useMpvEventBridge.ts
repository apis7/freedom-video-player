import { useEffect } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";

interface MpvPropertyEvent {
  name: string;
  value: number | boolean | string | null;
}

/**
 * Event-driven replacement for the old 100ms polling.
 *
 * Listens for `mpv-property` Tauri events pushed from the backend whenever
 * libmpv reports a property change (~60 Hz for time-pos during playback).
 * Updates the Zustand store in place. The frontend's `state.position` is now
 * ground truth at libmpv's frame cadence — no polling lag, no interpolation
 * estimates.
 *
 * Also performs a one-shot `get_state` on mount so the initial snapshot is
 * populated even before the first event fires.
 */
export function useMpvEventBridge() {
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    // One-shot bootstrap so we have non-zero state on first paint.
    void playback
      .getState()
      .then((s) => {
        if (cancelled) return;
        useAppStore.setState({
          position: s.position,
          duration: s.duration,
          playing: !s.paused,
          volume: s.volume,
          muted: s.muted,
          playbackSpeed: s.speed,
        });
      })
      .catch(() => {});

    void listen<MpvPropertyEvent>("mpv-property", (e) => {
      const { name, value } = e.payload;
      useAppStore.setState((prev) => {
        switch (name) {
          case "time-pos": {
            if (typeof value !== "number") return {};
            const updates: Partial<typeof prev> = { position: value };
            // Lift loading overlay once libmpv reports real playback (a frame
            // has been rendered, indicated by a non-zero position with a file
            // loaded). Previously gated on `has_file`; here we use the position
            // as a strong-enough signal — `idle-active` also fires separately.
            if (prev.loading && value > 0.04) {
              updates.loading = false;
            }
            return updates;
          }
          case "duration":
            return typeof value === "number" ? { duration: value } : {};
          case "pause":
            if (typeof value !== "boolean") return {};
            // Pause → Play transition: re-check the safety banner. The
            // banner has its own dedup so frequent toggles won't spam it.
            if (value === false && prev.playing === false) {
              void import("../utils/safetyBanner").then(
                ({ evaluateSafetyBanner }) => evaluateSafetyBanner(),
              );
            }
            return { playing: !value };
          case "speed":
            return typeof value === "number" ? { playbackSpeed: value } : {};
          case "volume":
            return typeof value === "number" ? { volume: value } : {};
          case "mute":
            return typeof value === "boolean" ? { muted: value } : {};
          case "idle-active": {
            if (typeof value !== "boolean") return {};
            if (value && prev.loading) {
              // idle == true with loading flag set means file failed or was
              // closed; clear loading to release the overlay.
              return { loading: false };
            }
            return {};
          }
          case "play-direction": {
            if (typeof value !== "string") return {};
            if (value === "forward" || value === "backward") {
              return { playDirection: value };
            }
            return {};
          }
          default:
            return {};
        }
      });
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);
}
