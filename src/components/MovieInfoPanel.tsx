import { useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";
import {
  MAPS_TIERS,
  MAX_MAPS_SUMMARY_LEN,
  MAX_MOVIE_PLOT_LEN,
  MAX_STARS_PER_MOVIE,
  type MapsRating,
  type MapsTier,
  type TmdbMovieDetails,
} from "../ipc/types";
import { buildSnipSummary } from "../utils/snipSummary";
import { TmdbAutoFillModal } from "./TmdbAutoFillModal";

interface Props {
  /** "edit" surfaces text inputs + the TMDb auto-fill button (used in
   *  Creator Mode). "view" renders everything read-only (used by the
   *  film-camera button in Player Mode). */
  mode: "edit" | "view";
}

/**
 * Movie Info — title, year, director, cast, plot, MAPS ratings,
 * IMDb & FVP user ratings, auto-generated snip summary.
 *
 * Editable shape in Creator Mode; read-only in Player Mode. Single
 * component so both modes show identical layout / wording.
 */
export function MovieInfoPanel({ mode }: Props) {
  const snips = useAppStore((s) => s.snips);
  const snipSummary = buildSnipSummary(snips);

  return (
    <div className="space-y-4 text-xs">
      <TitleAndYear mode={mode} />
      <DirectorAndStars mode={mode} />
      <PlotField mode={mode} />
      <MapsRatings mode={mode} />
      <ExternalRatings mode={mode} />
      <SnipSummarySection rows={snipSummary} />
    </div>
  );
}

/* ─────────────────────────── Title / Year ─────────────────────────── */

function TitleAndYear({ mode }: { mode: "edit" | "view" }) {
  const title = useAppStore((s) => s.movieTitle);
  const year = useAppStore((s) => s.movieYear);
  const currentFile = useAppStore((s) => s.currentFile);
  const [showAuto, setShowAuto] = useState(false);

  const setTitle = (v: string) =>
    useAppStore.setState({ movieTitle: v.trim().length > 0 ? v.slice(0, 200) : null });
  const setYear = (v: string) => {
    const n = parseInt(v, 10);
    useAppStore.setState({
      movieYear: !Number.isNaN(n) && n >= 1888 && n <= 2200 ? n : null,
    });
  };

  if (mode === "view") {
    return (
      <div>
        <div className="text-base font-semibold text-fvp-text">
          {title ?? "(untitled)"}
          {year != null && (
            <span className="ml-1 text-fvp-muted font-normal">({year})</span>
          )}
        </div>
      </div>
    );
  }

  const initialQuery = title ?? filenameStem(currentFile);

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={title ?? ""}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Movie title"
          maxLength={200}
          className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-fvp-text outline-none"
        />
        <input
          value={year ?? ""}
          onChange={(e) => setYear(e.target.value)}
          placeholder="Year"
          maxLength={4}
          className="w-16 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-fvp-text outline-none font-mono tabular-nums"
        />
      </div>
      <button
        onClick={() => setShowAuto(true)}
        className="text-[11px] text-fvp-accent hover:underline cursor-pointer"
      >
        Auto-fill from TMDb…
      </button>
      {showAuto && (
        <TmdbAutoFillModal
          initialQuery={initialQuery}
          onPicked={(d) => {
            applyTmdbDetails(d);
            setShowAuto(false);
          }}
          onCancel={() => setShowAuto(false)}
        />
      )}
    </div>
  );
}

function applyTmdbDetails(d: TmdbMovieDetails) {
  useAppStore.setState({
    movieTitle: d.title,
    movieYear: d.release_year ?? null,
    movieDirector: d.director,
    movieStars: d.top_cast.slice(0, MAX_STARS_PER_MOVIE),
    moviePlot: d.overview.length > 0 ? d.overview.slice(0, MAX_MOVIE_PLOT_LEN) : null,
    imdbRating: d.vote_average,
    imdbId: d.imdb_id,
  });
}

