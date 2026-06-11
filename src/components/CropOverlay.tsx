import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../state/appStore";
import type { SnipAction } from "../ipc/types";

/**
 * Visual editor for `crop_video` snips. Mounted as a transparent
 * overlay over the video area; renders a draggable rectangle showing
 * the crop region with 8 handles (4 corners + 4 edges). The dim
 * surrounding the rectangle shows what will be discarded by the crop
 * during the snip window.
 *
 * Active only when:
 *   - mode === "creator"
 *   - the primary-selected snip's action.type === "crop_video"
 *
 * Coordinates are stored as fractions of the source frame (0..1).
 * That keeps the .free file resolution-independent — the same crop
 * holds whether the user later replaces a 1080p source with a 4K
 * remaster.
 *
 * Interactions:
 *   - Mouse down inside the rect → drag to translate
 *   - Mouse down on a corner handle → drag to resize from that corner
 *   - Mouse down on an edge handle → drag to resize that edge
 *   - Shift held during a corner-resize → preserve aspect ratio
 *   - Min crop = 5% × 5%. Rect is clamped to stay inside the frame.
 */
export function CropOverlay() {
  const mode = useAppStore((s) => s.mode);
  const snips = useAppStore((s) => s.snips);
  const selectedSnipId = useAppStore((s) => s.selectedSnipId);
  const updateSnip = useAppStore((s) => s.updateSnip);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragKind, setDragKind] = useState<DragKind | null>(null);
  const dragStart = useRef<DragStart | null>(null);

  const snip = selectedSnipId ? snips.find((s) => s.id === selectedSnipId) : null;
  const cropAction = snip && snip.action.type === "crop_video" ? snip.action : null;

  // Drag handlers — installed on `window` so dragging beyond the
  // overlay's bounds still moves smoothly.
  useEffect(() => {
    if (!dragKind || !snip || !cropAction || !dragStart.current) return;
    const onMove = (e: MouseEvent) => {
      const cont = containerRef.current;
      const start = dragStart.current;
      if (!cont || !start) return;
      const rect = cont.getBoundingClientRect();
      const dxPct = (e.clientX - start.mouseX) / rect.width;
      const dyPct = (e.clientY - start.mouseY) / rect.height;
      const shift = e.shiftKey;
      const next = applyDrag(dragKind, start.rect, dxPct, dyPct, shift);
      updateSnip(snip.id, {
        action: {
          type: "crop_video",
          x_pct: next.x,
          y_pct: next.y,
          w_pct: next.w,
          h_pct: next.h,
        } as SnipAction,
      });
    };
    const onUp = () => {
      setDragKind(null);
      dragStart.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragKind, snip, cropAction, updateSnip]);

  if (mode !== "creator" || !cropAction || !snip) return null;

  const beginDrag = (kind: DragKind, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      rect: {
        x: cropAction.x_pct,
        y: cropAction.y_pct,
        w: cropAction.w_pct,
        h: cropAction.h_pct,
      },
    };
    setDragKind(kind);
  };

  const x = cropAction.x_pct * 100;
  const y = cropAction.y_pct * 100;
  const w = cropAction.w_pct * 100;
  const h = cropAction.h_pct * 100;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20 pointer-events-none"
      // The video sits behind a transparent area, so we let pointer
      // events pass through unless they land on the crop rectangle or
      // a handle. Children below set pointer-events:auto where needed.
    >
      {/* SVG overlay — dim mask outside the rect + the crop rectangle */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full pointer-events-none"
      >
        <defs>
          <mask id="crop-cutout">
            <rect width="100" height="100" fill="white" />
            <rect x={x} y={y} width={w} height={h} fill="black" />
          </mask>
        </defs>
        <rect
          width="100"
          height="100"
          fill="rgba(0,0,0,0.55)"
          mask="url(#crop-cutout)"
        />
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill="none"
          stroke="#22d3ee"
          strokeWidth={0.4}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Hit zone INSIDE the rect for translate-drag. Slightly inset so
          the edge handles win on the edge. */}
      <div
        onMouseDown={(e) => beginDrag("move", e)}
        className="absolute pointer-events-auto cursor-move"
        style={{
          left: `${x}%`,
          top: `${y}%`,
          width: `${w}%`,
          height: `${h}%`,
        }}
        title="Drag to move the crop region. Shift+corner = preserve aspect."
      />

      {/* 4 corner handles */}
      {(
        [
          ["nw", x, y],
          ["ne", x + w, y],
          ["sw", x, y + h],
          ["se", x + w, y + h],
        ] as Array<[CornerKind, number, number]>
      ).map(([k, hx, hy]) => (
        <Handle
          key={k}
          kind={k}
          left={hx}
          top={hy}
          cursor={cornerCursor(k)}
          onDown={(e) => beginDrag(k, e)}
        />
      ))}

      {/* 4 edge handles (center of each side) */}
      {(
        [
          ["n", x + w / 2, y],
          ["s", x + w / 2, y + h],
          ["w", x, y + h / 2],
          ["e", x + w, y + h / 2],
        ] as Array<[EdgeKind, number, number]>
      ).map(([k, hx, hy]) => (
        <Handle
          key={k}
          kind={k}
          left={hx}
          top={hy}
          cursor={edgeCursor(k)}
          onDown={(e) => beginDrag(k, e)}
        />
      ))}
    </div>
  );
}

