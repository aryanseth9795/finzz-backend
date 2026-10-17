import { describe, it, expect } from "vitest";
import { balanceSentence, buildInsights } from "../src/services/chatReport/insights.js";
import type {
  ChatReportData,
  ReportInsight,
  ReportLedgerRow,
  ReportMonthNet,
} from "../src/services/chatReport/types.js";

/** Pure tests: no database, fixtures built by hand. */

const row = (over: Partial<ReportLedgerRow> = {}): ReportLedgerRow => ({
  id: "r" + Math.random().toString(36).slice(2),
  day: "2026-10-05",
  dayOfMonth: 5,
  weekday: 1,
  remarks: "",
  amount: 100,
  direction: "gave",
  status: "verified",
  addedBy: "me",
  runningBalance: 0,
  ...over,
});

const empty = (): ChatReportData => ({
  generatedAtUtc: "2026-10-17T00:00:00.000Z",
  period: {
    year: 2026,
    month: 10,
    label: "October 2026",
    startUtc: "2026-09-30T18:30:00.000Z",
    endUtc: "2026-10-31T18:30:00.000Z",
    daysInMonth: 31,
    tzOffsetMinutes: 330,
  },
  me: { id: "m", name: "Aryan" },
  friend: { id: "f", name: "Summer" },
  openingBalance: 0,
  closingBalance: 0,
  totals: {
    gave: 0,
    received: 0,
    net: 0,
    count: 0,
    activeDays: 0,
    addedByMe: 0,
    addedByFriend: 0,
  },
  byStatus: {
    pending: { count: 0, amount: 0 },
    verified: { count: 0, amount: 0 },
    rejected: { count: 0, amount: 0 },
  },
  ledger: [],
  daily: [],
  weekday: [],
  previousMonth: null,
  trend: [],
});

const make = (over: Partial<ChatReportData> = {}): ChatReportData => ({
  ...empty(),
  ...over,
});

const kinds = (list: ReportInsight[]) => list.map((i) => i.kind);
const find = (list: ReportInsight[], kind: ReportInsight["kind"]) =>
  list.find((i) => i.kind === kind);

const MONTH_NUMBER: Record<string, number> = { Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11 };
const month = (label: string, net: number): ReportMonthNet => ({
  year: 2026,
  month: MONTH_NUMBER[label] ?? 1,
  label,
  gave: net < 0 ? -net : 0,
  received: net > 0 ? net : 0,
  net,
});

describe("balanceSentence", () => {
  it("positive balance: the friend owes the viewer", () => {
    expect(balanceSentence(4250, "Summer")).toBe("Summer owes you ₹4,250.00");
  });
  it("negative balance: the viewer owes the friend, without a minus sign", () => {
    expect(balanceSentence(-4250, "Summer")).toBe("You owe Summer ₹4,250.00");
  });
  it("zero and sub-paisa values are settled", () => {
    expect(balanceSentence(0, "Summer")).toBe("You and Summer are all settled");
    expect(balanceSentence(0.004, "Summer")).toBe("You and Summer are all settled");
    expect(balanceSentence(-0.004, "Summer")).toBe("You and Summer are all settled");
  });
  it("0.005 is not settled", () => {
    expect(balanceSentence(0.005, "Summer")).toBe("Summer owes you ₹0.01");
  });
  it("uses Indian digit grouping", () => {
    expect(balanceSentence(1234567.5, "Summer")).toBe("Summer owes you ₹12,34,567.50");
  });
});

describe("buildInsights: empty month", () => {
  it("only the balance insight (settled) for a quiet, settled month", () => {
    const out = buildInsights(make());
    expect(kinds(out)).toEqual(["balance"]);
    expect(out[0].text).toBe("You and Summer are all settled as of 17 Oct 2026");
    expect(out[0].tone).toBe("neutral");
  });
});

