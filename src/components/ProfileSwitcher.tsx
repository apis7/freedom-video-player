import { useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import clsx from "clsx";
import { useAppStore } from "../state/appStore";
import { profileIpc } from "../ipc";
import type { DetectedProfile } from "../state/types";
import type { MatchQuality } from "../ipc/types";
import { sanitizeForDisplay } from "../utils/sanitize";

const QUALITY_STYLE: Record<MatchQuality, string> = {
  exact: "bg-fvp-ok/20 text-fvp-ok border-fvp-ok/40",
  soft: "bg-fvp-accent/20 text-fvp-accent border-fvp-accent/40",
  weak: "bg-fvp-warn/20 text-fvp-warn border-fvp-warn/40",
  no_match: "bg-fvp-err/20 text-fvp-err border-fvp-err/40",
};

const QUALITY_LABEL: Record<MatchQuality, string> = {
  exact: "Exact",
  soft: "Soft",
  weak: "Weak",
  no_match: "No match",
};

export function ProfileSwitcher() {
  const open_ = useAppStore((s) => s.switcherOpen);
  const detected = useAppStore((s) => s.detectedProfiles);
  const setOpen = useAppStore((s) => s.setSwitcherOpen);
  const toggleActive = useAppStore((s) => s.toggleProfileActive);
  const addProfile = useAppStore((s) => s.addDetectedProfile);

  useEffect(() => {
    if (!open_) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open_, setOpen]);

  const handleLoadManual = async () => {
    const selected = await open({
      filters: [{ name: ".free profile", extensions: ["free"] }],
      multiple: false,
    });
    if (typeof selected !== "string") return;
    try {
      const profile = await profileIpc.loadProfile(selected);
      const dp: DetectedProfile = {
        path: selected,
        profile,
        score: { quality: "soft", reasons: ["loaded manually"] },
        active: true,
      };
      addProfile(dp);
    } catch (err) {
      console.error(err);
      alert(`Failed to load profile:\n${err}`);
    }
  };

  if (!open_) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-30"
        onClick={() => setOpen(false)}
      />
      <aside
        className="fixed top-0 right-0 h-full w-80 bg-fvp-surface border-l border-fvp-border z-40 flex flex-col shadow-2xl"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-fvp-border">
          <h2 className="text-sm font-semibold text-fvp-text">Profiles for this file</h2>
          <button
            onClick={() => setOpen(false)}
            className="text-fvp-muted hover:text-fvp-text text-sm"
            title="Close (Esc)"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-auto">
          {detected.length === 0 ? (
            <div className="p-6 text-center text-xs text-fvp-muted">
              No `.free` profiles found in this folder.
              <div className="mt-2">Use “Load .free file…” below to import one manually.</div>
            </div>
          ) : (
            <ul className="divide-y divide-fvp-border">
              {detected.map((p) => (
                <ProfileRow
                  key={p.path}
                  profile={p}
                  onToggle={() => toggleActive(p.path)}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="px-4 py-3 border-t border-fvp-border">
          <button
            onClick={handleLoadManual}
            className="w-full px-3 py-2 bg-fvp-surface2 hover:bg-fvp-border text-fvp-text text-xs rounded"
            title="Pick a .free file from anywhere"
          >
            Load .free file…
          </button>
        </footer>
      </aside>
    </>
  );
}

function ProfileRow({
  profile,
  onToggle,
}: {
  profile: DetectedProfile;
  onToggle: () => void;
}) {
  const meta = profile.profile.payload.metadata;
  const snipCount = profile.profile.payload.snips.length;
  const uploader = profile.profile.uploader ?? "your local";
  // Autosaves are written by this app; anything else is "imported" (manual
  // export, copied from another folder, downloaded). The provenance badge
  // helps the user remember which profiles they CREATED vs RECEIVED.
  const isAutosave = profile.path
    .toLowerCase()
    .endsWith(".fvp-autosave.free");

  return (
    <li className="px-4 py-3">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={profile.active}
          onChange={onToggle}
          className="mt-1 accent-fvp-accent cursor-pointer"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-fvp-text truncate">
              {sanitizeForDisplay(meta.name)}{" "}
              <span className="text-fvp-muted font-normal">v{meta.version}</span>
            </div>
            <span
              className={clsx(
                "shrink-0 px-1.5 py-px text-[10px] rounded border font-medium uppercase tracking-wide",
                QUALITY_STYLE[profile.score.quality],
              )}
              title={profile.score.reasons.join(" · ")}
            >
              {QUALITY_LABEL[profile.score.quality]}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-fvp-muted flex items-center gap-1.5 flex-wrap">
            <span>
              {snipCount} snip{snipCount === 1 ? "" : "s"} · by {sanitizeForDisplay(uploader)}
            </span>
            {profile.profile.signature && (
              <span title="Profile is signed (cryptographic provenance)">
                · ✓ signed
              </span>
            )}
            <span
              className={clsx(
                "px-1 py-px rounded text-[9px] uppercase tracking-wide border",
                isAutosave
                  ? "bg-fvp-accent/15 text-fvp-accent border-fvp-accent/30"
                  : "bg-fvp-warn/15 text-fvp-warn border-fvp-warn/30",
              )}
              title={
                isAutosave
                  ? "Autosaved by FVP from your edits in Profile Creator."
                  : "Imported — this profile was authored or downloaded elsewhere. Review snips before relying on it."
              }
            >
              {isAutosave ? "Autosave" : "Imported"}
            </span>
          </div>
        </div>
      </label>
    </li>
  );
}
