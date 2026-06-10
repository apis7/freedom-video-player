import clsx from "clsx";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FixedSizeGrid as Grid } from "react-window";
import type { GridChildComponentProps } from "react-window";
import type { LibraryRow } from "../../ipc/library";
import { LibraryPoster } from "./LibraryPoster";
import { formatBytes, formatRuntime } from "./libraryFormat";
import { setIdentityDragData } from "./dragKinds";
import { displayTitle } from "./titleDisplay";
import { actlog } from "../../utils/actlog";
import { useAppStore } from "../../state/appStore";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

interface Props {
  rows: LibraryRow[];
  selectedFileIds: Set<number>;
  primarySelectedId: number | null;
  /** Identity-ids currently waiting on a TMDb refresh — receives a
   *  small spinner overlay in the card corner so the user has feedback
   *  during the slow network call. */
  refreshingIdentityIds?: Set<number>;
  /** Identity-id → "S.E" label (e.g. "1.3"). When present, replaces the
   *  default `#<n>` episode badge with `#<S.E>`. Only populated when in
   *  a series scope with seasons on. */
  episodeLabels?: Map<number, string>;
  /** Pre-computed season groups for the current series view — first row
   *  index per season + a count. Used to draw a "Season N" sticker on
   *  the first card of each season. */
  seasonGroups?: { season: number; firstRowIndex: number; count: number }[];
  /** Bumping counter sent by the SeriesScopeBar dropdown; views scroll
   *  to the given row index when this counter changes. */
  jumpToRowIndex?: { idx: number; n: number };
  /** Stable identifier for the current Library scope (e.g. "all-root",
   *  "series-37", "collection-12"). Used to save + restore scroll
   *  position so the user keeps their spot when diving into a series
   *  and coming back. */
  scopeKey: string;
  /** Enable drag-reorder. "series-numbered" shows a position badge on
   *  each card; "collection" is plain reorder. Drop fires onReorderRows
   *  with the new identity-id order. */
  reorderMode?: "series-numbered" | "collection" | null;
  onReorderRows?: (orderedIdentityIds: number[]) => void;
  onPick: (
    fileId: number,
    modifiers: { ctrl: boolean; shift: boolean },
  ) => void;
  onPlay: (row: LibraryRow) => void;
  onContextMenu: (row: LibraryRow, x: number, y: number) => void;
  /** Fire the same backend metadata-refresh that the right-click menu's
   *  "Refresh metadata from TMDb" uses. Wired to the small refresh
   *  badge that appears on the bottom-right of every thumbnail that
   *  has neither a custom thumbnail nor a cached poster. */
  onRefreshMetadata?: (row: LibraryRow) => void;
}

// Card width includes its outer gap; height = poster (228 = 152*1.5) +
// info row (~22) + small margin. Tight numbers but they let us avoid an
// extra wrap div per card.
const CARD_W = 168;
const CARD_H = 268;

/**
 * Virtualized grid of poster cards. Only renders rows currently in the
 * viewport (+ a small overscan) so a library of thousands costs the same
 * as a library of ~30 visible cards. Replaces the previous "render every
 * card at once" approach that mounted 1000+ DOM nodes + fired 1000+
 * poster IPC calls at once.
 *
 * Layout: measure the scroll container's width, compute column count
 * from CARD_W, render react-window's FixedSizeGrid.
 */
