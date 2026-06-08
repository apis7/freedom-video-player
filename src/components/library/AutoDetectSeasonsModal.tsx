import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type LibraryRow } from "../../ipc/library";
import { tmdbIpc, type TmdbTvSearchResult, type TmdbTvSeasonEpisode } from "../../ipc/tmdb";

interface Props {
  seriesId: number;
  seriesName: string;
  /** All rows that currently belong to this series. */
  rows: LibraryRow[];
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}

type DetectionMethod = "folder" | "filename" | "tmdb" | "manual";

interface SeasonGuess {
  source: DetectionMethod;
  /** Identity id → assigned season number (null = unassigned). */
  assignments: Map<number, number | null>;
  /** Distinct seasons that got at least one assignment. */
  seasonCount: number;
  /** Identities that didn't match any pattern. */
  unassignedCount: number;
}

/**
 * Permissive parent-folder name parser. Same vocabulary as the
 * series-detection modal — Season/Series/Volume/Disc/Part/Book + bare
 * numbers + word numbers. Falls back to null when no signal is present.
 */
function parseSeasonFromFolderName(name: string): number | null {
  const cleaned = name.trim();
  if (!cleaned) return null;
  const m1 = cleaned.match(
    /^(?:season|series|vol(?:ume)?\.?|disc|book|part)\s*0*(\d{1,3})/i,
  );
  if (m1) return parseInt(m1[1]!, 10);
  const m2 = cleaned.match(/^s\.?0*(\d{1,3})\b/i);
  if (m2) return parseInt(m2[1]!, 10);
  const m3 = cleaned.match(/^0*(\d{1,3})$/);
  if (m3) return parseInt(m3[1]!, 10);
  const wordNum = cleaned.match(/^(?:season|series)\s+(\w+)\b/i);
  if (wordNum) {
    const dict: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5,
      six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    };
    const n = dict[wordNum[1]!.toLowerCase()];
    if (n != null) return n;
  }
  return null;
}

/**
 * Try the folder-name approach: parent folder is "Season N", "S0N",
 * "Series N", "Vol N", bare numeric, etc. Highest-quality signal for
 * the user's curated \TV SERIES\Show\Season N\ layout.
 *
 * If the direct match comes up dry but the SERIES root has ≥2 sibling
 * folders that each contain episodes, fall back to ordinal numbering:
 * sort the distinct parent folders alphabetically and assign 1, 2, 3…
 * That handles BBC-style named seasons ("The Adventures", "The Return")
 * where the curator didn't use any season-numbering convention.
 */
function detectFromFolder(rows: LibraryRow[]): SeasonGuess {
  const assignments = new Map<number, number | null>();
  const seasons = new Set<number>();

  // Pass 1: direct match per row.
  for (const r of rows) {
    const segs = r.file.path.split(/[\\/]/);
    const parent = segs[segs.length - 2] ?? "";
    const n = parseSeasonFromFolderName(parent);
    if (n != null) {
      assignments.set(r.identity.id, n);
      seasons.add(n);
    } else {
      assignments.set(r.identity.id, null);
    }
  }

  // Pass 2: ordinal fallback. When direct matching covered NO rows but
  // there are ≥2 distinct parent folders, the user probably has named
  // seasons (e.g. "The Adventures", "The Return", …). Sort them
  // alphabetically and number them 1, 2, 3.
  const directlyMatched = Array.from(assignments.values()).some((v) => v != null);
  if (!directlyMatched) {
    const parentFolders = new Map<string, number[]>();
    for (const r of rows) {
      const segs = r.file.path.split(/[\\/]/);
      const parent = segs[segs.length - 2] ?? "";
      const list = parentFolders.get(parent) ?? [];
      list.push(r.identity.id);
      parentFolders.set(parent, list);
    }
    if (parentFolders.size >= 2) {
      const sortedFolders = Array.from(parentFolders.keys()).sort((a, b) =>
        a.localeCompare(b),
      );
      sortedFolders.forEach((folder, idx) => {
        const season = idx + 1;
        for (const identityId of parentFolders.get(folder)!) {
          assignments.set(identityId, season);
          seasons.add(season);
        }
      });
    }
  }

  const unassigned = Array.from(assignments.values()).filter(
    (v) => v == null,
  ).length;
  return {
    source: "folder",
    assignments,
    seasonCount: seasons.size,
    unassignedCount: unassigned,
  };
}