function Handle({
  left,
  top,
  cursor,
  onDown,
}: {
  kind: DragKind;
  left: number;
  top: number;
  cursor: string;
  onDown: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onMouseDown={onDown}
      className="absolute pointer-events-auto bg-fvp-bg border border-fvp-accent"
      style={{
        left: `calc(${left}% - 6px)`,
        top: `calc(${top}% - 6px)`,
        width: 12,
        height: 12,
        cursor,
      }}
    />
  );
}

type CornerKind = "nw" | "ne" | "sw" | "se";
type EdgeKind = "n" | "s" | "w" | "e";
type DragKind = CornerKind | EdgeKind | "move";

interface DragStart {
  mouseX: number;
  mouseY: number;
  rect: Rect;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function cornerCursor(k: CornerKind): string {
  switch (k) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
  }
}
function edgeCursor(k: EdgeKind): string {
  switch (k) {
    case "n":
    case "s":
      return "ns-resize";
    case "w":
    case "e":
      return "ew-resize";
  }
}

const MIN_DIM = 0.05;

function applyDrag(
  kind: DragKind,
  start: Rect,
  dx: number,
  dy: number,
  shiftKey: boolean,
): Rect {
  let { x, y, w, h } = start;
  if (kind === "move") {
    x = clamp(start.x + dx, 0, 1 - start.w);
    y = clamp(start.y + dy, 0, 1 - start.h);
    return { x, y, w, h };
  }
  // Resize logic — compute new corners then re-derive (x,y,w,h).
  let left = start.x;
  let top = start.y;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  switch (kind) {
    case "nw":
      left = start.x + dx;
      top = start.y + dy;
      break;
    case "ne":
      right = start.x + start.w + dx;
      top = start.y + dy;
      break;
    case "sw":
      left = start.x + dx;
      bottom = start.y + start.h + dy;
      break;
    case "se":
      right = start.x + start.w + dx;
      bottom = start.y + start.h + dy;
      break;
    case "n":
      top = start.y + dy;
      break;
    case "s":
      bottom = start.y + start.h + dy;
      break;
    case "w":
      left = start.x + dx;
      break;
    case "e":
      right = start.x + start.w + dx;
      break;
  }
  // Aspect-lock for corner drags when Shift held — anchor the OPPOSITE
  // corner and project the dragged corner along the original diagonal.
  if (
    shiftKey &&
    (kind === "nw" || kind === "ne" || kind === "sw" || kind === "se")
  ) {
    const aspect = start.w / Math.max(start.h, 0.001);
    const isLeft = kind === "nw" || kind === "sw";
    const isTop = kind === "nw" || kind === "ne";
    const anchorX = isLeft ? start.x + start.w : start.x;
    const anchorY = isTop ? start.y + start.h : start.y;
    const cornerX = isLeft ? left : right;
    const cornerY = isTop ? top : bottom;
    // Pick the new w as the larger of (proposed width, proposed
    // height × aspect), so the cursor never gets ahead of the rect.
    const propW = Math.abs(cornerX - anchorX);
    const propH = Math.abs(cornerY - anchorY);
    const newW = Math.max(propW, propH * aspect);
    const newH = newW / aspect;
    left = isLeft ? anchorX - newW : anchorX;
    right = isLeft ? anchorX : anchorX + newW;
    top = isTop ? anchorY - newH : anchorY;
    bottom = isTop ? anchorY : anchorY + newH;
  }
  // Clamp + enforce min dimensions.
  left = clamp(left, 0, 1 - MIN_DIM);
  right = clamp(right, MIN_DIM, 1);
  top = clamp(top, 0, 1 - MIN_DIM);
  bottom = clamp(bottom, MIN_DIM, 1);
  if (right - left < MIN_DIM) {
    if (kind === "nw" || kind === "sw" || kind === "w") {
      left = right - MIN_DIM;
    } else {
      right = left + MIN_DIM;
    }
  }
  if (bottom - top < MIN_DIM) {
    if (kind === "nw" || kind === "ne" || kind === "n") {
      top = bottom - MIN_DIM;
    } else {
      bottom = top + MIN_DIM;
    }
  }
  return {
    x: left,
    y: top,
    w: right - left,
    h: bottom - top,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
