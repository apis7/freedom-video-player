import { useEffect, useState } from "react";
import { useAppStore } from "../state/appStore";
import { HOTKEYS, keyFor } from "../state/hotkeys";
import { HotkeyRecorder } from "../components/HotkeyRecorder";
import { MAX_AUTHOR_HANDLE_LEN } from "../ipc/types";
import { LibrarySettingsPanel } from "../components/library/LibrarySettingsPanel";

/**
 * Settings — first pass. Holds the toggles that have state hooks today.
 * Per ui_settings_and_dialogs.md there's a much bigger surface to come
 * (hotkey customization, theme, default snip durations, padding, etc.).
 */
export function SettingsMode() {
  const autosaveDraft = useAppStore((s) => s.autosaveDraft);
  const setAutosaveDraft = useAppStore((s) => s.setAutosaveDraft);
  const jumpOn = useAppStore((s) => s.jumpPlayheadOnSnipSelect);
  const toggleJump = useAppStore((s) => s.toggleJumpPlayheadOnSnipSelect);
  const playerShowProfileIcon = useAppStore((s) => s.playerShowProfileIcon);
  const setPlayerShowProfileIcon = useAppStore((s) => s.setPlayerShowProfileIcon);
  const playerShowPathOnStart = useAppStore((s) => s.playerShowPathOnStart);
  const setPlayerShowPathOnStart = useAppStore((s) => s.setPlayerShowPathOnStart);

  return (
    <div className="h-full bg-fvp-bg p-6 text-fvp-text text-sm overflow-auto">
      <h2 className="text-lg font-semibold mb-1">Settings</h2>
      <p className="text-xs text-fvp-muted mb-6">
        Hotkey customization, default snip padding, themes, and the full
        Settings surface arrive in a later milestone.
      </p>

      <Section title="Player Mode">
        <Toggle
          checked={playerShowProfileIcon}
          onChange={setPlayerShowProfileIcon}
          label="Show profile-active icon on video"
          help="When a .free profile is currently filtering playback, a small FVP badge shows in the corner of the video so you know edits are being applied."
        />
        <Toggle
          checked={playerShowPathOnStart}
          onChange={setPlayerShowPathOnStart}
          label="Show movie file path briefly on play"
          help="When you start a movie from the very beginning, the file path appears at the bottom for ~5 seconds then fades out. Only fires for fresh starts (resumes don't trigger it)."
        />
      </Section>

      <Section title="Profile Creator">
        <Toggle
          checked={autosaveDraft}
          onChange={setAutosaveDraft}
          label="Autosave drafts"
          help="When ON, edits are saved to a .fvp-autosave.free sidecar next to the video on every change (debounced). Restored automatically when you reopen the video."
        />
        <Toggle
          checked={jumpOn}
          onChange={toggleJump}
          label="Jump playhead to selected snip"
          help="Clicking any snip auto-seeks the playhead to its start. Ctrl+Shift+click overrides when this is off."
        />
      </Section>

      <Section title="Author handle">
        <p className="text-[11px] text-fvp-muted mb-2">
          Optional alias attached to your edits. Stored in each profile's
          edit history so the sharing site can group your work together
          and let others find more of your profiles. Use an{" "}
          <strong className="text-fvp-text">anonymous handle</strong> —
          not your real name. Leave blank to stay fully anonymous.
        </p>
        <AuthorHandleField />
      </Section>

      <Section title="Library">
        <LibrarySettingsPanel />
      </Section>

      {/* "Google Image Search" panel temporarily disabled — Google
          deprecated the relevant Custom Search Engine setup path,
          breaking the flow for new users. Backend command + modal
          stay in place; we'll re-enable + re-document once we have
          a working setup path again. Set the constant in
          src/featureFlags.ts to flip back on. */}

      <Section title="AutoSnip — subtitle language">
        <p className="text-[11px] text-fvp-muted mb-2">
          Which language wordlist AutoSnip uses when scanning subtitles. Edit
          the underlying .md files directly in <code>src-tauri/assets/</code>
          to refine them — backend rebuild required for changes.
        </p>
        <AutoSnipLanguagePicker />
      </Section>

      <Section title="AutoSnip — snip padding">
        <p className="text-[11px] text-fvp-muted mb-2">
          When AutoSnip creates a snip from a flagged subtitle entry, it
          extends the snip slightly outside the entry's start/end times to
          account for loose subtitle timing (the offensive word usually sits
          inside the entry but rarely at the exact boundaries).
        </p>
        <PaddingControls />
      </Section>

      <Section title="Keyboard shortcuts">
        <p className="text-[11px] text-fvp-muted mb-2">
          Click any hotkey below to rebind it. Modifier-heavy combos (Ctrl+O,
          Ctrl+Z, Ctrl+A, arrows, etc.) stay hardcoded to avoid colliding
          with browser/OS shortcuts. Press <kbd className="px-1 py-0.5 bg-fvp-bg border border-fvp-border rounded font-mono">?</kbd> at any time for the full cheatsheet.
        </p>
        <HotkeyEditor />
        <details className="mt-6">
          <summary className="text-[11px] text-fvp-muted cursor-pointer hover:text-fvp-text">
            All hotkeys (non-customizable shown for reference)
          </summary>
          <div className="mt-3">
            <HotkeyList />
          </div>
        </details>
      </Section>
    </div>
  );
}

