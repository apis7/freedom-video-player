import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { libraryIpc, type LibraryRow } from "../../ipc/library";

interface Props {
  rows: LibraryRow[];
  /** Identity id of the file the user right-clicked to launch this
   *  modal. Used to pick the "best guess" proposal (the one whose
   *  member set CONTAINS this identity) and enable only that one by
   *  default. All other proposals stay listed but unchecked so the
   *  user opts in explicitly. Pass undefined when not relevant (e.g.
   *  the top-level "Auto-detect series" toolbar entry that scans the
   *  whole library — in that case fall back to all-on default). */
  sourceIdentityId?: number;
  /** Names of existing series so we can dedupe proposals — proposing
   *  to create "Hogan's Heroes" when it already exists wastes the user's
   *  time. Pass empty list when not loaded yet. */
  existingSeriesNames: string[];
  /** Names of existing collections so we can pre-disable the "Also add
   *  as collection" checkbox when a collection of that name exists. */
  existingCollectionNames: string[];
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}

interface Proposal {
  /** Suggested series name (parent folder's last segment, cleaned). */
  name: string;
  /** Identity ids that would be moved under this new series. */
  identityIds: number[];
  /** Sample titles for the user to sanity-check the grouping. */
  sampleTitles: string[];
  /** Whether this group will be created on Confirm. */
  enabled: boolean;
  /** Whether to also create a Collection mirroring this series. Per
   *  directive: independent of `enabled`, default unchecked. */
  alsoAsCollection: boolean;
  /** Detected season-folder count when the grouping is across nested
   *  "Season N" subdirectories. 0 = no season subfolders (flat layout). */
  seasonFolderCount: number;
  /** Mark hint pre-populates the seasons-detection method when the user
   *  scopes into the newly created series and runs Auto-detect seasons. */
  recommendedSeasonsMethod: "folder" | "filename" | "none";
}

/** Clean a folder name into a sensible series title. Strips trailing
 *  year-in-parens, normalizes whitespace, AND chops trailing tokens
 *  that aren't part of the show name ("- series", "- collection",
 *  "- seasons", "edits", "episodes") which often live in user folders. */
function cleanSeriesName(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    // Remove trailing junk separators commonly seen in folder names —
    // "Show - series", "Show - seasons", "Show - collection", "Show — set".
    .replace(/\s*[-–—]\s*(series|seasons?|collection|set|edits?|episodes?|tv)\s*$/i, "")
    .trim();
}

/** Lightweight season parser for the bulk series-creation flow. Catches
 *  the most common patterns: parent folder "Season N" / "S0N",
 *  filename "S01E03" / "1x03". Returns null on no match. */
function parseSeasonFromPathQuick(path: string): number | null {
  const segs = path.split(/[\\/]/);
  const parentName = segs[segs.length - 2] ?? "";
  const folderMatch = parentName.match(/(?:season|series|s)\s*(\d{1,3})/i);
  if (folderMatch) return parseInt(folderMatch[1]!, 10);
  const name = segs[segs.length - 1] ?? "";
  const sxxexx = name.match(/[Ss](\d{1,3})[._\s-]*[Ee]\d{1,3}/);
  if (sxxexx) return parseInt(sxxexx[1]!, 10);
  const sxe = name.match(/(?:^|[\s._-])(\d{1,2})x\d{1,3}(?:[\s._-]|$)/i);
  if (sxe) return parseInt(sxe[1]!, 10);
  return null;
}

/**
 * Returns true when a folder name looks like a season label. Permissive
 * enough to catch the realities of curated libraries:
 *   - "Season 1", "Season 01", "Season 1 - The Pilot Years"
 *   - "S01", "S1", "S01 - extras", "s.01"
 *   - "Series 1" (BBC convention — Jeeves & Wooster, Sherlock, etc.)
 *   - "Volume 1", "Vol 1", "Vol. 1"
 *   - "Disc 1", "Part 1", "Book 1"
 *   - "Season One", "Series Two" (word numbers up to fifteen)
 *   - Bare numeric folders: "1", "01", "001" — but only when they look
 *     like a season index (length ≤ 3 digits, optional zero padding)
 */
