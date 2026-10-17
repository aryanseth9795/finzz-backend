import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import TryCatch from "../utils/TryCatch.js";
import { Tx } from "../models/txModel.js";
import { Chat } from "../models/chatModel.js";
import { User } from "../models/userModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import { sendPushNotification } from "../services/notificationService.js";
import {
  updateSummaryOnAdd,
  updateSummaryOnDelete,
  updateSummaryOnEdit,
} from "../services/summaryService.js";
import { decodeCursor, cursorFilter, encodeCursor } from "../utils/cursor.js";
import { monthRangeUtc, parseTzOffset, currentPeriod } from "../utils/dates.js";

type TxStatus = "pending" | "verified" | "rejected";

type TxLike = {
  _id?: mongoose.Types.ObjectId | string;
  chatId?: mongoose.Types.ObjectId | string;
  amount?: number;
  remarks?: string;
  date?: Date | string;
  to?: mongoose.Types.ObjectId | string;
  from?: mongoose.Types.ObjectId | string;
  addedBy?: mongoose.Types.ObjectId | string;
  status?: string;
  verified?: boolean;
  verifiedBy?: mongoose.Types.ObjectId | string;
  verifiedAt?: Date | string;
  rejectedBy?: mongoose.Types.ObjectId | string;
  rejectedAt?: Date | string;
  rejectionRemark?: string;
};

const getTxnStatus = (txn: TxLike): TxStatus => {
  if (txn.status === "verified" || txn.status === "rejected") {
    return txn.status;
  }

  return txn.verified ? "verified" : "pending";
};

const serializeTxn = <T extends TxLike>(txn: T) => {
  const status = getTxnStatus(txn);

  return {
    ...txn,
    status,
    verified: status === "verified",
  };
};

async function getChatMemberIds(
  chatId: mongoose.Types.ObjectId | string,
): Promise<string[]> {
  const chat = await Chat.findById(chatId)
    .select("members")
    .lean<{ members: mongoose.Types.ObjectId[] } | null>();

  if (!chat) {
    throw new ErrorHandler("Chat not found", 404);
  }

  return chat.members.map((member) => member.toString());
}

/**
 * Reject a transaction dated before the current month.
 *
 * Previously `new Date(now.getFullYear(), now.getMonth(), 1)` built the month
 * boundary from the SERVER's local time, while the date being tested came from
 * the user's device. On a UTC-hosted server an IST user submitting a
 * transaction during the first 5½ hours of the 1st was told their own current
 * month was "closed". The boundary is now computed in the caller's frame.
 */
function ensureCurrentMonth(
  txDate: Date,
  message: string,
  tzOffsetMinutes = 0,
) {
  const { year, month } = currentPeriod(tzOffsetMinutes);
  const { start } = monthRangeUtc(year, month, tzOffsetMinutes);

  if (txDate < start) {
    throw new ErrorHandler(message, 400);
  }
}

function validateTxnParticipants(
  memberIds: string[],
  from: string,
  to: string,
) {
  if (from === to) {
    throw new ErrorHandler("Sender and receiver must be different", 400);
  }

  if (!memberIds.includes(from) || !memberIds.includes(to)) {
    throw new ErrorHandler("Transaction users must belong to this chat", 400);
  }
}

function getOtherMemberId(memberIds: string[], userId: string) {
  return memberIds.find((memberId) => memberId !== userId) || null;
}

async function syncChatLastTransaction(
  chatId: mongoose.Types.ObjectId | string,
) {
  const latestTxn = await Tx.findOne({ chatId })
    .sort({ date: -1, _id: -1 })
    .select("amount date remarks to from status verified")
    .lean<TxLike | null>();

  if (!latestTxn) {
    await Chat.findByIdAndUpdate(chatId, {
      $unset: { lastTransaction: "" },
    });
    return;
  }

  await Chat.findByIdAndUpdate(chatId, {
    lastTransaction: {
      amount: latestTxn.amount,
      date: latestTxn.date,
      remark: latestTxn.remarks || "",
      to: latestTxn.to,
      from: latestTxn.from,
      status: getTxnStatus(latestTxn),
    },
  });
}

async function getUserName(userId: string) {
  const user = await User.findById(userId)
    .select("name")
    .lean<{ name: string } | null>();

  return user?.name || "Your friend";
}

