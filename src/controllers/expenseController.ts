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
} from "../utils/dates.js";
import { escapeHtml, formatCurrency } from "../utils/html.js";
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
export const getAdvancedStats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const userObjectId = new mongoose.Types.ObjectId(userId);

    // Parse requested month/year (defaults to current month)
    const now = new Date();
    const year = parseInt(
      (req.query.year as string) || String(now.getFullYear()),
      10,
    );
    const month = parseInt(
      (req.query.month as string) || String(now.getMonth() + 1),
      10,
    );

    const selectedLedger = await ExpenseLedger.findOne({
      userId,
      year,
      month,
    })
      .select("_id year month status")
      .lean<{ _id: mongoose.Types.ObjectId; year: number; month: number; status: string } | null>();

    // ── 1. Monthly Trend (last 12 months including requested month) ──
    const twelveMonthsAgo = new Date(year, month - 13, 1); // 12 months before requested
    const monthlyTrend = await Expense.aggregate([
      {
        $match: {
          userId: userObjectId,
          date: { $gte: twelveMonthsAgo, $lt: new Date(year, month, 1) },
        },
      },
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
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ]);

    // ── 2. Daily Breakdown for selected month ──
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 1);

    const dailyBreakdown = await Expense.aggregate([
      {
        $match: {
          userId: userObjectId,
          date: { $gte: startOfMonth, $lt: endOfMonth },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
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
    const allMonthExpenses = await Expense.find({
      userId: userObjectId,
      date: { $gte: startOfMonth, $lt: endOfMonth },
    }).lean();

    const debitExpenses = allMonthExpenses.filter((exp) => exp.type === "debit");
    const creditExpenses = allMonthExpenses.filter(
      (exp) => exp.type === "credit",
    );

    const categoryMap: Record<string, { total: number; count: number }> = {};
    let debitMonthTotal = 0;

    for (const exp of debitExpenses) {
      debitMonthTotal += exp.amount;
      let label = "Other";
      if (exp.category && exp.category !== "-") {
        label = exp.category;
      }

      if (exp.remarks) {
        const match = exp.remarks.match(/^#\s*(.+)/);
        if (match) {
          label = match[1].trim();
        }
      }
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
      }));

    // ── 5. Summary for selected month ──
    const totalDebits = debitExpenses.reduce((sum, exp) => sum + exp.amount, 0);
    const totalCredits = creditExpenses.reduce(
      (sum, exp) => sum + exp.amount,
      0,
    );
    const net = totalCredits - totalDebits;
    const daysInMonth = new Date(year, month, 0).getDate();
    const activeDays = dailyBreakdown.length;
    const avgDailyDebit = totalDebits > 0 ? totalDebits / daysInMonth : 0;
    const avgDailyCredit = totalCredits > 0 ? totalCredits / daysInMonth : 0;

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

function buildExpenseExportHtml({
  ledger,
  user,
  debitExpenses,
  creditExpenses,
}: {
  ledger: {
    year: number;
    month: number;
    status: "open" | "closed";
    totalExpenses: number;
    totalCredits: number;
  };
  user: { name: string; phone?: string; email?: string };
  debitExpenses: any[];
  creditExpenses: any[];
}) {
  const allExpenses = [...debitExpenses, ...creditExpenses];
  const net = ledger.totalCredits - ledger.totalExpenses;
  const conclusionLabel = net >= 0 ? "Surplus" : "Deficit";
  const conclusionColor = net >= 0 ? "#16A34A" : "#DC2626";
  const daysInMonth = new Date(ledger.year, ledger.month, 0).getDate();
  const activeDays = new Set(allExpenses.map((e) => new Date(e.date).toDateString())).size;
  const avgDailyDebit = ledger.totalExpenses > 0 && daysInMonth > 0 ? ledger.totalExpenses / daysInMonth : 0;
  const avgDailyCredit = ledger.totalCredits > 0 && daysInMonth > 0 ? ledger.totalCredits / daysInMonth : 0;

  const generatedOn = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
  const periodLabel = new Date(ledger.year, ledger.month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });

  //  Derived analytics ─
  // 1. Category breakdown from debits
  const catMap: Record<string, { total: number; count: number }> = {};
  for (const exp of debitExpenses) {
    let label = exp.category || "Uncategorized";
    if (!label && exp.remarks) {
      const m = exp.remarks.match(/^#\s*(.+)/);
      if (m) label = m[1].trim();
    }
    if (!label) label = "Uncategorized";
    if (!catMap[label]) catMap[label] = { total: 0, count: 0 };
    catMap[label].total += exp.amount;
    catMap[label].count += 1;
  }
  const categories = Object.entries(catMap)
    .map(([name, { total, count }]) => ({
      name,
      total: Math.round(total * 100) / 100,
      count,
      pct: ledger.totalExpenses > 0 ? Math.round((total / ledger.totalExpenses) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.total - a.total);

  // 2. Daily breakdown
  const dailyDebit: Record<string, number> = {};
  const dailyCredit: Record<string, number> = {};
  for (const exp of debitExpenses) {
    const d = new Date(exp.date).getDate();
    dailyDebit[d] = (dailyDebit[d] || 0) + exp.amount;
  }
  for (const exp of creditExpenses) {
    const d = new Date(exp.date).getDate();
    dailyCredit[d] = (dailyCredit[d] || 0) + exp.amount;
  }
  const daysWithData = Array.from(
    new Set([...Object.keys(dailyDebit), ...Object.keys(dailyCredit)].map(Number))
  ).sort((a, b) => a - b);
  const maxDailyAmt = Math.max(
    ...Object.values(dailyDebit),
    ...Object.values(dailyCredit),
    1,
  );

  // 3. Top 5 expenses
  const top5 = [...debitExpenses].sort((a, b) => b.amount - a.amount).slice(0, 5);

  // 4. Comparison bars
  const maxBar = Math.max(ledger.totalCredits, ledger.totalExpenses, 1);
  const creditBarW = Math.round((ledger.totalCredits / maxBar) * 100);
  const debitBarW = Math.round((ledger.totalExpenses / maxBar) * 100);

  //  HTML helpers 
  const catColors = ["#EF4444","#F97316","#EAB308","#8B5CF6","#EC4899","#06B6D4","#10B981","#6366F1"];

  const renderRows = (entries: any[], cls: string) =>
    entries.length > 0
      ? entries.map((exp) => `
        <tr>
          <td>${new Date(exp.date).toLocaleDateString("en-IN")}</td>
          <td>${escapeHtml(exp.remarks || "-")}</td>
          <td>${escapeHtml(exp.category || "-")}</td>
          <td class="amount-cell ${cls}">Rs. ${exp.amount.toFixed(2)}</td>
        </tr>`).join("")
      : `<tr><td colspan="4" class="empty-row">No transactions in this section.</td></tr>`;

  const renderCategoryRows = () =>
    categories.length > 0
      ? categories.map((c, i) => `
        <tr>
          <td>
            <span class="cat-dot" style="background:${catColors[i % catColors.length]};"></span>
            ${c.name}
          </td>
          <td style="text-align:center;">${c.count}</td>
          <td>
            <div class="cat-bar-track">
              <div class="cat-bar-fill" style="width:${c.pct}%;background:${catColors[i % catColors.length]};"></div>
            </div>
          </td>
          <td style="text-align:right;font-weight:700;">${c.pct}%</td>
          <td class="amount-cell debit-text">Rs. ${c.total.toFixed(2)}</td>
        </tr>`).join("")
      : `<tr><td colspan="5" class="empty-row">No category data.</td></tr>`;

  const renderDailyChart = () => {
    if (daysWithData.length === 0) return `<p class="empty-notice">No daily data available.</p>`;
    return daysWithData.map((day) => {
      const d = dailyDebit[day] || 0;
      const c = dailyCredit[day] || 0;
      const dW = Math.round((d / maxDailyAmt) * 100);
      const cW = Math.round((c / maxDailyAmt) * 100);
      return `
        <div class="daily-row">
          <div class="day-label">D${day}</div>
          <div class="day-bars">
            ${d > 0 ? `<div class="day-bar-wrap"><div class="day-bar debit-bar" style="width:${dW}%"></div><span class="day-amt debit-text">Rs.${Math.round(d)}</span></div>` : ""}
            ${c > 0 ? `<div class="day-bar-wrap"><div class="day-bar credit-bar" style="width:${cW}%"></div><span class="day-amt credit-text">Rs.${Math.round(c)}</span></div>` : ""}
          </div>
        </div>`;
    }).join("");
  };

  const renderTop5 = () =>
    top5.length > 0
      ? top5.map((exp, i) => {
          const pct = ledger.totalExpenses > 0 ? Math.round((exp.amount / ledger.totalExpenses) * 100) : 0;
          return `
        <div class="top-item">
          <div class="top-rank">#${i + 1}</div>
          <div class="top-info">
            <div class="top-name">${escapeHtml(exp.remarks || exp.category || "Uncategorized")}</div>
            <div class="top-date">${new Date(exp.date).toLocaleDateString("en-IN")}</div>
            <div class="top-bar-track"><div class="top-bar-fill" style="width:${pct}%;"></div></div>
          </div>
          <div class="top-amount debit-text">Rs. ${exp.amount.toFixed(2)}</div>
        </div>`;
        }).join("")
      : `<p class="empty-notice">No expense transactions this month.</p>`;

  //  Full HTML 
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Finzz Monthly Report - ${periodLabel}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; padding: 28px; background: #f1f5f9; color: #0f172a; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .container { max-width: 900px; margin: 0 auto; background: #ffffff; border-radius: 20px; padding: 32px; box-shadow: 0 16px 48px rgba(15,23,42,0.10); }

    /* Header */
    .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 20px; border-bottom: 3px solid #4F46E5; margin-bottom: 28px; gap: 20px; }
    .logo { font-size: 32px; font-weight: 900; color: #4F46E5; font-style: italic; letter-spacing: -1.5px; }
    .subtitle { margin-top: 8px; color: #475569; font-size: 13px; line-height: 1.7; }
    .user-details { text-align: right; color: #475569; font-size: 13px; line-height: 1.8; }
    .user-details strong { color: #0f172a; font-size: 15px; display: block; margin-bottom: 2px; }

    /* Summary cards */
    .summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 28px; }
    .summary-card { border-radius: 16px; padding: 16px; border: 1px solid #e2e8f0; }
    .summary-card .s-icon { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; font-size: 18px; }
    .summary-card .s-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: #64748b; font-weight: 700; margin-bottom: 4px; }
    .summary-card .s-value { font-size: 20px; font-weight: 900; margin-bottom: 2px; }
    .summary-card .s-sub { font-size: 11px; color: #94a3b8; }
    .card-debit { background: #FEF2F2; border-color: #FECACA; }
    .card-credit { background: #F0FDF4; border-color: #BBF7D0; }
    .card-net { border-color: #e2e8f0; }
    .card-avg { background: #EEF2FF; border-color: #C7D2FE; }

    /* Section headings */
    .section-title { font-size: 17px; font-weight: 800; margin: 28px 0 12px; color: #0f172a; display: flex; align-items: center; gap: 8px; }
    .section-title::after { content: ""; flex: 1; height: 2px; background: #e2e8f0; border-radius: 1px; }
    .section-badge { background: #4F46E5; color: #fff; font-size: 10px; padding: 2px 8px; border-radius: 999px; font-weight: 700; letter-spacing: 0.4px; vertical-align: middle; }

    /* Comparison horizontal bars */
    .compare-section { margin-bottom: 28px; }
    .bar-row { margin-bottom: 14px; }
    .bar-header { display: flex; justify-content: space-between; font-size: 13px; font-weight: 700; margin-bottom: 6px; }
    .bar-track { width: 100%; height: 20px; border-radius: 999px; background: #f1f5f9; overflow: hidden; }
    .bar-fill { height: 100%; border-radius: 999px; }

    /* Category table */
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td { padding: 11px 12px; text-align: left; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
    th { background: #4F46E5; color: #fff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; }
    tr:last-child td { border-bottom: none; }
    tr:nth-child(even) td { background: #f8fafc; }
    .total-row td { font-weight: 800 !important; background: #f1f5f9 !important; border-top: 2px solid #e2e8f0; }
    .amount-cell { text-align: right; font-weight: 700; }
    .credit-text { color: #16A34A; }
    .debit-text { color: #DC2626; }
    .empty-row { text-align: center; color: #94a3b8; font-style: italic; padding: 24px; }
    .empty-notice { color: #94a3b8; font-style: italic; font-size: 13px; margin: 10px 0; }
    .cat-dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 7px; vertical-align: middle; }
    .cat-bar-track { width: 100%; height: 10px; border-radius: 999px; background: #f1f5f9; overflow: hidden; }
    .cat-bar-fill { height: 100%; border-radius: 999px; }

    /* Daily chart */
    .daily-chart { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
    .daily-row { display: flex; align-items: flex-start; gap: 10px; }
    .day-label { font-size: 11px; color: #64748b; font-weight: 700; width: 26px; padding-top: 3px; flex-shrink: 0; }
    .day-bars { flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .day-bar-wrap { display: flex; align-items: center; gap: 8px; }
    .day-bar { height: 14px; border-radius: 999px; min-width: 4px; }
    .debit-bar { background: linear-gradient(90deg, #EF4444, #F87171); }
    .credit-bar { background: linear-gradient(90deg, #22C55E, #4ADE80); }
    .day-amt { font-size: 10px; font-weight: 700; white-space: nowrap; }

    /* Top 5 */
    .top-list { display: flex; flex-direction: column; gap: 14px; margin-top: 8px; }
    .top-item { display: flex; align-items: center; gap: 12px; }
    .top-rank { width: 26px; height: 26px; border-radius: 8px; background: #4F46E5; color: #fff; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .top-info { flex: 1; }
    .top-name { font-size: 13px; font-weight: 700; color: #0f172a; margin-bottom: 2px; }
    .top-date { font-size: 11px; color: #94a3b8; margin-bottom: 5px; }
    .top-bar-track { height: 8px; background: #f1f5f9; border-radius: 999px; overflow: hidden; }
    .top-bar-fill { height: 100%; background: linear-gradient(90deg, #EF4444, #F97316); border-radius: 999px; }
    .top-amount { font-size: 15px; font-weight: 800; flex-shrink: 0; }

    /* Conclusion */
    .conclusion { margin-top: 28px; padding: 20px; border-radius: 18px; background: #f8fafc; border: 1px solid #e2e8f0; }
    .conclusion-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 800; color: #64748b; margin-bottom: 14px; }
    .conclusion-row { display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 14px; color: #475569; }
    .conclusion-row strong { color: #0f172a; }
    .conclusion-final { margin-top: 14px; padding-top: 14px; border-top: 2px solid #e2e8f0; display: flex; justify-content: space-between; font-size: 22px; font-weight: 900; color: ${conclusionColor}; }

    /* Info chips */
    .info-chips { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
    .chip { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 999px; padding: 6px 14px; font-size: 12px; color: #475569; }
    .chip strong { color: #0f172a; }

    /* Footer */
    .footer { margin-top: 30px; padding-top: 18px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 12px; text-align: center; }

    @media print { body { background: #fff; } .container { box-shadow: none; } }
  </style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <div class="header">
    <div>
      <div class="logo">Finzz</div>
      <div class="subtitle">Monthly Financial Report &bull; ${periodLabel}<br>Generated on ${generatedOn}</div>
    </div>
    <div class="user-details">
      <strong>${escapeHtml(user.name)}</strong>
      ${user.phone ? `<div>${escapeHtml(user.phone)}</div>` : ""}
      ${user.email ? `<div>${escapeHtml(user.email)}</div>` : ""}
    </div>
  </div>

  <!-- Info chips -->
  <div class="info-chips">
    <div class="chip">Period: <strong>${periodLabel}</strong></div>
    <div class="chip">Status: <strong style="text-transform:capitalize">${ledger.status}</strong></div>
    <div class="chip">Total Transactions: <strong>${allExpenses.length}</strong></div>
    <div class="chip">Active Days: <strong>${activeDays}</strong></div>
  </div>

  <!-- Summary cards -->
  <div class="summary-grid">
    <div class="summary-card card-debit">
      <div class="s-icon" style="background:#FEE2E2;"></div>
      <div class="s-label">Total Debited</div>
      <div class="s-value debit-text">Rs. ${ledger.totalExpenses.toFixed(2)}</div>
      <div class="s-sub">${debitExpenses.length} expense${debitExpenses.length !== 1 ? "s" : ""}</div>
    </div>
    <div class="summary-card card-credit">
      <div class="s-icon" style="background:#D1FAE5;"></div>
      <div class="s-label">Total Credited</div>
      <div class="s-value credit-text">Rs. ${ledger.totalCredits.toFixed(2)}</div>
      <div class="s-sub">${creditExpenses.length} credit${creditExpenses.length !== 1 ? "s" : ""}</div>
    </div>
    <div class="summary-card card-net">
      <div class="s-icon" style="background:${net >= 0 ? "#D1FAE5" : "#FEE2E2"}">${net >= 0 ? "" : ""}</div>
      <div class="s-label">${conclusionLabel}</div>
      <div class="s-value" style="color:${conclusionColor}">${net >= 0 ? "+" : "-"}Rs. ${Math.abs(net).toFixed(2)}</div>
      <div class="s-sub">${net >= 0 ? "You saved money" : "Spent more than earned"}</div>
    </div>
    <div class="summary-card card-avg">
      <div class="s-icon" style="background:#E0E7FF;"></div>
      <div class="s-label">Avg/Day</div>
      <div class="s-value debit-text">Rs. ${Math.round(avgDailyDebit)}</div>
      <div class="s-sub">Debit &bull; Rs. ${Math.round(avgDailyCredit)} Credit</div>
    </div>
  </div>

  <!-- Debit vs Credit bars -->
  <div class="section-title">Credit vs Debit Comparison <span class="section-badge">Overview</span></div>
  <div class="compare-section">
    <div class="bar-row">
      <div class="bar-header"><span> Credits (Income)</span><span class="credit-text">Rs. ${ledger.totalCredits.toFixed(2)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${creditBarW}%;background:linear-gradient(90deg,#22C55E,#4ADE80);"></div></div>
    </div>
    <div class="bar-row">
      <div class="bar-header"><span> Debits (Expenses)</span><span class="debit-text">Rs. ${ledger.totalExpenses.toFixed(2)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${debitBarW}%;background:linear-gradient(90deg,#EF4444,#F87171);"></div></div>
    </div>
    <div class="bar-row">
      <div class="bar-header"><span>${conclusionLabel}</span><span style="color:${conclusionColor};">${net >= 0 ? "+" : ""}Rs. ${net.toFixed(2)}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.min(Math.round((Math.abs(net) / maxBar) * 100), 100)}%;background:${conclusionColor};"></div></div>
    </div>
  </div>

  <!-- Category breakdown -->
  <div class="section-title">Category Breakdown <span class="section-badge">Debits</span></div>
  <table>
    <thead>
      <tr>
        <th style="width:32%">Category</th>
        <th style="width:10%;text-align:center">Txns</th>
        <th style="width:30%">Distribution</th>
        <th style="width:10%;text-align:right">%</th>
        <th style="width:18%;text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>${renderCategoryRows()}</tbody>
  </table>

  <!-- Top 5 expenses -->
  <div class="section-title">Top Expenses <span class="section-badge">This Month</span></div>
  <div class="top-list">${renderTop5()}</div>

  <!-- Daily spending chart -->
  <div class="section-title">Daily Activity <span class="section-badge">${periodLabel}</span></div>
  <div class="daily-chart">${renderDailyChart()}</div>

  <!-- Expense transactions table -->
  <div class="section-title">Expense Transactions <span class="section-badge">Debit</span></div>
  <table>
    <thead>
      <tr>
        <th style="width:18%">Date</th>
        <th style="width:40%">Remarks</th>
        <th style="width:20%">Category</th>
        <th style="width:22%;text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${renderRows(debitExpenses, "debit-text")}
      <tr class="total-row">
        <td colspan="3" style="text-align:right">Expense Total</td>
        <td class="amount-cell debit-text">Rs. ${ledger.totalExpenses.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Credit transactions table -->
  <div class="section-title">Credit Transactions <span class="section-badge">Income</span></div>
  <table>
    <thead>
      <tr>
        <th style="width:18%">Date</th>
        <th style="width:40%">Remarks</th>
        <th style="width:20%">Category</th>
        <th style="width:22%;text-align:right">Amount</th>
      </tr>
    </thead>
    <tbody>
      ${renderRows(creditExpenses, "credit-text")}
      <tr class="total-row">
        <td colspan="3" style="text-align:right">Credit Total</td>
        <td class="amount-cell credit-text">Rs. ${ledger.totalCredits.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <!-- Conclusion -->
  <div class="conclusion">
    <div class="conclusion-title">Financial Summary</div>
    <div class="conclusion-row"><span>Total Credits (Income)</span><strong class="credit-text">Rs. ${ledger.totalCredits.toFixed(2)}</strong></div>
    <div class="conclusion-row"><span>Total Debits (Expenses)</span><strong class="debit-text">Rs. ${ledger.totalExpenses.toFixed(2)}</strong></div>
    <div class="conclusion-row"><span>Active Days</span><strong>${activeDays} of ${daysInMonth}</strong></div>
    <div class="conclusion-row"><span>Avg Daily Debit</span><strong>Rs. ${Math.round(avgDailyDebit)}</strong></div>
    <div class="conclusion-final">
      <span>${conclusionLabel}</span>
      <span>${net >= 0 ? "+" : "-"}Rs. ${Math.abs(net).toFixed(2)}</span>
    </div>
  </div>

  <div class="footer">Generated by Finzz &copy; ${new Date().getFullYear()} &bull; ${periodLabel} Report</div>

</div>
</body>
</html>`;
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
    const debitExpenses = expenses.filter((expense) => expense.type === "debit");
    const creditExpenses = expenses.filter((expense) => expense.type === "credit");

    // Get user details from DB (uses `phone` field, not `mobile`)
    const userDoc = await User.findById(userId)
      .select("name phone email")
      .lean();

    if (!userDoc) {
      return next(new ErrorHandler("User not found", 404));
    }

    const user = {
      name: (userDoc as any).name || "User",
      phone: (userDoc as any).phone || "",
      email: (userDoc as any).email || "",
    };

    const html = buildExpenseExportHtml({
      ledger: {
        year: ledger.year,
        month: ledger.month,
        status: ledger.status as "open" | "closed",
        totalExpenses: ledger.totalExpenses,
        totalCredits: ledger.totalCredits || 0,
      },
      user,
      debitExpenses: debitExpenses as any[],
      creditExpenses: creditExpenses as any[],
    });

    return res.status(200).json({
      success: true,
      html,
    });
  },
);
