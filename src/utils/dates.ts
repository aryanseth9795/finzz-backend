/**
 * Calendar-period helpers.
 *
 * THE BUG THIS FIXES
 * Dates are stored as UTC instants, but every month boundary was computed with
 * local-time accessors (`date.getFullYear()`, `date.getMonth()`) evaluated on
 * the *server's* clock. Meanwhile the mobile client took local midnight from
 * its date picker and called `.toISOString()`. For a user at UTC+5:30 that
 * turns "1 August" into `2026-07-31T18:30:00Z`, so on a UTC-hosted server the
 * expense filed into JULY — the user watched it vanish from the month they
 * entered it under.
 *
 * THE MODEL
 * A ledger month is a fact about the *user's* calendar, not about an instant.
 * So the period is derived from the instant plus the offset the user was in
 * when they chose it. Clients send `tzOffsetMinutes` (minutes to ADD to UTC to
 * reach local time: +330 for IST, matching `-new Date().getTimezoneOffset()`).
 *
 * BACKWARD COMPATIBILITY
 * Clients that do not send an offset fall back to UTC, which is what the
 * server effectively used when hosted in UTC — so existing rows keep their
 * current bucket and nothing is retroactively reclassified.
 */

/** Minutes to add to UTC to reach the user's local time. */
export type TzOffsetMinutes = number;

/** Parse and bound a client-supplied offset. Returns 0 (UTC) when absent. */
export const parseTzOffset = (raw: unknown): TzOffsetMinutes => {
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  // Real offsets run from -12:00 to +14:00.
  if (value < -720 || value > 840) return 0;
  return Math.trunc(value);
};

/** Shift an instant into the user's local wall-clock frame. */
const toLocalFrame = (date: Date, tzOffsetMinutes: TzOffsetMinutes): Date =>
  new Date(date.getTime() + tzOffsetMinutes * 60_000);

/**
 * The calendar year/month a date belongs to, in the user's frame.
 * UTC accessors are used on the shifted value so the result never depends on
 * the server's own timezone.
 */
export const periodOf = (
  date: Date,
  tzOffsetMinutes: TzOffsetMinutes = 0,
): { year: number; month: number } => {
  const local = toLocalFrame(date, tzOffsetMinutes);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1 };
};

/** The current calendar period in the user's frame. */
export const currentPeriod = (tzOffsetMinutes: TzOffsetMinutes = 0) =>
  periodOf(new Date(), tzOffsetMinutes);

/**
 * The UTC instant range covering a local calendar month — the two bounds to
 * use in a `{ date: { $gte, $lt } }` query.
 *
 * Returning a half-open interval `[start, end)` is deliberate: `$lte` on an
 * end-of-month timestamp either includes or excludes the final millisecond
 * depending on how it was constructed, which is exactly the kind of off-by-one
 * that silently drops a transaction.
 */
export const monthRangeUtc = (
  year: number,
  month: number,
  tzOffsetMinutes: TzOffsetMinutes = 0,
): { start: Date; end: Date } => {
  const startLocal = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const endLocal = Date.UTC(year, month, 1, 0, 0, 0, 0);
  return {
    start: new Date(startLocal - tzOffsetMinutes * 60_000),
    end: new Date(endLocal - tzOffsetMinutes * 60_000),
  };
};

/** Days in a calendar month. */
export const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

/** True when (year, month) is strictly before the user's current period. */
export const isPastPeriod = (
  year: number,
  month: number,
  tzOffsetMinutes: TzOffsetMinutes = 0,
): boolean => {
  const now = currentPeriod(tzOffsetMinutes);
  // Numeric comparison on both sides. The previous check was
  // `year === currentYear && month >= currentMonth`, which is false when the
  // client sends the string "2026" — so the "past months only" guard passed
  // and a user could permanently close their CURRENT ledger, with no reopen
  // endpoint in existence. Schemas now coerce, and this compares numbers.
  return year * 12 + month < now.year * 12 + now.month;
};