// Add transaction
export const addtxns = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { chatId, to, from, amount, date, remarks } = req.body;
    const userId = req.user.id;

    const txDate = new Date(date);
    ensureCurrentMonth(
      txDate,
      "Cannot add transactions to closed months. Only current month is allowed.",
      parseTzOffset(req.body.tzOffsetMinutes),
    );

    const memberIds = await getChatMemberIds(chatId);
    if (!memberIds.includes(userId)) {
      return next(new ErrorHandler("You are not a member of this chat", 403));
    }

    validateTxnParticipants(memberIds, from, to);

    const txn = await Tx.create({
      chatId,
      to,
      from,
      amount,
      date: txDate,
      remarks,
      addedBy: userId,
      status: "pending",
      verified: false,
    });

    await updateSummaryOnAdd(chatId, txDate, from, to, amount);
    await syncChatLastTransaction(txn.chatId);

    // Send push notification to the other member
    const otherMemberId = getOtherMemberId(memberIds, userId);
    if (otherMemberId) {
      const senderName = await getUserName(userId);
      await sendPushNotification(
        otherMemberId,
        "Transaction Pending Review",
        `Rs. ${amount} added by ${senderName}`,
        {
          type: "txn_added",
          senderId: userId,
          chatId,
          txnId: txn._id.toString(),
        },
      );
    }

    res.status(201).json({
      success: true,
      message: "Transaction created successfully",
      txn: serializeTxn(txn.toObject()),
    });
  },
);

// Get transactions for a chat with cursor-based pagination
export const getTxns = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { chatId } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const limit = Number.parseInt(req.query.limit as string, 10) || 20;
    const year = req.query.year
      ? Number.parseInt(req.query.year as string, 10)
      : undefined;
    const month = req.query.month
      ? Number.parseInt(req.query.month as string, 10)
      : undefined;
    const userId = req.user.id;
    const tzOffset = parseTzOffset(req.query.tzOffsetMinutes);

    const memberIds = await getChatMemberIds(chatId);
    if (!memberIds.includes(userId)) {
      return next(new ErrorHandler("You are not a member of this chat", 403));
    }

    const query: Record<string, unknown> = {
      chatId: new mongoose.Types.ObjectId(chatId),
    };

    // Month filter. `monthRangeUtc` builds the range in the user's calendar
    // frame rather than the server's local time, so a request for "August" no
    // longer silently excludes the first hours of the 1st for users east of UTC.
    if (year && month) {
      const { start, end } = monthRangeUtc(year, month, tzOffset);
      query.date = { $gte: start, $lt: end };
    }

    /**
     * Compound keyset cursor.
     *
     * The old code mutated `query.date.$lt` in place, which had two problems:
     * it used the date alone as the cursor, so every same-day transaction after
     * the first was silently skipped at each page boundary; and when a month
     * filter was active it overwrote that filter's own `$lt` bound, so the
     * range check and the cursor fought over one field.
     *
     * `$and` keeps the two concerns separate: the month range constrains the
     * window, the cursor predicate walks within it.
     */
    const decoded = decodeCursor(cursor);
    const pageFilter = cursorFilter(decoded);
    const finalQuery =
      Object.keys(pageFilter).length > 0 ? { $and: [query, pageFilter] } : query;

    const txns = await Tx.find(finalQuery)
      .sort({ date: -1, _id: -1 })
      .limit(limit + 1)
      .populate("addedBy", "name")
      .populate("verifiedBy", "name")
      .populate("rejectedBy", "name")
      .lean<TxLike[]>();

    const hasMore = txns.length > limit;
    if (hasMore) txns.pop();

    const last = txns[txns.length - 1];
    const nextCursor =
      hasMore && last?.date
        ? encodeCursor(new Date(last.date as string | Date), last._id)
        : null;

    return res.status(200).json({
      success: true,
      txns: txns.map((txn) => serializeTxn(txn)),
      nextCursor,
      hasMore,
    });
  },
);

