import { useEffect, useMemo, useState } from "react";
import type { LibraryRow } from "../../ipc/library";
import { libraryIpc } from "../../ipc/library";
import { useAppStore } from "../../state/appStore";
import { LibraryPoster } from "./LibraryPoster";
import { formatAspectRatio, formatBytes, formatRuntime } from "./libraryFormat";
import {
  displayTitle,
  looksLike3DInTitle,
  strip3DFromTitle,
  looksLikeExtendedInTitle,
  stripExtendedFromTitle,
} from "./titleDisplay";

interface Props {
  /** Primary-selected row (drives the single-row view). */
  row: LibraryRow | null;
  /** ALL currently selected rows. Drives bulk-edit mode when length > 1. */
  selectedRows: LibraryRow[];
  onRefreshList: () => void;
}

/**
 * Right-side details + edit panel. Two modes:
 *
 *   - 0–1 selected → single-row mode (poster + stats + plot + per-item
 *     tags / notes / flags / actions)
 *   - 2+ selected → bulk-edit mode (tags add/remove, tri-state flags,
 *     bulk refresh, applies to EVERY selected identity in one batch)
 *
 * Bulk writes go through the same Tauri commands the single-row path
 * uses — just looped over the identity ids. Toasts confirm the count.
 */
export function LibraryDetailsPanel({ row, selectedRows, onRefreshList }: Props) {
  // Series synth rows have no file/identity on disk — give them their
  // own panel that summarizes the series and offers a "scope into it"
  // shortcut. Don't show in bulk mode (synth rows shouldn't be bulk-
  // edited; the parent already filters them out before delegating).
  const realRows = selectedRows.filter((r) => !r.__synthetic_series);
  if (row?.__synthetic_series) {
    return <SeriesSummaryPanel row={row} />;
  }
  if (realRows.length > 1) {
    return <BulkEditPanel rows={realRows} onRefreshList={onRefreshList} />;
  }
  return <SingleRowPanel row={row} onRefreshList={onRefreshList} />;
}

/**
 * Compact summary for a synthetic series row — the user clicked a
 * series tile in All Movies and wants to see what it represents before
 * scoping into it. Per directive: series acts as a single entity in
 * the main library view.
 */
function SeriesSummaryPanel({ row }: { row: LibraryRow }) {
  const s = row.__synthetic_series!;
  return (
    <aside className="w-72 shrink-0 border-l border-fvp-border bg-fvp-surface text-xs flex flex-col">
      <div className="p-3 border-b border-fvp-border">
        <div className="flex justify-center mb-2">
          <LibraryPoster
            customThumbnailPath={row.identity.custom_thumbnail_path}
            posterLocalPath={row.identity.poster_local_path}
            widthPx={140}
            alt={s.series_name}
            cacheKey={row.identity.last_updated_at}
          />
        </div>
        <div className="text-sm font-semibold text-fvp-text leading-tight">
          {s.series_name}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-fvp-accent mt-1">
          Series
        </div>
      </div>
      <div className="p-3 space-y-2 text-[11px]">
        <Stat label="Items" value={String(s.episode_count)} />
        <Stat label="Watched" value={`${s.watched_count} / ${s.episode_count}`} />
        <Stat label="Seasons" value={s.has_seasons ? "Yes" : "No"} />
      </div>
      <div className="p-3 text-[11px] text-fvp-muted">
        Double-click the tile to open this series.
      </div>
    </aside>
  );
}

// ── Single-row panel (unchanged from prior behavior) ────────────────

