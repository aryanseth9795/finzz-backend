import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import "./mailbox.js";
import app from "../src/app.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  adminCookie,
  registerUser,
  type TestUser,
} from "./helpers.js";
import { Expense } from "../src/models/expenseModel.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDb();
  alice = await registerUser(app, { name: "Alice" });
  cookie = await adminCookie(app);
});

type Row = {
  amount: number;
  type?: "debit" | "credit";
  date?: Date;
  category?: string;
  userId?: string;
};

const insert = (r: Row) =>
  Expense.create({
    userId: new mongoose.Types.ObjectId(r.userId ?? alice.id),
    ledgerId: new mongoose.Types.ObjectId(),
    amount: r.amount,
    type: r.type ?? "debit",
    date: r.date ?? new Date(),
    ...(r.category !== undefined ? { category: r.category } : {}),
  });

/** A pre-`type` row: written raw so the schema default is not applied. */
const insertLegacy = (r: Omit<Row, "type">) =>
  Expense.collection.insertOne({
    userId: new mongoose.Types.ObjectId(r.userId ?? alice.id),
    ledgerId: new mongoose.Types.ObjectId(),
    amount: r.amount,
    date: r.date ?? new Date(),
    ...(r.category !== undefined ? { category: r.category } : {}),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

const listExpenses = (query: Record<string, string | number> = {}) =>
  request(app).get("/api/v1/admin/expenses").set("Cookie", cookie).query(query);

describe("GET /admin/expenses totals", () => {
  it("splits debits and credits; byCategory is debits only", async () => {
    await insert({ amount: 100, category: "Food" });
    await insert({ amount: 50, category: "Food" });
    await insert({ amount: 30, category: "Travel" });
    await insert({ amount: 1000, type: "credit", category: "Salary" });
    await insert({ amount: 200, type: "credit", category: "Food" });

    const res = await listExpenses().expect(200);

    // Rows and pagination still cover both types.
    expect(res.body.expenses).toHaveLength(5);
    expect(res.body.pagination.total).toBe(5);

    const t = res.body.totals;
    expect(t.totalAmount).toBe(180);
    expect(t.totalCredits).toBe(1200);
    expect(t.count).toBe(5);
    expect(t.debitCount).toBe(3);
    expect(t.creditCount).toBe(2);
    expect(t.byCategory).toEqual([
      { name: "Food", total: 150, count: 2 },
      { name: "Travel", total: 30, count: 1 },
    ]);
  });

  it("counts a legacy row with no type as a debit", async () => {
    await insertLegacy({ amount: 70, category: "Food" });
    await insert({ amount: 500, type: "credit" });

    const t = (await listExpenses().expect(200)).body.totals;
    expect(t.totalAmount).toBe(70);
    expect(t.totalCredits).toBe(500);
    expect(t.debitCount).toBe(1);
    expect(t.creditCount).toBe(1);
    expect(t.count).toBe(2);
    expect(t.byCategory).toEqual([{ name: "Food", total: 70, count: 1 }]);
  });

  it("groups missing, null and empty categories as Uncategorised", async () => {
    await insert({ amount: 10 });
    await insert({ amount: 20, category: "" });
    await insertLegacy({ amount: 5 });

    const t = (await listExpenses().expect(200)).body.totals;
    expect(t.byCategory).toEqual([{ name: "Uncategorised", total: 35, count: 3 }]);
  });

  it("returns zeroes when nothing matches", async () => {
    const t = (await listExpenses().expect(200)).body.totals;
    expect(t).toEqual({
      totalAmount: 0,
      totalCredits: 0,
      count: 0,
      debitCount: 0,
      creditCount: 0,
      byCategory: [],
    });
  });
});

describe("GET /admin/expenses date filter", () => {
  beforeEach(async () => {
    await insert({ amount: 1, date: new Date("2026-03-04T23:59:59Z") });
    await insert({ amount: 2, date: new Date("2026-03-05T00:00:00Z") });
    await insert({ amount: 4, date: new Date("2026-03-10T18:00:00Z") });
    await insert({ amount: 8, date: new Date("2026-03-10T23:59:59.999Z") });
    await insert({ amount: 16, date: new Date("2026-03-11T00:00:00Z") });
  });

  it("includes the whole endDate day and starts at startDate midnight UTC", async () => {
    const res = await listExpenses({
      startDate: "2026-03-05",
      endDate: "2026-03-10",
    }).expect(200);
    expect(res.body.totals.totalAmount).toBe(2 + 4 + 8);
    expect(res.body.totals.count).toBe(3);
    expect(res.body.pagination.total).toBe(3);
  });

  it("accepts a single-day range", async () => {
    const res = await listExpenses({
      startDate: "2026-03-10",
      endDate: "2026-03-10",
    }).expect(200);
    expect(res.body.totals.totalAmount).toBe(12);
  });

  it("accepts startDate or endDate alone", async () => {
    const from = await listExpenses({ startDate: "2026-03-11" }).expect(200);
    expect(from.body.totals.totalAmount).toBe(16);
    const to = await listExpenses({ endDate: "2026-03-04" }).expect(200);
    expect(to.body.totals.totalAmount).toBe(1);
  });

  it.each([
    ["startDate", "2026-02-30"],
    ["startDate", "abc"],
    ["endDate", "2026-03-10T00:00:00Z"],
    ["endDate", "2026-3-10"],
    ["endDate", "2026-13-01"],
  ])("rejects %s=%s with 400", async (key, value) => {
    const res = await listExpenses({ [key]: value }).expect(400);
    expect(res.body.message).toBe("Validation error");
    expect(res.body.errors[0].field).toBe(key);
  });

  it("rejects startDate after endDate on endDate", async () => {
    const res = await listExpenses({
      startDate: "2026-03-11",
      endDate: "2026-03-10",
    }).expect(400);
    expect(res.body.message).toBe("Validation error");
    expect(res.body.errors).toEqual([
      { field: "endDate", message: "End date must be on or after start date" },
    ]);
  });

  it("still rejects limit above 200", async () => {
    const res = await listExpenses({ limit: 201 }).expect(400);
    expect(res.body.message).toBe("Validation error");
  });
});

describe("GET /admin/dashboard expense figures", () => {
  it("counts debits only in expense figures and reports credits separately", async () => {
    await insert({ amount: 100, category: "Food" });
    await insertLegacy({ amount: 40, category: "Food", date: new Date() });
    await insert({ amount: 1000, type: "credit", category: "Salary" });

    const res = await request(app)
      .get("/api/v1/admin/dashboard")
      .set("Cookie", cookie)
      .expect(200);
    const s = res.body.stats;

    expect(s.totalExpenses).toBe(3);
    expect(s.grandTotalExpense).toBe(140);
    expect(s.grandTotalCredit).toBe(1000);

    const monthTotal = s.monthlyExpenses.reduce(
      (sum: number, m: { total: number }) => sum + m.total,
      0,
    );
    expect(monthTotal).toBe(140);
    expect(s.categoryData).toEqual([{ name: "Food", value: 140, count: 2 }]);
  });

  it("reports zero totals with no expenses", async () => {
    const res = await request(app)
      .get("/api/v1/admin/dashboard")
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.stats.grandTotalExpense).toBe(0);
    expect(res.body.stats.grandTotalCredit).toBe(0);
  });
});

describe("GET /admin/users/:id expenseSummary", () => {
  it("splits debits and credits; count covers all rows", async () => {
    const bob = await registerUser(app, { name: "Bob" });
    await insert({ amount: 100 });
    await insertLegacy({ amount: 25 });
    await insert({ amount: 300, type: "credit" });
    await insert({ amount: 999, userId: bob.id });

    const res = await request(app)
      .get(`/api/v1/admin/users/${alice.id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.expenseSummary).toEqual({
      totalAmount: 125,
      totalCredits: 300,
      count: 3,
    });
  });

  it("returns zeroes for a user with no expenses", async () => {
    const res = await request(app)
      .get(`/api/v1/admin/users/${alice.id}`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.expenseSummary).toEqual({
      totalAmount: 0,
      totalCredits: 0,
      count: 0,
    });
  });
});