describe("balance", () => {
  it("positive: tone positive, with the period label", () => {
    const i = find(buildInsights(make({ closingBalance: 4250 })), "balance")!;
    expect(i.text).toBe("Summer owes you ₹4,250.00 as of 17 Oct 2026");
    expect(i.tone).toBe("positive");
  });
  it("negative: tone negative", () => {
    const i = find(buildInsights(make({ closingBalance: -4250 })), "balance")!;
    expect(i.text).toBe("You owe Summer ₹4,250.00 as of 17 Oct 2026");
    expect(i.tone).toBe("negative");
  });
  it("current month reads 'as of 17 Oct 2026', never 'end of'", () => {
    const text = find(buildInsights(make({ closingBalance: 5 })), "balance")!.text;
    expect(text).toContain("as of 17 Oct 2026");
    expect(text).not.toContain("end of");
  });
  it("past month reads 'at the end of September 2026'", () => {
    const d = make({
      closingBalance: 5,
      period: { ...empty().period, month: 9, label: "September 2026", daysInMonth: 30 },
    });
    expect(find(buildInsights(d), "balance")!.text).toBe(
      "Summer owes you ₹5.00 at the end of September 2026",
    );
  });
  it("compares in the viewer's timezone: 31 Oct 20:00 UTC is already 1 Nov in IST", () => {
    const d = make({ closingBalance: 5, generatedAtUtc: "2026-10-31T20:00:00.000Z" });
    expect(find(buildInsights(d), "balance")!.text).toBe(
      "Summer owes you ₹5.00 at the end of October 2026",
    );
  });
  it("is always first", () => {
    const out = buildInsights(
      make({
        closingBalance: 10,
        ledger: [row({ amount: 10 })],
        totals: { ...empty().totals, count: 1, activeDays: 1, gave: 10, addedByMe: 1 },
      }),
    );
    expect(out[0].kind).toBe("balance");
  });
});

describe("biggest", () => {
  it("names the largest non-rejected entry, with remarks", () => {
    const out = buildInsights(
      make({
        ledger: [
          row({ amount: 500, day: "2026-10-03", dayOfMonth: 3 }),
          row({ amount: 15000, day: "2026-10-12", dayOfMonth: 12, remarks: "rent" }),
          row({ amount: 99999, status: "rejected", day: "2026-10-20", dayOfMonth: 20 }),
        ],
      }),
    );
    const i = find(out, "biggest")!;
    expect(i.text).toBe("Biggest entry: ₹15,000.00 on 12 Oct — rent");
    expect(i.tone).toBe("neutral");
  });
  it("omits the remarks part when empty or whitespace", () => {
    const out = buildInsights(
      make({ ledger: [row({ amount: 40, day: "2026-10-01", remarks: "   " })] }),
    );
    expect(find(out, "biggest")!.text).toBe("Biggest entry: ₹40.00 on 1 Oct");
  });
  it("is absent with no rows, or only rejected rows", () => {
    expect(find(buildInsights(make()), "biggest")).toBeUndefined();
    expect(
      find(buildInsights(make({ ledger: [row({ status: "rejected" })] })), "biggest"),
    ).toBeUndefined();
  });
  it("counts pending entries", () => {
    const out = buildInsights(make({ ledger: [row({ amount: 70, status: "pending" })] }));
    expect(find(out, "biggest")).toBeDefined();
  });
});

