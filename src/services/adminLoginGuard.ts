import { ipKeyGenerator } from "express-rate-limit";
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
 * The cap must hold under concurrency, so an attempt is RESERVED (counted)
 * atomically BEFORE the credential is compared. Only a successful reservation
 * may reach the comparison; with N guesses in flight at most `cap` of them are
 * ever compared. A correct login gives its reservation back.
 *
 * Policy:
 *  - per IP: 5 guesses within a 1 h window lock that IP for 15 min; every
 *    further lock doubles (15, 30, 60 ... capped at 24 h). IPv6 addresses
 *    share a bucket per subnet. A success clears the IP.
 *  - global: 30 guesses from any IPs within a 1 h window pause every admin
 *    login for 30 min; every further lock doubles (capped at 24 h) and the
 *    escalation decays after 24 h without a lock. IPs listed in
 *    ADMIN_LOGIN_ALLOWLIST_IPS skip the global lock (never the per-IP one).
 */

export const IP_MAX_FAILURES = 5;
export const IP_WINDOW_MS = 60 * 60 * 1000;
export const IP_BASE_LOCK_MS = 15 * 60 * 1000;
export const IP_MAX_LOCK_MS = 24 * 60 * 60 * 1000;
export const GLOBAL_MAX_FAILURES = 30;
export const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
export const GLOBAL_BASE_LOCK_MS = 30 * 60 * 1000;
export const GLOBAL_MAX_LOCK_MS = 24 * 60 * 60 * 1000;
/** lockCount falls back to 0 once the last lock ended this long ago. */
export const LOCK_COUNT_DECAY_MS = 24 * 60 * 60 * 1000;

const GLOBAL_KEY = "global";

/**
 * Per-IP row key. `ipKeyGenerator` collapses an IPv6 address to its subnet
 * (exactly as rateLimit.ts does) so an attacker holding a v6 range cannot get
 * a fresh bucket per request.
 */
export const guardKeyForIp = (ip: string): string =>
  `ip:${ipKeyGenerator(ip)}`;

export interface LockStatus {
  locked: boolean;
  /** Whole seconds until the lock ends (0 when not locked). */
  retryAfterSeconds: number;
}

export interface ReserveResult extends LockStatus {
  /**
   * True when this attempt may be compared against the credential. False means
   * the login is refused (429) without comparing anything.
   */
  allowed: boolean;
  /**
   * Guesses left for this IP before it is locked. When `allowed` and `locked`
   * are both true the attempt was the last permitted one: if it is wrong the
   * caller answers 429 (the lock is already in force).
   */
  attemptsLeft: number;
}

/** Duration of the Nth IP lock (0-based): 15 min, 30, 60 ... capped at 24 h. */
export const ipLockDurationMs = (lockCount: number): number =>
  Math.min(IP_BASE_LOCK_MS * 2 ** Math.min(lockCount, 20), IP_MAX_LOCK_MS);

/** Duration of the Nth global lock (0-based): 30 min, 60, 120 ... capped at 24 h. */
export const globalLockDurationMs = (lockCount: number): number =>
  Math.min(GLOBAL_BASE_LOCK_MS * 2 ** Math.min(lockCount, 20), GLOBAL_MAX_LOCK_MS);

const secondsUntil = (until: Date | number, now: number) =>
  Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));

const expiry = (now: number, lockedUntil?: number) =>
  new Date(Math.max(now, lockedUntil ?? 0) + GUARD_ROW_TTL_MS);

/** Listed IPs skip the global lock only. Read per call so tests can change it. */
const isAllowlisted = (ip: string): boolean => {
  const raw = process.env.ADMIN_LOGIN_ALLOWLIST_IPS;
  if (!raw) return false;
  const wanted = ip.trim().toLowerCase();
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .some((entry) => entry !== "" && entry === wanted);
};

const describeLock = (ms: number) => {
  const minutes = Math.round(ms / 60000);
  return minutes >= 120 ? `${Math.round(minutes / 60)} h` : `${minutes} min`;
};

/** A row is open when `lockedUntil` is absent/null or already in the past. */
const notLocked = (now: number) => ({
  $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date(now) } }],
});

/**
 * Atomically count one attempt on `key`, but only while the row is not locked.
 *
 * Returns the row AFTER the increment, or null when the row is locked. The
 * upsert makes the first-ever attempt create the row; a locked row fails the
 * filter, so the upsert tries to insert a duplicate key (11000) — that is the
 * "locked" signal, and a lost first-insert race is retried once.
 */
const reserveRow = async (
  key: string,
  windowMs: number,
  now: number,
): Promise<GuardRow | null> => {
  const stale = {
    $or: [
      { $not: [{ $gt: ["$windowStart", null] }] },
      { $lt: ["$windowStart", new Date(now - windowMs)] },
    ],
  };
  // Escalation is forgotten once the last lock ended a long time ago.
  const decayed = {
    $and: [
      { $gt: ["$lockedUntil", null] },
      { $lt: ["$lockedUntil", new Date(now - LOCK_COUNT_DECAY_MS)] },
    ],
  };
  const op = async () =>
    (await AdminLoginGuard.findOneAndUpdate(
      { key, ...notLocked(now) },
      [
        {
          $set: {
            windowStart: { $cond: [stale, new Date(now), "$windowStart"] },
            failures: {
              $cond: [stale, 1, { $add: [{ $ifNull: ["$failures", 0] }, 1] }],
            },
            lockCount: {
              $cond: [decayed, 0, { $ifNull: ["$lockCount", 0] }],
            },
            expiresAt: expiry(now),
          },
        },
      ],
      { upsert: true, new: true },
    ).lean()) as unknown as GuardRow | null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await op();
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }
  return null;
};

