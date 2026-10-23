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
import { User } from "../src/models/userModel.js";
import { ExpenseCategory } from "../src/models/expenseCategoryModel.js";
import {
  MAX_CATEGORIES_PER_USER,
  listCategories,
  type CategoryType,
} from "../src/services/expenseCategories.js";

/**
 * Expense add/edit with the `newCategory` flag (spec 6.3): the category is
 * added inside the expense's own transaction, the reply carries the stored
 * row and the new version, and a save never fails because of the category.
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

// Versions are set directly so these tests do not depend on what `register`
// writes (another card owns that).
const setVersion = (version: number) =>
  User.updateOne({ _id: user.id }, { $set: { expenseCategoriesVersion: version } });
const unsetVersion = () =>
  User.updateOne({ _id: user.id }, { $unset: { expenseCategoriesVersion: "" } });

/** Read the raw user document, so a missing field stays missing. */
const rawUser = () =>
  User.collection.findOne({ _id: new mongoose.Types.ObjectId(user.id) });
const versionOf = async () =>
  (await rawUser())?.expenseCategoriesVersion as number | undefined;
const hasVersionField = async () => {
  const doc = await rawUser();
  return doc !== null && "expenseCategoriesVersion" in doc;
};

const categoriesOf = () =>
  ExpenseCategory.find({ userId: user.id })
    .sort({ key: 1, type: 1 })
    .lean<{ _id: unknown; name: string; key: string; type: CategoryType }[]>();

const seedCategory = (name: string, type: CategoryType = "debit") =>
  ExpenseCategory.create({ userId: user.id, type, name, key: name.toLowerCase() });

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

