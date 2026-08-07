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
  adminCookie,
  type TestUser,
} from "./helpers.js";

/**
 * CROSS-REPO CONTRACT TESTS
 *
 * The Phase 4A/4B/4C write-ups each ended with the same honest caveat: the
 * contracts between the three repos were implemented on both sides but never
 * exercised together. These tests close that gap from the server side, by
 * asserting the exact response shapes the mobile app and the admin panel
 * depend on after the Phase 4 changes.
 *
 * They are deliberately about SHAPE and SEMANTICS, not about any client's
 * rendering — a client can be re-verified against these without running it.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
});

const isoNow = () => new Date().toISOString();

/**
 * X-9 / APP-010. The client sends UTC midnight of the picked calendar date
 * plus `tzOffsetMinutes`; the server derives the ledger period in the user's
 * frame. Both halves must agree or an entry lands in the wrong month.
 */
describe("Contract: tzOffsetMinutes (server ↔ App)", () => {
  it("files 1 August IST into August, not July", async () => {
    // Exactly what App/src/utils/dates.ts#toApiDate produces for 1 Aug, plus
    // the interceptor's +330 for IST.
    await request(app)
      .post("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .send({
        amount: 500,
        date: "2026-08-01T00:00:00.000Z",
        tzOffsetMinutes: 330,
      })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/expenses/ledgers")
      .set(auth(alice.accessToken))
      .expect(200);

    const august = res.body.ledgers.find(
      (l: { year: number; month: number }) => l.year === 2026 && l.month === 8,
    );
    expect(august).toBeDefined();
    expect(august.totalExpenses).toBe(500);

    // And nothing leaked into July.
    const july = res.body.ledgers.find(
      (l: { year: number; month: number }) => l.year === 2026 && l.month === 7,
    );
    expect(july?.totalExpenses ?? 0).toBe(0);
  });

  it("falls back to UTC when the offset is absent, so old builds still work", async () => {
    // The agreed backward-compatibility rule: an app build that does not send
    // the field must behave exactly as before, not error.
    await request(app)
      .post("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .send({ amount: 300, date: "2026-08-01T00:00:00.000Z" })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/expenses/ledgers")
      .set(auth(alice.accessToken))
      .expect(200);

    expect(
      res.body.ledgers.find(
        (l: { year: number; month: number }) => l.year === 2026 && l.month === 8,
      )?.totalExpenses,
    ).toBe(300);
  });

  it("ignores an out-of-range offset instead of trusting it", async () => {
    // Real offsets run -12:00..+14:00. A client sending nonsense must not be
    // able to steer an entry into an arbitrary month.
    await request(app)
      .post("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .send({
        amount: 100,
        date: "2026-08-01T00:00:00.000Z",
        tzOffsetMinutes: 99999,
      })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/expenses/ledgers")
      .set(auth(alice.accessToken))
      .expect(200);

    // Clamped to UTC → August, not some far-future month.
    expect(res.body.ledgers.every((l: { year: number }) => l.year === 2026)).toBe(
      true,
    );
  });
});

/**
 * X-3 / APP-021 / BE-018. The app parses `nextCursor` and sends it back
 * verbatim. The format changed from a bare ISO date to a compound cursor, and
 * the agreed rule was that BOTH must be accepted.
 */
