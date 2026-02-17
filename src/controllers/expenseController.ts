import { NextFunction, Request, Response } from "express";
import TryCatch from "../utils/TryCatch.js";
import { Expense } from "../models/expenseModel.js";
import { ExpenseLedger } from "../models/expenseLedgerModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";

// ==========================================
// Helper: Get or create current month's ledger
// ==========================================
async function getOrCreateLedger(userId: string, date: Date) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1; // 1-12

  let ledger = await ExpenseLedger.findOne({ userId, year, month });

  if (!ledger) {
    ledger = await ExpenseLedger.create({
      userId,
      year,
      month,
      status: "open",
      totalExpenses: 0,
    });
  }

  return ledger;
}

// ==========================================
// Add Expense
// ==========================================
export const addExpense = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { amount, date, remarks, category } = req.body;
    const userId = req.user.id;

    if (!amount || !date) {
      return next(new ErrorHandler("Amount and date are required", 400));
    }

    const expenseDate = new Date(date);

    // Get or create the ledger for this month
    const ledger = await getOrCreateLedger(userId, expenseDate);

    // Check if ledger is closed
    if (ledger.status === "closed") {
      return next(
        new ErrorHandler("Cannot add expenses to a closed ledger period", 400),
      );
    }

    // Create the expense
    const expense = await Expense.create({
      userId,
      ledgerId: ledger._id,
      amount,
      date: expenseDate,
      remarks,
      category,
    });

    // Update ledger total
    ledger.totalExpenses += amount;
    await ledger.save();

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
    const { ledgerId, cursor, limit = "20" } = req.query;
    const pageLimit = parseInt(limit as string);

    const query: any = { userId };

    if (ledgerId) {
      query.ledgerId = ledgerId;
    }

    if (cursor) {
      query.date = { $lt: new Date(cursor as string) };
    }

    const expenses = await Expense.find(query)
      .sort({ date: -1 })
      .limit(pageLimit + 1)
      .lean();

    const hasMore = expenses.length > pageLimit;
    if (hasMore) expenses.pop();

    const nextCursor =
      hasMore && expenses.length > 0
        ? expenses[expenses.length - 1].date.toISOString()
        : null;

    return res.status(200).json({
      success: true,
      expenses,
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
    const { amount, date, remarks, category } = req.body;

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

    // Update expense fields
    if (amount !== undefined) expense.amount = amount;
    if (date !== undefined) expense.date = new Date(date);
    if (remarks !== undefined) expense.remarks = remarks;
    if (category !== undefined) expense.category = category;

    await expense.save();

    // Update ledger total if amount changed
    if (amount !== undefined && amount !== oldAmount) {
      ledger.totalExpenses = ledger.totalExpenses - oldAmount + amount;
      await ledger.save();
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

    // Update ledger total
    ledger.totalExpenses -= expense.amount;
    await ledger.save();

    // Delete the expense
    await expense.deleteOne();

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

    let stats: any = {};

    if (period === "daily") {
      // Group by day for last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const dailyStats = await Expense.aggregate([
        {
          $match: {
            userId: userId,
            date: { $gte: thirtyDaysAgo },
          },
        },
        {
          $group: {
            _id: {
              $dateToString: { format: "%Y-%m-%d", date: "$date" },
            },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
      ]);

      stats.daily = dailyStats.map((d) => ({
        date: d._id,
        total: d.total,
        count: d.count,
      }));
    }

    if (period === "monthly" || !period) {
      // Group by month
      const monthlyStats = await Expense.aggregate([
        { $match: { userId: userId } },
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
        { $sort: { "_id.year": -1, "_id.month": -1 } },
      ]);

      stats.monthly = monthlyStats.map((m) => ({
        month: `${m._id.year}-${String(m._id.month).padStart(2, "0")}`,
        total: m.total,
        count: m.count,
      }));
    }

    if (period === "yearly") {
      // Group by year
      const yearlyStats = await Expense.aggregate([
        { $match: { userId: userId } },
        {
          $group: {
            _id: { $year: "$date" },
            total: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: -1 } },
      ]);

      stats.yearly = yearlyStats.map((y) => ({
        year: y._id,
        total: y.total,
        count: y.count,
      }));
    }

    // Grand total
    const grandTotal = await Expense.aggregate([
      { $match: { userId: userId } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    stats.grandTotal = grandTotal.length > 0 ? grandTotal[0].total : 0;

    return res.status(200).json({
      success: true,
      stats,
    });
  },
);

// ==========================================
// Get Ledgers
// ==========================================
export const getLedgers = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;

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
    const { year, month } = req.body;

    if (!year || !month) {
      return next(new ErrorHandler("Year and month are required", 400));
    }

    // Check if month is in the past
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    if (year > currentYear || (year === currentYear && month >= currentMonth)) {
      return next(
        new ErrorHandler("Can only close ledgers for past months", 400),
      );
    }

    const ledger = await ExpenseLedger.findOne({ userId, year, month });

    if (!ledger) {
      return next(new ErrorHandler("Ledger not found", 404));
    }

    if (ledger.status === "closed") {
      return next(new ErrorHandler("Ledger is already closed", 400));
    }

    ledger.status = "closed";
    ledger.closedAt = new Date();
    await ledger.save();

    return res.status(200).json({
      success: true,
      message: "Ledger closed successfully",
      ledger,
    });
  },
);

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

    // Get all expenses for this ledger
    const expenses = await Expense.find({ ledgerId }).sort({ date: -1 }).lean();

    // Build HTML string
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Expense Report - ${ledger.year}-${String(ledger.month).padStart(2, "0")}</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          h1 { color: #333; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #4F46E5; color: white; }
          .total { font-weight: bold; background-color: #f0f0f0; }
        </style>
      </head>
      <body>
        <h1>Expense Report</h1>
        <p><strong>Period:</strong> ${ledger.year}-${String(ledger.month).padStart(2, "0")}</p>
        <p><strong>Status:</strong> ${ledger.status}</p>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Amount (₹)</th>
              <th>Category</th>
              <th>Remarks</th>
            </tr>
          </thead>
          <tbody>
            ${expenses
              .map(
                (exp) => `
              <tr>
                <td>${new Date(exp.date).toLocaleDateString()}</td>
                <td>₹${exp.amount.toFixed(2)}</td>
                <td>${exp.category || "-"}</td>
                <td>${exp.remarks || "-"}</td>
              </tr>
            `,
              )
              .join("")}
            <tr class="total">
              <td colspan="3">Total</td>
              <td>₹${ledger.totalExpenses.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      </body>
      </html>
    `;

    return res.status(200).json({
      success: true,
      html,
    });
  },
);
