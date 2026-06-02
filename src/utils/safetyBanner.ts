/**
 * "Hey, snips aren't on" safety check — runs at moments where the user
 * is about to actually WATCH something (file open, play, fullscreen) and
 * surfaces a top-right banner if their content-filtering profile isn't
 * doing anything.
 *
 * Two flavors:
 *   - inactive-profile (RED): a `.free` was detected but isn't applying
 *     snips right now. Click → activate it.
 *   - no-profile (ORANGE): no `.free` exists for this video. Click →
 *     "Create one now?" Yes/No.
 *
 * Re-suppression: if a banner is currently visible, we DON'T re-trigger
 * it on a subsequent event (avoids spamming the user during a flurry of
 * open → fullscreen → play). The banner has its own auto-fade timer so
 * it'll go away on its own.
 *
 * Only fires in Player Mode. Creator Mode users are explicitly editing;
 * AB-off there is the expected state, not a safety concern.
 */
import { useAppStore } from "../state/appStore";

const REOPEN_GUARD_MS = 1000;

export function evaluateSafetyBanner(): void {
  const s = useAppStore.getState();

  // Only Player Mode. (Library/Settings the user isn't watching;
  // Creator Mode they're editing and AB-off is expected.)
  if (s.mode !== "player") return;
  if (!s.currentFile) return;

  // If a banner is already visible (within its 15s lifespan), don't
  // re-trigger. Lets the user dismiss it once during an open + play
  // sequence without it popping back up.
  if (s.safetyBanner) {
    const age = Date.now() - s.safetyBanner.shownAt;
    if (age < 15_000 + REOPEN_GUARD_MS) return;
  }

  // Are snips currently being applied to playback?
  const hasActiveProfile = s.detectedProfiles.some((p) => p.active);
  const snipsApplied = hasActiveProfile && s.abToggleOn;
  if (snipsApplied) return; // All good — no banner.

  // Determine which banner to show.
  const hasDetectedProfile = s.detectedProfiles.length > 0;
  const kind = hasDetectedProfile ? "inactive-profile" : "no-profile";

  useAppStore.setState({
    safetyBanner: { kind, shownAt: Date.now() },
  });
}

/** Mark the banner dismissed immediately. Used by click handlers + by
 *  the banner's own auto-fade timer when 15s expires. */
export function dismissSafetyBanner(): void {
  useAppStore.setState({ safetyBanner: null });
}

/** Click handler for the RED ("inactive-profile") banner. Activates the
 *  first detected profile and ensures AB-toggle is on, then dismisses. */
export function activateDetectedProfile(): void {
  const s = useAppStore.getState();
  const detected = s.detectedProfiles;
  if (detected.length === 0) {
    dismissSafetyBanner();
    return;
  }
  // Activate the first / highest-quality detected profile (scanner
  // returns sorted best-match first). Leave any that were already
  // active alone.
  const next = detected.map((p, i) => ({ ...p, active: p.active || i === 0 }));
  useAppStore.setState({
    detectedProfiles: next,
    abToggleOn: true,
    safetyBanner: null,
  });
}
