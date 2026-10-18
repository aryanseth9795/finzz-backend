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
  type TestUser,
} from "./helpers.js";
import { Tx } from "../src/models/txModel.js";
import { MonthlySummary } from "../src/models/monthlySummaryModel.js";
import { buildChatReportData } from "../src/services/chatReport/data.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
let bob: TestUser;
let chatId: string;

beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
  bob = await registerUser(app, { name: "Bob" });
  chatId = await befriend(app, alice, bob);
});

type Who = "alice" | "bob";
const id = (w: Who) => (w === "alice" ? alice.id : bob.id);

/** Insert a tx directly (any month). `gave` = who handed over the money. */
const mkTx = (o: {
  gave: Who;
  amount: number;
  date: string;
  status?: "pending" | "verified" | "rejected";
  addedBy?: Who;
  remarks?: string;
}) => {
  const receiver: Who = o.gave === "alice" ? "bob" : "alice";
  return Tx.create({
    chatId,
    from: id(o.gave),
    to: id(receiver),
    amount: o.amount,
    date: new Date(o.date),
    remarks: o.remarks ?? "",
    addedBy: id(o.addedBy ?? o.gave),
    status: o.status ?? "pending",
  });
};

/**
 * Write a monthly summary row for a chosen (year, month) bucket, shaped exactly
 * as updateSummaryOnAdd would. The report must NOT read these rows (they are
 * bucketed in server-local time); tests write them to prove it ignores them.
 */
const summary = async (
  year: number,
  month: number,
  sentByAlice: number,
  sentByBob: number,
  txCount = 1,
) => {
  await MonthlySummary.create({
    chatId,
    year,
    month,
    txCount,
    members: {
      [alice.id]: { totalSent: sentByAlice, totalReceived: sentByBob },
      [bob.id]: { totalSent: sentByBob, totalReceived: sentByAlice },
    },
  });
};

const build = (year: number, month: number, tz = 0, extra: object = {}) =>
  buildChatReportData({
    chatId,
    viewerId: alice.id,
    year,
    month,
    tzOffsetMinutes: tz,
    ...extra,
  });

describe("buildChatReportData: period and people", () => {
  it("labels the period, names the people and stamps the generation time", async () => {
    const now = new Date("2026-10-17T10:00:00Z");
    const r = await build(2026, 10, 330, { now });
    expect(r.generatedAtUtc).toBe(now.toISOString());
    expect(r.period.label).toBe("October 2026");
    expect(r.period.year).toBe(2026);
    expect(r.period.month).toBe(10);
    expect(r.period.daysInMonth).toBe(31);
    expect(r.period.tzOffsetMinutes).toBe(330);
    expect(r.period.startUtc).toBe("2026-09-30T18:30:00.000Z");
    expect(r.period.endUtc).toBe("2026-10-31T18:30:00.000Z");
    expect(r.me).toEqual({ id: alice.id, name: "Alice" });
    expect(r.friend).toEqual({ id: bob.id, name: "Bob" });
  });

  it("is empty and zeroed for a month with no activity", async () => {
    const r = await build(2026, 10);
    expect(r.ledger).toEqual([]);
    expect(r.openingBalance).toBe(0);
    expect(r.closingBalance).toBe(0);
    expect(r.totals).toEqual({
      gave: 0,
      received: 0,
      net: 0,
      count: 0,
      activeDays: 0,
      addedByMe: 0,
      addedByFriend: 0,
    });
    expect(r.byStatus.pending).toEqual({ count: 0, amount: 0 });
    expect(r.previousMonth).toBeNull();
    expect(r.trend.map((t) => `${t.year}-${t.month}`)).toEqual([
      "2026-5",
      "2026-6",
      "2026-7",
      "2026-8",
      "2026-9",
      "2026-10",
    ]);
    expect(r.trend.every((t) => t.gave === 0 && t.received === 0 && t.net === 0)).toBe(true);
  });
});

