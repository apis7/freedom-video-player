import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";
import { playerController } from "../controller/playerController";
import { playback } from "../ipc";
import { SeekBar } from "./SeekBar";

const VOLUME_STEPS = [25, 50, 75, 100];
const SPEED_STEPS = [0.25, 0.5, 1, 1.25, 1.5, 2, 10, 25];

interface TransportBarProps {
  onOpenFile: () => void;
  /** "player" (default) shows all controls. "creator" hides Prev/Next/Fullscreen. */
  variant?: "player" | "creator";
}

export function TransportBar({ onOpenFile, variant = "player" }: TransportBarProps) {
  const playing = useAppStore((s) => s.playing);
  const muted = useAppStore((s) => s.muted);
  const fullscreen = useAppStore((s) => s.fullscreen);
  const currentFile = useAppStore((s) => s.currentFile);
  const abToggleOn = useAppStore((s) => s.abToggleOn);
  const playDirection = useAppStore((s) => s.playDirection);
  const isCreator = variant === "creator";
  const showQueueButtons = !isCreator;
  const showFullscreen = !isCreator;

  // SeekBar still reports scrub state so we can wire it to anything that
  // needs it later, but the old per-component polling is gone — App-level
  // useMpvEventBridge is the single position source.
  const [, setScrubbing] = useState(false);

  const disabled = !currentFile;

  return (
    <div className="h-12 bg-fvp-surface border-t border-fvp-border flex items-center gap-3 px-3 select-none">
      <TransportButton title="Open file… (Ctrl+O)" onClick={onOpenFile}>
        <FolderIcon />
      </TransportButton>

      <div className="w-px h-5 bg-fvp-border" />

      {isCreator ? (
        <>
          {/* Creator: Play-Backwards and Play-Forwards. Each pauses if you
              click it while it's the active direction. Space (handled by
              useHotkeys → playerController.togglePause) always normalises
              back to forward. */}
          <TransportButton
            title={
              playing && playDirection === "backward"
                ? "Pause"
                : "Play backwards"
            }
            onClick={() => void playerController.playBackwardToggle()}
            disabled={disabled}
            className="text-fvp-warn"
          >
            {playing && playDirection === "backward" ? (
              <PauseIcon />
            ) : (
              <PlayBackwardIcon />
            )}
          </TransportButton>
          <TransportButton
            title={
              playing && playDirection === "forward"
                ? "Pause (Space)"
                : "Play forwards (Space)"
            }
            onClick={() => void playerController.playForwardToggle()}
            disabled={disabled}
          >
            {playing && playDirection === "forward" ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </TransportButton>
        </>
      ) : (
        <>
          <TransportButton
            title={playing ? "Pause (Space)" : "Play (Space)"}
            onClick={() => void playerController.togglePause()}
            disabled={disabled}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </TransportButton>
          <TransportButton
            title="Stop"
            onClick={() => void playerController.stop()}
            disabled={disabled}
          >
            <StopIcon />
          </TransportButton>
        </>
      )}
      {showQueueButtons && (
        <>
          <TransportButton title="Previous (no queue yet)" onClick={() => {}} disabled>
            <PrevIcon />
          </TransportButton>
          <TransportButton title="Next (no queue yet)" onClick={() => {}} disabled>
            <NextIcon />
          </TransportButton>
        </>
      )}

      <SeekBar onScrubStateChange={setScrubbing} />

      <div className="w-px h-5 bg-fvp-border" />

      <TransportButton
        title={muted ? "Unmute (M)" : "Mute (M)"}
        onClick={() => void playerController.toggleMute()}
        disabled={disabled}
      >
        {muted ? <MuteIcon /> : <VolumeIcon />}
      </TransportButton>
      <VolumeCycleButton disabled={disabled} />
      <SpeedDropdown disabled={disabled} />

      <div className="w-px h-5 bg-fvp-border" />

      <button
        onClick={(e) => {
          e.currentTarget.blur();
          useAppStore.setState({ abToggleOn: !abToggleOn });
        }}
        disabled={disabled}
        title={
          abToggleOn
            ? "Profile preview ON — click or press T to turn off"
            : "Profile preview OFF — click or press T to turn on"
        }
        className={clsx(
          "px-2 h-8 flex items-center justify-center rounded text-[10px] font-semibold border",
          disabled
            ? "opacity-30 cursor-not-allowed border-transparent"
            : abToggleOn
              ? "bg-fvp-ok/20 text-fvp-ok border-fvp-ok/40 hover:bg-fvp-ok/30 cursor-pointer"
              : "bg-fvp-err/20 text-fvp-err border-fvp-err/40 hover:bg-fvp-err/30 cursor-pointer",
        )}
      >
        A/B {abToggleOn ? "ON" : "OFF"}
      </button>

      {/* Movie Info button — Player only. Grayed when no profile is
          detected (the spec says no .free loaded; we treat "no detected
          profile" as "no .free loaded"). Spec position: between A/B
          and Fullscreen. */}
      {!isCreator && <MovieInfoButton disabled={disabled} />}

      {showFullscreen && (
        <>
          <div className="w-px h-5 bg-fvp-border" />
          <TransportButton
            title={fullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"}
            onClick={() => void playerController.toggleFullscreen()}
            disabled={disabled}
          >
            <FullscreenIcon />
          </TransportButton>
        </>
      )}
    </div>
  );
}

/** Player-mode-only film-camera button → opens the Movie Info modal
 *  in read-only "view" mode. Grayed out + tooltip when no profile is
 *  loaded for the current file. */
function MovieInfoButton({ disabled }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const detected = useAppStore((s) => s.detectedProfiles);
  const hasActiveProfile = detected.some((p) => p.active);
  const truly_disabled = disabled || !hasActiveProfile;
  return (
    <>
      <TransportButton
        title={
          truly_disabled
            ? "Movie info — no profile loaded for this file"
            : "Movie info — MAPS rating, plot, cast, snip summary"
        }
        onClick={() => setOpen(true)}
        disabled={truly_disabled}
      >
        <FilmCameraIcon />
      </TransportButton>
      {open && <MovieInfoModalView onClose={() => setOpen(false)} />}
    </>
  );
}

/** Inline lazy-import so MovieInfoModal + dependencies don't bloat
 *  TransportBar's normal render path. */
function MovieInfoModalView({ onClose }: { onClose: () => void }) {
  const [Cmp, setCmp] = useState<React.ComponentType<{
    mode: "view";
    onClose: () => void;
  }> | null>(null);
  useEffect(() => {
    void import("./MovieInfoModal").then((m) => setCmp(() => m.MovieInfoModal));
  }, []);
  if (!Cmp) return null;
  return <Cmp mode="view" onClose={onClose} />;
}

function VolumeCycleButton({ disabled }: { disabled?: boolean }) {
  const volume = useAppStore((s) => s.volume);
  const nextVolume = () => {
    const current = Math.round(volume);
    const next = VOLUME_STEPS.find((v) => v > current) ?? VOLUME_STEPS[0];
    void playerController.setVolume(next!);
  };
  const display = Math.round(volume);
  return (
    <button
      onClick={(e) => {
        e.currentTarget.blur();
        nextVolume();
      }}
      disabled={disabled}
      title={`Volume ${display}% — click to cycle ${VOLUME_STEPS.join("/")}%`}
      className={clsx(
        "px-2 h-8 flex items-center justify-center rounded text-fvp-text border border-fvp-border",
        disabled ? "opacity-30 cursor-not-allowed" : "hover:bg-fvp-surface2 cursor-pointer",
      )}
    >
      <span className="text-[10px] font-mono w-8 text-center">{display}%</span>
    </button>
  );
}

function SpeedDropdown({ disabled }: { disabled?: boolean }) {
  const speed = useAppStore((s) => s.playbackSpeed);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (rate: number) => {
    setOpen(false);
    useAppStore.setState({ playbackSpeed: rate });
    playback.setSpeed(rate).catch((err) => {
      // Surface IPC failures — otherwise speed silently reverts to 1.0 via polling.
      // eslint-disable-next-line no-console
      console.error("set_speed failed:", err);
      alert(`Speed change failed: ${err}`);
    });
  };

  const label = speed === 1 ? "1×" : `${speed}×`;

  return (
    <div ref={wrapRef} className="relative">
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          setOpen((o) => !o);
        }}
        disabled={disabled}
        title="Playback speed — useful for fast scrubbing"
        className={clsx(
          "px-2 h-8 flex items-center justify-center gap-1 rounded text-fvp-text border border-fvp-border",
          disabled ? "opacity-30 cursor-not-allowed" : "hover:bg-fvp-surface2 cursor-pointer",
        )}
      >
        <span className="text-[10px] font-mono">{label}</span>
        <svg width="8" height="8" viewBox="0 0 8 8">
          <path d="M1 2l3 4 3-4z" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-full mb-1 right-0 bg-fvp-surface border border-fvp-border rounded shadow-lg py-1 z-50 min-w-[80px]">
          {SPEED_STEPS.map((s) => (
            <button
              key={s}
              onClick={() => choose(s)}
              className={clsx(
                "w-full text-left px-3 py-1 text-[11px] font-mono",
                s === speed
                  ? "bg-fvp-accent/30 text-white"
                  : "text-fvp-text hover:bg-fvp-accent hover:text-white",
              )}
            >
              {s === 1 ? "1× (normal)" : `${s}×`}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TransportButton({
  children,
  onClick,
  title,
  disabled,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  /** Optional extra classes — used to tint specific buttons (e.g. the
   *  Creator-mode reverse-play button gets `text-fvp-warn` so the user
   *  can tell at a glance which direction will play). */
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={clsx(
        "w-8 h-8 flex items-center justify-center rounded",
        // Default color is fvp-text; callers can override via className.
        !className && "text-fvp-text",
        disabled
          ? "opacity-30 cursor-not-allowed"
          : "hover:bg-fvp-surface2 cursor-pointer",
        className,
      )}
    >
      {children}
    </button>
  );
}

const sw = 1.5;
function PlayIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 1.5l9 5.5-9 5.5z" fill="currentColor"/></svg>); }
function PlayBackwardIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M11 1.5l-9 5.5 9 5.5z" fill="currentColor"/></svg>); }
function PauseIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" fill="currentColor"/><rect x="8" y="2" width="3" height="10" fill="currentColor"/></svg>); }
function StopIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="3" width="8" height="8" fill="currentColor"/></svg>); }
function PrevIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 2v10M11 2L4 7l7 5z" fill="currentColor" stroke="currentColor" strokeWidth={sw} strokeLinejoin="round"/></svg>); }
function NextIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M11 2v10M3 2l7 5-7 5z" fill="currentColor" stroke="currentColor" strokeWidth={sw} strokeLinejoin="round"/></svg>); }
function VolumeIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 5v4h3l4 3V2L4 5z" fill="currentColor"/><path d="M10 4c1 1 1 5 0 6M11.5 2.5c2 2 2 7 0 9" stroke="currentColor" strokeWidth={sw} fill="none" strokeLinecap="round"/></svg>); }
function MuteIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 5v4h3l4 3V2L4 5z" fill="currentColor"/><path d="M10 5l4 4M14 5l-4 4" stroke="currentColor" strokeWidth={sw} strokeLinecap="round"/></svg>); }
function FullscreenIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" stroke="currentColor" strokeWidth={sw} fill="none" strokeLinecap="round" strokeLinejoin="round"/></svg>); }
function FolderIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><path d="M1 3a1 1 0 011-1h3l2 2h5a1 1 0 011 1v6a1 1 0 01-1 1H2a1 1 0 01-1-1z" stroke="currentColor" strokeWidth={sw} fill="none"/></svg>); }
function FilmCameraIcon() { return (<svg width="14" height="14" viewBox="0 0 14 14"><rect x="1" y="4" width="8" height="6" rx="1" stroke="currentColor" strokeWidth={sw} fill="none"/><path d="M9 6l4-2v6l-4-2z" stroke="currentColor" strokeWidth={sw} fill="none" strokeLinejoin="round"/></svg>); }
