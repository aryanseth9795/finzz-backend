import { Chat } from "../../models/chatModel.js";
import { Tx } from "../../models/txModel.js";
import { MonthlySummary } from "../../models/monthlySummaryModel.js";
import { getCarryForward } from "../summaryService.js";
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

interface SummaryRow {
  year: number;
  month: number;
  txCount?: number;
  members?: Map<string, MemberStats> | Record<string, MemberStats>;
}

interface MemberStats {
  totalSent?: number;
  totalReceived?: number;
}

const memberStats = (row: SummaryRow | undefined, userId: string): MemberStats | undefined => {
  const members = row?.members;
  if (!members) return undefined;
  return members instanceof Map ? members.get(userId) : members[userId];
};

/**
 * Everything the monthly chat report shows, computed once and in one place.
 *
 * Balance convention (see types.ts): POSITIVE = the friend owes the viewer.
 *  - A "gave" row (viewer paid the friend) increases what the friend owes: +amount.
 *  - A "received" row decreases it: -amount.
 *  - `getCarryForward` returns received - sent per user, which is the OPPOSITE
 *    sign (positive = that user has received more, i.e. owes more). The opening
 *    balance is therefore its negation.
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

  // getCarryForward is received - sent, the opposite of the report convention.
  const carry = await getCarryForward(chatId, year, month);
  const openingBalance = r2(-(carry[viewerId] ?? 0)) + 0; // "+ 0" turns -0 into 0

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

  // Previous month plus the trend window, in one query.
  const window: { year: number; month: number }[] = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    const idx = year * 12 + (month - 1) - i;
    window.push({ year: Math.floor(idx / 12), month: (idx % 12) + 1 });
  }
  const prev = (() => {
    const idx = year * 12 + (month - 1) - 1;
    return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
  })();
  const summaries = await MonthlySummary.find({
    chatId,
    $or: window.map((w) => ({ year: w.year, month: w.month })),
  }).lean<SummaryRow[]>();
  const summaryAt = (y: number, m: number) =>
    summaries.find((s) => s.year === y && s.month === m);

  const prevRow = summaryAt(prev.year, prev.month);
  const prevStats = memberStats(prevRow, viewerId);
  const prevGave = r2(prevStats?.totalSent ?? 0);
  const prevReceived = r2(prevStats?.totalReceived ?? 0);
  const prevCount = prevRow?.txCount ?? 0;
  const previousMonth =
    prevRow && (prevGave !== 0 || prevReceived !== 0)
      ? {
          gave: prevGave,
          received: prevReceived,
          net: r2(prevReceived - prevGave),
          count: Math.max(prevCount, 0),
        }
      : null;

  const trend: ReportMonthNet[] = [];
  for (const w of window) {
    const row = summaryAt(w.year, w.month);
    if (!row) continue;
    const stats = memberStats(row, viewerId);
    const g = r2(stats?.totalSent ?? 0);
    const rc = r2(stats?.totalReceived ?? 0);
    trend.push({
      year: w.year,
      month: w.month,
      label: MONTH_NAMES[w.month - 1].slice(0, 3),
      gave: g,
      received: rc,
      net: r2(rc - g),
    });
  }

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