describe("busiestDay", () => {
  const sat = (n: number, status: ReportLedgerRow["status"] = "verified") =>
    Array.from({ length: n }, () =>
      row({ day: "2026-10-18", dayOfMonth: 18, weekday: 6, status }),
    );
  it("reports the day with the most entries when at least 2", () => {
    const out = buildInsights(
      make({ ledger: [row({ day: "2026-10-04", dayOfMonth: 4, weekday: 6 }), ...sat(4)] }),
    );
    expect(find(out, "busiestDay")!.text).toBe("Busiest day: Saturday, 18 Oct (4 entries)");
    expect(find(out, "busiestDay")!.tone).toBe("neutral");
  });
  it("uses the singular-safe plural for 2", () => {
    expect(find(buildInsights(make({ ledger: sat(2) })), "busiestDay")!.text).toBe(
      "Busiest day: Saturday, 18 Oct (2 entries)",
    );
  });
  it("is absent when every day has a single entry", () => {
    const out = buildInsights(
      make({
        ledger: [
          row({ day: "2026-10-01", dayOfMonth: 1 }),
          row({ day: "2026-10-02", dayOfMonth: 2 }),
        ],
      }),
    );
    expect(find(out, "busiestDay")).toBeUndefined();
  });
  it("ignores rejected rows", () => {
    const out = buildInsights(make({ ledger: [...sat(1), ...sat(3, "rejected")] }));
    expect(find(out, "busiestDay")).toBeUndefined();
  });
  it("ties go to the earlier day", () => {
    const out = buildInsights(
      make({
        ledger: [
          row({ day: "2026-10-09", dayOfMonth: 9, weekday: 5 }),
          row({ day: "2026-10-09", dayOfMonth: 9, weekday: 5 }),
          ...sat(2),
        ],
      }),
    );
    expect(find(out, "busiestDay")!.text).toBe("Busiest day: Friday, 9 Oct (2 entries)");
  });
});

describe("vsLastMonth", () => {
  const withPrev = (thisTotal: number, prevTotal: number) =>
    make({
      totals: { ...empty().totals, gave: thisTotal, received: 0 },
      previousMonth: { gave: prevTotal / 2, received: prevTotal / 2, net: 0, count: 3 },
    });
  it("up", () => {
    const i = find(buildInsights(withPrev(1320, 1000)), "vsLastMonth")!;
    expect(i.text).toBe("Activity up 32% vs last month");
    expect(i.tone).toBe("neutral");
  });
  it("down", () => {
    expect(find(buildInsights(withPrev(500, 1000)), "vsLastMonth")!.text).toBe(
      "Activity down 50% vs last month",
    );
  });
  it("about the same within +/-5%", () => {
    for (const t of [1050, 950, 1000, 1020]) {
      expect(find(buildInsights(withPrev(t, 1000)), "vsLastMonth")!.text).toBe(
        "Activity about the same as last month",
      );
    }
    // wording from the card
    expect(
      find(buildInsights(withPrev(1000, 1000)), "vsLastMonth")!.text,
    ).toBe("Activity about the same as last month");
  });
  it("just outside 5% is up / down", () => {
    expect(find(buildInsights(withPrev(1060, 1000)), "vsLastMonth")!.text).toBe(
      "Activity up 6% vs last month",
    );
    expect(find(buildInsights(withPrev(940, 1000)), "vsLastMonth")!.text).toBe(
      "Activity down 6% vs last month",
    );
  });
  it("skipped when there was no previous month", () => {
    expect(find(buildInsights(make()), "vsLastMonth")).toBeUndefined();
  });
  it("skipped when last month's total was 0", () => {
    const d = make({
      totals: { ...empty().totals, gave: 100 },
      previousMonth: { gave: 0, received: 0, net: 0, count: 0 },
    });
    expect(find(buildInsights(d), "vsLastMonth")).toBeUndefined();
  });
  it("compares gave + received, not the net", () => {
    const d = make({
      totals: { ...empty().totals, gave: 500, received: 500, net: 0 },
      previousMonth: { gave: 1000, received: 0, net: -1000, count: 2 },
    });
    expect(find(buildInsights(d), "vsLastMonth")!.text).toBe(
      "Activity about the same as last month",
    );
  });
});

