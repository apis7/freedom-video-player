import { useMemo } from "react";
import type { LibraryRow, ProfileStatus } from "../../ipc/library";
import { looksLike3DInFilename } from "./titleDisplay";

export type WatchFilter = "any" | "unwatched" | "in_progress" | "watched";
export type MapsTierFilter =
  | "any"
  | "family"
  | "teen"
  | "adult"
  | "married_adult"
  | "degrading"
  | "unknown";
export type DateRangePreset =
  | "any"
  | "today"
  | "7d"
  | "30d"
  | "90d"
  | "year"
  | "never";

export type PresenceFilter = "any" | "yes" | "no";
export type SizeFilter = "any" | "lt_500mb" | "500mb_2gb" | "2gb_8gb" | "gt_8gb";

export interface LibraryFilterState {
  searchText: string;
  profileFilter: "any" | ProfileStatus;
  watchFilter: WatchFilter;
  tags: string[];
  genres: string[];
  priorityForProfile: boolean;
  nonFamilyFriendly: "any" | "include" | "exclude";
  mapsFiltered: MapsTierFilter;
  mapsUnfiltered: MapsTierFilter;
  /** Filter on the file's `added_at` timestamp. */
  addedRange: DateRangePreset;
  /** Filter on the file's `last_watched_at` timestamp. */
  lastWatchedRange: DateRangePreset;
  /** Presence-based metadata filters — does the row have a poster,
   *  TMDb year, resolution, runtime, freeform notes? */
  hasPoster: PresenceFilter;
  hasYear: PresenceFilter;
  hasResolution: PresenceFilter;
  hasRuntime: PresenceFilter;
  hasNotes: PresenceFilter;
  /** Filesize bucket. */
  sizeFilter: SizeFilter;
  /** Series scope (in All Movies view, lets the user narrow to "items
   *  belonging to series X"). "any" disables; "none" matches standalones
   *  only; numeric matches a specific series_id. */
  seriesFilter: "any" | "none" | number;
  /** 3D filter — "yes" surfaces items flagged is_3d OR whose filename
   *  contains a 3D marker the user never cleaned up. "no" surfaces
   *  items NEITHER flagged 3D NOR matching the filename pattern. */
  is3d: PresenceFilter;
  /** Broken-filepath filter. "yes" surfaces ONLY items the indexer
   *  flagged is_missing (so the user can pull up everything that needs
   *  rescue). "no" hides them. */
  broken: PresenceFilter;
  /** Duplicates filter — "yes" surfaces every file row whose identity
   *  has 2+ file rows (i.e. the same fingerprinted bytes indexed under
   *  more than one path). "no" hides anything that has duplicates. The
   *  duplicate-set computation happens in the parent (Library.tsx)
   *  because applyFilters() runs per-row and doesn't see the full row
   *  list; the set is precomputed and passed in via filter context. */
  duplicates: PresenceFilter;
}

export const EMPTY_FILTERS: LibraryFilterState = {
  searchText: "",
  profileFilter: "any",
  watchFilter: "any",
  tags: [],
  genres: [],
  priorityForProfile: false,
  nonFamilyFriendly: "any",
  mapsFiltered: "any",
  mapsUnfiltered: "any",
  addedRange: "any",
  lastWatchedRange: "any",
  hasPoster: "any",
  hasYear: "any",
  hasResolution: "any",
  hasRuntime: "any",
  hasNotes: "any",
  sizeFilter: "any",
  seriesFilter: "any",
  is3d: "any",
  broken: "any",
  duplicates: "any",
};

function presenceTest(value: boolean, filter: PresenceFilter): boolean {
  if (filter === "any") return true;
  if (filter === "yes") return value;
  return !value;
}

