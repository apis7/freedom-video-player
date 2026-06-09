import clsx from "clsx";
import { Fragment, useEffect, useRef, useState } from "react";
import type { LibraryRow } from "../../ipc/library";
import { formatBytes, formatDateShort, formatPct, formatRuntime } from "./libraryFormat";
import { setIdentityDragData } from "./dragKinds";
import { displayTitle } from "./titleDisplay";
import { actlog } from "../../utils/actlog";
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
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

export type ColumnId =
  | "title"
  | "year"
  | "runtime"
  | "resolution"
  | "size"
  | "profile"
  | "subs"
  | "watched"
  | "progress"
  | "last_watched"
  | "added"
  | "genres"
  | "tags"
  | "collections"
  | "series"
  | "path"
  | "maps_filtered"
  | "maps_unfiltered";

interface ColumnSpec {
  id: ColumnId;
  label: string;
  /** Default width in pixels. User can drag-resize. */
  defaultWidth: number;
  /** Render a cell — returns the value as a string OR a JSX node. */
  render: (row: LibraryRow) => React.ReactNode;
  /** Pure string version used for sorting. */
  sortKey: (row: LibraryRow) => string | number;
}

/** Render helper — wraps any column body in a synth-series-aware gray
 *  dot. Used by every column except `title` (which gets its own icon
 *  + amber color treatment). */
function synthOr(row: LibraryRow, body: React.ReactNode): React.ReactNode {
  if (row.__synthetic_series) {
    return (
      <span
        className="text-fvp-muted"
        title="Series — open the series to see per-episode data"
      >
        ·
      </span>
    );
  }
  return body;
}

