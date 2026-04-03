import express from "express";
import isAuthenticated from "../middlewares/auth.js";
import {
  getMyNotifications,
  markNotificationRead,
  markAllNotificationsRead,
} from "../controllers/notificationController.js";

const router = express.Router();

router.get("/", isAuthenticated, getMyNotifications);
router.patch("/read-all", isAuthenticated, markAllNotificationsRead);
router.patch("/:id/read", isAuthenticated, markNotificationRead);

export default router;
