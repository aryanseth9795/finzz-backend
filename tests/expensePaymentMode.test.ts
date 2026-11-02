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
 * T-019: the optional payment mode (cash / online) and, for online, the
 * method (upi, card, ...). Rows without them are "not recorded", which is
 * every row an older app saves, so leaving the fields out must keep working.
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

const isoNow = () => new Date().toISOString();

const post = (body: Record<string, unknown>) =>
  request(app)
    .post("/api/v1/expenses")
    .set(auth(user.accessToken))
    .send({ amount: 100, date: isoNow(), ...body });

const put = (id: string, body: Record<string, unknown>) =>
  request(app)
    .put(`/api/v1/expenses/${id}`)
    .set(auth(user.accessToken))
    .send(body);

/** Read the raw stored document, so a removed field stays missing. */
const rawExpense = (id: string) =>
  Expense.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });

const expenseCount = () => Expense.countDocuments({ userId: user.id });

const ledgerTotals = async () => {
  const rows = await ExpenseLedger.find({ userId: user.id })
    .sort({ year: 1, month: 1 })
    .lean<{ year: number; month: number; totalExpenses: number; totalCredits: number }[]>();
  return rows.map((r) => [r.year, r.month, r.totalExpenses, r.totalCredits]);
};

const METHODS = ["upi", "card", "netbanking", "wallet", "other"] as const;

describe("POST /expenses with a payment mode", () => {
  it("stores cash with no method", async () => {
    const res = await post({ paymentMode: "cash" }).expect(201);

    expect(res.body.expense.paymentMode).toBe("cash");
    expect(res.body.expense).not.toHaveProperty("paymentMethod");

    const doc = await rawExpense(res.body.expense._id);
    expect(doc!.paymentMode).toBe("cash");
    expect(doc).not.toHaveProperty("paymentMethod");
  });

  it.each(METHODS)("stores online with method %s", async (method) => {
    const res = await post({ paymentMode: "online", paymentMethod: method }).expect(201);

    expect(res.body.expense.paymentMode).toBe("online");
    expect(res.body.expense.paymentMethod).toBe(method);

    const doc = await rawExpense(res.body.expense._id);
    expect(doc!.paymentMode).toBe("online");
    expect(doc!.paymentMethod).toBe(method);
  });

  it("stores online with no method", async () => {
    const res = await post({ paymentMode: "online" }).expect(201);

    expect(res.body.expense.paymentMode).toBe("online");
    const doc = await rawExpense(res.body.expense._id);
    expect(doc!.paymentMode).toBe("online");
    expect(doc).not.toHaveProperty("paymentMethod");
  });

  it("stores neither field when the app sends none (old app)", async () => {
    const res = await post({}).expect(201);

    expect(res.body.expense).not.toHaveProperty("paymentMode");
    expect(res.body.expense).not.toHaveProperty("paymentMethod");
    const doc = await rawExpense(res.body.expense._id);
    expect(doc).not.toHaveProperty("paymentMode");
    expect(doc).not.toHaveProperty("paymentMethod");
  });

  type Refused = {
    label: string;
    body: Record<string, unknown>;
    field: string;
    /** The mode rule, not the enum, is what refuses it. */
    needsOnline: boolean;
  };
  it.each<Refused>([
    { label: "cash + upi", body: { paymentMode: "cash", paymentMethod: "upi" }, field: "paymentMethod", needsOnline: true },
    { label: "upi with no mode", body: { paymentMethod: "upi" }, field: "paymentMethod", needsOnline: true },
    { label: "an unknown mode", body: { paymentMode: "cheque" }, field: "paymentMode", needsOnline: false },
    { label: "an unknown method", body: { paymentMode: "online", paymentMethod: "cheque" }, field: "paymentMethod", needsOnline: false },
  ])("refuses $label and writes nothing", async ({ body, field, needsOnline }) => {
    // A row already in this month, so the ledger exists and has a total.
    await post({ amount: 40 }).expect(201);
    const countBefore = await expenseCount();
    const totalsBefore = await ledgerTotals();

    const res = await post({ amount: 999, ...body }).expect(400);

    expect(res.body.errors.map((e: { field: string }) => e.field)).toContain(field);
    if (needsOnline) {
      expect(res.body.errors).toContainEqual({
        field: "paymentMethod",
        message: "Payment method needs online mode",
      });
    }
    expect(await expenseCount()).toBe(countBefore);
    expect(await ledgerTotals()).toEqual(totalsBefore);
  });
});

