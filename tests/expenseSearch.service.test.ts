import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { connect, disconnect, resetDb, syncIndexes } from "./helpers.js";
import { Expense } from "../src/models/expenseModel.js";
import {
  expenseCategoryOf,
  OTHER_CATEGORY,
} from "../src/services/expenseReport/category.js";
import { categoryKey } from "../src/services/expenseCategories.js";
import {
  escapeRegex,
  isFilteredSearch,
  buildExpenseFilter,
  summarizeExpenses,
  type ExpenseSearchParams,
} from "../src/services/expenseSearch.js";
import { buildSearchRegex } from "../src/utils/escapeRegex.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(resetDb);

type Id = mongoose.Types.ObjectId;
const oid = () => new mongoose.Types.ObjectId();

// Fresh ids per test. Nothing here needs real User or ledger documents: the
// filter only compares ids.
let me: Id;
let other: Id;
let thisMonth: Id;
let lastMonth: Id;
beforeEach(() => {
  me = oid();
  other = oid();
  thisMonth = oid();
  lastMonth = oid();
});

interface Row {
  name: string;
  /** Omitted when undefined; stored as null when null. */
  remarks?: string | null;
  category?: string | null;
  /** "none" leaves the field out, like a row written before the default. */
  type?: "debit" | "credit" | "none";
  amount?: number;
  ledgerId?: Id;
  userId?: Id;
}

/** Row name by _id, for the rows seeded in the current test. */
let names = new Map<string, string>();

/**
 * Insert through the raw driver so values reach the database exactly as
 * written. The schema would trim remarks and category and default `type`, but
 * the filter has to be right for legacy rows written before those rules too.
 */
const seed = async (rows: Row[]) => {
  const docs = rows.map((r, i) => {
    const doc: Record<string, unknown> = {
      _id: oid(),
      userId: r.userId ?? me,
      ledgerId: r.ledgerId ?? thisMonth,
      amount: r.amount ?? 10,
      date: new Date(Date.now() - i * 60_000),
    };
    if (r.type !== "none") doc.type = r.type ?? "debit";
    if (r.remarks !== undefined) doc.remarks = r.remarks;
    if (r.category !== undefined) doc.category = r.category;
    return doc;
  });
  await Expense.collection.insertMany(docs);
  names = new Map(rows.map((r, i) => [String(docs[i]._id), r.name]));
};

const sortedNames = (docs: { _id: unknown }[]) =>
  docs.map((d) => names.get(String(d._id)) ?? "?").sort();

/**
 * `p` spelled the way an unparsed query string would carry it: bounds as text,
 * a lone category as a string rather than a one-item array, the flag as "true".
 */
const asRawQuery = (p: ExpenseSearchParams): ExpenseSearchParams => {
  const raw: ExpenseSearchParams = { ...p };
  if (typeof p.minAmount === "number") raw.minAmount = String(p.minAmount);
  if (typeof p.maxAmount === "number") raw.maxAmount = String(p.maxAmount);
  if (Array.isArray(p.categories) && p.categories.length === 1) {
    raw.categories = p.categories[0];
  }
  if (p.uncategorized === true) raw.uncategorized = "true";
  return raw;
};

/**
 * Names of the rows the filter matches. The controller feeds the same filter
 * to `find()` (the page) and to an aggregate (the totals), and Mongoose casts
 * only the first, so every case checks that both agree. Each gets its own
 * filter object because Mongoose casts a `find()` filter in place.
 *
 * Every case is also run with its raw query spelling (`asRawQuery`): the
 * filter must not lean on `find()`'s casting, which the aggregate never gets,
 * so "5" has to give the same rows as 5 in both.
 */