/**
 * Filename-pattern bank. Each entry knows how to pull (season, episode)
 * from a single filename. Ordered roughly most-specific → most-ambiguous;
 * the scorer tries them all and picks the highest-confidence winner.
 *
 * The "ambiguous" patterns (1.1, plain 1e1) only win when the user's
 * stated season count constrains them — otherwise a filename like
 * "v1.2 release.mkv" would falsely score as a season indicator.
 */
interface FilenamePattern {
  name: string;
  parse: (filename: string) => { season: number; episode: number } | null;
}

const FILENAME_PATTERNS: FilenamePattern[] = [
  {
    name: "S01E01",
    parse: (n) => {
      const m = n.match(/[Ss](\d{1,3})[._\s-]*[Ee](\d{1,3})/);
      return m ? { season: +m[1]!, episode: +m[2]! } : null;
    },
  },
  {
    name: "Season 1 Episode 1",
    parse: (n) => {
      const m = n.match(/[Ss]eason\s*(\d{1,3}).{0,12}?[Ee]p(?:isode)?\s*(\d{1,3})/i);
      return m ? { season: +m[1]!, episode: +m[2]! } : null;
    },
  },
  {
    name: "1 Episode 1",
    parse: (n) => {
      const m = n.match(/(?:^|[\s._-])(\d{1,2})\s*[._-]?\s*[Ee]p(?:isode)?\s*(\d{1,3})/i);
      return m ? { season: +m[1]!, episode: +m[2]! } : null;
    },
  },
  {
    name: "1x01",
    parse: (n) => {
      const m = n.match(/(?:^|[\s._-])(\d{1,2})x(\d{1,3})(?:[\s._-]|$)/i);
      return m ? { season: +m[1]!, episode: +m[2]! } : null;
    },
  },
  {
    name: "1e01",
    parse: (n) => {
      // Bare "1e1" — must NOT be embedded in a word (e.g. "movie1e1pic" no).
      const m = n.match(/(?:^|[\s._-])(\d{1,2})[Ee](\d{1,3})(?:[\s._-]|$)/);
      return m ? { season: +m[1]!, episode: +m[2]! } : null;
    },
  },
  {
    name: "S1.1",
    parse: (n) => {
      const m = n.match(/[Ss](\d{1,2})\.(\d{1,3})\b/);
      return m ? { season: +m[1]!, episode: +m[2]! } : null;
    },
  },
  {
    name: "1.1",
    parse: (n) => {
      // Two numbers separated by a dot, NOT preceded by other digits.
      // The leading-context guard rejects "v1.2", "Movie2.1", "S01.E03"
      // (already handled by the other patterns).
      const m = n.match(/(?:^|[\s_-])(\d{1,2})\.(\d{1,3})(?=[\s._-]|$)/);
      if (!m) return null;
      return { season: +m[1]!, episode: +m[2]! };
    },
  },
];

interface FilenameDetection extends SeasonGuess {
  patternName: string;
  /** Confidence in [0, 1]. Combines coverage with season-count match
   *  to user's stated count (when provided). */
  confidence: number;
  /** Identity id → episode number when one could be parsed. Used by
   *  TMDb renaming downstream. */
  episodeNumbers: Map<number, number>;
}

/**
 * Try every filename pattern in the bank; score by (coverage * 0.7 +
 * season-count-match * 0.3); return the winner.
 *
 * `expectedSeasons` is the user's stated count (or null if they haven't
 * touched the input). When provided, patterns whose distinct-season
 * count is far from `expectedSeasons` get penalized — this is what
 * disambiguates patterns like "1.1" / "1e1" that would otherwise match
 * incidental dots/letters in unrelated filenames.
 */