function sizeBucketMatch(bytes: number, filter: SizeFilter): boolean {
  if (filter === "any") return true;
  const MB = 1024 * 1024;
  const GB = 1024 * MB;
  switch (filter) {
    case "lt_500mb":
      return bytes < 500 * MB;
    case "500mb_2gb":
      return bytes >= 500 * MB && bytes < 2 * GB;
    case "2gb_8gb":
      return bytes >= 2 * GB && bytes < 8 * GB;
    case "gt_8gb":
      return bytes >= 8 * GB;
  }
}

/** Convert a preset to a Unix-epoch lower bound. Returns null when no
 *  numeric bound applies (e.g. "any", "never" — the latter is handled
 *  inline). */
function presetLowerBoundSec(preset: DateRangePreset, now: number): number | null {
  const day = 86_400;
  switch (preset) {
    case "today":
      return now - day;
    case "7d":
      return now - day * 7;
    case "30d":
      return now - day * 30;
    case "90d":
      return now - day * 90;
    case "year":
      return now - day * 365;
    default:
      return null;
  }
}

/**
 * Apply the active filters to a list of rows. Pure; the parent calls
 * this on every re-render. Cheap enough for libraries up to ~10k items;
 * we'll memoize at the call site if it ever becomes a bottleneck.
 *
 * `familyViewOn` is the global Family View toggle (separate from the
 * per-row "include / exclude non-family-friendly" filter): when ON,
 * non_family_friendly items are unconditionally hidden — that's the whole
 * point of Family View (per directive's "Hide from views + block tools").
 */
