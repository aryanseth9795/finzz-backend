import { Request, Response, NextFunction } from "express";
import TryCatch from "../utils/TryCatch.js";
import { Notification } from "../models/notificationModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";

// GET /api/v1/notifications — fetch latest notifications with unread count
export const getMyNotifications = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 100);

  const [notifications, unreadCount] = await Promise.all([
    Notification.find({ recipient: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("sender", "name phone avatar")
      .lean(),
    Notification.countDocuments({ recipient: userId, read: false }),
  ]);

  return res.status(200).json({
    success: true,
    notifications,
    unreadCount,
  });
});

// PATCH /api/v1/notifications/:id/read — mark a single notification as read
export const markNotificationRead = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, recipient: userId },
      { read: true },
      { new: true },
    );

    if (!notification) {
      return next(new ErrorHandler("Notification not found", 404));
    }

    return res.status(200).json({
      success: true,
      notification,
    });
  },
);

// PATCH /api/v1/notifications/read-all — mark all as read for current user
export const markAllNotificationsRead = TryCatch(
  async (req: Request, res: Response) => {
    const userId = req.user.id;

    await Notification.updateMany(
      { recipient: userId, read: false },
      { read: true },
    );

    return res.status(200).json({
      success: true,
      message: "All notifications marked as read",
    });
  },
);
