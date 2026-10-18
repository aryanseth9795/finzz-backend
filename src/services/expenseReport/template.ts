/**
 * HTML for the monthly expense report / PDF export (T007-E6).
 *
 * One self-contained document: all CSS inline, no JavaScript, no external
 * fonts or images, so it renders identically in the in-app WebView and in the
 * A4 PDF produced by expo-print. Same visual language as the chat report
 * (src/services/chatReport/template.ts): neutral first, spend in indigo,
 * income in teal, red/green only for small signals.
 *
 * Every data-derived string (names, remarks, categories, amounts) goes through
 * the auto-escaping `html` tag. The only `raw()` values are fragments built by
 * this file itself (SVG strings, the static stylesheet, composed sections).
 *
 * All days in `ExpenseReportData` are already in the USER's calendar
 * ("YYYY-MM-DD"); nothing here touches the server's timezone.
 */

import { html, raw, escapeHtml, formatCurrency } from "../../utils/html.js";

export interface ExpenseReportTx {
  /** User-local calendar day, "YYYY-MM-DD". */
  day: string;
  remarks: string;
  category: string;
  amount: number;
  type: "debit" | "credit";
}

export interface ExpenseReportData {
  userName: string;
  period: {
    year: number;
    month: number;
    /** "October 2026" */
    label: string;
    daysInMonth: number;
    tzOffsetMinutes: number;
  };
  status: "open" | "closed";
  generatedAtUtc: string;
  totals: {
    /** Sum of debits. */
    spent: number;
    /** Sum of credits. */
    received: number;
    net: number;
    /** net / received * 100, or null when nothing was received. */
    savingsRate: number | null;
    /** Days on which something was spent. */
    activeDays: number;
    avgPerActiveDay: number;
    txCount: number;
  };
  /** Debits only, ranked by total desc. pct is of the debit sum. */
  categories: { name: string; total: number; count: number; pct: number }[];
  /** Largest debits, at most 5. pct is of the debit sum. */
  top: {
    label: string;
    category: string;
    day: string;
    amount: number;
    pct: number;
  }[];
  /** One entry per day of the month (1..daysInMonth). */
  daily: { day: number; debit: number; credit: number }[];
  transactions: ExpenseReportTx[];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const COLORS = {
  spend: "#4F46E5",
  income: "#0D9488",
  muted: "#64748B",
  grid: "#E2E8F0",
  ink: "#111827",
  positive: "#059669",
  negative: "#E11D48",
  other: "#94A3B8",
};

/** Categorical palette: indigo family first, then calm distinct hues. */
const CATEGORY_COLORS = [
  "#4F46E5", "#0D9488", "#7C3AED", "#0EA5E9",
  "#D97706", "#DB2777", "#65A30D",
];
const MAX_DONUT_SLICES = CATEGORY_COLORS.length;

const FONT = "Helvetica, Arial, sans-serif";
const EPSILON = 0.005;

const round2 = (n: number): number => Math.round((Number(n) || 0) * 100) / 100;
const r1 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const colorFor = (i: number): string => CATEGORY_COLORS[i] ?? COLORS.other;

/** "2026-10-12" -> "12 Oct". Works on the string: no Date, no locale. */
function shortDate(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : day;
}

/** "17 Oct 2026, 4:05 PM (UTC+05:30)" in the user's frame. */
function formatLocalDateTime(utcIso: string, tzOffsetMinutes: number): string {
  const ms = Date.parse(utcIso);
  if (Number.isNaN(ms)) return "";
  const tz = tzOffsetMinutes || 0;
  const local = new Date(ms + tz * 60_000);
  const h24 = local.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(local.getUTCMinutes()).padStart(2, "0");
  const sign = tz < 0 ? "-" : "+";
  const abs = Math.abs(tz);
  const off = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()}, ${h12}:${mm} ${h24 >= 12 ? "PM" : "AM"} (${off})`;
}

/** Compact amount for axes: ₹850, ₹1.5K, ₹2.0L, ₹1.2Cr. */
function abbrev(value: number): string {
  const a = Math.abs(Number.isFinite(value) ? value : 0);
  if (a >= 1e7) return `₹${(a / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `₹${(a / 1e5).toFixed(1)}L`;
  if (a >= 1e3) return `₹${(a / 1e3).toFixed(1)}K`;
  return formatCurrency(a).replace(/\.00$/, "");
}

const signedCurrency = (n: number): string => {
  const v = round2(n);
  if (Math.abs(v) < EPSILON) return formatCurrency(0);
  return v > 0 ? `+${formatCurrency(v)}` : `−${formatCurrency(Math.abs(v))}`;
};

// ---------------------------------------------------------------------------
// SVG charts
// ---------------------------------------------------------------------------

/** Donut of category shares (top slices, the rest merged into "Others"). */
function donutSvg(data: ExpenseReportData): string {
  const cx = 110;
  const cy = 110;
  const r = 80;
  const stroke = 30;
  const circ = 2 * Math.PI * r;

  const total = data.categories.reduce((s, c) => s + c.total, 0);
  const slices = data.categories.slice(0, MAX_DONUT_SLICES).map((c, i) => ({
    value: c.total,
    color: colorFor(i),
  }));
  const restTotal = data.categories
    .slice(MAX_DONUT_SLICES)
    .reduce((s, c) => s + c.total, 0);
  if (restTotal > 0) slices.push({ value: restTotal, color: COLORS.other });

  let offset = 0;
  const arcs = total > 0
    ? slices
        .map((s) => {
          const len = (s.value / total) * circ;
          const arc =
            `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" ` +
            `stroke-width="${stroke}" stroke-dasharray="${r1(len)} ${r1(circ - len)}" ` +
            `stroke-dashoffset="${r1(-offset)}" transform="rotate(-90 ${cx} ${cy})"/>`;
          offset += len;
          return arc;
        })
        .join("")
    : "";

  return (
    `<svg viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" role="img" ` +
    `aria-label="Spending by category" style="max-width:220px">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${COLORS.grid}" stroke-width="${stroke}"/>` +
    arcs +
    `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="${FONT}" font-size="11" fill="${COLORS.muted}">Spent</text>` +
    `<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="${FONT}" font-size="17" font-weight="700" fill="${COLORS.ink}">${escapeHtml(abbrev(total))}</text>` +
    `</svg>`
  );
}

/** One grouped bar pair (spent, received) per day of the month. */
function dailyBarsSvg(data: ExpenseReportData): string {
  const W = 700;
  const H = 200;
  const left = 46;
  const right = 8;
  const top = 14;
  const bottom = 26;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const days = data.daily.length;
  const max = Math.max(1, ...data.daily.map((d) => Math.max(d.debit, d.credit)));
  const hasData = data.daily.some((d) => d.debit > 0 || d.credit > 0);

  const head =
    `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" ` +
    `aria-label="Daily spending and income">`;
  if (!hasData || days === 0) {
    return (
      head +
      `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-family="${FONT}" font-size="14" fill="${COLORS.muted}">No activity this month</text></svg>`
    );
  }

  const y = (v: number): number => top + plotH - (v / max) * plotH;
  const slot = plotW / days;
  const barW = Math.max(1.5, Math.min(14, slot * 0.38));

  let grid = "";
  for (const frac of [0, 0.5, 1]) {
    const gy = r1(y(max * frac));
    grid +=
      `<line x1="${left}" x2="${W - right}" y1="${gy}" y2="${gy}" stroke="${COLORS.grid}" stroke-width="1"/>` +
      `<text x="${left - 6}" y="${r1(gy + 4)}" text-anchor="end" font-family="${FONT}" font-size="10" fill="${COLORS.muted}">${escapeHtml(abbrev(max * frac))}</text>`;
  }

  let bars = "";
  let labels = "";
  data.daily.forEach((d, i) => {
    const mid = left + slot * i + slot / 2;
    const bar = (v: number, x: number, color: string): string => {
      if (v <= 0) return "";
      const h = Math.max(1, (v / max) * plotH);
      return `<rect data-bar-day="${d.day}" x="${r1(x)}" y="${r1(top + plotH - h)}" width="${r1(barW)}" height="${r1(h)}" rx="1.5" fill="${color}"/>`;
    };
    bars += bar(d.debit, mid - barW - 0.5, COLORS.spend);
    bars += bar(d.credit, mid + 0.5, COLORS.income);
    if (d.day === 1 || d.day % 5 === 0 || d.day === days) {
      labels += `<text x="${r1(mid)}" y="${H - 8}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="${COLORS.muted}">${d.day}</text>`;
    }
  });

  return head + grid + bars + labels + `</svg>`;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const STYLE = `
@page { size: A4; margin: 14mm 12mm; }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: #ffffff;
  color: ${COLORS.ink};
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  font-variant-numeric: tabular-nums;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page { max-width: 820px; margin: 0 auto; padding: 16px; }
h2 { font-size: 15px; margin: 26px 0 10px; letter-spacing: 0.01em; break-after: avoid; }
.muted { color: ${COLORS.muted}; }

.hero {
  border-radius: 16px;
  padding: 20px 22px;
  background: linear-gradient(135deg, #EEF2FF 0%, #ffffff 70%);
  border: 1px solid #E0E7FF;
  break-inside: avoid;
}
.wordmark { color: ${COLORS.spend}; font-weight: 800; font-size: 18px; letter-spacing: 0.02em; }
.hero-sentence { font-size: 28px; line-height: 1.2; font-weight: 800; margin: 10px 0 8px; }
.hero-sentence.neutral { color: ${COLORS.ink}; }
.hero-sub { font-size: 14px; color: #374151; }
.pill {
  display: inline-block;
  margin-top: 10px;
  font-size: 12px;
  font-weight: 700;
  border-radius: 999px;
  padding: 3px 10px;
  background: #F3F4F6;
  color: #374151;
}
.pill.pos { background: #DCFCE7; color: #166534; }
.pill.neg { background: #FFE4E6; color: #9F1239; }

.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.card { border: 1px solid #E5E7EB; border-radius: 12px; padding: 12px 14px; break-inside: avoid; }
.card .label { font-size: 12px; color: ${COLORS.muted}; }
.card .value { font-size: 20px; font-weight: 700; margin: 2px 0; }
.card .note { font-size: 12px; color: ${COLORS.muted}; }
.card.spent .value { color: ${COLORS.spend}; }
.card.received .value { color: ${COLORS.income}; }

.block { border: 1px solid #E5E7EB; border-radius: 12px; padding: 12px; break-inside: avoid; }
.block svg { display: block; width: 100%; max-width: 100%; height: auto; }
.legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: #374151; margin-top: 8px; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }

.cat-layout { display: flex; gap: 18px; align-items: center; }
.cat-donut { flex: 0 0 200px; }
.cat-donut svg { margin: 0 auto; }
.cat-table { flex: 1 1 auto; min-width: 0; }

table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
thead { display: table-header-group; }
th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: ${COLORS.muted};
  padding: 6px 8px;
  border-bottom: 1px solid #CBD5E1;
}
th.num, td.num { text-align: right; white-space: nowrap; }
td { padding: 7px 8px; border-bottom: 1px solid #E5E7EB; vertical-align: middle; }
tr { break-inside: avoid; page-break-inside: avoid; }
td.name { word-break: break-word; }
td.empty { text-align: center; color: ${COLORS.muted}; padding: 20px 8px; }
.track { height: 8px; border-radius: 4px; background: #EEF2F7; overflow: hidden; min-width: 60px; }
.fill { height: 100%; border-radius: 4px; }

.top-item { display: flex; gap: 12px; align-items: center; padding: 8px 0; border-bottom: 1px solid #E5E7EB; break-inside: avoid; }
.top-item:last-child { border-bottom: 0; }
.rank { flex: 0 0 26px; height: 26px; border-radius: 999px; background: #EEF2FF; color: ${COLORS.spend}; font-weight: 700; font-size: 12px; text-align: center; line-height: 26px; }
.top-main { flex: 1 1 auto; min-width: 0; }
.top-name { font-weight: 600; word-break: break-word; }
.top-meta { font-size: 12px; color: ${COLORS.muted}; }
.top-amt { flex: 0 0 auto; text-align: right; font-weight: 700; }
.top-amt small { display: block; font-weight: 400; color: ${COLORS.muted}; font-size: 12px; }
.top-main .track { margin-top: 5px; }

table.tx td.debit { color: ${COLORS.ink}; }
table.tx td.credit { color: ${COLORS.income}; font-weight: 600; }
table.tx tbody tr:nth-child(even) td { background: #F9FAFB; }
.badge { display: inline-block; font-size: 10.5px; font-weight: 600; border-radius: 999px; padding: 1px 8px; background: #EEF2FF; color: #3730A3; }
.badge.credit { background: #CCFBF1; color: #115E59; }

.footer { margin-top: 28px; padding-top: 12px; border-top: 1px solid #E5E7EB; font-size: 11px; color: ${COLORS.muted}; break-inside: avoid; }
.footer .brand { color: ${COLORS.spend}; font-weight: 700; }

@media (max-width: 639px) {
  .cards { grid-template-columns: repeat(2, 1fr); }
  .cat-layout { flex-direction: column; align-items: stretch; }
  .cat-donut { flex-basis: auto; }
}
@media (max-width: 520px) {
  .page { padding: 12px; }
  .cards { grid-template-columns: 1fr; }
  .hero-sentence { font-size: 24px; }
}
@media print {
  .page { max-width: none; padding: 0; }
  .cards { grid-template-columns: repeat(4, 1fr); }
  .cat-layout { flex-direction: row; }
}
`;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * With no income there is nothing to "overspend" against, so the headline is
 * a neutral statement of spend (shown in the neutral ink colour).
 */
function heroSentence(totals: ExpenseReportData["totals"], label: string): string {
  if (round2(totals.received) < EPSILON) {
    return `You spent ${formatCurrency(round2(totals.spent))} in ${label}`;
  }
  const net = totals.net;
  const v = round2(Math.abs(net));
  if (v < EPSILON) return `You broke even in ${label}`;
  return net > 0
    ? `You saved ${formatCurrency(v)} in ${label}`
    : `You overspent by ${formatCurrency(v)} in ${label}`;
}

function heroSection(data: ExpenseReportData): string {
  const { totals, period } = data;
  const rate = totals.savingsRate;
  const neutral = round2(totals.received) < EPSILON;
  const pill =
    rate === null
      ? html`<span class="pill">No income recorded</span>`
      : html`<span class="pill ${rate >= 0 ? "pos" : "neg"}">Savings rate ${r1(rate)}%</span>`;
  return html`<header class="hero">
  <div class="wordmark">Finzz</div>
  <div class="hero-sentence${neutral ? " neutral" : ""}">${heroSentence(totals, period.label)}</div>
  <div class="hero-sub">${data.userName} · ${period.label} · ${data.status === "closed" ? "Closed" : "Open"}</div>
  ${raw(pill)}
</header>`;
}

function cardsSection(data: ExpenseReportData): string {
  const t = data.totals;
  const debitCount = data.transactions.filter((x) => x.type === "debit").length;
  const creditCount = data.transactions.length - debitCount;
  const count = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;
  return html`<section>
  <div class="cards">
    <div class="card spent"><div class="label">Spent</div><div class="value">${formatCurrency(round2(t.spent))}</div><div class="note">${count(debitCount)}</div></div>
    <div class="card received"><div class="label">Received</div><div class="value">${formatCurrency(round2(t.received))}</div><div class="note">${count(creditCount)}</div></div>
    <div class="card net"><div class="label">Net</div><div class="value">${signedCurrency(t.net)}</div><div class="note">${t.net >= EPSILON ? "Saved" : t.net <= -EPSILON ? "Overspent" : "Even"}</div></div>
    <div class="card avg"><div class="label">Average per active day</div><div class="value">${formatCurrency(round2(t.avgPerActiveDay))}</div><div class="note">${t.activeDays} ${t.activeDays === 1 ? "day" : "days"} with spending</div></div>
  </div>
</section>`;
}

function categoryRow(
  c: ExpenseReportData["categories"][number],
  i: number,
): string {
  const color = colorFor(i);
  return html`<tr data-cat="${c.name}" data-pct="${c.pct}">
    <td class="name"><span class="swatch" style="background:${color}"></span>${c.name}</td>
    <td class="num">${c.count}</td>
    <td><div class="track"><div class="fill" style="width:${Math.min(100, Math.max(0, c.pct))}%;background:${color}"></div></div></td>
    <td class="num">${c.pct}%</td>
    <td class="num">${formatCurrency(round2(c.total))}</td>
  </tr>`;
}

function categoriesSection(data: ExpenseReportData): string {
  if (data.categories.length === 0) {
    return html`<section>
  <h2>Spending by category</h2>
  <div class="block muted">No spending this month.</div>
</section>`;
  }
  const rows = data.categories.map((c, i) => raw(categoryRow(c, i)));
  return html`<section>
  <h2>Spending by category</h2>
  <div class="block">
    <div class="cat-layout">
      <div class="cat-donut">${raw(donutSvg(data))}</div>
      <div class="cat-table">
        <table>
          <thead><tr><th>Category</th><th class="num">Entries</th><th>Share</th><th class="num">%</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  </div>
</section>`;
}

function topSection(data: ExpenseReportData): string {
  if (data.top.length === 0) return "";
  const max = Math.max(...data.top.map((t) => t.amount), 1);
  const items = data.top.map((t, i) =>
    raw(html`<div class="top-item">
    <div class="rank">${i + 1}</div>
    <div class="top-main">
      <div class="top-name">${t.label}</div>
      <div class="top-meta">${t.category} · ${shortDate(t.day)}</div>
      <div class="track"><div class="fill" style="width:${r1((t.amount / max) * 100)}%;background:${COLORS.spend}"></div></div>
    </div>
    <div class="top-amt">${formatCurrency(round2(t.amount))}<small>${t.pct}% of spend</small></div>
  </div>`),
  );
  return html`<section>
  <h2>Top 5 expenses</h2>
  <div class="block">${items}</div>
</section>`;
}

function activitySection(data: ExpenseReportData): string {
  return html`<section>
  <h2>Daily activity</h2>
  <div class="block">
    ${raw(dailyBarsSvg(data))}
    <div class="legend">
      <span><span class="swatch" style="background:${COLORS.spend}"></span>Spent</span>
      <span><span class="swatch" style="background:${COLORS.income}"></span>Received</span>
    </div>
  </div>
</section>`;
}

function txRow(t: ExpenseReportTx): string {
  const amount = formatCurrency(round2(t.amount));
  const credit = t.type === "credit";
  return html`<tr class="${t.type}" data-day="${t.day}">
    <td>${shortDate(t.day)}</td>
    <td class="name">${t.remarks && t.remarks.trim() ? t.remarks : "—"}</td>
    <td>${t.category}</td>
    <td class="num ${t.type}">${credit ? "+" : "−"}${amount}</td>
  </tr>`;
}

function transactionsSection(data: ExpenseReportData): string {
  const rows =
    data.transactions.length === 0
      ? [raw(html`<tr><td class="empty" colspan="4">No transactions this month</td></tr>`)]
      : data.transactions.map((t) => raw(txRow(t)));
  return html`<section>
  <h2>All transactions</h2>
  <table class="tx">
    <thead><tr><th>Date</th><th>Details</th><th>Category</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}

function footerSection(data: ExpenseReportData): string {
  const when = formatLocalDateTime(data.generatedAtUtc, data.period.tzOffsetMinutes);
  return html`<footer class="footer">
  Generated ${when} · Categories follow your #tags in remarks, then the category you chose, then "Other". · <span class="brand">Finzz</span>
</footer>`;
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

export function renderExpenseReportHtml(data: ExpenseReportData): string {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Finzz expense report · ${data.period.label}</title>
<style>${raw(STYLE)}</style>
</head>
<body>
<div class="page">
${raw(heroSection(data))}
${raw(cardsSection(data))}
${raw(categoriesSection(data))}
${raw(topSection(data))}
${raw(activitySection(data))}
${raw(transactionsSection(data))}
${raw(footerSection(data))}
</div>
</body>
</html>`;
}
