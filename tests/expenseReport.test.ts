import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  auth,
  type TestUser,
} from "./helpers.js";
import { ExpenseLedger } from "../src/models/expenseLedgerModel.js";
import { expenseCategoryOf } from "../src/services/expenseReport/category.js";

/**
 * T007-E6: the expense PDF export (GET /api/v1/expenses/export).
 *
 * The old builder interpolated category names raw, used its own category rule
 * and a different fallback label than the app, took percentages from the
 * ledger total instead of the debit sum, and bucketed days in server-local
 * time. These tests pin the corrected behaviour at the HTTP surface.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
});

const addExpense = async (body: Record<string, unknown>) =>
  request(app)
    .post("/api/v1/expenses")
    .set(auth(alice.accessToken))
    .send({ tzOffsetMinutes: 330, ...body })
    .expect(201);

const ledgerId = async (): Promise<string> => {
  const ledger = await ExpenseLedger.findOne({ userId: alice.id });
  return String(ledger!._id);
};

const exportHtml = async (query = ""): Promise<string> => {
  const id = await ledgerId();
  const res = await request(app)
    .get(`/api/v1/expenses/export?ledgerId=${id}${query}`)
    .set(auth(alice.accessToken))
    .expect(200);
  expect(res.body.success).toBe(true);
  return res.body.html as string;
};

const categoryNames = (html: string): string[] =>
  [...html.matchAll(/data-cat="([^"]*)"/g)].map((m) => m[1]);

describe("expenseCategoryOf (unit)", () => {
  it("lets a leading #tag in remarks win over the category", () => {
    expect(expenseCategoryOf({ category: "Food", remarks: "#travel" })).toBe(
      "travel",
    );
    // Same as the stats screen: everything after the # is the tag.
    expect(expenseCategoryOf({ category: "Food", remarks: "#travel cab" })).toBe(
      "travel cab",
    );
    expect(expenseCategoryOf({ category: "Food", remarks: "#  " })).toBe("Food");
  });
  it("falls back to the trimmed category, then to Other", () => {
    expect(expenseCategoryOf({ category: "  Food ", remarks: "lunch" })).toBe(
      "Food",
    );
    expect(expenseCategoryOf({ category: "", remarks: "lunch" })).toBe("Other");
    expect(expenseCategoryOf({ category: "-" })).toBe("Other");
    expect(expenseCategoryOf({})).toBe("Other");
  });
});

describe("Expense PDF export", () => {
  it("HTML-escapes a hostile category name", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    await addExpense({
      amount: 100,
      date: "2026-10-10T06:00:00.000Z",
      category: hostile,
    });

    const html = await exportHtml();
    expect(html).not.toContain(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });

  it("categorises '#travel cab' by its tag, not the category field", async () => {
    await addExpense({
      amount: 250,
      date: "2026-10-10T06:00:00.000Z",
      category: "Food",
      remarks: "#travel cab",
    });

    const names = categoryNames(await exportHtml());
    expect(names).toContain("travel cab");
    expect(names).not.toContain("Food");
  });

  it("labels an empty category 'Other', not 'Uncategorized'", async () => {
    await addExpense({ amount: 80, date: "2026-10-10T06:00:00.000Z" });

    const html = await exportHtml();
    expect(categoryNames(html)).toContain("Other");
    expect(html).not.toContain("Uncategorized");
  });

  it("computes category % from the debit sum, not ledger.totalExpenses", async () => {
    await addExpense({ amount: 300, date: "2026-10-10T06:00:00.000Z", category: "Food" });
    await addExpense({ amount: 200, date: "2026-10-11T06:00:00.000Z", category: "Rent" });
    await addExpense({ amount: 500, date: "2026-10-12T06:00:00.000Z", category: "Fun" });
    // Corrupt the denominator the old code used.
    await ExpenseLedger.updateOne(
      { userId: alice.id },
      { $set: { totalExpenses: 99999 } },
    );

    const html = await exportHtml();
    const pcts = [...html.matchAll(/data-pct="([\d.]+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(pcts.length).toBe(3);
    const sum = pcts.reduce((a, b) => a + b, 0);
    expect(sum).toBeGreaterThan(99.8);
    expect(sum).toBeLessThan(100.2);
    expect(pcts).toContain(50);
  });

  it("buckets days in the user's timezone (IST), not the server's", async () => {
    // 2026-10-14 20:00 UTC is 15 Oct 01:30 in IST.
    await addExpense({ amount: 120, date: "2026-10-14T20:00:00.000Z", category: "Food" });

    const ist = await exportHtml("&tzOffsetMinutes=330");
    expect(ist).toContain('data-day="2026-10-15"');
    expect(ist).not.toContain('data-day="2026-10-14"');
    expect(ist).toContain('data-bar-day="15"');

    const utc = await exportHtml();
    expect(utc).toContain('data-day="2026-10-14"');
    expect(utc).toContain('data-bar-day="14"');
  });

  it("is print-ready and script-free", async () => {
    await addExpense({ amount: 100, date: "2026-10-10T06:00:00.000Z", category: "Food" });
    await addExpense({
      amount: 900,
      date: "2026-10-11T06:00:00.000Z",
      type: "credit",
      remarks: "salary",
    });

    const html = await exportHtml();
    expect(html).toContain("@page");
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<(link|img)\b/i);
    expect(html).not.toContain(alice.phone);
  });

  it("uses a neutral 'You spent' headline when nothing was received", async () => {
    await addExpense({ amount: 1500, date: "2026-10-10T06:00:00.000Z", category: "Food" });

    const html = await exportHtml();
    const hero = html.match(/<div class="hero-sentence[^"]*">([^<]*)<\/div>/);
    expect(hero).not.toBeNull();
    expect(hero![1]).toMatch(/^You spent .*1,500.* in October 2026$/);
    expect(hero![1]).not.toMatch(/overspent/i);
    expect(html).toMatch(/\.hero-sentence\.neutral\s*\{\s*color:\s*#111827/);
    expect(html).toMatch(/class="hero-sentence neutral"/);
  });

  it("keeps 'overspent' when income exists but spending is higher", async () => {
    await addExpense({ amount: 1500, date: "2026-10-10T06:00:00.000Z", category: "Food" });
    await addExpense({
      amount: 500,
      date: "2026-10-11T06:00:00.000Z",
      type: "credit",
      remarks: "salary",
    });

    const html = await exportHtml();
    const hero = html.match(/<div class="hero-sentence[^"]*">([^<]*)<\/div>/);
    expect(hero![1]).toMatch(/overspent/i);
    expect(html).not.toMatch(/class="hero-sentence neutral"/);
  });
});
