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

/**
 * T-018: an expense may be dated in any past month that is not closed. The
 * server already behaves this way (getOrCreateLedger upserts the month as
 * `open`; only a `closed` ledger refuses); these tests lock it in now that
 * the app's date picker reaches past months.
 *
 * Dates are built from the current UTC month, never hard-coded, and sit on
 * the 15th at UTC midnight so no timezone offset can move them across a
 * month boundary. No tzOffsetMinutes is sent, so the server buckets in UTC.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let user: TestUser;
beforeEach(async () => {
  await resetDb();
  clearMailbox();
  user = await registerUser(app);
});

/** UTC midnight of the 15th, `n` months before the current UTC month. */
const monthsAgo = (n: number) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 15));
  return { iso: d.toISOString(), year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
};

const post = (body: Record<string, unknown>) =>
  request(app)
    .post("/api/v1/expenses")
    .set(auth(user.accessToken))
    .send({ amount: 100, ...body });

const put = (id: string, body: Record<string, unknown>) =>
  request(app)
    .put(`/api/v1/expenses/${id}`)
    .set(auth(user.accessToken))
    .send(body);

const closeMonth = (year: number, month: number) =>
  request(app)
    .post("/api/v1/expenses/ledgers/close")
    .set(auth(user.accessToken))
    .send({ year, month });

type LedgerRow = {
  _id: mongoose.Types.ObjectId;
  status: "open" | "closed";
  totalExpenses: number;
  totalCredits: number;
};
const ledgerOf = (p: { year: number; month: number }) =>
  ExpenseLedger.findOne({ userId: user.id, year: p.year, month: p.month }).lean<LedgerRow>();

const rawExpense = (id: string) =>
  Expense.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

const expenseCount = () => Expense.countDocuments({ userId: user.id });

describe("adding to a past month", () => {
  it("creates an open ledger for a past month that has none", async () => {
    const past = monthsAgo(2);
    expect(await ledgerOf(past)).toBeNull();

    const res = await post({ amount: 120, date: past.iso }).expect(201);

    const ledger = await ledgerOf(past);
    expect(ledger).not.toBeNull();
    expect(ledger!.status).toBe("open");
    expect(ledger!.totalExpenses).toBe(120);
    expect(String(res.body.expense.ledgerId)).toBe(String(ledger!._id));
  });

  it("adds to the total of an existing open past ledger", async () => {
    const past = monthsAgo(2);
    await post({ amount: 120, date: past.iso }).expect(201);

    const res = await post({ amount: 30.5, date: past.iso }).expect(201);

    const ledger = await ledgerOf(past);
    expect(ledger!.status).toBe("open");
    expect(ledger!.totalExpenses).toBe(150.5);
    expect(String(res.body.expense.ledgerId)).toBe(String(ledger!._id));
    expect(await expenseCount()).toBe(2);
  });

  it("refuses a closed past month and writes nothing", async () => {
    const past = monthsAgo(2);
    await post({ amount: 120, date: past.iso }).expect(201);
    await closeMonth(past.year, past.month).expect(200);
    const countBefore = await expenseCount();

    const res = await post({ amount: 999, date: past.iso }).expect(400);

    expect(res.body.message).toBe("Cannot add expenses to a closed ledger period");
    expect(await expenseCount()).toBe(countBefore);
    const ledger = await ledgerOf(past);
    expect(ledger!.status).toBe("closed");
    expect(ledger!.totalExpenses).toBe(120);
  });
});

describe("editing between past months", () => {
  it("refuses moving an expense into a closed month and changes nothing", async () => {
    const closed = monthsAgo(3);
    const open = monthsAgo(2);
    await post({ amount: 200, date: closed.iso }).expect(201);
    await closeMonth(closed.year, closed.month).expect(200);
    const created = await post({ amount: 80, date: open.iso }).expect(201);
    const id = created.body.expense._id as string;
    const before = await rawExpense(id);

    const res = await put(id, { date: closed.iso }).expect(400);

    expect(res.body.message).toBe("Cannot move an expense into a closed ledger");
    expect(await rawExpense(id)).toEqual(before);
    expect((await ledgerOf(closed))!.totalExpenses).toBe(200);
    expect((await ledgerOf(open))!.totalExpenses).toBe(80);
  });

  it("moves an expense between two open past months, ledger and totals", async () => {
    const from = monthsAgo(2);
    const to = monthsAgo(1);
    const created = await post({ amount: 80, date: from.iso }).expect(201);
    await post({ amount: 10, date: to.iso }).expect(201);
    const id = created.body.expense._id as string;

    const res = await put(id, { date: to.iso }).expect(200);

    const fromLedger = await ledgerOf(from);
    const toLedger = await ledgerOf(to);
    expect(String(res.body.expense.ledgerId)).toBe(String(toLedger!._id));
    expect(String((await rawExpense(id))!.ledgerId)).toBe(String(toLedger!._id));
    expect(fromLedger!.totalExpenses).toBe(0);
    expect(toLedger!.totalExpenses).toBe(90);
  });
});
