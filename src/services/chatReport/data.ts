import mongoose from "mongoose";
import { Chat } from "../../models/chatModel.js";
import { Tx } from "../../models/txModel.js";
import { daysInMonth as daysIn, monthRangeUtc } from "../../utils/dates.js";
import type {
  ChatReportData,
  ReportDaily,
  ReportLedgerRow,
  ReportMonthNet,
  ReportTxStatus,
} from "./types.js";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const TREND_MONTHS = 6;

/** Round to the paisa after every sum, so float drift never accumulates. */
const r2 = (x: number): number => Math.round(x * 100) / 100;

const pad2 = (n: number): string => String(n).padStart(2, "0");

interface RawTx {
  _id: { toString(): string };
  from: { toString(): string };
  amount: number;
  date: Date;
  remarks?: string;
  addedBy: { toString(): string };
  status?: ReportTxStatus;
  verified?: boolean;
}

/** "+05:30" / "-03:00": the form Mongo's `timezone` option accepts for a fixed offset. */
const tzString = (tzOffsetMinutes: number): string => {
  const sign = tzOffsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(tzOffsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
};

interface MonthAgg {
  gave: number;
  received: number;
  count: number;
}

/**
 * Everything the monthly chat report shows, computed once and in one place.
 *
 * Balance convention (see types.ts): POSITIVE = the friend owes the viewer.
 *  - A "gave" row (viewer paid the friend) increases what the friend owes: +amount.
 *  - A "received" row decreases it: -amount.
 *
 * One source of truth: the opening balance, the previous month and the trend
 * are all computed from Tx with the SAME timezone-aware boundaries as the
 * ledger. MonthlySummary rows are bucketed in server-local time, so reading
 * them here would double count (or drop) rows near a month boundary.
 */
export async function buildChatReportData(opts: {
  chatId: string;
  viewerId: string;
  year: number;
  month: number;
  tzOffsetMinutes: number;
  now?: Date;
}): Promise<ChatReportData> {
  const { chatId, viewerId, year, month, tzOffsetMinutes } = opts;

  const chat = await Chat.findById(chatId)
    .select("members")
    .populate("members", "name")
    .lean<{ members: { _id: { toString(): string }; name?: string }[] }>();
  if (!chat) throw new Error("Chat not found");

  const meDoc = chat.members.find((m) => m._id.toString() === viewerId);
  const friendDoc = chat.members.find((m) => m._id.toString() !== viewerId);
  const me = { id: viewerId, name: meDoc?.name || "You" };
  const friend = {
    id: friendDoc ? friendDoc._id.toString() : "",
    name: friendDoc?.name || "Friend",
  };

  const { start, end } = monthRangeUtc(year, month, tzOffsetMinutes);
  const daysInMonth = daysIn(year, month);

  const txs = await Tx.find({ chatId, date: { $gte: start, $lt: end } })
    .sort({ date: 1, _id: 1 })
    .lean<RawTx[]>();

  const chatOid = new mongoose.Types.ObjectId(chatId);
  const viewerOid = new mongoose.Types.ObjectId(viewerId);
  const isViewerGave = { $eq: ["$from", viewerOid] };

  // Everything before the period's first instant, non-rejected only (a legacy
  // row with no status counts). Positive = the friend owes the viewer.
  const [openingAgg] = await Tx.aggregate<{ net: number }>([
    { $match: { chatId: chatOid, date: { $lt: start }, status: { $ne: "rejected" } } },
    {
      $group: {
        _id: null,
        net: { $sum: { $cond: [isViewerGave, "$amount", { $multiply: ["$amount", -1] }] } },
      },
    },
  ]);
  const openingBalance = r2(openingAgg?.net ?? 0) + 0; // "+ 0" turns -0 into 0

  let running = openingBalance;
  let gave = 0;
  let received = 0;
  let count = 0;
  let addedByMe = 0;
  let addedByFriend = 0;
  const activeDays = new Set<string>();
  const byStatus: ChatReportData["byStatus"] = {
    pending: { count: 0, amount: 0 },
    verified: { count: 0, amount: 0 },
    rejected: { count: 0, amount: 0 },
  };
  const daily: ReportDaily[] = Array.from({ length: daysInMonth }, (_, i) => ({
    dayOfMonth: i + 1,
    gave: 0,
    received: 0,
    count: 0,
  }));
  const weekday = Array.from({ length: 7 }, (_, i) => ({ weekday: i, amount: 0, count: 0 }));
  const ledger: ReportLedgerRow[] = [];

  for (const tx of txs) {
    const status: ReportTxStatus = tx.status ?? (tx.verified ? "verified" : "pending");
    const direction = tx.from.toString() === viewerId ? "gave" : "received";
    const addedBy = tx.addedBy.toString() === viewerId ? "me" : "friend";

    // The viewer's calendar day: shift, then read the UTC fields.
    const local = new Date(new Date(tx.date).getTime() + tzOffsetMinutes * 60_000);
    const dayOfMonth = local.getUTCDate();
    const dow = local.getUTCDay();
    const day = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(dayOfMonth)}`;

    const bucket = byStatus[status];
    bucket.count += 1;
    bucket.amount = r2(bucket.amount + tx.amount);

    if (status !== "rejected") {
      if (direction === "gave") {
        gave = r2(gave + tx.amount);
        running = r2(running + tx.amount);
      } else {
        received = r2(received + tx.amount);
        running = r2(running - tx.amount);
      }
      count += 1;
      if (addedBy === "me") addedByMe += 1;
      else addedByFriend += 1;
      activeDays.add(day);

      const d = daily[dayOfMonth - 1];
      if (d) {
        if (direction === "gave") d.gave = r2(d.gave + tx.amount);
        else d.received = r2(d.received + tx.amount);
        d.count += 1;
      }
      weekday[dow].amount = r2(weekday[dow].amount + tx.amount);
      weekday[dow].count += 1;
    }

    ledger.push({
      id: tx._id.toString(),
      day,
      dayOfMonth,
      weekday: dow,
      remarks: tx.remarks ?? "",
      amount: tx.amount,
      direction,
      status,
      addedBy,
      runningBalance: running,
    });
  }

  // Trend window (this month and the five before it, oldest first) plus the
  // previous month, from one aggregate on Tx bucketed in the user's timezone.
  const window: { year: number; month: number }[] = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    const idx = year * 12 + (month - 1) - i;
    window.push({ year: Math.floor(idx / 12), month: (idx % 12) + 1 });
  }
  const windowStart = monthRangeUtc(window[0].year, window[0].month, tzOffsetMinutes).start;
  const parts = { $dateToParts: { date: "$date", timezone: tzString(tzOffsetMinutes) } };
  const monthRows = await Tx.aggregate<{ _id: { year: number; month: number } } & MonthAgg>([
    {
      $match: {
        chatId: chatOid,
        date: { $gte: windowStart, $lt: end },
        status: { $ne: "rejected" },
      },
    },
    { $addFields: { parts } },
    {
      $group: {
        _id: { year: "$parts.year", month: "$parts.month" },
        gave: { $sum: { $cond: [isViewerGave, "$amount", 0] } },
        received: { $sum: { $cond: [isViewerGave, 0, "$amount"] } },
        count: { $sum: 1 },
      },
    },
  ]);
  const monthAt = (y: number, m: number): MonthAgg | undefined =>
    monthRows.find((row) => row._id.year === y && row._id.month === m);

  const trend: ReportMonthNet[] = window.map((w) => {
    const row = monthAt(w.year, w.month);
    const g = r2(row?.gave ?? 0);
    const rc = r2(row?.received ?? 0);
    return {
      year: w.year,
      month: w.month,
      label: MONTH_NAMES[w.month - 1].slice(0, 3),
      gave: g,
      received: rc,
      net: r2(rc - g) + 0,
    };
  });

  const prevWindow = window[TREND_MONTHS - 2];
  const prevRow = monthAt(prevWindow.year, prevWindow.month);
  const previousMonth =
    prevRow && prevRow.count > 0
      ? {
          gave: r2(prevRow.gave),
          received: r2(prevRow.received),
          net: r2(prevRow.received - prevRow.gave) + 0,
          count: prevRow.count,
        }
      : null;

  return {
    generatedAtUtc: (opts.now ?? new Date()).toISOString(),
    period: {
      year,
      month,
      label: `${MONTH_NAMES[month - 1]} ${year}`,
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      daysInMonth,
      tzOffsetMinutes,
    },
    me,
    friend,
    openingBalance,
    closingBalance: r2(running),
    totals: {
      gave,
      received,
      net: r2(received - gave),
      count,
      activeDays: activeDays.size,
      addedByMe,
      addedByFriend,
    },
    byStatus,
    ledger,
    daily,
    weekday,
    previousMonth,
    trend,
  };
}
