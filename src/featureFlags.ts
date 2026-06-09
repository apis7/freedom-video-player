/**
 * Build-time feature flags. Centralized so we can disable a feature
 * without ripping its code out — handy for stuff that's broken
 * upstream but might come back, or that's gated on user demand.
 */

/**
 * Google Custom Search (image search) for the "Find alt poster on
 * Google" right-click action. Disabled because Google deprecated the
 * Custom Search Engine setup path users were following in mid-2026;
 * existing accounts may still work but the onboarding flow is broken.
 *
 * Backend command + modal component remain in the tree — flipping this
 * to true re-exposes the UI entry points (right-click menu item +
 * Settings → Google Image Search panel).
 */
export const FEATURE_GOOGLE_POSTER_SEARCH = false;
