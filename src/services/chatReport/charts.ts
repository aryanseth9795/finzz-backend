/**
 * Inline-SVG chart builders for the 1:1 chat monthly report (T-005).
 *
 * Every builder returns ONE complete `<svg>` string with a fixed viewBox and
 * `width="100%"`. They use no scripts, no external fonts, no images and no
 * links, so the same markup renders identically in a WebView and in a PDF
 * produced by expo-print.
 *
 * Balance convention (see types.ts): positive = the friend owes the viewer.
 */

import { escapeHtml, formatCurrency } from "../../utils/html.js";
import type { ChatReportData } from "./types.js";

export const CHART_COLORS = {
  gave: "#E11D48",
  received: "#059669",
  balance: "#4F46E5",
  grid: "#E2E8F0",
  muted: "#64748B",
  positive: "#059669",
  negative: "#E11D48",
};

const FONT = "Helvetica, Arial, sans-serif";
const EMPTY_TEXT = "No activity this month";
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------------------------------------------------------------- helpers

/** Round to one decimal; never emits NaN or Infinity. */
const n = (v: number): number => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);

/** Round an opacity to two decimals. */
const op = (v: number): number =>
  Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 100) / 100 : 0;

/** Linear scale from [d0, d1] to [r0, r1]; a zero-width domain maps to r0. */
const linear =
  (d0: number, d1: number, r0: number, r1: number) =>
  (v: number): number => {
    const span = d1 - d0;
    return span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0);
  };

/** "M x y L x y …" from points. */
const pathD = (pts: [number, number][]): string =>
  pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${n(x)} ${n(y)}`).join(" ");

/** Compact amount for axis and bar labels: ₹850, ₹1.5K, ₹2.0L, ₹1.2Cr. Signed. */
function abbrev(value: number, withPlus = false): string {
  const v = Number.isFinite(value) ? value : 0;
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : withPlus && v > 0 ? "+" : "";
  let body: string;
  if (a >= 1e7) body = `₹${(a / 1e7).toFixed(1)}Cr`;
  else if (a >= 1e5) body = `₹${(a / 1e5).toFixed(1)}L`;
  else if (a >= 1e3) body = `₹${(a / 1e3).toFixed(1)}K`;
  else body = formatCurrency(a).replace(/\.00$/, "");
  return sign + body;
}

const fullAmount = (v: number): string =>
  `${v < 0 ? "-" : ""}${formatCurrency(Math.abs(v))}`;

const text = (
  x: number,
  y: number,
  body: string,
  opts: { anchor?: "start" | "middle" | "end"; size?: number; fill?: string; extra?: string } = {},
): string =>
  `<text x="${n(x)}" y="${n(y)}" text-anchor="${opts.anchor ?? "middle"}" font-size="${
    opts.size ?? 10
  }" fill="${opts.fill ?? CHART_COLORS.muted}"${opts.extra ? ` ${opts.extra}` : ""}>${escapeHtml(
    body,
  )}</text>`;

function wrap(w: number, h: number, label: string, inner: string): string {
  return (
    `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="${escapeHtml(label)}" ` +
    `font-family="${FONT}">${inner}</svg>`
  );
}

function emptySvg(w: number, h: number, label: string): string {
  return wrap(w, h, label, text(w / 2, h / 2 + 4, EMPTY_TEXT, { size: 13 }));
}

// ------------------------------------------------------------ balance line

export function balanceLineSvg(data: ChatReportData): string {
  const W = 640;
  const H = 200;
  const label = `Running balance for ${data.period.label}: opening ${fullAmount(
    data.openingBalance,
  )}, closing ${fullAmount(data.closingBalance)}`;

  const rows = data.ledger.filter((r) => r.status !== "rejected");
  if (rows.length === 0 && !data.openingBalance && !data.closingBalance) {
    return emptySvg(W, H, label);
  }

  const days = Math.max(data.period.daysInMonth, 2);
  const L = 64;
  const R = 628;
  const T = 14;
  const B = 166;
  const xOf = linear(1, days, L, R);
  const dayX = (d: number) => xOf(Math.min(days, Math.max(1, d)));

  // Step path: hold the balance until a row's day, then jump.
  const steps: [number, number][] = [];
  let prev = data.openingBalance;
  steps.push([1, prev]);
  for (const r of rows) {
    steps.push([r.dayOfMonth, prev]);
    steps.push([r.dayOfMonth, r.runningBalance]);
    prev = r.runningBalance;
  }
  steps.push([days, prev]);
  if (prev !== data.closingBalance) steps.push([days, data.closingBalance]);

  const values = steps.map((s) => s[1]);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const flat = lo === hi;
  const dLo = flat ? lo - Math.max(Math.abs(lo) * 0.1, 1) : lo;
  const dHi = flat ? hi + Math.max(Math.abs(hi) * 0.1, 1) : hi;
  const yOf = linear(dLo, dHi, B, T);
  const clampY = (y: number) => Math.min(B, Math.max(T, y));

  const pts = steps.map(([d, v]): [number, number] => [dayX(d), yOf(v)]);
  const baseY = clampY(yOf(0));
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area = `${pathD(pts)} L${n(last[0])} ${n(baseY)} L${n(first[0])} ${n(baseY)} Z`;

  const parts: string[] = [];
  // Frame lines.
  for (const y of [T, B]) {
    parts.push(
      `<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${CHART_COLORS.grid}" stroke-width="1"/>`,
    );
  }
  if (lo < 0 && hi > 0) {
    const zy = yOf(0);
    parts.push(
      `<line data-role="zero" x1="${L}" y1="${n(zy)}" x2="${R}" y2="${n(
        zy,
      )}" stroke="${CHART_COLORS.muted}" stroke-width="1" stroke-dasharray="4 3"/>`,
    );
  }
  parts.push(`<path d="${area}" fill="${CHART_COLORS.balance}" fill-opacity="0.12" stroke="none"/>`);
  parts.push(
    `<path d="${pathD(pts)}" fill="none" stroke="${CHART_COLORS.balance}" stroke-width="2" stroke-linejoin="round"/>`,
  );

  // Dots: one per day with entries, at that day's closing balance.
  const dotDays = new Map<number, number>();
  for (const r of rows) dotDays.set(r.dayOfMonth, r.runningBalance);
  for (const [d, v] of dotDays) {
    parts.push(
      `<circle cx="${n(dayX(d))}" cy="${n(yOf(v))}" r="3" fill="#FFFFFF" stroke="${
        CHART_COLORS.balance
      }" stroke-width="2"/>`,
    );
  }

  // Y labels.
  if (flat) {
    parts.push(text(L - 6, (T + B) / 2 + 3, abbrev(hi), { anchor: "end" }));
  } else {
    parts.push(text(L - 6, T + 4, abbrev(hi), { anchor: "end" }));
    parts.push(text(L - 6, B, abbrev(lo), { anchor: "end" }));
  }

  // X labels.
  const xDays = [1, 8, 15, 22, days].filter((d, i, a) => a.indexOf(d) === i);
  for (const d of xDays) {
    parts.push(text(dayX(d), 186, String(d), { extra: `data-x-label="${d}"` }));
  }

  return wrap(W, H, label, parts.join(""));
}