describe("buildChatReportData: timezone", () => {
  it("puts 2026-09-30T19:00Z in October for IST and in September for UTC", async () => {
    await mkTx({ gave: "alice", amount: 100, date: "2026-09-30T19:00:00Z" });

    const ist = await build(2026, 10, 330);
    expect(ist.ledger).toHaveLength(1);
    expect(ist.ledger[0].day).toBe("2026-10-01");
    expect(ist.ledger[0].dayOfMonth).toBe(1);
    expect(ist.ledger[0].weekday).toBe(4); // Thursday 1 Oct 2026
    expect((await build(2026, 9, 330)).ledger).toHaveLength(0);

    const utc9 = await build(2026, 9, 0);
    expect(utc9.ledger).toHaveLength(1);
    expect(utc9.ledger[0].day).toBe("2026-09-30");
    expect(utc9.ledger[0].weekday).toBe(3); // Wednesday
    expect((await build(2026, 10, 0)).ledger).toHaveLength(0);
  });

  it("treats the end of the month as exclusive", async () => {
    await mkTx({ gave: "alice", amount: 1, date: "2026-10-31T18:29:59.999Z" });
    await mkTx({ gave: "alice", amount: 2, date: "2026-10-31T18:30:00.000Z" });
    const oct = await build(2026, 10, 330);
    expect(oct.ledger.map((l) => l.amount)).toEqual([1]);
    const nov = await build(2026, 11, 330);
    expect(nov.ledger.map((l) => l.amount)).toEqual([2]);
    expect(nov.ledger[0].day).toBe("2026-11-01");
  });
});

describe("buildChatReportData: status handling", () => {
  it("excludes rejected rows from totals but keeps them in the ledger", async () => {
    await mkTx({ gave: "alice", amount: 100, date: "2026-10-02T10:00:00Z", status: "verified" });
    await mkTx({
      gave: "bob",
      amount: 50,
      date: "2026-10-03T10:00:00Z",
      status: "rejected",
      addedBy: "bob",
    });
    await mkTx({ gave: "alice", amount: 30, date: "2026-10-04T10:00:00Z", status: "pending" });

    const r = await build(2026, 10);
    expect(r.ledger).toHaveLength(3);
    expect(r.totals.gave).toBe(130);
    expect(r.totals.received).toBe(0);
    expect(r.totals.net).toBe(-130);
    expect(r.totals.count).toBe(2);
    expect(r.totals.activeDays).toBe(2);

    const rejected = r.ledger[1];
    expect(rejected.status).toBe("rejected");
    expect(rejected.runningBalance).toBe(r.ledger[0].runningBalance);
    expect(r.ledger[2].runningBalance).toBe(130);
    expect(r.daily[2].count).toBe(0); // 3 Oct only had the rejected row
    expect(r.weekday.reduce((s, w) => s + w.count, 0)).toBe(2);
  });

  it("splits byStatus across all three statuses", async () => {
    await mkTx({ gave: "alice", amount: 10, date: "2026-10-02T10:00:00Z", status: "pending" });
    await mkTx({ gave: "alice", amount: 20, date: "2026-10-02T11:00:00Z", status: "pending" });
    await mkTx({ gave: "bob", amount: 40, date: "2026-10-03T10:00:00Z", status: "verified" });
    await mkTx({ gave: "bob", amount: 5, date: "2026-10-04T10:00:00Z", status: "rejected" });

    const r = await build(2026, 10);
    expect(r.byStatus.pending).toEqual({ count: 2, amount: 30 });
    expect(r.byStatus.verified).toEqual({ count: 1, amount: 40 });
    expect(r.byStatus.rejected).toEqual({ count: 1, amount: 5 });
  });

  it("counts a legacy row with no status but verified:true as verified", async () => {
    await Tx.collection.insertOne({
      chatId: new mongoose.Types.ObjectId(chatId),
      from: new mongoose.Types.ObjectId(alice.id),
      to: new mongoose.Types.ObjectId(bob.id),
      addedBy: new mongoose.Types.ObjectId(alice.id),
      amount: 75,
      date: new Date("2026-10-05T10:00:00Z"),
      verified: true,
    });
    await Tx.collection.insertOne({
      chatId: new mongoose.Types.ObjectId(chatId),
      from: new mongoose.Types.ObjectId(alice.id),
      to: new mongoose.Types.ObjectId(bob.id),
      addedBy: new mongoose.Types.ObjectId(alice.id),
      amount: 25,
      date: new Date("2026-10-06T10:00:00Z"),
    });

    const r = await build(2026, 10);
    expect(r.ledger.map((l) => l.status)).toEqual(["verified", "pending"]);
    expect(r.byStatus.verified).toEqual({ count: 1, amount: 75 });
    expect(r.byStatus.pending).toEqual({ count: 1, amount: 25 });
    expect(r.totals.count).toBe(2);
  });
});

