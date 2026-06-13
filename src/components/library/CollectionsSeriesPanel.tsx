import { useCallback, useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  type CollectionRow,
  type LibraryRow,
  type SeriesRow,
} from "../../ipc/library";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import {
  getIdentityDragData,
  setSidebarReorderData,
  getSidebarReorderData,
} from "./dragKinds";
import { diag } from "../../utils/uiErrorReporter";
import { SmartTmdbReviewModal } from "./SmartTmdbReviewModal";

export interface ActiveScope {
  kind: "all" | "collection" | "series";
  id: number | null;
  name: string | null;
}

interface Props {
  refreshToken: number;
  activeScope: ActiveScope;
  onScopeChange: (s: ActiveScope) => void;
  /** Library rows the parent already loaded; lets us match dropped paths
   *  to existing identities without a round-trip per call. */
  rows: LibraryRow[];
  /** Parent re-fetches list/collections/series whenever members change. */
  onMembershipChanged: () => void;
  /** When true, hide collections/series flagged non_family_friendly
   *  AND those whose member set is entirely non-family-friendly. */
  familyViewOn: boolean;
  /** Library-wide actions that show up in the right-click menu for
   *  All Movies / Collections / Series headers. Wired in the parent
   *  (Library.tsx) so all menu wiring goes through one place. */
  onRescanLibrary?: () => void;
  onRemoveBrokenLinks?: () => void;
  onOpenAnalytics?: () => void;
  onOpenFvpWebsite?: () => void;
  /** Right-click → "Rescan member folders" on a collection or series.
   *  Caller resolves the unique set of watched-folder roots that own
   *  any member identity and re-enqueues each. */
  onRescanScope?: (kind: "collection" | "series", id: number) => void;
  /** Right-click → "Refresh metadata for all members" on a collection
   *  or series. Caller collects every identity_id in the scope and
   *  fires the bulk refreshManyMetadata helper. */
  onRefreshScopeMetadata?: (kind: "collection" | "series", id: number) => void;
}

const VIDEO_EXTENSIONS = [
  "mkv", "mp4", "avi", "mov", "m4v", "webm",
  "wmv", "flv", "mpg", "mpeg", "ts", "m2ts",
];

/**
 * Sidebar panel listing Collections + Series. Each item is a click-target
 * that scopes the main library to its members. Right-click for rename /
 * add files / add folders / delete via a proper ContextMenu (no more
 * window.prompt ugliness).
 *
 * Spacers between the All Movies row, the Collections group, and the
 * Series group make the three categories read as visually distinct
 * from the Filters & Search section below.
 */
