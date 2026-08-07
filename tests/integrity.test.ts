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
  befriend,
  auth,
  adminCookie,
  type TestUser,
} from "./helpers.js";
import { Expense } from "../src/models/expenseModel.js";
import { ExpenseLedger } from "../src/models/expenseLedgerModel.js";
import { Chat } from "../src/models/chatModel.js";
import { Tx } from "../src/models/txModel.js";
import { User } from "../src/models/userModel.js";
import { FriendRequest } from "../src/models/friendRequestModel.js";
import { MonthlySummary } from "../src/models/monthlySummaryModel.js";

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

describe("BE-018 — the cursor that silently dropped rows", () => {
  /**
   * The regression this guards: users date transactions to the DAY, so many
   * rows share a timestamp. Paging with `{ date: { $lt: cursor } }` skipped
   * every same-date row after the first at each page boundary.
   */
  it("returns every row when all rows share one timestamp", async () => {
    const sameDate = new Date();
    sameDate.setUTCHours(12, 0, 0, 0);

    for (let i = 0; i < 12; i++) {
      await request(app)
        .post("/api/v1/expenses")
        .set(auth(user.accessToken))
        .send({ amount: i + 1, date: sameDate.toISOString(), remarks: `e${i}` })
        .expect(201);
    }

    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res: any = await request(app)
        .get("/api/v1/expenses")
        .set(auth(user.accessToken))
        .query({ limit: 5, ...(cursor ? { cursor } : {}) })
        .expect(200);

      for (const e of res.body.expenses) seen.add(e._id);
      cursor = res.body.nextCursor ?? undefined;
      pages += 1;
      if (pages > 10) throw new Error("pagination did not terminate");
    } while (cursor);

    // 12 identical-timestamp rows across pages of 5. The old cursor returned 5.
    expect(seen.size).toBe(12);
  });

  it("never returns the same row on two pages", async () => {
    const d = new Date();
    d.setUTCHours(9, 0, 0, 0);
    for (let i = 0; i < 9; i++) {
      await request(app)
        .post("/api/v1/expenses")
        .set(auth(user.accessToken))
        .send({ amount: 10, date: d.toISOString() })
        .expect(201);
    }

    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const res: any = await request(app)
        .get("/api/v1/expenses")
        .set(auth(user.accessToken))
        .query({ limit: 4, ...(cursor ? { cursor } : {}) })
        .expect(200);
      all.push(...res.body.expenses.map((e: any) => e._id));
      cursor = res.body.nextCursor ?? undefined;
    } while (cursor);

    expect(all.length).toBe(new Set(all).size);
    expect(all.length).toBe(9);
  });

  it("still accepts a legacy bare-ISO cursor from deployed app builds", async () => {
    const d = new Date();
    for (let i = 0; i < 4; i++) {
      await request(app)
        .post("/api/v1/expenses")
        .set(auth(user.accessToken))
        .send({ amount: 10, date: new Date(d.getTime() - i * 86400000).toISOString() })
        .expect(201);
    }

    // The pre-fix cursor format: an ISO date with no id component.
    const res = await request(app)
      .get("/api/v1/expenses")
      .set(auth(user.accessToken))
      .query({ limit: 10, cursor: d.toISOString() })
      .expect(200);

    expect(res.body.expenses.length).toBeGreaterThan(0);
  });
});

describe("BE-016/BE-017 — ledger totals are atomic and transactional", () => {
  it("keeps the ledger total consistent under concurrent writes", async () => {
    // The lost-update race: read-modify-write meant the second save
    // overwrote the first, so money silently vanished from the total.
    await Promise.all(
      Array.from({ length: 15 }, () =>
        request(app)
          .post("/api/v1/expenses")
          .set(auth(user.accessToken))
          .send({ amount: 10, date: isoNow() })
          .expect(201),
      ),
    );

    const ledger = await ExpenseLedger.findOne({ userId: user.id }).lean();
    expect(ledger!.totalExpenses).toBe(150);
    expect(await Expense.countDocuments({ userId: user.id })).toBe(15);
  });

  it("creates exactly one ledger under concurrent first writes", async () => {
    // find-then-create had a TOCTOU window: two writes on the 1st of the month
    // both found no ledger and both created one, splitting the totals.
    await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post("/api/v1/expenses")
          .set(auth(user.accessToken))
          .send({ amount: 5, date: isoNow() }),
      ),
    );

    expect(await ExpenseLedger.countDocuments({ userId: user.id })).toBe(1);
  });

  it("reverses the old amount and applies the new one on edit", async () => {
    const created = await request(app)
      .post("/api/v1/expenses")
      .set(auth(user.accessToken))
      .send({ amount: 100, date: isoNow() })
      .expect(201);

    await request(app)
      .put(`/api/v1/expenses/${created.body.expense._id}`)
      .set(auth(user.accessToken))
      .send({ amount: 30 })
      .expect(200);

    const ledger = await ExpenseLedger.findOne({ userId: user.id }).lean();
    expect(ledger!.totalExpenses).toBe(30);
  });

  it("moves the expense and both totals when the date crosses a month", async () => {
    const created = await request(app)
      .post("/api/v1/expenses")
      .set(auth(user.accessToken))
      .send({ amount: 100, date: isoNow() })
      .expect(201);
    const originalLedgerId = created.body.expense.ledgerId;

    // Editing the date previously left `ledgerId` pointing at the old month,
    // so the row showed under a month it was no longer dated to and BOTH
    // totals were wrong.
    const lastMonth = new Date();
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1, 15);

    await request(app)
      .put(`/api/v1/expenses/${created.body.expense._id}`)
      .set(auth(user.accessToken))
      .send({ date: lastMonth.toISOString() })
      .expect(200);

    const moved = await Expense.findById(created.body.expense._id).lean();
    expect(String(moved!.ledgerId)).not.toBe(String(originalLedgerId));

    const oldLedger = await ExpenseLedger.findById(originalLedgerId).lean();
    const newLedger = await ExpenseLedger.findById(moved!.ledgerId).lean();
    expect(oldLedger!.totalExpenses).toBe(0);
    expect(newLedger!.totalExpenses).toBe(100);
  });

  it("decrements the total on delete", async () => {
    const a = await request(app)
      .post("/api/v1/expenses")
      .set(auth(user.accessToken))
      .send({ amount: 40, date: isoNow() })
      .expect(201);
    await request(app)
      .post("/api/v1/expenses")
      .set(auth(user.accessToken))
      .send({ amount: 60, date: isoNow() })
      .expect(201);

    await request(app)
      .delete(`/api/v1/expenses/${a.body.expense._id}`)
      .set(auth(user.accessToken))
      .expect(200);

    const ledger = await ExpenseLedger.findOne({ userId: user.id }).lean();
    expect(ledger!.totalExpenses).toBe(60);
  });
});

