import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";

/**
 * Tiny FVP badge in the top-left of the video when a profile is
 * actively applying. Opt-in via Settings → Player Mode → "Show
 * profile-active icon on video" (default OFF). Stays out of the way
 * but signals "this video is being filtered" without taking up the
 * verbose top-right ProfileChip area.
 */
export function ProfileActiveIcon() {
  const enabled = useAppStore((s) => s.playerShowProfileIcon);
  const detected = useAppStore((s) => s.detectedProfiles);
  const abToggleOn = useAppStore((s) => s.abToggleOn);
  if (!enabled || !abToggleOn) return null;
  const anyActive = detected.some((p) => p.active);
  if (!anyActive) return null;
  return (
    <div
      className="absolute top-3 left-3 w-7 h-7 rounded-full bg-fvp-accent/85 border border-fvp-accent shadow flex items-center justify-center pointer-events-none"
      title="A profile is filtering this video"
    >
      <img
        src="/icon_96px.png"
        alt=""
        className="w-5 h-5 rounded-full select-none"
        draggable={false}
      />
    </div>
  );
}

/**
 * Brief overlay that fades in the movie file path when the user starts
 * a video from the very beginning. Opt-in via Settings → Player Mode →
 * "Show movie file path briefly on play" (default OFF). Visible for ~4s,
 * fades out over 1.5s. Only triggers on play-from-start (<1s) so resumes
 * don't pop up the path every time the user unpauses.
 */
export function MoviePathOverlay() {
  const enabled = useAppStore((s) => s.playerShowPathOnStart);
  const playing = useAppStore((s) => s.playing);
  const currentFile = useAppStore((s) => s.currentFile);
  const [visible, setVisible] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);
  const prevPlayingRef = useRef(playing);

  useEffect(() => {
    const wasPlaying = prevPlayingRef.current;
    prevPlayingRef.current = playing;
    if (!enabled || !currentFile) return;
    if (!playing || wasPlaying) return;
    // Capture position at the moment play kicks off — must be a true
    // start, not a resume. Reading the store directly (rather than
    // including `position` in deps) means this effect only fires on
    // play-state transitions, not every frame's time-pos update.
    const startPos = useAppStore.getState().position;
    if (startPos >= 1.0) return;
    setVisible(true);
    setFadingOut(false);
    const fadeTimer = window.setTimeout(() => setFadingOut(true), 4000);
    const hideTimer = window.setTimeout(() => {
      setVisible(false);
      setFadingOut(false);
    }, 5500);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(hideTimer);
    };
  }, [enabled, currentFile, playing]);

  if (!visible || !currentFile) return null;
  return (
    <div
      className={clsx(
        "absolute bottom-8 left-1/2 -translate-x-1/2 max-w-[80%] px-3 py-2",
        "bg-black/70 text-white text-xs font-mono rounded shadow pointer-events-none",
        "transition-opacity break-all text-center",
        fadingOut
          ? "opacity-0 duration-[1500ms]"
          : "opacity-100 duration-300",
      )}
    >
      {currentFile}
    </div>
  );
}
