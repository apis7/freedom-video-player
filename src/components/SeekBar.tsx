import { useRef, useState, useEffect } from "react";
import { useAppStore } from "../state/appStore";
import { playback } from "../ipc";
import { formatTime, parseTime } from "../utils/format";

interface SeekBarProps {
  onScrubStateChange?: (scrubbing: boolean) => void;
}

export function SeekBar({ onScrubStateChange }: SeekBarProps) {
  const position = useAppStore((s) => s.position);
  const duration = useAppStore((s) => s.duration);
  const mode = useAppStore((s) => s.mode);
  const creatorSnips = useAppStore((s) => s.snips);
  const detectedProfiles = useAppStore((s) => s.detectedProfiles);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState(0);
  const [hoverInfo, setHoverInfo] = useState<{ x: number; t: number } | null>(null);

  // Snips to render as faint markers on the seekbar. Creator shows in-memory
  // working snips; Player shows the union of active detected profiles' snips.
  const seekBarSnips =
    mode === "creator"
      ? creatorSnips
      : detectedProfiles.flatMap((p) => (p.active ? p.profile.payload.snips : []));

  const [editingTime, setEditingTime] = useState(false);
  const [timeInput, setTimeInput] = useState("");

  const displayPos = dragging ? dragPos : position;
  const pct = duration > 0 ? Math.min(100, Math.max(0, (displayPos / duration) * 100)) : 0;

  useEffect(() => {
    onScrubStateChange?.(dragging);
  }, [dragging, onScrubStateChange]);

  const seekFromClientX = (clientX: number): number => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (duration <= 0) return;
    e.preventDefault();
    setDragging(true);
    const t = seekFromClientX(e.clientX);
    setDragPos(t);

    const onMove = (ev: MouseEvent) => setDragPos(seekFromClientX(ev.clientX));
    const onUp = (ev: MouseEvent) => {
      const finalT = seekFromClientX(ev.clientX);
      void playback.seek(finalT);
      setDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (duration <= 0 || dragging) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const ratio = x / rect.width;
    setHoverInfo({ x, t: ratio * duration });
  };

  const handleMouseLeave = () => setHoverInfo(null);

  const startEdit = () => {
    if (duration <= 0) return;
    setTimeInput(formatTime(displayPos));
    setEditingTime(true);
  };

  const commitEdit = () => {
    const parsed = parseTime(timeInput);
    if (parsed !== null) {
      const clamped = Math.max(0, Math.min(duration, parsed));
      void playback.seek(clamped);
    }
    setEditingTime(false);
  };

  const cancelEdit = () => setEditingTime(false);

  function colorForSnipAction(t: string): string {
    switch (t) {
      case "skip":
        return "#ff5d5d";
      case "silence":
        return "#ffb347";
      case "freeze_frame":
        return "#79c0ff";
      case "audio_replace":
        return "#c792ea";
      case "beep":
        return "#facc15";
      default:
        return "#888";
    }
  }

  return (
    <div className="flex-1 flex items-center gap-3 min-w-0">
      <div
        ref={trackRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        className="flex-1 h-1.5 bg-fvp-surface2 rounded-full cursor-pointer relative group"
        title="Seek (click or drag)"
      >
        <div
          className="absolute top-0 left-0 h-full bg-fvp-accent rounded-full pointer-events-none"
          style={{ width: `${pct}%` }}
        />
        {/* Faint snip markers — slightly taller than the track so they peek
            above/below the played-progress fill. */}
        {duration > 0 &&
          seekBarSnips.map((s) => {
            const left = (s.start_ms / 1000 / duration) * 100;
            const width = ((s.end_ms - s.start_ms) / 1000 / duration) * 100;
            if (width <= 0) return null;
            return (
              <div
                key={s.id}
                className="absolute pointer-events-none rounded-sm"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.15)}%`,
                  top: -1,
                  bottom: -1,
                  backgroundColor: colorForSnipAction(s.action.type),
                  opacity: 0.55,
                }}
                title={`${s.action.type} · ${formatTime(s.start_ms / 1000)} → ${formatTime(s.end_ms / 1000)}`}
              />
            );
          })}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-fvp-accent rounded-full opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
        {hoverInfo && (
          <div
            className="absolute -top-7 px-1.5 py-0.5 bg-fvp-bg border border-fvp-border text-[10px] text-fvp-text rounded pointer-events-none whitespace-nowrap"
            style={{ left: `${hoverInfo.x}px`, transform: "translateX(-50%)" }}
          >
            {formatTime(hoverInfo.t)}
          </div>
        )}
      </div>
      <div className="text-[11px] text-fvp-muted font-mono tabular-nums whitespace-nowrap flex items-center gap-1">
        {editingTime ? (
          <input
            autoFocus
            value={timeInput}
            onChange={(e) => setTimeInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            onBlur={commitEdit}
            placeholder="MM:SS"
            className="bg-fvp-surface2 border border-fvp-accent text-fvp-text font-mono text-[11px] w-20 px-1 outline-none rounded-sm"
          />
        ) : (
          <span
            onDoubleClick={startEdit}
            title={duration > 0 ? "Double-click to jump to time" : ""}
            className={duration > 0 ? "cursor-text hover:text-fvp-text" : ""}
          >
            {formatTime(displayPos)}
          </span>
        )}
        <span>/</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  );
}
