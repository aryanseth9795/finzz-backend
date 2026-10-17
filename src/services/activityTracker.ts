import mongoose from "mongoose";
import { parseTzOffset } from "../utils/dates.js";
import {
  DailyActivity,
  DailyTraffic,
  ACTIVITY_RETENTION_DAYS,
} from "../models/dailyActivityModel.js";

/**
 * Daily traffic analytics, buffered in memory.
 *
 * Recording is synchronous Map work on the request path; the database is
 * touched only by `flushActivity()` (one bulkWrite per model), which a timer
 * started from server.ts runs every 30 s. Up to one interval of counts can be
 * lost if the process crashes, which is accepted for analytics.
 *
 * Privacy: only user id, day, counters and first/last seen times are kept.
 */

/** Minutes to add to UTC to get the analytics calendar day (default IST). */
export const ANALYTICS_TZ_OFFSET_MINUTES: number = (() => {
  const raw = process.env.ANALYTICS_TZ_OFFSET_MINUTES;
  if (!raw) return 330;
  const n = Number(raw);
  // Real offsets run from -12:00 to +14:00 (the same range parseTzOffset allows).
  if (!Number.isFinite(n) || n < -720 || n > 840) {
    console.warn(
      `[activity] ANALYTICS_TZ_OFFSET_MINUTES="${raw}" is not a valid offset ` +
        "(-720..840 minutes); using UTC (0).",
    );
  }
  return parseTzOffset(raw);
})();

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** The local calendar date "YYYY-MM-DD" of an instant. */
export function dayKey(
  date: Date,
  tzOffsetMinutes: number = ANALYTICS_TZ_OFFSET_MINUTES,
): string {
  return new Date(date.getTime() + tzOffsetMinutes * MINUTE_MS)
    .toISOString()
    .slice(0, 10);
}

/** Start of the local `day` (as a UTC instant) + the retention period. */
const expiryOf = (day: string): Date =>
  new Date(
    Date.parse(`${day}T00:00:00.000Z`) -
      ANALYTICS_TZ_OFFSET_MINUTES * MINUTE_MS +
      ACTIVITY_RETENTION_DAYS * DAY_MS,
  );

interface ActivityEntry {
  day: string;
  user: string;
  requests: number;
  opens: number;
  first: number;
  last: number;
}

interface TrafficEntry {
  day: string;
  requests: number;
  authed: number;
}

let activityBuf = new Map<string, ActivityEntry>();
let trafficBuf = new Map<string, TrafficEntry>();

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** Count one authenticated request (and optionally an app open) for a user. */
export function recordActivity(
  userId: string,
  opts: { isOpen?: boolean; now?: Date } = {},
): void {
  try {
    if (typeof userId !== "string" || !OBJECT_ID.test(userId)) return;
    const now = opts.now ?? new Date();
    const t = now.getTime();
    if (!Number.isFinite(t)) return;
    const day = dayKey(now);
    const key = `${day}|${userId}`;
    const entry = activityBuf.get(key);
    if (entry) {
      entry.requests += 1;
      if (opts.isOpen) entry.opens += 1;
      if (t < entry.first) entry.first = t;
      if (t > entry.last) entry.last = t;
    } else {
      activityBuf.set(key, {
        day,
        user: userId,
        requests: 1,
        opens: opts.isOpen ? 1 : 0,
        first: t,
        last: t,
      });
    }
  } catch {
    // Analytics must never break a request.
  }
}

/** Count one API request (authenticated or not) towards the daily total. */
export function recordRequest(authed: boolean, now: Date = new Date()): void {
  try {
    const day = dayKey(now);
    const entry = trafficBuf.get(day);
    if (entry) {
      entry.requests += 1;
      if (authed) entry.authed += 1;
    } else {
      trafficBuf.set(day, { day, requests: 1, authed: authed ? 1 : 0 });
    }
  } catch {
    // Analytics must never break a request.
  }
}

/** Merge entries back into the live buffers after a failed write. */
const restoreActivity = (entries: Map<string, ActivityEntry>): void => {
  for (const [key, e] of entries) {
    const cur = activityBuf.get(key);
    if (cur) {
      cur.requests += e.requests;
      cur.opens += e.opens;
      cur.first = Math.min(cur.first, e.first);
      cur.last = Math.max(cur.last, e.last);
    } else {
      activityBuf.set(key, e);
    }
  }
};

