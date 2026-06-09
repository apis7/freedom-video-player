/**
 * Library title rendering helpers. Single source of truth for the "(3D)"
 * suffix so every view (poster grid, column row, details panel, context
 * menu) appends it consistently.
 */

import type { LibraryRow } from "../../ipc/library";

/** Catches "3D", "3d", "(3D)", "(3D )", "[3D]" with arbitrary leading
 *  whitespace, _, ., or - separators — what messy filenames actually
 *  use. The captured group is the WHOLE matched token incl. surrounding
 *  parens/brackets so the strip function can delete it cleanly. */
const TITLE_3D_RE = /(\s*[\[(]?\s*3\s*[dD]\s*[\])]?\s*)$/;

/** Same idea but matches anywhere in a filename (not anchored to end)
 *  and also looks for the "_3d_" / ".3d." / "-3d-" forms commonly seen
 *  in user-named files. Used by the filter to surface files whose
 *  identity isn't flagged 3D but whose filename clearly says so. */
const FILENAME_3D_RE = /(?:[\s_.\-(\[]|^)3\s*[dD](?:[\s_.\-)\]]|$)/;

/** Trailing "Extended Edition" / "Director's Cut" / "Final Cut" /
 *  "Theatrical Cut" tokens, with the same liberal whitespace +
 *  punctuation tolerance as the 3D detector. */
const TITLE_EXTENDED_RE =
  /(\s*[\[(]?\s*(?:extended(?:\s+edition)?|director'?s?\s+cut|final\s+cut|theatrical\s+cut|unrated|uncut|special\s+edition)\s*[\])]?\s*)$/i;

/** Filename-anywhere variant. Catches "Movie_Extended_1080p.mp4",
 *  "Movie Directors Cut.mkv", "Movie (Final Cut).mp4", etc. */
const FILENAME_EXTENDED_RE =
  /(?:[\s_.\-(\[]|^)(?:extended|director'?s?\s*cut|final\s*cut|theatrical\s*cut|unrated|uncut)(?:[\s_.\-)\]]|$)/i;

export function looksLike3DInTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return TITLE_3D_RE.test(title);
}

export function looksLike3DInFilename(filename: string): boolean {
  return FILENAME_3D_RE.test(filename);
}

export function looksLikeExtendedInTitle(
  title: string | null | undefined,
): boolean {
  if (!title) return false;
  return TITLE_EXTENDED_RE.test(title);
}

export function looksLikeExtendedInFilename(filename: string): boolean {
  return FILENAME_EXTENDED_RE.test(filename);
}

/** Strip a trailing "3D" / "(3D)" / etc. token from a title. Returns the
 *  cleaned title; if nothing matched, returns the input unchanged. */
export function strip3DFromTitle(title: string): string {
  return title.replace(TITLE_3D_RE, "").trim();
}

export function stripExtendedFromTitle(title: string): string {
  return title.replace(TITLE_EXTENDED_RE, "").trim();
}

/** Render the user-facing title for a library row. Appends " (3D)" and/or
 *  " (Extended)" when the identity is flagged. Suffixes are NOT
 *  duplicated when the underlying title already contains the marker. */
export function displayTitle(row: LibraryRow): string {
  const id = row.identity;
  let out =
    id.movie_title ?? row.file.path.split(/[\\/]/).pop() ?? "(untitled)";
  if (id.is_extended && !looksLikeExtendedInTitle(out)) {
    out = `${out} (Extended)`;
  }
  if (id.is_3d && !looksLike3DInTitle(out)) {
    out = `${out} (3D)`;
  }
  return out;
}
