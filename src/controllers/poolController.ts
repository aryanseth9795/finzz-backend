import { NextFunction, Request, Response } from "express";
import TryCatch from "../utils/TryCatch.js";
import { Pool } from "../models/poolModel.js";
import { PoolTx } from "../models/poolTxModel.js";
import { User } from "../models/userModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import {
  sendPushNotification,
  sendBulkPushNotifications,
} from "../services/notificationService.js";
import mongoose from "mongoose";

// ========================
// Pool CRUD Operations
// ========================

// Create pool
export const createPool = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, description, rules } = req.body;
    const userId = req.user.id;

    const pool = await Pool.create({
      name,
      description,
      rules,
      admin: userId,
      members: [userId], // Creator is the first member
      status: "active",
    });

    return res.status(201).json({
      success: true,
      message: "Pool created successfully",
      pool,
    });
  },
);

// Get all pools for the current user
export const getMyPools = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    const pools = await Pool.find({ members: userId })
      .populate("members", "name avatar phone")
      .populate("admin", "name avatar")
      .sort({ "lastTransaction.date": -1 })
      .lean();

    return res.status(200).json({
      success: true,
      pools,
    });
  },
);

// Get pool by ID
export const getPoolById = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId)
      .populate("members", "name avatar phone")
      .populate("admin", "name avatar")
      .lean();

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check membership
    const isMember = pool.members.some(
      (member: any) => member._id.toString() === userId,
    );

    if (!isMember) {
      return next(new ErrorHandler("You are not a member of this pool", 403));
    }

    return res.status(200).json({
      success: true,
      pool,
    });
  },
);

// Update pool (admin only)
export const updatePool = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const { name, description, rules, image } = req.body;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check admin
    if (pool.admin.toString() !== userId) {
      return next(
        new ErrorHandler("Only the admin can update pool details", 403),
      );
    }

    // Update fields
    if (name !== undefined) pool.name = name;
    if (description !== undefined) pool.description = description;
    if (rules !== undefined) pool.rules = rules;
    if (image !== undefined) pool.image = image;

    await pool.save();

    return res.status(200).json({
      success: true,
      message: "Pool updated successfully",
      pool,
    });
  },
);

// Delete pool (admin only)
export const deletePool = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check admin
    if (pool.admin.toString() !== userId) {
      return next(new ErrorHandler("Only the admin can delete the pool", 403));
    }

    // Delete all pool transactions
    await PoolTx.deleteMany({ poolId });

    // Delete pool
    await Pool.findByIdAndDelete(poolId);

    return res.status(200).json({
      success: true,
      message: "Pool and all transactions deleted successfully",
    });
  },
);

// ========================
// Membership Management
// ========================

// Add member (admin only)
export const addMember = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const { userId: newMemberId } = req.body;
    const adminId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check admin
    if (pool.admin.toString() !== adminId) {
      return next(new ErrorHandler("Only the admin can add members", 403));
    }

    // Check if user exists
    const newMember = await User.findById(newMemberId);
    if (!newMember) {
      return next(new ErrorHandler("User not found", 404));
    }

    // Check if already a member
    const alreadyMember = pool.members.some(
      (member) => member.toString() === newMemberId,
    );

    if (alreadyMember) {
      return next(new ErrorHandler("User is already a member", 400));
    }

    // Add member
    pool.members.push(new mongoose.Types.ObjectId(newMemberId));
    await pool.save();

    // Send push notification to added member
    const adminUser = await User.findById(adminId).select("name").lean();
    await sendPushNotification(
      newMemberId,
      "Pool Invite",
      `${adminUser?.name} added you to ${pool.name}`,
      {
        type: "pool_member_added",
        senderId: adminId,
        poolId: poolId,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Member added successfully",
      pool,
    });
  },
);

