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
import { expenseCategoryOf } from "../src/services/expenseReport/category.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app);
});

const insert = (
  over: Partial<{
    amount: number;
    type: "debit" | "credit";
    date: string;
    remarks: string;
    category: string;
  }>,
) =>
  Expense.create({
    userId: new mongoose.Types.ObjectId(alice.id),
    ledgerId: new mongoose.Types.ObjectId(),
    amount: 100,
    type: "debit",
    date: new Date("2026-10-10T06:00:00Z"),
    ...over,
    ...(over.date ? { date: new Date(over.date) } : {}),
  });

const stats = async (query: Record<string, string | number>) => {
  const res = await request(app)
    .get("/api/v1/expenses/advanced-stats")
    .set(auth(alice.accessToken))
    .query(query)
    .expect(200);
  return res.body.data;
};

describe("getAdvancedStats: timezone-correct boundaries", () => {
  it("counts 2026-09-30T19:00Z in October for IST and in September for UTC", async () => {
    await insert({ amount: 250, date: "2026-09-30T19:00:00Z" });

    const ist = await stats({ year: 2026, month: 10, tzOffsetMinutes: 330 });
    expect(ist.summary.totalDebits).toBe(250);
    expect(ist.dailyBreakdown.map((d: { date: string }) => d.date)).toEqual([
      "2026-10-01",
    ]);

    const istSep = await stats({ year: 2026, month: 9, tzOffsetMinutes: 330 });
    expect(istSep.summary.totalDebits).toBe(0);

    const utc = await stats({ year: 2026, month: 9, tzOffsetMinutes: 0 });
    expect(utc.summary.totalDebits).toBe(250);
    expect(utc.dailyBreakdown[0].date).toBe("2026-09-30");

    const utcOct = await stats({ year: 2026, month: 10 });
    expect(utcOct.summary.totalDebits).toBe(0);
  });

  it("buckets the monthly trend in the user's local month", async () => {
    await insert({ amount: 40, date: "2026-09-30T19:00:00Z" });
    const ist = await stats({ year: 2026, month: 10, tzOffsetMinutes: 330 });
    const oct = ist.monthlyTrend.find(
      (m: { month: string }) => m.month === "2026-10",
    );
    expect(oct.debitTotal).toBe(40);
    expect(
      ist.monthlyTrend.find((m: { month: string }) => m.month === "2026-09"),
    ).toBeUndefined();
  });
});

describe("getAdvancedStats: categoryTrend", () => {
  it("returns top categories with 3 zero-filled months", async () => {
    await insert({ amount: 300, category: "food", date: "2026-10-05T06:00:00Z" });
    await insert({ amount: 100, category: "food", date: "2026-08-05T06:00:00Z" });
    await insert({ amount: 50, category: "rent", date: "2026-09-05T06:00:00Z" });
    await insert({ amount: 20, category: "gym", date: "2026-10-06T06:00:00Z" });
    await insert({ amount: 999, type: "credit", category: "food", date: "2026-10-07T06:00:00Z" });

    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryTrend.map((c: { name: string }) => c.name)).toEqual([
      "food",
      "gym",
    ]);
    const food = d.categoryTrend[0];
    expect(food.months).toEqual([
      { month: "2026-08", total: 100 },
      { month: "2026-09", total: 0 },
      { month: "2026-10", total: 300 },
    ]);
    expect(d.categoryTrend[1].months).toEqual([
      { month: "2026-08", total: 0 },
      { month: "2026-09", total: 0 },
      { month: "2026-10", total: 20 },
    ]);
  });

  it("wraps across the year boundary and caps at 7 categories", async () => {
    for (let i = 0; i < 9; i++) {
      await insert({ amount: 10 + i, category: `c${i}`, date: "2026-01-05T06:00:00Z" });
    }
    const d = await stats({ year: 2026, month: 1 });
    expect(d.categoryTrend).toHaveLength(7);
    expect(d.categoryTrend[0].months.map((m: { month: string }) => m.month)).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
    ]);
  });

  it("applies the #tag rule from remarks", async () => {
    await insert({ amount: 80, category: "misc", remarks: "#travel", date: "2026-10-05T06:00:00Z" });
    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryTrend[0].name).toBe("travel");
    expect(d.categoryBreakdown[0].name).toBe("travel");
  });

  it("falls back to the category when the #tag is empty", async () => {
    // Bypass the schema's trim so the stored remark really is "#   " (legacy rows).
    await Expense.collection.insertOne({
      userId: new mongoose.Types.ObjectId(alice.id),
      ledgerId: new mongoose.Types.ObjectId(),
      amount: 60,
      type: "debit",
      category: "food",
      remarks: "#   ",
      date: new Date("2026-10-05T06:00:00Z"),
    });
    const d = await stats({ year: 2026, month: 10 });
    expect(d.categoryBreakdown.map((c: { name: string }) => c.name)).toEqual(["food"]);
    expect(d.categoryTrend[0].name).toBe("food");
  });

  it("uses local-month bucketing for the trend points", async () => {
    await insert({ amount: 70, category: "food", date: "2026-09-30T19:00:00Z" });
    const d = await stats({ year: 2026, month: 10, tzOffsetMinutes: 330 });
    expect(d.categoryTrend[0].months[2]).toEqual({ month: "2026-10", total: 70 });
  });
});

