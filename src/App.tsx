import { useEffect } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useAppStore } from "./state/appStore";
import { TitleBar } from "./components/TitleBar";
import { MenuBar } from "./components/MenuBar";
import { StatusBar } from "./components/StatusBar";
import { CheatsheetOverlay } from "./components/CheatsheetOverlay";
import { ToastOverlay } from "./components/Toast";
import { BulkProgressBar } from "./components/BulkProgressBar";
import { FullscreenTransitionIndicator } from "./components/FullscreenTransitionIndicator";
import { LoadTimeoutModal } from "./components/LoadTimeoutModal";
import { AboutModal } from "./components/AboutModal";
import { SafetyBanner } from "./components/SafetyBanner";
import { PlayerMode } from "./modes/Player";
import { CreatorMode } from "./modes/Creator";
import { LibraryMode } from "./modes/Library";
import { SettingsMode } from "./modes/Settings";
import { useChromeAutoHide } from "./hooks/useChromeAutoHide";
import { useHotkeys } from "./hooks/useHotkeys";
import { useProfileApplication } from "./hooks/useProfileApplication";
import { useMpvEventBridge } from "./hooks/useMpvEventBridge";
import { useAutosaveDraft } from "./hooks/useAutosaveDraft";
import { useAudioReplaceOverlay } from "./hooks/useAudioReplaceOverlay";
import { useFileDropTarget } from "./hooks/useFileDropTarget";
import { useWindowStatePersist } from "./hooks/useWindowStatePersist";
import { useSettingsPersist } from "./hooks/useSettingsPersist";
import { hasUnsavedWork, confirmDiscardUnsaved } from "./utils/unsavedWork";
import { openVideoPath, openFreeFile } from "./utils/openFileFlow";
import {
  libraryIpc,
  readHomeDiscovery,
  resetHostHealth,
  setHostEndpoint,
  setLibraryMode,
} from "./ipc/library";