// Remove member (admin only)
export const removeMember = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const { userId: memberToRemove } = req.body;
    const adminId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check admin
    if (pool.admin.toString() !== adminId) {
      return next(new ErrorHandler("Only the admin can remove members", 403));
    }

    // Cannot remove self (admin)
    if (memberToRemove === adminId) {
      return next(
        new ErrorHandler(
          "Admin cannot remove themselves. Use leave pool instead",
          400,
        ),
      );
    }

    // Check if member exists in pool
    const isMember = pool.members.some(
      (member) => member.toString() === memberToRemove,
    );

    if (!isMember) {
      return next(new ErrorHandler("User is not a member of this pool", 400));
    }

    // Remove member
    pool.members = pool.members.filter(
      (member) => member.toString() !== memberToRemove,
    );
    await pool.save();

    // Send push notification to removed member
    const adminUser = await User.findById(adminId).select("name").lean();
    await sendPushNotification(
      memberToRemove,
      "Pool Update",
      `${adminUser?.name} removed you from ${pool.name}`,
      {
        type: "pool_member_removed",
        senderId: adminId,
        poolId: poolId,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Member removed successfully",
      pool,
    });
  },
);

// Leave pool
export const leavePool = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check if member
    const isMember = pool.members.some(
      (member) => member.toString() === userId,
    );

    if (!isMember) {
      return next(new ErrorHandler("You are not a member of this pool", 400));
    }

    // If admin is leaving
    if (pool.admin.toString() === userId) {
      // Transfer admin to next member or delete if last member
      const otherMembers = pool.members.filter(
        (member) => member.toString() !== userId,
      );

      if (otherMembers.length === 0) {
        // Last member, delete pool
        await PoolTx.deleteMany({ poolId });
        await Pool.findByIdAndDelete(poolId);

        return res.status(200).json({
          success: true,
          message: "Pool deleted (you were the last member)",
        });
      } else {
        // Transfer admin to first remaining member
        pool.admin = otherMembers[0];
        pool.members = otherMembers;
        await pool.save();

        return res.status(200).json({
          success: true,
          message: "You left the pool. Admin transferred to another member",
        });
      }
    }

    // Regular member leaving
    pool.members = pool.members.filter(
      (member) => member.toString() !== userId,
    );
    await pool.save();

    return res.status(200).json({
      success: true,
      message: "You left the pool successfully",
    });
  },
);

// ========================
// Pool Status Management
// ========================

// Close pool (admin only)
export const closePool = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check admin
    if (pool.admin.toString() !== userId) {
      return next(new ErrorHandler("Only the admin can close the pool", 403));
    }

    if (pool.status === "closed") {
      return next(new ErrorHandler("Pool is already closed", 400));
    }

    pool.status = "closed";
    await pool.save();

    return res.status(200).json({
      success: true,
      message: "Pool closed successfully",
      pool,
    });
  },
);

// Reopen pool (admin only)
export const reopenPool = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check admin
    if (pool.admin.toString() !== userId) {
      return next(new ErrorHandler("Only the admin can reopen the pool", 403));
    }

    if (pool.status === "active") {
      return next(new ErrorHandler("Pool is already active", 400));
    }

    pool.status = "active";
    await pool.save();

    return res.status(200).json({
      success: true,
      message: "Pool reopened successfully",
      pool,
    });
  },
);

// ========================
// Pool Transactions
// ========================

// Add pool transaction
export const addPoolTx = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId, amount, type, date, remarks } = req.body;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId);

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check membership
    const isMember = pool.members.some(
      (member) => member.toString() === userId,
    );

    if (!isMember) {
      return next(
        new ErrorHandler("Only pool members can add transactions", 403),
      );
    }

    // Check if pool is closed
    if (pool.status === "closed") {
      return next(
        new ErrorHandler("Cannot add transactions to a closed pool", 400),
      );
    }

    // Create transaction
    const poolTx = await PoolTx.create({
      poolId,
      amount,
      type,
      date,
      remarks,
      addedBy: userId,
      verified: false,
    });

    // Update pool's lastTransaction
    await Pool.findByIdAndUpdate(poolId, {
      lastTransaction: {
        amount,
        date,
        remark: remarks || "",
        addedBy: userId,
      },
    });

    // Send bulk push notifications to all other members
    const otherMembers = pool.members.filter(
      (member) => member.toString() !== userId,
    );

    const senderName = await User.findById(userId).select("name").lean();

    const notifications = otherMembers.map((memberId) => ({
      userId: memberId.toString(),
      title: `Pool: ${pool.name}`,
      body: `${senderName?.name} added ₹${amount} (${type})`,
      data: {
        type: "pool_tx_added",
        senderId: userId,
        poolId,
        txnId: poolTx._id.toString(),
      },
    }));

    if (notifications.length > 0) {
      await sendBulkPushNotifications(notifications);
    }

    return res.status(201).json({
      success: true,
      message: "Transaction added successfully",
      poolTx,
    });
  },
);

