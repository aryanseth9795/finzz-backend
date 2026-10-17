import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import TryCatch from "../utils/TryCatch.js";
import { Expense } from "../models/expenseModel.js";
import { ExpenseLedger } from "../models/expenseLedgerModel.js";
import { User } from "../models/userModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import {
  periodOf,
  parseTzOffset,
  isPastPeriod,
  monthRangeUtc,
  daysInMonth,
} from "../utils/dates.js";
import { expenseCategoryOf } from "../services/expenseReport/category.js";
import { renderExpenseReportHtml } from "../services/expenseReport/template.js";
import { decodeCursor, cursorFilter, paginate } from "../utils/cursor.js";

// ==========================================
// Helper: Get or create current month's ledger
// ==========================================
async function getOrCreateLedger(
  userId: string,
  date: Date,
  tzOffsetMinutes = 0,
  session?: mongoose.ClientSession,
) {
  // Period is derived in the USER's calendar frame, not the server's. See
  // utils/dates.ts for why this was silently misfiling month-boundary rows.
  const { year, month } = periodOf(date, tzOffsetMinutes);

  /**
   * Upsert atomically instead of find-then-create. The previous read/write pair
   * had a TOCTOU window: two concurrent expense submissions on the 1st of the
   * month both found no ledger and both created one, producing duplicate
   * ledgers for the same period with the totals split between them.
   */
  const ledger = await ExpenseLedger.findOneAndUpdate(
    { userId, year, month },
    {
      $setOnInsert: {
        userId,
        year,
        month,
        status: "open",
        totalExpenses: 0,
        totalCredits: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, session },
  );

  return ledger;
}

// ==========================================
// Add Expense
// ==========================================
export const addExpense = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // `amount` is a validated, coerced, rounded number by the time it arrives
    // (addExpenseSchema). It used to be the raw body value with no schema on
    // the route at all, which is how `ledger.totalExpenses += amount` came to
    // evaluate `50 + "100"` as the string "50100".
    const { amount, date, remarks, category, type } = req.body;
    const userId = req.user.id;
    const tzOffset = parseTzOffset(req.body.tzOffsetMinutes);

    const expenseType = type === "credit" ? "credit" : "debit";
    const expenseDate = new Date(date);

    let expense;

    /**
     * The expense row and the ledger total are one fact recorded in two places,
     * so they are written in one transaction. Previously a failure after
     * `Expense.create` but before `ledger.save()` left an expense that no total
     * accounted for — the ledger silently under-reported for ever.
     */
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const ledger = await getOrCreateLedger(
          userId,
          expenseDate,
          tzOffset,
          session,
        );

        if (ledger.status === "closed") {
          throw new ErrorHandler(
            "Cannot add expenses to a closed ledger period",
            400,
          );
        }

        const created = await Expense.create(
          [
            {
              userId,
              ledgerId: ledger._id,
              amount,
              type: expenseType,
              date: expenseDate,
              remarks,
              category,
            },
          ],
          { session },
        );
        expense = created[0];

        /**
         * `$inc` rather than read-modify-write.
         *
         * `ledger.totalExpenses += amount; await ledger.save()` reads a value
         * into the application, adds to it, and writes it back. Two concurrent
         * expenses both read the same starting total and the second write
         * overwrites the first — a classic lost update, and in a ledger that
         * means money silently disappearing from the total.
         *
         * `$inc` performs the addition inside the database, where it is atomic
         * per document. It is also one round trip instead of two.
         */
        await ExpenseLedger.updateOne(
          { _id: ledger._id },
          {
            $inc:
              expenseType === "credit"
                ? { totalCredits: amount }
                : { totalExpenses: amount },
          },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    return res.status(201).json({
      success: true,
      message: "Expense added successfully",
      expense,
    });
  },
);

