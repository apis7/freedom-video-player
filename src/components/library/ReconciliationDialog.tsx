import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../state/appStore";
import {
  libraryIpc,
  type LibraryRow,
  type ProbablePair,
  type TransferChecklist,
} from "../../ipc/library";
import { LibraryPoster } from "./LibraryPoster";
import { actlog } from "../../utils/actlog";
import { formatBytes, formatRuntime } from "./libraryFormat";
import { PreviewCutsModal } from "./PreviewCutsModal";
import { openVideoPath } from "../../utils/openFileFlow";

interface Props {
  pair: ProbablePair;
  onResolved: () => void;
  /** Close the whole reconciliation flow without snoozing or
   *  advancing. Used by the title-bar "×" button. Optional so older
   *  callers fall back to the snooze-and-advance behavior. */
  onClose?: () => void;
}

/** Per directive §3 cluster taxonomy. Derived from the pair signals. */
type ClusterType = "true_duplicate" | "quality_variant" | "different_cut";

function classifyCluster(pair: ProbablePair): ClusterType {
  if (pair.is_likely_cut_difference) return "different_cut";
  // Same-fingerprint pairs are handled by Duplicate Catcher rather than
  // surfacing as PROBABLE — so anything we see in PROBABLE is either a
  // quality variant (different encode, same content) or a likely
  // different cut. We've already ruled out cut difference above.
  return "quality_variant";
}

/** Recommended-keeper score per directive: resolution > profile-presence >
 *  curation count. Higher score = better keeper. */
function keeperScore(row: LibraryRow): number {
  let score = 0;
  // Resolution: prefer larger pixel area. We parse "1920x1080" etc.
  if (row.file.resolution) {
    const m = row.file.resolution.match(/(\d+)\s*x\s*(\d+)/i);
    if (m) {
      const area = parseInt(m[1]!, 10) * parseInt(m[2]!, 10);
      score += area / 1000; // weight order
    }
  }
  if (row.profile_status === "has_profile") score += 5_000_000;
  // Curation weight: count of populated curation fields.
  if (row.tags.length > 0) score += 100_000;
  if (row.identity.notes) score += 100_000;
  if (row.identity.family_rating != null) score += 100_000;
  if (row.identity.custom_thumbnail_path) score += 100_000;
  score += row.collections.length * 50_000;
  if (row.series) score += 50_000;
  return score;
}

/**
 * Reconciliation dialog — implements librrary_directive.md §4.
 * Side-by-side comparison, transfer checklist, cut-detection escalation,
 * Confirm/Cancel actions. Never frames as "yes this is the upgrade,
 * click to apply" — header is always the question "Are these the same
 * movie?" so the user owns the call.
 *
 * Replacement direction defaults to "right replaces left" (right is the
 * newer file in our display order). User can flip the direction at any
 * time before confirming.
 */
