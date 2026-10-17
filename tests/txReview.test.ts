import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { Tx } from "../src/models/txModel.js";
import { MonthlySummary } from "../src/models/monthlySummaryModel.js";
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

const stored = async (id: string) => (await Tx.findById(id).lean()) as any;

describe("reviewTxn — expectedUpdatedAt", () => {
  it("stale verify after a creator edit → 409 with latest txn, not verified", async () => {
    const tx = await createTx(15000);
    await edit(alice, tx._id, { amount: 1500 }).expect(200);

    const res = await review(bob, tx._id, "verify", {
      expectedUpdatedAt: tx.updatedAt, // what Bob saw before the edit
    }).expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe(
      "This transaction was changed. Please check it again.",
    );
    expect(res.body.txn.amount).toBe(1500);
    expect(res.body.txn.status).toBe("pending");

    const s = await stored(tx._id);
    expect(s.status).toBe("pending");
    expect(s.verifiedBy).toBeUndefined();
    expect(await summary()).toEqual({ sent: 1500, received: 1500, txCount: 1 });
  });

  it("stale reject after a creator edit → 409, summary untouched", async () => {
    const tx = await createTx(15000);
    await edit(alice, tx._id, { amount: 1500 }).expect(200);

    await review(bob, tx._id, "reject", {
      remark: "no",
      expectedUpdatedAt: tx.updatedAt,
    }).expect(409);

    expect((await stored(tx._id)).status).toBe("pending");
    expect(await summary()).toEqual({ sent: 1500, received: 1500, txCount: 1 });
  });

  it("fresh verify (current updatedAt) works", async () => {
    const tx = await createTx(15000);
    const res = await review(bob, tx._id, "verify", {
      expectedUpdatedAt: tx.updatedAt,
    }).expect(200);

    expect(res.body.message).toBe("Transaction verified successfully");
    expect(res.body.txn.status).toBe("verified");
    expect(res.body.txn.verified).toBe(true);
    const s = await stored(tx._id);
    expect(s.status).toBe("verified");
    expect(String(s.verifiedBy)).toBe(bob.id);
    expect(s.verifiedAt).toBeTruthy();
    expect(await summary()).toEqual({ sent: 15000, received: 15000, txCount: 1 });
  });

  it("verify without expectedUpdatedAt still works (old builds)", async () => {
    const tx = await createTx(15000);
    await edit(alice, tx._id, { amount: 1500 }).expect(200);

    await review(bob, tx._id, "verify").expect(200);
    expect((await stored(tx._id)).status).toBe("verified");
  });

  it("reject removes the txn from the summary using the stored values", async () => {
    const tx = await createTx(15000);
    await edit(alice, tx._id, { amount: 1500 }).expect(200);

    const res = await review(bob, tx._id, "reject", { remark: "wrong" }).expect(
      200,
    );
    expect(res.body.message).toBe("Transaction rejected successfully");
    expect(res.body.txn.status).toBe("rejected");
    expect(res.body.txn.rejectionRemark).toBe("wrong");
    const s = await stored(tx._id);
    expect(String(s.rejectedBy)).toBe(bob.id);
    expect(s.verifiedBy).toBeUndefined();
    expect(await summary()).toEqual({ sent: 0, received: 0, txCount: 0 });
  });
});

describe("reviewTxn — races", () => {
  it("two concurrent rejects: exactly one succeeds and the summary is decremented once", async () => {
    const tx = await createTx(15000);
    const other = await createTx(500); // keeps the summary non-zero
    expect(await summary()).toEqual({ sent: 15500, received: 15500, txCount: 2 });

    const [a, b] = await Promise.all([
      review(bob, tx._id, "reject", { remark: "x" }),
      review(bob, tx._id, "reject", { remark: "y" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(await summary()).toEqual({ sent: 500, received: 500, txCount: 1 });
    expect((await stored(tx._id)).status).toBe("rejected");
    expect((await stored(other._id)).status).toBe("pending");
  });

  it("concurrent verify + reject: exactly one wins and the summary matches the final status", async () => {
    const tx = await createTx(15000);

    const [v, r] = await Promise.all([
      review(bob, tx._id, "verify"),
      review(bob, tx._id, "reject", { remark: "no" }),
    ]);

    expect([v.status, r.status].sort()).toEqual([200, 400]);
    const s = await stored(tx._id);
    if (v.status === 200) {
      expect(s.status).toBe("verified");
      expect(s.rejectedBy).toBeUndefined();
      expect(await summary()).toEqual({
        sent: 15000,
        received: 15000,
        txCount: 1,
      });
    } else {
      expect(s.status).toBe("rejected");
      expect(s.verifiedBy).toBeUndefined();
      expect(await summary()).toEqual({ sent: 0, received: 0, txCount: 0 });
    }
  });

  it("review racing a creator edit (both with the same updatedAt): exactly one wins, summary consistent", async () => {
    const tx = await createTx(15000);

    const [e, r] = await Promise.all([
      edit(alice, tx._id, { amount: 1500, expectedUpdatedAt: tx.updatedAt }),
      review(bob, tx._id, "reject", {
        remark: "no",
        expectedUpdatedAt: tx.updatedAt,
      }),
    ]);

    const s = await stored(tx._id);
    if (e.status === 200) {
      expect(r.status).toBe(409);
      expect(s.status).toBe("pending");
      expect(await summary()).toEqual({ sent: 1500, received: 1500, txCount: 1 });
    } else {
      expect(r.status).toBe(200);
      expect(s.status).toBe("rejected");
      expect(await summary()).toEqual({ sent: 0, received: 0, txCount: 0 });
    }
  });
});

describe("reviewTxn — existing behaviour", () => {
  it("creator cannot verify or reject their own transaction → 403", async () => {
    const tx = await createTx();
    const v = await review(alice, tx._id, "verify").expect(403);
    expect(v.body.message).toBe("You cannot verify your own transaction");
    const r = await review(alice, tx._id, "reject").expect(403);
    expect(r.body.message).toBe("You cannot reject your own transaction");
    expect((await stored(tx._id)).status).toBe("pending");
  });

  it("non-pending transaction → 400", async () => {
    const tx = await createTx();
    await review(bob, tx._id, "verify").expect(200);

    const res = await review(bob, tx._id, "reject").expect(400);
    expect(res.body.message).toBe("Only pending transactions can be rejected");
    expect(await summary()).toEqual({ sent: 15000, received: 15000, txCount: 1 });
  });

  it("missing transaction → 404; outsider → 403", async () => {
    await review(bob, "000000000000000000000000", "verify").expect(404);
    const tx = await createTx();
    const mallory = await registerUser(app, { name: "Mallory" });
    await review(mallory, tx._id, "verify").expect(403);
  });
});
