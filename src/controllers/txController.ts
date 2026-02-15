import { NextFunction, Request, Response } from "express";
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
import mongoose from "mongoose";

// Add transaction
export const addtxns = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { chatId, to, from, amount, date, remarks } = req.body;
    const userId = req.user.id;

    // Validate transaction date is not in a closed month (past month)
    const txDate = new Date(date);
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    if (txDate < currentMonthStart) {
      return next(
        new ErrorHandler(
          "Cannot add transactions to closed months. Only current month is allowed.",
          400,
        ),
      );
    }

    // Validate user is member of the chat
    const chat = await Chat.findById(chatId)
      .select("members")
      .lean<{ members: any[] }>();
    if (!chat) {
      return next(new ErrorHandler("Chat not found", 404));
    }

    const isMember = chat.members.some(
      (member) => member.toString() === userId,
    );
    if (!isMember) {
      return next(new ErrorHandler("You are not a member of this chat", 403));
    }

    // Create transaction
    const txn = await Tx.create({
      chatId,
      to,
      from,
      amount,
      date,
      remarks,
      addedBy: userId,
      verified: false,
    });

    // Update monthly summary (atomic $inc)
    await updateSummaryOnAdd(chatId, new Date(date), from, to, amount);

    // Update chat's lastTransaction
    await Chat.findByIdAndUpdate(chatId, {
      lastTransaction: {
        amount,
        date,
        remark: remarks || "",
      },
    });

    // Send push notification to the other member
    const otherMember = chat.members.find(
      (member: any) => member.toString() !== userId,
    );
    if (otherMember) {
      const senderName = await User.findById(userId)
        .select("name")
        .lean<{ name: string }>();
      await sendPushNotification(
        otherMember.toString(),
        "New Transaction",
        `₹${amount} added by ${senderName?.name}`,
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
      txn,
    });
  },
);

// Get transactions for a chat with cursor-based pagination
export const getTxns = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { chatId } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;
    const year = req.query.year
      ? parseInt(req.query.year as string)
      : undefined;
    const month = req.query.month
      ? parseInt(req.query.month as string)
      : undefined;

    // Build query
    const query: any = { chatId: new mongoose.Types.ObjectId(chatId) };

    // Month filter (if year and month provided)
    if (year && month) {
      const monthStart = new Date(year, month - 1, 1);
      const monthEnd = new Date(year, month, 1);
      query.date = { $gte: monthStart, $lt: monthEnd };
    }

    // Cursor pagination (within the month if filtered)
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (query.date) {
        // Combine month filter with cursor
        query.date.$lt = cursorDate;
      } else {
        query.date = { $lt: cursorDate };
      }
    }

    // Fetch limit + 1 to check if there are more pages
    const txns = await Tx.find(query)
      .sort({ date: -1, _id: -1 })
      .limit(limit + 1)
      .populate("addedBy", "name")
      .populate("verifiedBy", "name")
      .populate("chatId", "members")
      .lean();

    const hasMore = txns.length > limit;
    if (hasMore) txns.pop(); // Remove extra item

    const nextCursor =
      hasMore && txns.length > 0
        ? txns[txns.length - 1].date.toISOString()
        : null;

    return res.status(200).json({
      success: true,
      txns,
      nextCursor,
      hasMore,
    });
  },
);