function looksLikeSeasonFolderName(name: string): boolean {
  const cleaned = name.trim();
  if (!cleaned) return false;
  // Standard verbose prefixes — "Season N", "Series N", "Volume N", etc.
  // Anything after the digit is fine (handles "Season 1 - The Pilot").
  if (/^(season|series|vol(?:ume)?\.?|disc|book|part)\s*0*\d{1,3}\b/i.test(cleaned))
    return true;
  // Compact "S01" / "S1" / "s.01" / "S01 - Pilot". Followed by digits then
  // a word boundary so we don't eat names like "Shrek".
  if (/^s\.?0*\d{1,3}\b/i.test(cleaned)) return true;
  // Bare numeric folder: "1", "01", "001". Common when users index by
  // number alone. ≤3 digits keeps us from misreading "2023" (a year) as
  // a season.
  if (/^0*\d{1,3}$/.test(cleaned)) return true;
  // Word-numbered: "Season One", "Series Three". Up to fifteen.
  if (
    /^(season|series)\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\b/i.test(
      cleaned,
    )
  )
    return true;
  return false;
}

/** Extract the season number from a folder name that has already been
 *  validated by `looksLikeSeasonFolderName`. Returns null if no number
 *  can be pulled (caller falls back to ordinal assignment).
 *  Exported for testing; kept internal otherwise. */
