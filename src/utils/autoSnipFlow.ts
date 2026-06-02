import { useAppStore } from "../state/appStore";
import { autoSnipIpc, type AutoSnipMatch } from "../ipc";
import { truncateLabel } from "./constants";
import type { Flag } from "../state/types";
import type { Snip, SnipAction } from "../ipc/types";

// AutoSnip padding now lives in app settings (autoSnipPadBeforeMs /
// autoSnipPadAfterMs). Per directives the defaults are 200ms before /
// 300ms after the subtitle entry — overridable from Settings.

/** Convert the wordlist bucket string to a real snip action. */
function bucketToAction(bucket: string): SnipAction | null {
  switch (bucket) {
    case "skip":
      return { type: "skip" };
    case "silence":
      return { type: "silence" };
    case "freeze":
      return { type: "freeze_frame" };
    case "replace":
      // Default direction: pull replacement audio from BEFORE the snip
      // (typically safer than after — "before" is usually the same scene).
      return {
        type: "audio_replace",
        from_before: true,
        offset_ms: 0,
        crossfade_ms: 1500,
      };
    default:
      return null;
  }
}

export interface AutoSnipPlan {
  matches: AutoSnipMatch[];
  flagOnlyCount: number;
  snipCount: number;
  byCategory: Map<string, number>;
}

/** Run the backend matcher and produce a plan we can show in a preview.
 *  Filters out matches whose keyword has been added to the per-video
 *  whitelist (`<video>.fvp-whitelist.json`). Uses the selected wordlist
 *  language from settings. */
export async function runAutoSnip(videoPath: string): Promise<AutoSnipPlan> {
  const lang = useAppStore.getState().autoSnipLanguage;
  const [rawMatches, whitelist] = await Promise.all([
    autoSnipIpc.run(videoPath, lang),
    autoSnipIpc.loadWhitelist(videoPath).catch(() => [] as string[]),
  ]);
  const whitelistSet = new Set(whitelist.map((w) => w.toLowerCase()));
  const matches = rawMatches.filter(
    (m) => !whitelistSet.has(m.keyword.toLowerCase()),
  );
  return summarize(matches);
}

/** Same as runAutoSnip but works on subtitle entries that have already been
 *  extracted (used when the video has no external .srt but does have an
 *  embedded sub track we've pulled via the subtitleEntries store field). */
export async function runAutoSnipOnEntries(
  entries: { start_ms: number; end_ms: number; text: string }[],
  videoPath: string,
): Promise<AutoSnipPlan> {
  const lang = useAppStore.getState().autoSnipLanguage;
  const [rawMatches, whitelist] = await Promise.all([
    autoSnipIpc.runOnEntries(entries, lang),
    autoSnipIpc.loadWhitelist(videoPath).catch(() => [] as string[]),
  ]);
  const whitelistSet = new Set(whitelist.map((w) => w.toLowerCase()));
  const matches = rawMatches.filter(
    (m) => !whitelistSet.has(m.keyword.toLowerCase()),
  );
  return summarize(matches);
}

function summarize(matches: AutoSnipMatch[]): AutoSnipPlan {
  let flagOnlyCount = 0;
  let snipCount = 0;
  const byCategory = new Map<string, number>();
  for (const m of matches) {
    if (m.bucket === "flag") flagOnlyCount++;
    else snipCount++;
    byCategory.set(m.category, (byCategory.get(m.category) ?? 0) + 1);
  }
  return { matches, flagOnlyCount, snipCount, byCategory };
}

/** Append a keyword to the per-video whitelist + immediately remove any
 *  matching flags/snips from the current state. */
export async function whitelistKeyword(keyword: string): Promise<void> {
  const state = useAppStore.getState();
  if (!state.currentFile) return;
  try {
    const current = await autoSnipIpc.loadWhitelist(state.currentFile);
    if (!current.includes(keyword)) {
      current.push(keyword);
      await autoSnipIpc.saveWhitelist(state.currentFile, current);
    }
  } catch (err) {
    useAppStore.getState().showToast(`Couldn't save whitelist: ${err}`, "error");
    return;
  }
  // Drop any flags + their linked snips for this keyword from current state.
  const kwLower = keyword.toLowerCase();
  const flagsToRemove = state.flags.filter(
    (f) => f.keyword.toLowerCase() === kwLower,
  );
  if (flagsToRemove.length > 0) {
    state.commitToHistory();
    const removedSnipIds = new Set<string>();
    for (const f of flagsToRemove) {
      if (f.linkedSnipId) removedSnipIds.add(f.linkedSnipId);
    }
    useAppStore.setState((s) => ({
      flags: s.flags.filter((f) => f.keyword.toLowerCase() !== kwLower),
      snips: s.snips.filter((sn) => !removedSnipIds.has(sn.id)),
    }));
  }
  useAppStore
    .getState()
    .showToast(
      `Whitelisted "${keyword}" — future AutoSnip runs will skip this word for this video.`,
      "info",
      6000,
    );
}

/** Materialize selected matches into the store: append flags + auto-created
 *  snips. Each flag is named "<category>: <keyword>" (truncated to fit
 *  MAX_LABEL_LEN). Returns counts for the post-run stats toast. */
export function applyAutoSnipMatches(matches: AutoSnipMatch[]): {
  flagsAdded: number;
  snipsAdded: number;
} {
  if (matches.length === 0) return { flagsAdded: 0, snipsAdded: 0 };
  const state = useAppStore.getState();
  state.commitToHistory();

  if (state.flags.length > 0) {
    state.clearFlags();
  }

  const padBefore = state.autoSnipPadBeforeMs;
  const padAfter = state.autoSnipPadAfterMs;

  const newFlags: Flag[] = [];
  let snipsAdded = 0;
  // We add snips one-by-one so addSnip can do lane assignment correctly
  // against the accumulated state.
  for (const m of matches) {
    let linkedSnipId: string | null = null;
    const action = bucketToAction(m.bucket);
    if (action) {
      const id =
        (globalThis.crypto?.randomUUID?.() as string | undefined) ??
        `snip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const snip: Snip = {
        id,
        start_ms: Math.max(0, m.start_ms - padBefore),
        end_ms: m.end_ms + padAfter,
        categories: [m.category],
        action,
        group_id: null,
        note: `AutoSnip: "${m.keyword}" — ${m.text}`,
      };
      useAppStore.getState().addSnip(snip);
      linkedSnipId = id;
      snipsAdded++;
    }
    newFlags.push({
      ms: m.start_ms,
      name: truncateLabel(`${m.category}: ${m.keyword}`),
      category: m.category,
      keyword: m.keyword,
      subtitleText: m.text,
      linkedSnipId,
    });
  }
  useAppStore.getState().addFlags(newFlags);
  return { flagsAdded: newFlags.length, snipsAdded };
}

/** Group matches by category, useful for the preview list. */
export function groupByCategory(matches: AutoSnipMatch[]): Map<string, AutoSnipMatch[]> {
  const map = new Map<string, AutoSnipMatch[]>();
  for (const m of matches) {
    const arr = map.get(m.category);
    if (arr) arr.push(m);
    else map.set(m.category, [m]);
  }
  return map;
}
