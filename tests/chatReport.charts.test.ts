import { describe, it, expect } from "vitest";
import {
  CHART_COLORS,
  balanceLineSvg,
  dailyBarsSvg,
  weekdayStripSvg,
  trendBarsSvg,
} from "../src/services/chatReport/charts.js";
import type {
  ChatReportData,
  ReportLedgerRow,
  ReportMonthNet,
  ReportTxStatus,
} from "../src/services/chatReport/types.js";

/** Pure tests: no database, no network. */

const DAYS = 31;

interface RowSpec {
  day: number;
  amount: number;
  direction: "gave" | "received";
  status?: ReportTxStatus;
}

interface Spec {
  opening?: number;
  rows?: RowSpec[];
  trend?: ReportMonthNet[];
  remarks?: string;
}

/** Builds a consistent ChatReportData from a handful of rows. */
function makeData(spec: Spec = {}): ChatReportData {
  const opening = spec.opening ?? 0;
  let balance = opening;
  const ledger: ReportLedgerRow[] = (spec.rows ?? []).map((r, i) => {
    const status = r.status ?? "verified";
    if (status !== "rejected") {
      balance += r.direction === "gave" ? r.amount : -r.amount;
    }
    const dow = new Date(Date.UTC(2026, 9, r.day)).getUTCDay();
    return {
      id: `r${i}`,
      day: `2026-10-${String(r.day).padStart(2, "0")}`,
      dayOfMonth: r.day,
      weekday: dow,
      remarks: spec.remarks ?? "",
      amount: r.amount,
      direction: r.direction,
      status,
      addedBy: "me",
      runningBalance: Math.round(balance * 100) / 100,
    };
  });
  const live = ledger.filter((r) => r.status !== "rejected");
  const daily = Array.from({ length: DAYS }, (_, i) => ({
    dayOfMonth: i + 1,
    gave: 0,
    received: 0,
    count: 0,
  }));
  const weekday = Array.from({ length: 7 }, (_, i) => ({
    weekday: i,
    amount: 0,
    count: 0,
  }));
  for (const r of live) {
    const d = daily[r.dayOfMonth - 1];
    d[r.direction] += r.amount;
    d.count += 1;
    weekday[r.weekday].amount += r.amount;
    weekday[r.weekday].count += 1;
  }
  const gave = live.filter((r) => r.direction === "gave").reduce((s, r) => s + r.amount, 0);
  const received = live.filter((r) => r.direction === "received").reduce((s, r) => s + r.amount, 0);
  return {
    generatedAtUtc: "2026-10-17T00:00:00.000Z",
    period: {
      year: 2026,
      month: 10,
      label: "October 2026",
      startUtc: "2026-09-30T18:30:00.000Z",
      endUtc: "2026-10-31T18:30:00.000Z",
      daysInMonth: DAYS,
      tzOffsetMinutes: 330,
    },
    me: { id: "a", name: "Aryan" },
    friend: { id: "b", name: "Summer" },
    openingBalance: opening,
    closingBalance: Math.round(balance * 100) / 100,
    totals: {
      gave,
      received,
      net: received - gave,
      count: live.length,
      activeDays: new Set(live.map((r) => r.dayOfMonth)).size,
      addedByMe: live.length,
      addedByFriend: 0,
    },
    byStatus: {
      pending: { count: 0, amount: 0 },
      verified: { count: live.length, amount: gave + received },
      rejected: { count: 0, amount: 0 },
    },
    ledger,
    daily,
    weekday,
    previousMonth: null,
    trend: spec.trend ?? [],
  };
}

const TREND: ReportMonthNet[] = [
  { year: 2026, month: 5, label: "May", gave: 100, received: 0, net: -100 },
  { year: 2026, month: 6, label: "Jun", gave: 0, received: 400, net: 400 },
  { year: 2026, month: 7, label: "Jul", gave: 250, received: 0, net: -250 },
  { year: 2026, month: 8, label: "Aug", gave: 0, received: 0, net: 0 },
  { year: 2026, month: 9, label: "Sep", gave: 50, received: 900, net: 850 },
  { year: 2026, month: 10, label: "Oct", gave: 700, received: 100, net: -600 },
];

