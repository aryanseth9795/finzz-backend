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
  auth,
  adminCookie,
} from "./helpers.js";
import { User } from "../src/models/userModel.js";

const URL = "/api/v1/users/push-status";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  clearMailbox();
});

describe("POST /users/push-status", () => {
  it("requires authentication", async () => {
    const res = await request(app).post(URL).send({ outcome: "registered" });
    expect(res.status).toBe(401);
  });

  it("stores the outcome with a timestamp", async () => {
    const user = await registerUser(app);
    const before = Date.now();

    const res = await request(app)
      .post(URL)
      .set(auth(user.accessToken))
      .send({ outcome: "permission-denied", detail: "User tapped Don't allow" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const stored = await User.findById(user.id).lean();
    expect(stored?.pushStatus?.outcome).toBe("permission-denied");
    expect(stored?.pushStatus?.detail).toBe("User tapped Don't allow");
    expect(stored?.pushStatus?.at).toBeInstanceOf(Date);
    expect(stored!.pushStatus!.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("accepts every documented outcome", async () => {
    const user = await registerUser(app);
    for (const outcome of [
      "registered",
      "unchanged",
      "permission-denied",
      "not-a-device",
      "no-project-id",
      "token-error",
      "upload-error",
    ]) {
      const res = await request(app)
        .post(URL)
        .set(auth(user.accessToken))
        .send({ outcome });
      expect(res.status, outcome).toBe(200);
    }
  });

  it("a later report replaces the earlier one, dropping stale detail", async () => {
    const user = await registerUser(app);
    await request(app)
      .post(URL)
      .set(auth(user.accessToken))
      .send({ outcome: "token-error", detail: "boom" });
    await request(app)
      .post(URL)
      .set(auth(user.accessToken))
      .send({ outcome: "registered" });

    const stored = await User.findById(user.id).lean();
    expect(stored?.pushStatus?.outcome).toBe("registered");
    expect(stored?.pushStatus?.detail).toBeUndefined();
  });

  it("rejects an unknown outcome", async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .post(URL)
      .set(auth(user.accessToken))
      .send({ outcome: "great" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing outcome", async () => {
    const user = await registerUser(app);
    const res = await request(app).post(URL).set(auth(user.accessToken)).send({});
    expect(res.status).toBe(400);
  });

  it("rejects detail longer than 200 characters", async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .post(URL)
      .set(auth(user.accessToken))
      .send({ outcome: "token-error", detail: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("only touches the caller's own user", async () => {
    const a = await registerUser(app);
    const b = await registerUser(app);
    await request(app)
      .post(URL)
      .set(auth(a.accessToken))
      .send({ outcome: "registered" });
    const other = await User.findById(b.id).lean();
    expect(other?.pushStatus).toBeUndefined();
  });

  it("is visible in the admin users list", async () => {
    const user = await registerUser(app);
    await request(app)
      .post(URL)
      .set(auth(user.accessToken))
      .send({ outcome: "no-project-id" });
    const cookie = await adminCookie(app);

    const res = await request(app).get("/api/v1/admin/users").set("Cookie", cookie);

    expect(res.status).toBe(200);
    const row = (res.body.users as any[]).find((u) => String(u._id) === user.id);
    expect(row?.pushStatus?.outcome).toBe("no-project-id");
  });
});
