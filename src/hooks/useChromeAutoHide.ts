import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { fvpWindow } from "../ipc";

/** Delay before auto-hiding chrome AFTER no activity. The first
 *  fullscreen-entry uses a faster delay so the transition feels
 *  intentional (paired with the FullscreenTransitionIndicator); any
 *  later "wake on mouse" uses the longer delay so the user has time
 *  to actually use the controls. */
const INITIAL_HIDE_DELAY_MS = 1700;
const WAKE_HIDE_DELAY_MS = 4000;

/**
 * In fullscreen Player Mode, auto-hides all chrome (TitleBar, MenuBar, StatusBar,
 * TransportBar) after 6s of no mouse/keyboard activity. Any activity instantly
 * shows chrome again and restarts the timer.
 *
 * Also wires Esc to exit fullscreen, so you can always get out.
 */
export function useChromeAutoHide() {
  const fullscreen = useAppStore((s) => s.fullscreen);
  const mode = useAppStore((s) => s.mode);

  useEffect(() => {
    const inFsPlayer = mode === "player" && fullscreen;

    if (!inFsPlayer) {
      useAppStore.setState({ chromeVisible: true });
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleHide = (delay: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        useAppStore.setState({ chromeVisible: false });
      }, delay);
    };

    const wake = () => {
      useAppStore.setState({ chromeVisible: true });
      scheduleHide(WAKE_HIDE_DELAY_MS);
    };

    useAppStore.setState({ chromeVisible: true });
    // First hide on fullscreen entry uses the SHORTER delay so the
    // chrome doesn't linger awkwardly — paired with the visible
    // transition indicator the user gets clear feedback.
    scheduleHide(INITIAL_HIDE_DELAY_MS);

    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", wake);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      useAppStore.setState({ chromeVisible: true });
    };
  }, [fullscreen, mode]);

  // Esc exits fullscreen — universal escape hatch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && useAppStore.getState().fullscreen) {
        void fvpWindow.setFullscreen(false);
        useAppStore.setState({ fullscreen: false });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