describe("average", () => {
  it("count, active days of the month, and the average amount", () => {
    const d = make({
      totals: {
        ...empty().totals,
        gave: 10000,
        received: 7360,
        count: 14,
        activeDays: 9,
      },
    });
    const i = find(buildInsights(d), "average")!;
    expect(i.text).toBe("14 entries on 9 of 31 days · average ₹1,240.00");
    expect(i.tone).toBe("neutral");
  });
  it("singular", () => {
    const d = make({
      totals: { ...empty().totals, gave: 50, count: 1, activeDays: 1 },
    });
    expect(find(buildInsights(d), "average")!.text).toBe(
      "1 entry on 1 of 31 days · average ₹50.00",
    );
  });
  it("absent when there are no entries", () => {
    expect(find(buildInsights(make()), "average")).toBeUndefined();
  });
});

describe("pending", () => {
  it("plural", () => {
    const d = make({
      byStatus: { ...empty().byStatus, pending: { count: 2, amount: 3000 } },
    });
    const i = find(buildInsights(d), "pending")!;
    expect(i.text).toBe("₹3,000.00 (2 entries) is still waiting to be verified");
    expect(i.tone).toBe("warning");
  });
  it("singular", () => {
    const d = make({
      byStatus: { ...empty().byStatus, pending: { count: 1, amount: 75.5 } },
    });
    expect(find(buildInsights(d), "pending")!.text).toBe(
      "₹75.50 (1 entry) is still waiting to be verified",
    );
  });
  it("absent at zero", () => {
    expect(find(buildInsights(make()), "pending")).toBeUndefined();
  });
});

describe("rejected", () => {
  it("plural", () => {
    const d = make({
      byStatus: { ...empty().byStatus, rejected: { count: 2, amount: 10 } },
    });
    const i = find(buildInsights(d), "rejected")!;
    expect(i.text).toBe("2 rejected entries are not counted");
    expect(i.tone).toBe("neutral");
  });
  it("singular", () => {
    const d = make({
      byStatus: { ...empty().byStatus, rejected: { count: 1, amount: 10 } },
    });
    expect(find(buildInsights(d), "rejected")!.text).toBe("1 rejected entry is not counted");
  });
  it("absent at zero", () => {
    expect(find(buildInsights(make()), "rejected")).toBeUndefined();
  });
});

describe("whoAdded", () => {
  it("both counts positive", () => {
    const d = make({ totals: { ...empty().totals, addedByMe: 9, addedByFriend: 5 } });
    expect(find(buildInsights(d), "whoAdded")!.text).toBe(
      "You added 9 entries, Summer added 5",
    );
    expect(find(buildInsights(d), "whoAdded")!.tone).toBe("neutral");
  });
  it("singular", () => {
    const d = make({ totals: { ...empty().totals, addedByMe: 1, addedByFriend: 1 } });
    expect(find(buildInsights(d), "whoAdded")!.text).toBe(
      "You added 1 entry, Summer added 1",
    );
  });
  it("absent when either is zero", () => {
    expect(
      find(
        buildInsights(make({ totals: { ...empty().totals, addedByMe: 4, addedByFriend: 0 } })),
        "whoAdded",
      ),
    ).toBeUndefined();
    expect(
      find(
        buildInsights(make({ totals: { ...empty().totals, addedByMe: 0, addedByFriend: 4 } })),
        "whoAdded",
      ),
    ).toBeUndefined();
  });
});

