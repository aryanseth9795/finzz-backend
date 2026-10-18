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
  adminCookie as loginAdmin,
} from "./helpers.js";
import {
  dayKey,
  flushActivity,
  _resetActivityBuffersForTests,
} from "../src/services/activityTracker.js";
import {
  DailyActivity,
  DailyTraffic,
} from "../src/models/dailyActivityModel.js";
import { User } from "../src/models/userModel.js";
import { PushTicket } from "../src/models/pushTicketModel.js";

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

const DAY_MS = 86_400_000;
const URL = "/api/v1/admin/analytics/traffic";
const daysAgo = (n: number) => dayKey(new Date(Date.now() - n * DAY_MS));
const oid = () => new mongoose.Types.ObjectId();

/**
 * Log in as admin, then drop the traffic the login itself generated (every
 * API request is counted), so the tests control the request totals exactly.
 */
const adminCookie = async (): Promise<string> => {
  const cookie = await loginAdmin(app);
  await new Promise((r) => setTimeout(r, 50));
  await flushActivity();
  await DailyTraffic.deleteMany({});
  return cookie;
};

const seedActivity = (
  day: string,
  user: mongoose.Types.ObjectId,
  requests: number,
  opens: number,
  lastSeenAt = new Date(),
) =>
  DailyActivity.create({
    day,
    user,
    requests,
    opens,
    firstSeenAt: lastSeenAt,
    lastSeenAt,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
  });

const seedTraffic = (day: string, requests: number, authedRequests: number) =>
  DailyTraffic.create({
    day,
    requests,
    authedRequests,
    expiresAt: new Date(Date.now() + 30 * DAY_MS),
  });

describe("GET /admin/analytics/traffic", () => {
  it("refuses a request without an admin session", async () => {
    await request(app).get(URL).expect(401);
  });

  it("returns exactly `days` zero-filled entries, oldest to newest (default 30)", async () => {
    const cookie = await adminCookie();
    const res = await request(app).get(URL).set("Cookie", cookie).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.days).toHaveLength(30);
    expect(res.body.days[0]).toEqual({
      date: daysAgo(29),
      activeUsers: 0,
      opens: 0,
      requests: 0,
      newUsers: 0,
    });
    expect(res.body.days[29].date).toBe(daysAgo(0));
    expect(res.body.today).toEqual({
      activeUsers: 0,
      opens: 0,
      requests: 0,
      newUsers: 0,
    });
    expect(res.body.totals).toEqual({ dau: 0, wau: 0, mau: 0, stickiness: 0 });
    expect(res.body.topToday).toEqual([]);

    const seven = await request(app)
      .get(`${URL}?days=7`)
      .set("Cookie", cookie)
      .expect(200);
    expect(seven.body.days).toHaveLength(7);
  });

  it("rejects days outside 1-90", async () => {
    const cookie = await adminCookie();
    await request(app).get(`${URL}?days=0`).set("Cookie", cookie).expect(400);
    await request(app).get(`${URL}?days=91`).set("Cookie", cookie).expect(400);
    await request(app).get(`${URL}?days=abc`).set("Cookie", cookie).expect(400);
    await request(app).get(`${URL}?days=90`).set("Cookie", cookie).expect(200);
  });

  it("reports counts for today and yesterday from the seeded rows", async () => {
    const cookie = await adminCookie();
    const [a, b, c] = [oid(), oid(), oid()];
    await seedActivity(daysAgo(0), a, 10, 2);
    await seedActivity(daysAgo(0), b, 5, 1);
    await seedActivity(daysAgo(1), a, 7, 1);
    await seedActivity(daysAgo(1), b, 3, 0);
    await seedActivity(daysAgo(1), c, 4, 2);
    await seedTraffic(daysAgo(0), 100, 15);
    await seedTraffic(daysAgo(1), 80, 14);

    const res = await request(app).get(URL).set("Cookie", cookie).expect(200);
    expect(res.body.today).toMatchObject({
      activeUsers: 2,
      opens: 3,
      requests: 100,
      newUsers: 0,
    });
    const days = res.body.days;
    expect(days[29]).toMatchObject({
      date: daysAgo(0),
      activeUsers: 2,
      opens: 3,
      requests: 100,
    });
    expect(days[28]).toMatchObject({
      date: daysAgo(1),
      activeUsers: 3,
      opens: 3,
      requests: 80,
    });
    expect(days[27]).toMatchObject({ activeUsers: 0, opens: 0, requests: 0 });
  });

  it("computes dau / wau / mau as distinct users and stickiness", async () => {
    const cookie = await adminCookie();
    const [a, b, c, d, e] = [oid(), oid(), oid(), oid(), oid()];
    await seedActivity(daysAgo(0), a, 1, 0); // today
    await seedActivity(daysAgo(1), a, 1, 0); // a again: still one user
    await seedActivity(daysAgo(3), b, 1, 0); // within 7 days
    await seedActivity(daysAgo(6), c, 1, 0); // 7th day (inclusive of today)
    await seedActivity(daysAgo(7), d, 1, 0); // outside wau, inside mau
    await seedActivity(daysAgo(29), e, 1, 0); // 30th day
    await seedActivity(daysAgo(30), oid(), 1, 0); // outside mau

    const res = await request(app).get(URL).set("Cookie", cookie).expect(200);
    expect(res.body.totals).toEqual({
      dau: 1,
      wau: 3,
      mau: 5,
      stickiness: 0.2,
    });
  });

  it("computes wau / mau independent of the requested range", async () => {
    const cookie = await adminCookie();
    await seedActivity(daysAgo(20), oid(), 1, 0);
    const res = await request(app)
      .get(`${URL}?days=7`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.totals.mau).toBe(1);
    expect(res.body.days).toHaveLength(7);
  });

  it("lists today's top users by requests, ties by lastSeenAt, with names", async () => {
    const cookie = await adminCookie();
    const u1 = await registerUser(app, { name: "Alice" });
    const u2 = await registerUser(app, { name: "Bob" });
    const u3 = await registerUser(app, { name: "Cara" });
    const now = Date.now();
    await seedActivity(daysAgo(0), new mongoose.Types.ObjectId(u1.id), 5, 1, new Date(now - 60_000));
    await seedActivity(daysAgo(0), new mongoose.Types.ObjectId(u2.id), 9, 2, new Date(now - 120_000));
    await seedActivity(daysAgo(0), new mongoose.Types.ObjectId(u3.id), 5, 0, new Date(now - 10_000));

    const res = await request(app).get(URL).set("Cookie", cookie).expect(200);
    const top = res.body.topToday;
    expect(top.map((t: any) => t.name)).toEqual(["Bob", "Cara", "Alice"]);
    expect(top[0]).toMatchObject({
      userId: u2.id,
      name: "Bob",
      requests: 9,
      opens: 2,
    });
    expect(new Date(top[0].lastSeenAt).getTime()).toBe(now - 120_000);
  });

  it("caps topToday at 10", async () => {
    const cookie = await adminCookie();
    for (let i = 0; i < 12; i++) await seedActivity(daysAgo(0), oid(), i + 1, 0);
    const res = await request(app).get(URL).set("Cookie", cookie).expect(200);
    expect(res.body.topToday).toHaveLength(10);
    expect(res.body.topToday[0].requests).toBe(12);
    expect(res.body.today.activeUsers).toBe(12);
  });

  it("counts new users by sign-up day", async () => {
    const cookie = await adminCookie();
    const u1 = await registerUser(app);
    await registerUser(app);
    // Move one user's sign-up to yesterday.
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(u1.id) },
      { $set: { createdAt: new Date(Date.now() - DAY_MS) } },
    );

    const res = await request(app).get(URL).set("Cookie", cookie).expect(200);
    expect(res.body.today.newUsers).toBe(1);
    expect(res.body.days[29].newUsers).toBe(1);
    expect(res.body.days[28].newUsers).toBe(1);
    expect(res.body.days[27].newUsers).toBe(0);
  });
});