function SingleRowPanel({
  row,
  onRefreshList,
}: {
  row: LibraryRow | null;
  onRefreshList: () => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [notesDraft, setNotesDraft] = useState("");
  const [tagInput, setTagInput] = useState("");

  useEffect(() => {
    setNotesDraft(row?.identity.notes ?? "");
    setTagInput("");
  }, [row?.file.id]);

  if (!row) {
    return (
      <aside className="w-72 shrink-0 border-l border-fvp-border bg-fvp-surface text-xs p-4">
        <div className="text-fvp-muted">Select a movie for details.</div>
      </aside>
    );
  }

  const id = row.identity;
  const f = row.file;
  const title = displayTitle(row);

  const commitTagInput = async () => {
    const additions = tagInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (additions.length === 0) return;
    const setLower = new Set(row.tags.map((t) => t.toLowerCase()));
    const merged = [...row.tags];
    for (const t of additions) {
      if (!setLower.has(t.toLowerCase())) {
        merged.push(t);
        setLower.add(t.toLowerCase());
      }
    }
    setTagInput("");
    try {
      await libraryIpc.setTags(id.id, merged);
      onRefreshList();
    } catch (err) {
      showToast(`Tag save failed: ${err}`, "error");
    }
  };
  const removeTag = async (tag: string) => {
    const kept = row.tags.filter((t) => t.toLowerCase() !== tag.toLowerCase());
    try {
      await libraryIpc.setTags(id.id, kept);
      onRefreshList();
    } catch (err) {
      showToast(`Tag save failed: ${err}`, "error");
    }
  };
  const saveNotes = async () => {
    try {
      await libraryIpc.setNotes(id.id, notesDraft);
      onRefreshList();
    } catch (err) {
      showToast(`Notes save failed: ${err}`, "error");
    }
  };
  const setFlag = async (
    key:
      | "noProfileNecessary"
      | "priorityForProfile"
      | "nonFamilyFriendly"
      | "is3d"
      | "isExtended",
    value: boolean,
  ) => {
    try {
      await libraryIpc.setFlags(id.id, { [key]: value });
      onRefreshList();
    } catch (err) {
      showToast(`Flag save failed: ${err}`, "error");
    }
  };

  // 3D toggle. If the existing title already ends with a "3D" / "(3D)" /
  // "[3D]" token, ask the user whether to strip it first — otherwise
  // displayTitle() suppresses the suffix to avoid "Title 3D (3D)". Saying
  // "no" still flips the flag; we just leave the title as-is.
  const set3D = async (value: boolean) => {
    if (value && id.movie_title && looksLike3DInTitle(id.movie_title)) {
      const cleaned = strip3DFromTitle(id.movie_title);
      const ok = window.confirm(
        `The title "${id.movie_title}" already has "3D" in it. ` +
          `Strip it so the new "(3D)" suffix is the only 3D marker?\n\n` +
          `OK → rename to "${cleaned}" then mark as 3D.\n` +
          `Cancel → leave title alone, just mark as 3D.`,
      );
      if (ok) {
        try {
          await libraryIpc.setManualMetadata(id.id, "title", cleaned);
        } catch (err) {
          showToast(`Couldn't update title: ${err}`, "error");
        }
      }
    }
    await setFlag("is3d", value);
  };

  // Same shape as set3D — if the title already contains an
  // Extended-style marker, offer to clean it up before adding the
  // " (Extended)" suffix.
  const setExtended = async (value: boolean) => {
    if (value && id.movie_title && looksLikeExtendedInTitle(id.movie_title)) {
      const cleaned = stripExtendedFromTitle(id.movie_title);
      const ok = window.confirm(
        `The title "${id.movie_title}" already has an Extended/Director's Cut marker. ` +
          `Strip it so the new "(Extended)" suffix is the only marker?\n\n` +
          `OK → rename to "${cleaned}" then mark as Extended.\n` +
          `Cancel → leave title alone, just mark as Extended.`,
      );
      if (ok) {
        try {
          await libraryIpc.setManualMetadata(id.id, "title", cleaned);
        } catch (err) {
          showToast(`Couldn't update title: ${err}`, "error");
        }
      }
    }
    await setFlag("isExtended", value);
  };

  // Save handler factory for inline-editable fields. Empty string is
  // treated as "clear" (passes null to the backend, which also clears
  // the manual override flag → re-enables TMDb auto-fill). Refreshes
  // the list on success so the new value appears immediately.
  const saveField = async (field: "title" | "year" | "director" | "plot" | "genres" | "stars", raw: string) => {
    const trimmed = raw.trim();
    try {
      await libraryIpc.setManualMetadata(id.id, field, trimmed.length === 0 ? null : trimmed);
      onRefreshList();
    } catch (err) {
      showToast(`Save failed: ${err}`, "error");
    }
  };

  return (
    <aside className="w-72 shrink-0 border-l border-fvp-border bg-fvp-surface text-xs flex flex-col overflow-y-auto">
      <div className="p-3 border-b border-fvp-border">
        <div className="flex justify-center mb-2">
          <LibraryPoster
            customThumbnailPath={id.custom_thumbnail_path}
            posterLocalPath={id.poster_local_path}
            widthPx={140}
            alt={title}
            isMissing={f.is_missing}
            cacheKey={id.last_updated_at}
          />
        </div>
        <EditableField
          value={id.movie_title ?? ""}
          placeholder="(no title)"
          onSave={(v) => saveField("title", v)}
          className="text-sm font-semibold text-fvp-text leading-tight mb-0.5"
          ariaLabel="Edit title"
        />
        <EditableField
          value={id.movie_year != null ? String(id.movie_year) : ""}
          placeholder="(no year)"
          onSave={(v) => saveField("year", v)}
          className="text-fvp-muted text-[11px]"
          ariaLabel="Edit year"
        />
        <div className="text-fvp-muted text-[11px] mt-1 flex items-baseline gap-1">
          <span className="shrink-0">Dir.</span>
          <EditableField
            value={id.movie_director ?? ""}
            placeholder="(no director)"
            onSave={(v) => saveField("director", v)}
            className="flex-1 min-w-0"
            ariaLabel="Edit director"
          />
        </div>
      </div>

      <div className="p-3 border-b border-fvp-border space-y-2 text-[11px]">
        <Stat label="Runtime" value={formatRuntime(id.duration_ms)} />
        <Stat label="Resolution" value={f.resolution ?? "—"} />
        {formatAspectRatio(f.resolution) && (
          <Stat
            label="Aspect ratio"
            value={formatAspectRatio(f.resolution)!}
          />
        )}
        <Stat label="Size" value={formatBytes(f.size_bytes)} />
        {id.imdb_rating !== null && (
          <Stat label="TMDb rating" value={id.imdb_rating.toFixed(1)} />
        )}
        <EditableStat
          label="Genres"
          value={id.genres.join(", ")}
          placeholder="(none — comma-separated)"
          onSave={(v) => saveField("genres", v)}
        />
        <EditableStat
          label="Cast"
          value={id.movie_stars.join(", ")}
          placeholder="(none — comma-separated)"
          onSave={(v) => saveField("stars", v)}
        />
      </div>

      <div className="p-3 border-b border-fvp-border">
        <div className="text-[9px] uppercase tracking-wider text-fvp-muted mb-1">
          Description
        </div>
        <EditableField
          value={id.movie_plot ?? ""}
          placeholder="(no description — click ✎ to add)"
          onSave={(v) => saveField("plot", v)}
          multiline
          className="text-[11px] leading-relaxed text-fvp-text/90"
          ariaLabel="Edit description"
        />
      </div>

      <div className="p-3 border-b border-fvp-border space-y-2">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-fvp-muted mb-1">
            Tags
          </div>
          <TagPillList tags={row.tags} onRemove={(t) => void removeTag(t)} />
          <input
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onBlur={() => void commitTagInput()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                void commitTagInput();
              } else if (
                e.key === "Backspace" &&
                tagInput.length === 0 &&
                row.tags.length > 0
              ) {
                // Backspace on empty input removes the last pill — file
                // manager-style chip editing.
                e.preventDefault();
                void removeTag(row.tags[row.tags.length - 1]!);
              }
            }}
            placeholder="Add a tag…"
            className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs outline-none mt-1"
          />
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-fvp-muted mb-1">
            Notes
          </div>
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            onBlur={() => void saveNotes()}
            rows={3}
            placeholder="freeform notes…"
            className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs outline-none resize-y"
          />
        </div>
      </div>

      <div className="p-3 border-b border-fvp-border space-y-1.5">
        <FlagToggle
          label="No profile necessary"
          tip="Clean movie — don't show a missing-profile warning."
          checked={id.no_profile_necessary}
          onChange={(v) => void setFlag("noProfileNecessary", v)}
        />
        <FlagToggle
          label="Priority for profile creation"
          tip="Surface this title in the profile-suggestion nudge."
          checked={id.priority_for_profile}
          onChange={(v) => void setFlag("priorityForProfile", v)}
        />
        <FlagToggle
          label="Non-family-friendly"
          tip="Hidden when Family View is on (Roulette/Suggestions also skip)."
          checked={id.non_family_friendly}
          onChange={(v) => void setFlag("nonFamilyFriendly", v)}
        />
        <FlagToggle
          label="3D"
          tip="Marks the movie as a 3D release — appends &quot;(3D)&quot; to the displayed title and surfaces in the 3D filter."
          checked={id.is_3d}
          onChange={(v) => void set3D(v)}
        />
        <FlagToggle
          label="Extended Edition / Director's Cut"
          tip="Marks an Extended / Director's Cut / Final Cut variant — appends &quot;(Extended)&quot; to the title and tells the fuzzy-duplicate scanner NOT to pair this with the theatrical release."
          checked={id.is_extended}
          onChange={(v) => void setExtended(v)}
        />
      </div>

      <div className="p-3 space-y-1 text-[11px]">
        <button
          onClick={() => {
            void libraryIpc.refreshMetadata(id.id).then(() => {
              showToast("Metadata refresh queued.", "info", 2500);
            });
          }}
          className="w-full px-2 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded text-left"
        >
          ↻ Refresh metadata from TMDb
        </button>
        <div className="text-[10px] text-fvp-muted font-mono break-all pt-2">
          {f.path}
        </div>
      </div>
    </aside>
  );
}

