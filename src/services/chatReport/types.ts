/**
 * Data contract for the 1:1 chat monthly report (T-005).
 *
 * `data.ts` builds it, `insights.ts` and `charts.ts` read it, and
 * `template.ts` renders it. Every amount is in rupees, rounded to the paisa.
 *
 * Balance convention, used everywhere in the report: a POSITIVE balance means
 * the friend owes the viewer ("Summer owes you"), and a negative one means the
 * viewer owes the friend. Mixing conventions (BE-057) made the old report's
 * cards contradict each other.
 */

export type ReportTxStatus = "pending" | "verified" | "rejected";

export interface ReportPerson {
  id: string;
  name: string;
}

export interface ReportPeriod {
  year: number;
  /** 1–12 */
  month: number;
  /** "October 2026" */
  label: string;
  /** Inclusive start of the month in the viewer's timezone, as a UTC instant. */
  startUtc: string;
  /** Exclusive end of the month in the viewer's timezone, as a UTC instant. */
  endUtc: string;
  daysInMonth: number;
  /** Minutes added to UTC to reach the viewer's local time (+330 for IST). */
  tzOffsetMinutes: number;
}

export interface ReportLedgerRow {
  id: string;
  /** The viewer's local calendar date, "YYYY-MM-DD". */
  day: string;
  /** 1–31 in the viewer's calendar. */
  dayOfMonth: number;
  /** 0 = Sunday … 6 = Saturday, in the viewer's calendar. */
  weekday: number;
  remarks: string;
  amount: number;
  /** "gave": the viewer paid the friend. "received": the friend paid the viewer. */
  direction: "gave" | "received";
  status: ReportTxStatus;
  addedBy: "me" | "friend";
  /** Balance after this row, in the report convention. Rejected rows don't move it. */
  runningBalance: number;
}

export interface ReportStatusTotals {
  count: number;
  amount: number;
}

export interface ReportDaily {
  dayOfMonth: number;
  gave: number;
  received: number;
  count: number;
}

export interface ReportMonthNet {
  year: number;
  month: number;
  /** "Oct" */
  label: string;
  gave: number;
  received: number;
  /** received − gave for that month (positive = the balance moved in the viewer's favour). */
  net: number;
}

export interface ChatReportData {
  generatedAtUtc: string;
  period: ReportPeriod;
  me: ReportPerson;
  friend: ReportPerson;

  /** Balance carried in from all earlier months (report convention). */
  openingBalance: number;
  /** openingBalance + this month's movement from non-rejected rows. */
  closingBalance: number;

  /** Non-rejected totals for the month. */
  totals: {
    gave: number;
    received: number;
    /** received − gave */
    net: number;
    /** Non-rejected entries. */
    count: number;
    /** Distinct days with at least one non-rejected entry. */
    activeDays: number;
    addedByMe: number;
    addedByFriend: number;
  };

  byStatus: Record<ReportTxStatus, ReportStatusTotals>;

  /** Chronological (oldest first), INCLUDING rejected rows, which are shown as excluded. */
  ledger: ReportLedgerRow[];

  /** One entry per day of the month (1..daysInMonth); non-rejected only. */
  daily: ReportDaily[];

  /** Seven entries, index = weekday (0 = Sunday); non-rejected only. */
  weekday: { weekday: number; amount: number; count: number }[];

  /** The month before, when it has any activity; null otherwise. */
  previousMonth: { gave: number; received: number; net: number; count: number } | null;

  /** Up to 6 months ending with this one, oldest first, from the monthly summaries. */
  trend: ReportMonthNet[];
}

/** One insight sentence, ordered by importance. */
export interface ReportInsight {
  kind:
    | "balance"
    | "biggest"
    | "busiestDay"
    | "vsLastMonth"
    | "average"
    | "pending"
    | "rejected"
    | "whoAdded"
    | "trend"
    | "settle";
  /** Plain text. The template escapes it. */
  text: string;
  tone: "positive" | "negative" | "neutral" | "warning";
}