describe("trackingSince", () => {
  it("is null when no traffic has been recorded", async () => {
    const cookie = await adminCookie();
    const res = await request(app).get(URL).set("Cookie", cookie).expect(200);
    expect(res.body.trackingSince).toBeNull();
  });

  it("is the earliest DailyTraffic.day, even outside the requested range", async () => {
    const cookie = await adminCookie();
    await seedTraffic(daysAgo(50), 5, 1);
    await seedTraffic(daysAgo(10), 5, 1);
    await seedTraffic(daysAgo(2), 5, 1);
    const res = await request(app)
      .get(`${URL}?days=7`)
      .set("Cookie", cookie)
      .expect(200);
    expect(res.body.trackingSince).toBe(daysAgo(50));
  });
});

describe("DELETE /admin/users/:id purges activity", () => {
  it("removes the user's DailyActivity rows and leaves others", async () => {
    const cookie = await adminCookie();
    const victim = await registerUser(app);
    const other = await registerUser(app);
    const vid = new mongoose.Types.ObjectId(victim.id);
    const otherId = new mongoose.Types.ObjectId(other.id);
    await seedActivity(daysAgo(0), vid, 3, 1);
    await seedActivity(daysAgo(1), vid, 2, 0);
    await seedActivity(daysAgo(0), otherId, 4, 1);

    await request(app)
      .delete(`/api/v1/admin/users/${victim.id}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(await DailyActivity.countDocuments({ user: vid })).toBe(0);
    expect(await DailyActivity.countDocuments({ user: otherId })).toBe(1);
  });
});

describe("DELETE /admin/users/:id purges push tickets", () => {
  it("removes the user's PushTicket rows and leaves others", async () => {
    const cookie = await adminCookie();
    const victim = await registerUser(app);
    const other = await registerUser(app);
    await PushTicket.create([
      { ticketId: "t-victim-1", token: "ExponentPushToken[v1]", userId: victim.id },
      { ticketId: "t-other-1", token: "ExponentPushToken[o1]", userId: other.id },
    ]);

    await request(app)
      .delete(`/api/v1/admin/users/${victim.id}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(await PushTicket.countDocuments({ userId: victim.id })).toBe(0);
    expect(await PushTicket.countDocuments({ userId: other.id })).toBe(1);
  });
});