export function App() {
  const mode = useAppStore((s) => s.mode);
  const fullscreen = useAppStore((s) => s.fullscreen);
  const chromeVisible = useAppStore((s) => s.chromeVisible);
  const libraryEnabled = useAppStore((s) => s.libraryEnabled);

  useMpvEventBridge();
  useChromeAutoHide();
  useHotkeys();
  useProfileApplication();
  useAudioReplaceOverlay();
  useAutosaveDraft();
  useFileDropTarget();
  useWindowStatePersist();
  useSettingsPersist();

  // Auto-pause when leaving Player Mode while a video is playing.
  // Position stays in libmpv → user can jump back to Player and hit
  // Space to resume from where they were. Covers ALL setMode call
  // sites (action + raw setState) by subscribing to the store.
  useEffect(() => {
    let prevMode = useAppStore.getState().mode;
    const unsub = useAppStore.subscribe((state) => {
      if (prevMode === "player" && state.mode !== "player" && state.playing) {
        void import("./ipc").then(({ playback }) => {
          void playback.pause();
        });
      }
      prevMode = state.mode;
    });
    return unsub;
  }, []);

  // Library Networking boot: read the current mode + endpoint
  // configuration once at startup so every libraryIpc.* call routes
  // correctly. Falls back to manual host_address/host_auth_token if the
  // home folder's discovery files aren't readable. Errors are
  // swallowed — networking failure here just means Client mode won't
  // work; the Settings UI will show the issue.
  useEffect(() => {
    void (async () => {
      try {
        const snap = await libraryIpc.getSettings();
        // Fresh session — clear any cached "last success" from a
        // previous run so the lockout overlay only flips green AFTER
        // we actually round-trip the Host this session.
        resetHostHealth();
        setLibraryMode(snap.library_mode);
        if (snap.library_mode === "client") {
          // Prefer auto-discovery from home folder; fall back to manual
          // settings if discovery file is absent/unreadable.
          let endpoint: { url: string; token: string } | null = null;
          if (snap.home_folder_path && snap.home_folder_exists) {
            try {
              const d = await readHomeDiscovery();
              if (d) endpoint = { url: d.host_url, token: d.token };
            } catch (e) {
              console.log(`[fvp] auto-discovery failed: ${e}`);
            }
          }
          if (!endpoint && snap.host_address && snap.host_auth_token) {
            endpoint = {
              url: snap.host_address,
              token: snap.host_auth_token,
            };
          }
          setHostEndpoint(endpoint);
          console.log(
            `[fvp] Library Networking: mode=client endpoint=${
              endpoint ? endpoint.url : "(none)"
            }`,
          );
        } else {
          setHostEndpoint(null);
          console.log(
            `[fvp] Library Networking: mode=${snap.library_mode}`,
          );
        }
      } catch (e) {
        console.log(`[fvp] Library Networking boot failed: ${e}`);
      }
    })();
  }, []);

  // Guard window close when autosave is off and Creator has unsaved work.
  // Only preventDefault in that case — let Tauri's wrapper handle the
  // normal close path via its built-in destroy(). Always-preventing-and-
  // explicitly-destroying was failing silently in some build states.
  // Listen for `cli-open-file` events emitted by the Rust side. Two
  // sources fire this event with the same payload (a file path string):
  //   1. First-launch argv: user double-clicked a video in Explorer and
  //      FVP wasn't already running. Backend parses argv in setup() and
  //      emits after a short delay.
  //   2. Second-launch argv via single-instance plugin: FVP was already
  //      running, the user double-clicked another video. The second
  //      process forwards the path to the first via the plugin callback,
  //      then exits.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<string>("cli-open-file", (event) => {
        const path = event.payload;
        if (!path) return;
        console.log(`[fvp] cli-open-file event: ${path}`);
        // Route .free files through the profile-resolver flow so they
        // can find their associated video (or prompt for one). Anything
        // else goes straight to the video opener.
        if (path.toLowerCase().endsWith(".free")) {
          void openFreeFile(path);
        } else {
          void openVideoPath(path);
        }
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    const win = getCurrentWebviewWindow();
    let unlisten: (() => void) | null = null;
    win
      .onCloseRequested((event) => {
        try {
          if (!hasUnsavedWork()) return; // wrapper destroys normally
          // Unsaved work — ask. If user cancels, keep window open.
          event.preventDefault();
          if (confirmDiscardUnsaved("Closing the app")) {
            void win.destroy().catch((err) => {
              // eslint-disable-next-line no-console
              console.error("destroy failed:", err);
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error("close-guard error, allowing close:", err);
          // Don't preventDefault here either — let close proceed.
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("onCloseRequested registration failed:", err);
      });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const inFsPlayer = mode === "player" && fullscreen;
  const showChrome = !inFsPlayer || chromeVisible;
  const showMenuBar = showChrome && (mode === "player" || mode === "creator");
  const showStatusBar = mode === "player" && (!fullscreen || chromeVisible);

  return (
    <div className="flex flex-col h-screen text-fvp-text font-sans">
      {showChrome && <TitleBar />}
      {showMenuBar && <MenuBar />}
      <main className="flex-1 min-h-0 overflow-hidden">
        {mode === "player" && <PlayerMode />}
        {mode === "creator" && <CreatorMode />}
        {mode === "library" && libraryEnabled && <LibraryMode />}
        {mode === "settings" && <SettingsMode />}
      </main>
      {showStatusBar && <StatusBar />}
      <CheatsheetOverlay />
      <ToastOverlay />
      <BulkProgressBar />
      <FullscreenTransitionIndicator />
      <LoadTimeoutModal />
      <AboutModalIfVisible />
      <SafetyBanner />
    </div>
  );
}

function AboutModalIfVisible() {
  const visible = useAppStore((s) => s.aboutVisible);
  if (!visible) return null;
  return <AboutModal onClose={() => useAppStore.setState({ aboutVisible: false })} />;
}
