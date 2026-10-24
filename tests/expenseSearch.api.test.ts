import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  auth,
  type TestUser,
} from "./helpers.js";

/**
 * Search and filters on the expense list (`GET /expenses`), over HTTP.
 *
 * The filter itself is tested without HTTP in expenseSearch.service.test.ts.
 * This file pins what the route adds on top: the query validation (a category
 * sent once or as repeated keys, the flags and amounts as URL strings), the
 * merge with the keyset cursor, the summary over every match, the user scope,
 * and that the normal month list is unchanged.
 *
 * Rows are added through the real API, so they are stored the way the app
 * stores them. Supertest sends no `tzOffsetMinutes`, so the server works in
 * UTC and "now" lands in the current UTC month.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
  await resetDb();
  clearMailbox();
  labels = new Map();
  alice = await registerUser(app, { name: "Alice" });
  bob = await registerUser(app, { name: "Bob" });
});

const EXPENSES = "/api/v1/expenses";
const as = (u: TestUser) => auth(u.accessToken);

type Body = Record<string, any>;

interface Seed {
  label: string;
  amount?: number;
  type?: "debit" | "credit";
  /** Left out of the request when undefined. */
  remarks?: string;
  /** Left out of the request when undefined. */
  category?: string;
  date?: string;
}

/** The label of every row seeded in the current test, by `_id`. */
let labels = new Map<string, string>();

let tick = 0;
/** A distinct, recent time in the current month; later calls are older. */
const recent = () => new Date(Date.now() - ++tick * 1000).toISOString();

/** Mid-month noon UTC, `back` months before the current UTC month. */
const monthsAgo = (back: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15, 12),
  ).toISOString();
};

const add = async (user: TestUser, s: Seed) => {
  const body: Body = {
    amount: s.amount ?? 10,
    date: s.date ?? recent(),
    type: s.type ?? "debit",
  };
  if (s.remarks !== undefined) body.remarks = s.remarks;
  if (s.category !== undefined) body.category = s.category;
  const res = await request(app).post(EXPENSES).set(as(user)).send(body).expect(201);
  labels.set(res.body.expense._id, s.label);
  return res.body.expense as { _id: string; ledgerId: string };
};

/** In order, so seed order is newest-first unless a row sets its date. */
const seed = async (user: TestUser, rows: Seed[]) => {
  const out = [];
  for (const row of rows) out.push(await add(user, row));
  return out;
};

const list = (user: TestUser, query: Body | string = {}) =>
  request(app).get(EXPENSES).set(as(user)).query(query);

/** The labels of the rows in a response, sorted. */
const labelsOf = (res: { body: Body }) =>
  (res.body.expenses as { _id: string }[]).map((e) => labels.get(e._id) ?? "?").sort();

/** Follow `nextCursor` to the end and return every page's body. */
const everyPage = async (user: TestUser, query: Body, limit: number) => {
  const pages: Body[] = [];
  let cursor: string | undefined;
  do {
    const res = await list(user, { ...query, limit, ...(cursor ? { cursor } : {}) }).expect(200);
    pages.push(res.body);
    cursor = res.body.nextCursor ?? undefined;
    if (pages.length > 20) throw new Error("pagination did not terminate");
  } while (cursor);
  return pages;
};

/** The field names of a 400's errors. */
const errorFields = (res: { body: Body }) =>
  (res.body.errors as { field: string }[]).map((e) => e.field);

describe("access", () => {
  it("requires a login, like the normal list", async () => {
    await request(app).get(EXPENSES).query({ q: "food" }).expect(401);
  });

  it("never returns another user's rows, even with their ledgerId", async () => {
    await seed(alice, [{ label: "alice-food", remarks: "pizza", category: "Food", amount: 10 }]);
    const [bobRow] = await seed(bob, [
      { label: "bob-food", remarks: "pizza", category: "Food", amount: 500 },
    ]);

    const res = await list(alice, { q: "pizza", category: "Food", includeSummary: true }).expect(200);
    expect(labelsOf(res)).toEqual(["alice-food"]);
    expect(res.body.summary).toEqual({ count: 1, debitTotal: 10, creditTotal: 0 });

    // Bob's month id narrows to that month, and the userId scope still holds.
    const theirs = await list(alice, { ledgerId: bobRow.ledgerId, q: "pizza" }).expect(200);
    expect(theirs.body.expenses).toEqual([]);
  });
});

