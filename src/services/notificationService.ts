import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { User } from "../models/userModel.js";
import { Notification } from "../models/notificationModel.js";

// Create a new Expo SDK client
const expo = new Expo();

export interface DeliveryReport {
  /** Messages Expo accepted for delivery. */
  accepted: number;
  /** Messages Expo rejected outright (bad token, payload too large, …). */
  rejected: number;
  /** Recipients that had no usable push token at all. */
  skipped: number;
}

/**
 * Push tokens for a set of users, honouring the multi-device `pushTokens`
 * array and falling back to the deprecated single `pushToken` field so that
 * accounts which have not yet reopened the app still receive notifications.
 */
const collectTokens = (user: {
  pushTokens?: string[];
  pushToken?: string;
}): string[] => {
  const raw = [...(user.pushTokens ?? [])];
  if (user.pushToken) raw.push(user.pushToken);
  return [...new Set(raw)].filter((t) => Expo.isExpoPushToken(t));
};

/**
 * Delete tokens the Expo service reports as permanently dead.
 *
 * Previously tickets were discarded entirely, so `DeviceNotRegistered` tokens
 * accumulated forever. That is not merely wasteful: a token belonging to a
 * signed-out account keeps pointing at a physical device, so notifications for
 * one user can surface on a device somebody else is now using.
 */
const pruneDeadTokens = async (
  messages: ExpoPushMessage[],
  tickets: ExpoPushTicket[],
): Promise<void> => {
  const dead: string[] = [];

  tickets.forEach((ticket, index) => {
    if (
      ticket.status === "error" &&
      ticket.details?.error === "DeviceNotRegistered"
    ) {
      const to = messages[index]?.to;
      if (typeof to === "string") dead.push(to);
    }
  });

  if (dead.length === 0) return;

  await Promise.all([
    User.updateMany(
      { pushTokens: { $in: dead } },
      { $pull: { pushTokens: { $in: dead } } },
    ),
    // Clear the legacy single-token field only where it holds a dead token.
    User.updateMany(
      { pushToken: { $in: dead } },
      { $unset: { pushToken: "" } },
    ),
  ]);
};

/**
 * Send a chunked batch and report what actually happened.
 *
 * `sendPushNotificationsAsync` returns one ticket per message; a ticket with
 * `status: "error"` means Expo refused it. Counting `chunk.length` (the old
 * behaviour) reports every submitted message as delivered, which is a claim
 * the system has no basis for.
 */
const dispatch = async (
  messages: ExpoPushMessage[],
): Promise<{ accepted: number; rejected: number }> => {
  let accepted = 0;
  let rejected = 0;
  const chunks = expo.chunkPushNotifications(messages);
  let offset = 0;

  for (const chunk of chunks) {
    const slice = messages.slice(offset, offset + chunk.length);
    offset += chunk.length;
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      for (const ticket of tickets) {
        if (ticket.status === "ok") accepted += 1;
        else rejected += 1;
      }
      await pruneDeadTokens(slice, tickets);
    } catch (error) {
      // A transport failure fails the whole chunk; count it honestly.
      rejected += chunk.length;
      console.error("[push] chunk delivery failed:", error);
    }
  }

  return { accepted, rejected };
};

/**
 * Send push notification to a user via Expo Push Service.
 * Also saves a notification record to the database.
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<DeliveryReport> {
  try {
    await Notification.create({
      recipient: userId,
      sender: data?.senderId,
      type: data?.type,
      title,
      body,
      data,
    });

    const user = await User.findById(userId)
      .select("pushTokens pushToken")
      .lean<{ pushTokens?: string[]; pushToken?: string }>();

    const tokens = user ? collectTokens(user) : [];
    if (tokens.length === 0) {
      return { accepted: 0, rejected: 0, skipped: 1 };
    }

    const messages: ExpoPushMessage[] = tokens.map((to) => ({
      to,
      sound: "default",
      title,
      body,
      data: data || {},
    }));

    const { accepted, rejected } = await dispatch(messages);
    return { accepted, rejected, skipped: 0 };
  } catch (error) {
    // Notification delivery must never fail the request that triggered it —
    // a transaction still succeeded even if the phone was not told about it.
    console.error("[push] sendPushNotification failed:", error);
    return { accepted: 0, rejected: 0, skipped: 1 };
  }
}

/**
 * Send push notifications to multiple users (batch operation).
 */
export async function sendBulkPushNotifications(
  notifications: Array<{
    userId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }>,
): Promise<DeliveryReport> {
  if (notifications.length === 0) {
    return { accepted: 0, rejected: 0, skipped: 0 };
  }

  try {
    const userIds = notifications.map((n) => n.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id pushTokens pushToken")
      .lean();

    const tokenMap = new Map<string, string[]>(
      users.map((u: any) => [String(u._id), collectTokens(u)]),
    );

    await Notification.insertMany(
      notifications.map((n) => ({
        recipient: n.userId,
        sender: n.data?.senderId,
        type: n.data?.type,
        title: n.title,
        body: n.body,
        data: n.data,
      })),
    );

    const messages: ExpoPushMessage[] = [];
    let skipped = 0;

    for (const notification of notifications) {
      const tokens = tokenMap.get(notification.userId) ?? [];
      if (tokens.length === 0) {
        skipped += 1;
        continue;
      }
      for (const to of tokens) {
        messages.push({
          to,
          sound: "default",
          title: notification.title,
          body: notification.body,
          data: notification.data || {},
        });
      }
    }

    const { accepted, rejected } = await dispatch(messages);
    return { accepted, rejected, skipped };
  } catch (error) {
    console.error("[push] sendBulkPushNotifications failed:", error);
    return { accepted: 0, rejected: 0, skipped: notifications.length };
  }
}

/** Fan out one message to every user that has at least one live push token. */
export async function broadcastPushNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<DeliveryReport & { recipients: number }> {
  const users = await User.find({
    $or: [
      { pushTokens: { $exists: true, $ne: [] } },
      { pushToken: { $exists: true, $nin: ["", null] } },
    ],
  })
    .select("_id pushTokens pushToken")
    .lean();

  const messages: ExpoPushMessage[] = [];
  let recipients = 0;

  for (const user of users as any[]) {
    const tokens = collectTokens(user);
    if (tokens.length === 0) continue;
    recipients += 1;
    for (const to of tokens) {
      messages.push({ to, sound: "default", title, body, data: data || {} });
    }
  }

  const { accepted, rejected } = await dispatch(messages);
  return { accepted, rejected, skipped: users.length - recipients, recipients };
}
