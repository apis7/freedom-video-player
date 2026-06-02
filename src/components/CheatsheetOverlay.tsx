import { useAppStore } from "../state/appStore";

interface Row {
  keys: string;
  action: string;
}

const PLAYER_ROWS: Row[] = [
  { keys: "Space", action: "Play / Pause" },
  { keys: "F", action: "Fullscreen toggle" },
  { keys: "M", action: "Mute toggle" },
  { keys: "V", action: "Toggle subtitle visibility" },
  { keys: "T", action: "Toggle profile preview (A/B)" },
  { keys: "↑ / ↓", action: "Volume +/− (5%)" },
  { keys: "← / →", action: "Seek ∓5s" },
  { keys: "Ctrl + ← / →", action: "Seek ∓10s" },
  { keys: "Shift + ← / →", action: "Seek ∓1m" },
  { keys: "Tab / Shift+Tab", action: "Jump to next / previous snip" },
  { keys: ", / .", action: "Frame step back / forward" },
  { keys: "Ctrl + O", action: "Open file…" },
  { keys: "Esc", action: "Exit fullscreen / close dialogs" },
  { keys: "?", action: "Toggle this cheatsheet" },
];

const SKIPTHAT_ROWS: Row[] = [
  { keys: "[", action: "Drop a snip from 10s ago to now" },
  { keys: "\\", action: "Start an open snip at the playhead" },
  { keys: "]", action: "Close the open snip at the playhead" },
  { keys: "Q", action: "Quick 10s snip centered on playhead" },
];

const CREATOR_ROWS: Row[] = [
  { keys: "(All Player hotkeys work)", action: "Space, M, V, arrows, , / . — same as Player Mode" },
  { keys: "Delete", action: "Delete selection (confirm if >10)" },
  { keys: "Ctrl + A", action: "Select all snips" },
  { keys: "Ctrl + click", action: "Toggle snip in selection" },
  { keys: "Shift + click", action: "Range select snips" },
  { keys: "Alt + drag", action: "Clone snip(s)" },
  { keys: "Tab / Shift+Tab", action: "Jump between markers + flags" },
  { keys: "Ctrl + Z / Ctrl+Shift+Z", action: "Undo / Redo (100 steps)" },
  { keys: "Drag snip edge", action: "Resize the edge in real time" },
  { keys: "Click snip edge", action: "Activate for hotkey nudging" },
  { keys: "← / →", action: "When edge active: nudge 5s (else seek)" },
  { keys: "Ctrl + ← / →", action: "When edge active: nudge 10s" },
  { keys: "Shift + ← / →", action: "When edge active: nudge 1m" },
  { keys: ", / .", action: "When edge active: frame-nudge ~33ms" },
  { keys: "Esc", action: "Deactivate active edge" },
  { keys: "0", action: "Zoom timeline to fit" },
  { keys: "=", action: "Zoom to selected snip" },
  { keys: "+ / −", action: "Zoom in / out (centered on playhead)" },
  { keys: "Home / End", action: "Jump playhead to start / end" },
  { keys: "Page Up / Down", action: "Pan view by one window" },
  { keys: "B", action: "Drop marker at playhead" },
  { keys: "[ / ]", action: "Jump to previous / next marker" },
  { keys: "Enter", action: "Preview selected snip (seeks 2s before, plays through)" },
  { keys: "Right-click marker", action: "Rename (clear name → delete)" },
  { keys: "Scroll / Ctrl+Scroll / Shift+Scroll", action: "Pan / Zoom / Vertical lane scroll" },
  { keys: "Middle-click drag", action: "Pan timeline view" },
];

export function CheatsheetOverlay() {
  const visible = useAppStore((s) => s.cheatsheetVisible);
  const mode = useAppStore((s) => s.mode);
  const close = () => useAppStore.setState({ cheatsheetVisible: false });

  if (!visible) return null;

  // Show only shortcuts relevant to the current mode:
  //   - Player Mode → Player + Skip-That (Skip-That is player-only anyway)
  //   - Profile Creator → Creator hotkeys split into two visual columns
  //     so a single very tall column doesn't dominate the modal
  //   - Library / Settings → both groups, as a fallback reference
  type Pane = { title: string; rows: Row[] };
  let panes: Pane[];
  if (mode === "player") {
    panes = [
      { title: "Player Mode", rows: PLAYER_ROWS },
      { title: "Skip-That (Player Mode)", rows: SKIPTHAT_ROWS },
    ];
  } else if (mode === "creator") {
    // Split Creator rows roughly in half for a balanced two-column layout.
    const mid = Math.ceil(CREATOR_ROWS.length / 2);
    panes = [
      { title: "Profile Creator", rows: CREATOR_ROWS.slice(0, mid) },
      { title: "Profile Creator (cont.)", rows: CREATOR_ROWS.slice(mid) },
    ];
  } else {
    panes = [
      { title: "Player Mode", rows: PLAYER_ROWS },
      { title: "Profile Creator", rows: CREATOR_ROWS },
    ];
  }

  return (
    <div
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-6"
      onClick={close}
    >
      <div
        className="bg-fvp-surface border border-fvp-border rounded-lg p-6 max-w-6xl w-full max-h-[85vh] overflow-y-auto overflow-x-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-fvp-text">
            Keyboard shortcuts
            <span className="ml-2 text-xs font-normal text-fvp-muted">
              ({modeLabel(mode)})
            </span>
          </h2>
          <button
            onClick={close}
            className="text-fvp-muted hover:text-fvp-text text-sm"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        <div
          className={`grid gap-6 ${
            panes.length === 1 ? "grid-cols-1" : "grid-cols-2"
          }`}
        >
          {panes.map((p) => (
            <Column key={p.title} title={p.title} rows={p.rows} />
          ))}
        </div>
        <div className="mt-4 pt-3 border-t border-fvp-border text-[11px] text-fvp-muted">
          Hotkey customization is available in Settings.
        </div>
      </div>
    </div>
  );
}

function modeLabel(mode: string): string {
  switch (mode) {
    case "player":
      return "Player Mode";
    case "creator":
      return "Profile Creator";
    case "library":
      return "Library";
    case "settings":
      return "Settings";
    default:
      return mode;
  }
}

function Column({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-fvp-muted uppercase tracking-wider mb-2">
        {title}
      </h3>
      <table className="w-full text-xs table-fixed">
        <colgroup>
          {/* Fixed two-column proportions: ~40% keys / ~60% action. The
              keys cell allows wrapping (break-words) so long combo strings
              like "Scroll / Ctrl+Scroll / Shift+Scroll" don't force the
              modal into horizontal-scroll territory. */}
          <col className="w-2/5" />
          <col className="w-3/5" />
        </colgroup>
        <tbody>
          {rows.map((r) => (
            <tr key={r.keys} className="border-b border-fvp-border/50 last:border-0 align-top">
              <td className="py-1.5 pr-3 font-mono text-fvp-text break-words">{r.keys}</td>
              <td className="py-1.5 text-fvp-muted break-words">{r.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
