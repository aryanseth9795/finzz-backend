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
import { Expo } from "expo-server-sdk";
import { connect, disconnect, resetDb, syncIndexes, nextPhone } from "./helpers.js";
import { User } from "../src/models/userModel.js";
import { PushTicket } from "../src/models/pushTicketModel.js";
import {
  processPushReceipts,
  recentDeliveryStats,
} from "../src/services/pushReceipts.js";
import { Notification } from "../src/models/notificationModel.js";
import {
  sendPushNotification,
  sendBulkPushNotifications,
  flushPendingPushWork,
} from "../src/services/notificationService.js";

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";
const MIN = 60_000;

const minutesAgo = (m: number) => new Date(Date.now() - m * MIN);

const makeUser = (extra: Record<string, unknown> = {}) =>
  User.create({
    name: "Push User",
    phone: nextPhone(),
    password: "Passw0rd!",
    ...extra,
  });

/** Stub the Expo receipts endpoint; never touches the network. */
const mockReceipts = (receipts: Record<string, unknown>) =>
  vi
    .spyOn(Expo.prototype, "getPushNotificationReceiptsAsync")
    .mockImplementation(async (ids: string[]) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) if (receipts[id]) out[id] = receipts[id];
      return out as any;
    });

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("push receipts", () => {
  it("receipts mark ok tickets", async () => {
    await PushTicket.create([
      { ticketId: "t1", token: TOKEN_A, createdAt: minutesAgo(20) },
      { ticketId: "t2", token: TOKEN_B, createdAt: minutesAgo(20) },
    ]);
    mockReceipts({ t1: { status: "ok" }, t2: { status: "ok" } });

    const result = await processPushReceipts();

    expect(result.checked).toBe(2);
    expect(result.ok).toBe(2);
    expect(result.errors).toEqual({});
    expect(result.pruned).toBe(0);

    const rows = await PushTicket.find().lean();
    expect(rows.every((r) => r.status === "ok" && r.checkedAt)).toBe(true);
  });

  it("an InvalidCredentials receipt is counted and recorded", async () => {
    await PushTicket.create({
      ticketId: "t1",
      token: TOKEN_A,
      createdAt: minutesAgo(20),
    });
    mockReceipts({
      t1: {
        status: "error",
        message: "Unable to retrieve the FCM server key",
        details: { error: "InvalidCredentials" },
      },
    });

    const result = await processPushReceipts();

    expect(result.checked).toBe(1);
    expect(result.ok).toBe(0);
    expect(result.errors.InvalidCredentials).toBe(1);

    const row = await PushTicket.findOne({ ticketId: "t1" }).lean();
    expect(row?.status).toBe("error");
    expect(row?.error).toBe("InvalidCredentials");
    expect(row?.message).toBe("Unable to retrieve the FCM server key");
    expect(row?.checkedAt).toBeInstanceOf(Date);
  });

  it("DeviceNotRegistered prunes the token from the user", async () => {
    const user = await makeUser({
      pushTokens: [TOKEN_A, TOKEN_B],
    });
    const legacy = await makeUser({ pushToken: TOKEN_A });
    await PushTicket.create({
      ticketId: "t1",
      token: TOKEN_A,
      userId: user._id,
      createdAt: minutesAgo(20),
    });
    mockReceipts({
      t1: {
        status: "error",
        message: "not registered",
        details: { error: "DeviceNotRegistered" },
      },
    });

    const result = await processPushReceipts();

    expect(result.errors.DeviceNotRegistered).toBe(1);
    expect(result.pruned).toBe(1);

    const after = await User.findById(user._id).lean();
    expect(after?.pushTokens).toEqual([TOKEN_B]);
    const legacyAfter = await User.findById(legacy._id).lean();
    expect(legacyAfter?.pushToken).toBeUndefined();
  });

  it("tickets younger than 15 minutes are not checked yet", async () => {
    await PushTicket.create([
      { ticketId: "young", token: TOKEN_A, createdAt: minutesAgo(5) },
      { ticketId: "old", token: TOKEN_B, createdAt: minutesAgo(20) },
    ]);
    const spy = mockReceipts({
      young: { status: "ok" },
      old: { status: "ok" },
    });

    const result = await processPushReceipts();

    expect(result.checked).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(["old"]);
    const young = await PushTicket.findOne({ ticketId: "young" }).lean();
    expect(young?.checkedAt).toBeUndefined();
  });

  it("does not re-check tickets that already have a receipt", async () => {
    await PushTicket.create({
      ticketId: "done",
      token: TOKEN_A,
      createdAt: minutesAgo(30),
      checkedAt: new Date(),
      status: "ok",
    });
    const spy = mockReceipts({ done: { status: "ok" } });

    const result = await processPushReceipts();

    expect(result.checked).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("leaves a ticket unchecked when Expo has no receipt for it yet", async () => {
    await PushTicket.create({
      ticketId: "pending",
      token: TOKEN_A,
      createdAt: minutesAgo(20),
    });
    mockReceipts({});

    const result = await processPushReceipts();

    expect(result.checked).toBe(0);
    const row = await PushTicket.findOne({ ticketId: "pending" }).lean();
    expect(row?.checkedAt).toBeUndefined();
  });

  it("dispatch persists ok tickets", async () => {
    const user = await makeUser({ pushTokens: [TOKEN_A] });
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockResolvedValue([
      { status: "ok", id: "tk1" },
    ]);

    const report = await sendPushNotification(String(user._id), "Hi", "Body", {
      type: "friend_request",
      senderId: String(user._id),
    });
    expect(report.accepted).toBe(1);
    await flushPendingPushWork();

    const row = await PushTicket.findOne({ ticketId: "tk1" }).lean();
    expect(row).toBeTruthy();
    expect(row?.token).toBe(TOKEN_A);
    expect(String(row?.userId)).toBe(String(user._id));
    expect(row?.checkedAt).toBeUndefined();
  });

  it("defines a 3 day TTL index on createdAt", async () => {
    const indexes = await PushTicket.collection.indexes();
    const ttl = indexes.find((i) => i.key?.createdAt === 1);
    expect(ttl?.expireAfterSeconds).toBe(3 * 24 * 3600);
  });

  it("recentDeliveryStats aggregates", async () => {
    await PushTicket.create([
      {
        ticketId: "s1",
        token: TOKEN_A,
        createdAt: minutesAgo(60),
        checkedAt: minutesAgo(30),
        status: "ok",
      },
      {
        ticketId: "s2",
        token: TOKEN_A,
        createdAt: minutesAgo(50),
        checkedAt: minutesAgo(20),
        status: "error",
        error: "InvalidCredentials",
        message: "older error",
      },
      {
        ticketId: "s3",
        token: TOKEN_B,
        createdAt: minutesAgo(40),
        checkedAt: minutesAgo(10),
        status: "error",
        error: "MessageTooBig",
        message: "newest error",
      },
      // Not yet checked: counts toward total only.
      { ticketId: "s4", token: TOKEN_B, createdAt: minutesAgo(2) },
      // Outside the window: ignored entirely.
      {
        ticketId: "s5",
        token: TOKEN_B,
        createdAt: new Date(Date.now() - 48 * 3600e3),
        checkedAt: new Date(),
        status: "ok",
      },
    ]);

    const stats = await recentDeliveryStats();

    expect(stats.total).toBe(4);
    expect(stats.checked).toBe(3);
    expect(stats.ok).toBe(1);
    expect(stats.errors).toEqual({ InvalidCredentials: 1, MessageTooBig: 1 });
    expect(stats.lastError).toBe("newest error");
  });

  it("recentDeliveryStats on an empty collection is all zeros", async () => {
    const stats = await recentDeliveryStats();
    expect(stats).toMatchObject({ total: 0, checked: 0, ok: 0, errors: {} });
    expect(stats.lastError).toBeUndefined();
  });
});

describe("receipt window", () => {
  const HOUR = 60 * MIN;

  it("only fetches unchecked tickets from the last 24 hours", async () => {
    await PushTicket.create([
      { ticketId: "recent", token: TOKEN_A, createdAt: new Date(Date.now() - 23 * HOUR) },
      { ticketId: "stale", token: TOKEN_B, createdAt: new Date(Date.now() - 25 * HOUR) },
    ]);
    const spy = mockReceipts({ recent: { status: "ok" }, stale: { status: "ok" } });

    const result = await processPushReceipts();

    expect(result.checked).toBe(1);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toEqual(["recent"]);
  });

  it("marks unchecked tickets older than 24 hours as expired", async () => {
    await PushTicket.create([
      { ticketId: "stale", token: TOKEN_B, createdAt: new Date(Date.now() - 25 * HOUR) },
      { ticketId: "fresh", token: TOKEN_A, createdAt: minutesAgo(20) },
      {
        ticketId: "done",
        token: TOKEN_A,
        createdAt: new Date(Date.now() - 26 * HOUR),
        checkedAt: new Date(),
        status: "ok",
      },
    ]);
    mockReceipts({});

    await processPushReceipts();

    const byId = Object.fromEntries(
      (await PushTicket.find().lean()).map((r) => [r.ticketId, r]),
    );
    expect(byId.stale.status).toBe("expired");
    expect(byId.fresh.status).toBeUndefined();
    expect(byId.done.status).toBe("ok");
  });

  it("expired tickets are never queried again", async () => {
    await PushTicket.create({
      ticketId: "stale",
      token: TOKEN_B,
      createdAt: new Date(Date.now() - 25 * HOUR),
    });
    const spy = mockReceipts({ stale: { status: "ok" } });

    await processPushReceipts();
    await processPushReceipts();

    expect(spy).not.toHaveBeenCalled();
  });
});

describe("fetch failures", () => {
  it("reports how many receipt chunks failed", async () => {
    await PushTicket.create({
      ticketId: "t1",
      token: TOKEN_A,
      createdAt: minutesAgo(20),
    });
    vi.spyOn(Expo.prototype, "getPushNotificationReceiptsAsync").mockRejectedValue(
      new Error("expo down"),
    );

    const result = await processPushReceipts();

    expect(result.fetchFailed).toBe(1);
    expect(result.checked).toBe(0);
    const row = await PushTicket.findOne({ ticketId: "t1" }).lean();
    expect(row?.checkedAt).toBeUndefined();
  });

  it("fetchFailed is 0 on success and when there is nothing to check", async () => {
    expect((await processPushReceipts()).fetchFailed).toBe(0);
    await PushTicket.create({ ticketId: "t1", token: TOKEN_A, createdAt: minutesAgo(20) });
    mockReceipts({ t1: { status: "ok" } });
    expect((await processPushReceipts()).fetchFailed).toBe(0);
  });
});

describe("sending is not blocked by bookkeeping", () => {
  it("still pushes when the feed insert fails (single)", async () => {
    const user = await makeUser({ pushTokens: [TOKEN_A] });
    const send = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([{ status: "ok", id: "f1" }]);
    vi.spyOn(Notification, "create").mockRejectedValue(new Error("db down"));

    const report = await sendPushNotification(String(user._id), "Hi", "Body");

    expect(send).toHaveBeenCalledTimes(1);
    expect(report.accepted).toBe(1);
    expect(report.error).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  it("still pushes when the feed insert fails (bulk)", async () => {
    const user = await makeUser({ pushTokens: [TOKEN_A] });
    const send = vi
      .spyOn(Expo.prototype, "sendPushNotificationsAsync")
      .mockResolvedValue([{ status: "ok", id: "f2" }]);
    vi.spyOn(Notification, "insertMany").mockRejectedValue(new Error("db down"));

    const report = await sendBulkPushNotifications([
      { userId: String(user._id), title: "Hi", body: "Body" },
    ]);

    expect(send).toHaveBeenCalledTimes(1);
    expect(report.accepted).toBe(1);
    expect(report.error).toBeUndefined();
  });

  it("reports error only for a real send-path failure", async () => {
    vi.spyOn(User, "find").mockImplementation((() => {
      throw new Error("db down");
    }) as any);

    const report = await sendBulkPushNotifications([
      { userId: "64b000000000000000000000", title: "Hi", body: "Body" },
    ]);

    expect(report.error).toBe("db down");
  });

  it("does not await ticket bookkeeping", async () => {
    const user = await makeUser({ pushTokens: [TOKEN_A] });
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockResolvedValue([
      { status: "ok", id: "slow1" },
    ]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const realInsert = PushTicket.insertMany.bind(PushTicket);
    vi.spyOn(PushTicket, "insertMany").mockImplementation((async (...args: any[]) => {
      await gate;
      return (realInsert as any)(...args);
    }) as any);

    const report = await sendPushNotification(String(user._id), "Hi", "Body");
    expect(report.accepted).toBe(1);
    expect(await PushTicket.countDocuments()).toBe(0);

    release();
    await flushPendingPushWork();
    expect(await PushTicket.countDocuments()).toBe(1);
  });

  it("logs, and does not throw, when bookkeeping fails", async () => {
    const user = await makeUser({ pushTokens: [TOKEN_A] });
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockResolvedValue([
      { status: "ok", id: "bk1" },
    ]);
    vi.spyOn(PushTicket, "insertMany").mockRejectedValue(new Error("db down"));

    const report = await sendPushNotification(String(user._id), "Hi", "Body");
    await expect(flushPendingPushWork()).resolves.toBeUndefined();

    expect(report.accepted).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "[push] could not persist tickets:",
      "db down",
    );
  });

  it("prunes dead tokens in the background", async () => {
    const user = await makeUser({ pushTokens: [TOKEN_A, TOKEN_B] });
    vi.spyOn(Expo.prototype, "sendPushNotificationsAsync").mockResolvedValue([
      { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      { status: "ok", id: "pr1" },
    ]);

    await sendPushNotification(String(user._id), "Hi", "Body");
    await flushPendingPushWork();

    const after = await User.findById(user._id).lean();
    expect(after?.pushTokens).toEqual([TOKEN_B]);
  });
});
