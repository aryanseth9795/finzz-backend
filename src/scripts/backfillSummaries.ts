/**
 * Backfill MonthlySummary from existing transactions.
 *
 * Run once after deploying the new MonthlySummary model:
 *   npx ts-node src/scripts/backfillSummaries.ts
 *
 * Or after building:
 *   node dist/scripts/backfillSummaries.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (works from both src and dist)
const envPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath });

import { Tx } from "../models/txModel.js";
import { MonthlySummary } from "../models/monthlySummaryModel.js";

async function backfill() {
  const mongoUri = process.env.MONGO_URL;
  if (!mongoUri) {
    console.error("MONGO_URL not set in .env");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  // Clear existing summaries (fresh backfill)
  await MonthlySummary.deleteMany({});
  console.log("Cleared existing MonthlySummary documents");

  // Aggregate all transactions grouped by chatId + year + month + user direction
  const pipeline = [
    {
      $group: {
        _id: {
          chatId: "$chatId",
          year: { $year: "$date" },
          month: { $month: "$date" },
        },
        txns: {
          $push: {
            from: "$from",
            to: "$to",
            amount: "$amount",
          },
        },
        txCount: { $sum: 1 },
      },
    },
  ];

  const results = await Tx.aggregate(pipeline);
  console.log(`Found ${results.length} chat-month groups to backfill`);

  let created = 0;
  for (const group of results) {
    const { chatId, year, month } = group._id;

    // Build per-user stats
    const members: Record<
      string,
      { totalSent: number; totalReceived: number }
    > = {};

    for (const txn of group.txns) {
      const fromId = txn.from.toString();
      const toId = txn.to.toString();

      if (!members[fromId]) {
        members[fromId] = { totalSent: 0, totalReceived: 0 };
      }
      if (!members[toId]) {
        members[toId] = { totalSent: 0, totalReceived: 0 };
      }

      members[fromId].totalSent += txn.amount;
      members[toId].totalReceived += txn.amount;
    }

    await MonthlySummary.create({
      chatId,
      year,
      month,
      members,
      txCount: group.txCount,
    });

    created++;
  }

  console.log(`✅ Backfilled ${created} MonthlySummary documents`);

  await mongoose.disconnect();
  console.log("Disconnected from MongoDB");
  process.exit(0);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