describe("buildChatReportData: balances (positive = friend owes viewer)", () => {
  it("worked example: gave 1000, received 400 on top of an opening balance", async () => {
    // September: Alice gave 200, so Bob owes Alice 200 and the opening is +200.
    await mkTx({ gave: "alice", amount: 200, date: "2026-09-10T10:00:00Z" });

    await mkTx({ gave: "alice", amount: 1000, date: "2026-10-02T10:00:00Z", status: "verified" });
    await mkTx({ gave: "bob", amount: 400, date: "2026-10-03T10:00:00Z", status: "verified" });

    const r = await build(2026, 10);
    expect(r.openingBalance).toBe(200);
    expect(r.ledger.map((l) => l.direction)).toEqual(["gave", "received"]);
    expect(r.ledger[0].runningBalance).toBe(1200); // friend owes 1000 more
    expect(r.ledger[1].runningBalance).toBe(800); // friend paid 400 back
    expect(r.closingBalance).toBe(800); // opening + 600
    expect(r.closingBalance).toBe(r.openingBalance + 600);
    expect(r.ledger[r.ledger.length - 1].runningBalance).toBe(r.closingBalance);
    expect(r.totals.gave).toBe(1000);
    expect(r.totals.received).toBe(400);
    expect(r.totals.net).toBe(-600);
  });

  it("a negative opening balance means the viewer owes the friend", async () => {
    await mkTx({ gave: "bob", amount: 300, date: "2026-09-10T10:00:00Z" }); // Bob gave 300 in September
    const r = await build(2026, 10);
    expect(r.openingBalance).toBe(-300);
    expect(r.closingBalance).toBe(-300);
  });

  it("the friend's view of the same chat is the mirror image", async () => {
    await mkTx({ gave: "alice", amount: 200, date: "2026-09-10T10:00:00Z" });
    await mkTx({ gave: "bob", amount: 50, date: "2026-09-11T10:00:00Z" });
    const a = await build(2026, 10);
    const b = await buildChatReportData({
      chatId,
      viewerId: bob.id,
      year: 2026,
      month: 10,
      tzOffsetMinutes: 0,
    });
    expect(a.openingBalance).toBe(150);
    expect(b.openingBalance).toBe(-150);
    expect(b.me.name).toBe("Bob");
    expect(b.friend.name).toBe("Alice");
  });

  it("records who added each row", async () => {
    await mkTx({ gave: "alice", amount: 10, date: "2026-10-02T10:00:00Z" });
    await mkTx({ gave: "alice", amount: 20, date: "2026-10-03T10:00:00Z", addedBy: "bob" });
    await mkTx({ gave: "bob", amount: 5, date: "2026-10-04T10:00:00Z", addedBy: "bob" });
    const r = await build(2026, 10);
    expect(r.ledger.map((l) => l.addedBy)).toEqual(["me", "friend", "friend"]);
    expect(r.totals.addedByMe).toBe(1);
    expect(r.totals.addedByFriend).toBe(2);
  });

  it("rounds every sum to 2 decimals (0.1 + 0.2 gives 0.3)", async () => {
    await mkTx({ gave: "alice", amount: 0.1, date: "2026-10-02T10:00:00Z" });
    await mkTx({ gave: "alice", amount: 0.2, date: "2026-10-02T11:00:00Z" });
    const r = await build(2026, 10);
    expect(r.totals.gave).toBe(0.3);
    expect(r.totals.net).toBe(-0.3);
    expect(r.ledger[1].runningBalance).toBe(0.3);
    expect(r.closingBalance).toBe(0.3);
    expect(r.daily[1].gave).toBe(0.3);
    expect(r.byStatus.pending.amount).toBe(0.3);
  });

  it("orders same-instant rows by _id", async () => {
    const a = await mkTx({ gave: "alice", amount: 1, date: "2026-10-02T10:00:00Z", remarks: "first" });
    const b = await mkTx({ gave: "alice", amount: 2, date: "2026-10-02T10:00:00Z", remarks: "second" });
    const r = await build(2026, 10);
    expect(r.ledger.map((l) => l.id)).toEqual([String(a._id), String(b._id)]);
    expect(r.ledger.map((l) => l.remarks)).toEqual(["first", "second"]);
  });
});

