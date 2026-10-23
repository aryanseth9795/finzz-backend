import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import { Expo } from "expo-server-sdk";
import crypto from "crypto";
import TryCatch from "../utils/TryCatch.js";
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
import ErrorHandler from "../middlewares/Errorhandler.js";
import {
  adminSecretKey,
  adminSecretKind,
  wrongAdminCredentialMessage,
} from "../config/envVariables.js";
import { signAdminToken } from "../utils/tokens.js";
import { buildSearchRegex } from "../utils/escapeRegex.js";
import {
  broadcastPushNotification,
  sendBulkPushNotifications,
} from "../services/notificationService.js";
import {
  processPushReceipts,
  recentDeliveryStats,
} from "../services/pushReceipts.js";
import { PoolTx } from "../models/poolTxModel.js";
import { PushTicket } from "../models/pushTicketModel.js";
import {
  DailyActivity,
  DailyTraffic,
} from "../models/dailyActivityModel.js";
import {
  dayKey,
  flushActivity,
  ANALYTICS_TZ_OFFSET_MINUTES,
} from "../services/activityTracker.js";
import { adminTrafficQuerySchema } from "../middlewares/validation.js";
import {
  reserveAttempt,
  recordSuccess,
} from "../services/adminLoginGuard.js";

/**
 * Cookie options for the admin session.
 *
 * `sameSite: "none"` is required only because the admin SPA and this API are on
 * different registrable domains. `partitioned` opts into CHIPS so the cookie
 * survives third-party-cookie restrictions (Safari ITP blocks it otherwise).
 * The durable fix is to serve the API from a subdomain of the admin origin,
 * at which point this can become `sameSite: "lax"` and the CSRF surface closes
 * entirely — see the Phase 4 notes.
 */
const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "none" as const,
  secure: true,
  partitioned: true,
  path: "/",
};

// ==========================================
// Admin Login (6-character PIN, or legacy long secret)
// ==========================================
const sha256 = (value: string) =>
  crypto.createHash("sha256").update(value, "utf8").digest();

/** Upper-case ASCII letters only, so non-ASCII case folding (e.g. "ß") can't alias. */
const asciiUpper = (value: string) =>
  value.replace(/[a-z]/g, (c) => c.toUpperCase());

/**
 * Compare in constant time. Both sides are hashed first so the buffers are
 * always 32 bytes: `timingSafeEqual` needs equal lengths, and hashing avoids
 * leaking the secret's length through an early length check. A PIN is compared
 * case-insensitively; the legacy long secret exactly.
 */
const adminSecretMatches = (provided: string): boolean => {
  const isPin = /^[A-Za-z0-9]{6}$/.test(adminSecretKey);
  const a = isPin ? asciiUpper(provided) : provided;
  const b = isPin ? asciiUpper(adminSecretKey) : adminSecretKey;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
};

const sendLocked = (res: Response, retryAfterSeconds: number) =>
  void res
    .status(429)
    .set("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))))
    .json({
      success: false,
      message: `Too many attempts. Try again in ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} min`,
      retryAfterSeconds,
    });

export const adminLogin = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { secretKey } = req.body;
    const ip = req.ip ?? "unknown";

    // Reserve the attempt BEFORE comparing. The reservation is atomic, so with
    // many guesses in flight only the permitted number is ever compared; a
    // refused attempt (even with the correct PIN) is never looked at, so a
    // lock cannot be probed for the answer.
    const attempt = await reserveAttempt(ip);
    if (!attempt.allowed) return sendLocked(res, attempt.retryAfterSeconds);

    if (!adminSecretMatches(String(secretKey ?? ""))) {
      // The attempt is already counted. If it was the last permitted one the
      // lock is now in force and the caller is told so.
      if (attempt.locked) return sendLocked(res, attempt.retryAfterSeconds);
      return void res.status(401).json({
        success: false,
        message: wrongAdminCredentialMessage(adminSecretKind),
        attemptsLeft: attempt.attemptsLeft,
      });
    }

    await recordSuccess(ip, attempt.reservedAt);
    const token = signAdminToken();

    res
      .status(200)
      .cookie("admin-token", token, {
        ...ADMIN_COOKIE_OPTIONS,
        maxAge: 1000 * 60 * 60 * 12, // must match ADMIN_TOKEN_EXPIRES_IN
      })
      // The token is deliberately NOT returned in the body. It was previously,
      // which defeated `httpOnly`: the value became readable from JS, devtools,
      // and any logging proxy. The admin SPA has always used only the cookie.
      .json({
        success: true,
        message: "Admin authenticated successfully",
      });
  },
);

