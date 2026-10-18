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
  type TestUser,
} from "./helpers.js";
import { periodOf } from "../src/utils/dates.js";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

describe("GET /stats/chat/:chatId/export — new report pipeline", () => {
  let alice: TestUser;
  let bob: TestUser;
  let chatId: string;
  const { year, month } = periodOf(new Date(), 330);

  const addTx = (who: TestUser, from: TestUser, to: TestUser, amount: number) =>
    request(app)
      .post("/api/v1/txns/createtx")
      .set(auth(who.accessToken))
      .send({
        chatId,
        amount,
        date: new Date().toISOString(),
        from: from.id,
        to: to.id,
        remarks: "settle",
      })
      .expect(201);

  const exportAs = (who: TestUser) =>
    request(app)
      .get(`/api/v1/stats/chat/${chatId}/export`)
      .set(auth(who.accessToken))
      .query({ year, month, tzOffsetMinutes: 330 });

  beforeAll(async () => {
    await connect();
    await syncIndexes();
  });
  afterAll(disconnect);
  beforeEach(async () => {
    await resetDb();
    clearMailbox();
    alice = await registerUser(app, { name: "Alice" });
    bob = await registerUser(app, { name: "Bob" });
    chatId = await befriend(app, alice, bob);
    await addTx(alice, alice, bob, 1000);
    await addTx(bob, bob, alice, 400);
  });

  it("returns html, fileName and period for the viewer", async () => {
    const res = await exportAs(alice).expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.fileName).toMatch(/^Finzz-Bob-[A-Z][a-z]{2}-\d{4}\.pdf$/);
    expect(res.body.period).toEqual({
      year,
      month,
      label: `${MONTHS[month - 1]} ${year}`,
    });

    const body: string = res.body.html;
    expect(body).toContain("Bob owes you ₹600.00");
    expect(body).toContain("Full Ledger");
    expect(body).not.toContain(alice.phone);
    expect(body).not.toContain(bob.phone);
  });

  it("states the balance from the other side for the friend", async () => {
    const res = await exportAs(bob).expect(200);
    expect(res.body.fileName).toMatch(/^Finzz-Alice-[A-Z][a-z]{2}-\d{4}\.pdf$/);
    expect(res.body.html).toContain("You owe Alice ₹600.00");
  });

  it("sanitises the friend's name in the file name", async () => {
    const eve = await registerUser(app, { name: "../Eve  <b>X</b>" });
    const chat2 = await befriend(app, alice, eve);
    const res = await request(app)
      .get(`/api/v1/stats/chat/${chat2}/export`)
      .set(auth(alice.accessToken))
      .query({ year, month, tzOffsetMinutes: 330 })
      .expect(200);
    expect(res.body.fileName).toMatch(/^Finzz-[A-Za-z0-9_-]+-[A-Z][a-z]{2}-\d{4}\.pdf$/);
  });

  it("answers 404 to a non-member", async () => {
    const mallory = await registerUser(app, { name: "Mallory" });
    await exportAs(mallory).expect(404);
  });
});