const HOTKEY_GROUPS: { title: string; rows: { keys: string; action: string }[] }[] = [
  {
    title: "Player & Creator (both modes)",
    rows: [
      { keys: "Space", action: "Play / Pause" },
      { keys: "M", action: "Mute toggle" },
      { keys: "V", action: "Subtitle visibility toggle" },
      { keys: "T", action: "A/B profile preview toggle" },
      { keys: "↑ / ↓", action: "Volume +/− 5%" },
      { keys: "← / →", action: "Seek ∓5s" },
      { keys: "Ctrl + ← / →", action: "Seek ∓10s" },
      { keys: "Shift + ← / →", action: "Seek ∓1m" },
      { keys: ", / .", action: "Frame step back / forward" },
      { keys: "Home / End", action: "Jump to start / end" },
      { keys: "Ctrl + O", action: "Open file…" },
      { keys: "?", action: "Toggle keyboard cheatsheet" },
      { keys: "Esc", action: "Exit fullscreen / close dialogs" },
    ],
  },
  {
    title: "Player Mode only",
    rows: [
      { keys: "F", action: "Fullscreen toggle" },
      { keys: "Tab / Shift+Tab", action: "Next / previous active-profile snip" },
      { keys: "[", action: "Skip-That: snip from 10s ago to now" },
      { keys: "\\", action: "Skip-That: start open snip at playhead" },
      { keys: "]", action: "Skip-That: close open snip at playhead" },
      { keys: "Q", action: "Skip-That: quick 10s snip centered on playhead" },
    ],
  },
  {
    title: "Profile Creator only",
    rows: [
      { keys: "Delete", action: "Delete selected snip(s)" },
      { keys: "Ctrl + A", action: "Select all snips" },
      { keys: "Ctrl + Z / Ctrl+Shift+Z", action: "Undo / Redo (100 steps)" },
      { keys: "Ctrl + click", action: "Toggle snip in selection" },
      { keys: "Shift + click", action: "Range-select snips" },
      { keys: "Ctrl + Shift + click", action: "Jump-on-select override" },
      { keys: "Alt + drag", action: "Clone snip(s)" },
      { keys: "B", action: "Drop marker at playhead" },
      { keys: "[ / ]", action: "Jump to previous / next marker" },
      { keys: "Enter", action: "Preview selected snip" },
      { keys: "Tab / Shift+Tab", action: "Jump between markers + flags" },
      { keys: "Page Up / Down", action: "Pan view by one window" },
      { keys: "0", action: "Zoom timeline to fit" },
      { keys: "=", action: "Zoom to selected snip" },
      { keys: "+ / −", action: "Zoom in / out (centered on playhead)" },
      { keys: "Scroll / Ctrl+Scroll / Shift+Scroll", action: "Pan / Zoom / Vertical lane scroll" },
      { keys: "Middle-click drag", action: "Pan timeline view" },
    ],
  },
];