const matched = async (p: ExpenseSearchParams, userId: Id = me) => {
  const rowsOf = async (params: ExpenseSearchParams) => {
    const found = await Expense.find(buildExpenseFilter(String(userId), params))
      .select("_id")
      .lean<{ _id: unknown }[]>();
    const aggregated = await Expense.aggregate<{ _id: unknown }>([
      { $match: buildExpenseFilter(String(userId), params) },
      { $project: { _id: 1 } },
    ]);
    expect(sortedNames(aggregated)).toEqual(sortedNames(found));
    return sortedNames(found);
  };
  const rows = await rowsOf(p);
  expect(await rowsOf(asRawQuery(p))).toEqual(rows);
  return rows;
};

/** Every `$regex` in a filter, compiled the way JavaScript would run it. */
const regexesIn = (node: unknown): RegExp[] => {
  if (Array.isArray(node)) return node.flatMap(regexesIn);
  if (node === null || typeof node !== "object") return [];
  if (node instanceof mongoose.Types.ObjectId) return [];
  const obj = node as Record<string, unknown>;
  const own =
    typeof obj.$regex === "string"
      ? [new RegExp(obj.$regex, typeof obj.$options === "string" ? obj.$options : "")]
      : [];
  return [...own, ...Object.values(obj).flatMap(regexesIn)];
};

/** The report's label, from the row exactly as stored. */
const labelOf = (r: Row) =>
  expenseCategoryOf({ remarks: r.remarks, category: r.category });

//======= escapeRegex =======//

describe("escapeRegex", () => {
  it("escapes every regex metacharacter so the text matches only itself", () => {
    const text = "a.*+?^${}()|[]\\b";
    const re = new RegExp(`^${escapeRegex(text)}$`);
    expect(re.test(text)).toBe(true);
    expect(re.test("ab")).toBe(false);
    expect(escapeRegex(".*(")).toBe("\\.\\*\\(");
  });

  it("leaves ordinary text unchanged", () => {
    expect(escapeRegex("Food court #1 - cab/auto")).toBe("Food court #1 - cab/auto");
  });

  it("spells a NUL as \\x00, which MongoDB accepts in a pattern and matches literally", () => {
    // A raw NUL makes MongoDB reject the whole pattern (code 2).
    expect(escapeRegex("a\0b")).toBe("a\\x00b");
    expect(escapeRegex("\\\0")).toBe("\\\\\\x00");
    const re = new RegExp(`^${escapeRegex("a\0b\\\0")}$`);
    expect(re.test("a\0b\\\0")).toBe(true);
    expect(re.test("a b\\ ")).toBe(false);
  });
});

//======= isFilteredSearch =======//

describe("isFilteredSearch", () => {
  it("is false for the normal list, with or without a ledger", () => {
    expect(isFilteredSearch({})).toBe(false);
    expect(isFilteredSearch({ ledgerId: String(oid()) })).toBe(false);
  });

  it("is true when any search parameter is set", () => {
    expect(isFilteredSearch({ q: "cab" })).toBe(true);
    expect(isFilteredSearch({ type: "credit" })).toBe(true);
    expect(isFilteredSearch({ categories: ["Food"] })).toBe(true);
    expect(isFilteredSearch({ uncategorized: true })).toBe(true);
    // 0 is a real bound, not "unset".
    expect(isFilteredSearch({ minAmount: 0 })).toBe(true);
    expect(isFilteredSearch({ maxAmount: 0 })).toBe(true);
  });

  it("ignores values that filter nothing", () => {
    expect(
      isFilteredSearch({ q: "   ", categories: [], uncategorized: false }),
    ).toBe(false);
    expect(isFilteredSearch({ categories: ["  "] })).toBe(false);
  });

  it("reads raw query values the way buildExpenseFilter does", () => {
    expect(isFilteredSearch({ minAmount: "0" })).toBe(true);
    expect(isFilteredSearch({ maxAmount: "5" })).toBe(true);
    expect(isFilteredSearch({ categories: "Food" })).toBe(true);
    expect(isFilteredSearch({ uncategorized: "true" })).toBe(true);
    // Values buildExpenseFilter ignores are not a search either.
    expect(
      isFilteredSearch({
        minAmount: "abc",
        maxAmount: "-1",
        categories: "  ",
        uncategorized: "false",
      }),
    ).toBe(false);
    expect(isFilteredSearch({ minAmount: "", maxAmount: Number.NaN })).toBe(false);
  });
});

