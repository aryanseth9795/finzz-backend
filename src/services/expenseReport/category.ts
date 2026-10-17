/**
 * The category an expense is reported under.
 *
 * Mirrors the rule the stats screen uses (getAdvancedStats) so the PDF and the
 * app agree on where a rupee went:
 *   1. a leading "#tag" in the remarks wins, and the tag is everything after
 *      the "#" ("#travel cab" -> "travel cab");
 *   2. otherwise the trimmed category;
 *   3. otherwise "Other" (also for the legacy "-" placeholder).
 */
export const OTHER_CATEGORY = "Other";

export function expenseCategoryOf(exp: {
  category?: string | null;
  remarks?: string | null;
}): string {
  const tag = typeof exp.remarks === "string" ? /^#\s*(.+)/.exec(exp.remarks) : null;
  const tagged = tag ? tag[1].trim() : "";
  if (tagged) return tagged;

  const category = typeof exp.category === "string" ? exp.category.trim() : "";
  if (category && category !== "-") return category;

  return OTHER_CATEGORY;
}