function HotkeyEditor() {
  const customHotkeys = useAppStore((s) => s.customHotkeys);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  const byScope: Record<"both" | "player" | "creator", typeof HOTKEYS> = {
    both: HOTKEYS.filter((h) => h.scope === "both"),
    player: HOTKEYS.filter((h) => h.scope === "player"),
    creator: HOTKEYS.filter((h) => h.scope === "creator"),
  };

  const setKey = (id: string, key: string) => {
    const spec = HOTKEYS.find((h) => h.id === id);
    const next: Record<string, string> = { ...customHotkeys };
    if (!spec || key === spec.defaultKey) {
      delete next[id]; // back to default — don't persist as override
    } else {
      next[id] = key;
    }
    useAppStore.setState({ customHotkeys: next });
  };
  const reset = (id: string) => {
    const next = { ...customHotkeys };
    delete next[id];
    useAppStore.setState({ customHotkeys: next });
  };

  const recording = recordingId
    ? HOTKEYS.find((h) => h.id === recordingId)
    : null;

  return (
    <div className="space-y-5 max-w-2xl">
      {(["both", "player", "creator"] as const).map((scope) => (
        <div key={scope}>
          <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-2">
            {scope === "both"
              ? "Both modes"
              : scope === "player"
                ? "Player Mode only"
                : "Profile Creator only"}
          </div>
          <div className="space-y-1">
            {byScope[scope].map((h) => {
              const current = keyFor(h.id, customHotkeys);
              const isCustom = customHotkeys[h.id] != null;
              return (
                <div
                  key={h.id}
                  className="flex items-center gap-3 p-2 rounded border border-fvp-border bg-fvp-surface"
                >
                  <div className="flex-1 text-sm text-fvp-text">{h.label}</div>
                  <button
                    onClick={() => setRecordingId(h.id)}
                    title="Click to rebind"
                    className="px-2 py-1 text-[11px] font-mono bg-fvp-bg border border-fvp-border rounded hover:border-fvp-accent text-fvp-text cursor-pointer min-w-[90px]"
                  >
                    {current}
                  </button>
                  {isCustom && (
                    <button
                      onClick={() => reset(h.id)}
                      title={`Reset to default (${h.defaultKey})`}
                      className="text-[10px] text-fvp-muted hover:text-fvp-text"
                    >
                      ↺ default
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {recording && (
        <HotkeyRecorder
          current={keyFor(recording.id, customHotkeys)}
          onCapture={(key) => {
            setKey(recording.id, key);
            setRecordingId(null);
          }}
          onCancel={() => setRecordingId(null)}
        />
      )}
    </div>
  );
}

function HotkeyList() {
  return (
    <div className="space-y-5">
      {HOTKEY_GROUPS.map((g) => (
        <div key={g.title}>
          <div className="text-[10px] uppercase tracking-wider text-fvp-muted mb-2">
            {g.title}
          </div>
          <table className="w-full text-[11px]">
            <tbody>
              {g.rows.map((r) => (
                <tr key={r.keys} className="border-b border-fvp-border/30 last:border-0">
                  <td className="py-1 pr-3 font-mono text-fvp-text whitespace-nowrap w-1/3">
                    {r.keys}
                  </td>
                  <td className="py-1 text-fvp-muted">{r.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function PaddingControls() {
  const before = useAppStore((s) => s.autoSnipPadBeforeMs);
  const after = useAppStore((s) => s.autoSnipPadAfterMs);
  return (
    <div className="space-y-3 max-w-md">
      <label className="block">
        <span className="text-[11px] text-fvp-muted">
          Padding BEFORE subtitle start (ms)
        </span>
        <input
          type="number"
          min={0}
          max={5000}
          step={50}
          value={before}
          onChange={(e) =>
            useAppStore.setState({
              autoSnipPadBeforeMs: Math.max(0, Math.min(5000, Number(e.target.value) || 0)),
            })
          }
          className="mt-1 w-full bg-fvp-bg border border-fvp-border rounded px-2 py-1.5 text-sm text-fvp-text font-mono"
        />
      </label>
      <label className="block">
        <span className="text-[11px] text-fvp-muted">
          Padding AFTER subtitle end (ms)
        </span>
        <input
          type="number"
          min={0}
          max={5000}
          step={50}
          value={after}
          onChange={(e) =>
            useAppStore.setState({
              autoSnipPadAfterMs: Math.max(0, Math.min(5000, Number(e.target.value) || 0)),
            })
          }
          className="mt-1 w-full bg-fvp-bg border border-fvp-border rounded px-2 py-1.5 text-sm text-fvp-text font-mono"
        />
      </label>
      <div className="text-[10px] text-fvp-muted/70">
        Per-directives defaults: 200 ms / 300 ms. Setting both to 0 makes
        AutoSnip create snips that match the subtitle entry exactly.
      </div>
    </div>
  );
}

const SUPPORTED_LANGS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish (Español)" },
  { code: "fr", label: "French (Français)" },
  { code: "de", label: "German (Deutsch)" },
];

function AutoSnipLanguagePicker() {
  const current = useAppStore((s) => s.autoSnipLanguage);
  return (
    <div className="space-y-2 max-w-2xl">
      {SUPPORTED_LANGS.map((l) => (
        <label
          key={l.code}
          className="flex items-center gap-3 p-2 rounded border border-fvp-border bg-fvp-surface cursor-pointer hover:bg-fvp-surface2"
        >
          <input
            type="radio"
            name="autosnip-language"
            checked={current === l.code}
            onChange={() => useAppStore.setState({ autoSnipLanguage: l.code })}
            className="accent-fvp-accent"
          />
          <div className="flex-1">
            <div className="text-sm text-fvp-text">{l.label}</div>
            <div className="text-[11px] text-fvp-muted mt-0.5 font-mono">
              {l.code}
            </div>
          </div>
        </label>
      ))}
      <div className="text-[10px] text-fvp-muted/70 pt-2">
        Additional languages can be added by creating new
        <code className="mx-1">autosnip_wordlist_&lt;code&gt;.md</code> files
        in <code>src-tauri/assets/</code> and registering them in
        <code className="mx-1">wordlist.rs::bundled_for</code>.
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  // Anchor ID so external callers (e.g. Profile Creator's author-handle
  // icon) can switch to Settings mode and scroll the relevant section
  // into view via `location.hash` / `scrollIntoView`.
  const anchorId = `settings-section-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;
  return (
    <section id={anchorId} className="mb-8 scroll-mt-6">
      <h3 className="text-xs font-semibold text-fvp-muted uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="space-y-3 max-w-2xl">{children}</div>
    </section>
  );
}

function AuthorHandleField() {
  const handle = useAppStore((s) => s.authorHandle);
  const [local, setLocal] = useState(handle ?? "");

  // Keep local in sync if external state changes (e.g. settings reload).
  useEffect(() => {
    setLocal(handle ?? "");
  }, [handle]);

  const commit = () => {
    const trimmed = local.trim();
    const next = trimmed.length > 0 ? trimmed.slice(0, MAX_AUTHOR_HANDLE_LEN) : null;
    if (next !== handle) {
      useAppStore.setState({ authorHandle: next });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          }
        }}
        maxLength={MAX_AUTHOR_HANDLE_LEN}
        placeholder="e.g. clean-clips-42  (max 64 chars, blank = anonymous)"
        className="bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-1.5 text-sm text-fvp-text outline-none font-mono"
      />
      <div className="text-[11px] text-fvp-muted">
        Saved instantly on blur or Enter. Currently:{" "}
        {handle ? (
          <code className="font-mono text-fvp-text">{handle}</code>
        ) : (
          <em className="text-fvp-muted">anonymous</em>
        )}
      </div>
    </div>
  );
}

// Exported so TS doesn't flag it as unused — feature temporarily
// disabled (FEATURE_GOOGLE_POSTER_SEARCH flag). Re-enable by
// flipping the flag and uncommenting the Section block above.
export function _GoogleCseFields() {
  const apiKey = useAppStore((s) => s.googleCseApiKey);
  const cx = useAppStore((s) => s.googleCseId);
  const [apiLocal, setApiLocal] = useState(apiKey);
  const [cxLocal, setCxLocal] = useState(cx);
  const [revealKey, setRevealKey] = useState(false);
  useEffect(() => setApiLocal(apiKey), [apiKey]);
  useEffect(() => setCxLocal(cx), [cx]);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-fvp-muted">API key</span>
        <div className="flex gap-2">
          <input
            type={revealKey ? "text" : "password"}
            value={apiLocal}
            onChange={(e) => setApiLocal(e.target.value)}
            onBlur={() => {
              if (apiLocal.trim() !== apiKey) {
                useAppStore.setState({ googleCseApiKey: apiLocal.trim() });
              }
            }}
            placeholder="AIzaSy…"
            className="flex-1 bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-1.5 text-sm text-fvp-text outline-none font-mono"
          />
          <button
            type="button"
            onClick={() => setRevealKey((v) => !v)}
            className="px-2 py-1 bg-fvp-bg border border-fvp-border hover:border-fvp-muted text-xs text-fvp-muted rounded"
          >
            {revealKey ? "Hide" : "Show"}
          </button>
        </div>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-fvp-muted">
          Search Engine ID (cx)
        </span>
        <input
          value={cxLocal}
          onChange={(e) => setCxLocal(e.target.value)}
          onBlur={() => {
            if (cxLocal.trim() !== cx) {
              useAppStore.setState({ googleCseId: cxLocal.trim() });
            }
          }}
          placeholder="e.g. a12b3c4d5e6f7g8h9"
          className="bg-fvp-bg border border-fvp-border focus:border-fvp-accent rounded px-3 py-1.5 text-sm text-fvp-text outline-none font-mono"
        />
      </label>
      <div className="text-[10px] text-fvp-muted">
        Status:{" "}
        {apiKey && cx ? (
          <span className="text-fvp-ok">configured — feature enabled</span>
        ) : (
          <span className="text-fvp-warn">
            not configured — right-click menu item will be hidden
          </span>
        )}
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  help,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  help?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={
        "flex items-start gap-3 p-2 rounded border border-fvp-border bg-fvp-surface " +
        (disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:bg-fvp-surface2")
      }
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-fvp-accent"
      />
      <div className="flex-1">
        <div className="text-sm text-fvp-text">{label}</div>
        {help && <div className="text-[11px] text-fvp-muted mt-0.5">{help}</div>}
      </div>
    </label>
  );
}
