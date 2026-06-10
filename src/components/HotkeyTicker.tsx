import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";

interface Tip {
  keys: string;
  action: string;
}

// Same Creator hotkey list that lives in CheatsheetOverlay, lightly
// trimmed to the entries most users forget about. Kept inline rather
// than imported so a future cheatsheet rewrite doesn't break the
// ticker — these are the "discovery" hooks, not the canonical list.
const CREATOR_TIPS: Tip[] = [
  { keys: "Ctrl+A", action: "select every snip" },
  { keys: "Ctrl+click", action: "toggle a snip in/out of the selection" },
  { keys: "Shift+click", action: "range-select snips" },
  { keys: "Alt+drag", action: "clone the snip(s) you're dragging" },
  { keys: "Tab / Shift+Tab", action: "jump between markers + flags" },
  { keys: "Ctrl+Z / Ctrl+Shift+Z", action: "undo / redo (100 steps)" },
  { keys: "0", action: "zoom timeline to fit" },
  { keys: "=", action: "zoom to the selected snip" },
  { keys: "+ / −", action: "zoom in / out around the playhead" },
  { keys: "B", action: "drop a marker at the playhead" },
  { keys: "[ / ]", action: "jump to previous / next marker" },
  { keys: "Enter", action: "preview selected snip (seeks 2s before, plays)" },
  { keys: "Drag a snip edge", action: "resize that edge in real time" },
  { keys: "Click an edge then ← / →", action: "nudge it 5s (or seek if no edge)" },
  { keys: ", / .", action: "frame-step (or frame-nudge if an edge is active)" },
  { keys: "Esc", action: "deactivate the active edge" },
  { keys: "Middle-click drag", action: "pan the timeline view" },
  { keys: "Ctrl+S", action: "save the .free profile" },
  { keys: "Ctrl+Shift+S", action: "save profile as… (versioning)" },
  { keys: "Space / M / V", action: "play/pause, mute, toggle subtitle visibility" },
];

const ROTATE_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Slow-scrolling hotkey hint that lives in the Creator footer. Picks a
 * random tip, scrolls it gently across its container, swaps for a new
 * one every 2 minutes. Clicking opens the full cheatsheet.
 *
 * The animation is CSS-only (`@keyframes hotkey-ticker-scroll` is
 * declared inline below via a styled span) so React doesn't re-render
 * the marquee on every animation frame.
 */
export function HotkeyTicker() {
  const setCheatsheetVisible = useAppStore((s) => s.setCheatsheetVisible);
  const [idx, setIdx] = useState(() =>
    Math.floor(Math.random() * CREATOR_TIPS.length),
  );

  useEffect(() => {
    const handle = window.setInterval(() => {
      setIdx((prev) => {
        // Avoid showing the same tip back-to-back when the deck is small.
        let next = Math.floor(Math.random() * CREATOR_TIPS.length);
        if (next === prev) next = (next + 1) % CREATOR_TIPS.length;
        return next;
      });
    }, ROTATE_MS);
    return () => window.clearInterval(handle);
  }, []);

  const tip = CREATOR_TIPS[idx];

  return (
    <>
      <style>{`
        @keyframes fvp-hotkey-ticker {
          0%   { transform: translateX(100%); }
          100% { transform: translateX(-100%); }
        }
        .fvp-hotkey-ticker-inner {
          display: inline-block;
          white-space: nowrap;
          animation: fvp-hotkey-ticker 22s linear infinite;
        }
      `}</style>
      <button
        onClick={() => setCheatsheetVisible(true)}
        title="Click to open the full hotkey cheatsheet"
        className="overflow-hidden max-w-[420px] min-w-[180px] cursor-pointer hover:text-fvp-text text-[11px] text-fvp-muted/80 italic"
      >
        <span className="fvp-hotkey-ticker-inner">
          <span className="text-fvp-accent font-semibold not-italic">
            {tip.keys}
          </span>
          <span> &nbsp;·&nbsp; {tip.action}</span>
        </span>
      </button>
    </>
  );
}
