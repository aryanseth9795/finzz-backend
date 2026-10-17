import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
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
import { PushTicket } from "../src/models/pushTicketModel.js";

const TOKEN = "ExponentPushToken[abcdefghijklmnop]";
const HEALTH = "/api/v1/admin/notifications/health";
const FCM_HINT =
  "Expo can't deliver to Android: the FCM V1 credential for this app is missing or belongs to another Firebase project. Upload the Firebase service-account key for project finzz-1e22b with `eas credentials` (Android → Push Notifications: FCM V1).";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  clearMailbox();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /admin/notifications/health", () => {
  it("rejects requests without an admin cookie", async () => {
    const res = await request(app).get(HEALTH);
    expect(res.status).toBe(401);
  });

  it("reports InvalidCredentials errors with the FCM hint", async () => {
    await PushTicket.create([
      {
        ticketId: "t-bad-1",
        token: TOKEN,
        status: "error",
        error: "InvalidCredentials",
        message: "Unable to retrieve the FCM server key",
        checkedAt: new Date(),
      },
      { ticketId: "t-ok-1", token: TOKEN, status: "ok", checkedAt: new Date() },
    ]);
    const cookie = await adminCookie(app);

    const res = await request(app).get(HEALTH).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.last24h.total).toBe(2);
    expect(res.body.last24h.errors.InvalidCredentials).toBe(1);
    expect(res.body.hint).toBe(FCM_HINT);
  });

  it("hints about removed devices when only DeviceNotRegistered occurred", async () => {
    await PushTicket.create({
      ticketId: "t-dead-1",
      token: TOKEN,
      status: "error",
      error: "DeviceNotRegistered",
      checkedAt: new Date(),
    });
    const cookie = await adminCookie(app);
    const res = await request(app).get(HEALTH).set("Cookie", cookie);
    expect(res.body.hint).toBe(
      "Some devices uninstalled the app or changed tokens; they were removed automatically.",
    );
  });

  it("says nothing was sent when there are no tickets", async () => {
    const cookie = await adminCookie(app);
    const res = await request(app).get(HEALTH).set("Cookie", cookie);
    expect(res.body.last24h.total).toBe(0);
    expect(res.body.hint).toBe("No pushes were sent in the last 24 hours.");
  });

  it("has a null hint when everything is healthy", async () => {
    await PushTicket.create({ ticketId: "t-ok-2", token: TOKEN, status: "ok", checkedAt: new Date() });
    const cookie = await adminCookie(app);
    const res = await request(app).get(HEALTH).set("Cookie", cookie);
    expect(res.body.hint).toBeNull();
  });

  it("check=1 processes unchecked tickets first", async () => {
    await PushTicket.create({ ticketId: "t-new-1", token: TOKEN });
    const receipts = vi
      .spyOn(Expo.prototype, "getPushNotificationReceiptsAsync")
      .mockResolvedValue({
        "t-new-1": {
          status: "error",
          message: "bad creds",
          details: { error: "InvalidCredentials" },
        },
      } as any);
    const cookie = await adminCookie(app);

    const res = await request(app).get(`${HEALTH}?check=1`).set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(receipts).toHaveBeenCalledTimes(1);
    expect(res.body.last24h.errors.InvalidCredentials).toBe(1);
    expect(res.body.hint).toBe(FCM_HINT);
    const row = await PushTicket.findOne({ ticketId: "t-new-1" }).lean();
    expect(row!.checkedAt).toBeTruthy();
  });

  it("does not call Expo without check=1", async () => {
    await PushTicket.create({ ticketId: "t-new-2", token: TOKEN });
    const receipts = vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync");
    const cookie = await adminCookie(app);
    await request(app).get(HEALTH).set("Cookie", cookie);
    expect(receipts).not.toHaveBeenCalled();
  });
});

describe("notification send responses", () => {
  it("bulk says Queued, never Delivered", async () => {
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockResolvedValue([
      { status: "ok", id: "b1" },
    ]);
    const user = await registerUser(app);
    await User.updateOne({ _id: user.id }, { $set: { pushTokens: [TOKEN] } });
    const cookie = await adminCookie(app);

    const res = await request(app)
      .post("/api/v1/admin/notifications/bulk")
      .set("Cookie", cookie)
      .send({ title: "Hi", body: "There" });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe(
      "Queued 1 notification(s) at Expo. Delivery is confirmed by receipts about 15 minutes later — see Delivery health.",
    );
    expect(res.body.message).not.toContain("Delivered");
    expect(res.body.accepted).toBe(1);
    expect(res.body.recipients).toBe(1);
    expect(res.body.sentCount).toBe(1);
  });

  it("targeted returns 500 when the send path fails", async () => {
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockResolvedValue([
      { status: "ok", id: "x1" },
    ]);
    vi.spyOn(Notification, "insertMany").mockRejectedValue(new Error("db down"));
    const user = await registerUser(app);
    await User.updateOne({ _id: user.id }, { $set: { pushTokens: [TOKEN] } });
    const cookie = await adminCookie(app);

    const res = await request(app)
      .post("/api/v1/admin/notifications/targeted")
      .set("Cookie", cookie)
      .send({ userIds: [user.id], title: "Hello", body: "World" });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Failed to send the notification");
  });
});