describe("PUT /expenses/:id with a payment mode", () => {
  const createOnlineUpi = async () => {
    const res = await post({ paymentMode: "online", paymentMethod: "upi" }).expect(201);
    return res.body.expense._id as string;
  };
  const createCash = async () => {
    const res = await post({ paymentMode: "cash" }).expect(201);
    return res.body.expense._id as string;
  };

  it("switching online/upi to cash removes the method from the stored row", async () => {
    const id = await createOnlineUpi();

    const res = await put(id, { paymentMode: "cash" }).expect(200);

    expect(res.body.expense.paymentMode).toBe("cash");
    expect(res.body.expense.paymentMethod).toBeUndefined();
    const doc = await rawExpense(id);
    expect(doc!.paymentMode).toBe("cash");
    expect(doc).not.toHaveProperty("paymentMethod");
  });

  it("null clears both fields from the stored row", async () => {
    const id = await createOnlineUpi();

    const res = await put(id, { paymentMode: null, paymentMethod: null }).expect(200);

    expect(res.body.expense.paymentMode).toBeUndefined();
    expect(res.body.expense.paymentMethod).toBeUndefined();
    const doc = await rawExpense(id);
    expect(doc).not.toHaveProperty("paymentMode");
    expect(doc).not.toHaveProperty("paymentMethod");
  });

  it("clearing only the mode also clears the method", async () => {
    const id = await createOnlineUpi();

    await put(id, { paymentMode: null }).expect(200);

    const doc = await rawExpense(id);
    expect(doc).not.toHaveProperty("paymentMode");
    expect(doc).not.toHaveProperty("paymentMethod");
  });

  it("null method on an online row keeps the mode", async () => {
    const id = await createOnlineUpi();

    await put(id, { paymentMethod: null }).expect(200);

    const doc = await rawExpense(id);
    expect(doc!.paymentMode).toBe("online");
    expect(doc).not.toHaveProperty("paymentMethod");
  });

  it("an edit without payment keys keeps both", async () => {
    const id = await createOnlineUpi();

    const res = await put(id, { amount: 50 }).expect(200);

    expect(res.body.expense.amount).toBe(50);
    const doc = await rawExpense(id);
    expect(doc!.paymentMode).toBe("online");
    expect(doc!.paymentMethod).toBe("upi");
  });

  it("a method alone on an online row keeps the stored mode", async () => {
    const id = await createOnlineUpi();

    const res = await put(id, { paymentMethod: "card" }).expect(200);

    expect(res.body.expense.paymentMode).toBe("online");
    expect(res.body.expense.paymentMethod).toBe("card");
    const doc = await rawExpense(id);
    expect(doc!.paymentMode).toBe("online");
    expect(doc!.paymentMethod).toBe("card");
  });

  it("a method alone on a cash row is refused and the row is unchanged", async () => {
    const id = await createCash();
    const before = await rawExpense(id);
    const totalsBefore = await ledgerTotals();

    const res = await put(id, { paymentMethod: "upi", amount: 70 }).expect(400);

    expect(res.body.message).toBe("Payment method needs online mode");
    expect(await rawExpense(id)).toEqual(before);
    expect(await ledgerTotals()).toEqual(totalsBefore);
  });

  it("a method alone on a row with no mode is refused", async () => {
    const res0 = await post({}).expect(201);
    const id = res0.body.expense._id as string;
    const before = await rawExpense(id);

    const res = await put(id, { paymentMethod: "upi" }).expect(400);

    expect(res.body.message).toBe("Payment method needs online mode");
    expect(await rawExpense(id)).toEqual(before);
  });

  it.each<{ label: string; body: Record<string, unknown> }>([
    { label: "cash", body: { paymentMode: "cash", paymentMethod: "upi" } },
    { label: "null", body: { paymentMode: null, paymentMethod: "upi" } },
  ])("refuses a method sent with an explicit $label mode", async ({ body }) => {
    const id = await createOnlineUpi();
    const before = await rawExpense(id);

    const res = await put(id, body).expect(400);

    expect(res.body.errors).toContainEqual({
      field: "paymentMethod",
      message: "Payment method needs online mode",
    });
    expect(await rawExpense(id)).toEqual(before);
  });

  it("refuses an unknown mode or method on edit", async () => {
    const id = await createOnlineUpi();

    await put(id, { paymentMode: "cheque" }).expect(400);
    await put(id, { paymentMethod: "cheque" }).expect(400);

    const doc = await rawExpense(id);
    expect(doc!.paymentMode).toBe("online");
    expect(doc!.paymentMethod).toBe("upi");
  });

  it("a cash row switched to online with a method is saved", async () => {
    const id = await createCash();

    const res = await put(id, { paymentMode: "online", paymentMethod: "wallet" }).expect(200);

    expect(res.body.expense.paymentMode).toBe("online");
    expect(res.body.expense.paymentMethod).toBe("wallet");
    const doc = await rawExpense(id);
    expect(doc!.paymentMode).toBe("online");
    expect(doc!.paymentMethod).toBe("wallet");
  });
});

describe("GET /expenses returns the payment fields", () => {
  it("includes them on rows that have them and omits them on old rows", async () => {
    const cash = await post({ paymentMode: "cash" }).expect(201);
    const upi = await post({ paymentMode: "online", paymentMethod: "upi" }).expect(201);
    const old = await post({}).expect(201);
    const ledgerId = cash.body.expense.ledgerId as string;

    const res = await request(app)
      .get("/api/v1/expenses")
      .query({ ledgerId })
      .set(auth(user.accessToken))
      .expect(200);

    type Row = { _id: string; paymentMode?: string; paymentMethod?: string };
    const byId = new Map<string, Row>(
      (res.body.expenses as Row[]).map((e) => [e._id, e]),
    );
    expect(byId.size).toBe(3);

    expect(byId.get(cash.body.expense._id)).toMatchObject({ paymentMode: "cash" });
    expect(byId.get(cash.body.expense._id)).not.toHaveProperty("paymentMethod");
    expect(byId.get(upi.body.expense._id)).toMatchObject({
      paymentMode: "online",
      paymentMethod: "upi",
    });
    expect(byId.get(old.body.expense._id)).not.toHaveProperty("paymentMode");
    expect(byId.get(old.body.expense._id)).not.toHaveProperty("paymentMethod");
  });
});
