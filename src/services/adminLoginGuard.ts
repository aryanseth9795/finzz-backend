import {
  AdminLoginGuard,
  GUARD_ROW_TTL_MS,
  type IAdminLoginGuard,
} from "../models/adminLoginGuardModel.js";

type GuardRow = Pick<
  IAdminLoginGuard,
  "key" | "failures" | "lockedUntil" | "windowStart" | "lockCount"
>;

/**
 * Persistent brute-force lockout for the admin login.
 *
 * The admin credential may be a 6-character PIN, which is only safe if the
 * number of guesses an attacker gets is hard-capped — per address (so one
 * machine is slowed to a crawl) and globally (so rotating addresses does not
 * help). All state lives in MongoDB so a restart or redeploy cannot reset it.
 *
 * Policy:
 *  - per IP: 5 consecutive failures lock that IP for 15 min; every further
 *    lock doubles (15, 30, 60 ... capped at 24 h). A success clears the IP.
 *  - global: 30 failures from any IPs within a 1 h window pause every admin
 *    login for 30 min.
 */

export const IP_MAX_FAILURES = 5;
export const IP_BASE_LOCK_MS = 15 * 60 * 1000;
export const IP_MAX_LOCK_MS = 24 * 60 * 60 * 1000;
export const GLOBAL_MAX_FAILURES = 30;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const GLOBAL_LOCK_MS = 30 * 60 * 1000;

const GLOBAL_KEY = "global";
const ipKey = (ip: string) => `ip:${ip}`;

export interface LockStatus {
  locked: boolean;
  /** Whole seconds until the lock ends (0 when not locked). */
  retryAfterSeconds: number;
}

export interface FailureResult extends LockStatus {
  /** Wrong guesses left for this IP before it is locked. */
  attemptsLeft: number;
}

/** Duration of the Nth lock (0-based): 15 min, 30, 60 ... capped at 24 h. */
export const ipLockDurationMs = (lockCount: number): number =>
  Math.min(IP_BASE_LOCK_MS * 2 ** Math.min(lockCount, 20), IP_MAX_LOCK_MS);

const secondsUntil = (until: Date, now: number) =>
  Math.max(0, Math.ceil((until.getTime() - now) / 1000));

const expiry = (now: number, lockedUntil?: number) =>
  new Date(Math.max(now, lockedUntil ?? 0) + GUARD_ROW_TTL_MS);

/** Two concurrent first-ever failures can race on the unique key; retry once. */
const withUpsertRetry = async <T>(op: () => Promise<T>): Promise<T> => {
  try {
    return await op();
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return op();
    throw err;
  }
};

/** Is this IP (or the whole admin login) currently locked? */
export const checkLock = async (
  ip: string,
  now: number = Date.now(),
): Promise<LockStatus> => {
  const docs = await AdminLoginGuard.find({
    key: { $in: [ipKey(ip), GLOBAL_KEY] },
  }).lean();

  let until = 0;
  for (const doc of docs) {
    if (doc.lockedUntil && doc.lockedUntil.getTime() > now) {
      until = Math.max(until, doc.lockedUntil.getTime());
    }
  }
  if (until === 0) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: secondsUntil(new Date(until), now) };
};

/**
 * Count a failed attempt. If it tips the IP (or the global counter) over its
 * limit, the lock is applied and reported in the result.
 */
export const recordFailure = async (
  ip: string,
  now: number = Date.now(),
): Promise<FailureResult> => {
  let lockedUntil = 0;

  // ── Per IP ────────────────────────────────────────────────────────────────
  const key = ipKey(ip);
  const ipDoc = await withUpsertRetry(async () =>
    (await AdminLoginGuard.findOneAndUpdate(
      { key },
      {
        $inc: { failures: 1 },
        $set: { expiresAt: expiry(now) },
        $setOnInsert: { lockCount: 0 },
      },
      { upsert: true, new: true },
    ).lean()) as unknown as GuardRow | null,
  );

  let attemptsLeft = Math.max(0, IP_MAX_FAILURES - (ipDoc?.failures ?? 0));
  if (ipDoc && ipDoc.failures >= IP_MAX_FAILURES) {
    const until = now + ipLockDurationMs(ipDoc.lockCount);
    // Conditional so two concurrent failures cannot lock (and double) twice.
    const locked = await AdminLoginGuard.findOneAndUpdate(
      { key, failures: { $gte: IP_MAX_FAILURES } },
      {
        $set: {
          failures: 0,
          lockedUntil: new Date(until),
          expiresAt: expiry(now, until),
        },
        $inc: { lockCount: 1 },
      },
      { new: true },
    ).lean();
    if (locked) {
      lockedUntil = until;
      attemptsLeft = 0;
    }
  }

  // ── Global ────────────────────────────────────────────────────────────────
  // One atomic pipeline update: start a fresh window when none is open or the
  // old one has aged out, otherwise add one to the running count.
  const windowCutoff = new Date(now - GLOBAL_WINDOW_MS);
  const stale = {
    $or: [
      { $not: [{ $gt: ["$windowStart", null] }] },
      { $lt: ["$windowStart", windowCutoff] },
    ],
  };
  const globalDoc = await withUpsertRetry(async () =>
    (await AdminLoginGuard.findOneAndUpdate(
      { key: GLOBAL_KEY },
      [
        {
          $set: {
            windowStart: { $cond: [stale, new Date(now), "$windowStart"] },
            failures: {
              $cond: [stale, 1, { $add: [{ $ifNull: ["$failures", 0] }, 1] }],
            },
            lockCount: { $ifNull: ["$lockCount", 0] },
            lockedUntil: { $ifNull: ["$lockedUntil", null] },
            expiresAt: expiry(now),
          },
        },
      ],
      { upsert: true, new: true },
    ).lean()) as unknown as GuardRow | null,
  );

  if (globalDoc && globalDoc.failures >= GLOBAL_MAX_FAILURES) {
    const until = now + GLOBAL_LOCK_MS;
    const locked = await AdminLoginGuard.findOneAndUpdate(
      { key: GLOBAL_KEY, failures: { $gte: GLOBAL_MAX_FAILURES } },
      {
        $set: {
          failures: 0,
          windowStart: null,
          lockedUntil: new Date(until),
          expiresAt: expiry(now, until),
        },
        $inc: { lockCount: 1 },
      },
      { new: true },
    ).lean();
    if (locked) lockedUntil = Math.max(lockedUntil, until);
  }

  if (lockedUntil > now) {
    return {
      locked: true,
      retryAfterSeconds: secondsUntil(new Date(lockedUntil), now),
      attemptsLeft,
    };
  }
  return { locked: false, retryAfterSeconds: 0, attemptsLeft };
};

/** A correct login clears that IP's failures and escalation level. */
export const recordSuccess = async (ip: string): Promise<void> => {
  await AdminLoginGuard.updateOne(
    { key: ipKey(ip) },
    { $set: { failures: 0, lockCount: 0, lockedUntil: null } },
  );
};
