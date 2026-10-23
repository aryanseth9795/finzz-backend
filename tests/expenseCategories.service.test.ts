import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { connect, disconnect, resetDb, syncIndexes, nextPhone } from "./helpers.js";
import { User } from "../src/models/userModel.js";
import { Expense } from "../src/models/expenseModel.js";
import { ExpenseLedger } from "../src/models/expenseLedgerModel.js";
import { ExpenseCategory } from "../src/models/expenseCategoryModel.js";
import { periodOf } from "../src/utils/dates.js";
import {
  MAX_CATEGORIES_PER_USER,
  FIRST_FILL_ROW_LIMIT,
  normalizeCategoryName,
  categoryKey,
  isStorableCategory,
  firstFillIfNeeded,
  listCategories,
  addCategoryIfNew,
  removeCategory,
  type CategoryType,
} from "../src/services/expenseCategories.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(resetDb);

// IST, so the month boundaries are computed in a non-UTC frame the same way
// the controller will pass them.
const TZ = 330;
const MIN = 60_000;
const DAY = 86_400_000;

const makeUser = (extra: Record<string, unknown> = {}) =>
  User.create({
    name: "Category User",
    phone: nextPhone(),
    password: "Passw0rd!",
    ...extra,
  });

const userId = (u: { _id: unknown }) => String(u._id);

/** Read the raw user document, so a missing field stays missing. */
const versionOf = async (id: string) => {
  const doc = await User.collection.findOne({
    _id: new mongoose.Types.ObjectId(id),
  });
  return doc?.expenseCategoriesVersion as number | undefined;
};
const hasVersionField = async (id: string) => {
  const doc = await User.collection.findOne({
    _id: new mongoose.Types.ObjectId(id),
  });
  return doc !== null && "expenseCategoriesVersion" in doc;
};

/** `{ year, month }` shifted by whole months, with the year rollover. */
const shiftPeriod = (p: { year: number; month: number }, by: number) => {
  const index = p.year * 12 + (p.month - 1) + by;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
};

/** Ledgers for the current month and the two before it, in the user's frame. */
const makeLedgers = async (id: string) => {
  const cur = periodOf(new Date(), TZ);
  const [current, previous, older] = await Promise.all(
    [0, -1, -2].map((by) =>
      ExpenseLedger.create({ userId: id, ...shiftPeriod(cur, by) }),
    ),
  );
  return { current, previous, older };
};

interface Row {
  ledgerId: unknown;
  category?: string | null;
  type?: CategoryType;
  /** Minutes before now; larger is older. */
  ago?: number;
}

const seedExpenses = (id: string, rows: Row[]) =>
  Expense.insertMany(
    rows.map((r) => ({
      userId: id,
      ledgerId: r.ledgerId,
      amount: 10,
      type: r.type ?? "debit",
      date: new Date(Date.now() - (r.ago ?? 0) * MIN),
      ...(r.category !== undefined ? { category: r.category } : {}),
    })),
  );

const storedNames = async (id: string) =>
  (await ExpenseCategory.find({ userId: id }).sort({ key: 1, type: 1 }).lean()).map(
    (c: any) => `${c.type}:${c.name}`,
  );

const seedCategories = (id: string, names: string[], type: CategoryType = "debit") =>
  ExpenseCategory.insertMany(
    names.map((name) => ({ userId: id, type, name, key: name.toLowerCase() })),
  );

/** Run `fn` inside a real transaction, the way the expense controller will. */
const inTxn = async <T>(fn: (session: mongoose.ClientSession) => Promise<T>) => {
  const session = await mongoose.startSession();
  try {
    let out!: T;
    await session.withTransaction(async () => {
      out = await fn(session);
    });
    return out;
  } finally {
    await session.endSession();
  }
};