//======= buildExpenseFilter: shape =======//

describe("buildExpenseFilter shape", () => {
  it("casts userId and ledgerId to ObjectId, because an aggregate is never cast", () => {
    const ledgerId = String(oid());
    const filter = buildExpenseFilter(String(me), { ledgerId });
    expect(filter.userId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(filter.ledgerId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(String(filter.userId)).toBe(String(me));
    expect(String(filter.ledgerId)).toBe(ledgerId);
  });

  it("is only the owner (and ledger) for the normal list", () => {
    expect(Object.keys(buildExpenseFilter(String(me), {}))).toEqual(["userId"]);
    expect(
      Object.keys(buildExpenseFilter(String(me), { ledgerId: String(thisMonth) })),
    ).toEqual(["userId", "ledgerId"]);
  });

  it("keeps the conditions in one $and, never a top-level $or the cursor would overwrite", () => {
    const filter = buildExpenseFilter(String(me), {
      q: "cab",
      type: "debit",
      categories: ["Food"],
      uncategorized: true,
      minAmount: 1,
      maxAmount: 100,
    });
    expect(filter).not.toHaveProperty("$or");
    expect(Array.isArray(filter.$and)).toBe(true);
  });
});

//======= q =======//

describe("q", () => {
  it("finds the text anywhere in remarks or category, ignoring case", async () => {
    await seed([
      { name: "in remarks", remarks: "Team LUNCH at office", category: "Work" },
      { name: "in category", remarks: "paid cash", category: "Lunch money" },
      { name: "neither", remarks: "dinner", category: "Food" },
      { name: "no fields" },
    ]);
    expect(await matched({ q: "lunch" })).toEqual(["in category", "in remarks"]);
  });

  it("trims the text", async () => {
    await seed([{ name: "lunch", remarks: "Team lunch" }, { name: "dinner", remarks: "dinner" }]);
    expect(await matched({ q: "  lunch  " })).toEqual(["lunch"]);
  });

  it("searches regex characters literally", async () => {
    await seed([
      { name: "literal", remarks: "odd .*( text" },
      { name: "plain", remarks: "anything at all" },
      { name: "parens", category: "Books (used)" },
    ]);
    // Unescaped, ".*" would match every row and ".*(" would be a broken pattern.
    expect(await matched({ q: ".*" })).toEqual(["literal"]);
    expect(await matched({ q: ".*(" })).toEqual(["literal"]);
    expect(await matched({ q: "(used)" })).toEqual(["parens"]);
  });

  it("searches a NUL literally instead of failing the query", async () => {
    await seed([
      { name: "nul remarks", remarks: "odd\0text" },
      { name: "nul category", category: "Fo\0od" },
      { name: "plain", remarks: "odd text", category: "Food" },
    ]);
    expect(await matched({ q: "odd\0" })).toEqual(["nul remarks"]);
    expect(await matched({ q: "\0" })).toEqual(["nul category", "nul remarks"]);
    expect(await matched({ categories: ["fo\0od"] })).toEqual(["nul category"]);
    // The other search boxes (notes, admin) escape through the same helper.
    const contains = buildSearchRegex("odd\0")!;
    const rows = await Expense.find({ userId: me, remarks: contains }).lean();
    expect(sortedNames(rows)).toEqual(["nul remarks"]);
  });
});

//======= type =======//

describe("type", () => {
  it("matches the type exactly", async () => {
    await seed([
      { name: "debit", type: "debit" },
      { name: "credit", type: "credit" },
    ]);
    expect(await matched({ type: "credit" })).toEqual(["credit"]);
    expect(await matched({ type: "debit" })).toEqual(["debit"]);
  });
});

//======= categories =======//

describe("categories", () => {
  it("ignores case and runs of whitespace in the name", async () => {
    await seed([
      { name: "exact", category: "Food Court" },
      { name: "spaced", category: "  food \t  COURT " },
      { name: "tag", remarks: "#FOOD   court" },
      { name: "shorter", category: "Food" },
      { name: "longer", category: "Food Courts" },
    ]);
    expect(await matched({ categories: ["food  court"] })).toEqual([
      "exact",
      "spaced",
      "tag",
    ]);
  });

  it("lets a leading #tag win over the category, as the report does", async () => {
    await seed([
      { name: "tagged", category: "Food", remarks: "#travel cab" },
      { name: "food", category: "Food" },
    ]);
    expect(labelOf({ name: "", category: "Food", remarks: "#travel cab" })).toBe(
      "travel cab",
    );
    expect(await matched({ categories: ["travel cab"] })).toEqual(["tagged"]);
    expect(await matched({ categories: ["Food"] })).toEqual(["food"]);
  });

  it("falls back to the category when the remarks are not a tag", async () => {
    await seed([
      { name: "hash space", remarks: "# ", category: "Food" },
      { name: "bare hash", remarks: "#", category: "Food" },
      { name: "hash later", remarks: "lunch #travel", category: "Food" },
      { name: "no remarks", category: "Food" },
      { name: "null remarks", remarks: null, category: "Food" },
    ]);
    expect(await matched({ categories: ["Food"] })).toEqual([
      "bare hash",
      "hash later",
      "hash space",
      "no remarks",
      "null remarks",
    ]);
    expect(await matched({ categories: ["travel"] })).toEqual([]);
  });

  it("takes the tag from the first line of the remarks, as expenseCategoryOf does", async () => {
    const rows: Row[] = [
      { name: "two lines", remarks: "#gift\nfor mom", category: "Family" },
      { name: "tag on next line", remarks: "#\n  gift  ", category: "Family" },
      { name: "split tag", remarks: "#gift\ncard" },
    ];
    for (const r of rows) expect(labelOf(r)).toBe("gift");
    await seed(rows);
    expect(await matched({ categories: ["gift"] })).toEqual([
      "split tag",
      "tag on next line",
      "two lines",
    ]);
    expect(await matched({ categories: ["gift card"] })).toEqual([]);
    expect(await matched({ categories: ["Family"] })).toEqual([]);
  });

  it("treats a no-break space as whitespace, as JavaScript does", async () => {
    const rows: Row[] = [
      { name: "nbsp category", category: "Food Court" },
      { name: "nbsp after hash", remarks: "# snacks", category: "Food" },
    ];
    expect(labelOf(rows[1])).toBe("snacks");
    await seed(rows);
    expect(await matched({ categories: ["food court"] })).toEqual(["nbsp category"]);
    expect(await matched({ categories: ["snacks"] })).toEqual(["nbsp after hash"]);
    expect(await matched({ categories: ["Food"] })).toEqual([]);
  });

  it("treats regex characters in a name literally", async () => {
    await seed([
      { name: "cpp", category: "C++ (books)" },
      { name: "dot", category: "a.b" },
      { name: "not dot", category: "axb" },
    ]);
    expect(await matched({ categories: ["c++ (books)"] })).toEqual(["cpp"]);
    expect(await matched({ categories: ["a.b"] })).toEqual(["dot"]);
  });

  it("matches any of several categories", async () => {
    await seed([
      { name: "food", category: "Food" },
      { name: "rent", category: "Rent" },
      { name: "cab", remarks: "#cab", category: "Rent" },
      { name: "fuel", category: "Fuel" },
    ]);
    expect(await matched({ categories: ["Food", "rent", "CAB"] })).toEqual([
      "cab",
      "food",
      "rent",
    ]);
  });
});

//======= uncategorized =======//

describe("uncategorized", () => {
  it("matches what the report calls Other: no tag, and a missing, blank or \"-\" category", async () => {
    await seed([
      { name: "missing" },
      { name: "null", category: null },
      { name: "empty", category: "" },
      { name: "spaces", category: "  \t " },
      { name: "dash", category: "-" },
      { name: "spaced dash", category: " - " },
      { name: "empty hash", remarks: "# ", category: "" },
      { name: "tagged", remarks: "#snacks" },
      { name: "food", category: "Food" },
      { name: "double dash", category: "--" },
      // A category the user typed as "Other" is a real category, not "none".
      { name: "typed other", category: "Other" },
    ]);
    expect(await matched({ uncategorized: true })).toEqual([
      "dash",
      "empty",
      "empty hash",
      "missing",
      "null",
      "spaced dash",
      "spaces",
    ]);
  });

  it("with categories, matches either", async () => {
    await seed([
      { name: "food", category: "Food" },
      { name: "blank", category: "" },
      { name: "rent", category: "Rent" },
    ]);
    expect(await matched({ categories: ["Food"], uncategorized: true })).toEqual([
      "blank",
      "food",
    ]);
  });

  it("is included by a category filter for \"Other\", so that alone is the report's whole Other bucket", async () => {
    const rows: Row[] = [
      { name: "missing" },
      { name: "blank", category: "  " },
      { name: "dash", category: "-" },
      { name: "empty hash", remarks: "# ", category: " - " },
      { name: "typed Other", category: "Other" },
      { name: "typed other", category: " other " },
      { name: "Other tag", remarks: "#OTHER", category: "Food" },
      { name: "food", category: "Food" },
      { name: "dash tag", remarks: "#-" },
    ];
    await seed(rows);
    const bucket = rows
      .filter((r) => categoryKey(labelOf(r)) === categoryKey(OTHER_CATEGORY))
      .map((r) => r.name)
      .sort();
    expect(bucket).toHaveLength(7);
    expect(await matched({ categories: ["Other"] })).toEqual(bucket);
    expect(await matched({ categories: ["  OTHER "] })).toEqual(bucket);
    // With the flag too, or beside another category, nothing changes.
    expect(await matched({ categories: ["other"], uncategorized: true })).toEqual(bucket);
    expect(await matched({ categories: ["Food", "Other"] })).toEqual(
      [...bucket, "food"].sort(),
    );
  });

  it("classifies a category of 20k spaces quickly and correctly", async () => {
    const spaces = " ".repeat(20_000);
    const rows: Row[] = [
      { name: "long blank", category: spaces },
      { name: "long dash", category: `${spaces}-${spaces}` },
      // Each of these used to cost the old pattern quadratic backtracking.
      { name: "long then word", category: `${spaces}Food` },
      { name: "long then two dashes", category: `${spaces}--` },
    ];
    expect(rows.map(labelOf)).toEqual(["Other", "Other", "Food", "--"]);
    await seed(rows);

    const started = performance.now();
    const summary = await summarizeExpenses(
      buildExpenseFilter(String(me), { uncategorized: true }),
    );
    const elapsed = performance.now() - started;
    expect(summary.count).toBe(2);
    expect(elapsed).toBeLessThan(50);

    expect(await matched({ uncategorized: true })).toEqual(["long blank", "long dash"]);
    expect(await matched({ categories: ["food"] })).toEqual(["long then word"]);
  });

  it("uses no pattern that backtracks on long whitespace, in JavaScript's engine too", () => {
    // MongoDB 7's PCRE2 happened to survive the old `WS*-?WS*`; V8 took about
    // 600 ms on these inputs. So every pattern the filter sends is timed here.
    const filter = buildExpenseFilter(String(me), {
      q: "x",
      categories: ["Other", "food court"],
      uncategorized: true,
    });
    const patterns = regexesIn(filter);
    expect(patterns.length).toBeGreaterThan(5);

    const spaces = " ".repeat(20_000);
    const texts = [
      spaces,
      `${spaces}x`,
      `${spaces}-${spaces}x`,
      `${spaces}--`,
      `food${spaces}court${spaces}x`,
      `#${spaces}food${spaces}court${spaces}x`,
    ];
    const started = performance.now();
    for (const re of patterns) for (const text of texts) re.test(text);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

//======= amount =======//

describe("amount range", () => {
  beforeEach(async () => {
    await seed([
      { name: "5", amount: 5 },
      { name: "10", amount: 10 },
      { name: "15", amount: 15, category: "Food" },
      { name: "20", amount: 20, category: "Food" },
    ]);
  });

  it("includes both bounds", async () => {
    expect(await matched({ minAmount: 10 })).toEqual(["10", "15", "20"]);
    expect(await matched({ maxAmount: 15 })).toEqual(["10", "15", "5"]);
    expect(await matched({ minAmount: 10, maxAmount: 15 })).toEqual(["10", "15"]);
    expect(await matched({ minAmount: 15, maxAmount: 15 })).toEqual(["15"]);
  });

  it("combines with the other filters (all must hold)", async () => {
    expect(await matched({ maxAmount: 15, categories: ["Food"] })).toEqual(["15"]);
  });

  it("ignores a bound that is not a finite amount of 0 or more", async () => {
    const all = ["10", "15", "20", "5"];
    for (const bad of ["abc", "-1", "", "  ", "Infinity", -1, Number.NaN, Infinity]) {
      expect(await matched({ minAmount: bad })).toEqual(all);
      expect(await matched({ maxAmount: bad })).toEqual(all);
    }
    // The good bound still applies beside a bad one.
    expect(await matched({ minAmount: "abc", maxAmount: "10" })).toEqual(["10", "5"]);
  });
});

//======= raw query values =======//

describe("raw query values", () => {
  it("totals a text bound the way find() reads it (\"5\" is 5, not zero rows)", async () => {
    await seed([
      { name: "4", amount: 4 },
      { name: "5", amount: 5 },
      { name: "7", amount: 7, type: "credit" },
    ]);
    expect(
      await summarizeExpenses(buildExpenseFilter(String(me), { minAmount: "5" })),
    ).toEqual({ count: 2, debitTotal: 5, creditTotal: 7 });
    expect(
      await summarizeExpenses(buildExpenseFilter(String(me), { maxAmount: "4.5" })),
    ).toEqual({ count: 1, debitTotal: 4, creditTotal: 0 });
  });

  it("takes one category as a string, and the flag as \"true\" only", async () => {
    await seed([
      { name: "food", category: "Food" },
      { name: "blank", category: "" },
      { name: "rent", category: "Rent" },
    ]);
    expect(await matched({ categories: "food" })).toEqual(["food"]);
    expect(await matched({ categories: "Food", uncategorized: "true" })).toEqual([
      "blank",
      "food",
    ]);
    const all = ["blank", "food", "rent"];
    for (const flag of ["false", "1", "", "TRUE"]) {
      expect(await matched({ uncategorized: flag })).toEqual(all);
    }
  });
});

//======= scope =======//

describe("ledger scope", () => {
  it("searches one month with a ledgerId and every month without", async () => {
    await seed([
      { name: "now 1", category: "Food" },
      { name: "now 2", category: "Food" },
      { name: "earlier", category: "Food", ledgerId: lastMonth },
    ]);
    const ledgerId = String(thisMonth);
    expect(await matched({ categories: ["Food"], ledgerId })).toEqual(["now 1", "now 2"]);
    expect(await matched({ categories: ["Food"] })).toEqual(["earlier", "now 1", "now 2"]);
    expect(await matched({ ledgerId })).toEqual(["now 1", "now 2"]);
  });
});

describe("ownership", () => {
  it("never matches another user's rows", async () => {
    await seed([
      { name: "mine", remarks: "food stall", category: "Food" },
      { name: "mine blank", category: "" },
      { name: "theirs", remarks: "food stall", category: "Food", userId: other },
      { name: "theirs blank", category: "", userId: other },
    ]);
    const cases: ExpenseSearchParams[] = [
      {},
      { q: "food" },
      { type: "debit" },
      { categories: ["Food"] },
      { uncategorized: true },
      { minAmount: 0 },
    ];
    for (const p of cases) {
      for (const name of await matched(p)) expect(name.startsWith("mine")).toBe(true);
    }
    expect(await matched({}, other)).toEqual(["theirs", "theirs blank"]);
  });
});

//======= summarizeExpenses =======//

describe("summarizeExpenses", () => {
  it("counts and totals every match, rounded to 2 dp; a row without type is a debit", async () => {
    await seed([
      { name: "d1", amount: 10.1, category: "Food" },
      { name: "d2", amount: 20.2, category: "Food" },
      { name: "legacy", amount: 5, type: "none", category: "Food" },
      { name: "c1", amount: 0.1, type: "credit", category: "Food" },
      { name: "c2", amount: 0.2, type: "credit", category: "Food" },
      { name: "rent", amount: 999, category: "Rent" },
      { name: "theirs", amount: 1000, category: "Food", userId: other },
    ]);
    expect(
      await summarizeExpenses(buildExpenseFilter(String(me), { categories: ["Food"] })),
    ).toEqual({ count: 5, debitTotal: 35.3, creditTotal: 0.3 });
  });

  it("returns zeros when nothing matches", async () => {
    await seed([{ name: "food", category: "Food" }]);
    expect(
      await summarizeExpenses(buildExpenseFilter(String(me), { q: "nothing like this" })),
    ).toEqual({ count: 0, debitTotal: 0, creditTotal: 0 });
  });
});

//======= parity with the report =======//

describe("parity with expenseCategoryOf", () => {
  it("each label the report produces finds exactly the rows the report puts under it", async () => {
    const rows: Row[] = [
      { name: "Food", category: "Food" },
      { name: "food trailing space", category: "food " },
      { name: "FOOD", category: "FOOD", type: "credit" },
      { name: "#Food over Rent", remarks: "#Food", category: "Rent" },
      { name: "Food Court", category: "Food Court" },
      { name: "food court spaced", category: " food   court" },
      { name: "food court nbsp", category: "Food Court" },
      { name: "food court tag", remarks: "#  food\tcourt  ", category: "Food" },
      { name: "travel cab", remarks: "#travel cab", category: "Food" },
      { name: "travel cab refund", remarks: "#Travel Cab refund", category: "Food" },
      { name: "gift two lines", remarks: "#gift\nfor mom", category: "Family" },
      { name: "gift next line", remarks: "#\ngift" },
      { name: "Family", category: "Family" },
      { name: "hash space", remarks: "# ", category: "Rent" },
      { name: "bare hash", remarks: "#", category: "Rent" },
      { name: "hash later", remarks: "paid #rent", category: "Rent" },
      { name: "Rent", category: "Rent" },
      { name: "dash tag", remarks: "#-", category: "Food" },
      { name: "cpp", category: "C++ (books)" },
      { name: "a.b", category: "a.b" },
      { name: "axb", category: "axb" },
      { name: "snacks nbsp", remarks: "# snacks" },
      { name: "missing" },
      { name: "null", category: null, remarks: null },
      { name: "blank", category: "   " },
      { name: "dash", category: "-" },
      { name: "dash and empty hash", remarks: "# ", category: " - " },
      { name: "typed Other", category: "Other" },
      { name: "salary", category: "Salary", type: "credit" },
      { name: "theirs", remarks: "#travel cab", category: "Food", userId: other },
      { name: "theirs blank", userId: other },
    ];
    await seed(rows);
    const mine = rows.filter((r) => r.userId === undefined);

    // Group the way the report will: case and spacing variants are one
    // category (decision 8), so "food " and "FOOD" share Food's rows.
    const labels = [...new Set(mine.map(labelOf))];
    expect(labels.length).toBeGreaterThan(10);

    for (const label of labels) {
      const key = categoryKey(label);
      const expected = mine
        .filter((r) => categoryKey(labelOf(r)) === key)
        .map((r) => r.name)
        .sort();
      // The label alone, "Other" included: the filter adds the fallback
      // bucket for it, so the client need not send `uncategorized` as well.
      const rows = await matched({ categories: [label] });
      expect({ label, rows }).toEqual({ label, rows: expected });
    }
  });
});
