import { describe, it, expect } from "vitest";
import { renderChatReportHtml } from "../src/services/chatReport/template.js";
import type {
  ChatReportData,
  ReportInsight,
  ReportLedgerRow,
} from "../src/services/chatReport/types.js";

const XSS_NAME = "<script>alert(1)</script>";
const XSS_REMARK = "<img src=x onerror=alert(1)>";

function row(over: Partial<ReportLedgerRow>): ReportLedgerRow {
  return {
    id: "r1",
    day: "2026-10-12",
    dayOfMonth: 12,
    weekday: 1,
    remarks: "Rent",
    amount: 1000,
    direction: "gave",
    status: "verified",
    addedBy: "me",
    runningBalance: -1000,
    ...over,
  };
}

function makeData(over: Partial<ChatReportData> = {}): ChatReportData {
  const daily = Array.from({ length: 31 }, (_, i) => ({
    dayOfMonth: i + 1,
    gave: i === 11 ? 1000 : 0,
    received: i === 17 ? 500 : 0,
    count: i === 11 || i === 17 ? 1 : 0,
  }));
  return {
    generatedAtUtc: "2026-10-17T10:35:00.000Z",
    period: {
      year: 2026,
      month: 10,
      label: "October 2026",
      startUtc: "2026-09-30T18:30:00.000Z",
      endUtc: "2026-10-31T18:30:00.000Z",
      daysInMonth: 31,
      tzOffsetMinutes: 330,
    },
    me: { id: "u1", name: "Aryan" },
    friend: { id: "u2", name: "Summer" },
    openingBalance: 250,
    closingBalance: -250,
    totals: {
      gave: 1000,
      received: 500,
      net: -500,
      count: 2,
      activeDays: 2,
      addedByMe: 1,
      addedByFriend: 1,
    },
    byStatus: {
      verified: { count: 1, amount: 1000 },
      pending: { count: 1, amount: 500 },
      rejected: { count: 1, amount: 300 },
    },
    ledger: [
      row({ id: "a", remarks: "Rent", runningBalance: -750 }),
      row({
        id: "b",
        day: "2026-10-18",
        dayOfMonth: 18,
        weekday: 6,
        remarks: "Dinner",
        amount: 500,
        direction: "received",
        status: "pending",
        addedBy: "friend",
        runningBalance: -250,
      }),
      row({
        id: "c",
        day: "2026-10-19",
        dayOfMonth: 19,
        remarks: "Mistake",
        amount: 300,
        status: "rejected",
        runningBalance: -250,
      }),
    ],
    daily,
    weekday: Array.from({ length: 7 }, (_, i) => ({
      weekday: i,
      amount: i === 1 ? 1000 : i === 6 ? 500 : 0,
      count: i === 1 || i === 6 ? 1 : 0,
    })),
    previousMonth: { gave: 800, received: 400, net: -400, count: 3 },
    trend: [
      { year: 2026, month: 8, label: "Aug", gave: 100, received: 300, net: 200 },
      { year: 2026, month: 9, label: "Sep", gave: 800, received: 400, net: -400 },
      { year: 2026, month: 10, label: "Oct", gave: 1000, received: 500, net: -500 },
    ],
    ...over,
  };
}

const insights: ReportInsight[] = [
  { kind: "balance", text: "BALANCE-KIND-SENTENCE", tone: "negative" },
  { kind: "biggest", text: "Biggest entry: ₹1,000.00 on 12 Oct (Rent).", tone: "neutral" },
  { kind: "pending", text: "₹500.00 is still waiting to be verified.", tone: "warning" },
  { kind: "trend", text: "<b>hostile insight</b>", tone: "positive" },
];

