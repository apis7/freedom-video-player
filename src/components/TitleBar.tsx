import clsx from "clsx";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../state/appStore";
import type { AppMode } from "../state/types";

const TABS: { value: AppMode; label: string }[] = [
  { value: "player", label: "Player" },
  { value: "creator", label: "Profile Creator" },
  { value: "library", label: "Library" },
  { value: "settings", label: "Settings" },
];

const win = getCurrentWindow();

export function TitleBar() {
  const mode = useAppStore((s) => s.mode);
  const setMode = useAppStore((s) => s.setMode);
  const libraryEnabled = useAppStore((s) => s.libraryEnabled);
  const currentFile = useAppStore((s) => s.currentFile);

  // No-file placeholders intentionally use words instead of an em dash
  // glyph — a bare "—" centered in an otherwise empty title bar reads as
  // a stray white line, not as content.
  const context =
    mode === "player"
      ? (currentFile ?? "Freedom Video Player")
      : mode === "creator"
        ? `Editing: ${currentFile ?? "(no file)"}`
        : mode === "library"
          ? "Library"
          : "Settings";

  const visibleTabs = TABS.filter((t) => t.value !== "library" || libraryEnabled);

  return (
    <header
      data-tauri-drag-region
      className="flex items-center h-9 px-2 bg-fvp-surface border-b border-fvp-border select-none"
    >
      <nav
        data-tauri-drag-region
        className="flex items-center gap-1"
        role="tablist"
        aria-label="App modes"
      >
        {visibleTabs.map((t) => {
          const active = mode === t.value;
          return (
            <button
              key={t.value}
              role="tab"
              aria-selected={active}
              onClick={() => setMode(t.value)}
              title={`Switch to ${t.label}`}
              className={clsx(
                "px-3 py-1 text-xs rounded-sm border",
                active
                  ? "bg-fvp-surface2 border-fvp-border text-fvp-text"
                  : "bg-transparent border-transparent text-fvp-muted hover:text-fvp-text",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </nav>
      <div
        data-tauri-drag-region
        className="flex-1 text-center text-xs text-fvp-muted truncate px-4"
        title={context}
      >
        {context}
      </div>
      <div
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) void win.toggleMaximize();
        }}
        className="flex items-center gap-px"
      >
        <WindowButton title="Minimize" onClick={() => win.minimize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
        </WindowButton>
        <WindowButton title="Maximize / Restore" onClick={() => win.toggleMaximize()}>
          <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
        </WindowButton>
        <WindowButton title="Close" onClick={() => win.close()} danger>
          <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
        </WindowButton>
      </div>
    </header>
  );
}

function WindowButton({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      className={clsx(
        "w-9 h-7 flex items-center justify-center text-fvp-muted hover:text-fvp-text rounded-sm",
        danger ? "hover:bg-fvp-err hover:text-white" : "hover:bg-fvp-surface2",
      )}
    >
      {children}
    </button>
  );
}
