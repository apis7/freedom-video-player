/**
 * Built-in snip categories shipped with FVP. Users can also add their own
 * custom categories (stored in `appStore.customCategories`) — those render
 * alongside these but use a generic fallback color.
 *
 * The four discrete "agenda: …" buckets were collapsed into a single
 * "agenda: see notes" — users now put specifics in the snip's note field
 * (saved with the .free file) so the category set stays compact.
 */
export const DEFAULT_CATEGORIES = [
  "language",
  "sex",
  "violence",
  "boring",
  "agenda: see notes",
  "misc",
];

export const CATEGORY_COLOR: Record<string, string> = {
  language: "#4f8cff",
  sex: "#f85149",
  violence: "#d29922",
  boring: "#8a8f9c",
  "agenda: see notes": "#a371f7",
  misc: "#8a8f9c",
};