// ── Bulk-edit panel (2+ selected) ───────────────────────────────────

/** Tri-state derived from the selected rows for one flag — Some(true)
 *  if every selected row has it set, Some(false) if none do, None if
 *  mixed. None renders as an indeterminate checkbox. */
type TriState = boolean | null;

function deriveTriState<T>(values: T[], on: T): TriState {
  if (values.length === 0) return false;
  const allOn = values.every((v) => v === on);
  if (allOn) return true;
  const noneOn = values.every((v) => v !== on);
  if (noneOn) return false;
  return null;
}

function BulkEditPanel({
  rows,
  onRefreshList,
}: {
  rows: LibraryRow[];
  onRefreshList: () => void;
}) {
  const showToast = useAppStore((s) => s.showToast);
  const [addTags, setAddTags] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  // De-dup by identity — true duplicates count as ONE identity for
  // editing purposes (since tags / flags live on the identity row).
  const identities = useMemo(() => {
    const seen = new Map<number, LibraryRow>();
    for (const r of rows) {
      if (!seen.has(r.identity.id)) seen.set(r.identity.id, r);
    }
    return Array.from(seen.values());
  }, [rows]);
  const identityIds = identities.map((r) => r.identity.id);

  const nffTri = deriveTriState(
    identities.map((r) => r.identity.non_family_friendly),
    true,
  );
  const priorityTri = deriveTriState(
    identities.map((r) => r.identity.priority_for_profile),
    true,
  );
  const noProfileTri = deriveTriState(
    identities.map((r) => r.identity.no_profile_necessary),
    true,
  );

  const applyToAll = async <T extends unknown>(
    label: string,
    op: (identityId: number) => Promise<T>,
  ) => {
    setBusy(label);
    let okCount = 0;
    let failCount = 0;
    for (const id of identityIds) {
      try {
        await op(id);
        okCount += 1;
      } catch {
        failCount += 1;
      }
    }
    setBusy(null);
    if (failCount > 0) {
      showToast(`${label}: ${okCount} ok, ${failCount} failed`, "warn", 3500);
    } else {
      showToast(`${label}: applied to ${okCount} movie(s)`, "info", 2500);
    }
    onRefreshList();
  };

  const handleAddTags = async () => {
    const newTags = addTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (newTags.length === 0) return;
    // Server replaces the whole tag list — to add WITHOUT clobbering
    // existing tags, compute the union per identity.
    await applyToAll("Add tags", async (idn) => {
      const cur = identities.find((r) => r.identity.id === idn)?.tags ?? [];
      const setLower = new Set(cur.map((t) => t.toLowerCase()));
      const merged = [...cur];
      for (const t of newTags) {
        if (!setLower.has(t.toLowerCase())) merged.push(t);
      }
      return libraryIpc.setTags(idn, merged);
    });
    setAddTags("");
  };

  const setFlagAll = async (
    key: "noProfileNecessary" | "priorityForProfile" | "nonFamilyFriendly",
    value: boolean,
  ) => {
    await applyToAll(`Set ${key}=${value}`, (idn) =>
      libraryIpc.setFlags(idn, { [key]: value }),
    );
  };

  const refreshMetadataAll = async () => {
    await applyToAll("Refresh metadata", (idn) =>
      libraryIpc.refreshMetadata(idn),
    );
  };

  const bulkSetThumbnail = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      multiple: false,
      filters: [
        { name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] },
      ],
    });
    if (typeof picked !== "string") return;
    await applyToAll("Set custom thumbnail", (idn) =>
      libraryIpc.setCustomThumbnail(idn, picked),
    );
  };
  const bulkClearThumbnail = async () => {
    if (
      !window.confirm(
        `Clear the custom thumbnail on ${identityIds.length} movies? Their TMDb poster (if any) will be used instead.`,
      )
    )
      return;
    await applyToAll("Clear custom thumbnail", (idn) =>
      libraryIpc.setCustomThumbnail(idn, null),
    );
  };

  return (
    <aside className="w-72 shrink-0 border-l border-fvp-border bg-fvp-surface text-xs flex flex-col overflow-y-auto">
      <div className="p-3 border-b border-fvp-border bg-fvp-accent/10">
        <div className="text-sm font-semibold text-fvp-text mb-1">
          Bulk edit: {identities.length} movie{identities.length === 1 ? "" : "s"}
        </div>
        <div className="text-[11px] text-fvp-muted">
          Changes apply to every selected movie at once. Notes can't be
          bulk-edited — select one for that.
        </div>
      </div>

      {/* Tags — add via pill input; "shared tags across the whole
          selection" pills can be clicked to remove from ALL. We don't
          show partial-overlap tags here to avoid visual confusion. */}
      <div className="p-3 border-b border-fvp-border space-y-2">
        <div>
          <div className="text-[9px] uppercase tracking-wider text-fvp-muted mb-1">
            Tags shared by all selected
          </div>
          <BulkTagPillList
            identities={identities}
            onRemove={(tag) =>
              void applyToAll(`Remove "${tag}"`, async (idn) => {
                const cur = identities.find((r) => r.identity.id === idn)?.tags ?? [];
                const kept = cur.filter(
                  (t) => t.toLowerCase() !== tag.toLowerCase(),
                );
                return libraryIpc.setTags(idn, kept);
              })
            }
          />
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-wider text-fvp-muted mb-1">
            Add tag to all selected
          </div>
          <div className="flex gap-1">
            <input
              value={addTags}
              onChange={(e) => setAddTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  void handleAddTags();
                }
              }}
              placeholder="Add a tag…"
              className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs outline-none"
            />
            <button
              onClick={() => void handleAddTags()}
              disabled={!!busy || !addTags.trim()}
              className="px-2 py-1 bg-fvp-accent text-white text-[11px] rounded disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      </div>

      {/* Flags — tri-state checkboxes. Indeterminate when the selection
          is mixed; clicking sets ALL to the opposite. */}
      <div className="p-3 border-b border-fvp-border space-y-1.5">
        <TriFlag
          label="No profile necessary"
          state={noProfileTri}
          onChange={(v) => void setFlagAll("noProfileNecessary", v)}
        />
        <TriFlag
          label="Priority for profile creation"
          state={priorityTri}
          onChange={(v) => void setFlagAll("priorityForProfile", v)}
        />
        <TriFlag
          label="Non-family-friendly"
          state={nffTri}
          onChange={(v) => void setFlagAll("nonFamilyFriendly", v)}
        />
      </div>

      <div className="p-3 space-y-1 text-[11px]">
        <button
          onClick={() => void refreshMetadataAll()}
          disabled={!!busy}
          className="w-full px-2 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded text-left disabled:opacity-50"
        >
          ↻ Refresh metadata from TMDb (all {identities.length})
        </button>
        <button
          onClick={() => void bulkSetThumbnail()}
          disabled={!!busy}
          className="w-full px-2 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded text-left disabled:opacity-50"
          title="Pick one image; every selected movie will use it as its custom thumbnail."
        >
          🖼 Set custom thumbnail on all {identities.length}…
        </button>
        <button
          onClick={() => void bulkClearThumbnail()}
          disabled={!!busy}
          className="w-full px-2 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted rounded text-left disabled:opacity-50"
        >
          Clear custom thumbnail on all {identities.length}
        </button>
      </div>

      {busy && (
        <div className="p-3 text-[11px] text-fvp-muted text-center">
          {busy}…
        </div>
      )}
    </aside>
  );
}

