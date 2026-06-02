import type { Snip } from "../ipc/types";

/**
 * Per-spec snip-summary computation for the Movie Info panel. Groups
 * snips by category, counts per group, applies the "alcohol/drugs/
 * smoking" bundling rule, and returns rows in the canonical display
 * order. Categories with count=0 are omitted.
 *
 * Output is intentionally informative-only — we never expose specific
 * keywords (e.g. "language: 48", never "language: fuck × 12").
 */

export interface SnipSummaryRow {
  label: string;
  count: number;
}

// Display labels for the well-known categories. Anything not in this
// map renders with title-cased original string. The map also defines
// the canonical sort order via insertion order.
const CANONICAL_ORDER: Array<{ match: (cat: string) => boolean; label: string }> = [
  { match: (c) => c === "sex" || c === "sex-references", label: "Sex" },
  { match: (c) => c === "violence", label: "Violence" },
  { match: (c) => c === "language" || c === "language-mild" || c === "blasphemy" || c === "offensive-slurs", label: "Language" },
  {
    match: (c) =>
      c === "alcohol" ||
      c === "drug-references" ||
      c === "smoking" ||
      c === "drugs" ||
      c === "tobacco",
    label: "Alcohol, drugs, and smoking",
  },
  { match: (c) => c.startsWith("agenda"), label: "Agenda" },
  { match: (c) => c === "boring", label: "Boring" },
  { match: (c) => c === "misc", label: "Misc" },
];

export function buildSnipSummary(snips: Snip[]): SnipSummaryRow[] {
  // Step 1: every snip increments the count of EACH of its categories.
  // Snips with no categories at all bucket into "(uncategorized)".
  const rawCounts = new Map<string, number>();
  for (const s of snips) {
    if (s.categories.length === 0) {
      rawCounts.set("(uncategorized)", (rawCounts.get("(uncategorized)") ?? 0) + 1);
      continue;
    }
    for (const c of s.categories) {
      const key = c.toLowerCase().trim();
      rawCounts.set(key, (rawCounts.get(key) ?? 0) + 1);
    }
  }

  // Step 2: bucket into canonical groups + collect "other" categories
  // for alphabetical tail.
  const groupTotals = new Map<string, number>();
  const otherCounts = new Map<string, number>();

  for (const [cat, count] of rawCounts.entries()) {
    const canonical = CANONICAL_ORDER.find((g) => g.match(cat));
    if (canonical) {
      groupTotals.set(canonical.label, (groupTotals.get(canonical.label) ?? 0) + count);
    } else if (cat !== "(uncategorized)") {
      // Custom categories — display title-cased, sorted at end.
      const display = titleCase(cat);
      otherCounts.set(display, (otherCounts.get(display) ?? 0) + count);
    }
  }

  // Step 3: assemble in canonical order, drop zeros, append custom-sorted.
  const rows: SnipSummaryRow[] = [];
  for (const g of CANONICAL_ORDER) {
    const c = groupTotals.get(g.label);
    if (c && c > 0) rows.push({ label: g.label, count: c });
  }
  const others = [...otherCounts.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [label, count] of others) {
    if (count > 0) rows.push({ label, count });
  }
  const uncat = rawCounts.get("(uncategorized)") ?? 0;
  if (uncat > 0) rows.push({ label: "Uncategorized", count: uncat });
  return rows;
}

function titleCase(s: string): string {
  return s
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