export const ALL_COLUMNS: ColumnSpec[] = [
  {
    id: "title",
    label: "Title",
    defaultWidth: 280,
    render: (row) => {
      if (row.__synthetic_series) {
        const s = row.__synthetic_series;
        return (
          <span
            className="text-orange-300"
            title={`Series: ${s.episode_count} movies. Click into the series to see each episode.`}
          >
            <span className="mr-1 text-orange-400" aria-hidden>
              📺
            </span>
            {s.series_name}
          </span>
        );
      }
      return displayTitle(row);
    },
    sortKey: (row) =>
      (row.identity.movie_title ?? row.file.path).toLowerCase(),
  },
  {
    id: "year",
    label: "Year",
    defaultWidth: 70,
    render: (row) => synthOr(row, row.identity.movie_year?.toString() ?? "—"),
    sortKey: (row) => row.identity.movie_year ?? 0,
  },
  {
    id: "runtime",
    label: "Runtime",
    defaultWidth: 80,
    render: (row) => synthOr(row, formatRuntime(row.identity.duration_ms)),
    sortKey: (row) => row.identity.duration_ms,
  },
  {
    id: "resolution",
    label: "Resolution",
    defaultWidth: 100,
    render: (row) => synthOr(row, row.file.resolution ?? "—"),
    sortKey: (row) => row.file.resolution ?? "",
  },
  {
    id: "size",
    label: "Size",
    defaultWidth: 80,
    render: (row) => synthOr(row, formatBytes(row.file.size_bytes)),
    sortKey: (row) => row.file.size_bytes,
  },
  {
    id: "profile",
    label: ".free",
    defaultWidth: 60,
    render: (row) =>
      synthOr(
        row,
        row.profile_status === "has_profile" ? (
          <span title="Has .free profile" className="text-fvp-accent">★</span>
        ) : row.profile_status === "no_profile_necessary" ? (
          <span title="No profile necessary (marked clean)" className="text-fvp-ok">✓</span>
        ) : (
          <span className="text-fvp-muted">—</span>
        ),
      ),
    sortKey: (row) =>
      row.profile_status === "has_profile"
        ? 2
        : row.profile_status === "no_profile_necessary"
          ? 1
          : 0,
  },
  {
    id: "subs",
    label: "Subs",
    defaultWidth: 60,
    render: (row) =>
      synthOr(
        row,
        row.file.has_subtitle === true ? (
          <span title="Subtitle sidecar found" className="text-fvp-accent">CC</span>
        ) : row.file.has_subtitle === false ? (
          <span className="text-fvp-muted">—</span>
        ) : (
          <span className="text-fvp-muted" title="Not yet checked">·</span>
        ),
      ),
    sortKey: (row) => (row.file.has_subtitle === true ? 1 : 0),
  },
  {
    id: "maps_filtered",
    label: "MAPS (filtered)",
    defaultWidth: 130,
    render: (row) =>
      synthOr(
        row,
        row.identity.maps_filtered_tier ? (
          <MapsTierPill tier={row.identity.maps_filtered_tier} />
        ) : (
          <span className="text-fvp-muted">—</span>
        ),
      ),
    sortKey: (row) =>
      mapsTierRank(row.identity.maps_filtered_tier),
  },
  {
    id: "maps_unfiltered",
    label: "MAPS (raw)",
    defaultWidth: 130,
    render: (row) =>
      synthOr(
        row,
        row.identity.maps_unfiltered_tier ? (
          <MapsTierPill tier={row.identity.maps_unfiltered_tier} />
        ) : (
          <span className="text-fvp-muted">—</span>
        ),
      ),
    sortKey: (row) =>
      mapsTierRank(row.identity.maps_unfiltered_tier),
  },
  {
    id: "watched",
    label: "Seen",
    defaultWidth: 60,
    render: (row) =>
      synthOr(
        row,
        row.file.watched ? (
          <span title="Watched" className="text-fvp-ok">✓</span>
        ) : (
          <span className="text-fvp-muted">—</span>
        ),
      ),
    sortKey: (row) => (row.file.watched ? 1 : 0),
  },
  {
    id: "progress",
    label: "Progress",
    defaultWidth: 80,
    render: (row) =>
      synthOr(row, formatPct(row.file.watch_progress_ms, row.identity.duration_ms)),
    sortKey: (row) =>
      row.identity.duration_ms > 0
        ? row.file.watch_progress_ms / row.identity.duration_ms
        : 0,
  },
  {
    id: "last_watched",
    label: "Last watched",
    defaultWidth: 110,
    render: (row) => synthOr(row, formatDateShort(row.file.last_watched_at)),
    sortKey: (row) => row.file.last_watched_at ?? 0,
  },
  {
    id: "added",
    label: "Added",
    defaultWidth: 110,
    render: (row) => synthOr(row, formatDateShort(row.file.added_at)),
    sortKey: (row) => row.file.added_at,
  },
  {
    id: "genres",
    label: "Genres",
    defaultWidth: 180,
    render: (row) => synthOr(row, row.identity.genres.slice(0, 3).join(", ")),
    sortKey: (row) => row.identity.genres.join(",").toLowerCase(),
  },
  {
    id: "tags",
    label: "Tags",
    defaultWidth: 180,
    render: (row) =>
      synthOr(
        row,
        (() => {
          const t = row.tags;
          if (t.length === 0) return "";
          if (t.length <= 3) return t.join(", ");
          return `${t.slice(0, 3).join(", ")} …`;
        })(),
      ),
    sortKey: (row) => row.tags.join(",").toLowerCase(),
  },
  {
    id: "collections",
    label: "Collections",
    defaultWidth: 160,
    render: (row) =>
      synthOr(row, row.collections.map((c) => c.collection_name).join(", ")),
    sortKey: (row) => row.collections.map((c) => c.collection_name).join(",").toLowerCase(),
  },
  {
    id: "series",
    label: "Series",
    defaultWidth: 140,
    render: (row) => row.series?.series_name ?? "",
    sortKey: (row) => row.series?.series_name.toLowerCase() ?? "",
  },
  {
    id: "path",
    label: "Path",
    defaultWidth: 400,
    render: (row) => (
      <span className="font-mono text-[10px]" title={row.file.path}>
        {row.file.path}
      </span>
    ),
    sortKey: (row) => row.file.path.toLowerCase(),
  },
];

export const DEFAULT_VISIBLE_COLUMNS: ColumnId[] = [
  "title",
  "year",
  "runtime",
  "resolution",
  "profile",
  "watched",
  "progress",
  "tags",
  "added",
];