function detectFromFilename(
  rows: LibraryRow[],
  expectedSeasons: number | null,
): FilenameDetection {
  let best: FilenameDetection | null = null;
  for (const pat of FILENAME_PATTERNS) {
    const assignments = new Map<number, number | null>();
    const episodes = new Map<number, number>();
    const seasons = new Set<number>();
    let matched = 0;
    for (const r of rows) {
      const filename = r.file.path.split(/[\\/]/).pop() ?? "";
      const result = pat.parse(filename);
      if (result) {
        assignments.set(r.identity.id, result.season);
        episodes.set(r.identity.id, result.episode);
        seasons.add(result.season);
        matched++;
      } else {
        assignments.set(r.identity.id, null);
      }
    }
    const coverage = rows.length > 0 ? matched / rows.length : 0;
    let seasonMatch = 0.5;
    if (expectedSeasons != null && expectedSeasons > 0 && seasons.size > 0) {
      const diff = Math.abs(seasons.size - expectedSeasons);
      // Within ±1 → near-perfect; further away → decays toward 0.
      seasonMatch = Math.max(0, 1 - diff / Math.max(expectedSeasons, 1));
    } else if (seasons.size > 0) {
      // No user input — a plausible count (≤30 seasons) is mild positive
      // signal; a runaway count (e.g. 60 distinct "seasons") is a sign the
      // pattern is matching incidental numbers, not real season indices.
      seasonMatch = seasons.size <= 30 ? 0.5 : 0.1;
    }
    const confidence = coverage * 0.7 + seasonMatch * 0.3;
    // Penalize patterns that matched zero rows — they shouldn't beat a
    // pattern with any coverage on a tie.
    const effective = matched === 0 ? -1 : confidence;
    if (best == null || effective > best.confidence) {
      best = {
        source: "filename",
        assignments,
        seasonCount: seasons.size,
        unassignedCount: rows.length - matched,
        patternName: pat.name,
        confidence: effective,
        episodeNumbers: episodes,
      };
    }
  }
  // Fallback for an empty pool.
  return (
    best ?? {
      source: "filename",
      assignments: new Map(),
      seasonCount: 0,
      unassignedCount: rows.length,
      patternName: "(none matched)",
      confidence: 0,
      episodeNumbers: new Map(),
    }
  );
}

/** Confidence for the folder detector — purely coverage-based since
 *  folder names are categorical, not numeric guesses. */
function folderConfidence(g: SeasonGuess, total: number): number {
  if (total === 0) return 0;
  const covered = total - g.unassignedCount;
  return covered / total;
}

/**
 * Compare folder + filename detections; pick the winner. Folder wins
 * ties because curated structures are more reliable than embedded
 * numbers. The user's stated season count flows into the filename
 * detector's scoring so ambiguous patterns get the disambiguation they
 * need.
 */
function pickBestGuess(
  rows: LibraryRow[],
  expectedSeasons: number | null,
): SeasonGuess & { patternHint?: string; episodeNumbers?: Map<number, number> } {
  const fromFolder = detectFromFolder(rows);
  const fromFilename = detectFromFilename(rows, expectedSeasons);
  const folderScore = folderConfidence(fromFolder, rows.length);
  if (folderScore >= fromFilename.confidence) {
    return fromFolder;
  }
  return {
    ...fromFilename,
    patternHint: fromFilename.patternName,
    episodeNumbers: fromFilename.episodeNumbers,
  };
}