describe("BE-023 — duplicate chats", () => {
  it("creates exactly one chat when a friend request is accepted", async () => {
    const other = await registerUser(app);
    await befriend(app, user, other);
    expect(await Chat.countDocuments()).toBe(1);
  });

  it("does not create a second chat when accept is retried", async () => {
    const other = await registerUser(app);

    await request(app)
      .post("/api/v1/friends/request")
      .set(auth(user.accessToken))
      .send({ toUserId: other.id })
      .expect(201);

    const pending = await request(app)
      .get("/api/v1/friends/requests")
      .set(auth(other.accessToken))
      .expect(200);
    const requestId = pending.body.incoming[0]._id;

    await request(app)
      .post("/api/v1/friends/accept")
      .set(auth(other.accessToken))
      .send({ requestId })
      .expect(200);

    // The retry the mobile client provoked by reporting a failed chat REFETCH
    // as "Failed to accept". It must not mint a second chat.
    await request(app)
      .post("/api/v1/friends/accept")
      .set(auth(other.accessToken))
      .send({ requestId });

    expect(await Chat.countDocuments()).toBe(1);
  });
});

describe("BE-025 / X-19 — the delete cascade that crashed the mobile client", () => {
  it("removes every reference to a deleted user", async () => {
    const other = await registerUser(app);
    const chatId = await befriend(app, user, other);

    await request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(user.accessToken))
      .send({
        chatId,
        amount: 100,
        date: isoNow(),
        from: user.id,
        to: other.id,
        remarks: "lunch",
      })
      .expect(201);

    await request(app)
      .post("/api/v1/expenses")
      .set(auth(user.accessToken))
      .send({ amount: 25, date: isoNow() })
      .expect(201);

    const cookie = await adminCookie(app);
    await request(app)
      .delete(`/api/v1/admin/users/${user.id}`)
      .set("Cookie", cookie)
      .expect(200);

    const id = new mongoose.Types.ObjectId(user.id);

    // Every collection the old 4-collection cascade missed.
    expect(await Chat.countDocuments({ members: id })).toBe(0);
    expect(await Chat.countDocuments({ _id: chatId })).toBe(0);
    expect(await Tx.countDocuments({ $or: [{ from: id }, { to: id }] })).toBe(0);
    expect(await FriendRequest.countDocuments({ $or: [{ from: id }, { to: id }] })).toBe(0);
    expect(await MonthlySummary.countDocuments({ chatId })).toBe(0);
    expect(await Expense.countDocuments({ userId: id })).toBe(0);
    expect(await ExpenseLedger.countDocuments({ userId: id })).toBe(0);

    // The critical one: the SURVIVING user must not hold a dangling reference,
    // because the mobile client dereferences `chat.members` unguarded and
    // crashed its home screen on the null that populate returned.
    const survivor = await User.findById(other.id).lean();
    expect(survivor!.friends.map(String)).not.toContain(user.id);
    expect(survivor).not.toBeNull();
  });

  it("leaves the surviving user's chat list free of null members", async () => {
    const other = await registerUser(app);
    await befriend(app, user, other);

    const cookie = await adminCookie(app);
    await request(app)
      .delete(`/api/v1/admin/users/${user.id}`)
      .set("Cookie", cookie)
      .expect(200);

    // This is the exact request the mobile home screen makes on launch.
    const res = await request(app)
      .get("/api/v1/chats")
      .set(auth(other.accessToken))
      .expect(200);

    const chats = res.body.chats ?? res.body;
    for (const chat of chats) {
      for (const member of chat.members ?? []) {
        expect(member).not.toBeNull();
      }
    }
  });
});