export function CollectionsSeriesPanel({
  refreshToken,
  activeScope,
  onScopeChange,
  rows,
  onMembershipChanged,
  familyViewOn,
  onRescanLibrary,
  onRemoveBrokenLinks,
  onOpenAnalytics,
  onOpenFvpWebsite,
  onRescanScope,
  onRefreshScopeMetadata,
}: Props) {
  const showToast = useAppStore((s) => s.showToast);
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [series, setSeries] = useState<SeriesRow[]>([]);
  const [creating, setCreating] = useState<null | "collection" | "series">(
    null,
  );
  const [draftName, setDraftName] = useState("");
  // Inline filter for the Series list. Survives collapsing/expanding
  // the Series section (useState lifetime = panel mount). Cleared by
  // the "×" button in the input itself.
  const [seriesSearch, setSeriesSearch] = useState("");
  const [renaming, setRenaming] = useState<
    | null
    | { kind: "collection"; id: number; current: string }
    | { kind: "series"; id: number; current: string }
  >(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [smartTmdb, setSmartTmdb] = useState<{
    kind: "collection" | "series";
    id: number;
    name: string;
  } | null>(null);

  const reload = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        libraryIpc.listCollections(),
        libraryIpc.listSeries(),
      ]);
      setCollections(c);
      setSeries(s);
    } catch (err) {
      showToast(`Load collections/series failed: ${err}`, "error");
    }
  }, [showToast]);

  useEffect(() => {
    void reload();
  }, [reload, refreshToken]);

  // ── Create flows ────────────────────────────────────────────────
  // After creating a collection / series, immediately scope to it so
  // the user lands inside the new group ready to add items — saves
  // them a second click to find it in the sidebar.
  const createCollection = async () => {
    const name = draftName.trim();
    if (!name) return;
    try {
      const newId = await libraryIpc.createCollection(name);
      setDraftName("");
      setCreating(null);
      await reload();
      onScopeChange({ kind: "collection", id: newId, name });
    } catch (err) {
      showToast(`Create failed: ${err}`, "error");
    }
  };
  const createSeries = async () => {
    const name = draftName.trim();
    if (!name) return;
    try {
      const newId = await libraryIpc.createSeries(name, false);
      setDraftName("");
      setCreating(null);
      await reload();
      onScopeChange({ kind: "series", id: newId, name });
    } catch (err) {
      showToast(`Create failed: ${err}`, "error");
    }
  };

  // ── Delete flow (with confirmation modal) ───────────────────────
  const deleteCollection = async (c: CollectionRow) => {
    if (
      !window.confirm(
        `Delete collection "${c.name}"?\n\nMovies stay in the library — only the collection grouping is removed.`,
      )
    )
      return;
    try {
      await libraryIpc.deleteCollection(c.id);
      if (activeScope.kind === "collection" && activeScope.id === c.id) {
        onScopeChange({ kind: "all", id: null, name: null });
      }
      await reload();
      onMembershipChanged();
    } catch (err) {
      showToast(`Delete failed: ${err}`, "error");
    }
  };
  const deleteSeries = async (s: SeriesRow) => {
    if (
      !window.confirm(
        `Delete series "${s.name}"?\n\nMovies stay in the library (they'll reappear in All Movies) — only the series grouping is removed.`,
      )
    )
      return;
    try {
      await libraryIpc.deleteSeries(s.id);
      if (activeScope.kind === "series" && activeScope.id === s.id) {
        onScopeChange({ kind: "all", id: null, name: null });
      }
      await reload();
      onMembershipChanged();
    } catch (err) {
      showToast(`Delete failed: ${err}`, "error");
    }
  };

  // ── Add-files / add-folders flows shared by collection + series ─
  const addFilesTo = async (
    kind: "collection" | "series",
    id: number,
    name: string,
  ) => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "Video", extensions: VIDEO_EXTENSIONS }],
    });
    const paths =
      typeof picked === "string"
        ? [picked]
        : Array.isArray(picked)
          ? picked
          : [];
    if (paths.length === 0) return;
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const wanted = new Set(paths.map(norm));
    const matching = Array.from(
      new Set(
        rows
          .filter((r) => wanted.has(norm(r.file.path)))
          .map((r) => r.identity.id),
      ),
    );
    if (matching.length === 0) {
      showToast(
        "Pick files that are already indexed (in a watched library folder). To bring in new files first, add the folder via Settings → Library.",
        "warn",
        5500,
      );
      return;
    }
    try {
      if (kind === "collection") {
        await libraryIpc.addToCollection(id, matching);
      } else {
        await libraryIpc.addToSeries(id, matching);
      }
      showToast(
        `Added ${matching.length} movie${matching.length === 1 ? "" : "s"} to "${name}"`,
        "info",
        3000,
      );
      onMembershipChanged();
    } catch (err) {
      showToast(`Add failed: ${err}`, "error");
    }
  };
  const addFolderTo = async (
    kind: "collection" | "series",
    id: number,
    name: string,
  ) => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      // Index the folder first if it isn't already (so its videos
      // become identities we can wire to the group). add_folder is
      // idempotent — if it's already a watched folder, just no-ops.
      try {
        await libraryIpc.addFolder(picked, true);
        showToast(
          `Indexing ${picked} — adding to ${kind} as it scans.`,
          "info",
          3500,
        );
      } catch {
        // Already watched.
      }
      // Pull a fresh row list so identities under `picked` are visible.
      const fresh = await libraryIpc.listItems();
      const norm = picked.replace(/\\/g, "/").toLowerCase();
      const matching = Array.from(
        new Set(
          fresh
            .filter((r) =>
              r.file.path
                .replace(/\\/g, "/")
                .toLowerCase()
                .startsWith(norm),
            )
            .map((r) => r.identity.id),
        ),
      );
      if (matching.length === 0) {
        showToast(
          "No indexed videos found in that folder yet — try again after the scan completes.",
          "warn",
          4500,
        );
        return;
      }
      if (kind === "collection") {
        await libraryIpc.addToCollection(id, matching);
      } else {
        await libraryIpc.addToSeries(id, matching);
      }
      showToast(
        `Added ${matching.length} movie${matching.length === 1 ? "" : "s"} from folder to "${name}"`,
        "info",
        3500,
      );
      onMembershipChanged();
    } catch (err) {
      showToast(`Add folder failed: ${err}`, "error");
    }
  };

  // ── Right-click menus ───────────────────────────────────────────
  // Smart TMDb only works when at least one group member already has a
  // TMDb id — that's the "donor" the user needs to seed the heuristic.
  const groupHasDonor = (
    kind: "collection" | "series",
    id: number,
  ): boolean =>
    rows.some((r) => {
      if (r.identity.tmdb_id == null) return false;
      if (kind === "collection") {
        return r.collections.some((c) => c.collection_id === id);
      }
      return r.series?.series_id === id;
    });
  // Library-wide menu shared by All Movies / Collections / Series
  // headers in the sidebar. None of these actions are scope-specific,
  // so the same menu fits everywhere — the user doesn't have to think
  // about which scope they right-clicked.
  const libraryWideMenu = (): MenuItem[] => [
    {
      kind: "item",
      label: "Rescan library",
      title: "Re-walk every watched folder, pick up additions and removals.",
      disabled: !onRescanLibrary,
      onClick: () => onRescanLibrary?.(),
    },
    {
      kind: "item",
      label: "Remove broken links",
      title: "Drop every library row whose file is missing on disk.",
      disabled: !onRemoveBrokenLinks,
      onClick: () => onRemoveBrokenLinks?.(),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: "Analytics…",
      disabled: !onOpenAnalytics,
      onClick: () => onOpenAnalytics?.(),
    },
    {
      kind: "item",
      label: "Visit FVP website",
      title: "Opens freedomvideoplayer.com in your default browser.",
      disabled: !onOpenFvpWebsite,
      onClick: () => onOpenFvpWebsite?.(),
    },
  ];

  const collectionMenu = (c: CollectionRow): MenuItem[] => {
    const donor = groupHasDonor("collection", c.id);
    return [
      {
        kind: "item",
        label: "Rename…",
        onClick: () =>
          setRenaming({ kind: "collection", id: c.id, current: c.name }),
      },
      {
        kind: "item",
        label: "Add files…",
        onClick: () => void addFilesTo("collection", c.id, c.name),
      },
      {
        kind: "item",
        label: "Add folder & subfolders…",
        onClick: () => void addFolderTo("collection", c.id, c.name),
      },
      {
        kind: "item",
        label: "Rescan member folders",
        title: "Re-walk every watched-folder root that contains a movie from this collection.",
        disabled: !onRescanScope,
        onClick: () => onRescanScope?.("collection", c.id),
      },
      {
        kind: "item",
        label: "Refresh metadata for all members",
        title: "Queue a TMDb metadata refresh for every movie in this collection.",
        disabled: !onRefreshScopeMetadata,
        onClick: () => onRefreshScopeMetadata?.("collection", c.id),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: `${c.non_family_friendly ? "✓ " : "    "}Non-family-friendly`,
        title: "Hides the whole collection in Family Mode.",
        onClick: () => {
          void libraryIpc
            .setScopeNff("collection", c.id, !c.non_family_friendly)
            .then(reload)
            .catch((err) => showToast(`${err}`, "error"));
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Smart TMDb search…",
        title: donor
          ? "Use already-matched members as a hint to find TMDb matches for the rest"
          : "Match at least one member manually first (Replace metadata from TMDb…) to use Smart Search.",
        disabled: !donor,
        onClick: () =>
          setSmartTmdb({ kind: "collection", id: c.id, name: c.name }),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Delete collection",
        onClick: () => void deleteCollection(c),
      },
    ];
  };
  const seriesMenu = (s: SeriesRow): MenuItem[] => {
    const donor = groupHasDonor("series", s.id);
    return [
      {
        kind: "item",
        label: "Rename…",
        onClick: () =>
          setRenaming({ kind: "series", id: s.id, current: s.name }),
      },
      {
        kind: "item",
        label: "Add files…",
        onClick: () => void addFilesTo("series", s.id, s.name),
      },
      {
        kind: "item",
        label: "Add folder & subfolders…",
        onClick: () => void addFolderTo("series", s.id, s.name),
      },
      {
        kind: "item",
        label: "Rescan member folders",
        title: "Re-walk every watched-folder root that contains an episode from this series.",
        disabled: !onRescanScope,
        onClick: () => onRescanScope?.("series", s.id),
      },
      {
        kind: "item",
        label: "Refresh metadata for all members",
        title: "Queue a TMDb metadata refresh for every episode in this series.",
        disabled: !onRefreshScopeMetadata,
        onClick: () => onRefreshScopeMetadata?.("series", s.id),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: `${s.non_family_friendly ? "✓ " : "    "}Non-family-friendly`,
        title: "Hides the whole series in Family Mode.",
        onClick: () => {
          void libraryIpc
            .setScopeNff("series", s.id, !s.non_family_friendly)
            .then(reload)
            .catch((err) => showToast(`${err}`, "error"));
        },
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Smart TMDb search…",
        title: donor
          ? "Use already-matched members as a hint to find TMDb matches for the rest"
          : "Match at least one member manually first (Replace metadata from TMDb…) to use Smart Search.",
        disabled: !donor,
        onClick: () =>
          setSmartTmdb({ kind: "series", id: s.id, name: s.name }),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Create collection from series",
        title:
          "Copies every member of this series into a new collection of the same name. The series itself is unchanged.",
        onClick: () => void createCollectionFromSeries(s),
      },
      { kind: "separator" },
      {
        kind: "item",
        label: "Delete series",
        onClick: () => void deleteSeries(s),
      },
    ];
  };

  /**
   * Build a new Collection that mirrors a Series. Per directive:
   * collections feel like a playlist (movies still display individually
   * in All Movies), so duplicating a series into a collection lets the
   * user surface its members in the main library view without losing
   * the series grouping. The series stays put; this is a copy, not a
   * conversion.
   *
   * Uses the rows prop the parent already loaded (no extra DB call).
   * Picks a default name with " — collection" suffix when a collection
   * with the same name already exists, so we never silently merge into
   * an unrelated collection.
   */
  const createCollectionFromSeries = async (s: SeriesRow) => {
    const memberIds = Array.from(
      new Set(
        rows
          .filter((r) => r.series?.series_id === s.id)
          .map((r) => r.identity.id),
      ),
    );
    if (memberIds.length === 0) {
      showToast(
        `"${s.name}" has no members to copy into a collection.`,
        "warn",
        3500,
      );
      return;
    }
    // Avoid silently merging into an existing collection with the same
    // name — suffix when there's a clash.
    const existing = new Set(collections.map((c) => c.name.toLowerCase()));
    let candidate = s.name;
    if (existing.has(candidate.toLowerCase())) {
      candidate = `${s.name} — collection`;
      let i = 2;
      while (existing.has(candidate.toLowerCase())) {
        candidate = `${s.name} — collection ${i}`;
        i++;
      }
    }
    try {
      const newId = await libraryIpc.createCollection(candidate);
      await libraryIpc.addToCollection(newId, memberIds);
      showToast(
        `Created collection "${candidate}" with ${memberIds.length} movie${memberIds.length === 1 ? "" : "s"} from "${s.name}".`,
        "info",
        3500,
      );
      // Refresh the sidebar and the parent's library list so the new
      // collection appears immediately and any per-row collection
      // membership chips update.
      await reload();
      onMembershipChanged();
    } catch (err) {
      showToast(`Couldn't create collection: ${err}`, "error");
    }
  };

  // ── Accordion expand/collapse state ──────────────────────────────
  // Only one of {collections, series} can be expanded at a time, per
  // directive: "user clicks Collections and it expands; then user clicks
  // Series — now series expands, and collections un-expands." When the
  // user clicks "All Movies" we collapse both. Default state: whichever
  // group contains the active scope is expanded so the sidebar lines up
  // with what the user is currently viewing.
  type ExpandedSection = "collections" | "series" | null;
  const [expanded, setExpanded] = useState<ExpandedSection>(() => {
    if (activeScope.kind === "collection") return "collections";
    if (activeScope.kind === "series") return "series";
    return null;
  });
  // Reflect external scope changes (e.g. user clicked a series synth
  // tile in the main library) by expanding the matching group.
  useEffect(() => {
    if (activeScope.kind === "collection" && expanded !== "collections") {
      setExpanded("collections");
    } else if (activeScope.kind === "series" && expanded !== "series") {
      setExpanded("series");
    } else if (activeScope.kind === "all" && expanded !== null) {
      setExpanded(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope.kind, activeScope.id]);

  // When Family Mode is on, hide groups flagged non_family_friendly
  // AND groups whose member set is ENTIRELY NFF (all members'
  // identities have non_family_friendly = true). Empty groups never
  // hide — the user might be partway through curating them.
  const familyHidden = (kind: "collection" | "series", id: number): boolean => {
    if (!familyViewOn) return false;
    const members =
      kind === "collection"
        ? rows.filter((r) => r.collections.some((c) => c.collection_id === id))
        : rows.filter((r) => r.series?.series_id === id);
    if (members.length === 0) return false;
    return members.every((r) => r.identity.non_family_friendly);
  };

  const visibleCollections = collections.filter(
    (c) => !c.non_family_friendly && !familyHidden("collection", c.id),
  );
  const visibleSeries = series.filter(
    (s) => !s.non_family_friendly && !familyHidden("series", s.id),
  );

  // Apply the inline series filter. Cheap O(N) — series count is
  // typically small. Case-insensitive substring match on name.
  const filteredSeries = (() => {
    const needle = seriesSearch.trim().toLowerCase();
    if (!needle) return visibleSeries;
    return visibleSeries.filter((s) =>
      s.name.toLowerCase().includes(needle),
    );
  })();

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="px-3 py-2 border-b border-fvp-border bg-fvp-surface text-xs">
      {/* ALL MOVIES — top-level header. Bold + caps, slightly larger
          than the FILTERS & SEARCH heading so the eye lands here first. */}
      <button
        onClick={() => onScopeChange({ kind: "all", id: null, name: null })}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({
            x: e.clientX,
            y: e.clientY,
            items: libraryWideMenu(),
          });
        }}
        className={
          "w-full text-left px-1.5 py-1 rounded text-[13px] font-bold uppercase tracking-wider transition-colors " +
          (activeScope.kind === "all"
            ? "bg-fvp-accent/30 text-fvp-text"
            : "text-fvp-text hover:bg-fvp-surface2/60")
        }
      >
        All Movies
      </button>

      {/* spacer */}
      <div className="h-2" />

      {/* Collections — header is itself a button that toggles the
          expand state. The "+" creator button is split out so clicking
          it doesn't accidentally collapse the list. */}
      <AccordionHeader
        label="Collections"
        expanded={expanded === "collections"}
        onToggle={() =>
          setExpanded(expanded === "collections" ? null : "collections")
        }
        onAdd={() => {
          setExpanded("collections");
          setDraftName("");
          setCreating("collection");
        }}
        count={collections.length}
        tooltip="Collections are playlist-style groupings. Movies you add to a collection STILL show individually in All Movies — the collection is just an additional way to browse them."
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, items: libraryWideMenu() });
        }}
      />
      {expanded === "collections" && (
        <div className="mb-1">
          {creating === "collection" && (
            <InlineCreator
              placeholder="Collection name…"
              value={draftName}
              onChange={setDraftName}
              onSubmit={() => void createCollection()}
              onCancel={() => {
                setCreating(null);
                setDraftName("");
              }}
            />
          )}
          {visibleCollections.length === 0 && creating !== "collection" && (
            <div className="text-[10px] text-fvp-muted italic px-1">
              {collections.length === 0
                ? "No collections yet."
                : "All collections hidden by Family Mode."}
            </div>
          )}
          {visibleCollections.map((c) => (
            <ScopeRow
              key={`coll-${c.id}`}
              reorderKind="collection"
              reorderId={c.id}
              label={c.name}
              countBadge={c.item_count}
              active={
                activeScope.kind === "collection" && activeScope.id === c.id
              }
              onClick={() =>
                onScopeChange({
                  kind: "collection",
                  id: c.id,
                  name: c.name,
                })
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: collectionMenu(c),
                });
              }}
              onDropIdentities={(ids) => {
                void libraryIpc
                  .addToCollection(c.id, ids)
                  .then(() => {
                    showToast(
                      `Added ${ids.length} movie${ids.length === 1 ? "" : "s"} to "${c.name}"`,
                      "info",
                      2500,
                    );
                    onMembershipChanged();
                  })
                  .catch((err) =>
                    showToast(`Add failed: ${err}`, "error"),
                  );
              }}
              onReorderDrop={(sourceId) => {
                const ordered = collections.map((x) => x.id);
                const srcIdx = ordered.indexOf(sourceId);
                const tgtIdx = ordered.indexOf(c.id);
                if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
                ordered.splice(srcIdx, 1);
                const insertIdx = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
                ordered.splice(insertIdx, 0, sourceId);
                void libraryIpc
                  .reorderCollections(ordered)
                  .then(() => void reload())
                  .catch((err) =>
                    showToast(`Reorder failed: ${err}`, "error"),
                  );
              }}
            />
          ))}
        </div>
      )}

      {/* spacer between Collections + Series groups */}
      <div className="h-2" />

      <AccordionHeader
        label="Series"
        expanded={expanded === "series"}
        onToggle={() =>
          setExpanded(expanded === "series" ? null : "series")
        }
        onAdd={() => {
          setExpanded("series");
          setDraftName("");
          setCreating("series");
        }}
        count={series.length}
        tooltip="Series act as a single bundled entity. When you add movies to a series, the individual movies STOP showing in All Movies — only the series tile appears. Click into the series to see its episodes."
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY, items: libraryWideMenu() });
        }}
      />
      {expanded === "series" && (
        <div className="mb-1">
          {creating === "series" && (
            <InlineCreator
              placeholder="Series name…"
              value={draftName}
              onChange={setDraftName}
              onSubmit={() => void createSeries()}
              onCancel={() => {
                setCreating(null);
                setDraftName("");
              }}
            />
          )}
          {/* Filter input only shown when the list is long enough that
              scanning by eye gets tedious (10+). For shorter lists the
              search bar would just be UI noise. */}
          {series.length >= 10 && (
            <div className="px-1 mb-1 relative">
              <input
                value={seriesSearch}
                onChange={(e) => setSeriesSearch(e.target.value)}
                placeholder="Filter series…"
                className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded pl-2 pr-6 py-0.5 text-[11px] text-fvp-text outline-none"
              />
              {seriesSearch && (
                <button
                  type="button"
                  onClick={() => setSeriesSearch("")}
                  title="Clear filter"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fvp-muted hover:text-fvp-text text-[12px] leading-none"
                >
                  ×
                </button>
              )}
            </div>
          )}
          {visibleSeries.length === 0 && creating !== "series" && (
            <div className="text-[10px] text-fvp-muted italic px-1">
              {series.length === 0
                ? "No series yet."
                : "All series hidden by Family Mode."}
            </div>
          )}
          {filteredSeries.length === 0 && seriesSearch.trim() !== "" && (
            <div className="text-[10px] text-fvp-muted italic px-1 py-1">
              No series match "{seriesSearch}".
            </div>
          )}
          {filteredSeries.map((s) => (
            <ScopeRow
              key={`ser-${s.id}`}
              reorderKind="series"
              reorderId={s.id}
              label={s.name}
              countBadge={s.item_count}
              active={
                activeScope.kind === "series" && activeScope.id === s.id
              }
              onClick={() =>
                onScopeChange({ kind: "series", id: s.id, name: s.name })
              }
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: seriesMenu(s),
                });
              }}
              onDropIdentities={(ids) => {
                void libraryIpc
                  .addToSeries(s.id, ids)
                  .then(() => {
                    showToast(
                      `Added ${ids.length} movie${ids.length === 1 ? "" : "s"} to "${s.name}"`,
                      "info",
                      2500,
                    );
                    onMembershipChanged();
                  })
                  .catch((err) =>
                    showToast(`Add failed: ${err}`, "error"),
                  );
              }}
              onReorderDrop={(sourceId) => {
                const ordered = series.map((x) => x.id);
                const srcIdx = ordered.indexOf(sourceId);
                const tgtIdx = ordered.indexOf(s.id);
                if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return;
                ordered.splice(srcIdx, 1);
                const insertIdx = srcIdx < tgtIdx ? tgtIdx - 1 : tgtIdx;
                ordered.splice(insertIdx, 0, sourceId);
                void libraryIpc
                  .reorderSeriesList(ordered)
                  .then(() => void reload())
                  .catch((err) =>
                    showToast(`Reorder failed: ${err}`, "error"),
                  );
              }}
            />
          ))}
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}

      {smartTmdb && (
        <SmartTmdbReviewModal
          groupKind={smartTmdb.kind}
          groupId={smartTmdb.id}
          groupName={smartTmdb.name}
          onResolved={() => {
            setSmartTmdb(null);
            onMembershipChanged();
          }}
        />
      )}

      {renaming && (
        <RenameDialog
          kind={renaming.kind}
          currentName={renaming.current}
          onCancel={() => setRenaming(null)}
          onConfirm={(newName) => {
            const op =
              renaming.kind === "collection"
                ? libraryIpc.renameCollection(renaming.id, newName)
                : libraryIpc.renameSeries(renaming.id, newName);
            void op
              .then(() => {
                setRenaming(null);
                void reload();
                // The active scope's display name needs to follow if
                // the user just renamed the currently-scoped group.
                if (
                  activeScope.kind === renaming.kind &&
                  activeScope.id === renaming.id
                ) {
                  onScopeChange({
                    kind: activeScope.kind,
                    id: activeScope.id,
                    name: newName,
                  });
                }
              })
              .catch((err) => showToast(`Rename failed: ${err}`, "error"));
          }}
        />
      )}
    </div>
  );
}