describe("search text (q)", () => {
  it("matches the remarks or the category, ignoring case", async () => {
    await seed(alice, [
      { label: "pizza-remark", remarks: "Pizza night", category: "Food" },
      { label: "pizza-category", remarks: "dinner", category: "PIZZA Place" },
      { label: "rent", remarks: "October rent", category: "Home" },
      { label: "bare" },
    ]);

    expect(labelsOf(await list(alice, { q: "piz" }).expect(200))).toEqual([
      "pizza-category",
      "pizza-remark",
    ]);
    // Trimmed by the schema.
    expect(labelsOf(await list(alice, { q: "  pIzZa  " }).expect(200))).toEqual([
      "pizza-category",
      "pizza-remark",
    ]);
    expect(labelsOf(await list(alice, { q: "home" }).expect(200))).toEqual(["rent"]);
  });

  it("searches regex characters literally", async () => {
    await seed(alice, [
      { label: "literal", remarks: "a.*(b" },
      { label: "lookalike", remarks: "axxb" },
      { label: "paren", remarks: "(work) lunch" },
    ]);

    expect(labelsOf(await list(alice, { q: ".*(" }).expect(200))).toEqual(["literal"]);
    expect(labelsOf(await list(alice, { q: "(work)" }).expect(200))).toEqual(["paren"]);
  });
});

describe("type", () => {
  it("returns money out or money in only", async () => {
    await seed(alice, [
      { label: "out", type: "debit" },
      { label: "in", type: "credit" },
      { label: "out-2", type: "debit" },
    ]);

    expect(labelsOf(await list(alice, { type: "credit" }).expect(200))).toEqual(["in"]);
    expect(labelsOf(await list(alice, { type: "debit" }).expect(200))).toEqual(["out", "out-2"]);
  });
});

describe("categories", () => {
  const seedCategories = () =>
    seed(alice, [
      { label: "food", category: "Food" },
      { label: "food-lower", category: "food" },
      { label: "food-court", category: "Food Court" },
      { label: "gym", category: "Gym" },
      // The #tag wins over the category field, as in the report.
      { label: "tag-gym", remarks: "#Gym", category: "Food" },
      { label: "rent", category: "Rent" },
    ]);

  it("accepts one category as a plain string", async () => {
    await seedCategories();
    const res = await list(alice, { category: "Food" }).expect(200);
    expect(labelsOf(res)).toEqual(["food", "food-lower"]);
  });

  it("accepts several categories as repeated keys", async () => {
    await seedCategories();

    // Supertest serialises an array as repeated keys (qs, `indices: false`),
    // the same form the app sends.
    const res = await list(alice, { category: ["Food", "Gym"] }).expect(200);
    expect((res as unknown as { req: { path: string } }).req.path).toContain(
      "category=Food&category=Gym",
    );
    expect(labelsOf(res)).toEqual(["food", "food-lower", "gym", "tag-gym"]);

    const raw = await list(alice, "category=Food&category=Gym").expect(200);
    expect(labelsOf(raw)).toEqual(["food", "food-lower", "gym", "tag-gym"]);
  });

  it("finds a #tag category longer than the category field's 50 characters", async () => {
    const tag = "long tag ".repeat(15).trim(); // 134 characters
    await seed(alice, [
      { label: "long", remarks: `#${tag}` },
      { label: "short", remarks: "#long tag" },
    ]);
    expect(labelsOf(await list(alice, { category: tag }).expect(200))).toEqual(["long"]);
  });

  it("selects the report's \"Other\" rows with uncategorized", async () => {
    await seed(alice, [
      { label: "blank", category: "" },
      { label: "dash", category: "-" },
      { label: "missing" },
      { label: "food", category: "Food" },
      { label: "other", category: "Other" },
      { label: "tagged", remarks: "#travel", category: "" },
    ]);

    expect(labelsOf(await list(alice, { uncategorized: true }).expect(200))).toEqual([
      "blank",
      "dash",
      "missing",
    ]);
    // "false" is no filter at all: the normal list.
    expect(labelsOf(await list(alice, { uncategorized: "false" }).expect(200))).toEqual([
      "blank",
      "dash",
      "food",
      "missing",
      "other",
      "tagged",
    ]);
  });

  it("ORs category \"Other\" with uncategorized: blank, \"-\" and literal \"Other\"", async () => {
    await seed(alice, [
      { label: "blank", category: "" },
      { label: "dash", category: "-" },
      { label: "missing" },
      { label: "food", category: "Food" },
      { label: "other", category: "Other" },
    ]);

    const res = await list(alice, { category: "Other", uncategorized: "true" }).expect(200);
    expect(labelsOf(res)).toEqual(["blank", "dash", "missing", "other"]);
  });
});

