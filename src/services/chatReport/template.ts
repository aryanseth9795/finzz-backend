/**
 * HTML for the 1:1 chat monthly report (T-005).
 *
 * One self-contained document: all CSS inline, no JavaScript, no external
 * fonts or images. It is rendered twice from the same string, in a WebView for
 * the in-app preview (phone width, ~380px) and by expo-print into an A4 PDF,
 * so the layout is fluid up to 820px and has explicit print/page-break rules.
 *
 * Every data-derived string (names, remarks, insight text, amounts) goes
 * through the auto-escaping `html` tag. The only `raw()` values are the SVG
 * strings built by charts.ts and the static stylesheet.
 */

import { html, raw, formatCurrency } from "../../utils/html.js";
import { balanceSentence } from "./insights.js";
import {
  balanceLineSvg,
  dailyBarsSvg,
  weekdayStripSvg,
  trendBarsSvg,
  CHART_COLORS,
} from "./charts.js";
import type {
  ChatReportData,
  ReportInsight,
  ReportLedgerRow,
  ReportTxStatus,
} from "./types.js";

const BRAND = "#4F46E5";
const WARNING = "#B45309";
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Amounts are rupees rounded to the paisa; anything smaller counts as zero. */
const EPSILON = 0.005;

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;

/** "2026-10-12" -> "12 Oct". Works on the string, no Date or locale. */
function shortDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : day;
}

/** The generation instant in the viewer's local time: "17 Oct 2026, 4:05 PM". */
function formatLocalDateTime(utcIso: string, tzOffsetMinutes: number): string {
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) return "";
  const local = new Date(ms + (tzOffsetMinutes || 0) * 60_000);
  const hours24 = local.getUTCHours();
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  const suffix = hours24 >= 12 ? "PM" : "AM";
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}, ${hours12}:${minutes} ${suffix}`;
}

/** "+₹250.00" / "−₹250.00" / "₹0.00" for the ledger's running balance. */
function signedCurrency(n: number): string {
  const v = round2(n);
  if (Math.abs(v) < EPSILON) return formatCurrency(0);
  return v > 0 ? `+${formatCurrency(v)}` : `−${formatCurrency(Math.abs(v))}`;
}

type Sign = "pos" | "neg" | "zero";
const signOf = (n: number): Sign =>
  Math.abs(n) < EPSILON ? "zero" : n > 0 ? "pos" : "neg";

function balanceCaption(balance: number, friendName: string): string {
  const s = signOf(balance);
  if (s === "pos") return `${friendName} owes you`;
  if (s === "neg") return `You owe ${friendName}`;
  return "Settled";
}

const STATUS_LABEL: Record<ReportTxStatus, string> = {
  verified: "Verified",
  pending: "Pending",
  rejected: "Rejected",
};

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const C = CHART_COLORS;

const STYLE = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: #ffffff;
  color: #111827;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page { max-width: 820px; margin: 0 auto; padding: 16px; }
.amt, td.num, .card .value, .chip .value { font-variant-numeric: tabular-nums; }
h2 {
  font-size: 15px;
  margin: 26px 0 10px;
  color: #111827;
  letter-spacing: 0.01em;
  break-after: avoid;
}
.muted { color: ${C.muted}; }

.hero {
  border-radius: 16px;
  padding: 20px 22px;
  background: linear-gradient(135deg, #EEF2FF 0%, #ffffff 70%);
  border: 1px solid #E0E7FF;
  break-inside: avoid;
}
.wordmark { color: ${BRAND}; font-weight: 800; font-size: 18px; letter-spacing: 0.02em; }
.hero-sentence { font-size: 28px; line-height: 1.2; font-weight: 800; margin: 10px 0 8px; }
.hero-sentence.pos { color: ${C.positive}; }
.hero-sentence.neg { color: ${C.negative}; }
.hero-sentence.zero { color: ${C.muted}; }
.hero-sub { font-size: 14px; color: #374151; }
.hero-asof { font-size: 12px; color: ${C.muted}; margin-top: 2px; }

.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.card {
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 12px 14px;
  background: #ffffff;
  break-inside: avoid;
}
.card .label { font-size: 12px; color: ${C.muted}; }
.card .value { font-size: 20px; font-weight: 700; margin: 2px 0; }
.card .note { font-size: 12px; color: ${C.muted}; }
.card.gave .value { color: ${C.gave}; }
.card.received .value { color: ${C.received}; }
.card .note.pos { color: ${C.positive}; }
.card .note.neg { color: ${C.negative}; }

.block {
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 12px;
  background: #ffffff;
  break-inside: avoid;
}
.block + .block { margin-top: 10px; }
.block svg { display: block; width: 100%; max-width: 100%; height: auto; }

.insights { list-style: none; margin: 0; padding: 0; }
.insight {
  border-left: 4px solid ${BRAND};
  background: #F9FAFB;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 8px;
  break-inside: avoid;
}
.insight.positive { border-left-color: ${C.positive}; }
.insight.negative { border-left-color: ${C.negative}; }
.insight.neutral { border-left-color: ${BRAND}; }
.insight.warning { border-left-color: ${WARNING}; }

.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: #374151; margin-top: 8px; }
.legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }
.swatch.gave { background: ${C.gave}; }
.swatch.received { background: ${C.received}; }

.chips { display: flex; flex-wrap: wrap; gap: 10px; }
.chip {
  flex: 1 1 140px;
  border: 1px solid #E5E7EB;
  border-radius: 12px;
  padding: 10px 14px;
  break-inside: avoid;
}
.chip .label { font-size: 12px; color: ${C.muted}; }
.chip .value { font-size: 17px; font-weight: 700; }
.chip .sub { font-size: 12px; color: ${C.muted}; }
.bar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: #E5E7EB; margin-top: 12px; }
.bar .seg-verified { background: ${C.received}; }
.bar .seg-pending { background: ${WARNING}; }
.bar-legend { margin-top: 6px; }

.table-wrap { overflow-x: auto; }
table.ledger { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 620px; }
.ledger thead { display: table-header-group; }
.ledger tfoot { display: table-footer-group; }
.ledger th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #ffffff;
  background: ${BRAND};
  padding: 8px 8px;
}
.ledger th.num, .ledger td.num { text-align: right; white-space: nowrap; }
.ledger td { padding: 7px 8px; border-bottom: 1px solid #E5E7EB; vertical-align: top; }
.ledger tr { break-inside: avoid; page-break-inside: avoid; }
.ledger tbody tr:nth-child(even) td { background: #F9FAFB; }
.ledger td.gave { color: ${C.gave}; }
.ledger td.received { color: ${C.received}; }
.ledger td.details { word-break: break-word; }
.ledger tr.struck td { text-decoration: line-through; color: ${C.muted}; }
.ledger tr.struck td.status { text-decoration: none; }
.ledger tr.struck td.gave, .ledger tr.struck td.received { color: ${C.muted}; }
.ledger td.empty { text-align: center; color: ${C.muted}; padding: 22px 8px; }
.badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 8px;
  text-decoration: none;
}
.badge.verified { background: #DCFCE7; color: #166534; }
.badge.pending { background: #FEF3C7; color: #92400E; }
.badge.rejected { background: #F3F4F6; color: #4B5563; }

.footer {
  margin-top: 28px;
  padding-top: 12px;
  border-top: 1px solid #E5E7EB;
  font-size: 11px;
  color: ${C.muted};
  break-inside: avoid;
}
.footer .brand { color: ${BRAND}; font-weight: 700; }

@media (max-width: 639px) {
  .cards { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 520px) {
  .page { padding: 12px; }
  .cards { grid-template-columns: 1fr; }
  .hero-sentence { font-size: 24px; }
}
@media print {
  .page { max-width: none; padding: 0; }
  .cards { grid-template-columns: repeat(4, 1fr); }
  .table-wrap { overflow: visible; }
  table.ledger { min-width: 0; }
}
`;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function heroSection(data: ChatReportData): string {
  const sentence = balanceSentence(data.closingBalance, data.friend.name);
  const sign = signOf(data.closingBalance);
  return html`<header class="hero">
  <div class="wordmark">Finzz</div>
  <div class="hero-sentence ${sign}">${sentence}</div>
  <div class="hero-sub">${data.me.name} &amp; ${data.friend.name} · ${data.period.label}</div>
  <div class="hero-asof">as of the end of ${data.period.label}</div>
</header>`;
}