describe("buildChatReportData: daily and weekday", () => {
  it("has daysInMonth daily entries and seven weekday entries", async () => {
    await mkTx({ gave: "alice", amount: 100, date: "2026-10-01T10:00:00Z" }); // Thu
    await mkTx({ gave: "bob", amount: 40, date: "2026-10-01T12:00:00Z" });
    await mkTx({ gave: "alice", amount: 60, date: "2026-10-08T10:00:00Z" }); // Thu

    const r = await build(2026, 10);
    expect(r.daily).toHaveLength(31);
    expect(r.daily.map((d) => d.dayOfMonth)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(r.daily[0]).toEqual({ dayOfMonth: 1, gave: 100, received: 40, count: 2 });
    expect(r.daily[7]).toEqual({ dayOfMonth: 8, gave: 60, received: 0, count: 1 });
    expect(r.daily[1]).toEqual({ dayOfMonth: 2, gave: 0, received: 0, count: 0 });
    expect(r.totals.activeDays).toBe(2);

    expect(r.weekday).toHaveLength(7);
    expect(r.weekday.map((w) => w.weekday)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.weekday[4]).toEqual({ weekday: 4, amount: 200, count: 3 });
    expect(r.weekday[0]).toEqual({ weekday: 0, amount: 0, count: 0 });
  });

  it("handles February in a non-leap and a leap year", async () => {
    expect((await build(2026, 2)).daily).toHaveLength(28);
    expect((await build(2028, 2)).daily).toHaveLength(29);
  });
});

describe("buildChatReportData: previous month and trend", () => {
  it("previousMonth is null when last month has no rows, or only rejected ones", async () => {
    expect((await build(2026, 10)).previousMonth).toBeNull();
    await mkTx({ gave: "alice", amount: 40, date: "2026-09-10T10:00:00Z", status: "rejected" });
    expect((await build(2026, 10)).previousMonth).toBeNull();
  });

  it("previousMonth reads the viewer's side of last month's rows", async () => {
    await mkTx({ gave: "alice", amount: 300, date: "2026-09-05T10:00:00Z" });
    await mkTx({ gave: "alice", amount: 200, date: "2026-09-06T10:00:00Z", status: "verified" });
    await mkTx({ gave: "bob", amount: 200, date: "2026-09-07T10:00:00Z" });
    const r = await build(2026, 10);
    expect(r.previousMonth).toEqual({ gave: 500, received: 200, net: -300, count: 3 });
  });

  it("previousMonth wraps across the year boundary", async () => {
    await mkTx({ gave: "alice", amount: 10, date: "2025-12-10T10:00:00Z" });
    await mkTx({ gave: "bob", amount: 40, date: "2025-12-11T10:00:00Z" });
    const r = await build(2026, 1);
    expect(r.previousMonth).toEqual({ gave: 10, received: 40, net: 30, count: 2 });
  });

  it("previousMonth is bucketed in the user's timezone", async () => {
    // 1 Sep 00:30 IST (31 Aug UTC) and 1 Oct 00:30 IST (30 Sep UTC).
    await mkTx({ gave: "alice", amount: 100, date: "2026-08-31T19:00:00Z" });
    await mkTx({ gave: "alice", amount: 7, date: "2026-09-30T19:00:00Z" });

    const ist = await build(2026, 10, 330);
    expect(ist.previousMonth).toEqual({ gave: 100, received: 0, net: -100, count: 1 });
    expect(ist.openingBalance).toBe(100);
    expect(ist.ledger.map((l) => l.amount)).toEqual([7]);

    const utc = await build(2026, 10, 0);
    expect(utc.previousMonth).toEqual({ gave: 7, received: 0, net: -7, count: 1 });
    expect(utc.openingBalance).toBe(107);
    expect(utc.ledger).toHaveLength(0);
  });

  it("trend is six consecutive months, oldest first, zero-filled, ending with this month", async () => {
    await mkTx({ gave: "alice", amount: 100, date: "2026-07-10T10:00:00Z" });
    await mkTx({ gave: "alice", amount: 50, date: "2026-09-10T10:00:00Z" });
    await mkTx({ gave: "bob", amount: 150, date: "2026-09-11T10:00:00Z" });
    await mkTx({ gave: "bob", amount: 25, date: "2026-10-10T10:00:00Z" });
    await mkTx({ gave: "alice", amount: 999, date: "2026-11-10T10:00:00Z" }); // future
    await mkTx({ gave: "alice", amount: 1, date: "2026-04-10T10:00:00Z" }); // older than six months
    await mkTx({ gave: "alice", amount: 77, date: "2026-08-10T10:00:00Z", status: "rejected" });

    const r = await build(2026, 10);
    expect(r.trend).toEqual([
      { year: 2026, month: 5, label: "May", gave: 0, received: 0, net: 0 },
      { year: 2026, month: 6, label: "Jun", gave: 0, received: 0, net: 0 },
      { year: 2026, month: 7, label: "Jul", gave: 100, received: 0, net: -100 },
      { year: 2026, month: 8, label: "Aug", gave: 0, received: 0, net: 0 },
      { year: 2026, month: 9, label: "Sep", gave: 50, received: 150, net: 100 },
      { year: 2026, month: 10, label: "Oct", gave: 0, received: 25, net: 25 },
    ]);
  });

  it("trend window crosses a year boundary", async () => {
    await mkTx({ gave: "alice", amount: 5, date: "2025-11-10T10:00:00Z" });
    await mkTx({ gave: "bob", amount: 5, date: "2026-02-10T10:00:00Z" });
    const r = await build(2026, 2);
    expect(r.trend.map((t) => `${t.year}-${t.month}`)).toEqual([
      "2025-9",
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-1",
      "2026-2",
    ]);
    expect(r.trend[2].gave).toBe(5);
    expect(r.trend[5].received).toBe(5);
  });

  it("trend months follow the user's timezone", async () => {
    await mkTx({ gave: "alice", amount: 7, date: "2026-09-30T19:00:00Z" });
    const ist = await build(2026, 10, 330);
    expect(ist.trend[5]).toMatchObject({ month: 10, gave: 7 });
    expect(ist.trend[4]).toMatchObject({ month: 9, gave: 0 });
    const utc = await build(2026, 10, 0);
    expect(utc.trend[4]).toMatchObject({ month: 9, gave: 7 });
    expect(utc.trend[5]).toMatchObject({ month: 10, gave: 0 });
  });
});

describe("buildChatReportData: one source for opening balance and ledger", () => {
  it("does not double count a legacy-dated 1st that a summary bucketed into the previous month", async () => {
    // Old app builds stored "1 Oct" as 2026-09-30T18:30Z; the summary landed in September.
    await mkTx({ gave: "alice", amount: 15000, date: "2026-09-30T18:30:00Z" });
    await summary(2026, 9, 15000, 0);

    const r = await build(2026, 10, 330);
    expect(r.ledger.map((l) => l.amount)).toEqual([15000]);
    expect(r.openingBalance).toBe(0);
    expect(r.closingBalance).toBe(15000);
    expect(r.closingBalance).toBe(r.openingBalance + 15000);
    expect(r.totals.gave).toBe(15000);
  });

  it("negative offset: nothing is dropped from opening or ledger, summaries are ignored", async () => {
    // tz -300: October starts at 2026-10-01T05:00Z. A tx at 03:00Z is still 30 Sep locally.
    await mkTx({ gave: "alice", amount: 40, date: "2026-10-01T03:00:00Z" });
    await mkTx({ gave: "alice", amount: 2, date: "2026-10-01T05:00:00Z" });
    // A summary bucketed into October (server-local UTC) must be ignored.
    await summary(2026, 10, 40, 0);

    const r = await build(2026, 10, -300);
    expect(r.openingBalance).toBe(40);
    expect(r.ledger.map((l) => l.amount)).toEqual([2]);
    expect(r.closingBalance).toBe(42);
  });

  it("opening balance covers all earlier non-rejected movement, including legacy rows", async () => {
    await mkTx({ gave: "alice", amount: 500, date: "2026-07-10T10:00:00Z", status: "verified" });
    await mkTx({ gave: "bob", amount: 120, date: "2026-08-12T10:00:00Z" });
    await mkTx({ gave: "alice", amount: 9999, date: "2026-08-15T10:00:00Z", status: "rejected" });
    await mkTx({ gave: "bob", amount: 0.1, date: "2026-09-01T10:00:00Z" });
    await mkTx({ gave: "bob", amount: 0.2, date: "2026-09-02T10:00:00Z" });
    // Legacy verified row with no status field.
    await Tx.collection.insertOne({
      chatId: new mongoose.Types.ObjectId(chatId),
      from: new mongoose.Types.ObjectId(alice.id),
      to: new mongoose.Types.ObjectId(bob.id),
      addedBy: new mongoose.Types.ObjectId(alice.id),
      amount: 30,
      date: new Date("2026-09-20T10:00:00Z"),
      verified: true,
    });
    // Later movement must not count towards the opening balance.
    await mkTx({ gave: "alice", amount: 1000, date: "2026-10-05T10:00:00Z" });

    const r = await build(2026, 10, 330);
    expect(r.openingBalance).toBe(409.7); // 500 - 120 - 0.1 - 0.2 + 30
    expect(r.closingBalance).toBe(1409.7);
    expect(r.ledger[0].runningBalance).toBe(1409.7);

    const b = await buildChatReportData({
      chatId,
      viewerId: bob.id,
      year: 2026,
      month: 10,
      tzOffsetMinutes: 330,
    });
    expect(b.openingBalance).toBe(-409.7);
  });
});

describe("buildChatReportData: through the real API", () => {
  it("reflects created, verified and rejected transactions", async () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const post = (who: TestUser, body: object) =>
      request(app)
        .post("/api/v1/txns/createtx")
        .set(auth(who.accessToken))
        .send({ chatId, tzOffsetMinutes: 0, date: now.toISOString(), ...body })
        .expect(201);
    const review = (who: TestUser, txnId: string, action: "verify" | "reject") =>
      request(app)
        .post("/api/v1/txns/reviewtx")
        .set(auth(who.accessToken))
        .send({ txnId, action })
        .expect(200);

    const t1 = await post(alice, { from: alice.id, to: bob.id, amount: 500, remarks: "lunch" });
    const t2 = await post(bob, { from: bob.id, to: alice.id, amount: 200, remarks: "cab" });
    const t3 = await post(alice, { from: alice.id, to: bob.id, amount: 70, remarks: "oops" });
    await review(bob, t1.body.txn._id, "verify");
    await review(alice, t2.body.txn._id, "verify");
    await review(bob, t3.body.txn._id, "reject");

    const r = await build(year, month, 0);
    expect(r.ledger).toHaveLength(3);
    expect(r.ledger.map((l) => l.status).sort()).toEqual(["rejected", "verified", "verified"]);
    expect(r.totals.gave).toBe(500);
    expect(r.totals.received).toBe(200);
    expect(r.closingBalance).toBe(300);
    expect(r.byStatus.rejected).toEqual({ count: 1, amount: 70 });
    expect(r.ledger.find((l) => l.remarks === "cab")!.addedBy).toBe("friend");
    expect(r.ledger.find((l) => l.remarks === "lunch")!.addedBy).toBe("me");
  });
});
