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
import { ExpenseLedger } from "../src/models/expenseLedgerModel.js";
import { Expense } from "../src/models/expenseModel.js";

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

const addExpense = (body: Record<string, unknown>) =>
  request(app).post("/api/v1/expenses").set(auth(user.accessToken)).send(body);

const isoNow = () => new Date().toISOString();

describe("BE-031 — validate() now applies the parsed result", () => {
  it("strips unknown fields instead of passing them to Mongoose (mass assignment)", async () => {
    const res = await addExpense({
      amount: 100,
      date: isoNow(),
      // Attempt to set fields the schema does not name.
      userId: "000000000000000000000000",
      ledgerId: "000000000000000000000000",
      _id: "000000000000000000000000",
    }).expect(201);

    // The expense must belong to the caller, not to the injected userId.
    expect(String(res.body.expense.userId)).toBe(user.id);
    expect(String(res.body.expense._id)).not.toBe("000000000000000000000000");
  });

  it("applies schema defaults, which were previously inert", async () => {
    // `type` defaults to "debit" in the schema. Before the fix the parsed
    // result was discarded, so defaults never reached the handler.
    const res = await addExpense({ amount: 50, date: isoNow() }).expect(201);
    expect(res.body.expense.type).toBe("debit");
  });
});

describe("BE-015 — the money coercion bug", () => {
  it('coerces the string "100" so ledger totals add rather than concatenate', async () => {
    await addExpense({ amount: 50, date: isoNow() }).expect(201);
    // The exact payload that produced `50 + "100" === "50100"`.
    await addExpense({ amount: "100", date: isoNow() }).expect(201);

    const ledger = await ExpenseLedger.findOne({ userId: user.id }).lean();
    expect(ledger!.totalExpenses).toBe(150);
    expect(typeof ledger!.totalExpenses).toBe("number");
  });

  it("rejects a non-numeric amount instead of storing null", async () => {
    // `parseFloat("abc")` on the client produced NaN, which JSON-serialises to
    // null and silently poisoned every downstream sum.
    await addExpense({ amount: "abc", date: isoNow() }).expect(400);
    await addExpense({ amount: null, date: isoNow() }).expect(400);
    expect(await Expense.countDocuments()).toBe(0);
  });

  it("rejects zero, negative and absurd amounts", async () => {
    await addExpense({ amount: 0, date: isoNow() }).expect(400);
    await addExpense({ amount: -10, date: isoNow() }).expect(400);
    await addExpense({ amount: 99_999_999, date: isoNow() }).expect(400);
  });

  it("rounds to two decimals so float drift cannot accumulate", async () => {
    const res = await addExpense({ amount: 10.005, date: isoNow() }).expect(201);
    expect(res.body.expense.amount).toBe(10.01);
  });

  it("rejects a malformed date", async () => {
    await addExpense({ amount: 10, date: "not-a-date" }).expect(400);
  });
});

describe("BE-010 — NoSQL operator injection in phone search", () => {
  it("rejects an operator object where a string is expected", async () => {
    // `User.findOne({ phone: { $ne: null } })` returned an arbitrary user.
    await request(app)
      .post("/api/v1/friends/search")
      .set(auth(user.accessToken))
      .send({ phone: { $ne: null } })
      .expect(400);
  });

  it("rejects a $regex payload that could walk the whole user table", async () => {
    await request(app)
      .post("/api/v1/friends/search")
      .set(auth(user.accessToken))
      .send({ phone: { $regex: "^" } })
      .expect(400);
  });

  it("still finds a real user by an exact phone string", async () => {
    const other = await registerUser(app);
    const res = await request(app)
      .post("/api/v1/friends/search")
      .set(auth(user.accessToken))
      .send({ phone: other.phone })
      .expect(200);

    expect(res.body.exists).toBe(true);
    expect(res.body.user.phone).toBe(other.phone);
  });

  it("rejects an array containing an operator in contact sync", async () => {
    await request(app)
      .post("/api/v1/friends/check-contacts")
      .set(auth(user.accessToken))
      .send({ phoneNumbers: [{ $ne: null }] })
      .expect(400);
  });
});

describe("BE-021 — the ledger you could permanently lock", () => {
  it('refuses to close the current month even when year arrives as the string "2026"', async () => {
    const now = new Date();
    // The exact payload that defeated `year === currentYear`.
    await request(app)
      .post("/api/v1/expenses/ledgers/close")
      .set(auth(user.accessToken))
      .send({
        year: String(now.getUTCFullYear()),
        month: String(now.getUTCMonth() + 1),
      })
      .expect(400);
  });

  it("refuses to close a future month", async () => {
    const now = new Date();
    await request(app)
      .post("/api/v1/expenses/ledgers/close")
      .set(auth(user.accessToken))
      .send({ year: now.getUTCFullYear() + 1, month: 1 })
      .expect(400);
  });

  it("closes a past month exactly once", async () => {
    await ExpenseLedger.create({
      userId: user.id,
      year: 2024,
      month: 1,
      status: "open",
      totalExpenses: 0,
      totalCredits: 0,
    });

    await request(app)
      .post("/api/v1/expenses/ledgers/close")
      .set(auth(user.accessToken))
      .send({ year: 2024, month: 1 })
      .expect(200);

    // Second attempt is rejected, not silently re-applied.
    await request(app)
      .post("/api/v1/expenses/ledgers/close")
      .set(auth(user.accessToken))
      .send({ year: 2024, month: 1 })
      .expect(400);
  });
});

describe("BE-024 — regex escaping in admin search", () => {
  it("treats regex metacharacters as literals instead of erroring", async () => {
    const res = await request(app)
      .post("/api/v1/admin/login")
      .send({ secretKey: process.env.ADMIN_SECRET_KEY })
      .expect(200);
    const cookie = (res.headers["set-cookie"] as unknown as string[])
      .map((c) => c.split(";")[0])
      .join("; ");

    // An unbalanced "(" previously produced an invalid pattern and a 500.
    await request(app)
      .get("/api/v1/admin/users")
      .set("Cookie", cookie)
      .query({ search: "(work" })
      .expect(200);

    // A catastrophic-backtracking payload must be inert, not a pinned thread.
    await request(app)
      .get("/api/v1/admin/users")
      .set("Cookie", cookie)
      .query({ search: "(a+)+$" })
      .expect(200);
  });
});

describe("Route hygiene", () => {
  it("returns JSON, not HTML, for an unknown route", async () => {
    const res = await request(app).get("/api/v1/does-not-exist").expect(404);
    expect(res.headers["content-type"]).toMatch(/json/);
    expect(res.body.success).toBe(false);
  });

  it("matches /expenses/check-duplicate as a literal, not as /:id", async () => {
    // With `/:id` declared first, this bound id = "check-duplicate".
    await request(app)
      .get("/api/v1/expenses/check-duplicate")
      .set(auth(user.accessToken))
      .query({ amount: 10, date: isoNow() })
      .expect(200);
  });

  it("rejects a malformed ObjectId in a path parameter", async () => {
    await request(app)
      .delete("/api/v1/expenses/not-an-object-id")
      .set(auth(user.accessToken))
      .expect(400);
  });
});
