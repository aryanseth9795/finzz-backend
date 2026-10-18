import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
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
  adminCookie,
} from "./helpers.js";
import {
  dayKey,
  recordActivity,
  recordRequest,
  flushActivity,
  _resetActivityBuffersForTests,
} from "../src/services/activityTracker.js";
import {
  DailyActivity,
  DailyTraffic,
} from "../src/models/dailyActivityModel.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  clearMailbox();
  _resetActivityBuffersForTests();
});

/** `res.on("finish")` can run a tick after the client has the response. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe("dayKey", () => {
  it("rolls over at local midnight (UTC+5:30)", () => {
    expect(dayKey(new Date("2026-10-17T18:29:00Z"), 330)).toBe("2026-10-17");
    expect(dayKey(new Date("2026-10-17T18:31:00Z"), 330)).toBe("2026-10-18");
  });

  it("defaults to the configured offset (IST)", () => {
    expect(dayKey(new Date("2026-10-17T18:31:00Z"))).toBe("2026-10-18");
  });
});

describe("activity buffer", () => {
  it("merges buffered calls into one row with correct first/last seen", async () => {
    const id = new mongoose.Types.ObjectId().toString();
    const t1 = new Date("2026-10-17T05:00:00Z");
    const t2 = new Date("2026-10-17T06:00:00Z");
    const t3 = new Date("2026-10-17T07:00:00Z");
    // Deliberately out of order: $min / $max must still pick the extremes.
    recordActivity(id, { now: t2 });
    recordActivity(id, { now: t3 });
    recordActivity(id, { now: t1, isOpen: true });

    const res = await flushActivity();
    expect(res.activityRows).toBe(1);

    const rows = await DailyActivity.find({ user: id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].day).toBe("2026-10-17");
    expect(rows[0].requests).toBe(3);
    expect(rows[0].opens).toBe(1);
    expect(rows[0].firstSeenAt.toISOString()).toBe(t1.toISOString());
    expect(rows[0].lastSeenAt.toISOString()).toBe(t3.toISOString());
    // expiresAt = start of local day + 180 days (day starts 2026-10-16T18:30Z).
    expect(rows[0].expiresAt.toISOString()).toBe(
      new Date(
        Date.UTC(2026, 9, 17) - 330 * 60_000 + 180 * 86_400_000,
      ).toISOString(),
    );
  });

  it("accumulates across flushes", async () => {
    const id = new mongoose.Types.ObjectId().toString();
    recordActivity(id, { now: new Date("2026-10-17T05:00:00Z") });
    recordActivity(id, { now: new Date("2026-10-17T05:01:00Z") });
    await flushActivity();
    recordActivity(id, { now: new Date("2026-10-17T09:00:00Z"), isOpen: true });
    await flushActivity();

    const rows = await DailyActivity.find({ user: id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(3);
    expect(rows[0].opens).toBe(1);
    expect(rows[0].firstSeenAt.toISOString()).toBe("2026-10-17T05:00:00.000Z");
    expect(rows[0].lastSeenAt.toISOString()).toBe("2026-10-17T09:00:00.000Z");
  });

  it("writes nothing to the database before a flush", async () => {
    const id = new mongoose.Types.ObjectId().toString();
    recordActivity(id);
    recordRequest(true);
    expect(await DailyActivity.countDocuments()).toBe(0);
    expect(await DailyTraffic.countDocuments()).toBe(0);
    await flushActivity();
    expect(await DailyActivity.countDocuments()).toBe(1);
    expect(await DailyTraffic.countDocuments()).toBe(1);
  });

  it("an empty flush is a no-op", async () => {
    expect(await flushActivity()).toEqual({ activityRows: 0, trafficRows: 0 });
  });

  it("does not throw on a garbage userId, and the flush skips it", async () => {
    expect(() => recordActivity("not-an-object-id")).not.toThrow();
    expect(() => recordActivity(undefined as unknown as string)).not.toThrow();
    const res = await flushActivity();
    expect(res.activityRows).toBe(0);
    expect(await DailyActivity.countDocuments()).toBe(0);
  });
});

describe("traffic counters", () => {
  it("counts unauthenticated requests too (requests >= authedRequests)", async () => {
    const now = new Date("2026-10-17T05:00:00Z");
    recordRequest(false, now);
    recordRequest(false, now);
    recordRequest(true, now);
    const res = await flushActivity();
    expect(res.trafficRows).toBe(1);

    const row = await DailyTraffic.findOne({ day: "2026-10-17" }).lean();
    expect(row!.requests).toBe(3);
    expect(row!.authedRequests).toBe(1);
    expect(row!.requests).toBeGreaterThanOrEqual(row!.authedRequests);
  });
});

describe("through the real app", () => {
  it("counts opens only for GET /users/profile", async () => {
    const user = await registerUser(app);
    await settle();
    // Registration itself makes unauthenticated calls; start from a clean slate.
    _resetActivityBuffersForTests();

    await request(app)
      .get("/api/v1/users/profile?x=1")
      .set(auth(user.accessToken))
      .expect(200);
    await request(app)
      .get("/api/v1/users/profile")
      .set(auth(user.accessToken))
      .expect(200);
    await request(app)
      .get("/api/v1/notes")
      .set(auth(user.accessToken))
      .expect(200);
    await settle();

    await flushActivity();
    const rows = await DailyActivity.find({ user: user.id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].opens).toBe(2);
    expect(rows[0].requests).toBe(3);

    const traffic = await DailyTraffic.findOne({ day: rows[0].day }).lean();
    expect(traffic!.requests).toBe(3);
    expect(traffic!.authedRequests).toBe(3);
  });

  it("counts unauthenticated API requests in the app-level traffic", async () => {
    await request(app).get("/api/v1/users/profile").expect(401);
    await settle();
    await flushActivity();

    expect(await DailyActivity.countDocuments()).toBe(0);
    const rows = await DailyTraffic.find().lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(1);
    expect(rows[0].authedRequests).toBe(0);
  });
});

describe("admin traffic is excluded from the request counter", () => {
  it("does not count /api/v1/admin calls, but still counts other API calls", async () => {
    const cookie = await adminCookie(app);
    await request(app)
      .get("/api/v1/admin/analytics/traffic")
      .set("Cookie", cookie)
      .expect(200);
    await settle();
    // The traffic endpoint flushes; drop whatever it wrote and start clean.
    await DailyTraffic.deleteMany({});
    _resetActivityBuffersForTests();

    await request(app)
      .get("/api/v1/admin/analytics/traffic")
      .set("Cookie", cookie)
      .expect(200);
    await request(app).get("/api/v1/users/profile").expect(401);
    await settle();
    await flushActivity();

    const rows = await DailyTraffic.find().lean();
    expect(rows).toHaveLength(1);
    // Only the non-admin call is counted.
    expect(rows[0].requests).toBe(1);
  });
});

describe("partial bulkWrite failures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("merges back only the ops listed in writeErrors", async () => {
    const a = new mongoose.Types.ObjectId().toString();
    const b = new mongoose.Types.ObjectId().toString();
    const now = new Date("2026-10-17T05:00:00Z");
    recordActivity(a, { now });
    recordActivity(b, { now });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = DailyActivity.bulkWrite.bind(DailyActivity);
    const spy = vi.spyOn(DailyActivity, "bulkWrite").mockImplementationOnce(
      (async (ops: any[]) => {
        // Apply op 0 for real, fail op 1: exactly what an unordered bulk does.
        await real([ops[0]], { ordered: false });
        const err: any = new Error("partial");
        err.name = "MongoBulkWriteError";
        err.writeErrors = [{ index: 1, errmsg: "boom" }];
        throw err;
      }) as any,
    );

    const first = await flushActivity();
    expect(first.activityRows).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second flush retries only user b. If a were merged back too it would
    // be counted twice.
    await flushActivity();
    const rows = await DailyActivity.find().sort({ user: 1 }).lean();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.requests).toBe(1);
  });

  it("treats a lone writeConcernError as applied (no retry, no double count)", async () => {
    const a = new mongoose.Types.ObjectId().toString();
    recordActivity(a, { now: new Date("2026-10-17T05:00:00Z") });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const real = DailyActivity.bulkWrite.bind(DailyActivity);
    vi.spyOn(DailyActivity, "bulkWrite").mockImplementationOnce(
      (async (ops: any[]) => {
        await real(ops, { ordered: false });
        const err: any = new Error("wc");
        err.name = "MongoBulkWriteError";
        err.writeErrors = [];
        err.writeConcernError = { errmsg: "timeout" };
        throw err;
      }) as any,
    );

    const res = await flushActivity();
    expect(res.activityRows).toBe(1);
    await flushActivity();
    const rows = await DailyActivity.find({ user: a }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].requests).toBe(1);
  });

  it("still restores everything on a non-bulk error", async () => {
    const a = new mongoose.Types.ObjectId().toString();
    recordActivity(a, { now: new Date("2026-10-17T05:00:00Z") });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(DailyActivity, "bulkWrite").mockRejectedValueOnce(
      new Error("network down"),
    );
    expect((await flushActivity()).activityRows).toBe(0);
    expect((await flushActivity()).activityRows).toBe(1);
    expect((await DailyActivity.findOne({ user: a }).lean())!.requests).toBe(1);
  });
});

describe("flush error log throttle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs a repeated flush failure at most once per minute", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(DailyActivity, "bulkWrite").mockRejectedValue(new Error("down"));
    const a = new mongoose.Types.ObjectId().toString();
    for (let i = 0; i < 3; i++) {
      recordActivity(a);
      await flushActivity();
    }
    const flushLogs = errSpy.mock.calls.filter((c) =>
      String(c[0]).includes("[activity] flush failed"),
    );
    expect(flushLogs).toHaveLength(1);
  });
});

describe("ANALYTICS_TZ_OFFSET_MINUTES validation", () => {
  const saved = process.env.ANALYTICS_TZ_OFFSET_MINUTES;
  afterEach(() => {
    if (saved === undefined) delete process.env.ANALYTICS_TZ_OFFSET_MINUTES;
    else process.env.ANALYTICS_TZ_OFFSET_MINUTES = saved;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  const load = async (value: string | undefined) => {
    if (value === undefined) delete process.env.ANALYTICS_TZ_OFFSET_MINUTES;
    else process.env.ANALYTICS_TZ_OFFSET_MINUTES = value;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    await import("../src/services/activityTracker.js");
    const calls = warn.mock.calls.filter((c) =>
      String(c[0]).includes("ANALYTICS_TZ_OFFSET_MINUTES"),
    );
    warn.mockRestore();
    return calls;
  };

  it("warns once when the value is set but invalid", async () => {
    expect(await load("banana")).toHaveLength(1);
    expect(await load("99999")).toHaveLength(1);
  });

  it("does not warn for a valid value or when unset", async () => {
    expect(await load("330")).toHaveLength(0);
    expect(await load("0")).toHaveLength(0);
    expect(await load(undefined)).toHaveLength(0);
  });
});