/**
 * Apply the lock to `key` if it isn't applied yet. Conditional on the counter
 * still being at its cap, so concurrent callers lock (and escalate) only once.
 * Returns the new `lockedUntil` when THIS call applied it, otherwise null.
 */
const applyLock = async (
  key: string,
  cap: number,
  durationMs: number,
  now: number,
): Promise<number | null> => {
  const until = now + durationMs;
  const locked = await AdminLoginGuard.findOneAndUpdate(
    { key, failures: { $gte: cap }, ...notLocked(now) },
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
  return locked ? until : null;
};

/** When does this key's current lock end (0 when it is not locked)? */
const lockEnd = async (key: string, now: number): Promise<number> => {
  const doc = (await AdminLoginGuard.findOne({
    key,
  }).lean()) as unknown as GuardRow | null;
  const until = doc?.lockedUntil?.getTime() ?? 0;
  return until > now ? until : 0;
};

/** Is this IP (or the whole admin login) currently locked? Read-only. */
export const checkLock = async (
  ip: string,
  now: number = Date.now(),
): Promise<LockStatus> => {
  const docs = await AdminLoginGuard.find({
    key: { $in: [guardKeyForIp(ip), GLOBAL_KEY] },
  }).lean();

  let until = 0;
  for (const doc of docs) {
    if (doc.lockedUntil && doc.lockedUntil.getTime() > now) {
      until = Math.max(until, doc.lockedUntil.getTime());
    }
  }
  if (until === 0) return { locked: false, retryAfterSeconds: 0 };
  return { locked: true, retryAfterSeconds: secondsUntil(until, now) };
};

const refuse = (untilMs: number, now: number): ReserveResult => ({
  allowed: false,
  locked: true,
  retryAfterSeconds: Math.max(1, secondsUntil(untilMs, now)),
  attemptsLeft: 0,
});

/**
 * Reserve one login attempt. Call this BEFORE comparing the credential and
 * compare only when `allowed` is true. A failed comparison needs no further
 * bookkeeping — the attempt is already counted; a successful one must call
 * `recordSuccess`.
 */
export const reserveAttempt = async (
  ip: string,
  now: number = Date.now(),
): Promise<ReserveResult> => {
  const skipGlobal = isAllowlisted(ip);
  const ipKey = guardKeyForIp(ip);

  // A global pause refuses cheaply, without counting against anyone's IP.
  if (!skipGlobal) {
    const until = await lockEnd(GLOBAL_KEY, now);
    if (until > 0) return refuse(until, now);
  }

  // ── Per IP ────────────────────────────────────────────────────────────────
  const ipRow = await reserveRow(ipKey, IP_WINDOW_MS, now);
  if (!ipRow) return refuse(await lockEnd(ipKey, now), now);

  let ipLockedUntil = 0;
  if (ipRow.failures >= IP_MAX_FAILURES) {
    const duration = ipLockDurationMs(ipRow.lockCount);
    const applied = await applyLock(ipKey, IP_MAX_FAILURES, duration, now);
    if (applied) {
      console.warn(
        `[admin-login] per-IP lock tripped for ${ip}: locked for ${describeLock(duration)}`,
      );
    }
    ipLockedUntil = applied ?? (await lockEnd(ipKey, now));
    // Beyond the cap: the permitted guesses are already in flight. No compare.
    if (ipRow.failures > IP_MAX_FAILURES) return refuse(ipLockedUntil, now);
  }

  // ── Global ────────────────────────────────────────────────────────────────
  let globalLockedUntil = 0;
  if (!skipGlobal) {
    const globalRow = await reserveRow(GLOBAL_KEY, GLOBAL_WINDOW_MS, now);
    let refusedUntil = 0;
    if (!globalRow) {
      refusedUntil = await lockEnd(GLOBAL_KEY, now);
    } else if (globalRow.failures >= GLOBAL_MAX_FAILURES) {
      const duration = globalLockDurationMs(globalRow.lockCount);
      const applied = await applyLock(
        GLOBAL_KEY,
        GLOBAL_MAX_FAILURES,
        duration,
        now,
      );
      if (applied) {
        console.warn(
          `[admin-login] global lock tripped (last attempt from ${ip}): all admin logins paused for ${describeLock(duration)}`,
        );
      }
      globalLockedUntil = applied ?? (await lockEnd(GLOBAL_KEY, now));
      if (globalRow.failures > GLOBAL_MAX_FAILURES) {
        refusedUntil = globalLockedUntil;
      }
    }
    if (!globalRow || refusedUntil > 0) {
      // Never compared, so it must not eat this IP's own allowance.
      await AdminLoginGuard.updateOne(
        { key: ipKey, failures: { $gt: 0 } },
        { $inc: { failures: -1 } },
      );
      return refuse(refusedUntil, now);
    }
  }

  const lockedUntil = Math.max(ipLockedUntil, globalLockedUntil);
  return {
    allowed: true,
    locked: lockedUntil > now,
    retryAfterSeconds: lockedUntil > now ? secondsUntil(lockedUntil, now) : 0,
    attemptsLeft: Math.max(0, IP_MAX_FAILURES - ipRow.failures),
  };
};

/**
 * A correct login clears that IP's counters and escalation, and gives back the
 * attempt it reserved on the global counter.
 */
export const recordSuccess = async (ip: string): Promise<void> => {
  await AdminLoginGuard.updateOne(
    { key: guardKeyForIp(ip) },
    { $set: { failures: 0, lockCount: 0, lockedUntil: null, windowStart: null } },
  );
  if (!isAllowlisted(ip)) {
    await AdminLoginGuard.updateOne(
      { key: GLOBAL_KEY, failures: { $gt: 0 } },
      { $inc: { failures: -1 } },
    );
  }
};
