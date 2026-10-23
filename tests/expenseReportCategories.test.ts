import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
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
import { Expense } from "../src/models/expenseModel.js";
import { ExpenseLedger } from "../src/models/expenseLedgerModel.js";
import {
  expenseCategoryKeyOf,
  groupByCategory,
} from "../src/services/expenseReport/category.js";

/**
 * T-014 S2: report categories merge case and spacing variants ("Food",
 * "food " and "FOOD" are one category, named by the most-used spelling) in the
 * breakdown, the trend and the PDF, and categoryTrend covers every category.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
});

type Row = Partial<{
  amount: number;
  type: "debit" | "credit";
  date: string;
  remarks: string;
  category: string;
  ledgerId: mongoose.Types.ObjectId;
}>;

/**
 * Raw insert, bypassing the schema's trim, so "food " really is stored with
 * its trailing space (as legacy rows are).
 */
const insert = (over: Row) =>
  Expense.collection.insertOne({
    userId: new mongoose.Types.ObjectId(alice.id),
    ledgerId: new mongoose.Types.ObjectId(),
    amount: 100,
    type: "debit",
    ...over,
    date: new Date(over.date ?? "2026-10-10T06:00:00Z"),
  });

const stats = async (query: Record<string, string | number>) => {
  const res = await request(app)
    .get("/api/v1/expenses/advanced-stats")
    .set(auth(alice.accessToken))
    .query(query)
    .expect(200);
  return res.body.data;
};

type Breakdown = { name: string; total: number; count: number; percentage: number };
type Trend = { name: string; months: { month: string; total: number }[] };

describe("expenseCategoryKeyOf (unit)", () => {
  it("trims, collapses inner spaces and lowercases the report category", () => {
    expect(expenseCategoryKeyOf({ category: "  Food " })).toBe("food");
    expect(expenseCategoryKeyOf({ category: "FOOD" })).toBe("food");
    expect(expenseCategoryKeyOf({ category: "Eating   Out" })).toBe("eating out");
    expect(expenseCategoryKeyOf({ category: "Food", remarks: "#Travel   Cab" })).toBe(
      "travel cab",
    );
    expect(expenseCategoryKeyOf({})).toBe("other");
    expect(expenseCategoryKeyOf({ category: "-" })).toBe("other");
  });
});

describe("groupByCategory (unit)", () => {
  it("merges variants and names the group by its most-used spelling", () => {
    const groups = groupByCategory([
      { amount: 10, category: "Food" },
      { amount: 20, category: "food " },
      { amount: 30, category: "FOOD" },
      { amount: 5, category: "food" },
      { amount: 7, category: "Rent" },
    ]);
    expect(groups).toEqual([
      { key: "food", name: "food", total: 65, count: 4 },
      { key: "rent", name: "Rent", total: 7, count: 1 },
    ]);
  });

  it("breaks a spelling tie in favour of the one seen first", () => {
    expect(
      groupByCategory([
        { amount: 1, category: "FOOD" },
        { amount: 1, category: "Food" },
      ])[0].name,
    ).toBe("FOOD");
    expect(
      groupByCategory([
        { amount: 1, category: "Food" },
        { amount: 1, category: "FOOD" },
      ])[0].name,
    ).toBe("Food");
  });

  it("sorts by total, largest first", () => {
    const groups = groupByCategory([
      { amount: 5, category: "a" },
      { amount: 50, category: "b" },
      { amount: 20, category: "c" },
    ]);
    expect(groups.map((g) => g.name)).toEqual(["b", "c", "a"]);
  });

  it("groups #tag rows under the tag", () => {
    const groups = groupByCategory([
      { amount: 40, category: "Food", remarks: "#Travel" },
      { amount: 60, category: "travel" },
      { amount: 25, category: "Food", remarks: "#travel  cab" },
    ]);
    expect(groups).toEqual([
      { key: "travel", name: "Travel", total: 100, count: 2 },
      { key: "travel cab", name: "travel  cab", total: 25, count: 1 },
    ]);
  });

  it("keeps 'Other' as 'Other'", () => {
    const groups = groupByCategory([
      { amount: 1, category: "other" },
      { amount: 1, category: "other" },
      { amount: 1, category: "-" },
      { amount: 1 },
    ]);
    expect(groups).toEqual([{ key: "other", name: "Other", total: 4, count: 4 }]);
  });

  it("accepts a custom label function", () => {
    const groups = groupByCategory(
      [
        { amount: 3, label: "Gym" },
        { amount: 4, label: "gym" },
        { amount: 5, label: "gym" },
      ],
      (r) => r.label,
    );
    expect(groups).toEqual([{ key: "gym", name: "gym", total: 12, count: 3 }]);
  });
});

