import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import app from "../src/app.js";
import { connect, disconnect, resetDb, syncIndexes } from "./helpers.js";
import { AdminLoginGuard } from "../src/models/adminLoginGuardModel.js";
import { validateAdminSecret } from "../src/config/envVariables.js";
import {
  checkLock,
  recordFailure,
  recordSuccess,
} from "../src/services/adminLoginGuard.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(resetDb);

const PIN = process.env.ADMIN_SECRET_KEY as string;
const MIN = 60 * 1000;

// Each test gets its own source IP: the express-rate-limit layer in front of
// the route is in-memory and is not cleared by resetDb.
let ipCounter = 0;
const freshIp = () => `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
let currentIp = freshIp();
beforeEach(() => {
  currentIp = freshIp();
});

const login = (secretKey: string, ip = currentIp) =>
  request(app)
    .post("/api/v1/admin/login")
    .set("X-Forwarded-For", ip)
    .send({ secretKey });

describe("admin PIN login (HTTP)", () => {
  it("test setup uses the PIN A1B2C3", () => {
    expect(PIN).toBe("A1B2C3");
  });

  it("PIN login succeeds and is case-insensitive", async () => {
    const res = await login("a1b2c3").expect(200);
    expect(res.body.success).toBe(true);
    expect((res.headers["set-cookie"] as unknown as string[])[0]).toMatch(
      /^admin-token=/,
    );
    await login("A1B2C3").expect(200);
    await login("a1B2c3").expect(200);
  });

  it("wrong PIN → 401 Wrong PIN with attemptsLeft 4", async () => {
    const res = await login("ZZZZZZ").expect(401);
    expect(res.body).toMatchObject({
      success: false,
      message: "Wrong PIN",
      attemptsLeft: 4,
    });
  });

  it("a malformed PIN gets the same 401, not a 400", async () => {
    const res = await login("12").expect(401);
    expect(res.body.message).toBe("Wrong PIN");
  });

  it("5 wrong attempts → 429 with retryAfterSeconds, and the correct PIN is refused while locked", async () => {
    for (let i = 0; i < 4; i++) {
      const r = await login("ZZZZZZ").expect(401);
      expect(r.body.attemptsLeft).toBe(4 - i);
    }
    const fifth = await login("ZZZZZZ").expect(429);
    expect(fifth.body.success).toBe(false);
    expect(fifth.body.message).toMatch(/^Too many attempts\. Try again in \d+ min$/);
    expect(fifth.body.retryAfterSeconds).toBeGreaterThan(14 * 60);
    expect(fifth.body.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);

    const correct = await login(PIN).expect(429);
    expect(correct.headers["set-cookie"]).toBeUndefined();
    expect(correct.body.retryAfterSeconds).toBeGreaterThan(0);

    // Another IP is not affected by this IP's lock.
    await login(PIN, "10.1.1.2").expect(200);
  });

  it("lock persists: it is stored in the DB", async () => {
    for (let i = 0; i < 5; i++) await login("ZZZZZZ", "10.2.2.2");
    const doc = await AdminLoginGuard.findOne({ key: "ip:10.2.2.2" }).lean();
    expect(doc).toBeTruthy();
    expect(doc!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * MIN);
    expect(doc!.lockCount).toBe(1);
    expect(doc!.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 6 * 24 * 60 * MIN,
    );
  });

  it("success resets the counter", async () => {
    await login("ZZZZZZ").expect(401);
    await login("ZZZZZZ").expect(401);
    await login(PIN).expect(200);
    const res = await login("ZZZZZZ").expect(401);
    expect(res.body.attemptsLeft).toBe(4);
  });

  it("global cap: 30 failures from different IPs pauses all logins (HTTP)", async () => {
    const now = Date.now();
    for (let i = 0; i < 29; i++) await recordFailure(`10.9.0.${i}`, now);
    // The 30th failure arrives over HTTP and trips the global pause.
    const res = await login("ZZZZZZ", "10.9.1.1").expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(29 * 60);
    // A fresh IP with the correct PIN is paused too.
    await login(PIN, "10.9.1.2").expect(429);
  });
});

describe("adminLoginGuard service", () => {
  it("locks an IP after 5 failures and reports attemptsLeft", async () => {
    const now = Date.now();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await recordFailure("1.1.1.1", now));
    expect(results.map((r) => r.attemptsLeft)).toEqual([4, 3, 2, 1, 0]);
    expect(results[3].locked).toBe(false);
    expect(results[4].locked).toBe(true);
    expect(results[4].retryAfterSeconds).toBe(15 * 60);

    const check = await checkLock("1.1.1.1", now + MIN);
    expect(check.locked).toBe(true);
    expect(check.retryAfterSeconds).toBe(14 * 60);

    expect((await checkLock("1.1.1.1", now + 15 * MIN + 1)).locked).toBe(false);
    expect((await checkLock("2.2.2.2", now)).locked).toBe(false);
  });

  it("lock duration doubles on the second lock", async () => {
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await recordFailure("3.3.3.3", t0);
    const t1 = t0 + 16 * MIN; // first lock (15 min) has expired
    expect((await checkLock("3.3.3.3", t1)).locked).toBe(false);

    let last;
    for (let i = 0; i < 5; i++) last = await recordFailure("3.3.3.3", t1);
    expect(last!.locked).toBe(true);
    expect(last!.retryAfterSeconds).toBe(30 * 60);

    const t2 = t1 + 31 * MIN;
    for (let i = 0; i < 5; i++) last = await recordFailure("3.3.3.3", t2);
    expect(last!.retryAfterSeconds).toBe(60 * 60);
  });

  it("lock duration is capped at 24 hours", async () => {
    const t = Date.now();
    await AdminLoginGuard.create({
      key: "ip:4.4.4.4",
      failures: 4,
      lockCount: 20,
      expiresAt: new Date(t + 7 * 24 * 60 * MIN),
    });
    const r = await recordFailure("4.4.4.4", t);
    expect(r.locked).toBe(true);
    expect(r.retryAfterSeconds).toBe(24 * 60 * 60);
  });

  it("recordSuccess clears failures and lockCount", async () => {
    const t = Date.now();
    for (let i = 0; i < 5; i++) await recordFailure("5.5.5.5", t);
    await recordSuccess("5.5.5.5");
    const doc = await AdminLoginGuard.findOne({ key: "ip:5.5.5.5" }).lean();
    expect(doc!.failures).toBe(0);
    expect(doc!.lockCount).toBe(0);
    expect((await checkLock("5.5.5.5", t)).locked).toBe(false);
    expect((await recordFailure("5.5.5.5", t)).attemptsLeft).toBe(4);
  });

  it("global cap: 30 failures from different IPs pauses all logins for 30 min", async () => {
    const t = Date.now();
    let last;
    for (let i = 0; i < 30; i++) last = await recordFailure(`9.9.9.${i}`, t);
    expect(last!.locked).toBe(true);
    expect(last!.retryAfterSeconds).toBe(30 * 60);

    // A brand-new IP is refused, and recovers after 30 min.
    const refused = await checkLock("8.8.8.8", t + MIN);
    expect(refused.locked).toBe(true);
    expect(refused.retryAfterSeconds).toBe(29 * 60);
    expect((await checkLock("8.8.8.8", t + 30 * MIN + 1)).locked).toBe(false);
  });

  it("global failures outside the 1-hour window do not accumulate", async () => {
    const t = Date.now();
    for (let i = 0; i < 29; i++) await recordFailure(`7.7.7.${i}`, t);
    const later = t + 61 * MIN;
    const r = await recordFailure("7.7.8.1", later);
    expect(r.locked).toBe(false);
    const g = await AdminLoginGuard.findOne({ key: "global" }).lean();
    expect(g!.failures).toBe(1);
  });
});

describe("validateAdminSecret", () => {
  it("accepts a 6-character alphanumeric PIN", () => {
    expect(validateAdminSecret("A1b2C3", true)).toEqual({ ok: true, kind: "pin" });
    expect(validateAdminSecret("123456", false)).toEqual({ ok: true, kind: "pin" });
  });

  it("accepts a 24+ character legacy secret", () => {
    expect(validateAdminSecret("x".repeat(24), true)).toEqual({
      ok: true,
      kind: "secret",
    });
    expect(
      validateAdminSecret("a-very-long-secret-key-with-symbols-!@#", true),
    ).toEqual({ ok: true, kind: "secret" });
  });

  it("rejects 13 characters in production", () => {
    const r = validateAdminSecret("thirteen-char", true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/ADMIN_SECRET_KEY/);
  });

  it("rejects 7 characters", () => {
    expect(validateAdminSecret("abcdefg", true).ok).toBe(false);
    expect(validateAdminSecret("abcdefg", false).ok).toBe(false);
  });

  it("rejects a 6-character value that is not alphanumeric", () => {
    expect(validateAdminSecret("12345!", true).ok).toBe(false);
    expect(validateAdminSecret("12 456", true).ok).toBe(false);
  });
});
