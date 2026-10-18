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
import crypto from "crypto";
import request from "supertest";
import "./mailbox.js";
import app from "../src/app.js";
import { connect, disconnect, resetDb, syncIndexes } from "./helpers.js";
import { AdminLoginGuard } from "../src/models/adminLoginGuardModel.js";
import {
  validateAdminSecret,
  wrongAdminCredentialMessage,
  parseTrustProxyHops,
  TRUST_PROXY_HOPS,
} from "../src/config/envVariables.js";
import {
  checkLock,
  reserveAttempt,
  recordSuccess,
  guardKeyForIp,
} from "../src/services/adminLoginGuard.js";

/** A wrong guess: reserve the attempt and never match. */
const recordFailure = (ip: string, now?: number) => reserveAttempt(ip, now);

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
    expect(Number(fifth.headers["retry-after"])).toBe(
      fifth.body.retryAfterSeconds,
    );

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
      windowStart: new Date(t),
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
    expect(validateAdminSecret("123456", false)).toEqual({
      ok: true,
      kind: "pin",
      weak: true,
    });
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

describe("reserve-before-compare (concurrency)", () => {
  let compares: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    compares = vi.spyOn(crypto, "timingSafeEqual");
  });
  afterEach(() => {
    compares.mockRestore();
  });

  it("120 concurrent wrong guesses from 120 IPs → at most 30 compares, the rest 429", async () => {
    const ips = Array.from({ length: 120 }, (_, i) => `10.50.0.${i + 1}`);
    const responses = await Promise.all(ips.map((ip) => login("ZZZZZZ", ip)));
    expect(compares.mock.calls.length).toBeLessThanOrEqual(30);
    const wrong = responses.filter((r) => r.status === 401).length;
    const locked = responses.filter((r) => r.status === 429).length;
    expect(wrong + locked).toBe(120);
    expect(wrong).toBeLessThanOrEqual(30);
    expect(locked).toBeGreaterThanOrEqual(90);
  });

  it("10 concurrent wrong guesses from one IP → at most 5 compares", async () => {
    const ip = "10.51.0.1";
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => login("ZZZZZZ", ip)),
    );
    expect(compares.mock.calls.length).toBeLessThanOrEqual(5);
    expect(responses.filter((r) => r.status === 401).length).toBeLessThanOrEqual(4);
    expect(responses.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(6);
    // The lock was applied exactly once.
    const doc = await AdminLoginGuard.findOne({ key: guardKeyForIp(ip) }).lean();
    expect(doc!.lockCount).toBe(1);
  });

  it("a refused attempt never compares, even with the correct PIN", async () => {
    for (let i = 0; i < 5; i++) await login("ZZZZZZ", "10.52.0.1");
    compares.mockClear();
    await login(PIN, "10.52.0.1").expect(429);
    expect(compares).not.toHaveBeenCalled();
  });

  it("a correct login gives its global reservation back", async () => {
    await login("ZZZZZZ", "10.53.0.1").expect(401);
    await login(PIN, "10.53.0.2").expect(200);
    const g = await AdminLoginGuard.findOne({ key: "global" }).lean();
    expect(g!.failures).toBe(1);
  });
});