describe("getAdvancedStats: merged categories", () => {
  it("merges 'Food', 'food ' and 'FOOD' into one breakdown row", async () => {
    await insert({ amount: 100, category: "Food", date: "2026-10-02T06:00:00Z" });
    await insert({ amount: 50, category: "food ", date: "2026-10-03T06:00:00Z" });
    await insert({ amount: 25, category: "FOOD", date: "2026-10-04T06:00:00Z" });
    await insert({ amount: 10, category: "Food", date: "2026-10-05T06:00:00Z" });
    await insert({ amount: 15, category: "Rent", date: "2026-10-06T06:00:00Z" });

    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryBreakdown).toEqual([
      { name: "Food", total: 185, count: 4, percentage: 92.5 },
      { name: "Rent", total: 15, count: 1, percentage: 7.5 },
    ]);
  });

  it("merges variants per month in the trend", async () => {
    await insert({ amount: 30, category: "FOOD", date: "2026-08-05T06:00:00Z" });
    await insert({ amount: 20, category: "food", date: "2026-08-06T06:00:00Z" });
    await insert({ amount: 40, category: "food ", date: "2026-09-05T06:00:00Z" });
    await insert({ amount: 100, category: "Food", date: "2026-10-05T06:00:00Z" });
    await insert({ amount: 5, category: "Food", date: "2026-10-06T06:00:00Z" });
    await insert({ amount: 7, category: "food", date: "2026-10-07T06:00:00Z" });

    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryBreakdown.map((c: Breakdown) => c.name)).toEqual(["Food"]);
    expect(d.categoryTrend).toEqual([
      {
        name: "Food",
        months: [
          { month: "2026-08", total: 50 },
          { month: "2026-09", total: 40 },
          { month: "2026-10", total: 112 },
        ],
      },
    ]);
  });

  it("sends a trend row for every breakdown row", async () => {
    for (let i = 0; i < 9; i++) {
      await insert({ amount: 10 + i, category: `c${i}`, date: "2026-10-05T06:00:00Z" });
    }
    // A variant of c0 in an earlier month only feeds c0's trend.
    await insert({ amount: 3, category: "C0", date: "2026-09-05T06:00:00Z" });

    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryBreakdown).toHaveLength(9);
    expect(d.categoryTrend).toHaveLength(9);
    expect(d.categoryTrend.map((t: Trend) => t.name)).toEqual(
      d.categoryBreakdown.map((c: Breakdown) => c.name),
    );
    const c0 = d.categoryTrend.find((t: Trend) => t.name === "c0");
    expect(c0.months).toEqual([
      { month: "2026-08", total: 0 },
      { month: "2026-09", total: 3 },
      { month: "2026-10", total: 10 },
    ]);
  });

  it("groups #tag rows under the tag and keeps 'Other' as 'Other'", async () => {
    await insert({ amount: 80, category: "Food", remarks: "#Travel" });
    await insert({ amount: 20, category: "travel" });
    await insert({ amount: 30, category: "Travel", remarks: "cab" });
    await insert({ amount: 10, category: "other" });
    await insert({ amount: 10, category: "-" });
    await insert({ amount: 10 });

    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryBreakdown.map((c: Breakdown) => [c.name, c.total, c.count])).toEqual([
      ["Travel", 130, 3],
      ["Other", 30, 3],
    ]);
    expect(d.categoryTrend.map((t: Trend) => t.name)).toEqual(["Travel", "Other"]);
  });

  it("names top5 categories by the merged group", async () => {
    await insert({ amount: 500, category: "FOOD", date: "2026-10-02T06:00:00Z" });
    await insert({ amount: 10, category: "Food", date: "2026-10-03T06:00:00Z" });
    await insert({ amount: 10, category: "Food", date: "2026-10-04T06:00:00Z" });
    await insert({ amount: 5, remarks: "#gym", date: "2026-10-05T06:00:00Z" });

    const d = await stats({ year: 2026, month: 10 });
    expect(d.top5Expenses.map((e: { category: string }) => e.category)).toEqual([
      "Food",
      "Food",
      "Food",
      "gym",
    ]);
  });
});

describe("Expense PDF export: merged categories", () => {
  const addExpense = async (body: Record<string, unknown>) =>
    request(app)
      .post("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .send({ tzOffsetMinutes: 330, ...body })
      .expect(201);

  const exportHtml = async (): Promise<string> => {
    const ledger = await ExpenseLedger.findOne({ userId: alice.id });
    const res = await request(app)
      .get(`/api/v1/expenses/export?ledgerId=${String(ledger!._id)}`)
      .set(auth(alice.accessToken))
      .expect(200);
    return res.body.html as string;
  };

  it("shows one merged row named by the most-used spelling", async () => {
    await addExpense({ amount: 100, date: "2026-10-02T06:00:00.000Z", category: "Food" });
    await addExpense({ amount: 50, date: "2026-10-03T06:00:00.000Z", category: "FOOD" });
    await addExpense({ amount: 25, date: "2026-10-04T06:00:00.000Z", category: "Food" });
    await addExpense({ amount: 25, date: "2026-10-05T06:00:00.000Z", category: "Rent" });
    const ledger = await ExpenseLedger.findOne({ userId: alice.id });
    await insert({
      amount: 200,
      category: "food ",
      date: "2026-10-06T06:00:00Z",
      ledgerId: ledger!._id,
    });

    const html = await exportHtml();
    const rows = [
      ...html.matchAll(/<tr data-cat="([^"]*)" data-pct="([\d.]+)">[\s\S]*?<td class="num">(\d+)<\/td>/g),
    ].map((m) => [m[1], Number(m[2]), Number(m[3])]);
    expect(rows).toEqual([
      ["Food", 93.8, 4],
      ["Rent", 6.3, 1],
    ]);
    // The top 5 list names the merged group as well.
    expect(html).toContain('<div class="top-meta">Food ·');
    expect(html).not.toMatch(/<div class="top-meta">(food|FOOD) /);
  });

  it("names a tied group by its oldest spelling, the same as the screen", async () => {
    // Saved newest first, so neither insertion order nor the PDF's newest-first
    // query decides the name.
    await addExpense({ amount: 10, date: "2026-10-03T06:00:00.000Z", category: "Food" });
    await addExpense({ amount: 10, date: "2026-10-02T06:00:00.000Z", category: "FOOD" });

    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryBreakdown.map((c: Breakdown) => c.name)).toEqual(["FOOD"]);
    expect([...(await exportHtml()).matchAll(/data-cat="([^"]*)"/g)].map((m) => m[1])).toEqual([
      "FOOD",
    ]);
  });
});
