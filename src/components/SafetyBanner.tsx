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
          // Top-right, pushed BELOW the ProfileChip (which lives at
          // top-3 of the video area, absolute Y ~70-100 px). At top-28
          // (112 px) the banner clears the chip with breathing room.
          // Solid surface background instead of the previous translucent
          // /20 — the chip and banner used to blend into each other in
          // the overlap area; opaque card kills that bleed entirely.
          "fixed top-28 right-4 z-50 w-[340px] rounded-lg border-2 shadow-2xl bg-fvp-surface",
          "transition-opacity duration-[5000ms] ease-linear cursor-pointer select-none",
          "hover:brightness-110",
          isInactive
            ? "border-fvp-err text-fvp-err"
            : "border-fvp-warn text-fvp-warn",
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
        {/* Header row: title + X dismiss. Separate from the body so they
            can't collide regardless of how the title wraps. */}
        <div className="flex items-start justify-between gap-2 px-3 pt-2.5 pb-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-sm leading-none shrink-0">
              {isInactive ? "⚠" : "ⓘ"}
            </span>
            <strong className="text-xs leading-tight">
              {isInactive
                ? "Profile is not active"
                : "No profile for this video"}
            </strong>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              dismissSafetyBanner();
            }}
            className="text-current opacity-60 hover:opacity-100 text-sm leading-none shrink-0 -mt-0.5 px-1"
            title="Dismiss"
            aria-label="Dismiss banner"
          >
            ✕
          </button>
        </div>
        {/* Body — own row, full width inside padding, can wrap cleanly. */}
        <div className="text-[11px] leading-relaxed px-3 pb-2.5">
          {isInactive ? (
            <>
              A profile was found for this video but isn&apos;t filtering
              playback. <span className="underline">Click to activate.</span>
            </>
          ) : (
            <>
              Playback isn&apos;t being filtered.{" "}
              <span className="underline">Click here</span> to create one.
            </>
          )}
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