// Get pool transactions with pagination
export const getPoolTxns = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const limit = parseInt(req.query.limit as string) || 20;
    const year = req.query.year
      ? parseInt(req.query.year as string)
      : undefined;
    const month = req.query.month
      ? parseInt(req.query.month as string)
      : undefined;
    const userId = req.user.id;

    // Verify membership
    const pool = await Pool.findById(poolId);
    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    const isMember = pool.members.some(
      (member) => member.toString() === userId,
    );

    if (!isMember) {
      return next(new ErrorHandler("Access denied", 403));
    }

    // Build query
    const query: any = { poolId };

    if (cursor) {
      query.date = { $lt: new Date(cursor) };
    }

    if (year !== undefined && month !== undefined) {
      const startDate = new Date(year, month - 1, 1);
      const endDate = new Date(year, month, 0, 23, 59, 59);
      query.date = { ...query.date, $gte: startDate, $lte: endDate };
    }

    // Fetch with pagination
    const poolTxns = await PoolTx.find(query)
      .sort({ date: -1 })
      .limit(limit + 1)
      .populate("addedBy", "name avatar")
      .populate("verifiedBy", "name avatar")
      .lean();

    const hasMore = poolTxns.length > limit;
    if (hasMore) poolTxns.pop();

    const nextCursor =
      hasMore && poolTxns.length > 0
        ? poolTxns[poolTxns.length - 1].date.toISOString()
        : null;

    return res.status(200).json({
      success: true,
      poolTxns,
      nextCursor,
      hasMore,
    });
  },
);

// Edit pool transaction
export const editPoolTx = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.params;
    const userId = req.user.id;
    const { amount, type, date, remarks } = req.body;

    const poolTx = await PoolTx.findById(txnId);

    if (!poolTx) {
      return next(new ErrorHandler("Transaction not found", 404));
    }

    // Only the person who added can edit
    if (poolTx.addedBy.toString() !== userId) {
      return next(
        new ErrorHandler("You can only edit transactions you added", 403),
      );
    }

    // Cannot edit verified transactions
    if (poolTx.verified) {
      return next(new ErrorHandler("Cannot edit verified transactions", 400));
    }

    // Validate date is in current month
    const txDate = poolTx.date;
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    if (txDate < currentMonthStart) {
      return next(
        new ErrorHandler("Cannot edit transactions from past months", 400),
      );
    }

    // Update fields
    if (amount !== undefined) poolTx.amount = amount;
    if (type !== undefined) poolTx.type = type;
    if (date !== undefined) poolTx.date = new Date(date);
    if (remarks !== undefined) poolTx.remarks = remarks;

    await poolTx.save();

    // Update pool's lastTransaction if this was the latest
    const latestTx = await PoolTx.findOne({ poolId: poolTx.poolId })
      .sort({ date: -1 })
      .lean();

    if (latestTx && latestTx._id.toString() === txnId) {
      await Pool.findByIdAndUpdate(poolTx.poolId, {
        lastTransaction: {
          amount: poolTx.amount,
          date: poolTx.date,
          remark: poolTx.remarks || "",
          addedBy: poolTx.addedBy,
        },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Transaction updated successfully",
      poolTx,
    });
  },
);

