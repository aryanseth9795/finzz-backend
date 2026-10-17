import mongoose from "mongoose";

/**
 * Compound cursor for keyset pagination.
 *
 * THE BUG THIS FIXES
 * Every paginated list sorted by `{ date: -1, _id: -1 }` but used only the
 * date as the cursor, and fetched the next page with `{ date: { $lt: cursor } }`.
 * When several rows share a timestamp — which is normal, because users enter
 * transactions dated to the day, not the millisecond — every row after the
 * first with that date was **silently skipped**. In a ledger, a missing row is
 * indistinguishable from a deleted one, and the totals stop reconciling.
 *
 * THE FIX
 * The cursor carries both sort keys, and the next page is selected with the
 * standard keyset predicate:
 *
 *     date < cursorDate  OR  (date = cursorDate AND _id < cursorId)
 *
 * This is also strictly faster than `skip`/`offset` paging: the predicate is
 * satisfied by the same `{ date: -1, _id: -1 }` index, so the database seeks
 * directly to the boundary instead of counting past the rows it discards.
 *
 * BACKWARD COMPATIBILITY
 * App builds already in users' hands send a bare ISO date. `decodeCursor`
 * accepts that form and degrades to date-only filtering, so nothing breaks
 * for them; only the new compound form gets the tie-breaking guarantee.
 * Remove the legacy branch once the old builds are retired.
 */

export interface Cursor {
  date: Date;
  id?: mongoose.Types.ObjectId;
}

const SEPARATOR = "_";

/** Build a cursor from the last row of the page just returned. */
export const encodeCursor = (date: Date | string, id: unknown): string => {
  const iso = date instanceof Date ? date.toISOString() : new Date(date).toISOString();
  return `${iso}${SEPARATOR}${String(id)}`;
};

/** Parse a cursor from a client. Returns null when absent or unusable. */
export const decodeCursor = (raw: unknown): Cursor | null => {
  if (typeof raw !== "string" || !raw) return null;

  const separatorIndex = raw.lastIndexOf(SEPARATOR);

  // Legacy form: a bare ISO date with no id component.
  if (separatorIndex === -1) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : { date };
  }

  const datePart = raw.slice(0, separatorIndex);
  const idPart = raw.slice(separatorIndex + 1);
  const date = new Date(datePart);

  if (Number.isNaN(date.getTime())) return null;
  if (!mongoose.isValidObjectId(idPart)) return { date };

  return { date, id: new mongoose.Types.ObjectId(idPart) };
};

/**
 * The MongoDB filter selecting everything strictly *after* the cursor under a
 * `{ [field]: -1, _id: -1 }` sort. Returns `{}` when there is no cursor.
 *
 * `field` defaults to `date` (the ledgers); notes page on `editedAt`.
 */
export const cursorFilter = (
  cursor: Cursor | null,
  field = "date",
): Record<string, unknown> => {
  if (!cursor) return {};

  // Legacy date-only cursor: the old, tie-dropping behaviour. Kept only so
  // existing clients keep working.
  if (!cursor.id) return { [field]: { $lt: cursor.date } };

  return {
    $or: [
      { [field]: { $lt: cursor.date } },
      { [field]: cursor.date, _id: { $lt: cursor.id } },
    ],
  };
};

/**
 * Given one extra row fetched beyond the page size, split it into the page and
 * the pagination metadata. Fetching `limit + 1` is how `hasMore` is determined
 * without a second `countDocuments` query.
 *
 * `dateOf` picks the sort field the cursor is built from.
 */
export const paginateBy = <T extends { _id: unknown }>(
  rows: T[],
  limit: number,
  dateOf: (row: T) => Date,
): { items: T[]; nextCursor: string | null; hasMore: boolean } => {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(dateOf(last), last._id) : null,
  };
};

/** `paginateBy` on the ledgers' `date` field. */
export const paginate = <T extends { _id: unknown; date: Date }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null; hasMore: boolean } =>
  paginateBy(rows, limit, (row) => row.date);
