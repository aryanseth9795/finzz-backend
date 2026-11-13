import mongoose from "mongoose";
import { User } from "../models/userModel.js";
import { Expense } from "../models/expenseModel.js";
import { ExpenseLedger } from "../models/expenseLedgerModel.js";
import { ExpenseCategory } from "../models/expenseCategoryModel.js";
import { Pool } from "../models/poolModel.js";
import { Tx } from "../models/txModel.js";
import { Chat } from "../models/chatModel.js";
import { FriendRequest } from "../models/friendRequestModel.js";
import { MonthlySummary } from "../models/monthlySummaryModel.js";
import { Notification } from "../models/notificationModel.js";
import { Note } from "../models/noteModel.js";
import { PoolTx } from "../models/poolTxModel.js";
import { PushTicket } from "../models/pushTicketModel.js";
import { DailyActivity } from "../models/dailyActivityModel.js";
import {
  deleteFromCloudinary,
  extractPublicId,
} from "./cloudinaryService.js";

/**
 * Remove a user and everything that references them. Shared by the admin
 * delete route and the self-service delete-account route.
 */
export async function deleteUserCascade(
  userId: mongoose.Types.ObjectId,
): Promise<void> {
  // Read before the transaction deletes the document.
  const existing = await User.findById(userId).select("avatar");
  const avatar = existing?.avatar;

  /**
   * The previous cascade deleted four collections and missed six. Every miss
   * left a dangling ObjectId that Mongoose `populate` resolves to `null`,
   * and the mobile client dereferences those without a guard — so deleting
   * one account produced a crash on the *counterparty's* home screen.
   *
   * Specifically missed before: Chat documents, the `friends` arrays of every
   * other user, FriendRequest rows, MonthlySummary documents, PoolTx rows,
   * Pool membership, and Tx rows where the user was only `from`/`to`
   * (the old filter covered `addedBy`/`verifiedBy` only).
   *
   * The whole cascade now runs inside one transaction: a partial delete is
   * strictly worse than no delete, because it produces exactly the dangling
   * references this is meant to eliminate.
   */
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Chats this user belonged to, and everything hanging off them.
      const chats = await Chat.find({ members: userId })
        .select("_id")
        .session(session)
        .lean();
      const chatIds = chats.map((c) => c._id);

      await Promise.all([
        // Own data
        Expense.deleteMany({ userId }, { session }),
        ExpenseLedger.deleteMany({ userId }, { session }),
        ExpenseCategory.deleteMany({ userId }, { session }),

        // Anything referencing the user from either direction
        Notification.deleteMany(
          { $or: [{ recipient: userId }, { sender: userId }] },
          { session },
        ),
        Tx.deleteMany(
          {
            $or: [
              { addedBy: userId },
              { verifiedBy: userId },
              { from: userId },
              { to: userId },
            ],
          },
          { session },
        ),
        FriendRequest.deleteMany(
          { $or: [{ from: userId }, { to: userId }] },
          { session },
        ),

        // Shared structures: remove the reference, keep the structure.
        User.updateMany(
          { friends: userId },
          { $pull: { friends: userId } },
          { session },
        ),
        Pool.updateMany(
          { members: userId },
          { $pull: { members: userId } },
          { session },
        ),
        PoolTx.deleteMany({ addedBy: userId }, { session }),

        // Notes: their own go; their access to others' notes goes; labels
        // pointing at them are cleared (the note itself stays with its owner).
        Note.deleteMany({ owner: userId }, { session }),
        Note.updateMany(
          { "shares.user": userId },
          { $pull: { shares: { user: userId } } },
          { session },
        ),
        Note.updateMany(
          { personLabel: userId },
          { $set: { personLabel: null } },
          { session },
        ),

        // Per-user traffic analytics.
        DailyActivity.deleteMany({ user: userId }, { session }),

        // Push tickets hold the user's device tokens.
        PushTicket.deleteMany({ userId }, { session }),
      ]);

      // Chats are 1:1, so a chat the user belonged to has no meaning without
      // them. Delete the chat and its derived monthly summaries together.
      if (chatIds.length > 0) {
        await MonthlySummary.deleteMany(
          { chatId: { $in: chatIds } },
          { session },
        );
        await Chat.deleteMany({ _id: { $in: chatIds } }, { session });
      }

      // Pools this user administered are left intact but orphaned of an
      // admin, which the pool endpoints already handle; deleting other
      // members' shared financial history would be a larger, separate call.
      await User.deleteOne({ _id: userId }, { session });
    });
  } finally {
    await session.endSession();
  }

  // After a successful commit only. Best effort: a failure here costs storage,
  // not correctness, and must not fail a delete that already succeeded.
  if (avatar && avatar.includes("res.cloudinary.com")) {
    try {
      const publicId = extractPublicId(avatar);
      if (publicId) await deleteFromCloudinary(publicId);
    } catch (error) {
      console.error("[account-deletion] failed to delete avatar image:", error);
    }
  }
}