describe("normalising", () => {
  it("trims and collapses inner whitespace, keeping the spelling", () => {
    expect(normalizeCategoryName("  Food   court ")).toBe("Food court");
    expect(normalizeCategoryName("Food\t\n court")).toBe("Food court");
    expect(normalizeCategoryName("Food")).toBe("Food");
  });

  it("keys are the normalised name lowercased", () => {
    expect(categoryKey("  FOOD  Court")).toBe("food court");
    expect(categoryKey("Food court")).toBe(categoryKey("  food   COURT "));
  });

  it("never treats blank, '-' or a non-string as storable", () => {
    expect(isStorableCategory("-")).toBe(false);
    expect(isStorableCategory(" - ")).toBe(false);
    expect(isStorableCategory("   ")).toBe(false);
    expect(isStorableCategory("")).toBe(false);
    expect(isStorableCategory(42)).toBe(false);
    expect(isStorableCategory(null)).toBe(false);
    expect(isStorableCategory(undefined)).toBe(false);
    expect(isStorableCategory("Food")).toBe(true);
    expect(isStorableCategory("  Food   court ")).toBe(true);
  });

  it("rejects names over 50 characters after normalising", () => {
    expect(isStorableCategory("x".repeat(50))).toBe(true);
    expect(isStorableCategory(`  ${"x".repeat(50)}  `)).toBe(true);
    expect(isStorableCategory("x".repeat(51))).toBe(false);
  });
});

describe("firstFillIfNeeded", () => {
  it("takes categories only from the current and previous month", async () => {
    const u = await makeUser();
    const { current, previous, older } = await makeLedgers(userId(u));
    await seedExpenses(userId(u), [
      { ledgerId: current._id, category: "Food", ago: 1 },
      { ledgerId: previous._id, category: "Fuel", ago: 35 * 24 * 60 },
      { ledgerId: older._id, category: "Rent", ago: 65 * 24 * 60 },
    ]);

    await firstFillIfNeeded(userId(u), TZ);

    expect(await storedNames(userId(u))).toEqual(["debit:Food", "debit:Fuel"]);
    expect(await versionOf(userId(u))).toBe(1);
  });

  it("skips blank, null and '-' categories, including legacy untrimmed rows", async () => {
    const u = await makeUser();
    const { current } = await makeLedgers(userId(u));
    const ledgerId = current._id;
    // Written through the driver so the schema's `trim` cannot tidy them up:
    // these are the shapes old rows can actually have in the collection.
    await Expense.collection.insertMany(
      [null, "", "-", "   ", " - ", undefined].map((category, i) => ({
        userId: u._id,
        ledgerId,
        amount: 10,
        type: "debit",
        date: new Date(Date.now() - i * MIN),
        ...(category !== undefined ? { category } : {}),
      })),
    );
    await seedExpenses(userId(u), [{ ledgerId, category: "Food", ago: 30 }]);

    await firstFillIfNeeded(userId(u), TZ);

    expect(await storedNames(userId(u))).toEqual(["debit:Food"]);
  });

  it("merges case variants into one record with the newest spelling", async () => {
    const u = await makeUser();
    const { current, previous } = await makeLedgers(userId(u));
    await seedExpenses(userId(u), [
      { ledgerId: previous._id, category: "food", ago: 35 * 24 * 60 },
      { ledgerId: current._id, category: "Food", ago: 1 },
      { ledgerId: current._id, category: "  food   COURT ", ago: 2 },
    ]);

    await firstFillIfNeeded(userId(u), TZ);

    const rows = await ExpenseCategory.find({ userId: userId(u) }).sort({ key: 1 }).lean();
    expect(rows.map((r: any) => [r.name, r.key])).toEqual([
      ["Food", "food"],
      ["food COURT", "food court"],
    ]);
  });

  it("keeps debit and credit categories of the same name apart", async () => {
    const u = await makeUser();
    const { current } = await makeLedgers(userId(u));
    await seedExpenses(userId(u), [
      { ledgerId: current._id, category: "Food", type: "debit", ago: 1 },
      { ledgerId: current._id, category: "Food", type: "credit", ago: 2 },
    ]);

    await firstFillIfNeeded(userId(u), TZ);

    expect(await storedNames(userId(u))).toEqual(["credit:Food", "debit:Food"]);
    expect(await versionOf(userId(u))).toBe(1);
  });

  it("sets version 0 when nothing is found", async () => {
    const u = await makeUser();
    const { current } = await makeLedgers(userId(u));
    await seedExpenses(userId(u), [{ ledgerId: current._id, category: "-" }]);

    await firstFillIfNeeded(userId(u), TZ);

    expect(await storedNames(userId(u))).toEqual([]);
    expect(await versionOf(userId(u))).toBe(0);
  });

  it("works for a user with no ledgers at all", async () => {
    const u = await makeUser();

    await firstFillIfNeeded(userId(u), TZ);

    expect(await versionOf(userId(u))).toBe(0);
  });

  it("runs only once: removing everything and calling again re-adds nothing", async () => {
    const u = await makeUser();
    const { current } = await makeLedgers(userId(u));
    await seedExpenses(userId(u), [{ ledgerId: current._id, category: "Food" }]);

    await firstFillIfNeeded(userId(u), TZ);
    await ExpenseCategory.deleteMany({ userId: userId(u) });
    await firstFillIfNeeded(userId(u), TZ);

    expect(await storedNames(userId(u))).toEqual([]);
    expect(await versionOf(userId(u))).toBe(1);
  });

  it("does nothing for an account whose version is already set", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 0 });
    const { current } = await makeLedgers(userId(u));
    await seedExpenses(userId(u), [{ ledgerId: current._id, category: "Food" }]);

    await firstFillIfNeeded(userId(u), TZ);

    expect(await storedNames(userId(u))).toEqual([]);
    expect(await versionOf(userId(u))).toBe(0);
  });

  it("keeps a category saved before the fill and reports version 1", async () => {
    // An old account flagged "Books" on a save before its first launch sync:
    // the record exists but the version is still missing (Review Focus 5).
    const u = await makeUser();
    await seedCategories(userId(u), ["Books"]);

    await firstFillIfNeeded(userId(u), TZ);

    expect(await storedNames(userId(u))).toEqual(["debit:Books"]);
    expect(await versionOf(userId(u))).toBe(1);
  });
});