describe("global lock escalation", () => {
  const trip = async (t: number, tag: string) => {
    let last;
    for (let i = 0; i < 30; i++) last = await reserveAttempt(`${tag}.${i}`, t);
    return last!;
  };

  it("doubles each time: 30 min, 60 min, 120 min", async () => {
    const t0 = Date.now();
    expect((await trip(t0, "20.0.0")).retryAfterSeconds).toBe(30 * 60);
    const t1 = t0 + 31 * MIN;
    expect((await trip(t1, "20.0.1")).retryAfterSeconds).toBe(60 * 60);
    const t2 = t1 + 61 * MIN;
    expect((await trip(t2, "20.0.2")).retryAfterSeconds).toBe(120 * 60);
    const g = await AdminLoginGuard.findOne({ key: "global" }).lean();
    expect(g!.lockCount).toBe(3);
  });

  it("is capped at 24 hours", async () => {
    const t = Date.now();
    await AdminLoginGuard.create({
      key: "global",
      failures: 29,
      windowStart: new Date(t),
      lockCount: 10,
      expiresAt: new Date(t + 7 * 24 * 60 * MIN),
    });
    const r = await reserveAttempt("20.1.0.1", t);
    expect(r.locked).toBe(true);
    expect(r.retryAfterSeconds).toBe(24 * 60 * 60);
  });

  it("decays back to 30 min after 24 h without a global lock", async () => {
    const t0 = Date.now();
    await trip(t0, "20.2.0");
    await trip(t0 + 31 * MIN, "20.2.1"); // second lock: 60 min
    const lastLockEnd = t0 + 31 * MIN + 60 * MIN;
    const later = lastLockEnd + 25 * 60 * MIN;
    expect((await trip(later, "20.2.2")).retryAfterSeconds).toBe(30 * 60);
    const g = await AdminLoginGuard.findOne({ key: "global" }).lean();
    expect(g!.lockCount).toBe(1);
  });

  it("does not decay when the last lock ended less than 24 h ago", async () => {
    const t0 = Date.now();
    await trip(t0, "20.3.0");
    const soon = t0 + 30 * MIN + 23 * 60 * MIN;
    expect((await trip(soon, "20.3.1")).retryAfterSeconds).toBe(60 * 60);
  });
});

describe("per-IP rolling window", () => {
  it("failures older than 1 hour no longer count towards the lock", async () => {
    const t = Date.now();
    for (let i = 0; i < 4; i++) await reserveAttempt("21.0.0.1", t);
    const later = t + 61 * MIN;
    const r = await reserveAttempt("21.0.0.1", later);
    expect(r.locked).toBe(false);
    expect(r.attemptsLeft).toBe(4);
  });

  it("failures inside the hour still add up", async () => {
    const t = Date.now();
    for (let i = 0; i < 4; i++)
      await reserveAttempt("21.0.0.2", t + i * 10 * MIN);
    const r = await reserveAttempt("21.0.0.2", t + 50 * MIN);
    expect(r.locked).toBe(true);
  });
});

describe("IPv6 bucketing", () => {
  it("addresses in the same subnet share one key", () => {
    expect(guardKeyForIp("2001:db8::1")).toBe(guardKeyForIp("2001:db8::6"));
    expect(guardKeyForIp("2001:db8::1")).not.toBe(guardKeyForIp("2001:db9::1"));
    expect(guardKeyForIp("10.0.0.1")).not.toBe(guardKeyForIp("10.0.0.2"));
  });

  it("five guesses spread over one v6 subnet lock that subnet", async () => {
    const t = Date.now();
    let last;
    for (let i = 1; i <= 5; i++) last = await reserveAttempt(`2001:db8::${i}`, t);
    expect(last!.locked).toBe(true);
    expect((await checkLock("2001:db8::ff", t)).locked).toBe(true);
    expect((await checkLock("2001:db9::1", t)).locked).toBe(false);
  });
});

