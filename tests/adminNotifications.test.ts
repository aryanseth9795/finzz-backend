import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { Expo } from "expo-server-sdk";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  adminCookie,
} from "./helpers.js";
import { User } from "../src/models/userModel.js";
import { Notification } from "../src/models/notificationModel.js";

const TOKEN = "ExponentPushToken[abcdefghijklmnop]";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  clearMailbox();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /admin/notifications/targeted", () => {
  it("targeted send to a user with a token succeeds", async () => {
    const send = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([{ status: "ok", id: "t1" }]);
    const user = await registerUser(app);
    await User.updateOne({ _id: user.id }, { $set: { pushTokens: [TOKEN] } });
    const cookie = await adminCookie(app);

    const res = await request(app)
      .post("/api/v1/admin/notifications/targeted")
      .set("Cookie", cookie)
      .send({ userIds: [user.id], title: "Hello", body: "World" });

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(1);
    expect(res.body.rejected).toBe(0);
    expect(res.body.skipped).toBe(0);
    expect(res.body.message).toContain("Sent to 1 device(s)");
    expect(send).toHaveBeenCalledTimes(1);

    const stored = await Notification.findOne({ recipient: user.id }).lean();
    expect(stored).toBeTruthy();
    expect(stored!.type).toBe("admin_targeted");
    expect(stored!.sender).toBeUndefined();
  });

  it("targeted send to users without tokens gives the clear 404 message", async () => {
    const send = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([]);
    const user = await registerUser(app);
    const cookie = await adminCookie(app);

    const res = await request(app)
      .post("/api/v1/admin/notifications/targeted")
      .set("Cookie", cookie)
      .send({ userIds: [user.id], title: "Hello", body: "World" });

    expect(res.status).toBe(404);
    expect(res.body.message).toBe(
      "None of the selected users has a device registered for notifications",
    );
    expect(send).not.toHaveBeenCalled();
  });
});

describe("Notification model", () => {
  it("Notification.create accepts an admin type without a sender", async () => {
    const recipient = new mongoose.Types.ObjectId();
    const doc = await Notification.create({
      recipient,
      type: "admin_broadcast",
      title: "t",
      body: "b",
    });
    expect(doc.type).toBe("admin_broadcast");
    expect(doc.sender).toBeUndefined();
    const doc2 = await Notification.create({ recipient, type: "admin_targeted" });
    expect(doc2.type).toBe("admin_targeted");
  });
});
