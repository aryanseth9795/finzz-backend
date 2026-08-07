import express from "express";
import {
  getChatStats,
  getChatMonths,
  getMonthlyReport,
  getPerFriendReport,
  exportChatLedger,
} from "../controllers/statsController.js";
import isAuthenticated from "../middlewares/auth.js";
import { heavyLimiter } from "../middlewares/rateLimit.js";
import {
  validate,
  chatStatsSchema,
  chatIdParamSchema,
  chatExportSchema,
  friendIdParamSchema,
} from "../middlewares/validation.js";

const router = express.Router();

/**
 * `/chat/:chatId` and `/chat/:chatId/months` were authenticated but not
 * AUTHORISED — the handlers never checked that the caller belonged to the
 * chat, so any signed-in user could read any pair's balances by iterating
 * ObjectIds. The membership check now lives in the handlers themselves
 * (utils/authorize.ts) so it cannot be forgotten by a future route edit.
 *
 * Note `/chat/:chatId/months` and `/chat/:chatId/export` are declared before
 * `/chat/:chatId` is *not* required here — Express distinguishes them by
 * segment count — but the schemas make the expected shape explicit.
 */
router.get(
  "/chat/:chatId/months",
  isAuthenticated,
  validate(chatIdParamSchema),
  getChatMonths,
);
router.get(
  "/chat/:chatId/export",
  isAuthenticated,
  heavyLimiter,
  validate(chatExportSchema),
  exportChatLedger,
);
router.get(
  "/chat/:chatId",
  isAuthenticated,
  validate(chatStatsSchema),
  getChatStats,
);
router.get("/monthly", isAuthenticated, getMonthlyReport);
router.get(
  "/friend/:friendId",
  isAuthenticated,
  validate(friendIdParamSchema),
  getPerFriendReport,
);

export default router;