describe("firstFillIfNeeded limits", () => {
  it(`reads at most ${FIRST_FILL_ROW_LIMIT} rows, newest first`, async () => {
    const u = await makeUser();
    const { current } = await makeLedgers(userId(u));
    // The newest 1,000 rows cycle through 100 names, so the 200-category limit
    // is never reached. The 5 oldest rows each have a name of their own: they
    // can only be missing because the row limit stopped the read.
    const rows: Row[] = [];
    for (let i = 0; i < FIRST_FILL_ROW_LIMIT; i++) {
      rows.push({ ledgerId: current._id, category: `Cat ${i % 100}`, ago: i });
    }
    for (let i = 0; i < 5; i++) {
      rows.push({ ledgerId: current._id, category: `Old ${i}`, ago: FIRST_FILL_ROW_LIMIT + i });
    }
    await seedExpenses(userId(u), rows);

    await firstFillIfNeeded(userId(u), TZ);

    const keys = (await ExpenseCategory.find({ userId: userId(u) }).lean()).map(
      (c: any) => c.key,
    );
    expect(keys).toHaveLength(100);
    expect(keys.filter((k: string) => k.startsWith("old"))).toEqual([]);
  });

  it(`stores at most ${MAX_CATEGORIES_PER_USER} categories, keeping the newest`, async () => {
    const u = await makeUser();
    const { current } = await makeLedgers(userId(u));
    await seedExpenses(
      userId(u),
      Array.from({ length: 250 }, (_, i) => ({
        ledgerId: current._id,
        category: `Name ${i}`,
        ago: i,
      })),
    );

    await firstFillIfNeeded(userId(u), TZ);

    const keys = new Set(
      (await ExpenseCategory.find({ userId: userId(u) }).lean()).map((c: any) => c.key),
    );
    expect(keys.size).toBe(MAX_CATEGORIES_PER_USER);
    expect(keys.has("name 0")).toBe(true);
    expect(keys.has("name 199")).toBe(true);
    expect(keys.has("name 200")).toBe(false);
    expect(keys.has("name 249")).toBe(false);
  });

  it("counts categories saved before the fill against the limit", async () => {
    const u = await makeUser();
    await seedCategories(
      userId(u),
      Array.from({ length: 195 }, (_, i) => `Saved ${i}`),
    );
    const { current } = await makeLedgers(userId(u));
    await seedExpenses(
      userId(u),
      Array.from({ length: 10 }, (_, i) => ({
        ledgerId: current._id,
        category: `New ${i}`,
        ago: i,
      })),
    );

    await firstFillIfNeeded(userId(u), TZ);

    expect(await ExpenseCategory.countDocuments({ userId: userId(u) })).toBe(
      MAX_CATEGORIES_PER_USER,
    );
  });
});

