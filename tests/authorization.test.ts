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
let mallory: TestUser;
let chatId: string;

beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
  bob = await registerUser(app, { name: "Bob" });
  mallory = await registerUser(app, { name: "Mallory" });
  chatId = await befriend(app, alice, bob);
});

/**
 * BE-006. `getChatStats` and `getChatMonths` were authenticated but never
 * checked membership, so any signed-in user could read any pair's balances by
 * iterating ObjectIds. `exportChatLedger` — in the same file — did check.
 */
describe("BE-006 — IDOR on chat statistics", () => {
  it("lets a member read their own chat stats", async () => {
    await request(app)
      .get(`/api/v1/stats/chat/${chatId}`)
      .set(auth(alice.accessToken))
      .expect(200);
  });

  it("refuses a non-member reading chat stats", async () => {
    await request(app)
      .get(`/api/v1/stats/chat/${chatId}`)
      .set(auth(mallory.accessToken))
      .expect(404);
  });

  it("refuses a non-member reading the months list", async () => {
    await request(app)
      .get(`/api/v1/stats/chat/${chatId}/months`)
      .set(auth(mallory.accessToken))
      .expect(404);
  });

  it("refuses a non-member exporting the ledger", async () => {
    await request(app)
      .get(`/api/v1/stats/chat/${chatId}/export`)
      .set(auth(mallory.accessToken))
      .query({ year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() + 1 })
      .expect(404);
  });

  it("returns 404 rather than 403, so ids cannot be probed for existence", async () => {
    const real = await request(app)
      .get(`/api/v1/stats/chat/${chatId}`)
      .set(auth(mallory.accessToken));

    const fake = await request(app)
      .get("/api/v1/stats/chat/000000000000000000000000")
      .set(auth(mallory.accessToken));

    // Identical responses: an attacker learns nothing about which ids exist.
    expect(real.status).toBe(fake.status);
    expect(real.body.message).toBe(fake.body.message);
  });

  it("refuses an unauthenticated caller entirely", async () => {
    await request(app).get(`/api/v1/stats/chat/${chatId}`).expect(401);
  });
});

describe("Transaction ownership", () => {
  it("refuses a non-member listing a chat's transactions", async () => {
    await request(app)
      .get(`/api/v1/txns/gettx/${chatId}`)
      .set(auth(mallory.accessToken))
      .expect(403);
  });

  it("refuses a non-member adding a transaction to the chat", async () => {
    await request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(mallory.accessToken))
      .send({
        chatId,
        amount: 100,
        date: new Date().toISOString(),
        from: mallory.id,
        to: alice.id,
      })
      .expect(403);
  });

  it("refuses a transaction naming a participant outside the chat", async () => {
    // validateTxnParticipants: money must not be attributed to someone who was
    // never part of the conversation.
    await request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(alice.accessToken))
      .send({
        chatId,
        amount: 100,
        date: new Date().toISOString(),
        from: alice.id,
        to: mallory.id,
      })
      .expect(400);
  });

  it("refuses a transaction from a user to themselves", async () => {
    await request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(alice.accessToken))
      .send({
        chatId,
        amount: 100,
        date: new Date().toISOString(),
        from: alice.id,
        to: alice.id,
      })
      .expect(400);
  });
});

/**
 * The editTxn hole: the route had no schema and the handler assigned `to`/
 * `from` straight onto the document without re-running participant
 * validation, so arbitrary ids could be written into a ledger.
 */
describe("editTxn — participants are re-validated", () => {
  it("refuses an edit that redirects the transaction to an outsider", async () => {
    const created = await request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(alice.accessToken))
      .send({
        chatId,
        amount: 100,
        date: new Date().toISOString(),
        from: alice.id,
        to: bob.id,
      })
      .expect(201);

    const txnId = created.body.txn?._id ?? created.body._id;

    // Bob rejects it so Alice is allowed to edit.
    await request(app)
      .post("/api/v1/txns/reviewtx")
      .set(auth(bob.accessToken))
      .send({ txnId, action: "reject", remark: "wrong amount" })
      .expect(200);

    await request(app)
      .put(`/api/v1/txns/edittx/${txnId}`)
      .set(auth(alice.accessToken))
      .send({ to: mallory.id })
      .expect(400);
  });

  it("rejects a malformed user id in an edit", async () => {
    await request(app)
      .put("/api/v1/txns/edittx/000000000000000000000000")
      .set(auth(alice.accessToken))
      .send({ to: "not-an-id" })
      .expect(400);
  });
});

describe("Admin routes require the admin role", () => {
  it("refuses a normal user's access token on an admin route", async () => {
    // A user access token must not satisfy `adminOnly` — the type claim is
    // what distinguishes them.
    await request(app)
      .get("/api/v1/admin/users")
      .set(auth(alice.accessToken))
      .expect(401);

    await request(app)
      .delete(`/api/v1/admin/users/${bob.id}`)
      .set(auth(alice.accessToken))
      .expect(401);
  });
});
