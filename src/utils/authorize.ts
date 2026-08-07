import mongoose from "mongoose";
import { Chat } from "../models/chatModel.js";
import { Pool } from "../models/poolModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";

/**
 * Resource-ownership checks.
 *
 * These exist as shared helpers because the previous code applied them
 * inconsistently: `exportChatLedger` verified chat membership, while
 * `getChatStats` and `getChatMonths` — sitting in the same file, taking the
 * same `:chatId` parameter — did not. Any authenticated user could read any
 * other pair's balances and transaction history by iterating chat ids.
 *
 * Authentication answers "who are you". Authorisation answers "may you see
 * THIS". A route that has `isAuthenticated` but no ownership check has only
 * answered the first question.
 */

/** Throws unless `userId` is a member of `chatId`. Returns the chat. */
export const assertChatMember = async (chatId: string, userId: string) => {
  if (!mongoose.isValidObjectId(chatId)) {
    throw new ErrorHandler("Invalid chat id", 400);
  }

  const chat = await Chat.findOne({ _id: chatId, members: userId })
    .select("members")
    .lean<{ _id: mongoose.Types.ObjectId; members: mongoose.Types.ObjectId[] }>();

  if (!chat) {
    // 404 rather than 403: distinguishing "exists but forbidden" from "does
    // not exist" tells an attacker which ids are real.
    throw new ErrorHandler("Chat not found", 404);
  }

  return chat;
};

/** Throws unless `userId` is a member of `poolId`. Returns the pool. */
export const assertPoolMember = async (poolId: string, userId: string) => {
  if (!mongoose.isValidObjectId(poolId)) {
    throw new ErrorHandler("Invalid pool id", 400);
  }

  const pool = await Pool.findOne({
    _id: poolId,
    $or: [{ members: userId }, { admin: userId }],
  }).lean<{
    _id: mongoose.Types.ObjectId;
    admin: mongoose.Types.ObjectId;
    members: mongoose.Types.ObjectId[];
    status: "active" | "closed";
  }>();

  if (!pool) {
    throw new ErrorHandler("Pool not found", 404);
  }

  return pool;
};

/** Throws unless `userId` administers `poolId`. Returns the pool. */
export const assertPoolAdmin = async (poolId: string, userId: string) => {
  const pool = await assertPoolMember(poolId, userId);
  if (String(pool.admin) !== String(userId)) {
    throw new ErrorHandler("Only the pool admin can perform this action", 403);
  }
  return pool;
};
