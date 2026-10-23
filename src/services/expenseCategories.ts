import mongoose from "mongoose";
import { Expense } from "../models/expenseModel.js";
import { ExpenseLedger } from "../models/expenseLedgerModel.js";
import {
  ExpenseCategory,
  EXPENSE_CATEGORY_NAME_MAX,
} from "../models/expenseCategoryModel.js";
import { User } from "../models/userModel.js";
import { periodOf } from "../utils/dates.js";

/**
 * Saved expense categories: the per-user list behind the category chips.
 *
 * THE VERSION
 * `User.expenseCategoriesVersion` lets the app tell, from the Profile call it
 * already makes at launch, whether its saved copy is current:
 *   - missing → never filled (an account older than this feature);
 *   - 0       → filled and empty (registration starts every new account here);
 *   - +1      → only when a row is REALLY inserted or REALLY deleted.
 * A flagged name that already exists changes nothing, so it must not move the
 * version either — otherwise every phone would refetch an identical list.
 *
 * Every `$inc` filters on `expenseCategoriesVersion: { $exists: true }`. On an
 * account that was never filled the field stays missing, and the first fill
 * (which reads the current month) picks the new row up at the next launch.
 *
 * SAVING AN EXPENSE MUST NEVER FAIL BECAUSE OF THIS
 * `addCategoryIfNew` runs inside the expense's own transaction, so anything it
 * throws aborts the save. That is why it upserts instead of `create`-ing (an
 * E11000 would abort the transaction), and why at the limit it skips the
 * category rather than rejecting.
 */

export type CategoryType = "debit" | "credit";

/** What the API returns for one category. */
export interface CategoryDTO {
  _id: string;
  name: string;
  type: CategoryType;
}

/** Both types together. */
export const MAX_CATEGORIES_PER_USER = 200;
/** Expense rows the one-time first fill may read. */
export const FIRST_FILL_ROW_LIMIT = 1000;

//======= Normalising =======//
//
// The app has its own copy of these two functions, tested on the same cases.
// They must agree, or the phone would flag names the server already has.

/** Trim, then collapse every run of whitespace to one space. Spelling is kept. */
export function normalizeCategoryName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** The matching key: the normalised name lowercased. */
export function categoryKey(raw: string): string {
  return normalizeCategoryName(raw).toLowerCase();
}

/**
 * True when `raw` may become a saved category. Blank and "-" (the old
 * placeholder) never do. Names over the length limit only exist in legacy rows
 * written before validation; storing one would offer a chip whose save the
 * expense validator then rejects.
 */
export function isStorableCategory(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const name = normalizeCategoryName(raw);
  return name !== "" && name !== "-" && name.length <= EXPENSE_CATEGORY_NAME_MAX;
}

//======= Helpers =======//

/** A category as read back with `lean()`. */
type CategoryRow = { _id: mongoose.Types.ObjectId; name: string; type: CategoryType };
/** The one user field this module reads. */
type VersionRow = { expenseCategoriesVersion?: number } | null;

const toDTO = (doc: CategoryRow): CategoryDTO => ({
  _id: String(doc._id),
  name: doc.name,
  type: doc.type,
});

const readVersion = (user: VersionRow) =>
  typeof user?.expenseCategoriesVersion === "number"
    ? user.expenseCategoriesVersion
    : undefined;

const getVersion = async (userId: string) =>
  readVersion(
    await User.findById(userId).select("expenseCategoriesVersion").lean<VersionRow>(),
  );

/** Raise the version by 1, but only on an account that has one. */
const bumpVersion = async (userId: string, session: mongoose.ClientSession) => {
  const user = await User.findOneAndUpdate(
    { _id: userId, expenseCategoriesVersion: { $exists: true } },
    { $inc: { expenseCategoriesVersion: 1 } },
    { new: true, session },
  )
    .select("expenseCategoriesVersion")
    .lean<VersionRow>();
  return readVersion(user);
};

/** The month before `{ year, month }`, with the year rollover. */
const previousPeriod = ({ year, month }: { year: number; month: number }) =>
  month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };

/**
 * True when a bulk write failed only on duplicate keys, i.e. a concurrent
 * flagged save inserted the same category first. The row exists either way.
 * The driver reports one write error as an object and several as an array.
 */
const onlyDuplicateKeys = (err: unknown): boolean => {
  const { code, writeErrors } = (err ?? {}) as {
    code?: number;
    writeErrors?: { code?: number } | { code?: number }[];
  };
  if (writeErrors === undefined) return code === 11000;
  const list = Array.isArray(writeErrors) ? writeErrors : [writeErrors];
  return list.length > 0 && list.every((w) => w.code === 11000);
};

//======= First fill =======//

/**
 * Build the list once for an account older than this feature, from the
 * categories used in the current and previous month (in the user's timezone).
 * A no-op once the version exists, so it costs one indexed user read after.
 *
 * Rows are read newest first, so the first spelling seen for a key is the most
 * recent one, and when the limit cuts the list it is the oldest names that go.
 */