describe("amount range", () => {
  it("is inclusive at both ends", async () => {
    await seed(alice, [50, 100, 150, 200, 250].map((amount) => ({ label: `a${amount}`, amount })));

    expect(labelsOf(await list(alice, { minAmount: 100, maxAmount: 200 }).expect(200))).toEqual([
      "a100",
      "a150",
      "a200",
    ]);
    expect(labelsOf(await list(alice, { minAmount: "200" }).expect(200))).toEqual(["a200", "a250"]);
    expect(labelsOf(await list(alice, { maxAmount: "50" }).expect(200))).toEqual(["a50"]);
    expect(labelsOf(await list(alice, { minAmount: 150, maxAmount: 150 }).expect(200))).toEqual([
      "a150",
    ]);
  });
});

describe("months", () => {
  it("ledgerId is this month only; without it, every month", async () => {
    const [nowFood] = await seed(alice, [
      { label: "now-food", category: "Food" },
      { label: "old-food", category: "Food", date: monthsAgo(2) },
      { label: "now-gym", category: "Gym" },
    ]);

    const month = await list(alice, { ledgerId: nowFood.ledgerId, category: "Food" }).expect(200);
    expect(labelsOf(month)).toEqual(["now-food"]);

    const all = await list(alice, { category: "Food" }).expect(200);
    expect(labelsOf(all)).toEqual(["now-food", "old-food"]);
  });
});

describe("paging and the summary", () => {
  it("returns every match exactly once across cursor pages", async () => {
    // One shared timestamp, so the cursor's _id tie-break does the work, with
    // non-matching rows interleaved.
    const sameTime = new Date(Date.now() - 3600_000).toISOString();
    const rows: Seed[] = [];
    for (let i = 0; i < 13; i++) {
      rows.push({ label: `food-${i}`, category: "Food", date: sameTime, amount: i + 1 });
      if (i % 2 === 0) rows.push({ label: `gym-${i}`, category: "Gym", date: sameTime });
    }
    const seeded = await seed(alice, rows);
    const foodIds = seeded.filter((r) => labels.get(r._id)!.startsWith("food-")).map((r) => r._id);

    const pages = await everyPage(alice, { category: "Food" }, 4);
    const ids = pages.flatMap((p) => (p.expenses as { _id: string }[]).map((e) => e._id));

    expect(pages).toHaveLength(4);
    expect(ids).toHaveLength(13);
    expect(new Set(ids).size).toBe(13);
    expect([...ids].sort()).toEqual([...foodIds].sort());
    expect(pages.at(-1)!.hasMore).toBe(false);
  });

  it("totals every match, ignoring the cursor", async () => {
    await seed(alice, [
      { label: "f1", category: "Food", type: "debit", amount: 10.25 },
      { label: "g1", category: "Gym", type: "debit", amount: 1000 },
      { label: "f2", category: "Food", type: "credit", amount: 5.5 },
      { label: "f3", category: "Food", type: "debit", amount: 20 },
      { label: "f4", category: "Food", type: "credit", amount: 100 },
      { label: "f5", category: "food", type: "debit", amount: 0.1 },
    ]);
    await seed(bob, [{ label: "bob", category: "Food", amount: 999 }]);

    const pages = await everyPage(alice, { category: "Food", includeSummary: true }, 2);
    expect(pages).toHaveLength(3);

    const rows = pages.flatMap((p) => p.expenses as { type: string; amount: number }[]);
    const sum = (type: string) =>
      Math.round(rows.filter((r) => r.type === type).reduce((s, r) => s + r.amount, 0) * 100) / 100;
    const expected = { count: 5, debitTotal: 30.35, creditTotal: 105.5 };

    expect({ count: rows.length, debitTotal: sum("debit"), creditTotal: sum("credit") }).toEqual(
      expected,
    );
    // Pages 2 and 3 carry a cursor; their summary is still every match.
    for (const page of pages) expect(page.summary).toEqual(expected);
  });

  it("returns a zero summary when nothing matches", async () => {
    await seed(alice, [{ label: "food", category: "Food" }]);
    const res = await list(alice, { q: "nothing like this", includeSummary: "true" }).expect(200);
    expect(res.body.expenses).toEqual([]);
    expect(res.body.summary).toEqual({ count: 0, debitTotal: 0, creditTotal: 0 });
  });
});

