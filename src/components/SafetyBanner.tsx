import { useEffect, useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";
import {
  activateDetectedProfile,
  dismissSafetyBanner,
} from "../utils/safetyBanner";

/**
 * Top-right safety banner. Two variants:
 *   - "inactive-profile" (red): profile exists but isn't applying snips.
 *     Click → activate it.
 *   - "no-profile" (orange): no profile exists. Click → ask "Create one?"
 *
 * Fully opaque for the first 10s, then linear-fades over 5s, then
 * removes itself from the store.
 */
export function SafetyBanner() {
  const banner = useAppStore((s) => s.safetyBanner);
  const setMode = useAppStore((s) => s.setMode);
  const [fading, setFading] = useState(false);
  const [askingCreate, setAskingCreate] = useState(false);

  useEffect(() => {
    setFading(false);
    setAskingCreate(false);
    if (!banner) return;
    const fadeTimer = window.setTimeout(() => setFading(true), 10_000);
    const removeTimer = window.setTimeout(dismissSafetyBanner, 15_000);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [banner?.shownAt, banner?.kind]);

  if (!banner) return null;

  const isInactive = banner.kind === "inactive-profile";

  const handleBannerClick = () => {
    if (isInactive) {
      activateDetectedProfile();
    } else {
      setAskingCreate(true);
    }
  };

  return (
    <>
      <div
        className={clsx(
          // Top-right fixed; below the menubar (~32px) + some breathing room.
          "fixed top-12 right-4 z-50 max-w-[360px] rounded-lg border-2 shadow-2xl px-4 py-3",
          "transition-opacity duration-[5000ms] ease-linear cursor-pointer select-none",
          "hover:brightness-110",
          isInactive
            ? "bg-fvp-err/20 border-fvp-err text-fvp-err"
            : "bg-fvp-warn/20 border-fvp-warn text-fvp-warn",
          fading ? "opacity-0" : "opacity-100",
        )}
        onClick={handleBannerClick}
        role="alert"
        title={
          isInactive
            ? "Click to activate the detected profile."
            : "Click for options."
        }
      >
        <div className="flex items-start gap-2">
          <span className="text-base leading-none mt-0.5">
            {isInactive ? "⚠" : "ⓘ"}
          </span>
          <div className="flex-1 text-xs leading-snug">
            {isInactive ? (
              <>
                <strong className="block mb-0.5">Profile is not active</strong>
                A profile was found for this video but isn't filtering
                playback. <span className="underline">Click to activate.</span>
              </>
            ) : (
              <>
                <strong className="block mb-0.5">No profile for this video</strong>
                Playback isn't being filtered. <span className="underline">
                  Click here
                </span>{" "}
                to create one.
              </>
            )}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              dismissSafetyBanner();
            }}
            className="text-current opacity-60 hover:opacity-100 text-sm leading-none -mt-0.5"
            title="Dismiss"
            aria-label="Dismiss banner"
          >
            ✕
          </button>
        </div>
      </div>

      {askingCreate && (
        <CreateProfileConfirm
          onYes={() => {
            setAskingCreate(false);
            dismissSafetyBanner();
            setMode("creator");
          }}
          onNo={() => {
            setAskingCreate(false);
            // Leave the banner up so it can finish its fade naturally.
          }}
        />
      )}
    </>
  );
}

function CreateProfileConfirm({
  onYes,
  onNo,
}: {
  onYes: () => void;
  onNo: () => void;
}) {
  // Block other modals from also opening while this is up.
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onNo();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onYes();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onNo, onYes]);

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onNo}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[380px] max-w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-sm font-semibold text-fvp-text mb-2">
          Create a profile for this video?
        </h3>
        <p className="text-xs text-fvp-muted mb-4 leading-relaxed">
          You'll switch to Profile Creator mode where you can mark snips
          (skip, silence, beep, etc.). Your edits autosave next to the
          video as a <code className="font-mono">.free</code> file.
        </p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onNo}
            className="px-3 py-1.5 rounded text-xs bg-fvp-bg border border-fvp-border text-fvp-text hover:border-fvp-muted"
          >
            No, just watch
          </button>
          <button
            onClick={onYes}
            autoFocus
            className="px-3 py-1.5 rounded text-xs bg-fvp-accent text-white hover:opacity-90"
          >
            Yes, open Creator
          </button>
        </div>
      </div>
    </div>
  );
}
