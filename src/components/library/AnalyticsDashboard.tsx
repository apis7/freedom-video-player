import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  type AnalyticsSnapshot,
  type LibraryRow,
} from "../../ipc/library";

interface Props {
  /** All library rows — used to build the tag-filter dropdown. */
  rows: LibraryRow[];
  onClose: () => void;
}

type WindowChoice = 7 | 30 | 90 | 365;

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
export function AnalyticsDashboard({ rows, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [snapshot, setSnapshot] = useState<AnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<WindowChoice>(30);
  const [tag, setTag] = useState<string>("");

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
    void libraryIpc
      .analytics(windowDays, tag || null)
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
  }, [windowDays, tag, showToast]);

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
          <div className="flex items-center gap-2 text-[11px]">
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