export function AutoDetectSeasonsModal({
  seriesId,
  seriesName,
  rows,
  onChanged,
  onClose,
}: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);

  // Initial guess. Computed once at mount with no user-supplied count.
  const initialGuess = useMemo(() => pickBestGuess(rows, null), [rows]);
  const [method, setMethod] = useState<DetectionMethod>(initialGuess.source);
  const [userSeasonCount, setUserSeasonCount] = useState<string>(
    String(initialGuess.seasonCount || 1),
  );
  const [assignments, setAssignments] = useState<Map<number, number | null>>(
    () => new Map(initialGuess.assignments),
  );
  // Hint about which filename pattern won the scoring — surfaced in the
  // UI so the user knows what we matched against.
  const [filenamePatternHint, setFilenamePatternHint] = useState<string | null>(
    initialGuess.source === "filename"
      ? (initialGuess as { patternHint?: string }).patternHint ?? null
      : null,
  );
  // Per-file episode numbers from the latest filename-pattern run.
  // Used by TMDb renaming to look up episode metadata when the user
  // doesn't manually enter ep numbers. Keyed by identity_id.
  const [_episodeNumbers, _setEpisodeNumbers] = useState<Map<number, number>>(
    () =>
      (initialGuess as { episodeNumbers?: Map<number, number> })
        .episodeNumbers ?? new Map(),
  );
  const [busy, setBusy] = useState(false);
  const [tmdbHits, setTmdbHits] = useState<TmdbTvSearchResult[] | null>(null);
  const [tmdbSearching, setTmdbSearching] = useState(false);
  const [tmdbQuery, setTmdbQuery] = useState(seriesName);
  const [tmdbPicked, setTmdbPicked] = useState<TmdbTvSearchResult | null>(null);
  const [tmdbRenameEpisodes, setTmdbRenameEpisodes] = useState(true);
  // Three random filename samples (with parent folder context) for the
  // user to eyeball — per directive line "pick three random filenames
  // from the series and have the user input what part of the filename
  // to guess." Stable across re-renders (mounted-once memo).
  const samples = useMemo(() => {
    if (rows.length === 0) return [];
    const shuffled = [...rows].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 3).map((r) => {
      const segs = r.file.path.split(/[\\/]/);
      return {
        identityId: r.identity.id,
        filename: segs[segs.length - 1] ?? r.file.path,
        parentFolder: segs[segs.length - 2] ?? "",
      };
    });
  }, [rows]);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  // When the user switches detection method OR edits the stated season
  // count, recompute the assignments map. The filename detector uses
  // the stated count as a disambiguation hint — typing "5" makes us
  // strongly prefer a pattern that splits files into ~5 groups over
  // one that splits them into 1 or 30.
  useEffect(() => {
    const parsedCount = parseInt(userSeasonCount, 10);
    const hint = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : null;
    if (method === "folder") {
      const g = detectFromFolder(rows);
      setAssignments(new Map(g.assignments));
      setFilenamePatternHint(null);
    } else if (method === "filename") {
      const g = detectFromFilename(rows, hint);
      setAssignments(new Map(g.assignments));
      setFilenamePatternHint(g.patternName);
      _setEpisodeNumbers(g.episodeNumbers);
    } else if (method === "manual") {
      setFilenamePatternHint(null);
      // Keep current assignments — the user wants to edit by hand.
    }
    // tmdb method is treated separately (uses tmdbPicked + episode list).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, userSeasonCount]);

  // Derived: detected seasons in the current assignment map.
  const detectedCount = useMemo(() => {
    const seasons = new Set<number>();
    for (const v of assignments.values()) {
      if (v != null) seasons.add(v);
    }
    return seasons.size;
  }, [assignments]);
  const unassignedCount = useMemo(() => {
    let n = 0;
    for (const v of assignments.values()) {
      if (v == null) n++;
    }
    return n;
  }, [assignments]);

  // The user-edited season count is treated as a STRONG SUGGESTION, not
  // gospel — per the directive line: "user might mess up; ask to
  // confirm if you think the number's wrong." We display a warning when
  // the detected count diverges from the user's stated count.
  const userStatedCount = parseInt(userSeasonCount, 10);
  const userStatedValid = Number.isFinite(userStatedCount) && userStatedCount > 0;
  const countMismatch =
    userStatedValid &&
    detectedCount > 0 &&
    Math.abs(detectedCount - userStatedCount) >= 1;

  // ── TMDb flow ──────────────────────────────────────────────────────
  const runTmdbSearch = async () => {
    setTmdbSearching(true);
    try {
      const hits = await tmdbIpc.tvSearch(tmdbQuery.trim());
      setTmdbHits(hits);
    } catch (err) {
      showToast(`TMDb TV search failed: ${err}`, "error");
    } finally {
      setTmdbSearching(false);
    }
  };

  const applyTmdbRenaming = async (picked: TmdbTvSearchResult) => {
    if (busy) return;
    setBusy(true);
    try {
      // Group identities by their current (parsed) season — we need a
      // season assignment first to know which TMDb season to look up.
      const bySeason = new Map<number, Array<{ identityId: number; episodeGuess: number | null }>>();
      for (const r of rows) {
        const season = assignments.get(r.identity.id) ?? null;
        if (season == null) continue;
        const name = r.file.path.split(/[\\/]/).pop() ?? "";
        let ep: number | null = null;
        const sxxexx = name.match(/[Ss]\d{1,3}[._\s-]*[Ee](\d{1,3})/);
        if (sxxexx) ep = parseInt(sxxexx[1]!, 10);
        if (ep == null) {
          const sxe = name.match(/\d{1,2}x(\d{1,3})/i);
          if (sxe) ep = parseInt(sxe[1]!, 10);
        }
        if (ep == null) {
          // Fallback: trailing "01", "02" before extension as an
          // episode-only number (e.g., "Ronja 01.mkv").
          const trailing = name.match(/(?:^|[\s._-])(\d{1,3})(?=\.[A-Za-z0-9]{2,4}$)/);
          if (trailing) ep = parseInt(trailing[1]!, 10);
        }
        const list = bySeason.get(season) ?? [];
        list.push({ identityId: r.identity.id, episodeGuess: ep });
        bySeason.set(season, list);
      }

      let renamed = 0;
      let skipped = 0;
      for (const [seasonNum, members] of bySeason) {
        let episodes: TmdbTvSeasonEpisode[] = [];
        try {
          episodes = await tmdbIpc.tvSeason(picked.tmdb_tv_id, seasonNum);
        } catch {
          skipped += members.length;
          continue;
        }
        // For members WITH a parsed episode number, look it up. For
        // members without, fall back to sequential order within the
        // season (preserve the file's natural sort).
        const sortedMembers = [...members].sort((a, b) => {
          const ea = a.episodeGuess ?? 999;
          const eb = b.episodeGuess ?? 999;
          return ea - eb;
        });
        for (let i = 0; i < sortedMembers.length; i++) {
          const m = sortedMembers[i]!;
          const ep =
            (m.episodeGuess != null
              ? episodes.find((e) => e.episode_number === m.episodeGuess)
              : null) ?? episodes[i];
          if (!ep || !ep.name) {
            skipped++;
            continue;
          }
          const padded2 = (n: number) => (n < 10 ? `0${n}` : String(n));
          const title = `${picked.name} S${padded2(seasonNum)}E${padded2(ep.episode_number)} — ${ep.name}`;
          try {
            await libraryIpc.setManualMetadata(m.identityId, "title", title);
            if (ep.overview) {
              await libraryIpc.setNotes(m.identityId, ep.overview);
            }
            renamed++;
          } catch {
            skipped++;
          }
        }
      }
      showToast(
        `Renamed ${renamed} episode${renamed === 1 ? "" : "s"} from TMDb${skipped > 0 ? ` (${skipped} skipped)` : ""}`,
        skipped > 0 && renamed === 0 ? "warn" : "info",
        3500,
      );
    } finally {
      setBusy(false);
    }
  };

  // ── Apply ──────────────────────────────────────────────────────────
  const apply = async () => {
    if (busy) return;
    if (userStatedValid && countMismatch) {
      // Per directive: weight the user's stated count heavily but confirm
      // when the detected count diverges. This is the confirmation gate.
      const ok = window.confirm(
        `You said there are ${userStatedCount} season${userStatedCount === 1 ? "" : "s"}, ` +
          `but I detected ${detectedCount} from the ${method} pattern. ` +
          `\n\nApply the ${detectedCount}-season detection anyway, or cancel and switch methods?`,
      );
      if (!ok) return;
    }
    setBusy(true);
    try {
      // Ensure has_seasons=true on the series before assigning.
      await libraryIpc.setSeriesHasSeasons(seriesId, true);
      let okCount = 0;
      let failCount = 0;
      for (const [identityId, season] of assignments) {
        if (season == null) continue;
        try {
          await libraryIpc.setSeriesItemSeason(seriesId, identityId, season);
          okCount++;
        } catch {
          failCount++;
        }
      }
      if (method === "tmdb" && tmdbPicked && tmdbRenameEpisodes) {
        await applyTmdbRenaming(tmdbPicked);
      }
      showToast(
        `Assigned ${okCount} episode${okCount === 1 ? "" : "s"} to seasons${failCount > 0 ? ` (${failCount} failed)` : ""}`,
        failCount > 0 ? "warn" : "info",
        3000,
      );
      await onChanged();
      onClose();
    } catch (err) {
      showToast(`Apply failed: ${err}`, "error");
      setBusy(false);
    }
  };

  // ── Per-row manual edit helpers ───────────────────────────────────
  const updateAssignment = (identityId: number, value: string) => {
    const next = new Map(assignments);
    if (value === "" || value === "unassigned") {
      next.set(identityId, null);
    } else {
      const n = parseInt(value, 10);
      next.set(identityId, Number.isFinite(n) && n > 0 ? n : null);
    }
    setAssignments(next);
  };

  // For the manual mode preview, show ALL rows so the user can edit
  // anything. For other modes, show a compact summary + first ~20 rows
  // so the modal stays readable.
  const previewRows = useMemo(() => {
    const sorted = [...rows].sort((a, b) => {
      const sa = assignments.get(a.identity.id) ?? 999;
      const sb = assignments.get(b.identity.id) ?? 999;
      if (sa !== sb) return sa - sb;
      return (a.identity.movie_title ?? a.file.path).localeCompare(
        b.identity.movie_title ?? b.file.path,
      );
    });
    return method === "manual" ? sorted : sorted.slice(0, 20);
  }, [rows, assignments, method]);

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[80] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col w-[680px] max-w-[95vw] max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-fvp-text">
              Auto-detect seasons — {seriesName}
            </div>
            <div className="text-[11px] text-fvp-muted mt-0.5">
              {rows.length} item{rows.length === 1 ? "" : "s"} in this series.
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-fvp-muted hover:text-fvp-text text-lg leading-none disabled:opacity-50"
          >
            ×
          </button>
        </header>

        <div className="flex-1 overflow-y-auto min-h-0 px-5 py-3 space-y-4">
          {/* Season count Q ─────────────────────────────────────── */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-1">
              How many seasons does "{seriesName}" have?
            </div>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={50}
                value={userSeasonCount}
                onChange={(e) => setUserSeasonCount(e.target.value)}
                className="w-20 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text outline-none"
              />
              <span className="text-[11px] text-fvp-muted">
                (guessed: {initialGuess.seasonCount || 1} from the {initialGuess.source} pattern)
              </span>
            </div>
            {countMismatch && (
              <div className="text-[11px] text-fvp-warn mt-1">
                ⚠ I detected {detectedCount} seasons from the {method} pattern.
                If your number is right, the detection is missing some files —
                consider switching methods or going manual.
              </div>
            )}
          </section>

          {/* Method Q ───────────────────────────────────────────── */}
          <section>
            <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-1">
              How are episodes assigned to seasons?
            </div>
            <div className="space-y-1.5">
              <MethodRadio
                value="folder"
                current={method}
                label="From folder name"
                recommended
                hint="Each file's parent folder is 'Season 1', 'S01', 'Series 1', etc. Works for most curated TV libraries."
                onSelect={() => setMethod("folder")}
              />
              <MethodRadio
                value="filename"
                current={method}
                label="From filename"
                hint="The episode filename contains S01E03 / 1x03 / Season 1."
                onSelect={() => setMethod("filename")}
              />
              <MethodRadio
                value="tmdb"
                current={method}
                label="Look up on TMDb (auto-name episodes too)"
                hint="Search TMDb for the show; we apply each episode's official name to your files."
                onSelect={() => setMethod("tmdb")}
              />
              <MethodRadio
                value="manual"
                current={method}
                label="I'll set them by hand"
                hint="Edit each row's season below."
                onSelect={() => setMethod("manual")}
              />
            </div>
          </section>

          {/* Filename samples — visible whenever a pattern-based
              method is selected, so the user can eyeball whether the
              detection is plausible. */}
          {(method === "filename" || method === "folder") && (
            <section className="bg-fvp-bg/50 border border-fvp-border rounded p-2">
              <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-1 flex items-center justify-between gap-2">
                <span>
                  Three random samples — does the {method} pattern look right?
                </span>
                {method === "filename" && filenamePatternHint && (
                  <span className="text-fvp-accent normal-case font-mono">
                    matched: {filenamePatternHint}
                  </span>
                )}
              </div>
              <div className="space-y-1 text-[11px] font-mono">
                {samples.map((s, i) => {
                  const assigned = assignments.get(s.identityId);
                  return (
                    <div key={i}>
                      <span className="text-fvp-muted">📁 {s.parentFolder} / </span>
                      <span className="text-fvp-text">{s.filename}</span>{" "}
                      {assigned != null ? (
                        <span className="text-fvp-accent font-bold">
                          (Season {assigned})
                        </span>
                      ) : (
                        <span className="text-fvp-warn">(unassigned)</span>
                      )}
                    </div>
                  );
                })}
              </div>
              {method === "filename" && userStatedValid && (
                <div className="text-[10px] text-fvp-muted mt-1.5 italic">
                  Using your stated count of {userSeasonCount} season
                  {userStatedCount === 1 ? "" : "s"} to pick the best pattern.
                </div>
              )}
            </section>
          )}

          {/* TMDb panel ─────────────────────────────────────────── */}
          {method === "tmdb" && (
            <section className="bg-fvp-bg/50 border border-fvp-border rounded p-2 space-y-2">
              <div className="text-[10px] uppercase tracking-wider text-fvp-muted">
                Find this series on TMDb
              </div>
              <div className="flex gap-2">
                <input
                  value={tmdbQuery}
                  onChange={(e) => setTmdbQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void runTmdbSearch();
                    }
                  }}
                  className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text outline-none"
                  placeholder="Series title…"
                />
                <button
                  onClick={() => void runTmdbSearch()}
                  disabled={tmdbSearching || !tmdbQuery.trim()}
                  className="px-3 py-1 bg-fvp-accent text-white text-[11px] rounded disabled:opacity-50"
                >
                  {tmdbSearching ? "…" : "Search"}
                </button>
              </div>
              {tmdbHits && tmdbHits.length === 0 && (
                <div className="text-[11px] text-fvp-muted italic">
                  No matches on TMDb.
                </div>
              )}
              {tmdbHits && tmdbHits.length > 0 && (
                <ul className="space-y-1 max-h-[180px] overflow-y-auto">
                  {tmdbHits.map((h) => (
                    <li
                      key={h.tmdb_tv_id}
                      onClick={() => setTmdbPicked(h)}
                      className={
                        "p-2 rounded cursor-pointer flex gap-2 items-start " +
                        (tmdbPicked?.tmdb_tv_id === h.tmdb_tv_id
                          ? "bg-fvp-accent/20 border border-fvp-accent"
                          : "hover:bg-fvp-surface2/50 border border-transparent")
                      }
                    >
                      {h.poster_url && (
                        <img
                          src={h.poster_url}
                          alt=""
                          className="w-10 h-14 object-cover rounded"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-semibold text-fvp-text truncate">
                          {h.name}
                          {h.first_air_year && (
                            <span className="text-fvp-muted ml-1">
                              ({h.first_air_year})
                            </span>
                          )}
                        </div>
                        {h.number_of_seasons != null && (
                          <div className="text-[10px] text-fvp-accent">
                            {h.number_of_seasons} season
                            {h.number_of_seasons === 1 ? "" : "s"} on TMDb
                          </div>
                        )}
                        <div className="text-[10px] text-fvp-muted line-clamp-2">
                          {h.overview || "(no overview)"}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {tmdbPicked && (
                <label className="flex items-center gap-2 cursor-pointer text-[11px] mt-1">
                  <input
                    type="checkbox"
                    checked={tmdbRenameEpisodes}
                    onChange={(e) => setTmdbRenameEpisodes(e.target.checked)}
                    className="accent-fvp-accent"
                  />
                  Also rename my episode files using TMDb episode names
                </label>
              )}
            </section>
          )}

          {/* Preview / manual edit ──────────────────────────────── */}
          <section>
            <div className="flex items-center justify-between mb-1">
              <div className="text-[10px] uppercase tracking-wider text-fvp-muted">
                Preview
                {method !== "manual" && (
                  <span className="ml-2 text-fvp-muted normal-case">
                    (showing first 20 of {rows.length})
                  </span>
                )}
              </div>
              <div className="text-[11px] text-fvp-muted">
                {detectedCount} season{detectedCount === 1 ? "" : "s"} ·{" "}
                {unassignedCount} unassigned
              </div>
            </div>
            <div className="border border-fvp-border rounded max-h-[300px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="bg-fvp-bg sticky top-0">
                  <tr>
                    <th className="text-left px-2 py-1 text-fvp-muted text-[10px] uppercase tracking-wider">
                      Title
                    </th>
                    <th className="text-left px-2 py-1 text-fvp-muted text-[10px] uppercase tracking-wider w-20">
                      Season
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r) => {
                    const season = assignments.get(r.identity.id);
                    return (
                      <tr key={r.identity.id} className="border-t border-fvp-border/40">
                        <td className="px-2 py-1 truncate text-fvp-text">
                          {r.identity.movie_title ??
                            r.file.path.split(/[\\/]/).pop() ??
                            "?"}
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            min={0}
                            max={50}
                            value={season ?? ""}
                            onChange={(e) =>
                              updateAssignment(r.identity.id, e.target.value)
                            }
                            placeholder="—"
                            className="w-14 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-1 py-0.5 text-[11px] text-fvp-text outline-none"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-end gap-2 text-xs">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1 text-fvp-text hover:bg-fvp-surface2 rounded disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void apply()}
            disabled={busy || detectedCount === 0 || (method === "tmdb" && !tmdbPicked)}
            className="px-3 py-1 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Working…" : "Apply"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function MethodRadio({
  value,
  current,
  label,
  hint,
  recommended,
  onSelect,
}: {
  value: DetectionMethod;
  current: DetectionMethod;
  label: string;
  hint: string;
  recommended?: boolean;
  onSelect: () => void;
}) {
  const active = current === value;
  return (
    <label
      onClick={onSelect}
      className={
        "flex items-start gap-2 cursor-pointer p-2 rounded border " +
        (active
          ? "border-fvp-accent bg-fvp-accent/10"
          : "border-fvp-border hover:bg-fvp-surface2/30")
      }
    >
      <input
        type="radio"
        checked={active}
        onChange={onSelect}
        className="accent-fvp-accent mt-0.5"
      />
      <div>
        <div className="text-xs text-fvp-text font-semibold">
          {label}
          {recommended && (
            <span className="ml-2 text-[10px] font-normal text-fvp-accent italic">
              (recommended organization)
            </span>
          )}
        </div>
        <div className="text-[11px] text-fvp-muted">{hint}</div>
      </div>
    </label>
  );
}
