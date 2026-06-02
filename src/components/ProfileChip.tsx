import { useAppStore } from "../state/appStore";

/**
 * Top-right overlay in Player Mode. Always visible when a file is loaded —
 * shows a sensible state for "no profile" so the user can always click into
 * the ProfileSwitcher.
 */
export function ProfileChip() {
  const currentFile = useAppStore((s) => s.currentFile);
  const detected = useAppStore((s) => s.detectedProfiles);
  const abToggleOn = useAppStore((s) => s.abToggleOn);
  const setSwitcherOpen = useAppStore((s) => s.setSwitcherOpen);

  if (!currentFile) return null;

  const active = detected.filter((p) => p.active);

  let label: string;
  let variant: "off" | "none" | "active";
  if (!abToggleOn) {
    label = "Profile OFF (T)";
    variant = "off";
  } else if (detected.length === 0) {
    label = "No profile";
    variant = "none";
  } else if (active.length === 0) {
    label = `${detected.length} available — none active`;
    variant = "none";
  } else if (active.length === 1) {
    const p = active[0]!;
    label = `Profile: ${p.profile.payload.metadata.name} v${p.profile.payload.metadata.version}`;
    variant = "active";
  } else {
    const names = active
      .slice(0, 2)
      .map((p) => p.profile.payload.metadata.name)
      .join(" + ");
    label = `Profile: ${names} (${active.length} active)`;
    variant = "active";
  }

  const styleByVariant = {
    off: "bg-fvp-err/80 text-white border-fvp-err",
    none: "bg-fvp-surface/85 text-fvp-text border-fvp-muted/60 hover:bg-fvp-surface2 hover:border-fvp-muted",
    active: "bg-fvp-surface/85 text-fvp-text border-fvp-muted/60 hover:bg-fvp-accent hover:border-fvp-accent hover:text-white",
  } as const;

  return (
    <button
      onClick={() => setSwitcherOpen(true)}
      title={
        variant === "off"
          ? "Profile filter is off — press T to re-enable"
          : "Click to switch / stack profiles"
      }
      className={
        "absolute top-3 right-3 px-3 py-1.5 rounded text-xs font-medium backdrop-blur-sm shadow border " +
        styleByVariant[variant]
      }
    >
      {label}
    </button>
  );
}