const ROWS: RowSpec[] = [
  { day: 1, amount: 1200, direction: "gave" },
  { day: 4, amount: 350.5, direction: "received" },
  { day: 4, amount: 75, direction: "gave" },
  { day: 17, amount: 20000, direction: "gave" },
  { day: 31, amount: 900, direction: "received" },
  { day: 12, amount: 5000, direction: "gave", status: "rejected" },
];

const active = () => makeData({ opening: 250, rows: ROWS, trend: TREND });
const empty = () => makeData();

type Builder = (d: ChatReportData) => string;
const BUILDERS: { name: string; fn: Builder; w: number; h: number; hasData: () => ChatReportData }[] = [
  { name: "balanceLineSvg", fn: balanceLineSvg, w: 640, h: 200, hasData: active },
  { name: "dailyBarsSvg", fn: dailyBarsSvg, w: 640, h: 180, hasData: active },
  { name: "weekdayStripSvg", fn: weekdayStripSvg, w: 640, h: 70, hasData: active },
  { name: "trendBarsSvg", fn: trendBarsSvg, w: 640, h: 160, hasData: active },
];

const attr = (tag: string, name: string): number | undefined => {
  const m = new RegExp(`\\s${name}="(-?\\d+(?:\\.\\d+)?)"`).exec(tag);
  return m ? Number(m[1]) : undefined;
};

const tagsOf = (svg: string, names: string): string[] =>
  [...svg.matchAll(new RegExp(`<(?:${names})\\b[^>]*>`, "g"))].map((m) => m[0]);

describe("CHART_COLORS", () => {
  it("exposes the print-safe palette", () => {
    expect(CHART_COLORS).toEqual({
      gave: "#E11D48",
      received: "#059669",
      balance: "#4F46E5",
      grid: "#E2E8F0",
      muted: "#64748B",
      positive: "#059669",
      negative: "#E11D48",
    });
  });
});

