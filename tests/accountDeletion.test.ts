import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { User } from "../src/models/userModel.js";
import { Chat } from "../src/models/chatModel.js";
import { Tx } from "../src/models/txModel.js";
import { Note } from "../src/models/noteModel.js";
import { Expense } from "../src/models/expenseModel.js";
import { ExpenseLedger } from "../src/models/expenseLedgerModel.js";
import { ExpenseCategory } from "../src/models/expenseCategoryModel.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  befriend,
  auth,
  adminCookie,
  createNote,
  type TestUser,
} from "./helpers.js";

/**
 * Self-service account deletion: the caller proves ownership with their
 * password, then the same cascade the admin route uses removes everything.
 */

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

const DELETE = "/api/v1/users/delete-account";

/** Give alice an expense, a ledger and a category, plus a chat tx and notes. */
const seed = async () => {
  const ledger = await ExpenseLedger.create({ userId: alice.id, year: 2026, month: 1 });
  await Expense.create({
    userId: alice.id,
    ledgerId: ledger._id,
    amount: 100,
    type: "debit",
    date: new Date(),
  });
  await ExpenseCategory.create({
    userId: alice.id,
    type: "debit",
    name: "Food",
    key: "food",
  });
  await request(app)
    .post("/api/v1/txns/createtx")
    .set(auth(alice.accessToken))
    .send({
      chatId,
      amount: 15000,
      date: new Date().toISOString(),
      from: alice.id,
      to: bob.id,
      remarks: "lunch",
    })
    .expect(201);
};

describe("DELETE self-service account", () => {
  it("rejects a wrong password and deletes nothing", async () => {
    await seed();
    await request(app)
      .post(DELETE)
      .set(auth(alice.accessToken))
      .send({ password: "not-the-password" })
      .expect(400);

    expect(await User.countDocuments({ _id: alice.id })).toBe(1);
    expect(await Expense.countDocuments({ userId: alice.id })).toBe(1);
  });

  it("rejects a request with no token", async () => {
    await request(app).post(DELETE).send({ password: alice.password }).expect(401);
    expect(await User.countDocuments({ _id: alice.id })).toBe(1);
  });

  it("deletes the account and everything hanging off it", async () => {
    await seed();
    const mine = await createNote(app, alice, { title: "mine" });
    const bobs = await createNote(app, bob, { title: "bobs" });
    await request(app)
      .put(`/api/v1/notes/${bobs._id}/shares`)
      .set(auth(bob.accessToken))
      .send({ shares: [{ userId: alice.id, permission: "view" }] })
      .expect(200);

    await request(app)
      .post(DELETE)
      .set(auth(alice.accessToken))
      .send({ password: alice.password })
      .expect(200)
      .expect((r) => {
        expect(r.body.success).toBe(true);
        expect(r.body.message).toBe("Account deleted");
      });

    expect(await User.countDocuments({ _id: alice.id })).toBe(0);
    const friend = await User.findById(bob.id).lean<any>();
    expect(friend.friends.map(String)).not.toContain(alice.id);
    expect(await Chat.countDocuments({ _id: chatId })).toBe(0);
    expect(await Tx.countDocuments({ chatId })).toBe(0);
    expect(await Note.countDocuments({ _id: mine._id })).toBe(0);

    const kept = await Note.findById(bobs._id).lean<any>();
    expect(kept).not.toBeNull();
    expect(kept.shares.map((s: any) => String(s.user))).not.toContain(alice.id);

    expect(await Expense.countDocuments({ userId: alice.id })).toBe(0);
    expect(await ExpenseLedger.countDocuments({ userId: alice.id })).toBe(0);
    expect(await ExpenseCategory.countDocuments({ userId: alice.id })).toBe(0);
  });

  it("leaves the old tokens useless", async () => {
    await request(app)
      .post(DELETE)
      .set(auth(alice.accessToken))
      .send({ password: alice.password })
      .expect(200);

    const refresh = await request(app)
      .post("/api/v1/users/refresh")
      .send({ refreshToken: alice.refreshToken });
    expect(refresh.status).not.toBe(200);

    const profile = await request(app)
      .get("/api/v1/users/profile")
      .set(auth(alice.accessToken));
    expect(profile.status).not.toBe(200);
  });

  it("still lets the admin route delete a user through the shared service", async () => {
    await seed();
    const cookie = await adminCookie(app);
    await request(app)
      .delete(`/api/v1/admin/users/${alice.id}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(await User.countDocuments({ _id: alice.id })).toBe(0);
    expect(await Expense.countDocuments({ userId: alice.id })).toBe(0);
    expect(await Chat.countDocuments({ _id: chatId })).toBe(0);
  });
});