interface Props {
  rows: LibraryRow[];
  selectedFileIds: Set<number>;
  primarySelectedId: number | null;
  visibleColumns: ColumnId[];
  columnWidths: Partial<Record<ColumnId, number>>;
  sortBy: { column: ColumnId; ascending: boolean };
  /** When true, ignore sortBy and render rows in incoming order. Used by
   *  the parent to keep series-scope ordering in sync with the thumbnail
   *  view (which doesn't sort). */
  respectIncomingOrder?: boolean;
  /** When set, prepends a leftmost drag-handle (and optionally a "#"
   *  column for series). Drag-drop on rows reorders the list and fires
   *  onReorderRows with the new identity-id sequence. */
  reorderMode?: "series-numbered" | "collection" | null;
  onReorderRows?: (orderedIdentityIds: number[]) => void;
  /** Identity-ids currently waiting on a TMDb refresh — receives a
   *  small inline spinner next to the title cell. */
  refreshingIdentityIds?: Set<number>;
  /** Identity-id → "S.E" label for the # column when in a seasons-on
   *  series scope. */
  episodeLabels?: Map<number, string>;
  /** Season group metadata — used to insert "Season N" header rows
   *  between groups. */
  seasonGroups?: { season: number; firstRowIndex: number; count: number }[];
  /** Bumping counter — view scrolls to row `idx` when `n` changes. */
  jumpToRowIndex?: { idx: number; n: number };
  onSortByChange: (next: { column: ColumnId; ascending: boolean }) => void;
  onColumnWidthChange: (id: ColumnId, width: number) => void;
  /** Called with the new column-id order after a drag-and-drop reorder. */
  onColumnReorder: (next: ColumnId[]) => void;
  onPick: (
    fileId: number,
    modifiers: { ctrl: boolean; shift: boolean },
  ) => void;
  onPlay: (row: LibraryRow) => void;
  onContextMenu: (row: LibraryRow, x: number, y: number) => void;
  onHeaderContextMenu: (x: number, y: number) => void;
}

/**
 * Resizable + reorderable column view. Reordering is driven from the
 * `visibleColumns` prop (parent owns the order); resizing emits widths up
 * via `onColumnWidthChange`. Horizontal scroll kicks in when total width
 * exceeds the viewport.
 */