function balanceCard(label: string, balance: number, friendName: string): string {
  const v = round2(balance);
  const sign = signOf(v);
  return html`<div class="card balance">
    <div class="label">${label}</div>
    <div class="value amt">${formatCurrency(Math.abs(v))}</div>
    <div class="note ${sign}">${balanceCaption(v, friendName)}</div>
  </div>`;
}

function flowCard(
  kind: "gave" | "received",
  label: string,
  amount: number,
  count: number,
): string {
  return html`<div class="card ${kind}">
    <div class="label">${label}</div>
    <div class="value amt">${formatCurrency(round2(amount))}</div>
    <div class="note">${count} ${count === 1 ? "entry" : "entries"}</div>
  </div>`;
}

function glanceSection(data: ChatReportData): string {
  const active = data.ledger.filter((r) => r.status !== "rejected");
  const gaveCount = active.filter((r) => r.direction === "gave").length;
  const receivedCount = active.filter((r) => r.direction === "received").length;
  const name = data.friend.name;
  return html`<section>
  <h2>Month at a glance</h2>
  <div class="cards">
    ${raw(balanceCard("Opening balance", data.openingBalance, name))}
    ${raw(flowCard("gave", "You gave", data.totals.gave, gaveCount))}
    ${raw(flowCard("received", "You received", data.totals.received, receivedCount))}
    ${raw(balanceCard("Closing balance", data.closingBalance, name))}
  </div>
</section>`;
}

function journeySection(data: ChatReportData): string {
  return html`<section>
  <h2>Balance journey</h2>
  <div class="block">${raw(balanceLineSvg(data))}</div>
</section>`;
}

