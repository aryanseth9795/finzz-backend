import { Expo, ExpoPushMessage } from "expo-server-sdk";
import { User } from "../models/userModel.js";
import { Notification } from "../models/notificationModel.js";

// Create a new Expo SDK client
const expo = new Expo();

/**
 * Send push notification to a user via Expo Push Service
 * Also saves notification record to database
 */
export async function sendPushNotification(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    // 1. Find user and get their push token
    const user = await User.findById(userId)
      .select("pushToken")
      .lean<{ pushToken?: string }>();

    if (!user?.pushToken) {
      console.log(`No push token for user ${userId}`);
      return;
    }

    // 2. Validate Expo push token
    if (!Expo.isExpoPushToken(user.pushToken)) {
      console.error(
        `Invalid Expo push token for user ${userId}: ${user.pushToken}`,
      );
      return;
    }

    // 3. Build push notification message
    const message: ExpoPushMessage = {
      to: user.pushToken,
      sound: "default",
      title,
      body,
      data: data || {},
    };

    // 4. Send via Expo Push Service (batch-safe)
    const chunks = expo.chunkPushNotifications([message]);
    const tickets = [];

    for (const chunk of chunks) {
      try {
        const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
        tickets.push(...ticketChunk);
      } catch (error) {
        console.error("Error sending push notification:", error);
      }
    }

    // 5. Save notification record to database
    await Notification.create({
      recipient: userId,
      sender: data?.senderId,
      type: data?.type,
      data,
    });

    console.log(`Push notification sent to user ${userId}`);
  } catch (error) {
    console.error("Error in sendPushNotification:", error);
  }
}

/**
 * Send push notifications to multiple users (batch operation)
 */
export async function sendBulkPushNotifications(
  notifications: Array<{
    userId: string;
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }>,
): Promise<void> {
  try {
    // Get all user push tokens
    const userIds = notifications.map((n) => n.userId);
    const users = await User.find({ _id: { $in: userIds } })
      .select("_id pushToken")
      .lean();

    const userTokenMap = new Map<string, string | undefined>(
      users.map((u: any) => [u._id.toString(), u.pushToken]),
    );

    // Build messages
    const messages: ExpoPushMessage[] = [];
    const notificationRecords = [];

    for (const notification of notifications) {
      const pushToken = userTokenMap.get(notification.userId);

      if (pushToken && Expo.isExpoPushToken(pushToken)) {
        messages.push({
          to: pushToken,
          sound: "default",
          title: notification.title,
          body: notification.body,
          data: notification.data || {},
        });

        notificationRecords.push({
          recipient: notification.userId,
          sender: notification.data?.senderId,
          type: notification.data?.type,
          data: notification.data,
        });
      }
    }

    // Send in chunks
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
      } catch (error) {
        console.error("Error sending bulk push notifications:", error);
      }
    }

    // Save all notification records
    if (notificationRecords.length > 0) {
      await Notification.insertMany(notificationRecords);
    }

    console.log(`Bulk push notifications sent to ${messages.length} users`);
  } catch (error) {
    console.error("Error in sendBulkPushNotifications:", error);
  }
}
