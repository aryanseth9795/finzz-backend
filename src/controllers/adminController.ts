import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import TryCatch from "../utils/TryCatch.js";
import { User } from "../models/userModel.js";
import { Expense } from "../models/expenseModel.js";
import { ExpenseLedger } from "../models/expenseLedgerModel.js";
import { Pool } from "../models/poolModel.js";
import { Tx } from "../models/txModel.js";
import { Notification } from "../models/notificationModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import { JWT_SECRET, adminSecretKey } from "../config/envVariables.js";
import { Expo, ExpoPushMessage } from "expo-server-sdk";
import { PoolTx } from "../models/poolTxModel.js";

const expo = new Expo();

// ==========================================
// Admin Login (secret key)
// ==========================================
// console.log(adminSecretKey)
export const adminLogin = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { secretKey } = req.body;
    if (!secretKey || secretKey !== adminSecretKey) {
      return next(new ErrorHandler("Invalid admin secret key", 401));
    }

    // Create admin JWT token
    const token = jwt.sign(adminSecretKey, JWT_SECRET);

    res
      .status(200)
      .cookie("admin-token", token, {
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        httpOnly: true,
        sameSite: "none",
        secure: true,
      })
      .json({
        success: true,
        message: "Admin authenticated successfully",
        token,
      });
  },
);

// ==========================================
// Admin Logout
// ==========================================
export const adminLogout = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    res
      .status(200)
      .cookie("admin-token", "", {
        maxAge: 0,
        httpOnly: true,
        sameSite: "none",
        secure: true,
      })
      .json({
        success: true,
        message: "Admin logged out",
      });
  },
);

// ==========================================
// Admin Verify (check if token is valid)
// ==========================================
export const adminVerify = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    res.status(200).json({
      success: true,
      message: "Admin verified",
    });
  },
);

// ==========================================
// Dashboard Stats
// ==========================================
export const getDashboardStats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const [
      totalUsers,
      totalExpenses,
      totalPools,
      totalTransactions,
      recentUsers,
      monthlyExpenseData,
      categoryData,
      dailySignups,
    ] = await Promise.all([
      // Counts
      User.countDocuments(),
      Expense.countDocuments(),
      Pool.countDocuments(),
      Tx.countDocuments(),

      // Recent 10 users
      User.find()
        .sort({ _id: -1 })
        .limit(10)
        .select("name phone avatar _id")
        .lean(),

      // Monthly expense totals (last 12 months)
      Expense.aggregate([
        {
          $match: {
            date: {
              $gte: new Date(new Date().setMonth(new Date().getMonth() - 12)),
            },
          },
        },
        {
          $group: {
            _id: {
              year: { $year: "$date" },
              month: { $month: "$date" },
            },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),

      // Top expense categories
      Expense.aggregate([
        { $match: { category: { $nin: [null, ""] } } },
        {
          $group: {
            _id: "$category",
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 8 },
      ]),

      // Daily user signups (last 30 days)
      User.aggregate([
        {
          $match: {
            _id: {
              $gte: new mongoose.Types.ObjectId(
                Math.floor(
                  new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).getTime() /
                    1000,
                )
                  .toString(16)
                  .padStart(8, "0") + "0000000000000000",
              ),
            },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: { $toDate: "$_id" },
              },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    // Format monthly expense data
    const formattedMonthlyExpenses = monthlyExpenseData.map((m: any) => ({
      month: `${m._id.year}-${String(m._id.month).padStart(2, "0")}`,
      total: m.total,
      count: m.count,
    }));

    // Grand total expense
    const grandTotalExpense = await Expense.aggregate([
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    res.status(200).json({
      success: true,
      stats: {
        totalUsers,
        totalExpenses,
        totalPools,
        totalTransactions,
        grandTotalExpense:
          grandTotalExpense.length > 0 ? grandTotalExpense[0].total : 0,
        recentUsers,
        monthlyExpenses: formattedMonthlyExpenses,
        categoryData: categoryData.map((c: any) => ({
          name: c._id || "Uncategorized",
          value: c.total,
          count: c.count,
        })),
        dailySignups: dailySignups.map((d: any) => ({
          date: d._id,
          count: d.count,
        })),
      },
    });
  },
);

// ==========================================
// Get All Users (paginated)
// ==========================================
export const getAllUsers = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const search = (req.query.search as string) || "";
    const sort = (req.query.sort as string) || "-_id";

    const filter: any = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .select("-password -refreshToken")
        .lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      users,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  },
);

// ==========================================
// Get Single User Detail
// ==========================================
export const getUserDetail = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    const user = await User.findById(id)
      .select("-password -refreshToken")
      .populate("friends", "name phone avatar")
      .lean();

    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    // Get user's expense summary
    const expenseSummary = await Expense.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(id) } },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Get user's pools
    const pools = await Pool.find({
      $or: [{ createdBy: id }, { "members.userId": id }],
    })
      .select("name status totalBalance")
      .lean();

    // Get user's ledgers
    const ledgers = await ExpenseLedger.find({ userId: id })
      .sort({ year: -1, month: -1 })
      .limit(12)
      .lean();

    res.status(200).json({
      success: true,
      user,
      expenseSummary:
        expenseSummary.length > 0
          ? expenseSummary[0]
          : { totalAmount: 0, count: 0 },
      pools,
      ledgers,
    });
  },
);

// ==========================================
// Delete User
// ==========================================
export const deleteUser = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    // Delete related data
    await Promise.all([
      Expense.deleteMany({ userId: id }),
      ExpenseLedger.deleteMany({ userId: id }),
      Notification.deleteMany({
        $or: [{ recipient: id }, { sender: id }],
      }),
      Tx.deleteMany({
        $or: [{ addedBy: id }, { verifiedBy: id }],
      }),
    ]);

    await User.findByIdAndDelete(id);

    res.status(200).json({
      success: true,
      message: "User and related data deleted",
    });
  },
);