describe("POST /expenses with newCategory", () => {
  it("adds a new category and replies with it and the bumped version", async () => {
    await setVersion(0);

    const res = await post({ category: "Groceries", newCategory: true }).expect(201);

    expect(res.body.category).toMatchObject({ name: "Groceries", type: "debit" });
    expect(typeof res.body.category._id).toBe("string");
    expect(res.body.categoriesVersion).toBe(1);
    expect(res.body.expense.category).toBe("Groceries");

    const rows = await categoriesOf();
    expect(rows.map((r) => [r.type, r.name])).toEqual([["debit", "Groceries"]]);
    expect(String(rows[0]._id)).toBe(res.body.category._id);
    expect(await versionOf()).toBe(1);
  });

  it("saves the stored spelling when the name already exists, without a version", async () => {
    const stored = await seedCategory("Groceries");
    await setVersion(1);

    const res = await post({ category: "groceries", newCategory: true }).expect(201);

    expect(res.body.expense.category).toBe("Groceries");
    const saved = await Expense.findById(res.body.expense._id).lean<{ category?: string }>();
    expect(saved!.category).toBe("Groceries");

    expect(res.body.category).toMatchObject({
      _id: String(stored._id),
      name: "Groceries",
      type: "debit",
    });
    expect(res.body).not.toHaveProperty("categoriesVersion");
    expect(await categoriesOf()).toHaveLength(1);
    expect(await versionOf()).toBe(1);
  });

  it("leaves the table and version alone without the flag", async () => {
    await setVersion(0);

    const res = await post({ category: "Snacks" }).expect(201);

    expect(res.body.expense.category).toBe("Snacks");
    expect(res.body).not.toHaveProperty("category");
    expect(res.body).not.toHaveProperty("categoriesVersion");
    expect(await categoriesOf()).toHaveLength(0);
    expect(await versionOf()).toBe(0);
  });

  it(`still saves at ${MAX_CATEGORIES_PER_USER} categories, with the typed category and neither reply field`, async () => {
    await ExpenseCategory.insertMany(
      Array.from({ length: MAX_CATEGORIES_PER_USER }, (_, i) => ({
        userId: user.id,
        type: i % 2 === 0 ? "debit" : "credit",
        name: `Cat ${i}`,
        key: `cat ${i}`,
      })),
    );
    await setVersion(5);

    const res = await post({ category: "Brand New", newCategory: true }).expect(201);

    expect(res.body.expense.category).toBe("Brand New");
    expect(res.body).not.toHaveProperty("category");
    expect(res.body).not.toHaveProperty("categoriesVersion");
    expect(await ExpenseCategory.countDocuments({ userId: user.id })).toBe(
      MAX_CATEGORIES_PER_USER,
    );
    expect(await versionOf()).toBe(5);
  });

  /**
   * Review Focus 1. Both saves race on the same new name: the loser hits a
   * write conflict, `withTransaction` re-runs it, and the retry finds the
   * winner's row. A duplicate key must never abort a save.
   */
  it("two concurrent flagged saves of one new name give one row and one bump", async () => {
    await setVersion(0);

    const [a, b] = await Promise.all([
      post({ category: "Taxi", newCategory: true }),
      post({ category: "Taxi", newCategory: true }),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.expense.category).toBe("Taxi");
    expect(b.body.expense.category).toBe("Taxi");

    const rows = await categoriesOf();
    expect(rows.map((r) => [r.type, r.name])).toEqual([["debit", "Taxi"]]);
    expect(await versionOf()).toBe(1);
    expect(await Expense.countDocuments({ userId: user.id })).toBe(2);

    // Exactly one reply carries the bump; the other found the row existing.
    const versions = [a.body.categoriesVersion, b.body.categoriesVersion];
    expect(versions.filter((v) => v === 1)).toHaveLength(1);
    expect(versions.filter((v) => v === undefined)).toHaveLength(1);
  });

  /**
   * Review Focus 5. An account older than the feature saves a new category
   * before its first fill: the row is stored, the version stays missing, and
   * the next list (which runs the fill) includes it with a version ≥ 1.
   */
  it("stores the category on a never-filled account and keeps the version missing", async () => {
    await unsetVersion();
    expect(await hasVersionField()).toBe(false);

    const res = await post({ category: "Books", newCategory: true }).expect(201);

    expect(res.body.category).toMatchObject({ name: "Books", type: "debit" });
    expect(res.body).not.toHaveProperty("categoriesVersion");
    expect((await categoriesOf()).map((r) => r.name)).toEqual(["Books"]);
    expect(await hasVersionField()).toBe(false);

    const listed = await listCategories(user.id, 0);
    expect(listed.categories.map((c) => c.name)).toContain("Books");
    expect(listed.version).toBeGreaterThanOrEqual(1);
  });
});

describe("PUT /expenses/:id with newCategory", () => {
  it("creates the category for the type after the edit (debit → credit)", async () => {
    await seedCategory("Groceries", "debit");
    await setVersion(1);
    const created = await post({ category: "Groceries" }).expect(201);

    const res = await put(created.body.expense._id, {
      type: "credit",
      category: "Groceries",
      newCategory: true,
    }).expect(200);

    expect(res.body.expense.type).toBe("credit");
    expect(res.body.expense.category).toBe("Groceries");
    expect(res.body.category).toMatchObject({ name: "Groceries", type: "credit" });
    expect(res.body.categoriesVersion).toBe(2);

    const rows = await categoriesOf();
    expect(rows.map((r) => [r.type, r.name])).toEqual([
      ["credit", "Groceries"],
      ["debit", "Groceries"],
    ]);
    expect(await versionOf()).toBe(2);
  });

  it("saves the stored spelling on edit when the name already exists", async () => {
    await seedCategory("Food court", "debit");
    await setVersion(3);
    const created = await post({ category: "Lunch" }).expect(201);

    const res = await put(created.body.expense._id, {
      category: "  food   COURT ",
      newCategory: true,
    }).expect(200);

    expect(res.body.expense.category).toBe("Food court");
    const saved = await Expense.findById(created.body.expense._id).lean<{ category?: string }>();
    expect(saved!.category).toBe("Food court");
    expect(res.body.category).toMatchObject({ name: "Food court", type: "debit" });
    expect(res.body).not.toHaveProperty("categoriesVersion");
    expect(await versionOf()).toBe(3);
  });

  it("leaves the table and version alone on an amount-only edit", async () => {
    await seedCategory("Groceries", "debit");
    await setVersion(1);
    const created = await post({ category: "Fodo" }).expect(201);

    const res = await put(created.body.expense._id, { amount: 250 }).expect(200);

    expect(res.body.expense.amount).toBe(250);
    expect(res.body.expense.category).toBe("Fodo");
    expect(res.body).not.toHaveProperty("category");
    expect(res.body).not.toHaveProperty("categoriesVersion");
    expect((await categoriesOf()).map((r) => r.name)).toEqual(["Groceries"]);
    expect(await versionOf()).toBe(1);
  });
});
