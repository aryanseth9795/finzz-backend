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

// ==============================
// Chat Ledger PDF Export
// GET /stats/chat/:chatId/export?year=2026&month=4
// ==============================
export const exportChatLedger = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { chatId } = req.params;
    const now = new Date();
    const year = parseInt(req.query.year as string) || now.getFullYear();
    const month = parseInt(req.query.month as string) || now.getMonth() + 1;

    const chat = await Chat.findById(chatId)
      .select("members")
      .populate("members", "name phone avatar")
      .lean<{ members: { _id: any; name: string; phone?: string }[] }>();

    if (!chat) return next(new ErrorHandler("Chat not found", 404));
    if (!chat.members.some((m) => m._id.toString() === userId)) {
      return next(new ErrorHandler("You are not a member of this chat", 403));
    }

    const me = chat.members.find((m) => m._id.toString() === userId);
    const friend = chat.members.find((m) => m._id.toString() !== userId);
    const myName = me?.name || "You";
    const friendName = friend?.name || "Friend";

    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
    const txns = await Tx.find({
      chatId,
      status: { $ne: "rejected" },
      date: { $gte: monthStart, $lte: monthEnd },
    })
      .sort({ date: 1 })
      .lean<Array<{ amount: number; date: Date; remarks?: string; to: any; from: any; status?: string }>>();

    let totalSent = 0;
    let totalReceived = 0;
    const dailySent: Record<number, number> = {};
    const dailyReceived: Record<number, number> = {};
    const sentTxns: typeof txns = [];
    const receivedTxns: typeof txns = [];

    for (const tx of txns) {
      const day = new Date(tx.date).getDate();
      if (tx.from.toString() === userId) {
        totalSent += tx.amount;
        dailySent[day] = (dailySent[day] || 0) + tx.amount;
        sentTxns.push(tx);
      } else {
        totalReceived += tx.amount;
        dailyReceived[day] = (dailyReceived[day] || 0) + tx.amount;
        receivedTxns.push(tx);
      }
    }

    const net = totalReceived - totalSent;
    const daysInMonth = new Date(year, month, 0).getDate();
    const activeDays = new Set(txns.map((t) => new Date(t.date).getDate())).size;
    const maxBar = Math.max(totalSent, totalReceived, 1);
    const sentBarW = Math.round((totalSent / maxBar) * 100);
    const recvBarW = Math.round((totalReceived / maxBar) * 100);

    const carryForward = await getCarryForward(chatId, year, month);
    const cfMe = carryForward[userId] || 0;
    const overallNet = (totalSent - totalReceived) - cfMe;

    const daysWithData = Array.from(
      new Set([...Object.keys(dailySent), ...Object.keys(dailyReceived)].map(Number)),
    ).sort((a, b) => a - b);
    const maxDaily = Math.max(...Object.values(dailySent), ...Object.values(dailyReceived), 1);

    const periodLabel = new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    const generatedOn = new Date().toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
    const netColor = overallNet > 0 ? "#16A34A" : overallNet < 0 ? "#DC2626" : "#64748b";
    const netLabel = overallNet > 0 ? "To Receive" : overallNet < 0 ? "To Pay" : "Settled";

    const renderRows = (entries: typeof txns, cls: string) =>
      entries.length > 0
        ? entries.map((tx) => `<tr><td>${new Date(tx.date).toLocaleDateString("en-IN")}</td><td>${tx.remarks || "-"}</td><td style="text-align:center">${tx.status === "verified" ? "✓" : "⏳"}</td><td class="amount-cell ${cls}">₹${tx.amount.toLocaleString("en-IN")}</td></tr>`).join("")
        : `<tr><td colspan="4" class="empty-row">No transactions.</td></tr>`;

    const renderDailyChart = () => {
      if (daysWithData.length === 0) return `<p style="color:#94a3b8;font-style:italic;font-size:13px">No daily data.</p>`;
      return `<div style="display:flex;align-items:flex-end;gap:16px;height:180px;padding-top:10px;padding-bottom:10px;overflow-x:auto;border-bottom:2px solid #e2e8f0;margin-bottom:10px">` +
        daysWithData.map((day) => {
          const s = dailySent[day] || 0;
          const r = dailyReceived[day] || 0;
          const sH = Math.max(Math.round((s / maxDaily) * 100), 1);
          const rH = Math.max(Math.round((r / maxDaily) * 100), 1);
          return `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;min-width:40px;gap:8px;">
            <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:auto">
              ${s > 0 ? `<div style="font-size:9px;font-weight:700;color:#DC2626">₹${Math.round(s)}</div>` : ""}
              ${r > 0 ? `<div style="font-size:9px;font-weight:700;color:#16A34A">₹${Math.round(r)}</div>` : ""}
            </div>
            <div style="display:flex;align-items:flex-end;justify-content:center;gap:6px;flex:1;width:100%;">
              ${s > 0 ? `<div style="height:${sH}%;width:14px;border-radius:4px 4px 0 0;background:linear-gradient(0deg,#EF4444,#F87171);"></div>` : ""}
              ${r > 0 ? `<div style="height:${rH}%;width:14px;border-radius:4px 4px 0 0;background:linear-gradient(0deg,#22C55E,#4ADE80);"></div>` : ""}
            </div>
            <div style="font-size:11px;color:#64748b;font-weight:700;margin-top:2px;">D${day}</div>
          </div>`;
        }).join("") + `</div>`;
    };

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Finzz Ledger - ${myName} &amp; ${friendName} - ${periodLabel}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;padding:28px;background:#f1f5f9;color:#0f172a;-webkit-print-color-adjust:exact;print-color-adjust:exact}.container{max-width:900px;margin:0 auto;background:#fff;border-radius:20px;padding:32px;box-shadow:0 16px 48px rgba(15,23,42,.10)}.header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid #4F46E5;margin-bottom:28px;gap:20px}.logo{font-size:32px;font-weight:900;color:#4F46E5;font-style:italic;letter-spacing:-1.5px}.subtitle{margin-top:8px;color:#475569;font-size:13px;line-height:1.7}.user-details{text-align:right;color:#475569;font-size:13px;line-height:1.8}.user-details strong{color:#0f172a;font-size:15px;display:block}.info-chips{display:flex;gap:10px;margin-bottom:20px;flex-wrap:wrap}.chip{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:999px;padding:6px 14px;font-size:12px;color:#475569}.chip strong{color:#0f172a}.summary-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}.summary-card{border-radius:16px;padding:16px;border:1px solid #e2e8f0}.s-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:10px;font-size:18px}.s-label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:#64748b;font-weight:700;margin-bottom:4px}.s-value{font-size:20px;font-weight:900;margin-bottom:2px}.s-sub{font-size:11px;color:#94a3b8}.card-sent{background:#FEF2F2;border-color:#FECACA}.card-recv{background:#F0FDF4;border-color:#BBF7D0}.card-net{border-color:#e2e8f0}.card-avg{background:#EEF2FF;border-color:#C7D2FE}.section-title{font-size:17px;font-weight:800;margin:28px 0 12px;color:#0f172a;display:flex;align-items:center;gap:8px}.section-title::after{content:"";flex:1;height:2px;background:#e2e8f0;border-radius:1px}.section-badge{background:#4F46E5;color:#fff;font-size:10px;padding:2px 8px;border-radius:999px;font-weight:700}.compare-section{margin-bottom:28px}.bar-row{margin-bottom:14px}.bar-header{display:flex;justify-content:space-between;font-size:13px;font-weight:700;margin-bottom:6px}.bar-track{width:100%;height:20px;border-radius:999px;background:#f1f5f9;overflow:hidden}.bar-fill{height:100%;border-radius:999px}table{width:100%;border-collapse:collapse;margin-top:8px}th,td{padding:11px 12px;text-align:left;border-bottom:1px solid #f1f5f9;font-size:13px}th{background:#4F46E5;color:#fff;font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:700}tr:last-child td{border-bottom:none}tr:nth-child(even) td{background:#f8fafc}.total-row td{font-weight:800!important;background:#f1f5f9!important;border-top:2px solid #e2e8f0}.amount-cell{text-align:right;font-weight:700}.credit-text{color:#16A34A}.debit-text{color:#DC2626}.empty-row{text-align:center;color:#94a3b8;font-style:italic;padding:24px}.conclusion{margin-top:28px;padding:20px;border-radius:18px;background:#f8fafc;border:1px solid #e2e8f0}.conclusion-title{font-size:11px;text-transform:uppercase;letter-spacing:.8px;font-weight:800;color:#64748b;margin-bottom:14px}.conclusion-row{display:flex;justify-content:space-between;margin-bottom:8px;font-size:14px;color:#475569}.conclusion-row strong{color:#0f172a}.conclusion-final{margin-top:14px;padding-top:14px;border-top:2px solid #e2e8f0;display:flex;justify-content:space-between;font-size:22px;font-weight:900;color:${netColor}}.footer{margin-top:30px;padding-top:18px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;text-align:center}@media print{body{background:#fff}.container{box-shadow:none}}</style></head><body><div class="container">
<div class="header"><div><div class="logo">Finzz</div><div class="subtitle">Ledger Report &bull; ${myName} &#8596; ${friendName}<br>Period: ${periodLabel} &bull; Generated on ${generatedOn}</div></div><div class="user-details"><strong>${myName}</strong>${me?.phone ? `<div>${me.phone}</div>` : ""}<div style="margin-top:6px"><strong>${friendName}</strong></div>${friend?.phone ? `<div>${friend.phone}</div>` : ""}</div></div>
<div class="info-chips"><div class="chip">Period: <strong>${periodLabel}</strong></div><div class="chip">Transactions: <strong>${txns.length}</strong></div><div class="chip">Active Days: <strong>${activeDays}</strong></div><div class="chip">Days in Month: <strong>${daysInMonth}</strong></div></div>
<div class="summary-grid"><div class="summary-card card-sent"><div class="s-icon" style="background:#FEE2E2">&#128184;</div><div class="s-label">You Sent</div><div class="s-value debit-text">&#8377;${totalSent.toLocaleString("en-IN")}</div><div class="s-sub">${sentTxns.length} txn${sentTxns.length !== 1 ? "s" : ""}</div></div><div class="summary-card card-recv"><div class="s-icon" style="background:#D1FAE5">&#128176;</div><div class="s-label">You Received</div><div class="s-value credit-text">&#8377;${totalReceived.toLocaleString("en-IN")}</div><div class="s-sub">${receivedTxns.length} txn${receivedTxns.length !== 1 ? "s" : ""}</div></div><div class="summary-card card-net"><div class="s-icon" style="background:${net >= 0 ? "#D1FAE5" : "#FEE2E2"}">${net >= 0 ? "&#128200;" : "&#128201;"}</div><div class="s-label">This Month</div><div class="s-value" style="color:${net >= 0 ? "#16A34A" : "#DC2626"}">${net >= 0 ? "+" : ""}&#8377;${net.toLocaleString("en-IN")}</div><div class="s-sub">${net >= 0 ? "Received more" : "Sent more"}</div></div><div class="summary-card card-avg"><div class="s-icon" style="background:#E0E7FF">&#128202;</div><div class="s-label">Overall</div><div class="s-value" style="color:${netColor}">${overallNet >= 0 ? "+" : ""}&#8377;${Math.abs(overallNet).toLocaleString("en-IN")}</div><div class="s-sub">${netLabel} (incl. carry-forward)</div></div></div>
<div class="section-title">Sent vs Received <span class="section-badge">Comparison</span></div><div class="compare-section"><div class="bar-row"><div class="bar-header"><span>&#128184; You Sent</span><span class="debit-text">&#8377;${totalSent.toLocaleString("en-IN")}</span></div><div class="bar-track"><div class="bar-fill" style="width:${sentBarW}%;background:linear-gradient(90deg,#EF4444,#F87171)"></div></div></div><div class="bar-row"><div class="bar-header"><span>&#128176; You Received</span><span class="credit-text">&#8377;${totalReceived.toLocaleString("en-IN")}</span></div><div class="bar-track"><div class="bar-fill" style="width:${recvBarW}%;background:linear-gradient(90deg,#22C55E,#4ADE80)"></div></div></div></div>
<div class="section-title">Daily Activity <span class="section-badge">${periodLabel}</span></div><div style="margin-top:8px">${renderDailyChart()}</div>
<div class="section-title">Sent Transactions <span class="section-badge">You &#8594; ${friendName}</span></div><table><thead><tr><th style="width:18%">Date</th><th style="width:42%">Remarks</th><th style="width:12%;text-align:center">Status</th><th style="width:28%;text-align:right">Amount</th></tr></thead><tbody>${renderRows(sentTxns, "debit-text")}<tr class="total-row"><td colspan="3" style="text-align:right">Sent Total</td><td class="amount-cell debit-text">&#8377;${totalSent.toLocaleString("en-IN")}</td></tr></tbody></table>
<div class="section-title">Received Transactions <span class="section-badge">${friendName} &#8594; You</span></div><table><thead><tr><th style="width:18%">Date</th><th style="width:42%">Remarks</th><th style="width:12%;text-align:center">Status</th><th style="width:28%;text-align:right">Amount</th></tr></thead><tbody>${renderRows(receivedTxns, "credit-text")}<tr class="total-row"><td colspan="3" style="text-align:right">Received Total</td><td class="amount-cell credit-text">&#8377;${totalReceived.toLocaleString("en-IN")}</td></tr></tbody></table>
<div class="conclusion"><div class="conclusion-title">Settlement Summary</div><div class="conclusion-row"><span>Sent to ${friendName}</span><strong class="debit-text">&#8377;${totalSent.toLocaleString("en-IN")}</strong></div><div class="conclusion-row"><span>Received from ${friendName}</span><strong class="credit-text">&#8377;${totalReceived.toLocaleString("en-IN")}</strong></div><div class="conclusion-row"><span>This Month Net</span><strong>${net >= 0 ? "+" : ""}&#8377;${net.toLocaleString("en-IN")}</strong></div><div class="conclusion-row"><span>Carry Forward</span><strong>${cfMe >= 0 ? "+" : ""}&#8377;${cfMe.toLocaleString("en-IN")}</strong></div><div class="conclusion-final"><span>${netLabel}</span><span>${overallNet >= 0 ? "+" : "-"}&#8377;${Math.abs(overallNet).toLocaleString("en-IN")}</span></div></div>
<div class="footer">Generated by Finzz &copy; ${new Date().getFullYear()} &bull; ${myName} &#8596; ${friendName} &bull; ${periodLabel}</div>
</div></body></html>`;

    return res.status(200).json({ success: true, html });
  },
);
