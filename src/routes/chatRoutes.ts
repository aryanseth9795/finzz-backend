import express from "express";
import { getUserChats, getChatById } from "../controllers/chatController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

router.get("/", isAuthenticated, getUserChats);
router.get("/:chatId", isAuthenticated, getChatById);

export default router;