export function LibraryColumnView({
  rows,
  selectedFileIds,
  primarySelectedId,
  visibleColumns,
  columnWidths,
  sortBy,
  respectIncomingOrder,
  reorderMode,
  onReorderRows,
  refreshingIdentityIds,
  episodeLabels,
  seasonGroups,
  jumpToRowIndex,
  onSortByChange,
  onColumnWidthChange,
  onColumnReorder,
  onPick,
  onPlay,
  onContextMenu,
  onHeaderContextMenu,
}: Props) {
  const specs = visibleColumns
    .map((id) => ALL_COLUMNS.find((c) => c.id === id))
    .filter((s): s is ColumnSpec => s != null);

  const sorted = respectIncomingOrder ? rows : sortRows(rows, sortBy);

  // Per-row refs for the "Jump to season" feature. We attach a ref to
  // each TR; when jumpToRowIndex bumps we call scrollIntoView on the
  // matching row.
  const rowRefs = useRef<Map<number, HTMLTableRowElement | null>>(new Map());
  useEffect(() => {
    if (!jumpToRowIndex || jumpToRowIndex.idx < 0) return;
    const el = rowRefs.current.get(jumpToRowIndex.idx);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpToRowIndex?.n]);

  // Map of "this row index starts a new season" → season number.
  const seasonStartsAt = (() => {
    const m = new Map<number, number>();
    if (seasonGroups) for (const g of seasonGroups) m.set(g.firstRowIndex, g.season);
    return m;
  })();

  // Row-reorder state. CRITICAL: rowDragId is a useRef, NOT useState.
  // React state updates are async — if we stored the drag source in
  // useState, the OTHER row's onDragOver closure would still see the
  // pre-dragstart value (null) on the first few dragover ticks, so the
  // early-return path would fire, skip preventDefault, and HTML5 would
  // then refuse to deliver further dragover events to that element.
  // useRef updates synchronously and any handler reading .current sees
  // the freshest value. rowDropTargetId stays in state since its only
  // purpose is to drive the drop-indicator visual.
  const ROW_DRAG_MIME = "application/x-fvp-row-reorder";
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
    const ids = sorted.map((r) => r.identity.id);
    const srcIdx = ids.indexOf(sourceIdentityId);
    const tgtIdx = ids.indexOf(targetIdentityId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const desiredSlot = side === "after" ? tgtIdx + 1 : tgtIdx;
    if (desiredSlot === srcIdx || desiredSlot === srcIdx + 1) return;
    ids.splice(srcIdx, 1);
    const insertIdx = desiredSlot > srcIdx ? desiredSlot - 1 : desiredSlot;
    ids.splice(insertIdx, 0, sourceIdentityId);
    onReorderRows(ids);
  };

  // ── @dnd-kit row drag (Wave 1 of Path A) ─────────────────────────────
  // Pointer-event-based drag-reorder via @dnd-kit, replacing the
  // HTML5 path. HTML5 dragstart/dragover/drop are suppressed on
  // Windows when tauri's `dragDropEnabled: true` (which we need ON
  // for Explorer→app file drops). @dnd-kit uses pointer events so
  // both can coexist. PointerSensor's `distance` constraint of 6px
  // means a stationary click goes through as onClick — only an
  // actual drag activates sortable.
  const sortableSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );
  const sortableIds = sorted.map((r) => r.identity.id);
  const handleSortableDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    if (!onReorderRows) return;
    const ids = sorted.map((r) => r.identity.id);
    const oldIdx = ids.indexOf(Number(active.id));
    const newIdx = ids.indexOf(Number(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(ids, oldIdx, newIdx);
    onReorderRows(next);
  };

  // Track which column the user is dragging so we can show drop hints.
  // Same useRef pattern as row reorder — state-based tracking has
  // first-tick lag that breaks dragover delivery in some webviews.
  const draggingIdRef = useRef<ColumnId | null>(null);
  const [draggingId, setDraggingId] = useState<ColumnId | null>(null);
  const [dropHintAfter, setDropHintAfter] = useState<ColumnId | null>(null);

  const handleDrop = (targetId: ColumnId) => {
    const src = draggingIdRef.current;
    if (!src || src === targetId) {
      draggingIdRef.current = null;
      setDraggingId(null);
      setDropHintAfter(null);
      return;
    }
    const fromIdx = visibleColumns.indexOf(src);
    const toIdx = visibleColumns.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) {
      draggingIdRef.current = null;
      setDraggingId(null);
      setDropHintAfter(null);
      return;
    }
    const next = [...visibleColumns];
    next.splice(fromIdx, 1);
    // Insert BEFORE the target (matches the drop-indicator visual on
    // the target's LEFT edge). After splicing out fromIdx, indices
    // greater than fromIdx shift down by 1, so adjust accordingly.
    const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
    next.splice(insertAt, 0, src);
    onColumnReorder(next);
    draggingIdRef.current = null;
    setDraggingId(null);
    setDropHintAfter(null);
  };

  return (
    <div className="overflow-x-auto overflow-y-auto h-full">
      <table className="text-xs border-collapse" style={{ minWidth: "100%" }}>
        <thead>
          <tr
            className="bg-fvp-surface sticky top-0 z-10"
            onContextMenu={(e) => {
              e.preventDefault();
              onHeaderContextMenu(e.clientX, e.clientY);
            }}
          >
            {reorderMode && (
              <th
                className="text-left px-1 py-1.5 text-[10px] text-fvp-muted border-b border-fvp-border select-none w-6"
                title="Drag to reorder"
              >
                {/* tiny drag-handle column header (no label) */}
              </th>
            )}
            {reorderMode === "series-numbered" && (
              <th
                className="text-left px-2 py-1.5 text-[10px] uppercase tracking-wider text-fvp-muted border-b border-fvp-border select-none w-10"
                title="Position within the series"
              >
                #
              </th>
            )}
            {specs.map((c) => (
              <ColumnHeader
                key={c.id}
                spec={c}
                width={columnWidths[c.id] ?? c.defaultWidth}
                sortActive={sortBy.column === c.id}
                sortAscending={sortBy.ascending}
                isDragging={draggingId === c.id}
                isDropTarget={dropHintAfter === c.id}
                onDragStart={() => {
                  draggingIdRef.current = c.id;
                  setDraggingId(c.id);
                }}
                onDragOver={() => setDropHintAfter(c.id)}
                onDragEnd={() => {
                  draggingIdRef.current = null;
                  setDraggingId(null);
                  setDropHintAfter(null);
                }}
                onDrop={() => handleDrop(c.id)}
                onSortChange={() => {
                  if (sortBy.column === c.id) {
                    onSortByChange({ column: c.id, ascending: !sortBy.ascending });
                  } else {
                    onSortByChange({ column: c.id, ascending: true });
                  }
                }}
                onWidthChange={(w) => onColumnWidthChange(c.id, w)}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {/* When reorderMode is on, wrap the body rows in a dnd-kit
              DndContext + SortableContext so the row drag goes through
              pointer events instead of HTML5 drag (which is suppressed
              by Tauri's dragDropEnabled=true on Windows). The body
              renders identical markup either way — just the
              <SortableTr> wrapper differs. */}
          {reorderMode && (
            <DndContext
              sensors={sortableSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleSortableDragEnd}
            >
              <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                {sorted.map((row, idx) => {
                  const selected = selectedFileIds.has(row.file.id);
                  const isPrimary = primarySelectedId === row.file.id;
                  const seasonStart = seasonStartsAt.get(idx);
                  const totalCols =
                    specs.length + 1 + (reorderMode === "series-numbered" ? 1 : 0);
                  return (
                    <Fragment key={row.file.id}>
                      {seasonStart != null && (
                        <tr className="bg-fvp-accent/15 border-y border-fvp-accent/40">
                          <td
                            colSpan={totalCols}
                            className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-fvp-accent"
                          >
                            Season {seasonStart}
                          </td>
                        </tr>
                      )}
                      <SortableTr
                        id={row.identity.id}
                        rowRefs={rowRefs}
                        idx={idx}
                        className={clsx(
                          "border-b border-fvp-border/40 cursor-pointer",
                          selected
                            ? isPrimary
                              ? "bg-fvp-accent/30 text-fvp-text"
                              : "bg-fvp-accent/15 text-fvp-text"
                            : "hover:bg-fvp-surface2/40",
                          row.file.drift_warning && "border-l-2 border-l-fvp-warn",
                        )}
                        onClick={(e) =>
                          onPick(row.file.id, {
                            ctrl: e.ctrlKey || e.metaKey,
                            shift: e.shiftKey,
                          })
                        }
                        onDoubleClick={() => onPlay(row)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!selected) {
                            onPick(row.file.id, { ctrl: false, shift: false });
                          }
                          onContextMenu(row, e.clientX, e.clientY);
                        }}
                      >
                        <td
                          className="px-1 text-center text-fvp-muted cursor-grab w-6 select-none"
                          title="Drag this row to reorder."
                        >
                          ⋮⋮
                        </td>
                        {reorderMode === "series-numbered" && (
                          <td className="px-2 text-fvp-muted text-[11px] w-14 text-right tabular-nums">
                            {episodeLabels?.get(row.file.id) ?? idx + 1}
                          </td>
                        )}
                        {specs.map((c) => {
                          const isTitle = c.id === "title";
                          const showSpinner =
                            isTitle && refreshingIdentityIds?.has(row.identity.id);
                          return (
                            <td
                              key={c.id}
                              className="px-2 py-1.5 truncate"
                              style={{
                                width: columnWidths[c.id] ?? c.defaultWidth,
                                maxWidth: columnWidths[c.id] ?? c.defaultWidth,
                              }}
                            >
                              {showSpinner ? (
                                <span className="inline-flex items-center gap-1.5">
                                  <span
                                    className="inline-block w-2.5 h-2.5 border-2 border-fvp-accent border-t-transparent rounded-full animate-spin"
                                    title="Refreshing metadata from TMDb…"
                                    aria-hidden
                                  />
                                  {c.render(row)}
                                </span>
                              ) : (
                                c.render(row)
                              )}
                            </td>
                          );
                        })}
                      </SortableTr>
                    </Fragment>
                  );
                })}
              </SortableContext>
            </DndContext>
          )}
          {!reorderMode && sorted.map((row, idx) => {
            const selected = selectedFileIds.has(row.file.id);
            const isPrimary = primarySelectedId === row.file.id;
            const isDropTargetRow =
              rowDropTargetId === row.identity.id &&
              rowDragIdRef.current !== row.identity.id;
            const seasonStart = seasonStartsAt.get(idx);
            // Non-reorder path — no drag-handle column.
            const totalCols = specs.length;
            return (
              <Fragment key={row.file.id}>
              {seasonStart != null && (
                <tr className="bg-fvp-accent/15 border-y border-fvp-accent/40">
                  <td
                    colSpan={totalCols}
                    className="px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-fvp-accent"
                  >
                    Season {seasonStart}
                  </td>
                </tr>
              )}
              <tr
                ref={(el) => {
                  rowRefs.current.set(idx, el);
                }}
                draggable
                onDragStart={(e) => {
                  if (reorderMode) {
                    actlog(
                      "col-view",
                      `row drag-start identity_id=${row.identity.id} reorderMode=${reorderMode}`,
                    );
                    // Whole row is draggable for reorder — the ⋮⋮ td
                    // is just a visual affordance. We still also set
                    // the MIME so legacy listeners work, but the live
                    // state in rowDragId is what dragover/drop check.
                    e.dataTransfer.setData(
                      ROW_DRAG_MIME,
                      String(row.identity.id),
                    );
                    e.dataTransfer.effectAllowed = "move";
                    rowDragIdRef.current = row.identity.id;
                    return;
                  }
                  // Identity drag (add to collection/series via drop
                  // targets in sidebar). Suppressed when row reorder
                  // mode owns drags.
                  let ids: number[];
                  if (selected && selectedFileIds.size > 1) {
                    ids = Array.from(
                      new Set(
                        sorted
                          .filter((r) => selectedFileIds.has(r.file.id))
                          .map((r) => r.identity.id),
                      ),
                    );
                  } else {
                    ids = [row.identity.id];
                  }
                  setIdentityDragData(e.dataTransfer, ids);
                }}
                onDragEnd={
                  reorderMode
                    ? () => {
                        rowDragIdRef.current = null;
                        setRowDropTargetId(null);
                      }
                    : undefined
                }
                onDragOver={
                  reorderMode
                    ? (e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        const srcId = rowDragIdRef.current;
                        if (srcId == null) return;
                        // Cursor on TOP half → drop above this row,
                        // BOTTOM half → drop below. Bottom-half on the
                        // last row is what lets the user place an item
                        // at the end of the list.
                        const rect = e.currentTarget.getBoundingClientRect();
                        const side: "before" | "after" =
                          e.clientY - rect.top > rect.height / 2 ? "after" : "before";
                        rowDropSideRef.current = side;
                        if (rowDropTargetId !== row.identity.id) {
                          setRowDropTargetId(row.identity.id);
                        }
                        if (rowDropSide !== side) {
                          setRowDropSide(side);
                        }
                      }
                    : undefined
                }
                onDragLeave={
                  reorderMode
                    ? () => {
                        if (rowDropTargetId === row.identity.id) {
                          setRowDropTargetId(null);
                        }
                      }
                    : undefined
                }
                onDrop={
                  reorderMode
                    ? (e) => {
                        e.preventDefault();
                        const sourceId = rowDragIdRef.current;
                        if (sourceId != null) {
                          actlog(
                            "col-view",
                            `row drop src=${sourceId} tgt=${row.identity.id} side=${rowDropSideRef.current}`,
                          );
                          commitRowReorder(sourceId, row.identity.id, rowDropSideRef.current);
                        }
                        rowDragIdRef.current = null;
                        setRowDropTargetId(null);
                      }
                    : undefined
                }
                onClick={(e) =>
                  onPick(row.file.id, {
                    ctrl: e.ctrlKey || e.metaKey,
                    shift: e.shiftKey,
                  })
                }
                onDoubleClick={() => onPlay(row)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selected) {
                    onPick(row.file.id, { ctrl: false, shift: false });
                  }
                  onContextMenu(row, e.clientX, e.clientY);
                }}
                className={clsx(
                  "border-b border-fvp-border/40 cursor-pointer",
                  selected
                    ? isPrimary
                      ? "bg-fvp-accent/30 text-fvp-text"
                      : "bg-fvp-accent/15 text-fvp-text"
                    : "hover:bg-fvp-surface2/40",
                  row.file.drift_warning && "border-l-2 border-l-fvp-warn",
                  isDropTargetRow && rowDropSide === "before" && "border-t-2 border-t-fvp-accent",
                  isDropTargetRow && rowDropSide === "after" && "border-b-2 border-b-fvp-accent",
                )}
              >
                {/* No drag-handle / episode-label tds in the non-reorder
                    branch — those are exclusive to the SortableTr path. */}
                {specs.map((c) => {
                  const isTitle = c.id === "title";
                  const showSpinner =
                    isTitle && refreshingIdentityIds?.has(row.identity.id);
                  return (
                    <td
                      key={c.id}
                      className="px-2 py-1.5 truncate"
                      style={{
                        width: columnWidths[c.id] ?? c.defaultWidth,
                        maxWidth: columnWidths[c.id] ?? c.defaultWidth,
                      }}
                    >
                      {showSpinner ? (
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            className="inline-block w-2.5 h-2.5 border-2 border-fvp-accent border-t-transparent rounded-full animate-spin"
                            title="Refreshing metadata from TMDb…"
                            aria-hidden
                          />
                          {c.render(row)}
                        </span>
                      ) : (
                        c.render(row)
                      )}
                    </td>
                  );
                })}
              </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Sortable `<tr>` wrapper using @dnd-kit. Used only in reorderMode.
 *  Pointer-event-based — coexists with Tauri's dragDropEnabled=true
 *  IDropTarget on WebView2 (HTML5 drag wouldn't). The PointerSensor's
 *  6px activation distance lets a stationary click still fire onClick
 *  via the row's existing handler. */
function SortableTr({
  id,
  rowRefs,
  idx,
  className,
  onClick,
  onDoubleClick,
  onContextMenu,
  children,
}: {
  id: number;
  rowRefs: React.MutableRefObject<Map<number, HTMLTableRowElement | null>>;
  idx: number;
  className?: string;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
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
    <tr
      ref={(el) => {
        setNodeRef(el);
        rowRefs.current.set(idx, el);
      }}
      style={style}
      className={className}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      {...attributes}
      {...listeners}
    >
      {children}
    </tr>
  );
}

function sortRows(
  rows: LibraryRow[],
  sort: { column: ColumnId; ascending: boolean },
): LibraryRow[] {
  const spec = ALL_COLUMNS.find((c) => c.id === sort.column);
  if (!spec) return rows;
  const sorted = [...rows].sort((a, b) => {
    const av = spec.sortKey(a);
    const bv = spec.sortKey(b);
    if (typeof av === "number" && typeof bv === "number") {
      return av - bv;
    }
    return String(av).localeCompare(String(bv));
  });
  if (!sort.ascending) sorted.reverse();
  return sorted;
}

function ColumnHeader({
  spec,
  width,
  sortActive,
  sortAscending,
  isDragging,
  isDropTarget,
  onSortChange,
  onWidthChange,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  spec: ColumnSpec;
  width: number;
  sortActive: boolean;
  sortAscending: boolean;
  isDragging: boolean;
  isDropTarget: boolean;
  onSortChange: () => void;
  onWidthChange: (w: number) => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  // Resize drag handlers — track at the document level so the mouse can
  // leave the header bar without losing the drag.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = e.clientX - dragRef.current.startX;
      const next = Math.max(40, dragRef.current.startW + dx);
      onWidthChange(next);
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onWidthChange]);

  // Track whether a mousedown has moved past a small threshold — if so,
  // we treat the gesture as a column-drag and suppress the sort-click.
  // HTML5 onDragStart fires automatically when the user actually moves
  // the cursor; the issue we're guarding against is that a button-style
  // child element absorbs the mousedown and never lets HTML5 drag start.
  // Solution: use a div, not a button, and let the entire th be the
  // draggable + clickable surface.
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const draggedRef = useRef(false);

  return (
    <th
      draggable
      onMouseDown={(e) => {
        downRef.current = { x: e.clientX, y: e.clientY };
        draggedRef.current = false;
      }}
      onMouseMove={(e) => {
        if (!downRef.current) return;
        const dx = Math.abs(e.clientX - downRef.current.x);
        const dy = Math.abs(e.clientY - downRef.current.y);
        if (dx + dy > 4) draggedRef.current = true;
      }}
      onClick={(e) => {
        // Distinguish click-to-sort from drag-release. We only fire the
        // sort change when the mouse stayed still between down and up.
        if (draggedRef.current) {
          e.preventDefault();
          return;
        }
        onSortChange();
      }}
      onDragStart={(e) => {
        actlog("col-view", `column-header drag-start ${spec.id}`);
        e.dataTransfer.setData("text/plain", spec.id);
        e.dataTransfer.effectAllowed = "move";
        draggedRef.current = true;
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDragEnd={() => {
        downRef.current = null;
        draggedRef.current = false;
        onDragEnd();
      }}
      onDrop={(e) => {
        actlog("col-view", `column-header drop tgt=${spec.id}`);
        e.preventDefault();
        onDrop();
      }}
      className={clsx(
        "text-left px-2 py-1.5 text-[10px] uppercase tracking-wider text-fvp-muted border-b border-fvp-border relative select-none cursor-move hover:text-fvp-text",
        isDragging && "opacity-40",
        isDropTarget && "bg-fvp-accent/15",
      )}
      style={{ width, minWidth: width, maxWidth: width }}
      title="Click to sort · drag to reorder · right-click for column list"
    >
      {/* Drop indicator — vertical accent bar on the LEFT edge of the
          target column, mirroring the row-reorder drop indicator. The
          column will land HERE on release. */}
      {isDropTarget && !isDragging && (
        <div className="absolute left-0 top-0 bottom-0 w-1 bg-fvp-accent rounded-full pointer-events-none z-10" />
      )}
      <span className="block w-full">
        {spec.label}
        {sortActive && (
          <span className="ml-1 text-fvp-accent">
            {sortAscending ? "▲" : "▼"}
          </span>
        )}
      </span>
      {/* Resize handle on the right edge. Stops propagation so the
          mousedown doesn't also kick off a column-drag operation. */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          dragRef.current = { startX: e.clientX, startW: width };
        }}
        // The handle itself should NOT be draggable — otherwise HTML5
        // drag-drop kicks in over the resize gesture.
        draggable={false}
        onDragStart={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-fvp-accent/40 z-10"
        title="Drag to resize"
      />
    </th>
  );
}

const MAPS_TIER_PILL_STYLES: Record<string, { label: string; cls: string }> = {
  family: { label: "Family", cls: "bg-fvp-ok/20 text-fvp-ok" },
  teen: { label: "Teen", cls: "bg-yellow-500/20 text-yellow-500" },
  adult: { label: "Adult", cls: "bg-orange-500/20 text-orange-400" },
  married_adult: {
    label: "Married Adult",
    cls: "bg-fvp-err/20 text-fvp-err",
  },
  degrading: {
    label: "Degrading",
    cls: "bg-gray-800/40 text-gray-300 border border-gray-700",
  },
};

function MapsTierPill({ tier }: { tier: string }) {
  const cfg = MAPS_TIER_PILL_STYLES[tier] ?? {
    label: tier,
    cls: "bg-fvp-surface2 text-fvp-muted",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${cfg.cls}`}>
      {cfg.label}
    </span>
  );
}

/** Sort rank for MAPS tiers — family-friendliest first. */
function mapsTierRank(tier: string | null): number {
  switch (tier) {
    case "family":
      return 1;
    case "teen":
      return 2;
    case "adult":
      return 3;
    case "married_adult":
      return 4;
    case "degrading":
      return 5;
    default:
      return 0;
  }
}