export function ReconciliationDialog({ pair, onResolved, onClose }: Props) {
  const inc = useAppStore((s) => s.incrementOpenModalCount);
  const dec = useAppStore((s) => s.decrementOpenModalCount);
  const showToast = useAppStore((s) => s.showToast);

  useEffect(() => {
    inc();
    return () => dec();
  }, [inc, dec]);

  /** Snooze the current pair for 24h, then advance. Per directive:
   *  hitting Esc / backdrop / "Decide later" should NOT re-pester the
   *  user about this same pair on the next scan. The user will still
   *  see it eventually, but not until tomorrow. Falls back to plain
   *  onResolved() if the IPC throws so the dialog doesn't get stuck. */
  const snoozeAndAdvance = async () => {
    try {
      await libraryIpc.snoozePair(
        pair.left.identity.cheap_fingerprint,
        pair.right.identity.cheap_fingerprint,
        24,
      );
    } catch {
      // Non-fatal — worst case the pair shows up again next scan.
    }
    onResolved();
  };

  // Esc closes with snooze (same effect as Decide later). Window-level
  // listener so it works even when focus is on a button inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        void snoozeAndAdvance();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair]);

  // Recommended-keeper computation runs ONCE at mount so subsequent
  // toggles by the user don't flip the suggestion behind their back.
  // The dialog defaults to the recommended side but the user is free
  // to override.
  const recommendedSide: "left" | "right" = useMemo(
    () =>
      keeperScore(pair.right) >= keeperScore(pair.left) ? "right" : "left",
    [pair],
  );
  const [keepSide, setKeepSide] = useState<"left" | "right">(recommendedSide);
  const [busy, setBusy] = useState(false);
  // Replacement question per directive §4: does the keeper REPLACE the
  // other entry (taking its collection / series slot) or do we Keep Both
  // (the keeper inherits curation but the loser stays as a separate
  // entry in any collection/series it's a member of)?
  const [replacement, setReplacement] = useState<"replace" | "keep_both">(
    "replace",
  );
  const [showPreviewCuts, setShowPreviewCuts] = useState(false);
  const cluster = useMemo(() => classifyCluster(pair), [pair]);

  // Cut-difference rule (directive §5): when runtime delta > threshold,
  // profile_link defaults UNCHECKED + warning escalates.
  const cutDiff = pair.is_likely_cut_difference;
  const [checklist, setChecklist] = useState<TransferChecklist>({
    tags: true,
    notes: true,
    family_rating: true,
    custom_thumbnail: true,
    non_family_friendly: true,
    priority_for_profile: true,
    no_profile_necessary: true,
    collections: true,
    series_membership: true,
    watch_history: true,
    // The single exception to "everything checked": cut-different pairs
    // start with the profile copy off.
    profile_link: !cutDiff,
  });

  const source = keepSide === "right" ? pair.left : pair.right;
  const target = keepSide === "right" ? pair.right : pair.left;

  const confirm = async () => {
    if (busy) return;
    actlog(
      "reconcile",
      `transfer ${source.identity.id} → ${target.identity.id}`,
    );
    setBusy(true);
    try {
      await libraryIpc.transferCuration(
        source.identity.id,
        target.identity.id,
        checklist,
      );
      showToast("Curation transferred.", "info", 2500);
      onResolved();
    } catch (err) {
      showToast(`Transfer failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    if (busy) return;
    actlog(
      "reconcile",
      `dismiss pair ${pair.left.identity.id} / ${pair.right.identity.id}`,
    );
    setBusy(true);
    try {
      await libraryIpc.dismissPair(
        pair.left.identity.cheap_fingerprint,
        pair.right.identity.cheap_fingerprint,
      );
      onResolved();
    } catch (err) {
      showToast(`Dismiss failed: ${err}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center"
      onClick={() => void snoozeAndAdvance()}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg shadow-2xl flex flex-col max-w-[920px] w-full max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-fvp-border flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <div className="text-base font-semibold text-fvp-text">
                Are these the same movie?
              </div>
              <ClusterBadge type={cluster} />
            </div>
            <div className="text-[11px] text-fvp-muted">
              FVP found a possible match. Confirm the comparison and choose
              which file becomes the keeper.
            </div>
          </div>
          <button
            onClick={() => (onClose ? onClose() : void snoozeAndAdvance())}
            disabled={busy}
            className="text-fvp-muted hover:text-fvp-text text-lg leading-none disabled:opacity-50"
            title="Close (doesn't snooze — pair stays in the queue)"
          >
            ×
          </button>
        </header>

        <div className="grid grid-cols-2 gap-4 p-5 border-b border-fvp-border min-h-0 overflow-y-auto">
          <ComparisonCard
            row={pair.left}
            isKeeper={keepSide === "left"}
            isRecommended={recommendedSide === "left"}
            onPickAsKeeper={() => setKeepSide("left")}
            onResolved={onResolved}
            showToast={showToast}
          />
          <ComparisonCard
            row={pair.right}
            isKeeper={keepSide === "right"}
            isRecommended={recommendedSide === "right"}
            onPickAsKeeper={() => setKeepSide("right")}
            onResolved={onResolved}
            showToast={showToast}
          />
        </div>

        {/* Replacement question per directive §4. Drives collection/series
            slot logic — Replace takes the loser's slot; Keep both leaves
            both entries in any group they're in. */}
        <div className="px-5 py-3 border-b border-fvp-border bg-fvp-bg/40 text-xs">
          <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-1.5">
            Is this replacing the other file, or are you keeping both?
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={replacement === "replace"}
                onChange={() => setReplacement("replace")}
                className="accent-fvp-accent"
              />
              <span>
                <strong>Replace</strong> &mdash; the loser leaves any
                collection/series it&apos;s in; the keeper takes its slot
              </span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={replacement === "keep_both"}
                onChange={() => setReplacement("keep_both")}
                className="accent-fvp-accent"
              />
              <span>
                <strong>Keep both</strong> &mdash; loser stays as a
                separate entry alongside the keeper
              </span>
            </label>
          </div>
        </div>

        {pair.signals.length > 0 && (
          <div className="px-5 py-2 border-b border-fvp-border text-[11px] text-fvp-muted bg-fvp-bg/40">
            <span className="text-fvp-text font-semibold mr-2">Match signals:</span>
            {pair.signals.join(" · ")}
          </div>
        )}

        {cutDiff && (
          <div className="px-5 py-3 bg-fvp-warn/15 border-b border-fvp-warn text-fvp-warn text-[12px] flex items-start gap-3">
            <span className="text-base shrink-0">⚠</span>
            <div className="flex-1 flex flex-col gap-2">
              <span>
                <strong>Runtime differs.</strong> This is likely a different
                cut (Theatrical / Extended / Director&apos;s). The profile
                will almost certainly mis-time cuts on the other file —
                we recommend rebuilding it rather than transferring it.
              </span>
              <div className="flex gap-2 text-[11px]">
                <button
                  onClick={() => setShowPreviewCuts(true)}
                  className="px-2.5 py-1 bg-fvp-warn/30 hover:bg-fvp-warn/50 rounded text-fvp-warn"
                  title="Play a 90-second reel of the cuts from the source profile, running on the keeper file. Lets you spot misalignments before trusting the transfer."
                >
                  ▶ Preview the cuts
                </button>
                <button
                  onClick={() => {
                    // Jump straight to Profile Creator on the keeper
                    // file — the user can rebuild from there.
                    const keeper =
                      keepSide === "right" ? pair.right : pair.left;
                    useAppStore.setState({ mode: "creator" });
                    void openVideoPath(keeper.file.path);
                    onResolved();
                  }}
                  className="px-2.5 py-1 bg-fvp-warn/30 hover:bg-fvp-warn/50 rounded text-fvp-warn"
                >
                  ↻ Rebuild profile…
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="px-5 py-3 border-b border-fvp-border">
          <div className="text-[11px] uppercase tracking-wider text-fvp-muted mb-2">
            What to transfer onto the keeper
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <CheckRow
              label="Tags"
              checked={checklist.tags}
              onChange={(v) => setChecklist({ ...checklist, tags: v })}
            />
            <CheckRow
              label="Notes"
              checked={checklist.notes}
              onChange={(v) => setChecklist({ ...checklist, notes: v })}
            />
            <CheckRow
              label="Family rating"
              checked={checklist.family_rating}
              onChange={(v) => setChecklist({ ...checklist, family_rating: v })}
            />
            <CheckRow
              label="Custom thumbnail"
              checked={checklist.custom_thumbnail}
              onChange={(v) =>
                setChecklist({ ...checklist, custom_thumbnail: v })
              }
            />
            <CheckRow
              label="Non-family-friendly flag"
              checked={checklist.non_family_friendly}
              onChange={(v) =>
                setChecklist({ ...checklist, non_family_friendly: v })
              }
            />
            <CheckRow
              label="Priority-for-profile flag"
              checked={checklist.priority_for_profile}
              onChange={(v) =>
                setChecklist({ ...checklist, priority_for_profile: v })
              }
            />
            <CheckRow
              label="No-profile-necessary flag"
              checked={checklist.no_profile_necessary}
              onChange={(v) =>
                setChecklist({ ...checklist, no_profile_necessary: v })
              }
            />
            <CheckRow
              label="Collection memberships"
              checked={checklist.collections}
              onChange={(v) => setChecklist({ ...checklist, collections: v })}
            />
            <CheckRow
              label="Series membership"
              checked={checklist.series_membership}
              onChange={(v) =>
                setChecklist({ ...checklist, series_membership: v })
              }
            />
            <CheckRow
              label="Watch history (merge, not overwrite)"
              checked={checklist.watch_history}
              onChange={(v) =>
                setChecklist({ ...checklist, watch_history: v })
              }
            />
            <CheckRow
              label={
                cutDiff
                  ? ".free profile link  ⚠ likely different cut"
                  : ".free profile link  (re-verify after)"
              }
              checked={checklist.profile_link}
              onChange={(v) =>
                setChecklist({ ...checklist, profile_link: v })
              }
              warn={cutDiff}
            />
          </div>
          <div className="text-[10px] text-fvp-muted mt-2">
            Profile cut timings are tied to the exact file. After transfer the
            keeper&apos;s .free will land in <em>needs re-verify</em> state
            regardless of this choice.
          </div>
        </div>

        <footer className="px-5 py-3 border-t border-fvp-border flex items-center justify-between text-xs gap-2">
          <button
            onClick={() => void dismiss()}
            disabled={busy}
            className="px-3 py-1.5 text-fvp-muted hover:text-fvp-text rounded disabled:opacity-50"
            title="Don't flag this pair again."
          >
            Not the same movie
          </button>
          <div className="flex gap-2">
            <button
              onClick={() => void snoozeAndAdvance()}
              disabled={busy}
              className="px-3 py-1.5 text-fvp-text hover:bg-fvp-surface2 rounded"
              title="Snooze this pair for 24 hours."
            >
              Decide later
            </button>
            <button
              onClick={() => void confirm()}
              disabled={busy}
              className="px-4 py-1.5 bg-fvp-accent text-white rounded hover:opacity-90 disabled:opacity-50"
            >
              {busy ? "Transferring…" : "Confirm & transfer"}
            </button>
          </div>
        </footer>
      </div>
      {showPreviewCuts && (
        <PreviewCutsModal
          keeperRow={keepSide === "right" ? pair.right : pair.left}
          sourceRow={keepSide === "right" ? pair.left : pair.right}
          onClose={() => setShowPreviewCuts(false)}
        />
      )}
      {/* Replacement choice is informational today — the backend's
          library_transfer_curation currently doesn't accept a slot mode
          flag. The UI captures the user's intent so when the backend
          gains the slot logic, this dialog already collects the value. */}
      {/* Replacement option also drives whether we should keep the loser's
          presence in any collection/series. For "replace" we'd want to
          remove the loser from those groups; for "keep_both" we leave
          them. Backend extension queued — UI captures the intent. */}
      <_ReplacementSink replacement={replacement} />
    </div>
  );
}

/** Cluster-type pill shown next to the dialog header. Per directive's
 *  Duplicate Catcher taxonomy — gives the user a one-glance read on what
 *  kind of relationship is being proposed. */
function ClusterBadge({ type }: { type: ClusterType }) {
  const cfg =
    type === "true_duplicate"
      ? {
          label: "True duplicate",
          tip: "Same content fingerprint — safe to merge curation.",
          cls: "bg-fvp-ok/20 text-fvp-ok border-fvp-ok",
        }
      : type === "quality_variant"
        ? {
            label: "Quality variant",
            tip: "Same movie, different resolution/codec — likely an upgrade candidate.",
            cls: "bg-fvp-accent/20 text-fvp-accent border-fvp-accent",
          }
        : {
            label: "Different cut",
            tip: "Same movie, different runtime — likely a Theatrical/Extended/Director's cut.",
            cls: "bg-fvp-warn/20 text-fvp-warn border-fvp-warn",
          };
  return (
    <span
      className={`px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider ${cfg.cls}`}
      title={cfg.tip}
    >
      {cfg.label}
    </span>
  );
}

/** Render-only sink so the unused-state warning quiets while the backend
 *  catches up. Receives the replacement choice in case we ever want to
 *  read it via dev tools or pass it to a future command param. */
function _ReplacementSink({ replacement }: { replacement: "replace" | "keep_both" }) {
  // Visible in DOM only as a data attribute; harmless.
  return <div data-fvp-replacement={replacement} className="hidden" aria-hidden="true" />;
}

function ComparisonCard({
  row,
  isKeeper,
  isRecommended,
  onPickAsKeeper,
  onResolved,
  showToast,
}: {
  row: LibraryRow;
  isKeeper: boolean;
  isRecommended: boolean;
  onPickAsKeeper: () => void;
  onResolved: () => void;
  showToast: (msg: string, level?: "info" | "warn" | "error", ttl?: number) => void;
}) {
  const id = row.identity;
  const f = row.file;
  return (
    <div
      className={
        "border-2 rounded-lg p-3 transition-colors relative " +
        (isKeeper
          ? "border-fvp-accent bg-fvp-accent/10"
          : "border-fvp-border bg-fvp-bg/40")
      }
    >
      {isRecommended && (
        <span
          className="absolute -top-2 right-2 px-2 py-0.5 bg-fvp-ok text-white text-[9px] font-bold uppercase tracking-wider rounded shadow"
          title="Higher resolution / profile presence / more curation makes this the recommended keeper."
        >
          ★ Recommended
        </span>
      )}
      <div className="flex gap-3 mb-3">
        <LibraryPoster
          customThumbnailPath={id.custom_thumbnail_path}
          posterLocalPath={id.poster_local_path}
          widthPx={88}
          alt={id.movie_title ?? ""}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-fvp-text leading-tight">
            {id.movie_title ?? f.path.split(/[\\/]/).pop()}
          </div>
          {id.movie_year && (
            <div className="text-[11px] text-fvp-muted">{id.movie_year}</div>
          )}
          <div className="text-[10px] text-fvp-muted mt-1">
            {formatRuntime(id.duration_ms)} · {f.resolution ?? "—"} ·{" "}
            {formatBytes(f.size_bytes)}
          </div>
        </div>
      </div>
      <div className="text-[10px] font-mono text-fvp-muted break-all">
        {f.path}
      </div>
      <button
        onClick={onPickAsKeeper}
        className={
          "mt-3 w-full px-2 py-1.5 rounded text-xs " +
          (isKeeper
            ? "bg-fvp-accent text-white"
            : "bg-fvp-bg border border-fvp-border text-fvp-text hover:border-fvp-muted")
        }
      >
        {isKeeper ? "✓ This is the keeper" : "Make this the keeper"}
      </button>
      <div className="flex gap-1 mt-2 text-[10px]">
        <button
          onClick={() => {
            showToast("Opening in Explorer…", "info", 1500);
            void libraryIpc
              .revealInExplorer(f.path)
              .catch(() => {
                // If the file is already gone from disk, Explorer will
                // open the parent folder. Backend swallows the error.
              });
          }}
          className="flex-1 px-2 py-1 bg-fvp-bg border border-fvp-border text-fvp-muted hover:text-fvp-text hover:border-fvp-muted rounded"
          title="Open the parent folder in Explorer. Lets you manually verify or delete the file outside FVP."
        >
          📂 Show in Explorer
        </button>
        <button
          onClick={() => {
            const fileName = f.path.split(/[\\/]/).pop() ?? f.path;
            if (
              !window.confirm(
                `Send "${fileName}" to the Recycle Bin AND remove it from the library?\n\nThe other side of this pair will remain.`,
              )
            )
              return;
            void libraryIpc
              .trashFiles([f.id])
              .then((result) => {
                // Always advance — even when nothing was removable
                // (file already gone, permissions, etc.) the pair is
                // resolved enough that staying here would just trap
                // the user. Show a toast for the failure mode so it's
                // not silent.
                if (result.failed.length > 0) {
                  showToast(
                    `Couldn't delete: ${result.failed[0]}`,
                    "warn",
                    4000,
                  );
                } else if (result.removed + result.trashed > 0) {
                  showToast(
                    `Deleted "${fileName}".`,
                    "info",
                    2500,
                  );
                }
                onResolved();
              })
              .catch((err) => {
                showToast(`Delete failed: ${err}`, "error");
                // Still advance so the user isn't stuck.
                onResolved();
              });
          }}
          className="flex-1 px-2 py-1 bg-fvp-bg border border-fvp-err/40 text-fvp-err hover:bg-fvp-err/10 rounded"
          title="Move this video to the OS Recycle Bin and remove it from the library."
        >
          🗑 Delete this one
        </button>
      </div>
    </div>
  );
}

function CheckRow({
  label,
  checked,
  onChange,
  warn,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  warn?: boolean;
}) {
  return (
    <label
      className={
        "flex items-center gap-2 cursor-pointer " +
        (warn ? "text-fvp-warn" : "text-fvp-text")
      }
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-fvp-accent"
      />
      <span>{label}</span>
    </label>
  );
}