// Review transaction
export const reviewTxn = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.body;
    const action = req.body.action === "reject" ? "reject" : "verify";
    const rejectionRemark = req.body.remark || "";
    const userId = req.user.id;

    const txn = await Tx.findById(txnId);

    if (!txn) {
      return next(new ErrorHandler("Transaction not found", 404));
    }

    const memberIds = await getChatMemberIds(txn.chatId);
    if (!memberIds.includes(userId)) {
      return next(new ErrorHandler("You are not a member of this chat", 403));
    }

    if (txn.addedBy.toString() === userId) {
      return next(
        new ErrorHandler(`You cannot ${action} your own transaction`, 403),
      );
    }

    const currentStatus = getTxnStatus(txn);
    if (currentStatus !== "pending") {
      return next(
        new ErrorHandler(
          `Only pending transactions can be ${action === "verify" ? "verified" : "rejected"}`,
          400,
        ),
      );
    }

    /**
     * One conditional `findOneAndUpdate`, filtered on "still pending, not mine"
     * and, when the client sent it, the `updatedAt` the reviewer saw. A reject's
     * summary decrement runs in the same MongoDB transaction and only if the
     * update matched, so two racing reviews can never both decrement, and a
     * creator edit that lands first makes the review match nothing instead of
     * approving a version the reviewer never saw.
     */
    const { expectedUpdatedAt } = req.body;
    const filter: Record<string, unknown> = {
      _id: txn._id,
      status: { $in: ["pending", null] },
      addedBy: { $ne: userId },
    };
    if (expectedUpdatedAt !== undefined) {
      filter.updatedAt = new Date(expectedUpdatedAt);
    }

    const now = new Date();
    const update =
      action === "verify"
        ? {
            $set: {
              status: "verified",
              verified: true,
              verifiedBy: userId,
              verifiedAt: now,
            },
          }
        : {
            $set: {
              status: "rejected",
              verified: false,
              rejectedBy: userId,
              rejectedAt: now,
              rejectionRemark,
            },
            $unset: { verifiedBy: "", verifiedAt: "" },
          };

    let updated: TxLike | null = null;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // The callback can be retried on a transient error.
        updated = null;

        updated = await Tx.findOneAndUpdate(filter, update, {
          new: true,
          session,
        }).lean<TxLike | null>();

        if (!updated || action !== "reject") return;

        // Use the matched document's values: they are what the summary holds.
        await updateSummaryOnDelete(
          txn.chatId,
          updated.date as Date,
          String(updated.from),
          String(updated.to),
          updated.amount as number,
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    if (!updated) {
      const latest = await Tx.findById(txnId).lean<TxLike | null>();
      if (!latest) {
        return next(new ErrorHandler("Transaction not found", 404));
      }
      if (getTxnStatus(latest) !== "pending") {
        return next(
          new ErrorHandler("This transaction was already reviewed", 400),
        );
      }
      return res.status(409).json({
        success: false,
        message: "This transaction was changed. Please check it again.",
        txn: serializeTxn(latest),
      });
    }

    const reviewed: TxLike = updated;
    await syncChatLastTransaction(txn.chatId);

    const reviewerName = await getUserName(userId);
    const rejectMsg = rejectionRemark
      ? `${reviewerName} rejected your Rs. ${reviewed.amount} transaction — "${rejectionRemark}"`
      : `${reviewerName} rejected your Rs. ${reviewed.amount} transaction`;
    await sendPushNotification(
      txn.addedBy.toString(),
      action === "verify" ? "Transaction Verified" : "Transaction Rejected",
      action === "verify"
        ? `Rs. ${reviewed.amount} verified by ${reviewerName}`
        : rejectMsg,
      {
        type: action === "verify" ? "txn_verified" : "txn_rejected",
        senderId: userId,
        chatId: txn.chatId.toString(),
        txnId: txnId,
      },
    );

    return res.status(200).json({
      success: true,
      message:
        action === "verify"
          ? "Transaction verified successfully"
          : "Transaction rejected successfully",
      txn: serializeTxn(reviewed),
    });
  },
);


/**
 * Edit a transaction. Only the creator may, and only until the other person
 * has verified it: a PENDING edit stays pending and applies a summary delta; a
 * REJECTED edit goes back to pending and re-adds the summary (the reject had
 * removed it).
 *
 * The write is a single conditional `findOneAndUpdate` filtered on creator,
 * the status we read and, when the client sent it, `expectedUpdatedAt`. The
 * summary update runs in the same MongoDB transaction, so either both land or
 * neither does, and a verify that wins the race makes the edit match nothing
 * instead of silently overwriting what the verifier saw.
 *
 * `findOneAndUpdate` bypasses the schema's pre-save hook, so the hook's
 * clean-up of verified/rejected metadata is done explicitly with `$unset`.
 */
