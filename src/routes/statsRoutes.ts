import express from "express";
import {
  getChatStats,
  getChatMonths,
  getMonthlyReport,
  getPerFriendReport,
} from "../controllers/statsController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

router.get("/chat/:chatId", isAuthenticated, getChatStats);
router.get("/chat/:chatId/months", isAuthenticated, getChatMonths);
router.get("/monthly", isAuthenticated, getMonthlyReport);
router.get("/friend/:friendId", isAuthenticated, getPerFriendReport);

export default router;