// Delete pool transaction
export const deletePoolTx = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.params;
    const userId = req.user.id;

    const poolTx = await PoolTx.findById(txnId);

    if (!poolTx) {
      return next(new ErrorHandler("Transaction not found", 404));
    }

    // Only the person who added can delete
    if (poolTx.addedBy.toString() !== userId) {
      return next(
        new ErrorHandler("You can only delete transactions you added", 403),
      );
    }

    // Cannot delete verified transactions
    if (poolTx.verified) {
      return next(new ErrorHandler("Cannot delete verified transactions", 400));
    }

    // Validate date is in current month
    const txDate = poolTx.date;
    const now = new Date();
    const currentMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    if (txDate < currentMonthStart) {
      return next(
        new ErrorHandler("Cannot delete transactions from past months", 400),
      );
    }

    const poolId = poolTx.poolId;

    await PoolTx.findByIdAndDelete(txnId);

    // Recalculate pool's lastTransaction
    const latestTx = await PoolTx.findOne({ poolId }).sort({ date: -1 }).lean();

    if (latestTx) {
      await Pool.findByIdAndUpdate(poolId, {
        lastTransaction: {
          amount: latestTx.amount,
          date: latestTx.date,
          remark: latestTx.remarks || "",
          addedBy: latestTx.addedBy,
        },
      });
    } else {
      await Pool.findByIdAndUpdate(poolId, {
        $unset: { lastTransaction: "" },
      });
    }

    return res.status(200).json({
      success: true,
      message: "Transaction deleted successfully",
    });
  },
);

// Verify pool transaction
export const verifyPoolTx = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { txnId } = req.body;
    const userId = req.user.id;

    const poolTx = await PoolTx.findById(txnId);

    if (!poolTx) {
      return next(new ErrorHandler("Transaction not found", 404));
    }

    // Cannot verify own transaction
    if (poolTx.addedBy.toString() === userId) {
      return next(
        new ErrorHandler("You cannot verify your own transaction", 400),
      );
    }

    // Check if already verified
    if (poolTx.verified) {
      return next(new ErrorHandler("Transaction already verified", 400));
    }

    // Verify membership
    const pool = await Pool.findById(poolTx.poolId);
    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    const isMember = pool.members.some(
      (member) => member.toString() === userId,
    );

    if (!isMember) {
      return next(
        new ErrorHandler("Only pool members can verify transactions", 403),
      );
    }

    // Verify transaction
    poolTx.verified = true;
    poolTx.verifiedBy = new mongoose.Types.ObjectId(userId);
    poolTx.verifiedAt = new Date();
    await poolTx.save();

    // Send push notification to transaction adder
    const verifierName = await User.findById(userId).select("name").lean();
    await sendPushNotification(
      poolTx.addedBy.toString(),
      `Pool: ${pool.name}`,
      `${verifierName?.name} verified your ₹${poolTx.amount} entry`,
      {
        type: "pool_tx_verified",
        senderId: userId,
        txnId: txnId,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Transaction verified successfully",
      poolTx,
    });
  },
);

// Get pool statistics
export const getPoolStats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { poolId } = req.params;
    const userId = req.user.id;

    const pool = await Pool.findById(poolId).populate("members", "name").lean();

    if (!pool) {
      return next(new ErrorHandler("Pool not found", 404));
    }

    // Check membership
    const isMember = pool.members.some(
      (member: any) => member._id.toString() === userId,
    );

    if (!isMember) {
      return next(new ErrorHandler("Access denied", 403));
    }

    // Aggregate statistics
    const transactions = await PoolTx.find({ poolId }).lean();

    const totalCredited = transactions
      .filter((tx) => tx.type === "credit")
      .reduce((sum, tx) => sum + tx.amount, 0);

    const totalDebited = transactions
      .filter((tx) => tx.type === "debit")
      .reduce((sum, tx) => sum + tx.amount, 0);

    const netBalance = totalCredited - totalDebited;

    // Calculate duration
    const createdAt = new Date(pool.createdAt);
    const now = new Date();
    const durationDays = Math.floor(
      (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Per-member breakdown
    const memberBreakdown: any[] = [];

    for (const member of pool.members as any[]) {
      const memberTxns = transactions.filter(
        (tx) => tx.addedBy.toString() === member._id.toString(),
      );

      const credited = memberTxns
        .filter((tx) => tx.type === "credit")
        .reduce((sum, tx) => sum + tx.amount, 0);

      const debited = memberTxns
        .filter((tx) => tx.type === "debit")
        .reduce((sum, tx) => sum + tx.amount, 0);

      memberBreakdown.push({
        userId: member._id,
        name: member.name,
        totalCredited: credited,
        totalDebited: debited,
        net: credited - debited,
      });
    }

    return res.status(200).json({
      success: true,
      stats: {
        totalCredited,
        totalDebited,
        netBalance,
        durationDays,
        memberBreakdown,
      },
    });
  },
);