function filenameStem(path: string | null): string {
  if (!path) return "";
  const file = path.split(/[\\/]/).pop() ?? "";
  return file.replace(/\.[^.]+$/, "");
}

/* ─────────────────────── Director / Stars ──────────────────────── */

function DirectorAndStars({ mode }: { mode: "edit" | "view" }) {
  const director = useAppStore((s) => s.movieDirector);
  const stars = useAppStore((s) => s.movieStars);

  if (mode === "view") {
    if (!director && stars.length === 0) return null;
    return (
      <div className="space-y-0.5">
        {director && (
          <div>
            <span className="text-fvp-muted">Director:</span>{" "}
            <span className="text-fvp-text">{director}</span>
          </div>
        )}
        {stars.length > 0 && (
          <div>
            <span className="text-fvp-muted">Stars:</span>{" "}
            <span className="text-fvp-text">{stars.join(", ")}</span>
          </div>
        )}
      </div>
    );
  }

  const setDirector = (v: string) =>
    useAppStore.setState({ movieDirector: v.trim().length > 0 ? v.slice(0, 200) : null });
  // Stars stored as array; UI presents as comma-separated text for simple editing.
  const starsText = stars.join(", ");
  const setStars = (v: string) =>
    useAppStore.setState({
      movieStars: v
        .split(",")
        .map((s) => s.trim().slice(0, 200))
        .filter((s) => s.length > 0)
        .slice(0, MAX_STARS_PER_MOVIE),
    });

  return (
    <div className="space-y-2">
      <input
        value={director ?? ""}
        onChange={(e) => setDirector(e.target.value)}
        placeholder="Director"
        maxLength={200}
        className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-fvp-text outline-none"
      />
      <input
        value={starsText}
        onChange={(e) => setStars(e.target.value)}
        placeholder="Top cast (comma-separated)"
        className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-fvp-text outline-none"
      />
    </div>
  );
}

/* ───────────────────────────── Plot ─────────────────────────────── */

function PlotField({ mode }: { mode: "edit" | "view" }) {
  const plot = useAppStore((s) => s.moviePlot);
  if (mode === "view") {
    if (!plot) return null;
    return (
      <p className="text-fvp-text leading-relaxed whitespace-pre-wrap">
        {plot}
      </p>
    );
  }
  const setPlot = (v: string) =>
    useAppStore.setState({
      moviePlot: v.length > 0 ? v.slice(0, MAX_MOVIE_PLOT_LEN) : null,
    });
  return (
    <textarea
      value={plot ?? ""}
      onChange={(e) => setPlot(e.target.value)}
      placeholder="Plot summary"
      rows={4}
      maxLength={MAX_MOVIE_PLOT_LEN}
      className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1.5 text-fvp-text outline-none resize-y leading-relaxed"
    />
  );
}

/* ────────────────────────── MAPS ratings ────────────────────────── */

function MapsRatings({ mode }: { mode: "edit" | "view" }) {
  const filtered = useAppStore((s) => s.mapsFiltered);
  const unfiltered = useAppStore((s) => s.mapsUnfiltered);
  return (
    <div className="space-y-2 pt-2 border-t border-fvp-border/40">
      <div className="text-[10px] uppercase tracking-wider text-fvp-muted">
        MAPS rating
      </div>
      <MapsRatingRow
        label="Unfiltered"
        rating={unfiltered}
        mode={mode}
        onChange={(r) => useAppStore.setState({ mapsUnfiltered: r })}
      />
      <MapsRatingRow
        label="FVP-filtered"
        rating={filtered}
        mode={mode}
        onChange={(r) => useAppStore.setState({ mapsFiltered: r })}
      />
    </div>
  );
}