// -------------------------------------------------------------- daily bars

export function dailyBarsSvg(data: ChatReportData): string {
  const W = 640;
  const H = 180;
  const label = `Daily amounts given and received in ${data.period.label}`;

  const daily = data.daily;
  const max = Math.max(...daily.map((d) => Math.max(d.gave, d.received)), 0);
  if (daily.length === 0 || max <= 0) return emptySvg(W, H, label);

  const L = 48;
  const R = 628;
  const T = 14;
  const B = 150;
  const slot = (R - L) / daily.length;
  const bw = Math.max(Math.min(slot * 0.36, 8), 1);
  const yOf = linear(0, Math.max(max, 1), B, T);

  const parts: string[] = [
    `<line x1="${L}" y1="${T}" x2="${R}" y2="${T}" stroke="${CHART_COLORS.grid}" stroke-width="1"/>`,
    `<line x1="${L}" y1="${B}" x2="${R}" y2="${B}" stroke="${CHART_COLORS.grid}" stroke-width="1"/>`,
    text(L - 6, T + 4, abbrev(max), { anchor: "end" }),
    text(L - 6, B, "₹0", { anchor: "end" }),
  ];

  daily.forEach((d, i) => {
    const cx = L + slot * (i + 0.5);
    if (d.gave <= 0 && d.received <= 0) {
      parts.push(
        `<line x1="${n(cx)}" y1="${B}" x2="${n(cx)}" y2="${B + 3}" stroke="${
          CHART_COLORS.grid
        }" stroke-width="1"/>`,
      );
    } else {
      const bars: [number, number, string][] = [
        [d.gave, cx - bw - 0.5, CHART_COLORS.gave],
        [d.received, cx + 0.5, CHART_COLORS.received],
      ];
      for (const [amount, x, fill] of bars) {
        if (amount <= 0) continue;
        const top = Math.min(yOf(amount), B - 1);
        parts.push(
          `<rect x="${n(x)}" y="${n(top)}" width="${n(bw)}" height="${n(
            B - top,
          )}" rx="1.5" fill="${fill}"/>`,
        );
      }
    }
    const day = d.dayOfMonth;
    if (day === 1 || day % 5 === 0) {
      parts.push(text(cx, 168, String(day), { extra: `data-x-label="${day}"` }));
    }
  });

  return wrap(W, H, label, parts.join(""));
}