describe("trend", () => {
  // net = received - gave. The balance (friend owes viewer) moves by gave - received = -net.
  it("balance change > 0 for 3 months in a row: neutral 'has grown' wording", () => {
    const d = make({ trend: [month("Aug", 50), month("Sep", -10), month("Oct", -20), month("Nov", -5)] });
    const i = find(buildInsights(d), "trend")!;
    expect(i.text).toBe("Summer's balance owed to you has grown 3 months in a row");
    expect(i.tone).toBe("neutral");
  });
  it("balance change < 0 for 3 months in a row: Summer is paying you back (positive)", () => {
    const d = make({ trend: [month("Aug", 10), month("Sep", 20), month("Oct", 5)] });
    const i = find(buildInsights(d), "trend")!;
    expect(i.text).toBe("Summer has been paying you back — 3 months in a row");
    expect(i.tone).toBe("positive");
  });
  it("never says 'favour'", () => {
    for (const nets of [[-1, -1, -1], [1, 1, 1]]) {
      const d = make({ trend: [month("Aug", nets[0]), month("Sep", nets[1]), month("Oct", nets[2])] });
      expect(find(buildInsights(d), "trend")!.text).not.toMatch(/favour/i);
    }
  });
  it("mixed signs: absent", () => {
    const d = make({ trend: [month("Aug", 10), month("Sep", -20), month("Oct", 5)] });
    expect(find(buildInsights(d), "trend")).toBeUndefined();
  });
  it("a zero month breaks the run", () => {
    const d = make({ trend: [month("Aug", 10), month("Sep", 0), month("Oct", 5)] });
    expect(find(buildInsights(d), "trend")).toBeUndefined();
  });
  it("months that are not consecutive do not make a run", () => {
    const d = make({ trend: [month("Jun", 10), month("Aug", 20), month("Oct", 5)] });
    expect(find(buildInsights(d), "trend")).toBeUndefined();
  });
  it("a run across a year boundary counts", () => {
    const d = make({
      trend: [
        { ...month("Nov", -1), year: 2025, month: 11 },
        { ...month("Dec", -1), year: 2025, month: 12 },
        { ...month("Jan", -1), year: 2026, month: 1 },
      ],
    });
    expect(find(buildInsights(d), "trend")!.text).toContain("has grown 3 months in a row");
  });
  it("fewer than 3 months: absent", () => {
    const d = make({ trend: [month("Sep", 10), month("Oct", 5)] });
    expect(find(buildInsights(d), "trend")).toBeUndefined();
  });
  it("only the last 3 months matter", () => {
    const d = make({ trend: [month("Jul", -9), month("Aug", 4), month("Sep", 3), month("Oct", 2)] });
    expect(find(buildInsights(d), "trend")!.text).toContain("paying you back");
  });
});

describe("settle", () => {
  it("closing > 0: Summer pays you", () => {
    const i = find(buildInsights(make({ closingBalance: 4250 })), "settle")!;
    expect(i.text).toBe("To settle, Summer pays you ₹4,250.00");
    expect(i.tone).toBe("positive");
  });
  it("closing < 0: you pay Summer", () => {
    const i = find(buildInsights(make({ closingBalance: -4250 })), "settle")!;
    expect(i.text).toBe("To settle, pay Summer ₹4,250.00");
    expect(i.tone).toBe("negative");
  });
  it("absent when settled", () => {
    expect(find(buildInsights(make({ closingBalance: 0.002 })), "settle")).toBeUndefined();
  });
  it("is the last insight", () => {
    const out = buildInsights(make({ closingBalance: 5 }));
    expect(out[out.length - 1].kind).toBe("settle");
  });
});

describe("ordering with everything present", () => {
  it("follows the card's order", () => {
    const d = make({
      closingBalance: 100,
      ledger: [
        row({ day: "2026-10-18", dayOfMonth: 18, weekday: 6, amount: 80 }),
        row({ day: "2026-10-18", dayOfMonth: 18, weekday: 6, amount: 20 }),
      ],
      totals: { gave: 100, received: 0, net: -100, count: 2, activeDays: 1, addedByMe: 1, addedByFriend: 1 },
      byStatus: {
        pending: { count: 1, amount: 20 },
        verified: { count: 1, amount: 80 },
        rejected: { count: 1, amount: 5 },
      },
      previousMonth: { gave: 10, received: 0, net: -10, count: 1 },
      trend: [month("Aug", -1), month("Sep", -1), month("Oct", -1)],
    });
    expect(kinds(buildInsights(d))).toEqual([
      "balance",
      "biggest",
      "busiestDay",
      "vsLastMonth",
      "average",
      "pending",
      "rejected",
      "whoAdded",
      "trend",
      "settle",
    ]);
  });
});
