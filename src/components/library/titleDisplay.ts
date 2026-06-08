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

export function looksLike3DInTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  return TITLE_3D_RE.test(title);
}

export function looksLike3DInFilename(filename: string): boolean {
  return FILENAME_3D_RE.test(filename);
}

/** Strip a trailing "3D" / "(3D)" / etc. token from a title. Returns the
 *  cleaned title; if nothing matched, returns the input unchanged. */
export function strip3DFromTitle(title: string): string {
  return title.replace(TITLE_3D_RE, "").trim();
}

/** Render the user-facing title for a library row. Appends " (3D)" when
 *  the identity is flagged. If the underlying title ALREADY contains a
 *  trailing "3D" token (e.g. the user kept it after declining the
 *  cleanup prompt), the suffix is NOT duplicated. */
export function displayTitle(row: LibraryRow): string {
  const id = row.identity;
  const base =
    id.movie_title ?? row.file.path.split(/[\\/]/).pop() ?? "(untitled)";
  if (!id.is_3d) return base;
  if (looksLike3DInTitle(base)) return base;
  return `${base} (3D)`;
}