export const editTxn = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.params;
    const userId = req.user.id;
    const { amount, date, remarks, to, from, expectedUpdatedAt } = req.body;

    const txn = await Tx.findById(txnId);

    if (!txn) {
      return next(new ErrorHandler("Transaction not found", 404));
    }

    // Guard: only addedBy can edit
    if (txn.addedBy.toString() !== userId) {
      return next(
        new ErrorHandler("You can only edit your own transactions", 403),
      );
    }

    // Guard: cannot edit verified transactions. Pending and rejected are fine.
    const oldStatus = getTxnStatus(txn);
    if (oldStatus === "verified") {
      return next(new ErrorHandler("Cannot edit a verified transaction", 403));
    }

    const old = {
      amount: txn.amount as number,
      date: new Date(txn.date),
      remarks: txn.remarks,
      from: txn.from.toString(),
      to: txn.to.toString(),
    };

    const target = {
      amount: amount !== undefined ? (amount as number) : old.amount,
      date: date !== undefined ? new Date(date) : old.date,
      remarks: remarks !== undefined ? (remarks as string) : old.remarks,
      from: from !== undefined ? String(from) : old.from,
      to: to !== undefined ? String(to) : old.to,
    };

    // Guard: cannot move the date to a closed month (same rule as add).
    // `tzOffsetMinutes` is stripped by the zod schema, so this is effectively
    // UTC, exactly as `addtxns` behaves today.
    if (date !== undefined) {
      ensureCurrentMonth(
        target.date,
        "Cannot move transactions to closed months.",
        parseTzOffset(req.body.tzOffsetMinutes),
      );
    }

    /**
     * Re-validate the participants whenever they change, same contract as
     * `addtxns`; otherwise arbitrary user ids could be written into a
     * transaction and propagated into MonthlySummary.
     */
    if (to !== undefined || from !== undefined) {
      const memberIds = await getChatMemberIds(txn.chatId.toString());
      validateTxnParticipants(memberIds, target.from, target.to);
    }

    const now = new Date();
    const filter: Record<string, unknown> = {
      _id: txn._id,
      addedBy: userId,
      // A pending row written before `status` existed has no field at all.
      status: oldStatus === "pending" ? { $in: ["pending", null] } : oldStatus,
    };
    if (expectedUpdatedAt !== undefined) {
      filter.updatedAt = new Date(expectedUpdatedAt);
    }

    const $set: Record<string, unknown> = {
      amount: target.amount,
      date: target.date,
      from: target.from,
      to: target.to,
      editedAt: now,
      status: "pending",
      verified: false,
    };
    if (target.remarks !== undefined) $set.remarks = target.remarks;

    let updated: TxLike | null = null;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // The callback can be retried on a transient error.
        updated = null;

        updated = await Tx.findOneAndUpdate(
          filter,
          {
            $set,
            $inc: { editCount: 1 },
            $unset: {
              rejectedBy: "",
              rejectedAt: "",
              rejectionRemark: "",
              verifiedBy: "",
              verifiedAt: "",
            },
          },
          { new: true, session },
        ).lean<TxLike | null>();

        if (!updated) return;

        if (oldStatus === "pending") {
          await updateSummaryOnEdit(txn.chatId, old, target, session);
        } else {
          // Rejected: the reject already removed it from the summary.
          await updateSummaryOnAdd(
            txn.chatId,
            target.date,
            target.from,
            target.to,
            target.amount,
            session,
          );
        }
      });
    } finally {
      await session.endSession();
    }

    if (!updated) {
      // The filter matched nothing: find out why.
      const latest = await Tx.findById(txnId).lean<TxLike | null>();
      if (!latest) {
        return next(new ErrorHandler("Transaction not found", 404));
      }
      if (latest.addedBy?.toString() !== userId) {
        return next(
          new ErrorHandler("You can only edit your own transactions", 403),
        );
      }
      if (getTxnStatus(latest) === "verified") {
        return next(
          new ErrorHandler("Cannot edit a verified transaction", 403),
        );
      }
      return res.status(409).json({
        success: false,
        message: "This transaction was changed. Please review it and try again.",
        txn: serializeTxn(latest),
      });
    }

    await syncChatLastTransaction(txn.chatId);

    // Notify the other member
    const memberIds = await getChatMemberIds(txn.chatId);
    const otherMemberId = getOtherMemberId(memberIds, userId);
    if (otherMemberId) {
      const senderName = await getUserName(userId);
      if (oldStatus === "pending") {
        await sendPushNotification(
          otherMemberId,
          "Transaction Edited",
          target.amount !== old.amount
            ? `${senderName} edited a pending transaction: Rs. ${old.amount} → Rs. ${target.amount}`
            : `${senderName} edited a pending transaction`,
          {
            type: "txn_edited",
            senderId: userId,
            chatId: txn.chatId.toString(),
            txnId: txn._id.toString(),
          },
        );
      } else {
        await sendPushNotification(
          otherMemberId,
          "Transaction Resubmitted",
          `${senderName} resubmitted Rs. ${target.amount} for review`,
          {
            type: "txn_reworked",
            senderId: userId,
            chatId: txn.chatId.toString(),
            txnId: txn._id.toString(),
          },
        );
      }
    }

    return res.status(200).json({
      success: true,
      message:
        oldStatus === "pending"
          ? "Transaction updated"
          : "Transaction resubmitted for review",
      txn: serializeTxn(updated as TxLike),
    });
  },
);