const restoreTraffic = (entries: Map<string, TrafficEntry>): void => {
  for (const [key, e] of entries) {
    const cur = trafficBuf.get(key);
    if (cur) {
      cur.requests += e.requests;
      cur.authed += e.authed;
    } else {
      trafficBuf.set(key, e);
    }
  }
};

/** Log flush failures at most once a minute so a DB outage cannot flood logs. */
const FLUSH_LOG_INTERVAL_MS = 60_000;
let lastFlushLogAt = 0;
const logFlushError = (err: unknown): void => {
  const nowMs = Date.now();
  if (nowMs - lastFlushLogAt < FLUSH_LOG_INTERVAL_MS) return;
  lastFlushLogAt = nowMs;
  console.error("[activity] flush failed:", (err as Error)?.message);
};

/**
 * Which ops of an unordered bulkWrite did NOT apply, given the thrown error.
 * A MongoBulkWriteError reports exactly the failed ops in `writeErrors`; a
 * writeConcernError on its own means every op was applied. Any other error
 * (network, etc.) gives no such guarantee, so every op counts as failed.
 */
const failedOpIndexes = (err: unknown, total: number): Set<number> => {
  const all = () => new Set(Array.from({ length: total }, (_, i) => i));
  const e = err as {
    name?: string;
    writeErrors?: unknown;
  };
  if (!e || (e.name !== "MongoBulkWriteError" && e.writeErrors === undefined)) {
    return all();
  }
  const list = Array.isArray(e.writeErrors)
    ? e.writeErrors
    : e.writeErrors
      ? [e.writeErrors]
      : [];
  const failed = new Set<number>();
  for (const w of list as Array<{ index?: number; err?: { index?: number } }>) {
    const idx = w?.index ?? w?.err?.index;
    // An error we cannot attribute to an op: retry everything to be safe.
    if (typeof idx !== "number") return all();
    failed.add(idx);
  }
  return failed;
};

/**
 * Write the buffered counts: one bulkWrite per model. On a write error the
 * counts of the ops that did not apply are merged back into the buffer, so the
 * next flush retries exactly those. Each model is restored independently so a
 * failure in one cannot double count the other.
 */
export async function flushActivity(): Promise<{
  activityRows: number;
  trafficRows: number;
}> {
  const activity = activityBuf;
  const traffic = trafficBuf;
  activityBuf = new Map();
  trafficBuf = new Map();

  const activityPairs = [...activity.entries()].filter(([, e]) =>
    OBJECT_ID.test(e.user),
  );
  const activityOps = activityPairs.map(([, e]) => ({
    updateOne: {
      filter: { day: e.day, user: new mongoose.Types.ObjectId(e.user) },
      update: {
        $inc: { requests: e.requests, opens: e.opens },
        $min: { firstSeenAt: new Date(e.first) },
        $max: { lastSeenAt: new Date(e.last) },
        $setOnInsert: { expiresAt: expiryOf(e.day) },
      },
      upsert: true,
    },
  }));
  const trafficPairs = [...traffic.entries()];
  const trafficOps = trafficPairs.map(([, e]) => ({
    updateOne: {
      filter: { day: e.day },
      update: {
        $inc: { requests: e.requests, authedRequests: e.authed },
        $setOnInsert: { expiresAt: expiryOf(e.day) },
      },
      upsert: true,
    },
  }));

  let activityRows = 0;
  let trafficRows = 0;

  if (activityOps.length > 0) {
    try {
      await DailyActivity.bulkWrite(activityOps, { ordered: false });
      activityRows = activityOps.length;
    } catch (err) {
      logFlushError(err);
      const failed = failedOpIndexes(err, activityOps.length);
      activityRows = activityOps.length - failed.size;
      restoreActivity(new Map(activityPairs.filter((_, i) => failed.has(i))));
    }
  }
  if (trafficOps.length > 0) {
    try {
      await DailyTraffic.bulkWrite(trafficOps, { ordered: false });
      trafficRows = trafficOps.length;
    } catch (err) {
      logFlushError(err);
      const failed = failedOpIndexes(err, trafficOps.length);
      trafficRows = trafficOps.length - failed.size;
      restoreTraffic(new Map(trafficPairs.filter((_, i) => failed.has(i))));
    }
  }
  return { activityRows, trafficRows };
}

/** Flush on a timer. The timer is unref'd; returns a function that stops it. */
export function startActivityFlush(intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    flushActivity().catch(logFlushError);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export function _resetActivityBuffersForTests(): void {
  activityBuf = new Map();
  trafficBuf = new Map();
  lastFlushLogAt = 0;
}