export function applyFilters(
  rows: LibraryRow[],
  filters: LibraryFilterState,
  familyViewOn: boolean,
): LibraryRow[] {
  const needle = filters.searchText.trim().toLowerCase();
  // Identity-ids that show up in 2+ file rows in the input. Computed
  // once per call so the per-row .filter() can do an O(1) lookup
  // instead of an O(N²) sweep. Empty when the duplicates filter is
  // "any" — saves the work on the common path.
  const dupSet: Set<number> | null =
    filters.duplicates === "any"
      ? null
      : (() => {
          const counts = new Map<number, number>();
          for (const r of rows) {
            counts.set(r.identity.id, (counts.get(r.identity.id) ?? 0) + 1);
          }
          const s = new Set<number>();
          for (const [id, c] of counts) {
            if (c > 1) s.add(id);
          }
          return s;
        })();
  return rows.filter((row) => {
    // Family View — hard mask. Takes precedence over the per-filter setting.
    if (familyViewOn && row.identity.non_family_friendly) return false;

    if (filters.nonFamilyFriendly === "exclude" && row.identity.non_family_friendly)
      return false;
    if (
      filters.nonFamilyFriendly === "include" &&
      !row.identity.non_family_friendly
    )
      return false;

    if (filters.priorityForProfile && !row.identity.priority_for_profile)
      return false;

    if (
      filters.profileFilter !== "any" &&
      row.profile_status !== filters.profileFilter
    )
      return false;

    if (filters.watchFilter === "watched" && !row.file.watched) return false;
    if (filters.watchFilter === "unwatched" && row.file.watched) return false;
    if (filters.watchFilter === "in_progress") {
      if (row.file.watched) return false;
      const pct =
        row.identity.duration_ms > 0
          ? row.file.watch_progress_ms / row.identity.duration_ms
          : 0;
      if (pct < 0.05 || pct > 0.9) return false;
    }

    if (filters.tags.length > 0) {
      const setLow = new Set(row.tags.map((t) => t.toLowerCase()));
      for (const wanted of filters.tags) {
        if (!setLow.has(wanted.toLowerCase())) return false;
      }
    }

    if (filters.genres.length > 0) {
      const setLow = new Set(row.identity.genres.map((g) => g.toLowerCase()));
      for (const wanted of filters.genres) {
        if (!setLow.has(wanted.toLowerCase())) return false;
      }
    }

    if (needle.length > 0) {
      const haystack = [
        row.identity.movie_title ?? "",
        row.file.path.split(/[\\/]/).pop() ?? "",
        row.identity.movie_director ?? "",
        ...row.identity.genres,
        ...row.identity.movie_stars,
        ...row.tags,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    if (filters.mapsFiltered !== "any") {
      const t = row.identity.maps_filtered_tier;
      if (filters.mapsFiltered === "unknown") {
        if (t != null) return false;
      } else if (t !== filters.mapsFiltered) return false;
    }
    if (filters.mapsUnfiltered !== "any") {
      const t = row.identity.maps_unfiltered_tier;
      if (filters.mapsUnfiltered === "unknown") {
        if (t != null) return false;
      } else if (t !== filters.mapsUnfiltered) return false;
    }

    if (filters.addedRange !== "any") {
      const now = Math.floor(Date.now() / 1000);
      const bound = presetLowerBoundSec(filters.addedRange, now);
      // "never" can't apply to added_at (every indexed file has it set).
      if (bound != null && row.file.added_at < bound) return false;
    }
    if (filters.lastWatchedRange !== "any") {
      const now = Math.floor(Date.now() / 1000);
      if (filters.lastWatchedRange === "never") {
        if (row.file.last_watched_at != null) return false;
      } else {
        const bound = presetLowerBoundSec(filters.lastWatchedRange, now);
        if (
          bound != null &&
          (row.file.last_watched_at == null ||
            row.file.last_watched_at < bound)
        )
          return false;
      }
    }

    // Presence-based metadata filters.
    const hasPoster =
      !!row.identity.poster_local_path || !!row.identity.custom_thumbnail_path;
    if (!presenceTest(hasPoster, filters.hasPoster)) return false;
    if (!presenceTest(row.identity.movie_year != null, filters.hasYear))
      return false;
    if (!presenceTest(!!row.file.resolution, filters.hasResolution)) return false;
    if (!presenceTest(row.identity.duration_ms > 0, filters.hasRuntime))
      return false;
    const hasNotes = !!row.identity.notes && row.identity.notes.trim() !== "";
    if (!presenceTest(hasNotes, filters.hasNotes)) return false;

    // Filesize bucket.
    if (!sizeBucketMatch(row.file.size_bytes, filters.sizeFilter)) return false;

    // Series filter.
    if (filters.seriesFilter === "none") {
      if (row.series != null) return false;
    } else if (typeof filters.seriesFilter === "number") {
      if (row.series?.series_id !== filters.seriesFilter) return false;
    }

    // 3D filter — flagged identity OR filename heuristic. The heuristic
    // catches user files like "Avatar (3D).mkv" or "Movie_3d_1080p.mp4"
    // even when the identity hasn't been hand-flagged yet.
    if (filters.is3d !== "any") {
      const filename = row.file.path.split(/[\\/]/).pop() ?? "";
      const is3D = row.identity.is_3d || looksLike3DInFilename(filename);
      if (!presenceTest(is3D, filters.is3d)) return false;
    }

    if (filters.broken !== "any") {
      if (!presenceTest(row.file.is_missing, filters.broken)) return false;
    }

    if (dupSet) {
      const isDup = dupSet.has(row.identity.id);
      if (!presenceTest(isDup, filters.duplicates)) return false;
    }

    return true;
  });
}

interface Props {
  rows: LibraryRow[];
  filters: LibraryFilterState;
  onChange: (next: LibraryFilterState) => void;
}

/** Sidebar filter panel. Compact controls; choices reflect the actual
 *  data (only tags/genres present in the library are offered).
 *
 *  Perf: allTags / allGenres are derived from the full unfiltered row
 *  set (up to thousands of entries). They only change when the row
 *  list itself changes, so memoize on `rows` identity — the parent
 *  re-renders constantly during playback (position ticks), and we don't
 *  want to flatMap+sort thousands of strings on every tick. */
interface FiltersProps extends Props {
  /** Collapsed state driven by the parent so the sidebar accordion can
   *  auto-close this section when the user clicks one of the top-three
   *  scope rows (All Movies / a collection / a series). */
  expanded: boolean;
  onToggle: () => void;
}

export function LibraryFilters({
  rows,
  filters,
  onChange,
  expanded,
  onToggle,
}: FiltersProps) {
  const allGenres = useMemo(
    () => uniqueSorted(rows.flatMap((r) => r.identity.genres)),
    [rows],
  );
  const allSeries = useMemo(() => {
    const seen = new Map<number, string>();
    for (const r of rows) {
      if (r.series && !seen.has(r.series.series_id)) {
        seen.set(r.series.series_id, r.series.series_name);
      }
    }
    return Array.from(seen.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const reset = () => onChange(EMPTY_FILTERS);
  const hasActive =
    filters.searchText.length > 0 ||
    filters.profileFilter !== "any" ||
    filters.watchFilter !== "any" ||
    filters.tags.length > 0 ||
    filters.genres.length > 0 ||
    filters.priorityForProfile ||
    filters.nonFamilyFriendly !== "any" ||
    filters.mapsFiltered !== "any" ||
    filters.mapsUnfiltered !== "any" ||
    filters.addedRange !== "any" ||
    filters.lastWatchedRange !== "any" ||
    filters.hasPoster !== "any" ||
    filters.hasYear !== "any" ||
    filters.hasResolution !== "any" ||
    filters.hasRuntime !== "any" ||
    filters.hasNotes !== "any" ||
    filters.sizeFilter !== "any" ||
    filters.seriesFilter !== "any" ||
    filters.is3d !== "any" ||
    filters.broken !== "any" ||
    filters.duplicates !== "any";

  return (
    <aside className="bg-fvp-surface text-xs flex flex-col">
      {/* Visual break between the scope shortcuts (All / Collections /
          Series) above and the filter form below. The header itself
          toggles the section open/closed — default closed, auto-closes
          when the user picks a different sidebar section. */}
      <div className="h-2 border-t-2 border-fvp-border/60" />
      <div className="px-3 py-2 border-b border-fvp-border flex items-center justify-between gap-2">
        <button
          onClick={onToggle}
          className="flex items-center gap-1.5 flex-1 text-left rounded hover:bg-fvp-surface2/40 px-1 py-0.5"
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
            Filters &amp; Search
          </span>
          {hasActive && (
            <span
              className="text-[9px] text-fvp-accent"
              title="One or more filters active"
            >
              ●
            </span>
          )}
        </button>
        {hasActive && (
          <button
            onClick={reset}
            className="text-[10px] text-fvp-accent hover:underline"
            title="Clear all filters"
          >
            clear
          </button>
        )}
      </div>
      {!expanded ? null : (
      <div className="px-3 py-2 space-y-3">
        <Section title="Search">
          <input
            value={filters.searchText}
            onChange={(e) => onChange({ ...filters, searchText: e.target.value })}
            placeholder="title, keywords, tags…"
            className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text outline-none"
          />
        </Section>

        <Section title="Profile">
          <SelectRadio
            value={filters.profileFilter}
            onChange={(v) =>
              onChange({ ...filters, profileFilter: v as Props["filters"]["profileFilter"] })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "has_profile", label: "Has .free" },
              { value: "missing", label: "Missing" },
              { value: "no_profile_necessary", label: "Marked clean" },
            ]}
          />
        </Section>

        <Section title="Watch state">
          <SelectRadio
            value={filters.watchFilter}
            onChange={(v) =>
              onChange({ ...filters, watchFilter: v as WatchFilter })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "unwatched", label: "Unwatched" },
              { value: "in_progress", label: "In progress" },
              { value: "watched", label: "Watched" },
            ]}
          />
        </Section>

        <Section title="Other">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.priorityForProfile}
              onChange={(e) =>
                onChange({ ...filters, priorityForProfile: e.target.checked })
              }
              className="accent-fvp-accent"
            />
            <span>Priority for profile creation</span>
          </label>
        </Section>

        <Section title="Family-friendly">
          <SelectRadio
            value={filters.nonFamilyFriendly}
            onChange={(v) =>
              onChange({
                ...filters,
                nonFamilyFriendly: v as Props["filters"]["nonFamilyFriendly"],
              })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "exclude", label: "Exclude flagged" },
              { value: "include", label: "Only flagged" },
            ]}
          />
        </Section>

        <Section title="Date added">
          <SelectRadio
            value={filters.addedRange}
            onChange={(v) =>
              onChange({ ...filters, addedRange: v as DateRangePreset })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "today", label: "24h" },
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
              { value: "90d", label: "90d" },
              { value: "year", label: "Year" },
            ]}
          />
        </Section>

        <Section title="Last watched">
          <SelectRadio
            value={filters.lastWatchedRange}
            onChange={(v) =>
              onChange({ ...filters, lastWatchedRange: v as DateRangePreset })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "today", label: "24h" },
              { value: "7d", label: "7d" },
              { value: "30d", label: "30d" },
              { value: "90d", label: "90d" },
              { value: "year", label: "Year" },
              { value: "never", label: "Never" },
            ]}
          />
        </Section>

        <Section title="MAPS (filtered)">
          <SelectRadio
            value={filters.mapsFiltered}
            onChange={(v) =>
              onChange({ ...filters, mapsFiltered: v as MapsTierFilter })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "family", label: "Family" },
              { value: "teen", label: "Teen" },
              { value: "adult", label: "Adult" },
              { value: "married_adult", label: "MA" },
              { value: "degrading", label: "Degr." },
              { value: "unknown", label: "Unk." },
            ]}
          />
        </Section>

        <Section title="MAPS (raw)">
          <SelectRadio
            value={filters.mapsUnfiltered}
            onChange={(v) =>
              onChange({ ...filters, mapsUnfiltered: v as MapsTierFilter })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "family", label: "Family" },
              { value: "teen", label: "Teen" },
              { value: "adult", label: "Adult" },
              { value: "married_adult", label: "MA" },
              { value: "degrading", label: "Degr." },
              { value: "unknown", label: "Unk." },
            ]}
          />
        </Section>

        <Section title="Has metadata">
          <div className="grid grid-cols-2 gap-1.5">
            <PresenceMini
              label="Poster"
              value={filters.hasPoster}
              onChange={(v) => onChange({ ...filters, hasPoster: v })}
            />
            <PresenceMini
              label="Year"
              value={filters.hasYear}
              onChange={(v) => onChange({ ...filters, hasYear: v })}
            />
            <PresenceMini
              label="Resolution"
              value={filters.hasResolution}
              onChange={(v) => onChange({ ...filters, hasResolution: v })}
            />
            <PresenceMini
              label="Runtime"
              value={filters.hasRuntime}
              onChange={(v) => onChange({ ...filters, hasRuntime: v })}
            />
            <PresenceMini
              label="Notes"
              value={filters.hasNotes}
              onChange={(v) => onChange({ ...filters, hasNotes: v })}
            />
            <PresenceMini
              label="3D"
              value={filters.is3d}
              onChange={(v) => onChange({ ...filters, is3d: v })}
            />
            <PresenceMini
              label="Broken path"
              value={filters.broken}
              onChange={(v) => onChange({ ...filters, broken: v })}
            />
            <PresenceMini
              label="Duplicates"
              value={filters.duplicates}
              onChange={(v) => onChange({ ...filters, duplicates: v })}
            />
          </div>
        </Section>

        <Section title="File size">
          <SelectRadio
            value={filters.sizeFilter}
            onChange={(v) =>
              onChange({ ...filters, sizeFilter: v as SizeFilter })
            }
            options={[
              { value: "any", label: "Any" },
              { value: "lt_500mb", label: "< 500MB" },
              { value: "500mb_2gb", label: "500MB–2GB" },
              { value: "2gb_8gb", label: "2–8GB" },
              { value: "gt_8gb", label: "> 8GB" },
            ]}
          />
        </Section>

        {allSeries.length > 0 && (
          <Section title="Series">
            <select
              value={
                typeof filters.seriesFilter === "number"
                  ? String(filters.seriesFilter)
                  : filters.seriesFilter
              }
              onChange={(e) => {
                const v = e.target.value;
                onChange({
                  ...filters,
                  seriesFilter:
                    v === "any" || v === "none" ? v : parseInt(v, 10),
                });
              }}
              className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text outline-none"
            >
              <option value="any">Any</option>
              <option value="none">Standalone only (not in any series)</option>
              {allSeries.map((s) => (
                <option key={s.id} value={String(s.id)}>
                  {s.name}
                </option>
              ))}
            </select>
          </Section>
        )}

        {allGenres.length > 0 && (
          <Section title="Genres">
            <ChipPicker
              available={allGenres}
              selected={filters.genres}
              onChange={(genres) => onChange({ ...filters, genres })}
            />
          </Section>
        )}
      </div>
      )}
    </aside>
  );
}