describe("operator visibility", () => {
  it("warns with the IP and duration when an IP lock trips, never the input", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) await login("HUNTER2", "10.60.0.9");
      const lines = warn.mock.calls.map((c) => c.join(" "));
      const tripped = lines.find((l) => l.includes("10.60.0.9"));
      expect(tripped).toBeTruthy();
      expect(tripped).toMatch(/15 min/);
      expect(lines.join("\n")).not.toMatch(/HUNTER2/i);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when the global lock trips", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let i = 0; i < 30; i++) await reserveAttempt(`10.61.0.${i}`);
      const lines = warn.mock.calls.map((c) => c.join(" "));
      expect(
        lines.some(
          (l) => /global/i.test(l) && /30 min/.test(l) && l.includes("10.61.0.29"),
        ),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("ADMIN_LOGIN_ALLOWLIST_IPS", () => {
  afterEach(() => {
    delete process.env.ADMIN_LOGIN_ALLOWLIST_IPS;
  });

  it("skips the global lock but never the per-IP lock", async () => {
    process.env.ADMIN_LOGIN_ALLOWLIST_IPS = " 10.70.0.1 , 10.70.0.2";
    const t = Date.now();
    for (let i = 0; i < 30; i++) await reserveAttempt(`10.71.0.${i}`, t);
    // Everyone else is paused...
    expect((await reserveAttempt("10.71.9.9", t + MIN)).allowed).toBe(false);
    // ...but the allowlisted address still gets to try.
    const ok = await reserveAttempt("10.70.0.1", t + MIN);
    expect(ok.allowed).toBe(true);
    expect(ok.locked).toBe(false);
    // Its own per-IP lock still applies.
    let last = ok;
    for (let i = 0; i < 4; i++) last = await reserveAttempt("10.70.0.1", t + MIN);
    expect(last.locked).toBe(true);
    expect((await reserveAttempt("10.70.0.1", t + 2 * MIN)).allowed).toBe(false);
  });

  it("allowlisted attempts do not count towards the global lock", async () => {
    process.env.ADMIN_LOGIN_ALLOWLIST_IPS = "10.72.0.1";
    await reserveAttempt("10.72.0.1");
    expect(await AdminLoginGuard.findOne({ key: "global" }).lean()).toBeNull();
  });
});

describe("credential wording", () => {
  it("names the PIN in PIN mode and the secret key in secret mode", () => {
    expect(wrongAdminCredentialMessage("pin")).toBe("Wrong PIN");
    expect(wrongAdminCredentialMessage("secret")).toBe("Wrong secret key");
  });
});

describe("digits-only PIN", () => {
  it("is flagged weak; alphanumeric PINs and long secrets are not", () => {
    expect(validateAdminSecret("123456", true)).toEqual({
      ok: true,
      kind: "pin",
      weak: true,
    });
    expect(validateAdminSecret("12345A", true)).toEqual({ ok: true, kind: "pin" });
    expect(validateAdminSecret("1".repeat(24), true)).toEqual({
      ok: true,
      kind: "secret",
    });
  });
});

describe("TRUST_PROXY_HOPS", () => {
  it("defaults to 1 when unset or blank, silently", () => {
    const warn = vi.fn();
    expect(parseTrustProxyHops(undefined, warn)).toBe(1);
    expect(parseTrustProxyHops("", warn)).toBe(1);
    expect(parseTrustProxyHops("   ", warn)).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a non-negative whole number of hops", () => {
    const warn = vi.fn();
    expect(parseTrustProxyHops("0", warn)).toBe(0);
    expect(parseTrustProxyHops("1", warn)).toBe(1);
    expect(parseTrustProxyHops(" 2 ", warn)).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(["abc", "-1", "1.5", "true", "2x", "1e3"])(
    "an invalid value (%s) warns once and falls back to 1",
    (raw) => {
      const warn = vi.fn();
      expect(parseTrustProxyHops(raw, warn)).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(/TRUST_PROXY_HOPS/);
    },
  );

  it("the app trusts exactly that many proxy hops (default 1)", () => {
    expect(TRUST_PROXY_HOPS).toBe(1);
    expect(app.get("trust proxy")).toBe(TRUST_PROXY_HOPS);
  });
});

describe("a refused attempt does not lock its IP (M3)", () => {
  it("the IP's 5th attempt arrives while the global step refuses → no IP lock, lockCount unchanged", async () => {
    const t = Date.now();
    const ip = "22.0.0.1";
    await AdminLoginGuard.create({
      key: guardKeyForIp(ip),
      failures: 4,
      windowStart: new Date(t),
      lockCount: 2,
      expiresAt: new Date(t + 7 * 24 * 60 * MIN),
    });
    // The global cap is already used up but its lock has not landed yet (the
    // 30th reservation is still in flight), so the cheap pre-check passes and
    // the refusal comes from the global reservation itself.
    await AdminLoginGuard.create({
      key: "global",
      failures: 30,
      windowStart: new Date(t),
      lockCount: 0,
      expiresAt: new Date(t + 7 * 24 * 60 * MIN),
    });
    const r = await reserveAttempt(ip, t);
    expect(r.allowed).toBe(false);
    const doc = await AdminLoginGuard.findOne({ key: guardKeyForIp(ip) }).lean();
    expect(doc!.lockedUntil).toBeNull();
    expect(doc!.lockCount).toBe(2);
    expect(doc!.failures).toBe(4);
  });
});

describe("Retry-After reports the later lock (M4)", () => {
  const seed = (key: string, t: number, lockMs: number) =>
    AdminLoginGuard.create({
      key,
      failures: 0,
      windowStart: null,
      lockedUntil: new Date(t + lockMs),
      lockCount: 1,
      expiresAt: new Date(t + 7 * 24 * 60 * MIN),
    });

  it("IP locked for 24 h while global is locked for 30 min → 24 h", async () => {
    const t = Date.now();
    await seed(guardKeyForIp("23.0.0.1"), t, 24 * 60 * MIN);
    await seed("global", t, 30 * MIN);
    const r = await reserveAttempt("23.0.0.1", t);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(24 * 60 * 60);
  });

  it("IP locked for 15 min while global is locked for 30 min → 30 min", async () => {
    const t = Date.now();
    await seed(guardKeyForIp("23.0.0.2"), t, 15 * MIN);
    await seed("global", t, 30 * MIN);
    const r = await reserveAttempt("23.0.0.2", t);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSeconds).toBe(30 * 60);
  });
});

describe("success only frees a global slot in its own window (M2)", () => {
  it("reserveAttempt reports its reservation time", async () => {
    const t = Date.now();
    expect((await reserveAttempt("24.0.0.1", t)).reservedAt).toBe(t);
  });

  it("a success whose reservation predates the current window does not decrement it", async () => {
    const t = Date.now();
    const mine = await reserveAttempt("24.0.1.1", t);
    // The global window rolls over before the success is recorded.
    const later = t + 61 * MIN;
    await reserveAttempt("24.0.1.2", later);
    await recordSuccess("24.0.1.1", mine.reservedAt);
    const g = await AdminLoginGuard.findOne({ key: "global" }).lean();
    expect(g!.failures).toBe(1);
  });

  it("a success inside the current window gives its slot back", async () => {
    const t = Date.now();
    await reserveAttempt("24.0.2.1", t);
    const mine = await reserveAttempt("24.0.2.2", t + MIN);
    await recordSuccess("24.0.2.2", mine.reservedAt);
    const g = await AdminLoginGuard.findOne({ key: "global" }).lean();
    expect(g!.failures).toBe(1);
  });
});

describe("allowlist and IPv4-mapped addresses (M6)", () => {
  afterEach(() => {
    delete process.env.ADMIN_LOGIN_ALLOWLIST_IPS;
  });

  const tripGlobal = async (t: number) => {
    for (let i = 0; i < 30; i++) await reserveAttempt(`25.0.0.${i}`, t);
  };

  it("::ffff:a.b.c.d matches a plain a.b.c.d entry", async () => {
    process.env.ADMIN_LOGIN_ALLOWLIST_IPS = "25.1.0.1";
    const t = Date.now();
    await tripGlobal(t);
    expect((await reserveAttempt("::ffff:25.1.0.1", t + MIN)).allowed).toBe(true);
    expect((await reserveAttempt("::FFFF:25.1.0.9", t + MIN)).allowed).toBe(false);
  });

  it("an ::ffff:a.b.c.d entry matches the plain address", async () => {
    process.env.ADMIN_LOGIN_ALLOWLIST_IPS = "::ffff:25.1.0.2";
    const t = Date.now();
    await tripGlobal(t);
    expect((await reserveAttempt("25.1.0.2", t + MIN)).allowed).toBe(true);
  });
});