function TriFlag({
  label,
  state,
  onChange,
}: {
  label: string;
  state: TriState;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer text-[11px]">
      <input
        type="checkbox"
        checked={state === true}
        ref={(el) => {
          if (el) el.indeterminate = state === null;
        }}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-fvp-accent mt-0.5"
      />
      <span>
        {label}
        {state === null && (
          <span className="text-fvp-muted ml-1">(mixed)</span>
        )}
      </span>
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-fvp-muted">{label}</span>
      <span className="text-fvp-text text-right">{value}</span>
    </div>
  );
}

/**
 * Inline-edit a single string. Idle state shows the value with a pen
 * icon that appears on hover; clicking the value OR the pen swaps in
 * an input. Auto-saves on blur or Enter (Esc cancels). When `multiline`
 * is true uses a textarea (Enter inserts newline, Ctrl/Cmd+Enter saves).
 * Empty-string saves clear the value AND the manual-override flag in
 * the backend, re-enabling TMDb auto-fill.
 */
function EditableField({
  value,
  placeholder,
  onSave,
  multiline = false,
  className = "",
  ariaLabel,
}: {
  value: string;
  placeholder: string;
  onSave: (newValue: string) => Promise<void> | void;
  multiline?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) {
      void onSave(draft);
    }
  };
  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (editing) {
    if (multiline) {
      return (
        <textarea
          autoFocus
          aria-label={ariaLabel}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          placeholder={placeholder}
          rows={4}
          className={`w-full bg-fvp-bg border border-fvp-accent rounded px-2 py-1 outline-none resize-y ${className}`}
        />
      );
    }
    return (
      <input
        autoFocus
        aria-label={ariaLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        placeholder={placeholder}
        className={`w-full bg-fvp-bg border border-fvp-accent rounded px-2 py-0.5 outline-none ${className}`}
      />
    );
  }

  return (
    <div className={`group/edit flex items-start gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex-1 min-w-0 text-left cursor-text"
        title="Click to edit"
      >
        {value || <span className="italic text-fvp-muted">{placeholder}</span>}
      </button>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="opacity-0 group-hover/edit:opacity-100 text-fvp-muted hover:text-fvp-accent transition-opacity shrink-0"
        title="Edit"
        aria-label={ariaLabel}
      >
        ✎
      </button>
    </div>
  );
}

/** Stat-row variant of EditableField. Stacked label + editable value. */
function EditableStat({
  label,
  value,
  placeholder,
  onSave,
}: {
  label: string;
  value: string;
  placeholder: string;
  onSave: (newValue: string) => Promise<void> | void;
}) {
  return (
    <div>
      <div className="text-fvp-muted mb-0.5">{label}</div>
      <EditableField
        value={value}
        placeholder={placeholder}
        onSave={onSave}
        className="text-fvp-text"
        ariaLabel={`Edit ${label.toLowerCase()}`}
      />
    </div>
  );
}

function FlagToggle({
  label,
  tip,
  checked,
  onChange,
}: {
  label: string;
  tip: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 cursor-pointer text-[11px]" title={tip}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-fvp-accent mt-0.5"
      />
      <span>{label}</span>
    </label>
  );
}

/**
 * Bulk-mode tag pills. Shows only tags present on EVERY identity in the
 * selection (full intersection). Clicking a pill's × removes that tag
 * from all selected at once. Partial-overlap tags are deliberately not
 * shown — would be confusing to "remove" a tag that's only on some.
 */
function BulkTagPillList({
  identities,
  onRemove,
}: {
  identities: LibraryRow[];
  onRemove: (tag: string) => void;
}) {
  const shared = useMemo(() => {
    if (identities.length === 0) return [];
    const lists = identities.map(
      (r) => new Set(r.tags.map((t) => t.toLowerCase())),
    );
    const base = identities[0]!.tags;
    return base.filter((t) =>
      lists.every((s) => s.has(t.toLowerCase())),
    );
  }, [identities]);
  if (shared.length === 0) {
    return (
      <div className="text-[10px] text-fvp-muted italic mb-1">
        No tags shared by every selected movie.
      </div>
    );
  }
  return <TagPillList tags={shared} onRemove={onRemove} />;
}

/**
 * Tag pill list. Each tag rendered as a removable chip with an "x"
 * button. Per directive — file-manager / email-style tag editing so
 * users don't have to retype the comma-separated list to drop a tag.
 */
function TagPillList({
  tags,
  onRemove,
}: {
  tags: string[];
  onRemove: (tag: string) => void;
}) {
  if (tags.length === 0) {
    return (
      <div className="text-[10px] text-fvp-muted italic mb-1">No tags yet.</div>
    );
  }
  return (
    <div className="flex flex-wrap gap-1 mb-1">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-fvp-accent/20 border border-fvp-accent/40 rounded-full text-[10px] text-fvp-text"
        >
          {t}
          <button
            type="button"
            onClick={() => onRemove(t)}
            className="text-fvp-muted hover:text-fvp-err leading-none text-[12px] font-bold"
            title={`Remove tag "${t}"`}
            aria-label={`Remove tag ${t}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