// ==========================================
// Get All Expenses (paginated)
// ==========================================
export const getAllExpenses = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    const userId = req.query.userId as string;

    const filter: any = {};
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(endDate);
    }
    if (userId) {
      filter.userId = new mongoose.Types.ObjectId(userId);
    }

    const [expenses, total] = await Promise.all([
      Expense.find(filter)
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("userId", "name phone")
        .lean(),
      Expense.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      expenses,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  },
);

// ==========================================
// Get All Pools
// ==========================================
export const getAllPools = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;

    const [pools, total] = await Promise.all([
      Pool.find()
        .sort({ _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("admin", "name phone avatar")
        .populate("members", "name phone avatar")
        .lean(),
      Pool.countDocuments(),
    ]);

    res.status(200).json({
      success: true,
      pools,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  },
);

// ==========================================
// Get All Pools Dashboard Stats
// ==========================================
export const getPoolDashboardStats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const [activePools, closedPools, allPoolTxns] = await Promise.all([
      Pool.countDocuments({ status: "active" }),
      Pool.countDocuments({ status: "closed" }),
      PoolTx.find().lean(),
    ]);

    let totalCredited = 0;
    let totalDebited = 0;

    allPoolTxns.forEach((tx) => {
      if (tx.type === "credit") {
        totalCredited += tx.amount;
      } else if (tx.type === "debit") {
        totalDebited += tx.amount;
      }
    });

    const netBalance = totalCredited - totalDebited;

    res.status(200).json({
      success: true,
      stats: {
        activePools,
        closedPools,
        totalCredited,
        totalDebited,
        netBalance,
      },
    });
  },
);

// ==========================================
// Get Admin Pool Detail
// ==========================================
export const getAdminPoolDetail = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;

    const pool = await Pool.findById(id)
      .populate("admin", "name phone avatar")
      .populate("members", "name phone avatar")
      .lean();

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    const txns = await PoolTx.find({ poolId: id })
      .populate("addedBy", "name phone avatar")
      .populate("verifiedBy", "name phone avatar")
      .sort({ date: -1 })
      .lean();

    let poolCredited = 0;
    let poolDebited = 0;

    txns.forEach((tx) => {
      if (tx.type === "credit") {
        poolCredited += tx.amount;
      } else if (tx.type === "debit") {
        poolDebited += tx.amount;
      }
    });

    res.status(200).json({
      success: true,
      pool,
      stats: {
        totalCredited: poolCredited,
        totalDebited: poolDebited,
        netBalance: poolCredited - poolDebited,
      },
      transactions: txns,
    });
  },
);

// ==========================================
// Send Bulk Notification to ALL users
// ==========================================
export const sendBulkNotification = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { title, body } = req.body;

    if (!title || !body) {
      return next(new ErrorHandler("Title and body are required", 400));
    }

    // Get all users with push tokens
    const users = await User.find({
      pushToken: { $exists: true, $ne: "" },
    })
      .select("_id pushToken")
      .lean();

    if (users.length === 0) {
      return next(new ErrorHandler("No users with push tokens found", 404));
    }

    // Build messages
    const messages: ExpoPushMessage[] = [];
    for (const user of users) {
      const token = (user as any).pushToken;
      if (token && Expo.isExpoPushToken(token)) {
        messages.push({
          to: token,
          sound: "default",
          title,
          body,
          data: { type: "admin_broadcast" },
        });
      }
    }

    // Send in chunks
    const chunks = expo.chunkPushNotifications(messages);
    let sentCount = 0;
    for (const chunk of chunks) {
      try {
        await expo.sendPushNotificationsAsync(chunk);
        sentCount += chunk.length;
      } catch (error) {
        console.error("Error sending bulk notifications:", error);
      }
    }

    res.status(200).json({
      success: true,
      message: `Notification sent to ${sentCount} users`,
      totalUsersWithTokens: users.length,
      sentCount,
    });
  },
);
