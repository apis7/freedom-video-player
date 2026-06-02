import { useEffect, useState } from "react";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";
import { formatTime } from "../utils/format";

const AUTO_HIDE_MS = 8000;

/**
 * Slim Skip-That tray, shown above the transport in Player Mode after the
 * user presses any Skip-That key. Auto-fades after AUTO_HIDE_MS of no
 * activity; any new Skip-That key brings it back.
 */
export function SkipThatTray({ onViewDraft }: { onViewDraft: () => void }) {
  const trayActiveAt = useAppStore((s) => s.skipThatTrayActiveAt);
  const pendingStartMs = useAppStore((s) => s.skipThatPendingStartMs);
  const snipCount = useAppStore((s) => s.snips.length);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (trayActiveAt == null) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const remaining = AUTO_HIDE_MS - (Date.now() - trayActiveAt);
    if (remaining <= 0) {
      setVisible(false);
      return;
    }
    // While a snip is open (`\` pressed, `]` not yet), keep the tray pinned.
    if (pendingStartMs != null) return;
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [trayActiveAt, pendingStartMs]);

  if (!visible) return null;

  const status =
    pendingStartMs != null
      ? `● Recording snip — started ${formatTime(pendingStartMs / 1000)}`
      : snipCount > 0
        ? `Draft: ${snipCount} snip${snipCount === 1 ? "" : "s"} logged`
        : "Skip-That ready";

  return (
    <div
      className={clsx(
        "h-8 bg-fvp-surface border-t border-fvp-border flex items-center gap-3 px-3 text-[11px] select-none",
        pendingStartMs != null ? "text-fvp-warn" : "text-fvp-muted",
      )}
    >
      <span className="font-medium">{status}</span>
      <span className="flex-1" />
      <KeyHint k="[" label="Start 10s ago" />
      <KeyHint k="\" label="Start now" />
      <KeyHint k="]" label="Stop snip" />
      <KeyHint k="Q" label="Quick 10s" />
      <span className="w-px h-4 bg-fvp-border mx-1" />
      <button
        onClick={(e) => {
          e.currentTarget.blur();
          onViewDraft();
        }}
        disabled={snipCount === 0}
        title="Switch to Profile Creator to review and categorize these snips"
        className={clsx(
          "px-2 py-0.5 rounded border border-fvp-border text-fvp-text",
          snipCount === 0
            ? "opacity-30 cursor-not-allowed"
            : "hover:bg-fvp-surface2 cursor-pointer",
        )}
      >
        View draft →
      </button>
    </div>
  );
}

function KeyHint({ k, label }: { k: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="px-1.5 py-px bg-fvp-bg border border-fvp-border rounded font-mono text-[10px] text-fvp-text">
        {k}
      </kbd>
      <span className="text-[10px]">{label}</span>
    </span>
  );
}
