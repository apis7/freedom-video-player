import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  type AnalyticsSeriesProgress,
  type AnalyticsSnapshot,
  type LibraryRow,
} from "../../ipc/library";

interface Props {
  /** All library rows — used to build the tag-filter dropdown. */
  rows: LibraryRow[];
  onClose: () => void;
  /** Called when the user clicks a series name in the progress widget.
   *  The host closes this modal and switches the library scope to that
   *  series. */
  onJumpToSeries?: (seriesId: number, name: string) => void;
}

type WindowChoice = 7 | 30 | 90 | 365 | "custom";

/**
 * Analytics dashboard — library_directive §7. Shows the user how they're
 * actually using their library:
 *   - Daily opens / watch time (windowed: 7d / 30d / 90d / year)
 *   - Top-N most-watched movies in the window
 *   - Watch breakdown by tag
 *   - Headline KPIs (total opens, distinct files, total watched hours)
 *
 * Filtered down by tag when the user picks one from the dropdown so they
 * can see e.g. "what have I been watching that I've tagged 'date night'".
 *
 * Charts are hand-rolled inline SVG to avoid pulling in chart libs (we
 * don't need axis ticks or interactive tooltips for V1).
 */
export function AnalyticsDashboard({ rows, onClose, onJumpToSeries }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<WindowChoice>(30);
  const [tag, setTag] = useState<string>("");
  // Custom-range state. Lazy: only populated when the user picks
  // "Custom". Default = last 30 days so the date pickers start with
  // something sensible.
  const [customStart, setCustomStart] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return toDateInputValue(d);
  });
  const [customEnd, setCustomEnd] = useState<string>(() =>
    toDateInputValue(new Date()),
  );

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const t of r.tags) set.add(t);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Resolve the request bounds. For canned windows we still send a
    // days parameter and let the backend compute the cutoff. For
    // custom we send explicit unix-second bounds (inclusive on both
    // sides; end_at uses end-of-day so a one-day range still picks up
    // events from that day).
    let daysParam = 30;
    let startUnix: number | null = null;
    let endUnix: number | null = null;
    if (windowDays === "custom") {
      const sd = parseDateInputValue(customStart);
      const ed = parseDateInputValue(customEnd);
      if (sd != null && ed != null && ed >= sd) {
        startUnix = Math.floor(sd.getTime() / 1000);
        // Inclusive end-of-day so "to: 2026-06-11" picks up everything
        // that happened on June 11.
        const endOfDay = new Date(ed);
        endOfDay.setHours(23, 59, 59, 999);
        endUnix = Math.floor(endOfDay.getTime() / 1000);
      }
    } else {
      daysParam = windowDays;
    }
    void libraryIpc
      .analytics(daysParam, tag || null, startUnix, endUnix)
      .then((s) => {
        if (cancelled) return;
        setSnapshot(s);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        showToast(`Analytics failed: ${err}`, "error");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowDays, customStart, customEnd, tag, showToast]);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col w-[860px] max-w-[95vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border flex items-center justify-between gap-4">
          <div className="text-sm font-semibold text-fvp-text">
            Watch Analytics
          </div>
          <div className="flex items-center gap-2 text-[11px] flex-wrap">
            <span className="text-fvp-muted">Window:</span>
            {([7, 30, 90, 365] as const).map((d) => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                className={
                  "px-2 py-0.5 rounded " +
                  (windowDays === d
                    ? "bg-fvp-accent text-white"
                    : "text-fvp-muted hover:text-fvp-text")
                }
              >
                {d === 365 ? "Year" : `${d}d`}
              </button>
            ))}
            <button
              onClick={() => setWindowDays("custom")}
              className={
                "px-2 py-0.5 rounded " +
                (windowDays === "custom"
                  ? "bg-fvp-accent text-white"
                  : "text-fvp-muted hover:text-fvp-text")
              }
              title="Pick an arbitrary start and end date"
            >
              Custom
            </button>
            {windowDays === "custom" && (
              <div className="flex items-center gap-1">
                <input
                  type="date"
                  value={customStart}
                  max={customEnd}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="bg-fvp-bg border border-fvp-border rounded px-1 py-0.5 text-fvp-text"
                />
                <span className="text-fvp-muted">→</span>
                <input
                  type="date"
                  value={customEnd}
                  min={customStart}
                  max={toDateInputValue(new Date())}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="bg-fvp-bg border border-fvp-border rounded px-1 py-0.5 text-fvp-text"
                />
              </div>
            )}
            <span className="text-fvp-muted ml-2">Tag:</span>
            <select
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="bg-fvp-bg border border-fvp-border rounded px-1 py-0.5 text-fvp-text"
            >
              <option value="">All</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              onClick={onClose}
              className="ml-3 text-fvp-muted hover:text-fvp-text text-lg leading-none"
            >
              ×
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">
          {loading && (
            <div className="text-center text-xs text-fvp-muted py-12">
              Loading analytics…
            </div>
          )}
          {!loading && snapshot && (
            <>
              <KpiRow snapshot={snapshot} />
              <Section title="Daily activity">
                <DailyChart snapshot={snapshot} />
              </Section>
              {snapshot.series_progress.length > 0 && (
                <Section title="Series progress">
                  <SeriesProgressList
                    snapshot={snapshot}
                    onJump={
                      onJumpToSeries
                        ? (id, name) => {
                            onJumpToSeries(id, name);
                            onClose();
                          }
                        : undefined
                    }
                  />
                </Section>
              )}
              <div className="grid grid-cols-2 gap-4">
                <Section title="Most-watched in window">
                  <TopMovies snapshot={snapshot} />
                </Section>
                <Section title="Activity by tag">
                  <TagSlices snapshot={snapshot} />
                </Section>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function KpiRow({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  const hours = (snapshot.total_watched_ms / 1000 / 3600).toFixed(1);
  return (
    <div className="grid grid-cols-3 gap-3">
      <Kpi label="Total opens" value={snapshot.total_opens.toString()} />
      <Kpi label="Distinct movies" value={snapshot.total_distinct_files.toString()} />
      <Kpi label="Watched (hours)" value={hours} />
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-fvp-bg/60 border border-fvp-border rounded p-3">
      <div className="text-[10px] uppercase tracking-wider text-fvp-muted">
        {label}
      </div>
      <div className="text-xl font-bold text-fvp-text mt-1">{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

function DailyChart({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  if (snapshot.daily.length === 0) {
    return (
      <div className="text-xs text-fvp-muted text-center py-6">
        No activity in this window.
      </div>
    );
  }
  // Bars scaled to opens; secondary thin line is watched_ms (proportional).
  const maxOpens = Math.max(1, ...snapshot.daily.map((d) => d.opens));
  const w = 760;
  const h = 120;
  const padL = 30;
  const padB = 18;
  const innerW = w - padL;
  const innerH = h - padB;
  const barW = innerW / snapshot.daily.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-32">
      {/* y-axis labels */}
      <text x={2} y={12} fill="#9ca3af" fontSize="9">
        {maxOpens}
      </text>
      <text x={2} y={innerH} fill="#9ca3af" fontSize="9">
        0
      </text>
      {snapshot.daily.map((d, i) => {
        const x = padL + i * barW;
        const bH = (d.opens / maxOpens) * (innerH - 6);
        const y = innerH - bH;
        return (
          <g key={d.day}>
            <rect
              x={x + 1}
              y={y}
              width={Math.max(1, barW - 2)}
              height={bH}
              fill="#3b82f6"
              opacity={0.85}
            >
              <title>{`${d.day} — opens: ${d.opens}, distinct: ${d.distinct_files}, watched: ${(d.watched_ms / 60000).toFixed(0)} min`}</title>
            </rect>
          </g>
        );
      })}
      {/* x-axis end labels */}
      <text x={padL} y={h - 4} fill="#9ca3af" fontSize="9">
        {snapshot.daily[0]?.day ?? ""}
      </text>
      <text x={w - 60} y={h - 4} fill="#9ca3af" fontSize="9">
        {snapshot.daily[snapshot.daily.length - 1]?.day ?? ""}
      </text>
    </svg>
  );
}

function TopMovies({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  if (snapshot.top_movies.length === 0) {
    return (
      <div className="text-xs text-fvp-muted text-center py-6">
        No movies opened in this window.
      </div>
    );
  }
  const maxWatched = Math.max(
    1,
    ...snapshot.top_movies.map((m) => m.watched_ms),
  );
  return (
    <ul className="space-y-1">
      {snapshot.top_movies.map((m) => {
        const pct = (m.watched_ms / maxWatched) * 100;
        return (
          <li key={m.identity_id} className="text-[11px]">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-fvp-text">
                {m.movie_title ?? `Identity #${m.identity_id}`}
              </span>
              <span className="text-fvp-muted">
                {m.opens} open{m.opens === 1 ? "" : "s"} · {(m.watched_ms / 60000).toFixed(0)}m
              </span>
            </div>
            <div className="h-1 bg-fvp-bg rounded mt-0.5 overflow-hidden">
              <div
                className="h-full bg-fvp-accent"
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Compact per-series progress widget. One row per series the user has
 * opened in the window, ordered most-recently-touched first. Each row
 * shows a clickable series name + an overall progress bar; for series
 * with seasons, a second slimmer bar shows the current-season slice.
 *
 * Hidden entirely (by the parent) when snapshot.series_progress is
 * empty, so users who never watch series don't see a header for a
 * permanently-blank section.
 */
function SeriesProgressList({
  snapshot,
  onJump,
}: {
  snapshot: AnalyticsSnapshot;
  onJump?: (seriesId: number, name: string) => void;
}) {
  return (
    <ul className="space-y-2">
      {snapshot.series_progress.map((s) => (
        <SeriesProgressRow key={s.series_id} row={s} onJump={onJump} />
      ))}
    </ul>
  );
}

function SeriesProgressRow({
  row,
  onJump,
}: {
  row: AnalyticsSeriesProgress;
  onJump?: (seriesId: number, name: string) => void;
}) {
  const overallPct = row.total_episodes > 0
    ? Math.round((row.watched_episodes / row.total_episodes) * 100)
    : 0;
  const seasonPct = row.current_season_total > 0
    ? Math.round(
        (row.current_season_watched / row.current_season_total) * 100,
      )
    : 0;
  const clickable = !!onJump;
  return (
    <li className="text-[11px] flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          {clickable ? (
            <button
              onClick={() => onJump!(row.series_id, row.name)}
              className="text-fvp-text hover:text-fvp-accent text-left truncate"
              title="Jump to this series in the library"
            >
              {row.name}
            </button>
          ) : (
            <span className="text-fvp-text truncate">{row.name}</span>
          )}
          {row.has_seasons && row.current_season != null && (
            <span className="text-fvp-muted shrink-0">
              · S{row.current_season} {seasonPct}%
            </span>
          )}
          <span className="text-fvp-muted shrink-0">
            · Series {overallPct}%
          </span>
        </div>
        {/* Bars: overall on top, current-season (if any) below as a
            slimmer accent line. */}
        <div className="h-1.5 bg-fvp-bg rounded mt-1 overflow-hidden">
          <div
            className="h-full bg-fvp-accent"
            style={{ width: `${overallPct}%` }}
          />
        </div>
        {row.has_seasons && row.current_season != null && (
          <div className="h-0.5 bg-fvp-bg rounded mt-0.5 overflow-hidden">
            <div
              className="h-full bg-fvp-ok"
              style={{ width: `${seasonPct}%` }}
            />
          </div>
        )}
      </div>
      <div className="text-[10px] text-fvp-muted shrink-0 text-right tabular-nums w-20">
        {row.watched_episodes} / {row.total_episodes} ep
      </div>
    </li>
  );
}

function TagSlices({ snapshot }: { snapshot: AnalyticsSnapshot }) {
  if (snapshot.by_tag.length === 0) {
    return (
      <div className="text-xs text-fvp-muted text-center py-6">
        No tagged movies opened in this window.
      </div>
    );
  }
  const maxOpens = Math.max(1, ...snapshot.by_tag.map((s) => s.opens));
  return (
    <ul className="space-y-1">
      {snapshot.by_tag.slice(0, 10).map((s) => {
        const pct = (s.opens / maxOpens) * 100;
        return (
          <li key={s.tag} className="text-[11px]">
            <div className="flex items-center gap-2">
              <span className="flex-1 truncate text-fvp-text">{s.tag}</span>
              <span className="text-fvp-muted">
                {s.opens} · {s.distinct_files} movie{s.distinct_files === 1 ? "" : "s"}
              </span>
            </div>
            <div className="h-1 bg-fvp-bg rounded mt-0.5 overflow-hidden">
              <div
                className="h-full bg-fvp-ok"
                style={{ width: `${pct}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Format a Date for the value of `<input type="date">`: YYYY-MM-DD. */
function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse a YYYY-MM-DD `<input type="date">` value back into a Date in
 *  local time. Returns null on malformed input. */
function parseDateInputValue(s: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return null;
  }
  return new Date(y, m - 1, d);
}