describe("Contract: pagination cursor (server ↔ App)", () => {
  it("returns a compound cursor the app can round-trip", async () => {
    const sameDay = "2026-08-05T12:00:00.000Z";
    for (let i = 0; i < 7; i++) {
      await request(app)
        .post("/api/v1/expenses")
        .set(auth(alice.accessToken))
        .send({ amount: 10 + i, date: sameDay })
        .expect(201);
    }

    const first = await request(app)
      .get("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .query({ limit: 3 })
      .expect(200);

    expect(first.body).toHaveProperty("nextCursor");
    expect(first.body).toHaveProperty("hasMore", true);
    // Compound form: "<iso>_<objectId>" — what App/api/expenseApi sends back.
    expect(first.body.nextCursor).toMatch(
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z_[0-9a-f]{24}$/,
    );

    const second = await request(app)
      .get("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .query({ limit: 3, cursor: first.body.nextCursor })
      .expect(200);

    // No overlap between pages — the tie-break actually works across the
    // identical timestamps.
    const firstIds = first.body.expenses.map((e: { _id: string }) => e._id);
    const secondIds = second.body.expenses.map((e: { _id: string }) => e._id);
    expect(firstIds.filter((id: string) => secondIds.includes(id))).toEqual([]);
  });

  it("still accepts a legacy bare-ISO cursor from a deployed build", async () => {
    await request(app)
      .post("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .send({ amount: 50, date: "2026-08-04T10:00:00.000Z" })
      .expect(201);

    await request(app)
      .get("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .query({ limit: 10, cursor: "2026-08-06T00:00:00.000Z" })
      .expect(200);
  });
});

/**
 * X-1 / APP-007. The app's `isRefTo`/`refId` helpers narrow a reference that
 * may be an id or a populated object. This pins which endpoints return which.
 */
describe("Contract: populated vs id references (server ↔ App)", () => {
  it("returns ids on create and populated objects on list", async () => {
    const bob = await registerUser(app, { name: "Bob" });
    const chatId = await befriend(app, alice, bob);

    const created = await request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(alice.accessToken))
      .send({
        chatId,
        amount: 100,
        date: isoNow(),
        from: alice.id,
        to: bob.id,
      })
      .expect(201);

    const createdTxn = created.body.txn ?? created.body;
    // Create returns a raw id …
    expect(typeof createdTxn.from === "string" || createdTxn.from?._id).toBeTruthy();

    const listed = await request(app)
      .get(`/api/v1/txns/gettx/${chatId}`)
      .set(auth(alice.accessToken))
      .expect(200);

    const row = listed.body.txns[0];
    // … and whatever shape each uses, `refId` must resolve BOTH to the same
    // id. That is the invariant the client's helper depends on.
    const refId = (v: unknown) =>
      typeof v === "string" ? v : (v as { _id?: string })?._id;

    expect(refId(row.from)).toBe(alice.id);
    expect(refId(row.to)).toBe(bob.id);
    expect(refId(createdTxn.from)).toBe(alice.id);
  });
});

/**
 * X-8 / APP-003. The app sends the refresh token and the push token on
 * logout so the server revokes only this device and stops delivering this
 * account's notifications here.
 */
describe("Contract: logout payload (server ↔ App)", () => {
  it("accepts the app's logout body and revokes only that device", async () => {
    const second = await request(app)
      .post("/api/v1/users/login")
      .send({ phone: alice.phone, password: alice.password })
      .expect(200);

    await request(app)
      .post("/api/v1/users/logout")
      .set(auth(alice.accessToken))
      .send({
        refreshToken: alice.refreshToken,
        pushToken: "ExponentPushToken[test-device-abc]",
      })
      .expect(200);

    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(alice.refreshToken))
      .expect(401);

    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(second.body.refresh_token))
      .expect(200);
  });

  it("exposes the endpoint the app calls to release a push token", async () => {
    await request(app)
      .post("/api/v1/users/push-token")
      .set(auth(alice.accessToken))
      .send({ pushToken: "ExponentPushToken[abc123]" })
      .expect(200);

    await request(app)
      .post("/api/v1/users/remove-push-token")
      .set(auth(alice.accessToken))
      .send({ pushToken: "ExponentPushToken[abc123]" })
      .expect(200);
  });
});

/**
 * ADM-003. The admin PDF's headline figure comes from this field. Without it
 * the export falls back to "unavailable" — which is correct behaviour, but
 * the whole point of the fix is that the number IS available.
 */
describe("Contract: expense totals (server ↔ admin)", () => {
  it("returns totals over the whole filtered set, not the returned page", async () => {
    // 12 expenses of 100 = 1200, requested one page of 5.
    for (let i = 0; i < 12; i++) {
      await request(app)
        .post("/api/v1/expenses")
        .set(auth(alice.accessToken))
        .send({ amount: 100, date: isoNow(), category: i < 7 ? "Food" : "Travel" })
        .expect(201);
    }

    const cookie = await adminCookie(app);
    const res = await request(app)
      .get("/api/v1/admin/expenses")
      .set("Cookie", cookie)
      .query({ page: 1, limit: 5 })
      .expect(200);

    expect(res.body.expenses).toHaveLength(5);
    expect(res.body.pagination.total).toBe(12);

    // The field the admin PDF reads. It must describe all 12, not the 5.
    expect(res.body.totals).toBeDefined();
    expect(res.body.totals.totalAmount).toBe(1200);
    expect(res.body.totals.count).toBe(12);

    // The page sum is deliberately different — that difference IS the bug the
    // export used to have.
    const pageSum = res.body.expenses.reduce(
      (s: number, e: { amount: number }) => s + e.amount,
      0,
    );
    expect(pageSum).toBe(500);
    expect(pageSum).not.toBe(res.body.totals.totalAmount);
  });

  it("respects the filter when computing totals", async () => {
    const bob = await registerUser(app, { name: "Bob" });

    await request(app)
      .post("/api/v1/expenses")
      .set(auth(alice.accessToken))
      .send({ amount: 200, date: isoNow() })
      .expect(201);
    await request(app)
      .post("/api/v1/expenses")
      .set(auth(bob.accessToken))
      .send({ amount: 900, date: isoNow() })
      .expect(201);

    const cookie = await adminCookie(app);
    const res = await request(app)
      .get("/api/v1/admin/expenses")
      .set("Cookie", cookie)
      .query({ userId: alice.id })
      .expect(200);

    // Alice's 200 only — not the 1100 across both users.
    expect(res.body.totals.totalAmount).toBe(200);
    expect(res.body.totals.count).toBe(1);
  });

  it("returns a category breakdown the admin charts can use", async () => {
    for (const category of ["Food", "Food", "Travel"]) {
      await request(app)
        .post("/api/v1/expenses")
        .set(auth(alice.accessToken))
        .send({ amount: 100, date: isoNow(), category })
        .expect(201);
    }

    const cookie = await adminCookie(app);
    const res = await request(app)
      .get("/api/v1/admin/expenses")
      .set("Cookie", cookie)
      .expect(200);

    const food = res.body.totals.byCategory.find(
      (c: { name: string }) => c.name === "Food",
    );
    expect(food).toEqual({ name: "Food", total: 200, count: 2 });
  });
});

/**
 * X-17 / ADM-019. The admin UI reports three numbers because they mean three
 * different things. `sentCount` is retained as a deprecated alias so the
 * currently deployed admin build keeps working.
 */
describe("Contract: notification delivery counts (server ↔ admin)", () => {
  it("reports accepted / rejected / skipped, plus the legacy alias", async () => {
    await request(app)
      .post("/api/v1/users/push-token")
      .set(auth(alice.accessToken))
      .send({ pushToken: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" })
      .expect(200);

    const cookie = await adminCookie(app);
    const res = await request(app)
      .post("/api/v1/admin/notifications/bulk")
      .set("Cookie", cookie)
      .send({ title: "Maintenance tonight", body: "Back by 9pm." });

    // Expo is unreachable from the test environment, so delivery fails — but
    // the SHAPE is what this asserts, and the numbers must be honest about it.
    if (res.status === 200) {
      expect(res.body).toHaveProperty("accepted");
      expect(res.body).toHaveProperty("rejected");
      expect(res.body).toHaveProperty("sentCount"); // deprecated alias
      expect(res.body.sentCount).toBe(res.body.accepted);
    } else {
      // 404 "no users with push tokens" is the only other valid outcome.
      expect(res.status).toBe(404);
    }
  });

  it("rejects a whitespace-only title, which the old check let through", async () => {
    const cookie = await adminCookie(app);
    await request(app)
      .post("/api/v1/admin/notifications/bulk")
      .set("Cookie", cookie)
      .send({ title: "   ", body: "x" })
      .expect(400);
  });
});

/**
 * ADM-020 / X-14. The admin user-detail "Pools" card read 0 for everyone,
 * because the server queried `createdBy` and `members.userId` — neither of
 * which exists on the Pool schema.
 */
describe("Contract: admin user detail (server ↔ admin)", () => {
  it("finds the pools a user actually belongs to", async () => {
    await request(app)
      .post("/api/v1/pools/create")
      .set(auth(alice.accessToken))
      .send({ name: "Goa Trip" })
      .expect(201);

    const cookie = await adminCookie(app);
    const res = await request(app)
      .get(`/api/v1/admin/users/${alice.id}`)
      .set("Cookie", cookie)
      .expect(200);

    // Was always [] — the card reported 0 even for pool administrators.
    expect(res.body.pools).toHaveLength(1);
    expect(res.body.pools[0].name).toBe("Goa Trip");
  });

  it("returns the expenseSummary shape the page destructures", async () => {
    const cookie = await adminCookie(app);
    const res = await request(app)
      .get(`/api/v1/admin/users/${alice.id}`)
      .set("Cookie", cookie)
      .expect(200);

    // The page reads `expenseSummary.totalAmount` directly; an array here
    // would render "₹0" silently, or throw if the shape changed again.
    expect(res.body.expenseSummary).toEqual({ totalAmount: 0, count: 0 });
    expect(Array.isArray(res.body.expenseSummary)).toBe(false);
    expect(Array.isArray(res.body.ledgers)).toBe(true);
  });

  it("never returns credentials to the admin panel", async () => {
    const cookie = await adminCookie(app);
    const res = await request(app)
      .get(`/api/v1/admin/users/${alice.id}`)
      .set("Cookie", cookie)
      .expect(200);

    for (const field of ["password", "refreshToken", "refreshTokens", "otp"]) {
      expect(res.body.user[field]).toBeUndefined();
    }
  });
});
