import { Request, Response, NextFunction } from "express";
import TryCatch from "../utils/TryCatch.js"; // default export
import { Tx } from "../models/txModel.js";
import { MonthlySummary } from "../models/monthlySummaryModel.js";
import { Chat } from "../models/chatModel.js";
import { User } from "../models/userModel.js";
import { getCarryForward } from "../services/summaryService.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import mongoose from "mongoose";

/**
 * GET /stats/chat/:chatId?year=2026&month=2
 * Returns per-user stats for a specific month + carry-forward from prior months.
 * If no year/month provided, defaults to current month.
 */
export const getChatStats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { chatId } = req.params;
    const now = new Date();
    const year = parseInt(req.query.year as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;

    // 1. Get the pre-computed summary for this month (O(1) indexed lookup)
    const summary = await MonthlySummary.findOne({
      chatId,
      year,
      month,
    }).lean<{
      members:
        | Map<string, { totalSent: number; totalReceived: number }>
        | Record<string, { totalSent: number; totalReceived: number }>;
      txCount: number;
    }>();

    // 2. Get carry-forward balance from all prior months
    const carryForward = await getCarryForward(chatId, year, month);

    // 3. Get chat members for names
    const chat = await Chat.findById(chatId)
      .select("members")
      .populate("members", "name")
      .lean<{ members: { _id: any; name: string }[] }>();

    if (!chat) {
      return next(new ErrorHandler("Chat not found", 404));
    }

    // 4. Build per-user stats with names
    const members: Record<
      string,
      {
        userId: string;
        name: string;
        totalSent: number;
        totalReceived: number;
        net: number;
      }
    > = {};

    for (const member of chat.members) {
      const id = member._id.toString();
      const membersObj = summary?.members as any;
      const memberData = membersObj?.[id] || {
        totalSent: 0,
        totalReceived: 0,
      };

      const totalSent = memberData.totalSent || 0;
      const totalReceived = memberData.totalReceived || 0;

      members[id] = {
        userId: id,
        name: member.name,
        totalSent,
        totalReceived,
        net: totalReceived - totalSent, // positive = has to receive, negative = has to send
      };
    }

    return res.status(200).json({
      success: true,
      stats: {
        year,
        month,
        members,
        carryForward,
        txCount: summary?.txCount || 0,
      },
    });
  },
);

/**
 * GET /stats/chat/:chatId/months
 * Returns a list of all months that have transactions for this chat.
 * Used for the month picker in the frontend.
 */
export const getChatMonths = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { chatId } = req.params;

    const months = await MonthlySummary.find({
      chatId,
      txCount: { $gt: 0 },
    })
      .select("year month txCount")
      .sort({ year: -1, month: -1 })
      .lean<{ year: number; month: number; txCount: number }[]>();

    return res.status(200).json({
      success: true,
      months: months.map((m) => ({
        year: m.year,
        month: m.month,
        txCount: m.txCount,
      })),
    });
  },
);

// ==============================
// Legacy endpoints (kept for Reports screen)
// ==============================

// Get monthly report for user across all transactions
export const getMonthlyReport = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    const report = await Tx.aggregate([
      {
        $match: {
          $or: [
            { to: new mongoose.Types.ObjectId(userId) },
            { from: new mongoose.Types.ObjectId(userId) },
          ],
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$date" },
            month: { $month: "$date" },
          },
          totalCredit: {
            $sum: {
              $cond: [
                { $eq: ["$to", new mongoose.Types.ObjectId(userId)] },
                "$amount",
                0,
              ],
            },
          },
          totalDebit: {
            $sum: {
              $cond: [
                { $eq: ["$from", new mongoose.Types.ObjectId(userId)] },
                "$amount",
                0,
              ],
            },
          },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          year: "$_id.year",
          month: "$_id.month",
          totalCredit: 1,
          totalDebit: 1,
          net: { $subtract: ["$totalCredit", "$totalDebit"] },
          count: 1,
          _id: 0,
        },
      },
      { $sort: { year: -1, month: -1 } },
      { $limit: 12 },
    ]);

    return res.status(200).json({
      success: true,
      report,
    });
  },
);

// Get per-friend report
export const getPerFriendReport = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { friendId } = req.params;
    const userId = req.user.id;

    const report = await Tx.aggregate([
      {
        $match: {
          $or: [
            {
              to: new mongoose.Types.ObjectId(userId),
              from: new mongoose.Types.ObjectId(friendId),
            },
            {
              to: new mongoose.Types.ObjectId(friendId),
              from: new mongoose.Types.ObjectId(userId),
            },
          ],
        },
      },
      {
        $group: {
          _id: {
            year: { $year: "$date" },
            month: { $month: "$date" },
          },
          totalCredit: {
            $sum: {
              $cond: [
                { $eq: ["$to", new mongoose.Types.ObjectId(userId)] },
                "$amount",
                0,
              ],
            },
          },
          totalDebit: {
            $sum: {
              $cond: [
                { $eq: ["$from", new mongoose.Types.ObjectId(userId)] },
                "$amount",
                0,
              ],
            },
          },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          year: "$_id.year",
          month: "$_id.month",
          totalCredit: 1,
          totalDebit: 1,
          net: { $subtract: ["$totalCredit", "$totalDebit"] },
          count: 1,
          _id: 0,
        },
      },
      { $sort: { year: -1, month: -1 } },
    ]);

    return res.status(200).json({
      success: true,
      report,
    });
  },
);
