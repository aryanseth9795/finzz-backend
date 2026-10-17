import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { Tx } from "../src/models/txModel.js";
import { MonthlySummary } from "../src/models/monthlySummaryModel.js";
import { Notification } from "../src/models/notificationModel.js";
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

/** Alice (from) sends `amount` to Bob (to), dated now. */
const createTx = async (amount = 15000) => {
  const res = await request(app)
    .post("/api/v1/txns/createtx")
    .set(auth(alice.accessToken))
    .send({
      chatId,
      amount,
      date: new Date().toISOString(),
      from: alice.id,
      to: bob.id,
      remarks: "lunch",
    })
    .expect(201);
  return res.body.txn;
};

const edit = (user: TestUser, txnId: string, body: Record<string, unknown>) =>
  request(app)
    .put(`/api/v1/txns/edittx/${txnId}`)
    .set(auth(user.accessToken))
    .send(body);

const review = (
  user: TestUser,
  txnId: string,
  action: "verify" | "reject",
  extra: Record<string, unknown> = {},
) =>
  request(app)
    .post("/api/v1/txns/reviewtx")
    .set(auth(user.accessToken))
    .send({ txnId, action, ...extra });

/** Summary for the current month, in the same (server-local) frame the service uses. */
const summary = async () => {
  const now = new Date();
  const doc = (await MonthlySummary.findOne({
    chatId,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  }).lean()) as any;
  return {
    sent: doc?.members?.[alice.id]?.totalSent ?? 0,
    received: doc?.members?.[bob.id]?.totalReceived ?? 0,
    txCount: doc?.txCount ?? 0,
  };
};

describe("editTxn — editing a pending transaction", () => {
  it("creator edits a pending transaction: stays pending, editCount 1, editedAt set", async () => {
    const tx = await createTx(15000);
    expect(tx.status).toBe("pending");

    const res = await edit(alice, tx._id, {
      amount: 1500,
      remarks: "fixed",
      expectedUpdatedAt: tx.updatedAt,
    }).expect(200);

    expect(res.body.message).toBe("Transaction updated");
    expect(res.body.txn.status).toBe("pending");
    expect(res.body.txn.verified).toBe(false);
    expect(res.body.txn.amount).toBe(1500);
    expect(res.body.txn.remarks).toBe("fixed");
    expect(res.body.txn.editCount).toBe(1);
    expect(res.body.txn.editedAt).toBeTruthy();
    expect(new Date(res.body.txn.updatedAt).getTime()).toBeGreaterThan(
      new Date(tx.updatedAt).getTime(),
    );

    const stored = (await Tx.findById(tx._id).lean()) as any;
    expect(stored.amount).toBe(1500);
    expect(stored.editCount).toBe(1);
  });

  it("pending edit applies the summary delta: 15000 → 1500 leaves totals at 1500", async () => {
    const tx = await createTx(15000);
    expect(await summary()).toEqual({ sent: 15000, received: 15000, txCount: 1 });

    await edit(alice, tx._id, { amount: 1500 }).expect(200);

    expect(await summary()).toEqual({ sent: 1500, received: 1500, txCount: 1 });
  });

  it("a second edit increments editCount", async () => {
    const tx = await createTx(100);
    await edit(alice, tx._id, { amount: 200 }).expect(200);
    const res = await edit(alice, tx._id, { amount: 300 }).expect(200);
    expect(res.body.txn.editCount).toBe(2);
    expect(await summary()).toEqual({ sent: 300, received: 300, txCount: 1 });
  });

  it("pushes txn_edited to the other member", async () => {
    const tx = await createTx(15000);
    await edit(alice, tx._id, { amount: 1500 }).expect(200);

    const note = (await Notification.findOne({
      recipient: bob.id,
      type: "txn_edited",
    }).lean()) as any;
    expect(note).toBeTruthy();
    expect(note.title).toBe("Transaction Edited");
    expect(note.body).toBe(
      "Alice edited a pending transaction: Rs. 15000 → Rs. 1500",
    );
    expect(note.data.txnId).toBe(tx._id);
    expect(note.data.chatId).toBe(chatId);
    expect(String(note.data.senderId)).toBe(alice.id);
  });
});