/**
 * Express 5 rebuilds `req.query` on every read, so validate() cannot hand the
 * handler its parsed values; the handler parses the query itself. These pin
 * that it reads numbers and arrays, not the raw URL strings ("5" + 1 is "51").
 */
describe("the parsed query reaches the handler", () => {
  it("limit=5 returns at most 5 rows, with a single category=Food", async () => {
    const rows: Seed[] = [];
    for (let i = 0; i < 7; i++) rows.push({ label: `food-${i}`, category: "Food" });
    rows.push({ label: "gym", category: "Gym" });
    await seed(alice, rows);

    const res = await list(alice, "category=Food&limit=5").expect(200);
    expect(res.body.expenses).toHaveLength(5);
    expect(labelsOf(res).every((l) => l.startsWith("food-"))).toBe(true);
    expect(res.body.hasMore).toBe(true);

    const rest = await list(alice, { category: "Food", limit: 5, cursor: res.body.nextCursor });
    expect(rest.status).toBe(200);
    expect(labelsOf(rest).every((l) => l.startsWith("food-"))).toBe(true);
    expect(rest.body.expenses).toHaveLength(2);
    expect(rest.body.hasMore).toBe(false);
  });

  it("applies the default limit of 20 when none is sent", async () => {
    const rows: Seed[] = [];
    for (let i = 0; i < 22; i++) rows.push({ label: `e${i}` });
    await seed(alice, rows);

    const res = await list(alice).expect(200);
    expect(res.body.expenses).toHaveLength(20);
    expect(res.body.hasMore).toBe(true);
  });
});

describe("validation", () => {
  it("rejects maxAmount below minAmount", async () => {
    const res = await list(alice, { minAmount: 200, maxAmount: 100 }).expect(400);
    expect(res.body.errors).toContainEqual({
      field: "maxAmount",
      message: "maxAmount must be at least minAmount",
    });
  });

  it("rejects a search over 50 characters", async () => {
    await list(alice, { q: "x".repeat(50) }).expect(200);
    const res = await list(alice, { q: "x".repeat(51) }).expect(400);
    expect(errorFields(res)).toContain("q");
  });

  it("rejects more than 10 categories, or one over 200 characters", async () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `Cat ${i}`);
    await list(alice, { category: names(10) }).expect(200);
    expect(errorFields(await list(alice, { category: names(11) }).expect(400))).toContain(
      "category",
    );
    // A report category can be a long #tag, so names past the field's 50 pass.
    await list(alice, { category: "c".repeat(200) }).expect(200);
    await list(alice, { category: "c".repeat(201) }).expect(400);
  });

  it("rejects a bad type, a negative or non-numeric amount, and a bad flag", async () => {
    expect(errorFields(await list(alice, { type: "both" }).expect(400))).toContain("type");
    expect(errorFields(await list(alice, { minAmount: -1 }).expect(400))).toContain("minAmount");
    expect(errorFields(await list(alice, { maxAmount: "abc" }).expect(400))).toContain(
      "maxAmount",
    );
    expect(errorFields(await list(alice, { includeSummary: "maybe" }).expect(400))).toContain(
      "includeSummary",
    );
  });
});

describe("the normal list", () => {
  it("is unchanged without filters: same keys, no summary", async () => {
    const [first] = await seed(alice, [
      { label: "e1", category: "Food" },
      { label: "e2", remarks: "#gym" },
      { label: "e3" },
    ]);

    for (const query of [{}, { ledgerId: first.ledgerId }, { includeSummary: false }]) {
      const res = await list(alice, query).expect(200);
      expect(Object.keys(res.body).sort()).toEqual(["expenses", "hasMore", "nextCursor", "success"]);
      // Newest first, as before.
      expect(res.body.expenses.map((e: { _id: string }) => labels.get(e._id))).toEqual([
        "e1",
        "e2",
        "e3",
      ]);
      expect(res.body.hasMore).toBe(false);
      expect(res.body.nextCursor).toBeNull();
    }
  });

  it("adds a summary of the whole list when asked", async () => {
    await seed(alice, [
      { label: "e1", amount: 30 },
      { label: "e2", amount: 12.5, type: "credit" },
    ]);
    const res = await list(alice, { includeSummary: true, limit: 1 }).expect(200);
    expect(res.body.expenses).toHaveLength(1);
    expect(res.body.summary).toEqual({ count: 2, debitTotal: 30, creditTotal: 12.5 });
  });
});