/**
 * Accordion-style section header. Clicking the label area toggles the
 * expand state; the "+" button is split so creating a new item doesn't
 * accidentally collapse the section. Caret rotates 90° when expanded.
 * Count badge surfaces how many items live under the header so the
 * user knows whether expanding is worthwhile.
 */
function AccordionHeader({
  label,
  expanded,
  count,
  onToggle,
  onAdd,
  tooltip,
  onContextMenu,
}: {
  label: string;
  expanded: boolean;
  count: number;
  onToggle: () => void;
  onAdd: () => void;
  /** Hover tooltip explaining how this grouping behaves vs the other —
   *  series collapse to one tile in All Movies, collections don't. */
  tooltip?: string;
  /** Right-click → opens the library-wide menu (Rescan, Remove broken,
   *  Analytics, FVP site). The header itself is a passive label; the
   *  right-click is a known affordance Windows users expect. */
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  return (
    <div className="flex items-center justify-between mt-1 mb-1" onContextMenu={onContextMenu}>
      <button
        onClick={onToggle}
        title={tooltip}
        className="flex items-center gap-1.5 flex-1 text-left px-1 py-0.5 rounded hover:bg-fvp-surface2/40 group"
      >
        <span
          className={
            "text-[10px] text-fvp-muted transition-transform " +
            (expanded ? "rotate-90" : "")
          }
        >
          ▶
        </span>
        <span className="text-[11px] uppercase tracking-wider text-fvp-text font-bold">
          {label}
        </span>
        {count > 0 && (
          <span className="text-[9px] text-fvp-muted">({count})</span>
        )}
      </button>
      <button
        onClick={onAdd}
        className="text-fvp-muted hover:text-fvp-accent text-[14px] leading-none px-1"
        title={`New ${label.toLowerCase().replace(/s$/, "")}`}
      >
        +
      </button>
    </div>
  );
}

function ScopeRow({
  label,
  countBadge,
  active,
  onClick,
  onContextMenu,
  onDropIdentities,
  reorderKind,
  reorderId,
  onReorderDrop,
}: {
  label: string;
  countBadge?: number;
  active: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  /** When provided, the row becomes a drop target for FVP identity drags
   *  (rows from the main library view). Drop fires with the dragged
   *  identity ids; the parent decides whether to call addToCollection
   *  or addToSeries. */
  onDropIdentities?: (ids: number[]) => void;
  /** When provided alongside reorderId, the row is itself draggable and
   *  also accepts drops of same-kind sidebar reorder payloads — that's
   *  how the user shuffles the order of collections / series in the
   *  sidebar. Different-kind drops are rejected so users can't accidentally
   *  intermix the two lists. */
  reorderKind?: "collection" | "series";
  reorderId?: number;
  onReorderDrop?: (sourceId: number) => void;
}) {
  const [hovering, setHovering] = useState(false);
  const [reorderHover, setReorderHover] = useState(false);
  const canReorder = reorderKind != null && reorderId != null && onReorderDrop != null;
  // Native HTML <button> elements in WebView2 / Chromium have
  // quirks with HTML5 drag-and-drop receive: dragover sometimes
  // doesn't fire reliably on the button itself, only on its
  // children. dragLeave can also stutter as the cursor moves
  // between the button and its inner <span>. Using a div with
  // role='button' sidesteps both issues - it's a clean block
  // element with the same accessibility semantics.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onContextMenu={onContextMenu}
      draggable={canReorder}
      onDragStart={
        canReorder
          ? (e) => {
              setSidebarReorderData(e.dataTransfer, {
                kind: reorderKind!,
                id: reorderId!,
              });
            }
          : undefined
      }
      onDragEnter={(e) => {
        // Also call preventDefault on dragEnter - some browsers
        // require it on BOTH dragenter and dragover to register the
        // element as a valid drop target. Cheap, doesn't break
        // anything when there's no drag in progress.
        const types = Array.from(e.dataTransfer.types);
        if (types.includes("Files")) return;
        e.preventDefault();
      }}
      onDragOver={(e) => {
        // dataTransfer.types during dragover is supposed to include
        // every format set with setData, but in WebView2 / Chromium
        // 'application/x-fvp-...' custom MIME types sometimes don't
        // surface in the types list during the dragover phase (only
        // on drop). Without an unconditional preventDefault here the
        // drop event never fires - the browser treats the row as not
        // a valid drop target and the user sees the 'No' cursor.
        //
        // Safety against external drags (Explorer file drops, browser
        // URL drags, etc.): if the drag carries 'Files' we explicitly
        // REJECT (return without preventDefault) so file drops bubble
        // up to the app's native handler. Otherwise we accept - the
        // actual payload check at drop time gates whether anything
        // happens. A drag carrying neither our payload nor a Files
        // entry just falls through to a no-op at drop time.
        const types = Array.from(e.dataTransfer.types);
        if (types.includes("Files")) {
          return;
        }
        const looksLikeReorder =
          canReorder && types.includes("application/x-fvp-sidebar-reorder");
        if (looksLikeReorder) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setReorderHover(true);
        } else if (onDropIdentities) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setHovering(true);
        }
      }}
      onDragLeave={() => {
        setHovering(false);
        setReorderHover(false);
      }}
      onDrop={(e) => {
        diag(
          "sidebar-drop",
          `drop fired label="${label}" types=[${Array.from(e.dataTransfer.types).join(",")}]`,
        );
        setHovering(false);
        setReorderHover(false);
        const reorderPayload = getSidebarReorderData(e.dataTransfer);
        if (
          canReorder &&
          reorderPayload &&
          reorderPayload.kind === reorderKind &&
          reorderPayload.id !== reorderId
        ) {
          e.preventDefault();
          onReorderDrop!(reorderPayload.id);
          return;
        }
        const ids = onDropIdentities
          ? getIdentityDragData(e.dataTransfer)
          : null;
        diag(
          "sidebar-drop",
          `parsed ids=${ids ? `[${ids.join(",")}]` : "null"} hasOnDropIdentities=${!!onDropIdentities}`,
        );
        if (onDropIdentities && ids && ids.length > 0) {
          e.preventDefault();
          onDropIdentities(ids);
        }
      }}
      className={
        "flex items-center w-full px-1.5 py-0.5 rounded text-[11px] text-left transition-colors cursor-pointer select-none outline-none focus:ring-1 focus:ring-fvp-accent " +
        (active
          ? "bg-fvp-accent/30 text-fvp-text"
          : hovering
            ? "bg-fvp-accent/40 text-fvp-text ring-1 ring-fvp-accent"
            : reorderHover
              ? "bg-fvp-surface2 text-fvp-text border-t-2 border-fvp-accent"
              : "text-fvp-text hover:bg-fvp-surface2/60")
      }
    >
      <span className="flex-1 truncate pointer-events-none" title={label}>
        {label}
      </span>
      {countBadge !== undefined && (
        <span className="text-[9px] text-fvp-muted ml-1 pointer-events-none">
          {countBadge}
        </span>
      )}
    </div>
  );
}