// ----------------------------------------------------------- weekday strip

export function weekdayStripSvg(data: ChatReportData): string {
  const W = 640;
  const H = 70;
  const label = `Activity by day of the week in ${data.period.label}`;

  const cells = Array.from({ length: 7 }, (_, i) => {
    const w = data.weekday.find((x) => x.weekday === i);
    return { amount: w?.amount ?? 0, count: w?.count ?? 0 };
  });
  const max = Math.max(...cells.map((c) => c.amount), 0);
  if (max <= 0) return emptySvg(W, H, label);

  const gap = 8;
  const left = 8;
  const cw = (W - left * 2 - gap * 6) / 7;
  const parts = cells.map((c, i) => {
    const x = left + i * (cw + gap);
    const opacity = op(0.08 + 0.92 * (c.amount / Math.max(max, 1)));
    return (
      `<rect x="${n(x)}" y="4" width="${n(cw)}" height="34" rx="6" fill="${
        CHART_COLORS.balance
      }" fill-opacity="${opacity}"/>` +
      text(x + cw / 2, 51, WEEKDAY_NAMES[i], { size: 11, fill: "#334155" }) +
      text(x + cw / 2, 64, `${c.count} ${c.count === 1 ? "entry" : "entries"}`, { size: 10 })
    );
  });

  return wrap(W, H, label, parts.join(""));
}

// -------------------------------------------------------------- trend bars

export function trendBarsSvg(data: ChatReportData): string {
  const W = 640;
  const H = 160;
  const label = `Net movement per month, last ${data.trend.length} months`;

  const trend = data.trend;
  const nets = trend.map((m) => (Number.isFinite(m.net) ? m.net : 0));
  if (trend.length === 0 || nets.every((v) => v === 0)) return emptySvg(W, H, label);

  const L = 24;
  const R = 616;
  const T = 26;
  const B = 120;
  const plotH = B - T;
  const maxPos = Math.max(...nets, 0);
  const maxNeg = Math.max(...nets.map((v) => -v), 0);
  const range = Math.max(maxPos + maxNeg, 1);
  const zeroY = T + (maxPos / range) * plotH;
  const perUnit = plotH / range;

  const slot = (R - L) / trend.length;
  const bw = Math.min(slot * 0.55, 56);

  const parts: string[] = [
    `<line data-role="zero" x1="${L}" y1="${n(zeroY)}" x2="${R}" y2="${n(
      zeroY,
    )}" stroke="${CHART_COLORS.grid}" stroke-width="1"/>`,
  ];

  trend.forEach((m, i) => {
    const net = nets[i];
    const cx = L + slot * (i + 0.5);
    const barH = net === 0 ? 0 : Math.max(Math.abs(net) * perUnit, 1);
    if (net > 0) {
      const top = Math.max(zeroY - barH, T);
      parts.push(
        `<rect x="${n(cx - bw / 2)}" y="${n(top)}" width="${n(bw)}" height="${n(
          zeroY - top,
        )}" rx="2" fill="${CHART_COLORS.positive}"/>`,
      );
      parts.push(text(cx, top - 4, abbrev(net, true), { size: 10, fill: CHART_COLORS.positive }));
    } else if (net < 0) {
      const bottom = Math.min(zeroY + barH, B);
      parts.push(
        `<rect x="${n(cx - bw / 2)}" y="${n(zeroY)}" width="${n(bw)}" height="${n(
          bottom - zeroY,
        )}" rx="2" fill="${CHART_COLORS.negative}"/>`,
      );
      parts.push(text(cx, bottom + 12, abbrev(net, true), { size: 10, fill: CHART_COLORS.negative }));
    } else {
      parts.push(text(cx, zeroY - 4, abbrev(0), { size: 10 }));
    }
    parts.push(text(cx, 150, m.label, { size: 11 }));
  });

  return wrap(W, H, label, parts.join(""));
}
