import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { User } from "../src/models/userModel.js";
import { ExpenseCategory } from "../src/models/expenseCategoryModel.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  auth,
  adminCookie,
  type TestUser,
} from "./helpers.js";

/**
 * The HTTP surface of the saved expense categories: the list (with the
 * one-time first fill for accounts older than the feature), removal, the
 * version every new account starts at, and the account-deletion cascade.
 *
 * Supertest sends no `tzOffsetMinutes`, so the server works in UTC (offset 0)
 * and every date below is built in UTC to land in the intended month.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
let bob: TestUser;

beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
  bob = await registerUser(app, { name: "Bob" });
});

const CATEGORIES = "/api/v1/expenses/categories";
const as = (u: TestUser) => auth(u.accessToken);

/** Mid-month noon UTC, `back` months before the current UTC month. */
const monthsAgo = (back: number) => {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 15, 12),
  ).toISOString();
};

/** Make `user` look like an account created before this feature existed. */
const makeOld = (user: TestUser) =>
  User.updateOne({ _id: user.id }, { $unset: { expenseCategoriesVersion: 1 } });

const addExpense = (user: TestUser, category: string, date: string) =>
  request(app)
    .post("/api/v1/expenses")
    .set(as(user))
    .send({ amount: 100, date, category })
    .expect(201);

const list = (user: TestUser) => request(app).get(CATEGORIES).set(as(user)).expect(200);

/** An old account whose first fill finds "Food" (this month). */
const seedFood = async (user: TestUser) => {
  await makeOld(user);
  await addExpense(user, "Food", new Date().toISOString());
  const res = await list(user);
  expect(res.body.categories.map((c: { name: string }) => c.name)).toEqual(["Food"]);
  return { food: res.body.categories[0], version: res.body.version as number };
};

describe("the version on the profile", () => {
  it("registration starts a new account at version 0", async () => {
    const res = await request(app).get("/api/v1/users/profile").set(as(alice)).expect(200);
    expect(res.body.user.expenseCategoriesVersion).toBe(0);
  });

  it("an account older than the feature has no version on its profile", async () => {
    await makeOld(alice);
    const res = await request(app).get("/api/v1/users/profile").set(as(alice)).expect(200);
    expect(res.body.user).not.toHaveProperty("expenseCategoriesVersion");
  });
});

describe("GET /expenses/categories", () => {
  it("requires a token", async () => {
    await request(app).get(CATEGORIES).expect(401);
  });

  it("first fill on an old account takes this and last month only, once", async () => {
    await makeOld(alice);
    await addExpense(alice, "Food", new Date().toISOString());
    await addExpense(alice, "Fuel", monthsAgo(1));
    await addExpense(alice, "Rent", monthsAgo(2));

    const first = await list(alice);
    expect(first.body.success).toBe(true);
    expect(first.body.version).toBe(1);
    expect(first.body.categories).toEqual([
      { _id: expect.any(String), name: "Food", type: "debit" },
      { _id: expect.any(String), name: "Fuel", type: "debit" },
    ]);

    // The fill runs once; asking again changes nothing.
    const second = await list(alice);
    expect(second.body.version).toBe(1);
    expect(second.body.categories).toEqual(first.body.categories);
  });

  it("a new account gets version 0 and an empty list", async () => {
    // Even with expenses on record: a new account is already "filled".
    await addExpense(alice, "Food", new Date().toISOString());

    const res = await list(alice);
    expect(res.body).toEqual({ success: true, version: 0, categories: [] });
  });

  it("lists only the caller's own categories", async () => {
    await seedFood(alice);
    const res = await list(bob);
    expect(res.body.categories).toEqual([]);
  });
});

describe("DELETE /expenses/categories/:id", () => {
  it("removes an own category and raises the version by 1", async () => {
    const { food, version } = await seedFood(alice);

    const res = await request(app)
      .delete(`${CATEGORIES}/${food._id}`)
      .set(as(alice))
      .expect(200);
    expect(res.body).toEqual({ success: true, categoriesVersion: version + 1 });

    const after = await list(alice);
    expect(after.body.version).toBe(version + 1);
    expect(after.body.categories).toEqual([]);
  });

  it("returns 404 for another user's category and leaves it in place", async () => {
    const { food } = await seedFood(bob);

    const res = await request(app)
      .delete(`${CATEGORIES}/${food._id}`)
      .set(as(alice))
      .expect(404);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBe("Category not found");

    expect(await ExpenseCategory.countDocuments({ _id: food._id })).toBe(1);
  });

  it("returns 404 for an id that does not exist", async () => {
    await request(app)
      .delete(`${CATEGORIES}/${new mongoose.Types.ObjectId()}`)
      .set(as(alice))
      .expect(404);
  });

  it("rejects an invalid id with 400", async () => {
    await request(app).delete(`${CATEGORIES}/abc`).set(as(alice)).expect(400);
  });

  it("requires a token", async () => {
    await request(app)
      .delete(`${CATEGORIES}/${new mongoose.Types.ObjectId()}`)
      .expect(401);
  });
});

describe("account deletion", () => {
  it("deleting an account removes its categories and no one else's", async () => {
    await seedFood(alice);
    await seedFood(bob);

    const cookie = await adminCookie(app);
    await request(app)
      .delete(`/api/v1/admin/users/${alice.id}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(await ExpenseCategory.countDocuments({ userId: alice.id })).toBe(0);
    expect(await ExpenseCategory.countDocuments({ userId: bob.id })).toBe(1);
  });
});
