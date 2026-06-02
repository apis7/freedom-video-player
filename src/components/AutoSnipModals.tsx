import { useEffect, useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";
import type { AutoSnipMatch } from "../ipc";
import { applyAutoSnipMatches, groupByCategory } from "../utils/autoSnipFlow";
import { formatTime } from "../utils/format";
import { CATEGORY_COLOR } from "../state/categories";

/** Spinner shown while the backend runs AutoSnip. Subtitle parsing + matching
 *  is usually fast (< 1s); for very long subs the user gets a "still working"
 *  message after a few seconds. */
export function AutoSnipRunningModal() {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    inc();
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => {
      clearInterval(t);
      dec();
    };
  }, [inc, dec]);
  return (
    <div className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center">
      <div className="bg-fvp-surface border border-fvp-border rounded-lg p-6 min-w-[320px] text-center">
        <div className="inline-block w-10 h-10 border-2 border-fvp-border border-t-fvp-accent rounded-full animate-spin mx-auto mb-4" />
        <div className="text-sm text-fvp-text font-semibold mb-1">Running AutoSnip…</div>
        <div className="text-[11px] text-fvp-muted">
          Parsing subtitles · matching wordlist
          {elapsed > 3 && ` · ${elapsed}s elapsed`}
        </div>
      </div>
    </div>
  );
}

interface NoSubsProps {
  videoPath: string;
  onClose: () => void;
}

/** Shown when no .srt is found next to the video. Offers to open
 *  OpenSubtitles in the user's default browser with the filename pre-filled. */
export function AutoSnipNoSubsModal({ videoPath, onClose }: NoSubsProps) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);
  const filename = videoPath.split(/[\\/]/).pop() ?? "";
  const stem = filename.replace(/\.[^.]+$/, "");
  const searchUrl = `https://www.opensubtitles.com/en/search-all/q-${encodeURIComponent(stem)}`;
  const openSearch = async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_external_url", { url: searchUrl });
    } catch (err) {
      // Surface failure; user can copy the URL manually.
      alert(`Couldn't open browser. URL:\n${searchUrl}`);
    }
    onClose();
  };
  return (
    <div
      className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl p-5 min-w-[440px] max-w-[560px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-fvp-text mb-2">No subtitles found</div>
        <div className="text-[12px] text-fvp-muted mb-4">
          AutoSnip needs a <span className="font-mono">.srt</span> file next to the video to
          scan. None was found for <span className="font-mono">{filename}</span>.
          {"\n"}Search OpenSubtitles for a matching subtitle file, download it to the
          same folder as the video, then run AutoSnip again.
        </div>
        <div className="flex justify-end gap-2 text-xs">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
          >
            Cancel
          </button>
          <button
            onClick={() => void openSearch()}
            className="px-3 py-1.5 bg-fvp-accent text-white rounded cursor-pointer"
          >
            Open OpenSubtitles ↗
          </button>
        </div>
      </div>
    </div>
  );
}

interface PreviewProps {
  matches: AutoSnipMatch[];
  onClose: () => void;
}

/** Preview of all matched subtitle lines. User unchecks false-positives,
 *  applies the rest. Snips appear in the timeline as both a flag (marker)
 *  and a colored snip block. */
