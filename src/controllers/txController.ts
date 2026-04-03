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
} from "../services/summaryService.js";

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

function ensureCurrentMonth(txDate: Date, message: string) {
  const now = new Date();
  const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  if (txDate < currentMonthStart) {
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

    const memberIds = await getChatMemberIds(chatId);
    if (!memberIds.includes(userId)) {
      return next(new ErrorHandler("You are not a member of this chat", 403));
    }

    const query: Record<string, unknown> = {
      chatId: new mongoose.Types.ObjectId(chatId),
    };

    // Month filter (if year and month provided)
    if (year && month) {
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 1);
      query.date = { $gte: monthStart, $lt: monthEnd };
    }

    // Cursor pagination (within the month if filtered)
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (query.date && typeof query.date === "object") {
        (query.date as Record<string, Date>).$lt = cursorDate;
      } else {
        query.date = { $lt: cursorDate };
      }
    }

    const txns = await Tx.find(query)
      .sort({ date: -1, _id: -1 })
      .limit(limit + 1)
      .populate("addedBy", "name")
      .populate("verifiedBy", "name")
      .populate("rejectedBy", "name")
      .lean<TxLike[]>();

    const hasMore = txns.length > limit;
    if (hasMore) txns.pop();

    const nextCursor =
      hasMore && txns.length > 0 && txns[txns.length - 1].date
        ? new Date(txns[txns.length - 1].date as string | Date).toISOString()
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

    if (action === "verify") {
      txn.status = "verified";
      txn.verifiedBy = new mongoose.Types.ObjectId(userId);
      txn.verifiedAt = new Date();
    } else {
      txn.status = "rejected";
      txn.rejectedBy = new mongoose.Types.ObjectId(userId);
      txn.rejectedAt = new Date();
      (txn as any).rejectionRemark = rejectionRemark;

      await updateSummaryOnDelete(
        txn.chatId,
        txn.date,
        txn.from.toString(),
        txn.to.toString(),
        txn.amount,
      );
    }

    await txn.save();
    await syncChatLastTransaction(txn.chatId);

    const reviewerName = await getUserName(userId);
    const rejectMsg = rejectionRemark
      ? `${reviewerName} rejected your Rs. ${txn.amount} transaction — "${rejectionRemark}"`
      : `${reviewerName} rejected your Rs. ${txn.amount} transaction`;
    await sendPushNotification(
      txn.addedBy.toString(),
      action === "verify" ? "Transaction Verified" : "Transaction Rejected",
      action === "verify"
        ? `Rs. ${txn.amount} verified by ${reviewerName}`
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
      txn: serializeTxn(txn.toObject()),
    });
  },
);


// Edit transaction — only allowed when status === "rejected"
export const editTxn = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.params;
    const userId = req.user.id;
    const { amount, date, remarks, to, from } = req.body;

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

    // Guard: cannot edit verified transactions
    if (txn.status === "verified") {
      return next(new ErrorHandler("Cannot edit a verified transaction", 403));
    }

    // Guard: can only edit rejected transactions (not pending)
    if (txn.status !== "rejected") {
      return next(
        new ErrorHandler(
          "You can only edit a transaction after it has been rejected",
          403,
        ),
      );
    }

    // Guard: cannot move date to a closed month
    if (date !== undefined) {
      const newDate = new Date(date);
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      if (newDate < currentMonthStart) {
        return next(
          new ErrorHandler(
            "Cannot move transactions to closed months.",
            400,
          ),
        );
      }
    }

    // Update fields
    if (amount !== undefined) txn.amount = amount;
    if (date !== undefined) txn.date = date;
    if (remarks !== undefined) txn.remarks = remarks;
    if (to !== undefined) txn.to = to;
    if (from !== undefined) txn.from = from;

    // Reset status to pending for re-review; clear reject metadata
    txn.status = "pending";
    txn.verified = false;
    txn.rejectedBy = undefined;
    txn.rejectedAt = undefined;

    await txn.save();

    // Re-apply balance since reject previously rolled it back
    await updateSummaryOnAdd(
      txn.chatId,
      new Date(txn.date),
      txn.from.toString(),
      txn.to.toString(),
      txn.amount,
    );

    await syncChatLastTransaction(txn.chatId);

    // Notify the other member that the transaction was reworked
    const memberIds = await getChatMemberIds(txn.chatId);
    const otherMemberId = getOtherMemberId(memberIds, userId);
    if (otherMemberId) {
      const senderName = await getUserName(userId);
      await sendPushNotification(
        otherMemberId,
        "Transaction Resubmitted",
        `${senderName} resubmitted Rs. ${txn.amount} for review`,
        {
          type: "txn_reworked",
          senderId: userId,
          chatId: txn.chatId.toString(),
          txnId: txn._id.toString(),
        },
      );
    }

    return res.status(200).json({
      success: true,
      message: "Transaction resubmitted for review",
      txn: serializeTxn(txn.toObject()),
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
