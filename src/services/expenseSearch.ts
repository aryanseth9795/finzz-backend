import mongoose from "mongoose";
import { Expense } from "../models/expenseModel.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { categoryKey, normalizeCategoryName } from "./expenseCategories.js";
import { OTHER_CATEGORY } from "./expenseReport/category.js";

/**
 * Search and filters for the expense list (`GET /expenses`).
 *
 * ONE FILTER FOR THE PAGE AND THE TOTALS
 * `buildExpenseFilter` returns a plain MongoDB filter the controller uses
 * twice: in `find()` for the page, and in `summarizeExpenses` for the totals.
 * Mongoose casts a `find()` filter but never an aggregate's `$match`, so the
 * ids are cast to ObjectId here. A string userId would match nothing in the
 * aggregate and the totals would silently read zero.
 *
 * Every search condition sits inside one `$and`. Two of them are `$or`s (q and
 * categories), and the controller merges the keyset cursor, itself a top-level
 * `$or`, into the same object; a top-level `$or` here would be overwritten.
 *
 * The same casting gap applies to the values. `find()` would read an amount of
 * "5" as 5, the aggregate would compare it as text and total zero rows. So the
 * params are read here, not trusted to arrive parsed: the amounts as numbers
 * (ignored unless finite and ≥ 0), one category as a string or several as an
 * array, the flag as true or "true". Raw query values give the same rows as
 * parsed ones, on both sides.
 *
 * THE SAME ANSWER AS THE REPORT
 * Tapping a category in the report opens this list filtered to it, so a
 * category filter must return exactly the rows the report counts under that
 * category. The report's rule is `expenseCategoryOf` (expenseReport/category.ts),
 * and the patterns below are that function written as a query:
 *   - the remarks are a tag when they are "#", optional whitespace, then
 *     anything that is not whitespace (`/^#\s*(.+)/` with a capture that
 *     survives `trim()`);
 *   - the tag is the rest of THAT line, because `.` stops at a line break, so
 *     "#gift\nfor mom" is "gift";
 *   - otherwise the trimmed category, unless it is "" or "-";
 *   - otherwise "Other", which is what `uncategorized` selects.
 * Names compare like saved categories do (normalizeCategoryName, ignoring
 * case), so "food  court" finds "Food Court" and "#FOOD court". A category
 * filter for "Other" adds the `uncategorized` rows itself, so it alone is the
 * report's whole "Other" bucket (blank, "-" and a category typed "Other").
 *
 * WHITESPACE
 * JavaScript's `\s` also matches Unicode spaces (a no-break space, say), while
 * MongoDB's PCRE `\s` matches only ASCII ones. The patterns spell out
 * JavaScript's set instead, so a name pasted with a no-break space lands in
 * the same bucket on both sides.
 *
 * COST
 * userId (and ledgerId, for one month) stay plain equalities, so the existing
 * `{ userId, ledgerId, date }` and `{ userId, date }` indexes narrow the scan
 * to one user's rows before any regex runs. No new index.
 */

// Re-exported so callers and tests have the search helpers in one place; the
// escaping itself lives in utils so every search box escapes the same way.
export { escapeRegex };

/** Parsed values, or the raw query values they come from (see the top). */
export interface ExpenseSearchParams {
  q?: string;
  type?: "debit" | "credit";
  /** Several names, or one as a lone query value ("Food"). */
  categories?: string | string[];
  /** Only true or "true" select the bucket. */
  uncategorized?: boolean | string;
  /** Numbers or numeric text; anything not finite and ≥ 0 is no bound. */
  minAmount?: number | string;
  maxAmount?: number | string;
  ledgerId?: string;
}

type Filter = Record<string, unknown>;

//======= Patterns =======//

/** JavaScript's line terminators: where `.` stops, so where a #tag ends. */
const LINE_BREAKS = "\n\r  ";
/** The rest of JavaScript's `\s`: the spaces that do not end a line. */
const SPACES = "\t\u000b\f    -   　﻿";

const WS = `[${SPACES}${LINE_BREAKS}]`; // JavaScript's \s
const NOT_WS = `[^${SPACES}${LINE_BREAKS}]`; // JavaScript's \S
const SPACE = `[${SPACES}]`; // \s that stays on the line

/**
 * A name as a pattern: its words escaped, joined by `separator`. Splitting on
 * the normalised name is what makes "food  court" and "Food Court" one name.
 */
const wordsPattern = (name: string, separator: string) =>
  name.split(" ").map(escapeRegex).join(separator);

// Each helper returns a NEW object: Mongoose casts a `find()` filter in place,
// so a shared constant would be rewritten by the first query that used it.

/** Remarks that are a non-empty #tag, whatever the tag says. */
const isTag = (): Filter => ({ $regex: `^#${WS}*${NOT_WS}` });

/**
 * Remarks that are NOT a #tag. Missing, null and non-text remarks match too,
 * as `expenseCategoryOf` treats them.
 */
const notTag = (): Filter => ({ $not: isTag() });

/**
 * Remarks whose tag is `name`. Words inside the tag are separated by spaces
 * on the same line, and after the last word only spaces may follow before the
 * line (or the text) ends, because the tag is the first line, trimmed.
 */
const tagIs = (name: string): Filter => ({
  $regex: `^#${WS}*${wordsPattern(name, `${SPACE}+`)}${SPACE}*(?:[${LINE_BREAKS}]|$)`,
  $options: "i",
});

/** A category that is `name` once trimmed and normalised. */
const categoryIs = (name: string): Filter => ({
  $regex: `^${WS}*${wordsPattern(name, `${WS}+`)}${WS}*$`,
  $options: "i",
});