function InlineCreator({
  placeholder,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={() => {
        if (value.trim()) onSubmit();
        else onCancel();
      }}
      placeholder={placeholder}
      className="w-full bg-fvp-bg border border-fvp-accent rounded px-1.5 py-0.5 text-[11px] outline-none mb-1"
    />
  );
}

/**
 * Themed rename dialog. Replaces the old window.prompt that the user
 * called out as "ugly tauri.localhost says…". Pre-filled with the
 * current name; Enter saves, Escape cancels.
 */
function RenameDialog({
  kind,
  currentName,
  onCancel,
  onConfirm,
}: {
  kind: "collection" | "series";
  currentName: string;
  onCancel: () => void;
  onConfirm: (newName: string) => void;
}) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const [name, setName] = useState(currentName);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === currentName) {
      onCancel();
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <div
      className="fixed inset-0 bg-black/60 z-[65] flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-4 min-w-[340px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-2">
          Rename {kind}
        </div>
        <div className="text-[11px] text-fvp-muted mb-2">
          Currently:{" "}
          <span className="text-fvp-text font-mono">{currentName}</span>
        </div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
          className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-sm text-fvp-text outline-none"
        />
        <div className="flex justify-end gap-2 mt-3 text-xs">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!name.trim() || name.trim() === currentName}
            className="px-3 py-1 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