// ==========================================
// Get Expenses (with cursor-based pagination)
// ==========================================
export const getExpenses = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    // Coerced and bounded by getExpensesSchema; `limit` can no longer be NaN
    // (`parseInt("abc")`) or an unbounded number chosen by the caller.
    const { ledgerId, cursor, limit } = req.query as unknown as {
      ledgerId?: string;
      cursor?: string;
      limit: number;
    };

    const query: Record<string, unknown> = { userId };
    if (ledgerId) query.ledgerId = ledgerId;

    // Compound keyset cursor. The previous `{ date: { $lt: cursor } }` dropped
    // every same-day row after the first on each page boundary.
    Object.assign(query, cursorFilter(decodeCursor(cursor)));

    const rows = await Expense.find(query)
      // `_id` must be in the sort for the tie-break in cursorFilter to be
      // meaningful — a sort key the cursor references but the query does not
      // order by gives no stable ordering to page through.
      .sort({ date: -1, _id: -1 })
      .limit(limit + 1)
      .lean<{ _id: unknown; date: Date }[]>();

    const { items, nextCursor, hasMore } = paginate(rows, limit);

    return res.status(200).json({
      success: true,
      expenses: items,
      nextCursor,
      hasMore,
    });
  },
);

// ==========================================
// Edit Expense
// ==========================================
export const editExpense = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const userId = req.user.id;
    const { amount, date, remarks, category, type } = req.body;

    const expense = await Expense.findById(id);

    if (!expense) {
      return next(new ErrorHandler("Expense not found", 404));
    }

    if (expense.userId.toString() !== userId) {
      return next(new ErrorHandler("You can only edit your own expenses", 403));
    }

    // Check if ledger is closed
    const ledger = await ExpenseLedger.findById(expense.ledgerId);
    if (!ledger) {
      return next(new ErrorHandler("Ledger not found", 404));
    }

    if (ledger.status === "closed") {
      return next(
        new ErrorHandler("Cannot edit expenses in a closed ledger", 400),
      );
    }

    const oldAmount = expense.amount;
    const oldType = expense.type || "debit";
    const tzOffset = parseTzOffset(req.body.tzOffsetMinutes);

    /**
     * Reversal and re-application of ledger totals now happen atomically, and
     * a date change moves the expense to the ledger it actually belongs to.
     *
     * Two bugs are fixed here:
     *
     *  1. Read-modify-write on the ledger totals (same lost-update race as
     *     addExpense) — replaced with `$inc` deltas.
     *  2. Changing an expense's date left `ledgerId` pointing at the OLD
     *     month. The row then appeared under a month it was no longer dated
     *     to, and both months' totals were wrong: the old kept the amount, the
     *     new never received it.
     */
    const newAmount = amount !== undefined ? amount : oldAmount;
    const newType = type !== undefined ? type : oldType;
    const newDate = date !== undefined ? new Date(date) : expense.date;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Which ledger should own the row after the edit?
        const targetLedger =
          date !== undefined
            ? await getOrCreateLedger(userId, newDate, tzOffset, session)
            : ledger;

        if (targetLedger.status === "closed") {
          throw new ErrorHandler(
            "Cannot move an expense into a closed ledger",
            400,
          );
        }

        // Remove the old contribution from the ledger that currently holds it.
        await ExpenseLedger.updateOne(
          { _id: ledger._id },
          {
            $inc:
              oldType === "credit"
                ? { totalCredits: -oldAmount }
                : { totalExpenses: -oldAmount },
          },
          { session },
        );

        // Add the new contribution to whichever ledger now owns the row.
        await ExpenseLedger.updateOne(
          { _id: targetLedger._id },
          {
            $inc:
              newType === "credit"
                ? { totalCredits: newAmount }
                : { totalExpenses: newAmount },
          },
          { session },
        );

        expense.amount = newAmount;
        expense.type = newType;
        expense.date = newDate;
        expense.ledgerId = targetLedger._id;
        if (remarks !== undefined) expense.remarks = remarks;
        if (category !== undefined) expense.category = category;

        await expense.save({ session });
      });
    } finally {
      await session.endSession();
    }

    return res.status(200).json({
      success: true,
      message: "Expense updated successfully",
      expense,
    });
  },
);

