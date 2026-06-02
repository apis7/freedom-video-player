/** Maximum displayable length for user-facing labels (marker names, flag
 *  names, snip notes). Auto-generated names get truncated with an ellipsis. */
export const MAX_LABEL_LEN = 64;

export function truncateLabel(s: string, max: number = MAX_LABEL_LEN): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
