import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { connect, disconnect, resetDb, syncIndexes } from "./helpers.js";
import { MonthlySummary } from "../src/models/monthlySummaryModel.js";
import {
  updateSummaryOnAdd,
  updateSummaryOnEdit,
} from "../src/services/summaryService.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(resetDb);

const chatId = new mongoose.Types.ObjectId();
const A = new mongoose.Types.ObjectId().toString();
const B = new mongoose.Types.ObjectId().toString();

// Local-time noon so getYearMonth (local) is stable in any timezone.
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);

const monthDoc = async (year: number, month: number) =>
  MonthlySummary.findOne({ chatId, year, month }).lean() as Promise<any>;

// lean() returns the Map-typed field as a plain object
const stat = (doc: any, id: string) => doc?.members?.[id] ?? {};

describe("updateSummaryOnEdit", () => {
  it("edit: amount-only change applies the difference", async () => {
    await updateSummaryOnAdd(chatId, day(2026, 10, 1), A, B, 15000);
    const before = await monthDoc(2026, 10);

    await updateSummaryOnEdit(
      chatId,
      { date: day(2026, 10, 1), from: A, to: B, amount: 15000 },
      { date: day(2026, 10, 1), from: A, to: B, amount: 1500 },
    );

    const after = await monthDoc(2026, 10);
    expect(stat(after, A).totalSent).toBe(1500);
    expect(stat(after, B).totalReceived).toBe(1500);
    expect(after.txCount).toBe(before.txCount);
    expect(after.txCount).toBe(1);
  });

  it("edit: direction change moves the amount", async () => {
    await updateSummaryOnAdd(chatId, day(2026, 10, 1), A, B, 1000);

    await updateSummaryOnEdit(
      chatId,
      { date: day(2026, 10, 1), from: A, to: B, amount: 1000 },
      { date: day(2026, 10, 1), from: B, to: A, amount: 1000 },
    );

    const doc = await monthDoc(2026, 10);
    expect(stat(doc, A).totalSent).toBe(0);
    expect(stat(doc, A).totalReceived).toBe(1000);
    expect(stat(doc, B).totalSent).toBe(1000);
    expect(stat(doc, B).totalReceived).toBe(0);
    expect(doc.txCount).toBe(1);
  });

  it("edit: month change moves the amount between months", async () => {
    await updateSummaryOnAdd(chatId, day(2026, 9, 15), A, B, 1000);

    await updateSummaryOnEdit(
      chatId,
      { date: day(2026, 9, 15), from: A, to: B, amount: 1000 },
      { date: day(2026, 10, 2), from: A, to: B, amount: 1000 },
    );

    const sep = await monthDoc(2026, 9);
    const oct = await monthDoc(2026, 10);
    expect(stat(sep, A).totalSent).toBe(0);
    expect(stat(sep, B).totalReceived).toBe(0);
    expect(sep.txCount).toBe(0);
    expect(stat(oct, A).totalSent).toBe(1000);
    expect(stat(oct, B).totalReceived).toBe(1000);
    expect(oct.txCount).toBe(1);
  });
});

describe("summary session support", () => {
  it("session: an aborted transaction rolls the summary back", async () => {
    const session = await mongoose.startSession();
    try {
      await session
        .withTransaction(async () => {
          await updateSummaryOnAdd(
            chatId,
            day(2026, 10, 1),
            A,
            B,
            1000,
            session,
          );
          throw new Error("abort");
        })
        .catch((e: Error) => {
          expect(e.message).toBe("abort");
        });
    } finally {
      await session.endSession();
    }

    expect(await monthDoc(2026, 10)).toBeNull();
  });
});