// ==========================================
// Delete Expense
// ==========================================
export const deleteExpense = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { id } = req.params;
    const userId = req.user.id;

    const expense = await Expense.findById(id);

    if (!expense) {
      return next(new ErrorHandler("Expense not found", 404));
    }

    if (expense.userId.toString() !== userId) {
      return next(
        new ErrorHandler("You can only delete your own expenses", 403),
      );
    }

    // Check if ledger is closed
    const ledger = await ExpenseLedger.findById(expense.ledgerId);
    if (!ledger) {
      return next(new ErrorHandler("Ledger not found", 404));
    }

    if (ledger.status === "closed") {
      return next(
        new ErrorHandler("Cannot delete expenses from a closed ledger", 400),
      );
    }

    // Atomic decrement + delete in one transaction. Previously the ledger was
    // decremented first and the expense deleted second, so a failure between
    // them left the row present but no longer counted in the total.
    const expenseType = expense.type || "debit";
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await ExpenseLedger.updateOne(
          { _id: ledger._id },
          {
            $inc:
              expenseType === "credit"
                ? { totalCredits: -expense.amount }
                : { totalExpenses: -expense.amount },
          },
          { session },
        );
        await expense.deleteOne({ session });
      });
    } finally {
      await session.endSession();
    }

    return res.status(200).json({
      success: true,
      message: "Expense deleted successfully",
    });
  },
);

// ==========================================
// Get Stats
// ==========================================
export const getStats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { period = "monthly" } = req.query;

    // Convert userId string to ObjectId for aggregation
    const userObjectId = new mongoose.Types.ObjectId(userId);

    let stats: any = {};

    if (period === "daily") {
      // Group by day for last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const dailyStats = await Expense.aggregate([
        {
          $match: {
            userId: userObjectId,
            date: { $gte: thirtyDaysAgo },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$date" },
            },
            debitTotal: {
              $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
            },
            creditTotal: {
              $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
            },
            debitCount: {
              $sum: { $cond: [{ $eq: ["$type", "debit"] }, 1, 0] },
            },
            creditCount: {
              $sum: { $cond: [{ $eq: ["$type", "credit"] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: -1 } },
      ]);

      stats.daily = dailyStats.map((d) => ({
        date: d._id,
        debitTotal: d.debitTotal,
        creditTotal: d.creditTotal,
        debitCount: d.debitCount,
        creditCount: d.creditCount,
        net: d.creditTotal - d.debitTotal,
      }));
    }

    if (period === "monthly" || !period) {
      // Group by month
      const monthlyStats = await Expense.aggregate([
        { $match: { userId: userObjectId } },
        {
          $group: {
            _id: {
              year: { $year: "$date" },
              month: { $month: "$date" },
            },
            debitTotal: {
              $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
            },
            creditTotal: {
              $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
            },
            debitCount: {
              $sum: { $cond: [{ $eq: ["$type", "debit"] }, 1, 0] },
            },
            creditCount: {
              $sum: { $cond: [{ $eq: ["$type", "credit"] }, 1, 0] },
            },
          },
        },
        { $sort: { "_id.year": -1, "_id.month": -1 } },
      ]);

      stats.monthly = monthlyStats.map((m) => ({
        month: `${m._id.year}-${String(m._id.month).padStart(2, "0")}`,
        debitTotal: m.debitTotal,
        creditTotal: m.creditTotal,
        debitCount: m.debitCount,
        creditCount: m.creditCount,
        net: m.creditTotal - m.debitTotal,
      }));
    }

    if (period === "yearly") {
      // Group by year
      const yearlyStats = await Expense.aggregate([
        { $match: { userId: userObjectId } },
        {
          $group: {
            _id: { $year: "$date" },
            debitTotal: {
              $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
            },
            creditTotal: {
              $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
            },
            debitCount: {
              $sum: { $cond: [{ $eq: ["$type", "debit"] }, 1, 0] },
            },
            creditCount: {
              $sum: { $cond: [{ $eq: ["$type", "credit"] }, 1, 0] },
            },
          },
        },
        { $sort: { _id: -1 } },
      ]);

      stats.yearly = yearlyStats.map((y) => ({
        year: y._id,
        debitTotal: y.debitTotal,
        creditTotal: y.creditTotal,
        debitCount: y.debitCount,
        creditCount: y.creditCount,
        net: y.creditTotal - y.debitTotal,
      }));
    }

    const grandTotal = await Expense.aggregate([
      { $match: { userId: userObjectId } },
      {
        $group: {
          _id: null,
          debits: {
            $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
          },
          credits: {
            $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
          },
        },
      },
    ]);

    stats.grandTotals =
      grandTotal.length > 0
        ? {
            debits: grandTotal[0].debits || 0,
            credits: grandTotal[0].credits || 0,
            net: (grandTotal[0].credits || 0) - (grandTotal[0].debits || 0),
          }
        : {
            debits: 0,
            credits: 0,
            net: 0,
          };

    return res.status(200).json({
      success: true,
      stats,
    });
  },
);