// ==========================================
// Admin Logout
// ==========================================
export const adminLogout = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // clearCookie must receive the same attributes used to set it, or the
    // browser treats it as a different cookie and the session survives.
    res.status(200).clearCookie("admin-token", ADMIN_COOKIE_OPTIONS).json({
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
    // Escaped and length-capped: an unescaped `$regex` let any search term be
    // a ReDoS payload, and an unbalanced "(" was a 500. See escapeRegex.ts.
    const searchMatcher = buildSearchRegex(search);
    if (searchMatcher) {
      filter.$or = [{ name: searchMatcher }, { phone: searchMatcher }];
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
      // Was `{ createdBy: id }` and `{ "members.userId": id }` — neither field
      // exists on the Pool schema (it has `admin`, and `members` is a flat
      // ObjectId array), so this query silently matched nothing and the admin
      // UI reported "0 pools" for every user, including pool administrators.
      $or: [{ admin: id }, { members: id }],
    })
      // `totalBalance` is likewise not a field on Pool; requesting it returned
      // undefined rather than erroring.
      .select("name status members admin")
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

    if (!mongoose.isValidObjectId(id)) {
      return next(new ErrorHandler("Invalid user id", 400));
    }

    const user = await User.findById(id);
    if (!user) {
      return next(new ErrorHandler("User not found", 404));
    }

    const userId = new mongoose.Types.ObjectId(id);

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

    res.status(200).json({
      success: true,
      message: "User and all related data deleted",
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

    /**
     * Totals over the WHOLE filtered set, not just the returned page.
     *
     * The admin UI was computing its "Total Amount" — and its category and
     * daily charts — by reducing over the 50 rows it happened to have
     * fetched, then exporting that as a PDF headed "Period: All Time". On a
     * 500-row filter the document stated a total that was a tenth of the
     * truth, in a file that detaches from the UI and gets emailed and filed.
     *
     * A client cannot compute a total it does not hold, so the aggregate has
     * to come from here. `$facet` runs both pipelines in one round trip.
     */
    const [expenses, total, aggregate] = await Promise.all([
      Expense.find(filter)
        .sort({ date: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("userId", "name phone")
        .lean(),
      Expense.countDocuments(filter),
      Expense.aggregate([
        { $match: filter },
        {
          $facet: {
            overall: [
              {
                $group: {
                  _id: null,
                  totalAmount: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
            ],
            byCategory: [
              {
                $group: {
                  _id: { $ifNull: ["$category", "Uncategorised"] },
                  total: { $sum: "$amount" },
                  count: { $sum: 1 },
                },
              },
              { $sort: { total: -1 } },
              { $limit: 20 },
            ],
          },
        },
      ]),
    ]);

    const facet = aggregate[0] ?? { overall: [], byCategory: [] };
    const overall = facet.overall?.[0] ?? { totalAmount: 0, count: 0 };

    res.status(200).json({
      success: true,
      expenses,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
      totals: {
        totalAmount: overall.totalAmount,
        count: overall.count,
        byCategory: (facet.byCategory ?? []).map(
          (c: { _id: string; total: number; count: number }) => ({
            name: c._id,
            total: c.total,
            count: c.count,
          }),
        ),
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
    /**
     * Was `PoolTx.find().lean()` — every pool transaction in the database
     * loaded into the Node heap and summed in application code. On a 512 MB
     * instance that is the most likely single cause of an OOM restart, and the
     * admin UI re-invoked it on every pagination click.
     *
     * `$group` does the same arithmetic inside the database over a covered
     * index, transferring two numbers instead of the whole collection. Cost
     * goes from O(documents) in memory and bandwidth to O(1) in both.
     */
    const [activePools, closedPools, totals] = await Promise.all([
      Pool.countDocuments({ status: "active" }),
      Pool.countDocuments({ status: "closed" }),
      PoolTx.aggregate<{ _id: "credit" | "debit"; total: number }>([
        { $group: { _id: "$type", total: { $sum: "$amount" } } },
      ]),
    ]);

    const totalCredited =
      totals.find((t) => t._id === "credit")?.total ?? 0;
    const totalDebited = totals.find((t) => t._id === "debit")?.total ?? 0;
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

    if (!title) {
      return next(new ErrorHandler("Title is required", 400));
    }

    const report = await broadcastPushNotification(title, body, {
      type: "admin_broadcast",
    });

    if (report.recipients === 0) {
      return next(new ErrorHandler("No users with push tokens found", 404));
    }

    res.status(200).json({
      success: true,
      message:
        `Queued ${report.accepted} notification(s) at Expo. ` +
        `Delivery is confirmed within ~25 minutes, or press Check now.`,
      // Three distinct numbers, because they mean three different things.
      // `sentCount` previously counted messages *submitted* to Expo and was
      // reported to the operator as a delivery count.
      recipients: report.recipients,
      accepted: report.accepted,
      rejected: report.rejected,
      /** @deprecated use `accepted`. Retained so the current admin build keeps working. */
      sentCount: report.accepted,
      /** @deprecated use `recipients`. */
      totalUsersWithTokens: report.recipients,
    });
  },
);

// ==========================================
// Send Targeted Notification to specific users
// ==========================================
export const sendTargetedNotification = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { userIds, title, body } = req.body;

    if (!title) {
      return next(new ErrorHandler("Title is required", 400));
    }

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return next(new ErrorHandler("Please select at least one user", 400));
    }

    const invalid = userIds.filter(
      (id: unknown) => !mongoose.isValidObjectId(id as string),
    );
    if (invalid.length > 0) {
      return next(new ErrorHandler("One or more user ids are invalid", 400));
    }

    try {
      // Distinguish "nobody has a device" from "the send ran" so the admin sees
      // an accurate reason instead of a generic failure.
      const recipients = await User.find({ _id: { $in: userIds } })
        .select("pushTokens pushToken")
        .lean();
      const withDevice = recipients.filter((u: any) =>
        [...(u.pushTokens ?? []), u.pushToken].some(
          (t) => typeof t === "string" && Expo.isExpoPushToken(t),
        ),
      ).length;

      if (withDevice === 0) {
        return next(
          new ErrorHandler(
            "None of the selected users has a device registered for notifications",
            404,
          ),
        );
      }

      const report = await sendBulkPushNotifications(
        userIds.map((userId: string) => ({
          userId,
          title,
          body,
          data: { type: "admin_targeted" },
        })),
      );

      if (report.error) {
        console.error("[admin] sendTargetedNotification send failed:", report.error);
        return next(new ErrorHandler("Failed to send the notification", 500));
      }

      let message = `Queued ${report.accepted} notification(s) at Expo`;
      if (report.rejected > 0) message += `; ${report.rejected} rejected`;
      if (report.skipped > 0) {
        message += `; ${report.skipped} user(s) skipped (no device or send failed)`;
      }

      res.status(200).json({
        success: true,
        message,
        totalSelectedUsers: userIds.length,
        accepted: report.accepted,
        rejected: report.rejected,
        skipped: report.skipped,
        /** @deprecated use `accepted`. */
        sentCount: report.accepted,
      });
    } catch (error) {
      console.error("[admin] sendTargetedNotification failed:", error);
      return next(new ErrorHandler("Failed to send the notification", 500));
    }
  },
);

// ==========================================
// Push delivery health (last 24h)
// ==========================================
export const getNotificationHealth = TryCatch(
  async (req: Request, res: Response) => {
    let checkFailed: boolean | undefined;
    if (req.query.check === "1") {
      const run = await processPushReceipts({ olderThanMs: 0 });
      checkFailed = run.fetchFailed > 0;
    }

    const last24h = await recentDeliveryStats();
    const codes = Object.keys(last24h.errors);

    let hint: string | null = null;
    if (
      codes.includes("InvalidCredentials") ||
      codes.includes("MismatchSenderId")
    ) {
      hint =
        "Expo can't deliver to Android: the FCM V1 credential for this app is missing or belongs to another Firebase project. Upload the Firebase service-account key for project finzz-1e22b with `eas credentials` (Android → Push Notifications: FCM V1).";
    } else if (codes.length > 0 && codes.every((c) => c === "DeviceNotRegistered")) {
      hint =
        "Some devices uninstalled the app or changed tokens; they were removed automatically.";
    } else if (last24h.total === 0) {
      hint = "No pushes were sent in the last 24 hours.";
    }

    res.status(200).json({
      success: true,
      last24h,
      hint,
      ...(checkFailed === undefined ? {} : { checkFailed }),
    });
  },
);

// ==========================================
// Traffic analytics
// ==========================================

/** "+05:30" style offset string for Mongo's `$dateToString` timezone. */
const tzOffsetString = (minutes: number): string => {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
};

export const getTrafficAnalytics = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // Express 5: validate() cannot write the coerced query back, so re-parse.
    const { days } = adminTrafficQuerySchema.parse({ query: req.query }).query;

    // Make today's buffered counts visible to the queries below.
    await flushActivity();

    const DAY_MS = 86_400_000;
    const now = Date.now();
    const dayAt = (ago: number) => dayKey(new Date(now - ago * DAY_MS));
    const today = dayAt(0);
    const dayList = Array.from({ length: days }, (_, i) => dayAt(days - 1 - i));
    const firstDay = dayList[0];
    const weekStart = dayAt(6);
    const monthStart = dayAt(29);

    // Start of the first local day, as a UTC instant.
    const rangeStart = new Date(
      Date.parse(`${firstDay}T00:00:00.000Z`) -
        ANALYTICS_TZ_OFFSET_MINUTES * 60_000,
    );

    const [perDay, traffic, newUsersPerDay, wauAgg, mauAgg, top, firstTraffic] =
      await Promise.all([
        DailyActivity.aggregate([
          { $match: { day: { $gte: firstDay, $lte: today } } },
          {
            $group: {
              _id: "$day",
              activeUsers: { $sum: 1 },
              opens: { $sum: "$opens" },
            },
          },
        ]),
        DailyTraffic.find({ day: { $gte: firstDay, $lte: today } })
          .select("day requests")
          .lean(),
        User.aggregate([
          { $match: { createdAt: { $gte: rangeStart } } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: "%Y-%m-%d",
                  date: "$createdAt",
                  timezone: tzOffsetString(ANALYTICS_TZ_OFFSET_MINUTES),
                },
              },
              count: { $sum: 1 },
            },
          },
        ]),
        DailyActivity.aggregate([
          { $match: { day: { $gte: weekStart, $lte: today } } },
          { $group: { _id: "$user" } },
          { $count: "n" },
        ]),
        DailyActivity.aggregate([
          { $match: { day: { $gte: monthStart, $lte: today } } },
          { $group: { _id: "$user" } },
          { $count: "n" },
        ]),
        DailyActivity.find({ day: today })
          .sort({ requests: -1, lastSeenAt: -1 })
          .limit(10)
          .select("user requests opens lastSeenAt")
          .lean(),
        DailyTraffic.findOne().sort({ day: 1 }).select("day").lean(),
      ]);

    const activityByDay = new Map<string, { activeUsers: number; opens: number }>(
      perDay.map((d: any) => [d._id, d]),
    );
    const requestsByDay = new Map<string, number>(
      traffic.map((t) => [t.day, t.requests]),
    );
    const newUsersByDay = new Map<string, number>(
      newUsersPerDay.map((d: any) => [d._id, d.count]),
    );

    const daysOut = dayList.map((date) => ({
      date,
      activeUsers: activityByDay.get(date)?.activeUsers ?? 0,
      opens: activityByDay.get(date)?.opens ?? 0,
      requests: requestsByDay.get(date) ?? 0,
      newUsers: newUsersByDay.get(date) ?? 0,
    }));

    const todayRow = daysOut[daysOut.length - 1];
    const dau = todayRow.activeUsers;
    const wau: number = wauAgg[0]?.n ?? 0;
    const mau: number = mauAgg[0]?.n ?? 0;

    const topUsers = await User.find({ _id: { $in: top.map((t) => t.user) } })
      .select("name")
      .lean();
    const nameById = new Map(topUsers.map((u) => [String(u._id), u.name]));

    res.status(200).json({
      success: true,
      trackingSince: firstTraffic?.day ?? null,
      today: {
        activeUsers: todayRow.activeUsers,
        opens: todayRow.opens,
        requests: todayRow.requests,
        newUsers: todayRow.newUsers,
      },
      totals: {
        dau,
        wau,
        mau,
        stickiness: mau ? Math.round((dau / mau) * 1000) / 1000 : 0,
      },
      days: daysOut,
      topToday: top.map((t) => ({
        userId: String(t.user),
        name: nameById.get(String(t.user)) ?? "Unknown",
        requests: t.requests,
        opens: t.opens,
        lastSeenAt: t.lastSeenAt,
      })),
    });
  },
);