/** The rows that fall under one category name. */
const categoryBranches = (name: string): Filter[] => {
  const branches: Filter[] = [{ remarks: tagIs(name) }];
  // "-" is never a category's label: expenseCategoryOf sends that legacy
  // placeholder to "Other". Only a "#-" tag is labelled "-".
  if (name !== "-") branches.push({ remarks: notTag(), category: categoryIs(name) });
  return branches;
};

/**
 * No tag, and a category that is missing, not text, blank or "-". The dash
 * brings its trailing whitespace with it: `WS*-?WS*` reads the same, but on a
 * long run of spaces that is not blank it tries every split of the run between
 * the two `WS*`, which is quadratic in JavaScript's engine.
 */
const uncategorizedBranch = (): Filter => ({
  remarks: notTag(),
  $or: [
    { category: { $not: { $type: "string" } } },
    { category: { $regex: `^${WS}*(?:-${WS}*)?$` } },
  ],
});

//======= Params =======//

/** The search text, trimmed; "" means no search. */
const searchText = (q: string | undefined) => (typeof q === "string" ? q.trim() : "");

/**
 * The category names, normalised, without blanks (they name nothing). One
 * name may come as a plain string; anything that is not text is dropped.
 */
const categoryNames = (categories: string | string[] | undefined): string[] =>
  [categories ?? []]
    .flat()
    .filter((name): name is string => typeof name === "string")
    .map(normalizeCategoryName)
    .filter((name) => name !== "");

/** True for the flag as parsed (true) or as a raw query value ("true"). */
const wantsUncategorized = (flag: boolean | string | undefined) =>
  flag === true || flag === "true";

/**
 * An amount bound as a number, or undefined for no bound. Blank text is no
 * bound rather than 0 (Number("") is 0), and so is anything that is not a
 * finite amount of 0 or more.
 */
const amountBound = (raw: number | string | undefined): number | undefined => {
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const amount = Number(raw);
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined;
};

const OTHER_KEY = categoryKey(OTHER_CATEGORY);

/**
 * True when the request is a search rather than the normal list. A ledgerId
 * alone is the normal month list.
 */
export function isFilteredSearch(p: ExpenseSearchParams): boolean {
  return (
    searchText(p.q) !== "" ||
    p.type !== undefined ||
    categoryNames(p.categories).length > 0 ||
    wantsUncategorized(p.uncategorized) ||
    amountBound(p.minAmount) !== undefined ||
    amountBound(p.maxAmount) !== undefined
  );
}

//======= Filter =======//

/**
 * The MongoDB filter for one user's expenses matching `p`, usable as-is in
 * `find()` and in an aggregate's `$match`. Inputs are expected to have passed
 * the route's zod schema (ledgerId is a valid ObjectId, lengths are capped),
 * but raw query values give the same filter (see the top).
 */
export function buildExpenseFilter(userId: string, p: ExpenseSearchParams): Filter {
  const filter: Filter = { userId: new mongoose.Types.ObjectId(userId) };
  // Present: that month only. Absent: every month.
  if (p.ledgerId) filter.ledgerId = new mongoose.Types.ObjectId(p.ledgerId);

  const and: Filter[] = [];

  const q = searchText(p.q);
  if (q) {
    // Escaped, so ".*(" is searched for literally and cannot cost a slow
    // or broken pattern.
    const contains = { $regex: escapeRegex(q), $options: "i" };
    and.push({ $or: [{ remarks: contains }, { category: { ...contains } }] });
  }

  if (p.type) and.push({ type: p.type });

  // Categories and uncategorized are one choice of "which buckets", so they
  // are OR-ed together, and AND-ed with everything else.
  const names = categoryNames(p.categories);
  const buckets = names.flatMap(categoryBranches);
  // The report's "Other" is the fallback bucket plus a category typed
  // "Other", so asking for "Other" asks for both, whatever the client sends.
  const wantsOther = names.some((name) => categoryKey(name) === OTHER_KEY);
  if (wantsUncategorized(p.uncategorized) || wantsOther) {
    buckets.push(uncategorizedBranch());
  }
  if (buckets.length > 0) and.push({ $or: buckets });

  // Numbers here, never text: the aggregate's $match is not cast.
  const minAmount = amountBound(p.minAmount);
  const maxAmount = amountBound(p.maxAmount);
  if (minAmount !== undefined || maxAmount !== undefined) {
    const amount: Filter = {};
    if (minAmount !== undefined) amount.$gte = minAmount;
    if (maxAmount !== undefined) amount.$lte = maxAmount;
    and.push({ amount });
  }

  // MongoDB rejects an empty $and, and the normal list needs none.
  if (and.length > 0) filter.$and = and;
  return filter;
}

//======= Summary =======//

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Count and totals of EVERY row matching `filter`, not just the loaded page,
 * in one aggregate. Zeros when nothing matches.
 */
export async function summarizeExpenses(
  filter: Filter,
): Promise<{ count: number; debitTotal: number; creditTotal: number }> {
  const [row] = await Expense.aggregate<{
    count: number;
    debitTotal: number;
    creditTotal: number;
  }>([
    { $match: filter },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        // An aggregate skips schema defaults, so a legacy row without `type`
        // counts as the debit the schema would have defaulted it to.
        debitTotal: { $sum: { $cond: [{ $eq: ["$type", "credit"] }, 0, "$amount"] } },
        creditTotal: { $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] } },
      },
    },
  ]);

  return {
    count: row?.count ?? 0,
    debitTotal: round2(row?.debitTotal ?? 0),
    creditTotal: round2(row?.creditTotal ?? 0),
  };
}