// ==========================================
// Get Advanced Stats (Charts & Analytics)
// ==========================================
/** "+05:30" / "-03:30" — the form Mongo's $dateToString `timezone` accepts. */
const tzString = (tzOffsetMinutes: number): string => {
  const sign = tzOffsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(tzOffsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export const getAdvancedStats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    // Express 5: req.query is a getter, so validate() cannot write coerced
    // values back. Read the raw values and coerce here.
    const tz = parseTzOffset(req.query.tzOffsetMinutes);
    const tzName = tzString(tz);

    // Requested month/year default to the current period in the USER's frame.
    const current = periodOf(new Date(), tz);
    const rawYear = Number(req.query.year);
    const rawMonth = Number(req.query.month);
    const year =
      Number.isInteger(rawYear) && rawYear >= 2000 && rawYear <= 2100
        ? rawYear
        : current.year;
    const month =
      Number.isInteger(rawMonth) && rawMonth >= 1 && rawMonth <= 12
        ? rawMonth
        : current.month;

    const selectedLedger = await ExpenseLedger.findOne({
      userId,
      year,
      month,
    })
      .select("_id year month status")
      .lean<{ _id: mongoose.Types.ObjectId; year: number; month: number; status: string } | null>();

    const { start: startOfMonth, end: endOfMonth } = monthRangeUtc(
      year,
      month,
      tz,
    );

    // ── 1. Monthly Trend (12 months before the requested month + itself) ──
    const twelveMonthsAgo = monthRangeUtc(year, month - 12, tz).start;
    const monthlyTrend = await Expense.aggregate([
      {
        $match: {
          userId: userObjectId,
          date: { $gte: twelveMonthsAgo, $lt: endOfMonth },
        },
      },
      {
        $group: {
          _id: {
            year: { $year: { date: "$date", timezone: tzName } },
            month: { $month: { date: "$date", timezone: tzName } },
          },
          debitTotal: {
            $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
          },
          creditTotal: {
            $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
          },
          debitCount: {
            $sum: { $cond: [{ $eq: ["$type", "debit"] }, 1, 0] },
          },
          creditCount: {
            $sum: { $cond: [{ $eq: ["$type", "credit"] }, 1, 0] },
          },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    // ── 2. Daily Breakdown for selected month (user's local calendar day) ──
    const dailyBreakdown = await Expense.aggregate([
      {
        $match: {
          userId: userObjectId,
          date: { $gte: startOfMonth, $lt: endOfMonth },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$date",
              timezone: tzName,
            },
          },
          debitTotal: {
            $sum: { $cond: [{ $eq: ["$type", "debit"] }, "$amount", 0] },
          },
          creditTotal: {
            $sum: { $cond: [{ $eq: ["$type", "credit"] }, "$amount", 0] },
          },
          debitCount: {
            $sum: { $cond: [{ $eq: ["$type", "debit"] }, 1, 0] },
          },
          creditCount: {
            $sum: { $cond: [{ $eq: ["$type", "credit"] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // ── 3. Remarks/Category Breakdown for selected month ──
    // One query covers the selected month and the 2 before it (categoryTrend).
    const trendMonths = [2, 1, 0].map((back) => {
      const idx = year * 12 + (month - 1) - back;
      return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
    });
    const trendStart = monthRangeUtc(
      trendMonths[0].year,
      trendMonths[0].month,
      tz,
    ).start;
    const threeMonthExpenses = await Expense.find({
      userId: userObjectId,
      date: { $gte: trendStart, $lt: endOfMonth },
    }).lean();

    const allMonthExpenses = threeMonthExpenses.filter(
      (exp) => exp.date >= startOfMonth && exp.date < endOfMonth,
    );
    const debitExpenses = allMonthExpenses.filter((exp) => exp.type === "debit");
    const creditExpenses = allMonthExpenses.filter(
      (exp) => exp.type === "credit",
    );

    const categoryMap: Record<string, { total: number; count: number }> = {};
    let debitMonthTotal = 0;

    for (const exp of debitExpenses) {
      debitMonthTotal += exp.amount;
      const label = expenseCategoryOf(exp);
      if (!categoryMap[label]) categoryMap[label] = { total: 0, count: 0 };
      categoryMap[label].total += exp.amount;
      categoryMap[label].count += 1;
    }

    const categoryBreakdown = Object.entries(categoryMap)
      .map(([name, { total, count }]) => ({
        name,
        total: Math.round(total * 100) / 100,
        count,
        percentage:
          debitMonthTotal > 0
            ? Math.round((total / debitMonthTotal) * 100 * 10) / 10
            : 0,
      }))
      .sort((a, b) => b.total - a.total);

    // ── 3b. Category trend: top 6 categories x last 3 months (zero-filled) ──
    const monthKeys = trendMonths.map(
      (m) => `${m.year}-${String(m.month).padStart(2, "0")}`,
    );
    const trendTotals: Record<string, Record<string, number>> = {};
    for (const exp of threeMonthExpenses) {
      if (exp.type !== "debit") continue;
      const p = periodOf(exp.date, tz);
      const key = `${p.year}-${String(p.month).padStart(2, "0")}`;
      if (!monthKeys.includes(key)) continue;
      const label = expenseCategoryOf(exp);
      const byMonth = (trendTotals[label] ??= {});
      byMonth[key] = (byMonth[key] ?? 0) + exp.amount;
    }
    const categoryTrend = categoryBreakdown.slice(0, 6).map((c) => ({
      name: c.name,
      months: monthKeys.map((key) => ({
        month: key,
        total: round2(trendTotals[c.name]?.[key] ?? 0),
      })),
    }));

    // ── 4. Top 5 Expenses for selected month ──
    const top5 = [...debitExpenses]
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 5)
      .map((e) => ({
        _id: e._id,
        amount: e.amount,
        date: e.date,
        remarks: e.remarks || "",
        category: e.category || "",
        type: e.type,
      }));

    // ── 5. Summary for selected month ──
    const totalDebits = debitExpenses.reduce((sum, exp) => sum + exp.amount, 0);
    const totalCredits = creditExpenses.reduce(
      (sum, exp) => sum + exp.amount,
      0,
    );
    const net = totalCredits - totalDebits;
    const monthDays = daysInMonth(year, month);
    const activeDays = dailyBreakdown.length;
    const avgDailyDebit = totalDebits > 0 ? totalDebits / monthDays : 0;
    const avgDailyCredit = totalCredits > 0 ? totalCredits / monthDays : 0;

    return res.status(200).json({
      success: true,
      data: {
        selectedLedger: selectedLedger
          ? {
              _id: selectedLedger._id.toString(),
              year: selectedLedger.year,
              month: selectedLedger.month,
              status: selectedLedger.status,
            }
          : null,
        selectedMonth: { year, month },
        summary: {
          totalDebits: Math.round(totalDebits * 100) / 100,
          totalCredits: Math.round(totalCredits * 100) / 100,
          net: Math.round(net * 100) / 100,
          debitCount: debitExpenses.length,
          creditCount: creditExpenses.length,
          avgDailyDebit: Math.round(avgDailyDebit * 100) / 100,
          avgDailyCredit: Math.round(avgDailyCredit * 100) / 100,
          activeDays,
        },
        monthlyTrend: monthlyTrend.map((m) => ({
          month: `${m._id.year}-${String(m._id.month).padStart(2, "0")}`,
          year: m._id.year,
          monthNum: m._id.month,
          debitTotal: Math.round(m.debitTotal * 100) / 100,
          creditTotal: Math.round(m.creditTotal * 100) / 100,
          debitCount: m.debitCount,
          creditCount: m.creditCount,
          net: Math.round((m.creditTotal - m.debitTotal) * 100) / 100,
        })),
        dailyBreakdown: dailyBreakdown.map((d) => ({
          date: d._id,
          debitTotal: Math.round(d.debitTotal * 100) / 100,
          creditTotal: Math.round(d.creditTotal * 100) / 100,
          debitCount: d.debitCount,
          creditCount: d.creditCount,
          net: Math.round((d.creditTotal - d.debitTotal) * 100) / 100,
        })),
        categoryBreakdown,
        categoryTrend,
        top5Expenses: top5,
      },
    });
  },
);

// ==========================================
// Get Ledgers
// ==========================================
export const getLedgers = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const { year, month } = req.query;

  // Proactively get or create the ledger for the requested/current month
  let targetYear: number, targetMonth: number;

  if (year && month) {
    targetYear = parseInt(year as string);
    targetMonth = parseInt(month as string);
  } else {
    const now = new Date();
    targetYear = now.getFullYear();
    targetMonth = now.getMonth() + 1;
  }

  // Use a pseudo-date to pass to the existing helper, or just recreate the logic
  const pseudoDate = new Date(targetYear, targetMonth - 1, 1);
  await getOrCreateLedger(userId, pseudoDate);

  const ledgers = await ExpenseLedger.find({ userId })
    .sort({ year: -1, month: -1 })
    .lean();

  return res.status(200).json({
    success: true,
    ledgers,
  });
});

// ==========================================
// Close Ledger
// ==========================================
export const closeLedger = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    // Coerced to numbers by closeLedgerSchema.
    const { year, month } = req.body as { year: number; month: number };
    const tzOffset = parseTzOffset(req.body.tzOffsetMinutes);

    /**
     * The guard that stops a user permanently locking their own current month.
     *
     * Previously: `if (year > currentYear || (year === currentYear && month >=
     * currentMonth))`. `year` came off `req.body` with no schema on the route,
     * so a client sending `"2026"` made `year === currentYear` false — the
     * guard passed and the CURRENT ledger was closed. There is no reopen
     * endpoint, so the user was locked out of recording anything for the rest
     * of the month, with no recovery path.
     *
     * Two changes make this sound: the schema coerces to a number, and the
     * comparison is a single ordering test on `year * 12 + month`.
     */
    if (!isPastPeriod(year, month, tzOffset)) {
      return next(
        new ErrorHandler("Can only close ledgers for past months", 400),
      );
    }

    // Conditional update: the status transition and the guard are one atomic
    // operation, so two concurrent close requests cannot both succeed.
    const ledger = await ExpenseLedger.findOneAndUpdate(
      { userId, year, month, status: "open" },
      { $set: { status: "closed", closedAt: new Date() } },
      { new: true },
    );

    if (!ledger) {
      const existing = await ExpenseLedger.findOne({ userId, year, month })
        .select("status")
        .lean<{ status: string }>();
      return next(
        existing
          ? new ErrorHandler("Ledger is already closed", 400)
          : new ErrorHandler("Ledger not found", 404),
      );
    }

    return res.status(200).json({
      success: true,
      message: "Ledger closed successfully",
      ledger,
    });
  },
);

// ==========================================
// Check for Duplicates
// ==========================================
export const checkDuplicate = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { amount, date } = req.query;

    if (!amount || !date) {
      return next(new ErrorHandler("Amount and date are required", 400));
    }

    const expenseDate = new Date(date as string);
    // Start of day
    const startOfDay = new Date(expenseDate);
    startOfDay.setHours(0, 0, 0, 0);
    // End of day
    const endOfDay = new Date(expenseDate);
    endOfDay.setHours(23, 59, 59, 999);

    const duplicates = await Expense.find({
      userId,
      amount: Number(amount),
      date: { $gte: startOfDay, $lte: endOfDay },
    }).select("amount date remarks category");

    return res.status(200).json({
      success: true,
      duplicates,
    });
  },
);

/**
 * Build the plain data object for the expense report from a ledger and its
 * expenses. All day bucketing is in the USER's calendar (tzOffsetMinutes), never
 * the server's, and all percentages are of the debit sum (not the ledger's
 * stored total, which can drift).
 */
function buildExpenseExportHtml({
  ledger,
  user,
  expenses,
  tzOffsetMinutes,
}: {
  ledger: {
    year: number;
    month: number;
    status: "open" | "closed";
  };
  user: { name: string };
  expenses: any[];
  tzOffsetMinutes: number;
}) {
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  // User-local "YYYY-MM-DD" of an instant.
  const localDay = (d: Date) =>
    new Date(d.getTime() + tzOffsetMinutes * 60_000).toISOString().slice(0, 10);

  const { start, end } = monthRangeUtc(ledger.year, ledger.month, tzOffsetMinutes);
  const daysInThisMonth = daysInMonth(ledger.year, ledger.month);

  const txs = expenses.map((e) => ({
    day: localDay(new Date(e.date)),
    inMonth: new Date(e.date) >= start && new Date(e.date) < end,
    remarks: (e.remarks as string) || "",
    category: expenseCategoryOf(e),
    amount: Number(e.amount) || 0,
    type: (e.type === "credit" ? "credit" : "debit") as "debit" | "credit",
  }));
  const debits = txs.filter((t) => t.type === "debit");
  const credits = txs.filter((t) => t.type === "credit");

  const spent = round2(debits.reduce((s, t) => s + t.amount, 0));
  const received = round2(credits.reduce((s, t) => s + t.amount, 0));
  const net = round2(received - spent);
  const activeDays = new Set(debits.map((t) => t.day)).size;

  const catMap = new Map<string, { total: number; count: number }>();
  for (const t of debits) {
    const c = catMap.get(t.category) ?? { total: 0, count: 0 };
    c.total += t.amount;
    c.count += 1;
    catMap.set(t.category, c);
  }
  const pctOf = (v: number) =>
    spent > 0 ? Math.round((v / spent) * 1000) / 10 : 0;
  const categories = [...catMap.entries()]
    .map(([name, { total, count }]) => ({
      name,
      total: round2(total),
      count,
      pct: pctOf(total),
    }))
    .sort((a, b) => b.total - a.total);

  const top = [...debits]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((t) => ({
      label: t.remarks || t.category,
      category: t.category,
      day: t.day,
      amount: t.amount,
      pct: pctOf(t.amount),
    }));

  const daily = Array.from({ length: daysInThisMonth }, (_, i) => ({
    day: i + 1,
    debit: 0,
    credit: 0,
  }));
  for (const t of txs) {
    if (!t.inMonth) continue;
    const slot = daily[Number(t.day.slice(8, 10)) - 1];
    if (!slot) continue;
    if (t.type === "debit") slot.debit += t.amount;
    else slot.credit += t.amount;
  }

  return renderExpenseReportHtml({
    userName: user.name,
    period: {
      year: ledger.year,
      month: ledger.month,
      label: `${MONTH_NAMES[ledger.month - 1]} ${ledger.year}`,
      daysInMonth: daysInThisMonth,
      tzOffsetMinutes,
    },
    status: ledger.status,
    generatedAtUtc: new Date().toISOString(),
    totals: {
      spent,
      received,
      net,
      savingsRate: received > 0 ? Math.round((net / received) * 1000) / 10 : null,
      activeDays,
      avgPerActiveDay: activeDays > 0 ? round2(spent / activeDays) : 0,
      txCount: txs.length,
    },
    categories,
    top,
    daily,
    transactions: txs.map(({ inMonth: _inMonth, ...t }) => t),
  });
}

// ==========================================
// Export PDF (HTML for client-side rendering)
// ==========================================
export const exportPDF = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { ledgerId } = req.query;

    if (!ledgerId) {
      return next(new ErrorHandler("Ledger ID is required", 400));
    }

    const ledger = await ExpenseLedger.findById(ledgerId);

    if (!ledger) {
      return next(new ErrorHandler("Ledger not found", 404));
    }

    if (ledger.userId.toString() !== userId) {
      return next(new ErrorHandler("Unauthorized", 403));
    }

    const expenses = await Expense.find({ ledgerId }).sort({ date: -1 }).lean();
    // Get user details from DB
    const userDoc = await User.findById(userId).select("name").lean();

    if (!userDoc) {
      return next(new ErrorHandler("User not found", 404));
    }

    // The client sends its offset so days and the footer time are the user's.
    const tzOffsetMinutes = parseTzOffset(req.query.tzOffsetMinutes);

    const html = buildExpenseExportHtml({
      ledger: {
        year: ledger.year,
        month: ledger.month,
        status: ledger.status as "open" | "closed",
      },
      user: { name: (userDoc as any).name || "User" },
      expenses: expenses as any[],
      tzOffsetMinutes,
    });

    return res.status(200).json({
      success: true,
      html,
    });
  },
);