describe.each(BUILDERS)("$name", ({ fn, w, h, hasData }) => {
  const datasets: [string, ChatReportData][] = [
    ["active data", hasData()],
    ["empty data", empty()],
    [
      "hostile remarks / all rejected",
      makeData({
        remarks: '<script>alert(1)</script>"&',
        rows: [{ day: 2, amount: 10, direction: "gave", status: "rejected" }],
      }),
    ],
  ];

  it.each(datasets)("is a clean, self-contained SVG for %s", (_n, data) => {
    const svg = fn(data);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain(`viewBox="0 0 ${w} ${h}"`);
    expect(svg).toContain('width="100%"');
    expect(svg).toContain('role="img"');
    expect(svg).toMatch(/aria-label="[^"]+"/);
    expect(svg).toContain("Helvetica, Arial, sans-serif");
    expect(svg).not.toMatch(/NaN|Infinity|undefined/);
    expect(svg).not.toContain("<script");
    expect(svg).not.toContain("href=");
    expect(svg).not.toContain("http");
  });

  it("shows the placeholder for empty data", () => {
    const svg = fn(empty());
    expect(svg).toContain("No activity this month");
    expect(svg).toContain(`x="${w / 2}"`);
    expect(svg).toContain(CHART_COLORS.muted);
  });

  it("does not show the placeholder when there is data", () => {
    expect(fn(hasData())).not.toContain("No activity this month");
  });

  it("keeps every coordinate inside the viewBox", () => {
    for (const data of [hasData(), empty()]) {
      const svg = fn(data);
      for (const tag of tagsOf(svg, "rect|circle|line|text")) {
        for (const n of ["x", "cx", "x1", "x2"]) {
          const v = attr(tag, n);
          if (v !== undefined) {
            expect(v, `${n} in ${tag}`).toBeGreaterThanOrEqual(0);
            expect(v, `${n} in ${tag}`).toBeLessThanOrEqual(w);
          }
        }
        for (const n of ["y", "cy", "y1", "y2"]) {
          const v = attr(tag, n);
          if (v !== undefined) {
            expect(v, `${n} in ${tag}`).toBeGreaterThanOrEqual(0);
            expect(v, `${n} in ${tag}`).toBeLessThanOrEqual(h);
          }
        }
        if (tag.startsWith("<rect")) {
          const x = attr(tag, "x") ?? 0;
          const y = attr(tag, "y") ?? 0;
          const rw = attr(tag, "width") ?? 0;
          const rh = attr(tag, "height") ?? 0;
          expect(rw, tag).toBeGreaterThanOrEqual(0);
          expect(rh, tag).toBeGreaterThanOrEqual(0);
          expect(x + rw, tag).toBeLessThanOrEqual(w + 0.05);
          expect(y + rh, tag).toBeLessThanOrEqual(h + 0.05);
        }
      }
      for (const m of svg.matchAll(/\sd="([^"]*)"/g)) {
        for (const p of m[1].matchAll(/[ML](-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)) {
          expect(Number(p[1])).toBeGreaterThanOrEqual(0);
          expect(Number(p[1])).toBeLessThanOrEqual(w);
          expect(Number(p[2])).toBeGreaterThanOrEqual(0);
          expect(Number(p[2])).toBeLessThanOrEqual(h);
        }
      }
    }
  });

  it("rounds coordinates to one decimal", () => {
    const svg = fn(hasData()).replace(/opacity="[^"]*"/g, "").replace(/aria-label="[^"]*"/g, "");
    // Ignore text content (amounts such as "₹350.50").
    const markup = svg.replace(/>[^<]*</g, "><");
    expect(markup).not.toMatch(/\d+\.\d{2,}/);
  });

  it("survives huge, tiny and fractional amounts without NaN", () => {
    const data = makeData({
      opening: 0.004,
      rows: [
        { day: 1, amount: 0.01, direction: "gave" },
        { day: 2, amount: 9_999_999_999.99, direction: "received" },
      ],
      trend: [{ year: 2026, month: 10, label: "Oct", gave: 0.01, received: 0, net: -0.01 }],
    });
    const svg = fn(data);
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
});

describe("balanceLineSvg", () => {
  it("draws a dashed zero line only when the balance crosses zero", () => {
    const crossing = makeData({
      rows: [
        { day: 3, amount: 500, direction: "gave" },
        { day: 10, amount: 800, direction: "received" },
      ],
    });
    const positiveOnly = makeData({
      rows: [
        { day: 3, amount: 500, direction: "gave" },
        { day: 10, amount: 200, direction: "gave" },
      ],
    });
    const negativeOnly = makeData({
      rows: [{ day: 3, amount: 500, direction: "received" }],
    });
    expect(balanceLineSvg(crossing)).toContain("stroke-dasharray");
    expect(balanceLineSvg(positiveOnly)).not.toContain("stroke-dasharray");
    expect(balanceLineSvg(negativeOnly)).not.toContain("stroke-dasharray");
  });

  it("marks entry days with dots, ignoring rejected rows", () => {
    const svg = balanceLineSvg(active());
    // Active days: 1, 4, 17, 31 (day 12 is rejected).
    expect(tagsOf(svg, "circle")).toHaveLength(4);
  });

  it("labels the x axis 1, 8, 15, 22 and the last day", () => {
    const svg = balanceLineSvg(active());
    const labels = [...svg.matchAll(/data-x-label="(\d+)"/g)].map((m) => Number(m[1]));
    expect(labels).toEqual([1, 8, 15, 22, 31]);
  });

  it("abbreviates large y-axis labels", () => {
    const svg = balanceLineSvg(
      makeData({ rows: [{ day: 5, amount: 2_500_000, direction: "gave" }] }),
    );
    expect(svg).toContain("₹25.0L");
  });

  it("draws a flat line for a carried-in balance with no activity", () => {
    const svg = balanceLineSvg(makeData({ opening: 1500 }));
    expect(svg).not.toMatch(/NaN|Infinity/);
  });
});

describe("dailyBarsSvg", () => {
  it("draws a gave and a received bar for a day with both", () => {
    const svg = dailyBarsSvg(active());
    expect(svg).toContain(`fill="${CHART_COLORS.gave}"`);
    expect(svg).toContain(`fill="${CHART_COLORS.received}"`);
  });

  it("labels every fifth day", () => {
    const svg = dailyBarsSvg(active());
    const labels = [...svg.matchAll(/data-x-label="(\d+)"/g)].map((m) => Number(m[1]));
    expect(labels).toEqual([1, 5, 10, 15, 20, 25, 30]);
  });

  it("shares one y-scale: the tallest bar is the largest amount", () => {
    const svg = dailyBarsSvg(active());
    const heights = tagsOf(svg, "rect").map((t) => attr(t, "height") ?? 0);
    const max = Math.max(...heights);
    // 20000 on day 17 dwarfs everything: the 1200 bar is ~6% of it.
    const mid = heights.filter((x) => x > 0 && x < max * 0.1);
    expect(mid.length).toBeGreaterThan(0);
  });
});

describe("weekdayStripSvg", () => {
  it("renders seven cells with day names and counts", () => {
    const svg = weekdayStripSvg(active());
    expect(tagsOf(svg, "rect")).toHaveLength(7);
    for (const d of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
      expect(svg).toContain(`>${d}<`);
    }
    expect(svg).toMatch(/>\d+ entr(y|ies)</);
  });

  it("scales fill opacity between 0.08 and 1", () => {
    const svg = weekdayStripSvg(active());
    const ops = tagsOf(svg, "rect").map((t) => Number(/fill-opacity="([\d.]+)"/.exec(t)![1]));
    expect(Math.min(...ops)).toBeCloseTo(0.08, 2);
    expect(Math.max(...ops)).toBeCloseTo(1, 2);
  });
});

describe("trendBarsSvg", () => {
  it("puts a negative-net bar below the zero line and a positive one above it", () => {
    const svg = trendBarsSvg(active());
    const zero = tagsOf(svg, "line").find((t) => t.includes('data-role="zero"'));
    expect(zero).toBeDefined();
    const zeroY = attr(zero!, "y1")!;
    const rects = tagsOf(svg, "rect");
    const neg = rects.filter((t) => t.includes(`fill="${CHART_COLORS.negative}"`));
    const pos = rects.filter((t) => t.includes(`fill="${CHART_COLORS.positive}"`));
    expect(neg).toHaveLength(3);
    expect(pos).toHaveLength(2);
    for (const t of neg) expect(attr(t, "y")!).toBeGreaterThanOrEqual(zeroY - 0.05);
    for (const t of pos) {
      expect(attr(t, "y")! + attr(t, "height")!).toBeLessThanOrEqual(zeroY + 0.05);
    }
  });

  it("labels each month and its value", () => {
    const svg = trendBarsSvg(active());
    for (const m of ["May", "Jun", "Jul", "Aug", "Sep", "Oct"]) {
      expect(svg).toContain(`>${m}<`);
    }
    expect(svg).toContain("+₹850");
    expect(svg).toContain("-₹600");
  });

  it("escapes month labels", () => {
    const svg = trendBarsSvg(
      makeData({
        trend: [{ year: 2026, month: 1, label: "<b>", gave: 0, received: 5, net: 5 }],
      }),
    );
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;");
  });

  it("shows the placeholder when every month is zero", () => {
    const svg = trendBarsSvg(
      makeData({
        trend: [{ year: 2026, month: 10, label: "Oct", gave: 0, received: 0, net: 0 }],
      }),
    );
    expect(svg).toContain("No activity this month");
  });
});