export async function firstFillIfNeeded(
  userId: string,
  tzOffsetMinutes: number,
): Promise<void> {
  const user = await User.findById(userId)
    .select("expenseCategoriesVersion")
    .lean<VersionRow>();
  if (!user || readVersion(user) !== undefined) return;

  const current = periodOf(new Date(), tzOffsetMinutes);
  const ledgers = await ExpenseLedger.find({
    userId,
    $or: [current, previousPeriod(current)],
  })
    .select("_id")
    .lean<{ _id: mongoose.Types.ObjectId }[]>();

  // Served by the existing { userId, ledgerId, date } index; no new index on
  // the large expenses collection.
  const rows =
    ledgers.length === 0
      ? []
      : await Expense.find({
          userId,
          ledgerId: { $in: ledgers.map((l) => l._id) },
          category: { $nin: [null, "", "-"] },
        })
          .sort({ date: -1, _id: -1 })
          .limit(FIRST_FILL_ROW_LIMIT)
          .select("category type")
          .lean<{ category?: string | null; type?: string }[]>();

  // Rows can already exist: a flagged save on an unfilled account inserts its
  // category but leaves the version missing. They count against the limit and
  // are not rewritten.
  const existing = await ExpenseCategory.find({ userId })
    .select("type key")
    .lean<{ type: CategoryType; key: string }[]>();
  const taken = new Set(existing.map((c) => `${c.type}:${c.key}`));
  const room = MAX_CATEGORIES_PER_USER - existing.length;

  const picked = new Map<string, { type: CategoryType; name: string; key: string }>();
  for (const row of rows) {
    if (picked.size >= room) break;
    if (!isStorableCategory(row.category)) continue;
    // `lean()` skips schema defaults, so a legacy row without `type` is read
    // as the schema would have defaulted it.
    const type: CategoryType = row.type === "credit" ? "credit" : "debit";
    const name = normalizeCategoryName(row.category);
    const key = name.toLowerCase();
    const id = `${type}:${key}`;
    if (!taken.has(id) && !picked.has(id)) picked.set(id, { type, name, key });
  }

  if (picked.size > 0) {
    try {
      await ExpenseCategory.bulkWrite(
        [...picked.values()].map(({ type, name, key }) => ({
          updateOne: {
            // The equality filter seeds userId/type/key on insert. Keeping the
            // unique-index fields out of the update lets the server retry a
            // racing upsert's duplicate key by itself.
            filter: { userId, type, key },
            update: { $setOnInsert: { name } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (err) {
      if (!onlyDuplicateKeys(err)) throw err;
    }
  }

  // Conditional on the field still being missing, so a second fill running at
  // the same time becomes a no-op instead of overwriting a bumped version.
  await User.updateOne(
    { _id: userId, expenseCategoriesVersion: { $exists: false } },
    { $set: { expenseCategoriesVersion: existing.length + picked.size > 0 ? 1 : 0 } },
  );
}

//======= Read =======//

/** Every category of the user, both types, sorted by key, plus the version. */
export async function listCategories(
  userId: string,
  tzOffsetMinutes: number,
): Promise<{ version: number; categories: CategoryDTO[] }> {
  await firstFillIfNeeded(userId, tzOffsetMinutes);

  // Version FIRST, list second. If a save lands between the two reads, the
  // phone gets the new row with the old version and simply refetches at its
  // next launch. The other order would pair the old list with the new version,
  // and the phone would believe it was current while missing that row.
  const version = await getVersion(userId);
  const rows = await ExpenseCategory.find({ userId })
    .sort({ key: 1, type: 1 })
    .select("name type")
    .lean<CategoryRow[]>();

  return { version: version ?? 0, categories: rows.map(toDTO) };
}

//======= Write =======//

/**
 * Add a category the phone flagged as new, inside the caller's transaction.
 *
 * - Already stored (any case): returns the stored row so the expense can use
 *   its spelling; no write, no `version`.
 * - Really inserted: returns it with the bumped `version`, or no `version` on
 *   an account never filled (see the header).
 * - Blank/"-", or the user is at the limit: `{ category: null }`.
 *
 * The limit is checked only for a key that does not exist yet, so an existing
 * name still resolves to its stored spelling at the limit.
 */
export async function addCategoryIfNew(
  userId: string,
  type: CategoryType,
  rawName: string,
  session: mongoose.ClientSession,
): Promise<{ category: CategoryDTO | null; version?: number }> {
  if (!isStorableCategory(rawName)) return { category: null };
  const name = normalizeCategoryName(rawName);
  const key = name.toLowerCase();

  const existing = await ExpenseCategory.findOne({ userId, type, key })
    .session(session)
    .lean<CategoryRow | null>();
  if (existing) return { category: toDTO(existing) };

  const count = await ExpenseCategory.countDocuments({ userId }).session(session);
  if (count >= MAX_CATEGORIES_PER_USER) return { category: null };

  // Upsert, never `create`: a duplicate key inside a transaction aborts the
  // whole expense save. When two saves race on the same new name, the loser
  // gets a write conflict instead, which `withTransaction` retries, and the
  // retry finds the winner's row above.
  const result = await ExpenseCategory.findOneAndUpdate(
    { userId, type, key },
    { $setOnInsert: { name } },
    { upsert: true, new: true, session, includeResultMetadata: true },
  ).lean<mongoose.ModifyResult<CategoryRow>>();
  // An upsert with `new: true` always returns a row; the guard satisfies the
  // driver's `value | null` type without risking a throw inside the save.
  if (!result.value) return { category: null };
  const category = toDTO(result.value);
  if (result.lastErrorObject?.updatedExisting !== false) return { category };

  const version = await bumpVersion(userId, session);
  return version === undefined ? { category } : { category, version };
}

/**
 * Delete one of the user's own categories and raise the version, in one small
 * transaction. Returns null when nothing matched (someone else's id, or
 * already removed from another phone), which the controller turns into 404.
 * Past expenses keep their category text.
 */
export async function removeCategory(
  userId: string,
  categoryId: string,
): Promise<{ version: number } | null> {
  // Cast so TypeScript does not narrow it to `null` across the callback.
  let result = null as { version: number } | null;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // `withTransaction` may run this more than once; start each run clean.
      result = null;
      const { deletedCount } = await ExpenseCategory.deleteOne(
        { _id: categoryId, userId },
        { session },
      );
      if (deletedCount === 0) return;
      result = { version: (await bumpVersion(userId, session)) ?? 0 };
    });
  } finally {
    await session.endSession();
  }

  return result;
}