describe("editTxn — guards", () => {
  it("non-creator cannot edit", async () => {
    const tx = await createTx();
    await edit(bob, tx._id, { amount: 5 }).expect(403);
    expect(((await Tx.findById(tx._id).lean()) as any).amount).toBe(15000);
  });

  it("returns 404 for a missing transaction", async () => {
    await edit(alice, "000000000000000000000000", { amount: 5 }).expect(404);
  });

  it("verified transaction cannot be edited", async () => {
    const tx = await createTx();
    await review(bob, tx._id, "verify").expect(200);

    const res = await edit(alice, tx._id, { amount: 5 }).expect(403);
    expect(res.body.message).toBe("Cannot edit a verified transaction");
    expect(await summary()).toEqual({ sent: 15000, received: 15000, txCount: 1 });
  });

  it("closed month date → 400", async () => {
    const tx = await createTx();
    const old = new Date();
    old.setUTCMonth(old.getUTCMonth() - 2);

    await edit(alice, tx._id, { date: old.toISOString() }).expect(400);
    expect(await summary()).toEqual({ sent: 15000, received: 15000, txCount: 1 });
  });

  it("an outsider as receiver → 400", async () => {
    const mallory = await registerUser(app, { name: "Mallory" });
    const tx = await createTx();
    await edit(alice, tx._id, { to: mallory.id }).expect(400);
  });
});

describe("editTxn — conflict detection", () => {
  it("stale expectedUpdatedAt → 409 with latest txn", async () => {
    const tx = await createTx(15000);

    await edit(alice, tx._id, {
      amount: 1500,
      expectedUpdatedAt: tx.updatedAt,
    }).expect(200);

    const res = await edit(alice, tx._id, {
      amount: 999,
      expectedUpdatedAt: tx.updatedAt, // the ORIGINAL value, now stale
    }).expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "This transaction was changed. Please review it and try again.",
    );
    expect(res.body.txn.amount).toBe(1500);
    expect(res.body.txn.editCount).toBe(1);
    // Nothing was applied by the losing request.
    expect(await summary()).toEqual({ sent: 1500, received: 1500, txCount: 1 });
  });

  it("edit landing after a verify → 403", async () => {
    const tx = await createTx(15000);
    await review(bob, tx._id, "verify").expect(200);

    const res = await edit(alice, tx._id, {
      amount: 1500,
      expectedUpdatedAt: tx.updatedAt,
    }).expect(403);
    expect(res.body.message).toBe("Cannot edit a verified transaction");

    expect(((await Tx.findById(tx._id).lean()) as any).amount).toBe(15000);
    expect(await summary()).toEqual({ sent: 15000, received: 15000, txCount: 1 });
  });

  it("two concurrent edits with the same expectedUpdatedAt: exactly one wins", async () => {
    const tx = await createTx(1000);
    const [a, b] = await Promise.all([
      edit(alice, tx._id, { amount: 2000, expectedUpdatedAt: tx.updatedAt }),
      edit(alice, tx._id, { amount: 3000, expectedUpdatedAt: tx.updatedAt }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? 2000 : 3000;
    expect(((await Tx.findById(tx._id).lean()) as any).amount).toBe(winner);
    expect(await summary()).toEqual({
      sent: winner,
      received: winner,
      txCount: 1,
    });
  });
});

describe("editTxn — rejected transaction resubmit", () => {
  it("rejected → resubmit still works and the summary is re-added exactly once", async () => {
    const tx = await createTx(1000);
    await review(bob, tx._id, "reject", { remark: "wrong amount" }).expect(200);
    expect(await summary()).toEqual({ sent: 0, received: 0, txCount: 0 });

    const res = await edit(alice, tx._id, { amount: 2000 }).expect(200);

    expect(res.body.message).toBe("Transaction resubmitted for review");
    expect(res.body.txn.status).toBe("pending");
    expect(res.body.txn.verified).toBe(false);
    expect(res.body.txn.rejectedBy).toBeUndefined();
    expect(res.body.txn.rejectedAt).toBeUndefined();
    expect(res.body.txn.rejectionRemark).toBeUndefined();
    expect(res.body.txn.editCount).toBe(1);
    expect(await summary()).toEqual({ sent: 2000, received: 2000, txCount: 1 });

    const stored = (await Tx.findById(tx._id).lean()) as any;
    expect(stored.rejectedBy).toBeUndefined();
    expect(stored.rejectionRemark).toBeUndefined();

    const note = await Notification.findOne({
      recipient: bob.id,
      type: "txn_reworked",
    }).lean();
    expect(note).toBeTruthy();
    expect(
      await Notification.findOne({ recipient: bob.id, type: "txn_edited" }),
    ).toBeNull();
  });
});