describe("getAdvancedStats: top5 resolved category", () => {
  it("resolves category via expenseCategoryOf (tag, fallback, Other)", async () => {
    await insert({ amount: 500, category: "food", remarks: "#travel", date: "2026-10-05T06:00:00Z" });
    await insert({ amount: 400, category: "rent", remarks: "monthly", date: "2026-10-06T06:00:00Z" });
    await Expense.collection.insertOne({
      userId: new mongoose.Types.ObjectId(alice.id),
      ledgerId: new mongoose.Types.ObjectId(),
      amount: 300,
      type: "debit",
      remarks: "no category",
      date: new Date("2026-10-07T06:00:00Z"),
    });
    const d = await stats({ year: 2026, month: 10 });
    expect(
      d.top5Expenses.map((e: { category: string }) => e.category),
    ).toEqual(["travel", "rent", "Other"]);
  });
});

describe("expenseCategoryOf", () => {
  it("follows the existing breakdown rule", () => {
    expect(expenseCategoryOf({ category: "food", remarks: "" })).toBe("food");
    expect(expenseCategoryOf({ category: "-", remarks: "" })).toBe("Other");
    expect(expenseCategoryOf({})).toBe("Other");
    expect(expenseCategoryOf({ category: "food", remarks: "# trip" })).toBe("trip");
    expect(expenseCategoryOf({ category: "food", remarks: "lunch #x" })).toBe("food");
  });
});

describe("getAdvancedStats: existing contract", () => {
  it("includes type on top5 and keeps every existing field", async () => {
    await insert({ amount: 500, category: "food", remarks: "big", date: "2026-10-05T06:00:00Z" });
    await insert({ amount: 30, type: "credit", date: "2026-10-06T06:00:00Z" });
    const d = await stats({ year: 2026, month: 10 });

    for (const k of [
      "selectedLedger",
      "selectedMonth",
      "summary",
      "monthlyTrend",
      "dailyBreakdown",
      "categoryBreakdown",
      "top5Expenses",
      "categoryTrend",
    ]) {
      expect(d).toHaveProperty(k);
    }
    expect(d.selectedMonth).toEqual({ year: 2026, month: 10 });
    expect(Object.keys(d.summary).sort()).toEqual(
      [
        "activeDays",
        "avgDailyCredit",
        "avgDailyDebit",
        "creditCount",
        "debitCount",
        "net",
        "totalCredits",
        "totalDebits",
      ].sort(),
    );
    expect(d.top5Expenses[0]).toMatchObject({
      amount: 500,
      remarks: "big",
      category: "food",
      type: "debit",
    });
    expect(d.top5Expenses[0]).toHaveProperty("_id");
    expect(d.top5Expenses[0]).toHaveProperty("date");
    expect(d.summary.avgDailyDebit).toBe(Math.round((500 / 31) * 100) / 100);
  });
});