// Verify transaction
export const verifyTxn = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.body;
    const userId = req.user.id;

    const txn = await Tx.findById(txnId);

    if (!txn) {
      return next(new ErrorHandler("Transaction not found", 404));
    }

    // Guard: only the member who did NOT add the txn can verify
    if (txn.addedBy.toString() === userId) {
      return next(
        new ErrorHandler("You cannot verify your own transaction", 403),
      );
    }

    // Guard: already verified
    if (txn.verified) {
      return next(new ErrorHandler("Transaction is already verified", 400));
    }

    // Verify the transaction
    txn.verified = true;
    txn.verifiedBy = new mongoose.Types.ObjectId(userId);
    txn.verifiedAt = new Date();
    await txn.save();

    // Send push notification to the person who added the txn
    const verifierName = await User.findById(userId)
      .select("name")
      .lean<{ name: string }>();
    await sendPushNotification(
      txn.addedBy.toString(),
      "Transaction Verified",
      `₹${txn.amount} verified by ${verifierName?.name}`,
      {
        type: "txn_verified",
        senderId: userId,
        txnId: txnId,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Transaction verified successfully",
      txn,
    });
  },
);

// Edit transaction
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
    if (txn.verified) {
      return next(new ErrorHandler("Cannot edit verified transaction", 403));
    }

    // Guard: cannot edit transactions in closed months (if date is being changed)
    if (date !== undefined) {
      const newDate = new Date(date);
      const now = new Date();
      const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      if (newDate < currentMonthStart) {
        return next(
          new ErrorHandler(
            "Cannot move transactions to closed months. Only current month is allowed.",
            400,
          ),
        );
      }
    }

    // Also check if the original transaction is in a closed month
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    if (txn.date < currentMonthStart) {
      return next(
        new ErrorHandler("Cannot edit transactions from closed months.", 400),
      );
    }

    // Capture old values before update for summary recalculation
    const oldTx = {
      date: txn.date,
      from: txn.from.toString(),
      to: txn.to.toString(),
      amount: txn.amount,
    };

    // Update fields
    if (amount !== undefined) txn.amount = amount;
    if (date !== undefined) txn.date = date;
    if (remarks !== undefined) txn.remarks = remarks;
    if (to !== undefined) txn.to = to;
    if (from !== undefined) txn.from = from;

    await txn.save();

    // Update monthly summary (handles month/direction/amount changes)
    await updateSummaryOnEdit(txn.chatId, oldTx, {
      date: txn.date,
      from: txn.from.toString(),
      to: txn.to.toString(),
      amount: txn.amount,
    });

    // Update chat's lastTransaction if this is the latest txn
    const chat = await Chat.findById(txn.chatId).select("lastTransaction");
    if (chat && chat.lastTransaction?.date) {
      const latestTxn: any = await Tx.findOne({ chatId: txn.chatId })
        .sort({ date: -1 })
        .select("amount date remarks")
        .lean();
      if (latestTxn) {
        await Chat.findByIdAndUpdate(txn.chatId, {
          lastTransaction: {
            amount: latestTxn.amount,
            date: latestTxn.date,
            remark: latestTxn.remarks || "",
          },
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Transaction updated successfully",
      txn,
    });
  },
);

// Delete transaction
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
    if (txn.verified) {
      return next(new ErrorHandler("Cannot delete verified transaction", 403));
    }

    const chatId = txn.chatId;

    // Update monthly summary before deletion
    await updateSummaryOnDelete(
      chatId,
      txn.date,
      txn.from.toString(),
      txn.to.toString(),
      txn.amount,
    );

    await Tx.findByIdAndDelete(txnId);

    // Update chat's lastTransaction
    const latestTxn: any = await Tx.findOne({ chatId })
      .sort({ date: -1 })
      .select("amount date remarks")
      .lean();

    if (latestTxn) {
      await Chat.findByIdAndUpdate(chatId, {
        lastTransaction: {
          amount: latestTxn.amount,
          date: latestTxn.date,
          remark: latestTxn.remarks || "",
        },
      });
    } else {
      // No transactions left, clear lastTransaction
      await Chat.findByIdAndUpdate(chatId, {
        $unset: { lastTransaction: "" },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Transaction deleted successfully",
    });
  },
);

// Get all transactions for a user (grouped by friends, for home screen)
export const getAllTxnsUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = new mongoose.Types.ObjectId(req.user.id);

    const result = await Tx.aggregate([
      {
        $match: {
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