function PresenceMini({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PresenceFilter;
  onChange: (v: PresenceFilter) => void;
}) {
  return (
    <div className="bg-fvp-bg border border-fvp-border rounded overflow-hidden">
      <div className="px-1.5 pt-1 text-[10px] text-fvp-text truncate" title={label}>
        {label}
      </div>
      <div className="grid grid-cols-3 mt-0.5 border-t border-fvp-border/60">
        {(["any", "yes", "no"] as const).map((v, i) => (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={
              "py-0.5 text-[10px] text-center leading-tight " +
              (i < 2 ? "border-r border-fvp-border/60 " : "") +
              (value === v
                ? "bg-fvp-accent text-white"
                : "text-fvp-muted hover:text-fvp-text")
            }
            title={
              v === "any" ? "Any" : v === "yes" ? "Has it" : "Doesn't have it"
            }
          >
            {v === "any" ? "Any" : v === "yes" ? "✓" : "✗"}
          </button>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-wider text-fvp-muted mb-1">
        {title}
      </div>
      {children}
    </div>
  );
}

/**
 * Segmented-control replacement for stacked radio buttons. Renders the
 * options as a row of pill buttons; the active one is highlighted. Wraps
 * to the next line if the filter sidebar is narrow.
 */
function SelectRadio<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={
              "px-2 py-0.5 rounded-full text-[10px] border transition-colors " +
              (active
                ? "bg-fvp-accent text-white border-fvp-accent"
                : "bg-fvp-bg text-fvp-muted border-fvp-border hover:text-fvp-text hover:border-fvp-muted")
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function ChipPicker({
  available,
  selected,
  onChange,
}: {
  available: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  // O(1) membership lookup so per-chip render is constant time even
  // when the user has many tags selected.
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const toggle = (item: string) => {
    if (selectedSet.has(item)) {
      onChange(selected.filter((x) => x !== item));
    } else {
      onChange([...selected, item]);
    }
  };
  return (
    <div className="flex flex-wrap gap-1">
      {available.map((item) => {
        const isOn = selectedSet.has(item);
        return (
          <button
            key={item}
            onClick={() => toggle(item)}
            className={
              "px-1.5 py-0.5 rounded border text-[10px] " +
              (isOn
                ? "bg-fvp-accent text-white border-fvp-accent"
                : "bg-fvp-bg text-fvp-text border-fvp-border hover:border-fvp-muted")
            }
          >
            {item}
          </button>
        );
      })}
    </div>
  );
}

function uniqueSorted(values: string[]): string[] {
  const set = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    if (t.length > 0) set.add(t);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