export function LibraryThumbnailView({
  rows,
  scopeKey,
  selectedFileIds,
  primarySelectedId,
  refreshingIdentityIds,
  episodeLabels,
  seasonGroups,
  jumpToRowIndex,
  reorderMode,
  onReorderRows,
  onPick,
  onPlay,
  onContextMenu,
  onRefreshMetadata,
}: Props) {
  // Save + restore scroll offset by scope.
  //
  // STRICTLY LIMITED to the "all" / root scope — initial attempt to
  // save+restore across ALL scopes caused a rendering glitch where
  // some collections/series stopped showing items after a bulk-
  // thumbnail write (unclear interaction between the scroll restore,
  // virtualization, and the post-write epoch bump). Restricting to
  // "all" keeps the most valuable use case (long All Movies list)
  // without risking the small-scope-grid-disappears bug.
  const savedScrollOffsets = useAppStore((s) => s.libraryScopeScrollOffsets);
  const setScrollOffset = useAppStore((s) => s.setLibraryScopeScroll);
  const isAllScope = scopeKey.startsWith("all-");
  // outerRef on react-window's Grid exposes the underlying scrolling
  // div. We use it to read + set scrollTop.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gridOuterRef = useRef<any>(null);
  useEffect(() => {
    if (!isAllScope) return;
    const saved = savedScrollOffsets[scopeKey];
    if (saved == null || saved <= 0) return;
    let cancelled = false;
    const restore = () => {
      if (cancelled) return;
      const el = gridOuterRef.current;
      if (el && "scrollTop" in el) {
        el.scrollTop = saved;
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(restore));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey, isAllScope]);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const handleGridScroll = (info: { scrollTop: number }) => {
    if (!isAllScope) return;
    if (scrollSaveTimerRef.current != null) return;
    scrollSaveTimerRef.current = window.setTimeout(() => {
      scrollSaveTimerRef.current = null;
      setScrollOffset(scopeKey, info.scrollTop);
    }, 250);
  };
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gridRef = useRef<any>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  // Scroll-to-row trigger from the "Jump to season" dropdown. We track
  // the bumping counter `n` so consecutive jumps to the same row index
  // re-fire (otherwise React would skip them as no-op).
  useEffect(() => {
    if (!jumpToRowIndex || jumpToRowIndex.idx < 0 || !gridRef.current) return;
    // Parent passes the ORIGINAL row index; map through padding so we
    // scroll to the correct grid cell.
    const padded = origToPaddedIdx.get(jumpToRowIndex.idx) ?? jumpToRowIndex.idx;
    const colCount = Math.max(1, Math.floor(dims.w / CARD_W) || 1);
    const targetRow = Math.floor(padded / colCount);
    gridRef.current.scrollToItem({
      rowIndex: targetRow,
      columnIndex: 0,
      align: "start",
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToRowIndex?.n]);
  // Row-reorder state — uses useRef instead of useState for the drag
  // source id, because React state updates are async and the OTHER
  // card's onDragOver closure would otherwise see a stale (null)
  // value on the first few dragover ticks. Without preventDefault on
  // those first ticks, the browser marks the card as a non-drop-target
  // and stops sending dragover events to it entirely. The ref is set
  // synchronously in onDragStart, so any handler reading .current sees
  // the freshest value. State stays for the visual indicator only.
  const rowDragIdRef = useRef<number | null>(null);
  const rowDropSideRef = useRef<"before" | "after">("before");
  const [rowDropTargetId, setRowDropTargetId] = useState<number | null>(null);
  const [rowDropSide, setRowDropSide] = useState<"before" | "after">("before");
  const commitRowReorder = (
    sourceIdentityId: number,
    targetIdentityId: number,
    side: "before" | "after",
  ) => {
    if (!onReorderRows) return;
    const ids = rows.map((r) => r.identity.id);
    const srcIdx = ids.indexOf(sourceIdentityId);
    const tgtIdx = ids.indexOf(targetIdentityId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    // Compute final landing slot BEFORE we splice out the source —
    // splicing first shifts indices for any target past srcIdx.
    const desiredSlot = side === "after" ? tgtIdx + 1 : tgtIdx;
    if (desiredSlot === srcIdx || desiredSlot === srcIdx + 1) return; // no-op
    ids.splice(srcIdx, 1);
    const insertIdx = desiredSlot > srcIdx ? desiredSlot - 1 : desiredSlot;
    ids.splice(insertIdx, 0, sourceIdentityId);
    onReorderRows(ids);
  };

  // Measure the container; recompute on resize.
  //
  // `reorderMode` is in deps because the component renders TWO
  // different JSX trees depending on reorderMode (ReorderableGrid
  // vs the virtualized Grid wrapped in our containerRef div). When
  // reorderMode toggles, the containerRef div unmounts/remounts.
  // Without re-running this effect, the new div would never be
  // measured — `dims` would stay at its last value (potentially
  // {0, 0} if the component first mounted in reorderMode), and
  // the virtualized Grid would render nothing.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setDims({ w: Math.floor(r.width), h: Math.floor(r.height) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [reorderMode]);

  // Empty-state messaging is handled by the parent so it can be
  // context-aware (empty scope vs. filter mismatch vs. no library).
  if (rows.length === 0) return null;

  const columnCount = Math.max(1, Math.floor(dims.w / CARD_W));

  // When seasons are on, pad the cell array so each new season starts
  // at column 0 of a fresh row. We insert `null` items into the
  // sequence wherever a row is incomplete when the next season's first
  // card arrives. Without this, season N+1 episode 1 would sit
  // immediately after season N's last card and the visual break the
  // user asked for is missing.
  const paddedRows: (LibraryRow | null)[] = (() => {
    if (!seasonGroups || seasonGroups.length < 2) return rows;
    const out: (LibraryRow | null)[] = [];
    let nextSeasonStartIdx = 0;
    const starts = new Set(seasonGroups.map((g) => g.firstRowIndex));
    for (let i = 0; i < rows.length; i++) {
      if (i > 0 && starts.has(i)) {
        const col = out.length % columnCount;
        if (col > 0) {
          const padCount = columnCount - col;
          for (let p = 0; p < padCount; p++) out.push(null);
        }
      }
      out.push(rows[i] ?? null);
      void nextSeasonStartIdx;
    }
    return out;
  })();
  const rowCount = Math.ceil(paddedRows.length / columnCount);

  // Original-index → padded-index mapping. Used for both the
  // "Season N" sticker placement AND the "Jump to season" scroll.
  const origToPaddedIdx = (() => {
    const m = new Map<number, number>();
    let origIdx = 0;
    for (let i = 0; i < paddedRows.length; i++) {
      if (paddedRows[i] != null) {
        m.set(origIdx, i);
        origIdx++;
      }
    }
    return m;
  })();
  const paddedSeasonStartsAt = (() => {
    const m = new Map<number, number>();
    if (!seasonGroups) return m;
    for (const g of seasonGroups) {
      const padded = origToPaddedIdx.get(g.firstRowIndex);
      if (padded != null) m.set(padded, g.season);
    }
    return m;
  })();

  // Identity ids of every selected card — used during drag so a
  // multi-card selection drags as a single payload.
  const selectedIdentityIds = Array.from(
    new Set(
      rows.filter((r) => selectedFileIds.has(r.file.id)).map((r) => r.identity.id),
    ),
  );

  // Use itemData so the cell renderer can read rows + handlers from a
  // single closure-free object — react-window memoizes cells based on
  // (rowIndex, columnIndex, data) so this keeps re-renders minimal.
  const seasonStartsAt = paddedSeasonStartsAt;
  const itemData: CellData = {
    rows: paddedRows,
    columnCount,
    selectedFileIds,
    primarySelectedId,
    selectedIdentityIds,
    refreshingIdentityIds: refreshingIdentityIds ?? new Set(),
    episodeLabels,
    seasonStartsAt,
    reorderMode: reorderMode ?? null,
    rowDropTargetId,
    rowDropSide,
    // Expose the ref OBJECT (not its .current) so cells reading it
    // always see the freshest value, not the snapshot from the render
    // that created itemData.
    rowDragIdRef,
    rowDropSideRef,
    onReorderDragStart: (identityId) => {
      rowDragIdRef.current = identityId;
    },
    onReorderDragOver: (identityId, side) => {
      rowDropSideRef.current = side;
      setRowDropTargetId(identityId);
      setRowDropSide(side);
    },
    onReorderDragEnd: () => {
      rowDragIdRef.current = null;
      setRowDropTargetId(null);
    },
    onReorderDrop: (targetId) => {
      const sourceId = rowDragIdRef.current;
      if (sourceId == null) return;
      commitRowReorder(sourceId, targetId, rowDropSideRef.current);
    },
    onPick,
    onPlay,
    onContextMenu,
    onRefreshMetadata,
  };

  // @dnd-kit-based reorderable grid for series/collection scopes.
  // We bypass react-window virtualization in reorderMode — series
  // typically have < 100 items so there's no perf concern, and
  // virtualization fights @dnd-kit (off-screen items aren't in the
  // DOM, so the SortableContext can't see them).
  if (reorderMode) {
    return (
      <ReorderableGrid
        rows={rows}
        cardWidth={CARD_W}
        onReorderRows={onReorderRows}
        data={itemData}
        jumpToRowIndex={jumpToRowIndex}
        scopeKey={scopeKey}
        onScrollSave={handleGridScroll}
      />
    );
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      {dims.w > 0 && dims.h > 0 && (
        <Grid
          ref={gridRef}
          outerRef={gridOuterRef}
          columnCount={columnCount}
          columnWidth={CARD_W}
          rowCount={rowCount}
          rowHeight={CARD_H}
          height={dims.h}
          width={dims.w}
          itemData={itemData}
          overscanRowCount={2}
          onScroll={handleGridScroll}
        >
          {Cell}
        </Grid>
      )}
    </div>
  );
}

interface CellData {
  /** May contain null entries — those are season-break padding cells
   *  inserted to push the next season's first card onto a fresh grid
   *  row. Cells render as empty divs for null entries. */
  rows: (LibraryRow | null)[];
  columnCount: number;
  selectedFileIds: Set<number>;
  primarySelectedId: number | null;
  selectedIdentityIds: number[];
  refreshingIdentityIds: Set<number>;
  episodeLabels: Map<number, string> | undefined;
  /** Map<rowIndex → seasonNumber> for cells that are the FIRST card in
   *  their season. Used to paint a "Season N" sticker on those cells. */
  seasonStartsAt: Map<number, number>;
  reorderMode: "series-numbered" | "collection" | null;
  rowDropTargetId: number | null;
  /** Which side of the target card the drop will land on. Used to render
   *  the indicator bar on the correct edge AND to let the user place an
   *  item at the very end of the list by dropping on the right half of
   *  the last card. */
  rowDropSide: "before" | "after";
  rowDragIdRef: React.MutableRefObject<number | null>;
  rowDropSideRef: React.MutableRefObject<"before" | "after">;
  onReorderDragStart: (identityId: number) => void;
  onReorderDragOver: (identityId: number, side: "before" | "after") => void;
  onReorderDragEnd: () => void;
  onReorderDrop: (targetId: number) => void;
  onPick: Props["onPick"];
  onPlay: Props["onPlay"];
  onContextMenu: Props["onContextMenu"];
  onRefreshMetadata?: Props["onRefreshMetadata"];
}

function Cell({
  columnIndex,
  rowIndex,
  style,
  data,
}: GridChildComponentProps<CellData>) {
  const i = rowIndex * data.columnCount + columnIndex;
  const row = data.rows[i];
  if (!row) return <div style={style} />;
  // Inset the card inside the cell so the grid has visible "gap" without
  // a CSS grid (react-window cells are absolutely positioned).
  const padded: React.CSSProperties = {
    ...style,
    padding: 8,
  };
  return (
    <div style={padded}>
      <ThumbCard
        row={row}
        selected={data.selectedFileIds.has(row.file.id)}
        isPrimary={data.primarySelectedId === row.file.id}
        selectedIdentityIds={data.selectedIdentityIds}
        isRefreshing={data.refreshingIdentityIds.has(row.identity.id)}
        episodeLabel={data.episodeLabels?.get(row.file.id)}
        seasonStartLabel={data.seasonStartsAt.get(i) ?? null}
        reorderMode={data.reorderMode}
        isReorderDropTarget={
          data.rowDropTargetId === row.identity.id &&
          data.rowDragIdRef.current !== row.identity.id
        }
        dropSide={data.rowDropSide}
        isReorderDragSource={data.rowDragIdRef.current === row.identity.id}
        rowDragIdRef={data.rowDragIdRef}
        onReorderDragStart={data.onReorderDragStart}
        onReorderDragOver={data.onReorderDragOver}
        onReorderDragEnd={data.onReorderDragEnd}
        onReorderDrop={data.onReorderDrop}
        onPick={data.onPick}
        onPlay={data.onPlay}
        onContextMenu={data.onContextMenu}
        onRefreshMetadata={data.onRefreshMetadata}
      />
    </div>
  );
}

function ThumbCard({
  row,
  selected,
  isPrimary,
  selectedIdentityIds,
  isRefreshing,
  episodeLabel,
  seasonStartLabel,
  reorderMode,
  isReorderDropTarget,
  isReorderDragSource,
  dropSide,
  rowDragIdRef,
  onReorderDragStart,
  onReorderDragOver,
  onReorderDragEnd,
  onReorderDrop,
  onPick,
  onPlay,
  onContextMenu,
  onRefreshMetadata,
}: {
  row: LibraryRow;
  selected: boolean;
  isPrimary: boolean;
  selectedIdentityIds: number[];
  isRefreshing: boolean;
  /** Pre-computed "S.E" label (e.g. "1.3") when in a seasons-on series
   *  scope; falls back to bare position+1 otherwise. */
  episodeLabel: string | undefined;
  /** When this card is the FIRST in a season, the season number;
   *  triggers a "Season N" sticker above the poster. */
  seasonStartLabel: number | null;
  reorderMode: "series-numbered" | "collection" | null;
  isReorderDropTarget: boolean;
  dropSide: "before" | "after";
  isReorderDragSource: boolean;
  rowDragIdRef: React.MutableRefObject<number | null>;
  onReorderDragStart: (identityId: number) => void;
  onReorderDragOver: (identityId: number, side: "before" | "after") => void;
  onReorderDragEnd: () => void;
  onReorderDrop: (targetId: number) => void;
  onPick: Props["onPick"];
  onPlay: Props["onPlay"];
  onContextMenu: Props["onContextMenu"];
  onRefreshMetadata?: Props["onRefreshMetadata"];
}) {
  const id = row.identity;
  const f = row.file;
  const synthSeries = row.__synthetic_series;
  const progressPct =
    synthSeries == null && id.duration_ms > 0
      ? Math.min(100, Math.max(0, (f.watch_progress_ms / id.duration_ms) * 100))
      : 0;
  const title = synthSeries
    ? synthSeries.series_name
    : displayTitle(row);
  // Episode-number-within-series for items currently scoped to a series
  // (series.position is 1-based). Shown as a small badge in the bottom-
  // left of the poster.
  const seriesPosition = row.series?.position ?? null;

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    onPick(f.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
  };
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    if (!selected) {
      onPick(f.id, { ctrl: false, shift: false });
    }
    onContextMenu(row, e.clientX, e.clientY);
  };

  const ROW_DRAG_MIME = "application/x-fvp-row-reorder";
  return (
    <div
      onClick={handleClick}
      onDoubleClick={() => onPlay(row)}
      onContextMenu={handleContextMenu}
      // In reorderMode the card's drag carries the row-reorder MIME
      // (used to shuffle cards within a collection/series). Otherwise
      // it carries the identity-id MIME so drops onto the sidebar add
      // the card to a collection/series.
      draggable
      onDragStart={(e) => {
        if (reorderMode) {
          actlog(
            "thumb-view",
            `card drag-start identity_id=${row.identity.id} reorderMode=${reorderMode}`,
          );
          e.dataTransfer.setData(ROW_DRAG_MIME, String(row.identity.id));
          e.dataTransfer.effectAllowed = "move";
          onReorderDragStart(row.identity.id);
          return;
        }
        const ids =
          selected && selectedIdentityIds.length > 0
            ? selectedIdentityIds
            : [row.identity.id];
        actlog("thumb-view", `card identity drag-start ids=[${ids.join(",")}]`);
        setIdentityDragData(e.dataTransfer, ids);
      }}
      onDragOver={
        reorderMode
          ? (e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const srcId = rowDragIdRef.current;
              if (srcId == null) return;
              // Cursor on left half → drop BEFORE this card; right half
              // → drop AFTER. Right-half on the last card is how the
              // user puts an item at the very end of the list.
              const rect = e.currentTarget.getBoundingClientRect();
              const side: "before" | "after" =
                e.clientX - rect.left > rect.width / 2 ? "after" : "before";
              onReorderDragOver(row.identity.id, side);
            }
          : undefined
      }
      onDragEnd={reorderMode ? (e) => {
        actlog(
          "thumb-view",
          `card drag-end identity_id=${row.identity.id} dropEffect=${e.dataTransfer.dropEffect}`,
        );
        onReorderDragEnd();
      } : undefined}
      onDrop={
        reorderMode
          ? (e) => {
              e.preventDefault();
              const srcId = rowDragIdRef.current;
              actlog(
                "thumb-view",
                `card drop FIRED src=${srcId ?? "null"} tgt=${row.identity.id}`,
              );
              if (srcId != null) {
                onReorderDrop(row.identity.id);
              }
            }
          : undefined
      }
      className={clsx(
        "flex flex-col cursor-pointer select-none group relative",
        "transition-transform hover:-translate-y-0.5",
        isReorderDragSource && "opacity-50",
      )}
      title={title}
    >
      {/* Drop-indicator bar on whichever edge the cursor is hovering —
          left for "drop before", right for "drop after". The right
          variant is what lets the user drop at the very end of the
          list (drag onto the right half of the last card). */}
      {isReorderDropTarget && dropSide === "before" && (
        <div className="absolute -left-1 top-0 bottom-0 w-1 bg-fvp-accent rounded-full pointer-events-none z-10" />
      )}
      {isReorderDropTarget && dropSide === "after" && (
        <div className="absolute -right-1 top-0 bottom-0 w-1 bg-fvp-accent rounded-full pointer-events-none z-10" />
      )}
      <div
        className={clsx(
          "relative",
          selected && "ring-2 ring-fvp-accent rounded",
          isPrimary && selected && "ring-offset-1 ring-offset-fvp-bg",
        )}
      >
        {isRefreshing && (
          <div
            className="absolute top-1 right-1 z-10 w-5 h-5 rounded-full bg-fvp-bg/80 border border-fvp-accent flex items-center justify-center shadow"
            title="Refreshing metadata from TMDb…"
          >
            <span
              className="inline-block w-2.5 h-2.5 border-2 border-fvp-accent border-t-transparent rounded-full animate-spin"
              aria-hidden
            />
          </div>
        )}
        <LibraryPoster
          customThumbnailPath={id.custom_thumbnail_path}
          posterLocalPath={id.poster_local_path}
          widthPx={152}
          alt={title}
          isMissing={!synthSeries && row.file.is_missing}
          cacheKey={id.last_updated_at}
        />
        <div className="absolute left-0 right-0 bottom-0 px-2 py-1 bg-gradient-to-t from-black/85 via-black/60 to-transparent rounded-b pointer-events-none">
          <div className="text-[11px] font-medium text-white leading-tight line-clamp-2">
            {title}
          </div>
          {id.movie_year && (
            <div className="text-[10px] text-white/70">{id.movie_year}</div>
          )}
        </div>
        {progressPct > 0 && progressPct < 99 && (
          <div className="absolute left-0 right-0 bottom-0 h-[3px] bg-black/50 rounded-b">
            <div
              className="h-full bg-fvp-accent rounded-bl"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}
        {synthSeries == null && f.watched && (
          <div
            className="absolute top-1 right-1 w-5 h-5 bg-fvp-ok rounded-full flex items-center justify-center text-white text-[10px] shadow"
            title="Watched"
          >
            ✓
          </div>
        )}
        {synthSeries == null && f.drift_warning && (
          <div
            className="absolute top-1 left-1 w-5 h-5 bg-fvp-warn rounded-full flex items-center justify-center text-white text-[10px] shadow"
            title="File changed since profile was created — re-verify"
          >
            ⚠
          </div>
        )}
        {/* Refresh-metadata shortcut. Shows on the bottom-right when
            the identity has neither a custom thumbnail nor a cached
            TMDb poster — these are the rows where the user most likely
            wants to nudge a fresh search. Hidden once a poster lands. */}
        {synthSeries == null &&
          !id.custom_thumbnail_path &&
          !id.poster_local_path &&
          !row.file.is_missing &&
          onRefreshMetadata && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRefreshMetadata(row);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="absolute bottom-1 right-1 w-7 h-7 bg-fvp-bg/85 border border-fvp-accent/70 hover:bg-fvp-accent hover:text-white text-fvp-accent rounded-full flex items-center justify-center text-[14px] shadow transition-colors"
              title="No poster — try a TMDb metadata refresh"
              aria-label="Refresh metadata from TMDb"
            >
              ↻
            </button>
          )}
        {/* Episode-number badge — top-left of poster when scoped into
            a series. Uses "S.E" form when the parent computed labels
            (seasons on); falls back to bare position+1 otherwise. */}
        {synthSeries == null && (episodeLabel || seriesPosition != null) && (
          <div
            className="absolute top-1 left-1 px-1.5 py-0.5 bg-fvp-bg/85 border border-fvp-accent/60 text-fvp-accent text-[10px] font-bold rounded shadow"
            title={
              episodeLabel
                ? `Season ${episodeLabel.split(".")[0]} · episode ${episodeLabel.split(".")[1]}`
                : `Item ${(seriesPosition ?? 0) + 1} in the series`
            }
          >
            #{episodeLabel ?? (seriesPosition! + 1)}
          </div>
        )}
        {/* "Season N" sticker on the FIRST card of each season. Lives
            above the poster so it doesn't fight with the # badge. */}
        {synthSeries == null && seasonStartLabel != null && (
          <div
            className="absolute -top-3 left-1 px-1.5 py-0.5 bg-fvp-accent text-white text-[9px] font-bold uppercase tracking-wider rounded shadow"
            title={`First item of Season ${seasonStartLabel}`}
          >
            Season {seasonStartLabel}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 mt-1.5 text-[10px] text-fvp-muted">
        {synthSeries ? (
          // Series tile: SERIES badge on the left, episode count on the
          // right (in place of resolution/filesize since those don't
          // mean anything at the series-aggregate level).
          <>
            <span
              className="px-1.5 py-0.5 bg-fvp-accent/20 text-fvp-accent text-[9px] font-bold uppercase tracking-wider rounded"
              title="Series — click to see episodes"
            >
              SERIES
            </span>
            <span className="text-fvp-muted" title={`${synthSeries.episode_count} items in this series`}>
              {synthSeries.episode_count} movie{synthSeries.episode_count === 1 ? "" : "s"}
            </span>
          </>
        ) : (
          <>
            <span title="Runtime">{formatRuntime(id.duration_ms)}</span>
            <ProfileIcon status={row.profile_status} />
            <span title={`${f.resolution ?? "Unknown resolution"} · ${formatBytes(f.size_bytes)}`}>
              {f.resolution ?? formatBytes(f.size_bytes)}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function ProfileIcon({ status }: { status: LibraryRow["profile_status"] }) {
  if (status === "has_profile") {
    return (
      <span
        className="text-fvp-accent text-[13px] leading-none"
        title="Has .free profile"
        aria-label="Has profile"
      >
        ★
      </span>
    );
  }
  if (status === "no_profile_necessary") {
    return (
      <span
        className="text-fvp-ok text-[13px] leading-none"
        title="No profile necessary (marked clean)"
        aria-label="No profile necessary"
      >
        ✓
      </span>
    );
  }
  return (
    <span
      className="text-fvp-muted text-[13px] leading-none"
      title="No profile"
    >
      ☆
    </span>
  );
}

/** Reorderable grid for series/collection scopes. Skips react-window
 *  virtualization (typical scope size is small) so @dnd-kit can see
 *  every item in the SortableContext. Pointer-event-based drag —
 *  coexists with Tauri's dragDropEnabled=true. */
function ReorderableGrid({
  rows,
  cardWidth,
  onReorderRows,
  data,
  jumpToRowIndex,
  scopeKey,
  onScrollSave,
}: {
  rows: LibraryRow[];
  cardWidth: number;
  onReorderRows?: (orderedIds: number[]) => void;
  data: CellData;
  jumpToRowIndex?: { idx: number; n: number };
  scopeKey: string;
  onScrollSave: (info: { scrollTop: number }) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const ids = rows.map((r) => r.identity.id);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // Jump-to-season for the reorderable path. react-window's
  // scrollToItem doesn't apply here — we use a per-card data
  // attribute + querySelector + scrollIntoView instead. Tracks
  // jumpToRowIndex.n so consecutive jumps to the same row re-fire.
  useEffect(() => {
    if (!jumpToRowIndex || jumpToRowIndex.idx < 0 || !scrollerRef.current) {
      return;
    }
    const target = scrollerRef.current.querySelector(
      `[data-row-idx="${jumpToRowIndex.idx}"]`,
    ) as HTMLElement | null;
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToRowIndex?.n]);

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id || !onReorderRows) return;
    const oldIdx = ids.indexOf(Number(active.id));
    const newIdx = ids.indexOf(Number(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    onReorderRows(arrayMove(ids, oldIdx, newIdx));
  };
  return (
    <div
      ref={scrollerRef}
      data-scope-scroller={scopeKey}
      onScroll={(e) =>
        onScrollSave({ scrollTop: (e.target as HTMLDivElement).scrollTop })
      }
      className="h-full w-full overflow-y-auto p-2"
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <div
            className="grid gap-2"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${cardWidth - 16}px, 1fr))`,
            }}
          >
            {rows.map((row, idx) => (
              <SortableCard
                key={row.identity.id}
                id={row.identity.id}
                row={row}
                data={data}
                rowIdx={idx}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

/** Single sortable card wrapper. Renders ThumbCard inside a dnd-kit
 *  sortable shell. Click / context-menu still work — the
 *  PointerSensor's 6px activation distance lets stationary clicks
 *  through. */
function SortableCard({
  id,
  row,
  data,
  rowIdx,
}: {
  id: number;
  row: LibraryRow;
  data: CellData;
  rowIdx: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    position: "relative",
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      data-row-idx={rowIdx}
      {...attributes}
      {...listeners}
    >
      <ThumbCard
        row={row}
        selected={data.selectedFileIds.has(row.file.id)}
        isPrimary={data.primarySelectedId === row.file.id}
        selectedIdentityIds={data.selectedIdentityIds}
        isRefreshing={data.refreshingIdentityIds.has(row.identity.id)}
        episodeLabel={data.episodeLabels?.get(row.file.id)}
        seasonStartLabel={null}
        reorderMode={data.reorderMode}
        isReorderDropTarget={false}
        dropSide="before"
        isReorderDragSource={isDragging}
        rowDragIdRef={data.rowDragIdRef}
        onReorderDragStart={data.onReorderDragStart}
        onReorderDragOver={data.onReorderDragOver}
        onReorderDragEnd={data.onReorderDragEnd}
        onReorderDrop={data.onReorderDrop}
        onPick={data.onPick}
        onPlay={data.onPlay}
        onContextMenu={data.onContextMenu}
      />
    </div>
  );
}