function MapsRatingRow({
  label,
  rating,
  mode,
  onChange,
}: {
  label: string;
  rating: MapsRating | null;
  mode: "edit" | "view";
  onChange: (r: MapsRating | null) => void;
}) {
  const tierInfo = MAPS_TIERS.find((t) => t.value === rating?.tier);
  if (mode === "view") {
    return (
      <div className="flex items-start gap-2">
        <span className="text-fvp-muted w-24 shrink-0">{label}:</span>
        {tierInfo ? (
          <span>
            <TierChip tier={rating!.tier} />
            <span className="text-fvp-text ml-1">{rating!.summary}</span>
          </span>
        ) : (
          <span className="text-fvp-muted italic">(not rated)</span>
        )}
      </div>
    );
  }
  // Edit mode
  return (
    <div className="space-y-1">
      <div className="text-fvp-muted">{label}</div>
      <div className="flex flex-wrap gap-1">
        <button
          onClick={() => onChange(null)}
          className={clsx(
            "px-2 py-0.5 rounded text-[10px] border",
            rating === null
              ? "bg-fvp-surface2 border-fvp-border text-fvp-text"
              : "bg-transparent border-fvp-border/50 text-fvp-muted hover:border-fvp-muted",
          )}
        >
          (none)
        </button>
        {MAPS_TIERS.map((t) => {
          const active = rating?.tier === t.value;
          return (
            <button
              key={t.value}
              onClick={() =>
                onChange({ tier: t.value, summary: rating?.summary ?? "" })
              }
              style={
                active
                  ? { backgroundColor: t.color, color: "#fff", borderColor: t.color }
                  : { borderColor: t.color, color: t.color }
              }
              className="px-2 py-0.5 rounded text-[10px] border font-medium"
              title={t.label}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {rating !== null && (
        <input
          value={rating.summary}
          onChange={(e) =>
            onChange({ tier: rating.tier, summary: e.target.value.slice(0, MAX_MAPS_SUMMARY_LEN) })
          }
          placeholder={`Why ${tierInfo?.label ?? "this tier"}? (short reason)`}
          maxLength={MAX_MAPS_SUMMARY_LEN}
          className="w-full bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-fvp-text outline-none"
        />
      )}
    </div>
  );
}

export function TierChip({ tier }: { tier: MapsTier }) {
  const t = MAPS_TIERS.find((m) => m.value === tier);
  if (!t) return null;
  return (
    <span
      style={{ backgroundColor: t.color, color: "#fff" }}
      className="inline-block px-1.5 py-px rounded text-[9px] font-semibold uppercase tracking-wide"
    >
      {t.label}
    </span>
  );
}

/* ──────────────────── External ratings (IMDb / FVP) ──────────────────── */

function ExternalRatings({ mode }: { mode: "edit" | "view" }) {
  const imdbRating = useAppStore((s) => s.imdbRating);
  const setImdb = (v: string) => {
    const n = parseFloat(v);
    useAppStore.setState({
      imdbRating: Number.isNaN(n) ? null : Math.max(0, Math.min(10, n)),
    });
  };
  return (
    <div className="pt-2 border-t border-fvp-border/40 space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-fvp-muted w-24 shrink-0">IMDb rating:</span>
        {mode === "view" ? (
          <span className="font-mono tabular-nums text-fvp-text">
            {imdbRating != null ? `${imdbRating.toFixed(1)} / 10` : "—"}
          </span>
        ) : (
          <input
            value={imdbRating ?? ""}
            onChange={(e) => setImdb(e.target.value)}
            placeholder="—"
            type="number"
            min={0}
            max={10}
            step={0.1}
            className="w-20 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-0.5 text-fvp-text outline-none font-mono tabular-nums"
          />
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-fvp-muted w-24 shrink-0">FVP user rating:</span>
        <span
          className="text-fvp-muted"
          title="Available when the FVP sharing site launches"
        >
          —
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────── Snip Summary section ────────────────────── */

function SnipSummarySection({ rows }: { rows: { label: string; count: number }[] }) {
  return (
    <div className="pt-2 border-t border-fvp-border/40">
      <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-1">
        Snip summary
      </div>
      {rows.length === 0 ? (
        <div className="text-fvp-muted italic">No snips yet.</div>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.label} className="flex justify-between">
              <span className="text-fvp-text">{r.label}</span>
              <span className="font-mono tabular-nums text-fvp-text">
                {r.count}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
