/**
 * Plain-language insight sentences for the 1:1 chat report (T-005).
 *
 * Pure: reads a `ChatReportData`, returns `ReportInsight[]` in importance order.
 * No locale or local-time Date methods are used for dates: the ledger rows
 * already carry the viewer's calendar day ("YYYY-MM-DD") and weekday, so the
 * text is the same on any server timezone.
 *
 * Balance convention (types.ts): POSITIVE = the friend owes the viewer.
 */

import { formatCurrency } from "../../utils/html.js";
import type { ChatReportData, ReportInsight, ReportLedgerRow } from "./types.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Anything under half a paisa counts as zero. */
const EPSILON = 0.005;
/** Activity within this fraction of last month is "about the same". */
const SAME_BAND = 0.05;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const entries = (n: number): string => plural(n, "entry", "entries");

/** "2026-10-12" -> "12 Oct" (parsed from the string, no Date). */
function shortDate(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m - 1] ?? ""}`.trim();
}

/**
 * When a balance is "as of": "as of 17 Oct 2026" while the report month is the
 * current one (or later) in the viewer's timezone, because the month isn't over
 * and the balance can still change; "at the end of September 2026" once it is
 * past. Compared in the viewer's timezone, never the server's.
 */
export function asOfPhrase(data: ChatReportData): string {
  const endOf = `at the end of ${data.period.label}`;
  const ms = Date.parse(data.generatedAtUtc);
  if (Number.isNaN(ms)) return endOf;
  const local = new Date(ms + (data.period.tzOffsetMinutes || 0) * 60_000);
  const nowIndex = local.getUTCFullYear() * 12 + local.getUTCMonth();
  const periodIndex = data.period.year * 12 + (data.period.month - 1);
  if (periodIndex < nowIndex) return endOf;
  return `as of ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}`;
}

/** "Owes you" wording for a closing/any balance, in the report convention. */
export function balanceSentence(balance: number, friendName: string): string {
  if (Math.abs(balance) < EPSILON) return `You and ${friendName} are all settled`;
  if (balance > 0) return `${friendName} owes you ${formatCurrency(balance)}`;
  return `You owe ${friendName} ${formatCurrency(-balance)}`;
}

export function buildInsights(data: ChatReportData): ReportInsight[] {
  const out: ReportInsight[] = [];
  const friend = data.friend.name;
  const closing = data.closingBalance;
  const settled = Math.abs(closing) < EPSILON;
  const live: ReportLedgerRow[] = data.ledger.filter((r) => r.status !== "rejected");

  // 1. balance
  out.push({
    kind: "balance",
    text: `${balanceSentence(closing, friend)} ${asOfPhrase(data)}`,
    tone: settled ? "neutral" : closing > 0 ? "positive" : "negative",
  });

  // 2. biggest (first one wins a tie, i.e. the earliest)
  let biggest: ReportLedgerRow | undefined;
  for (const r of live) if (!biggest || r.amount > biggest.amount) biggest = r;
  if (biggest) {
    const remarks = (biggest.remarks ?? "").trim();
    out.push({
      kind: "biggest",
      text:
        `Biggest entry: ${formatCurrency(biggest.amount)} on ${shortDate(biggest.day)}` +
        (remarks ? ` — ${remarks}` : ""),
      tone: "neutral",
    });
  }

  // 3. busiest day (earliest day wins a tie; needs at least 2 entries)
  const perDay = new Map<string, { count: number; weekday: number }>();
  for (const r of live) {
    const cur = perDay.get(r.day);
    if (cur) cur.count += 1;
    else perDay.set(r.day, { count: 1, weekday: r.weekday });
  }
  let busiestDay: string | undefined;
  let busiest: { count: number; weekday: number } | undefined;
  for (const [day, v] of perDay) {
    if (!busiest || v.count > busiest.count || (v.count === busiest.count && day < busiestDay!)) {
      busiestDay = day;
      busiest = v;
    }
  }
  if (busiest && busiestDay && busiest.count >= 2) {
    out.push({
      kind: "busiestDay",
      text: `Busiest day: ${WEEKDAYS[busiest.weekday]}, ${shortDate(busiestDay)} (${entries(busiest.count)})`,
      tone: "neutral",
    });
  }

  // 4. vs last month (total movement = gave + received)
  if (data.previousMonth) {
    const prev = data.previousMonth.gave + data.previousMonth.received;
    if (prev > 0) {
      const now = data.totals.gave + data.totals.received;
      const change = (now - prev) / prev;
      const pct = Math.round(Math.abs(change) * 100);
      const text =
        Math.abs(change) <= SAME_BAND
          ? "Activity about the same as last month"
          : `Activity ${change > 0 ? "up" : "down"} ${pct}% vs last month`;
      out.push({ kind: "vsLastMonth", text, tone: "neutral" });
    }
  }

  // 5. average
  if (data.totals.count >= 1) {
    const avg = (data.totals.gave + data.totals.received) / data.totals.count;
    out.push({
      kind: "average",
      text:
        `${entries(data.totals.count)} on ${data.totals.activeDays} of ${data.period.daysInMonth} days` +
        ` · average ${formatCurrency(avg)}`,
      tone: "neutral",
    });
  }

  // 6. pending
  const pending = data.byStatus.pending;
  if (pending.count > 0) {
    out.push({
      kind: "pending",
      text: `${formatCurrency(pending.amount)} (${entries(pending.count)}) is still waiting to be verified`,
      tone: "warning",
    });
  }

  // 7. rejected
  const rejected = data.byStatus.rejected;
  if (rejected.count > 0) {
    out.push({
      kind: "rejected",
      text: `${plural(rejected.count, "rejected entry", "rejected entries")} ${rejected.count === 1 ? "is" : "are"} not counted`,
      tone: "neutral",
    });
  }

  // 8. who added
  if (data.totals.addedByMe > 0 && data.totals.addedByFriend > 0) {
    out.push({
      kind: "whoAdded",
      text: `You added ${entries(data.totals.addedByMe)}, ${friend} added ${data.totals.addedByFriend}`,
      tone: "neutral",
    });
  }

  // 9. trend. month.net = received - gave, but the BALANCE (positive = friend
  // owes the viewer) moves by gave - received = -net. Three months in a row of
  // net < 0 mean the balance grew each month; three of net > 0 mean the friend
  // has been paying the viewer back. Only calendar-consecutive months count and
  // a zero month breaks the run.
  if (data.trend.length >= 3) {
    const last3 = data.trend.slice(-3);
    const consecutive = last3.every(
      (m, i) =>
        i === 0 ||
        m.year * 12 + m.month === last3[i - 1].year * 12 + last3[i - 1].month + 1,
    );
    if (consecutive) {
      const nets = last3.map((m) => m.net);
      if (nets.every((v) => v <= -EPSILON)) {
        out.push({
          kind: "trend",
          text: `${friend}'s balance owed to you has grown 3 months in a row`,
          tone: "neutral",
        });
      } else if (nets.every((v) => v >= EPSILON)) {
        out.push({
          kind: "trend",
          text: `${friend} has been paying you back — 3 months in a row`,
          tone: "positive",
        });
      }
    }
  }

  // 10. settle
  if (!settled) {
    out.push(
      closing > 0
        ? { kind: "settle", text: `To settle, ${friend} pays you ${formatCurrency(closing)}`, tone: "positive" }
        : { kind: "settle", text: `To settle, pay ${friend} ${formatCurrency(-closing)}`, tone: "negative" },
    );
  }

  return out;
}