// @ts-expect-error reserved for future ordinal-assignment fallback in the
// series detector when sibling folder names don't contain explicit numbers.
function seasonNumberFromFolderName(name: string): number | null {
  const cleaned = name.trim();
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
 * Walk a file path up to the series root. If the immediate parent looks
 * like a season folder, climb one more level to the actual series root.
 * Returns the series-root path + the season-folder name (or null when
 * the file lives in a flat-layout series with no season subfolders).
 */
function findSeriesRoot(filePath: string): {
  seriesPath: string;
  seasonFolderName: string | null;
} {
  const segs = filePath.split(/[\\/]/).filter(Boolean);
  if (segs.length < 2) return { seriesPath: filePath, seasonFolderName: null };
  const parentName = segs[segs.length - 2] ?? "";
  if (looksLikeSeasonFolderName(parentName) && segs.length >= 3) {
    // Climb one more level to the series root.
    const seriesPath = filePath.replace(/[\\/][^\\/]+[\\/][^\\/]+$/, "");
    return { seriesPath, seasonFolderName: parentName };
  }
  return {
    seriesPath: filePath.replace(/[\\/][^\\/]+$/, ""),
    seasonFolderName: null,
  };
}

/** Minimum number of episodes in a folder before we propose it as a
 *  series. Folders with 1–2 files are likely just a movie + extras. */
const MIN_GROUP_SIZE = 3;

/**
 * Auto-detect series modal. Groups library files by parent folder; any
 * folder with ≥3 episode-like files that aren't already in a series
 * becomes a proposed grouping. The user reviews + edits names and
 * confirms; we then create the series rows + add identities in batch.
 *
 * Per directive — help users sort items INTO series rather than
 * forcing them to drag-and-drop one at a time.
 */
export function AutoDetectSeriesModal({
  rows,
  sourceIdentityId,
  existingSeriesNames,
  existingCollectionNames,
  onChanged,
  onClose,
}: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState(false);

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

  const computed = useMemo(() => {
    // Two-level grouping per directive: when files live in nested
    // "Season N" subfolders under a common series root (e.g.
    // \TV SERIES\Hogan's Heroes\Season 1\*.avi), roll them all up
    // into ONE proposed series and remember the distinct season
    // folders for the badge. Flat layouts still work (a single folder
    // of episodes with no nested season dirs).
    const groups = new Map<string, { members: LibraryRow[]; seasons: Set<string> }>();
    for (const r of rows) {
      // Skip rows already in a series — proposals only target
      // unassigned items.
      if (r.series != null) continue;
      if (r.__synthetic_series) continue;
      const { seriesPath, seasonFolderName } = findSeriesRoot(r.file.path);
      const entry = groups.get(seriesPath) ?? {
        members: [],
        seasons: new Set<string>(),
      };
      entry.members.push(r);
      if (seasonFolderName) entry.seasons.add(seasonFolderName);
      groups.set(seriesPath, entry);
    }
    const existingSeriesLower = new Set(
      existingSeriesNames.map((n) => n.trim().toLowerCase()),
    );
    const out: Proposal[] = [];
    for (const [seriesPath, { members, seasons }] of groups) {
      if (members.length < MIN_GROUP_SIZE) continue;
      const folderName = seriesPath.split(/[\\/]/).pop() ?? "Untitled series";
      const cleaned = cleanSeriesName(folderName);
      // Skip proposals whose name already exists as a series — the user
      // can manually add the new files to that existing series instead.
      if (existingSeriesLower.has(cleaned.toLowerCase())) continue;
      const identityIds = Array.from(
        new Set(members.map((m) => m.identity.id)),
      );
      // When the modal was triggered from a specific identity, only the
      // proposal whose member set CONTAINS that identity is the "best
      // guess" — enable just that one by default. All other proposals
      // stay listed but unchecked. With no source identity (whole-library
      // auto-detect), keep the all-on default.
      const isBestGuess =
        sourceIdentityId == null
          ? true
          : identityIds.includes(sourceIdentityId);
      out.push({
        name: cleaned,
        identityIds,
        sampleTitles: members
          .slice(0, 4)
          .map((m) => m.identity.movie_title ?? m.file.path.split(/[\\/]/).pop() ?? "?")
          .filter(Boolean),
        enabled: isBestGuess,
        alsoAsCollection: false,
        seasonFolderCount: seasons.size,
        recommendedSeasonsMethod:
          seasons.size > 0 ? "folder" : "filename",
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }, [rows, existingSeriesNames]);

  // Reset proposals state when the computed list changes.
  useEffect(() => {
    setProposals(computed);
  }, [computed]);

  const enabledCount = proposals.filter((p) => p.enabled).length;

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    let created = 0;
    let failed = 0;
    let collectionsCreated = 0;
    const existingCollectionLower = new Set(
      existingCollectionNames.map((n) => n.trim().toLowerCase()),
    );
    for (const p of proposals) {
      if (!p.enabled || p.name.trim() === "") continue;
      try {
        // When we detected nested "Season N" subfolders, create the
        // series with has_seasons=true AND immediately assign each
        // identity's season based on its file path. Saves the user the
        // extra step of opening Auto-detect seasons afterwards.
        const hasSeasons = p.seasonFolderCount > 1;
        const seriesId = await libraryIpc.createSeries(
          p.name.trim(),
          hasSeasons,
        );
        await libraryIpc.addToSeries(seriesId, p.identityIds);
        if (hasSeasons) {
          const memberRows = rows.filter((r) =>
            p.identityIds.includes(r.identity.id),
          );
          for (const r of memberRows) {
            const season = parseSeasonFromPathQuick(r.file.path);
            if (season != null) {
              try {
                await libraryIpc.setSeriesItemSeason(
                  seriesId,
                  r.identity.id,
                  season,
                );
              } catch {
                // best-effort
              }
            }
          }
        }
        // Optional: also create a Collection mirroring this series. Per
        // directive — collections show items individually in All Movies
        // while series collapses to one tile, so this gives the user a
        // way to surface members both ways simultaneously.
        if (p.alsoAsCollection) {
          let collectionName = p.name.trim();
          if (existingCollectionLower.has(collectionName.toLowerCase())) {
            collectionName = `${collectionName} — collection`;
          }
          try {
            const collectionId = await libraryIpc.createCollection(collectionName);
            await libraryIpc.addToCollection(collectionId, p.identityIds);
            existingCollectionLower.add(collectionName.toLowerCase());
            collectionsCreated++;
          } catch {
            // Non-fatal — the series itself was created successfully.
          }
        }
        created++;
      } catch {
        failed++;
      }
    }
    setBusy(false);
    const collMsg = collectionsCreated > 0
      ? ` (+${collectionsCreated} collection${collectionsCreated === 1 ? "" : "s"})`
      : "";
    showToast(
      `Created ${created} series${collMsg}${failed > 0 ? `, ${failed} failed` : ""}`,
      failed > 0 ? "warn" : "info",
      3500,
    );
    await onChanged();
    onClose();
  };

  const setAllEnabled = (value: boolean) => {
    setProposals(proposals.map((p) => ({ ...p, enabled: value })));
  };
  const setAllCollections = (value: boolean) => {
    setProposals(proposals.map((p) => ({ ...p, alsoAsCollection: value })));
  };

  return (
    // NOTE: backdrop intentionally does NOT close the modal on click.
    // The user has typed/checked work in here that would be lost on an
    // accidental misclick. They close via Cancel, ×, or Esc.
    <div className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center">
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col w-[720px] max-w-[95vw] max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-3 border-b border-fvp-border flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-fvp-text">
              Auto-detect series
            </div>
            <div className="text-[11px] text-fvp-muted mt-0.5">
              Groups library files by parent folder. Folders with 3+ episodes
              become proposed series. Already-existing series are skipped.
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-fvp-muted hover:text-fvp-text text-lg leading-none"
          >
            ×
          </button>
        </header>

        {proposals.length > 0 && (
          <div className="px-5 py-2 border-b border-fvp-border bg-fvp-bg/40 flex items-center gap-2 text-[11px]">
            <button
              onClick={() => setAllEnabled(true)}
              className="px-2 py-0.5 text-fvp-accent hover:underline"
            >
              Select all
            </button>
            <span className="text-fvp-muted">·</span>
            <button
              onClick={() => setAllEnabled(false)}
              className="px-2 py-0.5 text-fvp-muted hover:underline"
            >
              Deselect all
            </button>
            <span className="text-fvp-muted">·</span>
            <button
              onClick={() => setAllCollections(true)}
              className="px-2 py-0.5 text-fvp-muted hover:underline"
              title="Check 'Also as collection' on every proposal"
            >
              All as collections too
            </button>
            <span className="text-fvp-muted">·</span>
            <button
              onClick={() => setAllCollections(false)}
              className="px-2 py-0.5 text-fvp-muted hover:underline"
            >
              None as collections
            </button>
          </div>
        )}

        <div className="px-5 py-2 border-b border-fvp-border bg-fvp-warn/10 text-[11px] text-fvp-text/90 leading-relaxed">
          <strong className="text-fvp-warn">Tip:</strong> If you see episodes
          from the SAME show split into separate proposals (e.g. one show
          spread across multiple folders), don&apos;t use this tool for it.
          Instead: cancel out, manually create one series via the sidebar
          &quot;+&quot;, then add each folder to it.
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {proposals.length === 0 && (
            <div className="px-5 py-12 text-center text-xs text-fvp-muted">
              No new groups found. Either every folder has fewer than 3 files,
              or every multi-file folder is already organized into a series.
            </div>
          )}
          {proposals.length > 0 && (
            <ul className="divide-y divide-fvp-border">
              {proposals.map((p, i) => {
                const collectionConflict = existingCollectionNames.some(
                  (n) => n.trim().toLowerCase() === p.name.trim().toLowerCase(),
                );
                return (
                  <li key={i} className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={p.enabled}
                        onChange={(e) => {
                          const next = [...proposals];
                          next[i] = { ...p, enabled: e.target.checked };
                          setProposals(next);
                        }}
                        className="accent-fvp-accent"
                      />
                      <input
                        value={p.name}
                        disabled={!p.enabled}
                        onChange={(e) => {
                          const next = [...proposals];
                          next[i] = { ...p, name: e.target.value };
                          setProposals(next);
                        }}
                        className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-2 py-1 text-xs text-fvp-text disabled:opacity-50"
                      />
                      <span className="text-[11px] text-fvp-muted">
                        {p.identityIds.length} item
                        {p.identityIds.length === 1 ? "" : "s"}
                      </span>
                      {p.seasonFolderCount > 1 && (
                        <span
                          className="text-[10px] px-1.5 py-0.5 bg-fvp-accent/20 text-fvp-accent rounded"
                          title="Nested 'Season N' subfolders detected — episodes will be assigned automatically."
                        >
                          {p.seasonFolderCount} seasons
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] text-fvp-muted mt-1 pl-7 truncate">
                      {p.sampleTitles.join(", ")}
                      {p.identityIds.length > p.sampleTitles.length && " …"}
                    </div>
                    <label
                      className={
                        "flex items-center gap-1.5 pl-7 mt-1.5 text-[10px] cursor-pointer " +
                        (p.enabled ? "text-fvp-muted hover:text-fvp-text" : "opacity-40 cursor-not-allowed")
                      }
                    >
                      <input
                        type="checkbox"
                        checked={p.alsoAsCollection}
                        disabled={!p.enabled}
                        onChange={(e) => {
                          const next = [...proposals];
                          next[i] = { ...p, alsoAsCollection: e.target.checked };
                          setProposals(next);
                        }}
                        className="accent-fvp-accent"
                      />
                      <span>
                        Also create a Collection with these movies
                        {collectionConflict && (
                          <span className="text-fvp-warn ml-1">
                            (will be named &quot;{p.name.trim()} — collection&quot; — name in use)
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
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
            onClick={() => void confirm()}
            disabled={busy || enabledCount === 0}
            className="px-3 py-1 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "Working…" : `Create ${enabledCount} series`}
          </button>
        </footer>
      </div>
    </div>
  );
}