export function AutoSnipPreviewModal({ matches, onClose }: PreviewProps) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);
  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  // Selection: matches keyed by `${start_ms}-${keyword}` so duplicate rows
  // for the same hit are independent.
  const keyOf = (m: AutoSnipMatch) => `${m.start_ms}-${m.category}-${m.keyword}`;
  const [checked, setChecked] = useState<Set<string>>(
    new Set(matches.map((m) => keyOf(m))),
  );

  const grouped = groupByCategory(matches);
  const categoryNames = Array.from(grouped.keys()).sort();

  const toggle = (key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const setAllInCategory = (cat: string, value: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const m of grouped.get(cat) ?? []) {
        if (value) next.add(keyOf(m));
        else next.delete(keyOf(m));
      }
      return next;
    });
  };

  const apply = () => {
    const selected = matches.filter((m) => checked.has(keyOf(m)));
    const { flagsAdded, snipsAdded } = applyAutoSnipMatches(selected);
    onClose();
    showToast(
      `AutoSnip added ${flagsAdded} flag${flagsAdded === 1 ? "" : "s"}` +
        (snipsAdded > 0 ? ` and ${snipsAdded} snip${snipsAdded === 1 ? "" : "s"}.` : ".") +
        " Heads up: subtitle matching isn't 100% accurate (censored words, mis-timed " +
        "subs, false positives). Review and edit before exporting.",
      "info",
      14_000,
    );
  };

  const totalChecked = checked.size;
  const totalAvailable = matches.length;

  return (
    <div className="fixed inset-0 bg-black/60 z-[55] flex items-center justify-center p-6">
      <div className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col max-w-[800px] w-full max-h-[80vh]">
        <header className="px-5 pt-4 pb-3 border-b border-fvp-border shrink-0">
          <div className="text-sm font-semibold text-fvp-text">
            AutoSnip — review {totalAvailable} match{totalAvailable === 1 ? "" : "es"}
          </div>
          <div className="text-[11px] text-fvp-muted mt-1">
            Uncheck false positives. Applying creates a flag (and a snip for snip-bucket
            categories) for each checked row.
          </div>
        </header>

        <div className="overflow-y-auto px-5 py-3 flex-1">
          {totalAvailable === 0 ? (
            <div className="text-xs text-fvp-muted text-center py-12">
              No matches found in the loaded subtitles.
            </div>
          ) : (
            categoryNames.map((cat) => {
              const items = grouped.get(cat) ?? [];
              const allChecked = items.every((m) => checked.has(keyOf(m)));
              const someChecked = items.some((m) => checked.has(keyOf(m)));
              const isSnipCat = items.some((m) => m.bucket !== "flag");
              const color = CATEGORY_COLOR[cat] ?? "#79c0ff";
              return (
                <section key={cat} className="mb-4">
                  <div className="flex items-center gap-2 mb-2">
                    <input
                      type="checkbox"
                      checked={allChecked}
                      ref={(el) => {
                        if (el) el.indeterminate = !allChecked && someChecked;
                      }}
                      onChange={() => setAllInCategory(cat, !allChecked)}
                      className="accent-fvp-accent"
                    />
                    <span
                      className="inline-block w-2 h-2 rounded-sm"
                      style={{ backgroundColor: color }}
                    />
                    <span className="text-xs font-semibold text-fvp-text">
                      {cat} · {items.length}
                    </span>
                    <span className="text-[10px] text-fvp-muted">
                      ({isSnipCat ? "flag + snip" : "flag only"})
                    </span>
                  </div>
                  <ul className="space-y-1 ml-6">
                    {items.map((m) => {
                      const key = keyOf(m);
                      const isChecked = checked.has(key);
                      return (
                        <li
                          key={key}
                          className={clsx(
                            "flex items-start gap-2 py-1 px-2 rounded text-[11px]",
                            isChecked
                              ? "bg-fvp-surface2/60"
                              : "bg-transparent opacity-60",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggle(key)}
                            className="mt-0.5 accent-fvp-accent shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-fvp-muted">
                                {formatTime(m.start_ms / 1000)}
                              </span>
                              <span className="px-1 py-0.5 rounded text-[9px] font-mono bg-fvp-bg border border-fvp-border text-fvp-text">
                                {m.keyword}
                              </span>
                            </div>
                            <div className="text-fvp-text mt-0.5 truncate" title={m.text}>
                              {m.text}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })
          )}
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-between shrink-0 text-xs">
          <span className="text-fvp-muted">
            {totalChecked} of {totalAvailable} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={totalChecked === 0}
              className="px-3 py-1.5 bg-fvp-accent text-white rounded disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
            >
              Apply {totalChecked} match{totalChecked === 1 ? "" : "es"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
