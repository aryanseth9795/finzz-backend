import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  befriend,
  auth,
  nextPhone,
  type TestUser,
} from "./helpers.js";
import { escapeHtml, html, raw } from "../src/utils/html.js";
import { escapeRegex, buildSearchRegex } from "../src/utils/escapeRegex.js";
import { decodeCursor, cursorFilter, encodeCursor } from "../src/utils/cursor.js";
import { periodOf, isPastPeriod, monthRangeUtc } from "../src/utils/dates.js";
import mongoose from "mongoose";

/** The classic payload set. */
const XSS_PAYLOADS = [
  `<script>alert(1)</script>`,
  `<img src=x onerror=alert(1)>`,
  `" onmouseover="alert(1)`,
  `'><svg/onload=alert(1)>`,
  "javascript:alert(1)",
];

describe("BE-009 — HTML escaping (unit)", () => {
  it("neutralises every payload", () => {
    for (const payload of XSS_PAYLOADS) {
      const out = escapeHtml(payload);
      expect(out).not.toContain("<script");
      expect(out).not.toContain("<img");
      expect(out).not.toContain("<svg");
      // Quotes and = are escaped too, so unquoted attributes cannot be broken
      // out of — `onerror=alert(1)` cannot survive inside `<img src=x ...>`.
      expect(out).not.toMatch(/[<>"'`=]/);
    }
  });

  it("preserves legitimate text meaning", () => {
    // Escaping on OUTPUT rather than input is what keeps this readable: a
    // sanitise-on-input approach would have mangled the stored remark.
    expect(escapeHtml("R&D < budget")).toBe("R&amp;D &lt; budget");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });

  it("escapes interpolations in the html tagged template but not raw markup", () => {
    const out = html`<td>${`<script>x</script>`}</td>${raw("<br/>")}`;
    expect(out).toBe("<td>&lt;script&gt;x&lt;/script&gt;</td><br/>");
  });
});

describe("BE-024 — regex escaping (unit)", () => {
  it("escapes every metacharacter", () => {
    expect(escapeRegex("(a+)+$")).toBe("\\(a\\+\\)\\+\\$");
    expect(escapeRegex("a.b*c")).toBe("a\\.b\\*c");
    expect(new RegExp(escapeRegex("(work")).test("(work")).toBe(true);
  });

  it("caps search length and rejects non-strings", () => {
    expect(buildSearchRegex({ $ne: null })).toBeNull();
    expect(buildSearchRegex("")).toBeNull();
    expect(buildSearchRegex("x".repeat(500))!.$regex.length).toBeLessThanOrEqual(64);
  });
});

describe("BE-018 — cursor (unit)", () => {
  it("round-trips a compound cursor", () => {
    const d = new Date("2026-08-01T10:00:00.000Z");
    const id = new mongoose.Types.ObjectId();
    const parsed = decodeCursor(encodeCursor(d, id));
    expect(parsed!.date.toISOString()).toBe(d.toISOString());
    expect(String(parsed!.id)).toBe(String(id));
  });

  it("accepts a legacy bare-ISO cursor and degrades to date-only", () => {
    const parsed = decodeCursor("2026-08-01T10:00:00.000Z");
    expect(parsed!.id).toBeUndefined();
    expect(cursorFilter(parsed)).toEqual({
      date: { $lt: new Date("2026-08-01T10:00:00.000Z") },
    });
  });

  it("emits the tie-breaking predicate for a compound cursor", () => {
    const d = new Date("2026-08-01T10:00:00.000Z");
    const id = new mongoose.Types.ObjectId();
    const filter = cursorFilter(decodeCursor(encodeCursor(d, id))) as {
      $or: unknown[];
    };
    // date < d  OR  (date = d AND _id < id) — this is what stopped same-day
    // rows being silently skipped.
    expect(filter.$or).toHaveLength(2);
  });

  it("rejects garbage rather than producing a filter that matches everything", () => {
    expect(decodeCursor("garbage")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor({ $ne: null })).toBeNull();
    expect(cursorFilter(null)).toEqual({});
  });
});

describe("BE-019 — timezone handling (unit)", () => {
  it("buckets local-midnight-on-the-1st into the correct month for IST", () => {
    // 1 Aug 2026 00:00 IST === 2026-07-31T18:30:00Z. Under the old
    // server-local-time logic this filed into JULY.
    const instant = new Date("2026-07-31T18:30:00.000Z");
    expect(periodOf(instant, 330)).toEqual({ year: 2026, month: 8 });
    // With no offset supplied it falls back to UTC — the legacy behaviour, so
    // existing rows are not retroactively reclassified.
    expect(periodOf(instant, 0)).toEqual({ year: 2026, month: 7 });
  });

  it("returns a half-open month range", () => {
    const { start, end } = monthRangeUtc(2026, 8, 0);
    expect(start.toISOString()).toBe("2026-08-01T00:00:00.000Z");
    // Exclusive upper bound: `23:59:59` excluded the final 999ms of the month,
    // so a transaction at 23:59:59.500 vanished from that month's list.
    expect(end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("compares periods numerically, defeating the string-year bug", () => {
    const now = new Date();
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + 1;
    expect(isPastPeriod(y, m)).toBe(false);
    expect(isPastPeriod(y - 1, 12)).toBe(true);
    expect(isPastPeriod(y + 1, 1)).toBe(false);
    // `"2026" === 2026` is false, which is exactly how the old guard let a
    // user close their own CURRENT ledger.
    expect(isPastPeriod(Number("2020"), 1)).toBe(true);
  });
});

describe("BE-009 — XSS end-to-end through the export", () => {
  let alice: TestUser;
  let bob: TestUser;
  let chatId: string;

  beforeAll(async () => {
    await connect();
    await syncIndexes();
  });
  afterAll(disconnect);
  beforeEach(async () => {
    await resetDb();
    clearMailbox();
    // A hostile display name, chosen by the counterparty.
    alice = await registerUser(app, { name: "Alice" });
    bob = await registerUser(app, { name: `<script>alert('pwn')</script>` });
    chatId = await befriend(app, alice, bob);
  });

  it("escapes a hostile name and remark in the generated report", async () => {
    await request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(alice.accessToken))
      .send({
        chatId,
        amount: 500,
        date: new Date().toISOString(),
        from: alice.id,
        to: bob.id,
        remarks: `<img src=x onerror=alert(1)>`,
      })
      .expect(201);

    const now = new Date();
    const res = await request(app)
      .get(`/api/v1/stats/chat/${chatId}/export`)
      .set(auth(alice.accessToken))
      .query({ year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 })
      .expect(200);

    const generated: string = res.body.html;
    expect(generated).toBeTruthy();

    // expo-print renders this HTML in a WebView where scripts execute, so a
    // counterparty's remark ran in YOUR app when you exported a statement.
    expect(generated).not.toContain("<script>alert('pwn')</script>");
    expect(generated).not.toContain("<img src=x onerror=alert(1)>");
    expect(generated).toContain("&lt;script&gt;");
    expect(generated).toContain("&lt;img");
  });
});

describe("Security headers and body limits", () => {
  beforeAll(async () => {
    await connect();
  });

  it("sets the baseline helmet headers", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBeDefined();
    // helmet removes the framework fingerprint.
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects an oversized JSON body", async () => {
    const res = await request(app)
      .post("/api/v1/users/login")
      .set("Content-Type", "application/json")
      .send({ phone: nextPhone(), password: "x".repeat(2 * 1024 * 1024) });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