function insightsSection(insights: ReportInsight[]): string {
  // The hero already states the balance, so that insight is not repeated.
  const shown = insights.filter((i) => i.kind !== "balance");
  if (shown.length === 0) return "";
  const items = shown.map(
    (i) => raw(html`<li class="insight ${i.tone}">${i.text}</li>`),
  );
  return html`<section>
  <h2>Insights</h2>
  <ul class="insights">${items}</ul>
</section>`;
}

function activitySection(data: ChatReportData): string {
  return html`<section>
  <h2>Activity</h2>
  <div class="block">
    ${raw(dailyBarsSvg(data))}
    <div class="legend">
      <span><span class="swatch gave"></span>You gave</span>
      <span><span class="swatch received"></span>You received</span>
    </div>
  </div>
  <div class="block">${raw(weekdayStripSvg(data))}</div>
</section>`;
}

function trendSection(data: ChatReportData): string {
  if (data.trend.length < 2) return "";
  return html`<section>
  <h2>6-month trend</h2>
  <div class="block">${raw(trendBarsSvg(data))}</div>
</section>`;
}

function verificationSection(data: ChatReportData): string {
  const { verified, pending, rejected } = data.byStatus;
  const vAmt = Math.max(0, verified.amount);
  const pAmt = Math.max(0, pending.amount);
  const total = vAmt + pAmt;
  const vPct = total > 0 ? Math.round((vAmt / total) * 1000) / 10 : 0;
  const pPct = total > 0 ? Math.round((100 - vPct) * 10) / 10 : 0;
  return html`<section>
  <h2>Verification health</h2>
  <div class="chips">
    <div class="chip">
      <div class="label">Verified</div>
      <div class="value amt">${formatCurrency(round2(verified.amount))}</div>
      <div class="sub">${verified.count} ${verified.count === 1 ? "entry" : "entries"}</div>
    </div>
    <div class="chip">
      <div class="label">Pending</div>
      <div class="value amt">${formatCurrency(round2(pending.amount))}</div>
      <div class="sub">${pending.count} ${pending.count === 1 ? "entry" : "entries"}</div>
    </div>
    <div class="chip">
      <div class="label">Rejected</div>
      <div class="value">${rejected.count}</div>
      <div class="sub">excluded</div>
    </div>
  </div>
  <div class="bar" role="img" aria-label="Verified versus pending amounts">
    <div class="seg-verified" style="width:${vPct}%"></div>
    <div class="seg-pending" style="width:${pPct}%"></div>
  </div>
  <div class="legend bar-legend">
    <span><span class="swatch received"></span>Verified</span>
    <span><span class="swatch" style="background:${WARNING}"></span>Pending</span>
  </div>
</section>`;
}

function ledgerRow(r: ReportLedgerRow, friendName: string): string {
  const rejected = r.status === "rejected";
  const amount = formatCurrency(round2(r.amount));
  return html`<tr class="${rejected ? "struck" : ""}">
    <td>${shortDate(r.day)}</td>
    <td class="details">${r.remarks && r.remarks.trim() ? r.remarks : "—"}</td>
    <td>${r.addedBy === "me" ? "You" : friendName}</td>
    <td class="num gave">${r.direction === "gave" ? amount : ""}</td>
    <td class="num received">${r.direction === "received" ? amount : ""}</td>
    <td class="status"><span class="badge ${r.status}">${STATUS_LABEL[r.status]}</span></td>
    <td class="num">${signedCurrency(r.runningBalance)}</td>
  </tr>`;
}

function ledgerSection(data: ChatReportData): string {
  const rows =
    data.ledger.length === 0
      ? [raw(html`<tr><td class="empty" colspan="7">No entries this month</td></tr>`)]
      : data.ledger.map((r) => raw(ledgerRow(r, data.friend.name)));
  return html`<section>
  <h2>Full Ledger</h2>
  <div class="table-wrap">
    <table class="ledger">
      <thead>
        <tr>
          <th>Date</th>
          <th>Details</th>
          <th>Added by</th>
          <th class="num">Gave</th>
          <th class="num">Received</th>
          <th>Status</th>
          <th class="num">Balance</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
</section>`;
}

function footerSection(data: ChatReportData): string {
  const when = formatLocalDateTime(data.generatedAtUtc, data.period.tzOffsetMinutes);
  return html`<footer class="footer">
  Generated ${when} · Pending entries count toward totals until they are verified or rejected; rejected entries never do. · <span class="brand">Finzz</span>
</footer>`;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function renderChatReportHtml(
  data: ChatReportData,
  insights: ReportInsight[],
): string {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finzz report · ${data.friend.name} · ${data.period.label}</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<div class="page">
${raw(heroSection(data))}
${raw(glanceSection(data))}
${raw(journeySection(data))}
${raw(insightsSection(insights))}
${raw(activitySection(data))}
${raw(trendSection(data))}
${raw(verificationSection(data))}
${raw(ledgerSection(data))}
${raw(footerSection(data))}
</div>
</body>
</html>`;
}