describe("listCategories", () => {
  it("returns { version, categories } sorted by key with string ids", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 2 });
    await seedCategories(userId(u), ["zeta", "Mango"]);
    await seedCategories(userId(u), ["Alpha"], "credit");

    const result = await listCategories(userId(u), TZ);

    expect(result.version).toBe(2);
    expect(result.categories).toEqual([
      { _id: expect.any(String), name: "Alpha", type: "credit" },
      { _id: expect.any(String), name: "Mango", type: "debit" },
      { _id: expect.any(String), name: "zeta", type: "debit" },
    ]);
    const stored = await ExpenseCategory.findOne({ userId: userId(u), key: "mango" }).lean();
    expect(result.categories[1]._id).toBe(String((stored as any)._id));
  });

  it("returns only the caller's categories", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 1 });
    const other = await makeUser({ expenseCategoriesVersion: 1 });
    await seedCategories(userId(u), ["Food"]);
    await seedCategories(userId(other), ["Rent"]);

    const result = await listCategories(userId(u), TZ);

    expect(result.categories.map((c) => c.name)).toEqual(["Food"]);
  });

  it("runs the first fill when the version is missing", async () => {
    const u = await makeUser();
    const { current } = await makeLedgers(userId(u));
    await seedExpenses(userId(u), [{ ledgerId: current._id, category: "Food" }]);

    const result = await listCategories(userId(u), TZ);

    expect(result.version).toBe(1);
    expect(result.categories.map((c) => c.name)).toEqual(["Food"]);
    expect(await versionOf(userId(u))).toBe(1);
  });

  it("a new account gives { version: 0, categories: [] }", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 0 });

    expect(await listCategories(userId(u), TZ)).toEqual({ version: 0, categories: [] });
  });
});

describe("addCategoryIfNew", () => {
  it("inserts a new name and raises the version by 1", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 3 });

    const result = await inTxn((s) => addCategoryIfNew(userId(u), "debit", "Groceries", s));

    expect(result.category).toEqual({
      _id: expect.any(String),
      name: "Groceries",
      type: "debit",
    });
    expect(result.version).toBe(4);
    expect(await versionOf(userId(u))).toBe(4);
    const stored = await ExpenseCategory.findOne({ userId: userId(u) }).lean();
    expect((stored as any).key).toBe("groceries");
    expect(String((stored as any)._id)).toBe(result.category!._id);
  });

  it("stores the normalised name and key for messy input", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 0 });

    const result = await inTxn((s) =>
      addCategoryIfNew(userId(u), "debit", "  Food   court ", s),
    );

    expect(result.category?.name).toBe("Food court");
    const stored = await ExpenseCategory.findOne({ userId: userId(u) }).lean();
    expect((stored as any).name).toBe("Food court");
    expect((stored as any).key).toBe("food court");
  });

  it("returns the stored spelling for an existing key and leaves the version alone", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 3 });
    const [existing] = await seedCategories(userId(u), ["Food"]);

    const result = await inTxn((s) => addCategoryIfNew(userId(u), "debit", "  FOOD ", s));

    expect(result.category).toEqual({
      _id: String(existing._id),
      name: "Food",
      type: "debit",
    });
    expect(result.version).toBeUndefined();
    expect(await versionOf(userId(u))).toBe(3);
    expect(await ExpenseCategory.countDocuments({ userId: userId(u) })).toBe(1);
  });

  it("treats the same name under the other type as new", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 1 });
    await seedCategories(userId(u), ["Food"], "debit");

    const result = await inTxn((s) => addCategoryIfNew(userId(u), "credit", "Food", s));

    expect(result.category).toMatchObject({ name: "Food", type: "credit" });
    expect(result.version).toBe(2);
    expect(await storedNames(userId(u))).toEqual(["credit:Food", "debit:Food"]);
  });

  it(`skips a new name at ${MAX_CATEGORIES_PER_USER} categories`, async () => {
    const u = await makeUser({ expenseCategoriesVersion: 7 });
    await seedCategories(
      userId(u),
      Array.from({ length: MAX_CATEGORIES_PER_USER }, (_, i) => `Cat ${i}`),
    );

    const result = await inTxn((s) => addCategoryIfNew(userId(u), "debit", "Brand new", s));

    expect(result).toEqual({ category: null });
    expect(await ExpenseCategory.countDocuments({ userId: userId(u) })).toBe(
      MAX_CATEGORIES_PER_USER,
    );
    expect(await versionOf(userId(u))).toBe(7);
  });

  it("still resolves an existing key at the limit", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 7 });
    await seedCategories(
      userId(u),
      Array.from({ length: MAX_CATEGORIES_PER_USER }, (_, i) => `Cat ${i}`),
    );

    const result = await inTxn((s) => addCategoryIfNew(userId(u), "debit", "cat 5", s));

    expect(result.category?.name).toBe("Cat 5");
    expect(result.version).toBeUndefined();
  });

  it("never stores '-' or a blank name", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 0 });

    expect(await inTxn((s) => addCategoryIfNew(userId(u), "debit", "-", s))).toEqual({
      category: null,
    });
    expect(await inTxn((s) => addCategoryIfNew(userId(u), "debit", "   ", s))).toEqual({
      category: null,
    });
    expect(await ExpenseCategory.countDocuments({ userId: userId(u) })).toBe(0);
    expect(await versionOf(userId(u))).toBe(0);
  });

  it("inserts but leaves the version missing on an account never filled", async () => {
    const u = await makeUser();

    const result = await inTxn((s) => addCategoryIfNew(userId(u), "debit", "Books", s));

    expect(result.category?.name).toBe("Books");
    expect(result.version).toBeUndefined();
    expect(await storedNames(userId(u))).toEqual(["debit:Books"]);
    expect(await hasVersionField(userId(u))).toBe(false);
  });

  it("is rolled back with the transaction it runs in", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 3 });

    await expect(
      inTxn(async (s) => {
        await addCategoryIfNew(userId(u), "debit", "Taxi", s);
        throw new Error("expense save failed");
      }),
    ).rejects.toThrow("expense save failed");

    expect(await ExpenseCategory.countDocuments({ userId: userId(u) })).toBe(0);
    expect(await versionOf(userId(u))).toBe(3);
  });

  it("two transactions adding the same new name at once: one record, one bump", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 3 });

    const results = await Promise.all([
      inTxn((s) => addCategoryIfNew(userId(u), "debit", "Taxi", s)),
      inTxn((s) => addCategoryIfNew(userId(u), "debit", "taxi", s)),
    ]);

    // Whichever commits first decides the spelling; the other gets it back.
    expect(["Taxi", "taxi"]).toContain(results[0].category?.name);
    expect(results[1].category?.name).toBe(results[0].category?.name);
    expect(new Set(results.map((r) => r.category?._id)).size).toBe(1);
    expect(results.filter((r) => r.version !== undefined)).toHaveLength(1);
    expect(await ExpenseCategory.countDocuments({ userId: userId(u) })).toBe(1);
    expect(await versionOf(userId(u))).toBe(4);
  });
});