describe("renderChatReportHtml", () => {
  it("is a complete HTML document with meta tags and @page", () => {
    const out = renderChatReportHtml(makeData(), insights);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('name="viewport"');
    expect(out).toContain("@page");
    expect(out).toContain("size: A4");
    expect(out).toContain("tabular-nums");
    expect(out).toContain("table-header-group");
  });

  it("renders every section heading", () => {
    const out = renderChatReportHtml(makeData(), insights);
    for (const h of [
      "Month at a glance",
      "Balance journey",
      "Insights",
      "Activity",
      "6-month trend",
      "Verification",
      "Ledger",
    ]) {
      expect(out).toContain(h);
    }
  });

  it("omits the trend section when fewer than 2 months", () => {
    const data = makeData();
    data.trend = data.trend.slice(0, 1);
    const out = renderChatReportHtml(data, insights);
    expect(out).not.toContain("6-month trend");
    expect(renderChatReportHtml(makeData({ trend: [] }), insights)).not.toContain(
      "6-month trend",
    );
  });

  it("shows the hero in plain words and the card captions", () => {
    const out = renderChatReportHtml(makeData(), insights);
    expect(out).toContain("You owe Summer");
    expect(out).toContain("Summer owes you"); // opening balance caption (+250)
    expect(out).toContain("Aryan &amp; Summer");
    expect(out).toContain("as of 17 Oct 2026");
    expect(out).not.toContain("end of October 2026");
    expect(out).toContain("₹250.00");
  });

  it("hero says 'at the end of September 2026' for a past month", () => {
    const out = renderChatReportHtml(
      makeData({
        period: {
          year: 2026,
          month: 9,
          label: "September 2026",
          startUtc: "2026-08-31T18:30:00.000Z",
          endUtc: "2026-09-30T18:30:00.000Z",
          daysInMonth: 30,
          tzOffsetMinutes: 330,
        },
      }),
      insights,
    );
    expect(out).toContain("at the end of September 2026");
    expect(out).not.toContain("as of 17 Oct 2026");
  });

  it("says Settled for a zero balance", () => {
    const out = renderChatReportHtml(
      makeData({ openingBalance: 0, closingBalance: 0 }),
      insights,
    );
    expect(out).toContain("Settled");
  });

  it("skips the balance insight but renders the others", () => {
    const out = renderChatReportHtml(makeData(), insights);
    expect(out).not.toContain("BALANCE-KIND-SENTENCE");
    expect(out).toContain("Biggest entry");
  });

  it("escapes hostile names, remarks and insight text", () => {
    const data = makeData({
      friend: { id: "u2", name: XSS_NAME },
      me: { id: "u1", name: XSS_REMARK },
      ledger: [row({ remarks: XSS_REMARK })],
    });
    const out = renderChatReportHtml(data, [
      { kind: "trend", text: XSS_NAME, tone: "neutral" },
    ]);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src&#61;x onerror&#61;alert(1)&gt;");
  });

  it("contains no <script at all, even with normal data", () => {
    expect(renderChatReportHtml(makeData(), insights)).not.toContain("<script");
  });

  it("strikes rejected rows and badges the statuses", () => {
    const out = renderChatReportHtml(makeData(), insights);
    expect(out).toMatch(/<tr class="[^"]*\bstruck\b[^"]*">/);
    expect(out.match(/class="[^"]*\bstruck\b/g)).toHaveLength(1);
    for (const s of ["Verified", "Pending", "Rejected"]) expect(out).toContain(s);
  });

  it("explains the sign of the Balance column with a caption", () => {
    const out = renderChatReportHtml(makeData(), insights);
    expect(out).toContain("Balance: + means Summer owes you, − means you owe Summer");
    const hostile = renderChatReportHtml(makeData({ friend: { id: "u2", name: XSS_NAME } }), insights);
    expect(hostile).not.toContain("<script");
  });

  it("does not strike through the Balance cell of a rejected row", () => {
    const out = renderChatReportHtml(makeData(), insights);
    const tr = /<tr class="[^"]*\bstruck\b[^"]*">([\s\S]*?)<\/tr>/.exec(out)![1];
    const cells = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g)!;
    const balanceCell = cells[cells.length - 1];
    expect(balanceCell).toMatch(/class="[^"]*\bbalance\b[^"]*"/);
    // The stylesheet must switch the line-through off for that cell.
    const rule = /\.ledger tr\.struck td\.balance\s*\{([^}]*)\}/.exec(out);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/text-decoration:\s*none/);
  });

  it("formats ledger dates as '12 Oct' and uses a dash for empty remarks", () => {
    const out = renderChatReportHtml(
      makeData({ ledger: [row({ remarks: "" })] }),
      insights,
    );
    expect(out).toContain("12 Oct");
    expect(out).toContain("—");
  });

  it("shows an empty-state row for a month with no entries", () => {
    const out = renderChatReportHtml(makeData({ ledger: [] }), insights);
    expect(out).toContain("No entries this month");
  });

  it("shows the footer time in the viewer's timezone", () => {
    const out = renderChatReportHtml(makeData(), insights);
    expect(out).toContain("Generated 17 Oct 2026, 4:05 PM");
    expect(out).toContain("rejected entries never do");
  });

  it("handles the day rollover and midnight/noon in local time", () => {
    const late = renderChatReportHtml(
      makeData({ generatedAtUtc: "2026-10-31T20:00:00.000Z" }),
      insights,
    );
    expect(late).toContain("Generated 1 Nov 2026, 1:30 AM");
    const noon = renderChatReportHtml(
      makeData({ generatedAtUtc: "2026-10-17T06:30:00.000Z" }),
      insights,
    );
    expect(noon).toContain("Generated 17 Oct 2026, 12:00 PM");
    const midnight = renderChatReportHtml(
      makeData({ generatedAtUtc: "2026-10-16T18:30:00.000Z" }),
      insights,
    );
    expect(midnight).toContain("Generated 17 Oct 2026, 12:00 AM");
  });

  it("contains no phone-number-looking strings", () => {
    const out = renderChatReportHtml(makeData(), insights);
    expect(out).not.toMatch(/\+\d{2}/);
    expect(out).not.toMatch(/\d{10}/);
  });
});
