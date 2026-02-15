import mongoose from "mongoose";
import { MonthlySummary } from "../models/monthlySummaryModel.js";

/**
 * Extract year and month from a Date object
 */
function getYearMonth(date: Date): { year: number; month: number } {
  const d = new Date(date);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

/**
 * Called when a transaction is ADDED.
 * Uses atomic $inc + upsert so there's no read-before-write.
 */
export async function updateSummaryOnAdd(
  chatId: mongoose.Types.ObjectId | string,
  txDate: Date,
  fromUserId: string,
  toUserId: string,
  amount: number,
) {
  const { year, month } = getYearMonth(txDate);

  await MonthlySummary.updateOne(
    { chatId, year, month },
    {
      $inc: {
        [`members.${fromUserId}.totalSent`]: amount,
        [`members.${toUserId}.totalReceived`]: amount,
        txCount: 1,
      },
    },
    { upsert: true },
  );
}

/**
 * Called when a transaction is DELETED.
 * Reverses the effect of the original add.
 */
export async function updateSummaryOnDelete(
  chatId: mongoose.Types.ObjectId | string,
  txDate: Date,
  fromUserId: string,
  toUserId: string,
  amount: number,
) {
  const { year, month } = getYearMonth(txDate);

  await MonthlySummary.updateOne(
    { chatId, year, month },
    {
      $inc: {
        [`members.${fromUserId}.totalSent`]: -amount,
        [`members.${toUserId}.totalReceived`]: -amount,
        txCount: -1,
      },
    },
  );
}

/**
 * Called when a transaction is EDITED.
 * Handles changes to amount, direction (from/to), and even date (month change).
 */
export async function updateSummaryOnEdit(
  chatId: mongoose.Types.ObjectId | string,
  oldTx: {
    date: Date;
    from: string;
    to: string;
    amount: number;
  },
  newTx: {
    date: Date;
    from: string;
    to: string;
    amount: number;
  },
) {
  const oldYM = getYearMonth(oldTx.date);
  const newYM = getYearMonth(newTx.date);

  const sameMonth = oldYM.year === newYM.year && oldYM.month === newYM.month;
  const sameDirection = oldTx.from === newTx.from && oldTx.to === newTx.to;

  if (sameMonth && sameDirection) {
    // Only amount changed — single atomic update with difference
    const diff = newTx.amount - oldTx.amount;
    if (diff !== 0) {
      await MonthlySummary.updateOne(
        { chatId, year: oldYM.year, month: oldYM.month },
        {
          $inc: {
            [`members.${oldTx.from}.totalSent`]: diff,
            [`members.${oldTx.to}.totalReceived`]: diff,
          },
        },
      );
    }
  } else {
    // Month or direction changed — reverse old, apply new
    await updateSummaryOnDelete(
      chatId,
      oldTx.date,
      oldTx.from,
      oldTx.to,
      oldTx.amount,
    );
    await updateSummaryOnAdd(
      chatId,
      newTx.date,
      newTx.from,
      newTx.to,
      newTx.amount,
    );
  }
}

/**
 * Get the carry-forward (opening) balance for a given month.
 * This sums up the net balance of all months BEFORE the given month.
 * Returns per-user net: positive = user has received more (is owed less / owes more)
 */
export async function getCarryForward(
  chatId: mongoose.Types.ObjectId | string,
  year: number,
  month: number,
): Promise<Record<string, number>> {
  // Get all summaries before the given month
  const priorSummaries = await MonthlySummary.find({
    chatId,
    $or: [{ year: { $lt: year } }, { year: year, month: { $lt: month } }],
  })
    .sort({ year: 1, month: 1 })
    .lean();

  // Accumulate per-user net across all prior months
  const netBalances: Record<string, number> = {};

  for (const summary of priorSummaries) {
    const members = summary.members as any;
    if (members) {
      // Handle both Map and plain object
      const entries =
        members instanceof Map
          ? Array.from(members.entries())
          : Object.entries(members);

      for (const [userId, stats] of entries) {
        const s = stats as { totalSent: number; totalReceived: number };
        // net = received - sent (positive means user has received more)
        const monthNet = (s.totalReceived || 0) - (s.totalSent || 0);
        netBalances[userId] = (netBalances[userId] || 0) + monthNet;
      }
    }
  }

  return netBalances;
}