describe("removeCategory", () => {
  it("deletes the caller's own category and raises the version by 1", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 5 });
    const [cat] = await seedCategories(userId(u), ["Food"]);

    const result = await removeCategory(userId(u), String(cat._id));

    expect(result).toEqual({ version: 6 });
    expect(await ExpenseCategory.findById(cat._id)).toBeNull();
    expect(await versionOf(userId(u))).toBe(6);
  });

  it("returns null for another user's category and deletes nothing", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 5 });
    const other = await makeUser({ expenseCategoriesVersion: 2 });
    const [theirs] = await seedCategories(userId(other), ["Rent"]);

    const result = await removeCategory(userId(u), String(theirs._id));

    expect(result).toBeNull();
    expect(await ExpenseCategory.findById(theirs._id)).not.toBeNull();
    expect(await versionOf(userId(u))).toBe(5);
    expect(await versionOf(userId(other))).toBe(2);
  });

  it("returns null for an id that no longer exists", async () => {
    const u = await makeUser({ expenseCategoriesVersion: 5 });

    const result = await removeCategory(userId(u), new mongoose.Types.ObjectId().toString());

    expect(result).toBeNull();
    expect(await versionOf(userId(u))).toBe(5);
  });

  it("reports version 0 and leaves the field missing on an account never filled", async () => {
    const u = await makeUser();
    const [cat] = await seedCategories(userId(u), ["Books"]);

    const result = await removeCategory(userId(u), String(cat._id));

    expect(result).toEqual({ version: 0 });
    expect(await ExpenseCategory.findById(cat._id)).toBeNull();
    expect(await hasVersionField(userId(u))).toBe(false);
  });
});
