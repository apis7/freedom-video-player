import { useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { fvpWindow } from "../ipc";

const HIDE_DELAY_MS = 6000;

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

    const scheduleHide = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        useAppStore.setState({ chromeVisible: false });
      }, HIDE_DELAY_MS);
    };

    const wake = () => {
      useAppStore.setState({ chromeVisible: true });
      scheduleHide();
    };

    useAppStore.setState({ chromeVisible: true });
    scheduleHide();

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