// Delete transaction — only allowed when status === "rejected"
export const deleteTxn = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.params;
    const userId = req.user.id;

    const txn = await Tx.findById(txnId);

    if (!txn) {
      return next(new ErrorHandler("Transaction not found", 404));
    }

    // Guard: only addedBy can delete
    if (txn.addedBy.toString() !== userId) {
      return next(
        new ErrorHandler("You can only delete your own transactions", 403),
      );
    }

    // Guard: cannot delete verified transactions
    if (txn.status === "verified") {
      return next(new ErrorHandler("Cannot delete a verified transaction", 403));
    }

    // Guard: can only delete rejected transactions (not pending)
    if (txn.status !== "rejected") {
      return next(
        new ErrorHandler(
          "You can only delete a transaction after it has been rejected",
          403,
        ),
      );
    }

    const chatId = txn.chatId;

    // Do NOT call updateSummaryOnDelete — the reject flow already rolled back the balance.
    // Simply remove the document.
    await Tx.findByIdAndDelete(txnId);

    await syncChatLastTransaction(chatId);

    // Notify the other member that the transaction was deleted
    const memberIds = await getChatMemberIds(chatId);
    const otherMemberId = getOtherMemberId(memberIds, userId);
    if (otherMemberId) {
      const senderName = await getUserName(userId);
      await sendPushNotification(
        otherMemberId,
        "Transaction Deleted",
        `${senderName} deleted a rejected Rs. ${txn.amount} transaction`,
        {
          type: "txn_deleted",
          senderId: userId,
          chatId: chatId.toString(),
        },
      );
    }

    return res.status(200).json({
      success: true,
      message: "Transaction deleted successfully",
    });
  },
);

// Get all transactions for a user (grouped by friends, for home screen)
// Excludes rejected transactions so balances are accurate
export const getAllTxnsUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const result = await Tx.aggregate([
      {
        $match: {
          status: { $ne: "rejected" },
          $or: [{ to: userId }, { from: userId }],
        },
      },
      {
        $addFields: {
          otherUser: {
            $cond: [{ $eq: ["$to", userId] }, "$from", "$to"],
          },
        },
      },
      {
        $group: {
          _id: "$otherUser",
          latestDate: { $max: "$date" },
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "friendInfo",
        },
      },
      {
        $unwind: "$friendInfo",
      },
      {
        $project: {
          friendId: "$_id",
          name: "$friendInfo.name",
          phone: "$friendInfo.phone",
          avatar: "$friendInfo.avatar",
          latestDate: 1,
          totalAmount: 1,
          count: 1,
        },
      },
      { $sort: { latestDate: -1 } },
      { $limit: 50 },
    ]);

    return res.status(200).json({
      success: true,
      friends: result,
    });
  },
);
