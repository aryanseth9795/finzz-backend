/**
 * The category an expense is reported under.
 *
 * The single rule shared by the stats screen (getAdvancedStats) and the PDF so
 * they agree on where a rupee went:
 *   1. a leading "#tag" in the remarks wins, and the tag is everything after
 *      the "#" ("#travel cab" -> "travel cab");
 *   2. otherwise the trimmed category;
 *   3. otherwise "Other" (also for the legacy "-" placeholder).
 *
 * Reports then merge case and spacing variants of a category (groupByCategory).
 */
export const OTHER_CATEGORY = "Other";

export function expenseCategoryOf(exp: {
  category?: string | null;
  remarks?: string | null;
  [key: string]: unknown;
}): string {
  const tag = typeof exp.remarks === "string" ? /^#\s*(.+)/.exec(exp.remarks) : null;
  const tagged = tag ? tag[1].trim() : "";
  if (tagged) return tagged;

  const category = typeof exp.category === "string" ? exp.category.trim() : "";
  if (category && category !== "-") return category;

  return OTHER_CATEGORY;
}

/**
 * The key reports group a label under: trimmed, inner whitespace collapsed,
 * lowercased, so "Food", "food " and "FOOD" are one category.
 */
export function categoryKey(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

/** expenseCategoryOf, reduced to its grouping key ("#Travel  Cab" -> "travel cab"). */
export function expenseCategoryKeyOf(
  exp: Parameters<typeof expenseCategoryOf>[0],
): string {
  return categoryKey(expenseCategoryOf(exp));
}

/** "Oldest first, then by _id": the order to group in, see groupByCategory. */
export function oldestFirst(
  a: { date: Date | string; _id?: unknown },
  b: { date: Date | string; _id?: unknown },
): number {
  const byDate = new Date(a.date).getTime() - new Date(b.date).getTime();
  if (byDate) return byDate;
  const idA = String(a._id ?? "");
  const idB = String(b._id ?? "");
  return idA < idB ? -1 : idA > idB ? 1 : 0;
}

/**
 * Rows grouped by category key, largest total first.
 *
 * The one merge rule for the stats screen (breakdown, trend, top 5) and the PDF.
 * Each group is named by its most-used spelling; a tie goes to the spelling
 * seen first, so callers pass rows oldest first (`oldestFirst`) and every
 * report names a group the same way. The "Other" group is always "Other", even
 * when rows typed "other" outnumber the uncategorised ones.
 *
 * Totals are not rounded; callers round for display.
 */
export function groupByCategory<T extends { amount: number }>(
  rows: readonly T[],
  labelOf: (row: T) => string = expenseCategoryOf as (row: T) => string,
): Array<{ key: string; name: string; total: number; count: number }> {
  const groups = new Map<
    string,
    { total: number; count: number; spellings: Map<string, number> }
  >();
  for (const row of rows) {
    const label = labelOf(row);
    const key = categoryKey(label);
    let group = groups.get(key);
    if (!group) {
      group = { total: 0, count: 0, spellings: new Map() };
      groups.set(key, group);
    }
    group.total += row.amount;
    group.count += 1;
    group.spellings.set(label, (group.spellings.get(label) ?? 0) + 1);
  }

  const otherKey = categoryKey(OTHER_CATEGORY);
  return [...groups.entries()]
    .map(([key, { total, count, spellings }]) => {
      let name = OTHER_CATEGORY;
      if (key !== otherKey) {
        // Map keeps insertion order, and only a strictly larger count
        // replaces the leader, so a tie keeps the spelling seen first.
        let best = 0;
        for (const [spelling, uses] of spellings) {
          if (uses > best) {
            name = spelling;
            best = uses;
          }
        }
      }
      return { key, name, total, count };
    })
    .sort((a, b) => b.total - a.total);
}
