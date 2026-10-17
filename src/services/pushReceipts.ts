import { Expo } from "expo-server-sdk";
import { User } from "../models/userModel.js";
import { PushTicket } from "../models/pushTicketModel.js";

const expo = new Expo();

/** Expo makes receipts available roughly 15 minutes after sending. */
const DEFAULT_OLDER_THAN_MS = 15 * 60 * 1000;
const DEFAULT_LIMIT = 1000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface ReceiptRunResult {
  checked: number;
  ok: number;
  errors: Record<string, number>;
  pruned: number;
}

/**
 * Fetch Expo push receipts for tickets that are old enough to have one, store
 * the outcome on each ticket row, and delete tokens reported as dead.
 *
 * A ticket with status "ok" only means Expo queued the message. Failures such
 * as `InvalidCredentials`, `MismatchSenderId`, `MessageTooBig` or an FCM-side
 * `DeviceNotRegistered` appear only here.
 */
export async function processPushReceipts(
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<ReceiptRunResult> {
  const olderThanMs = opts.olderThanMs ?? DEFAULT_OLDER_THAN_MS;
  const limit = opts.limit ?? DEFAULT_LIMIT;

  const result: ReceiptRunResult = { checked: 0, ok: 0, errors: {}, pruned: 0 };

  const tickets = await PushTicket.find({
    checkedAt: { $exists: false },
    createdAt: { $lte: new Date(Date.now() - olderThanMs) },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select("ticketId token")
    .lean<{ ticketId: string; token: string }[]>();

  if (tickets.length === 0) {
    console.log("[push-receipts] checked=0 ok=0 errors={}");
    return result;
  }

  const tokenByTicket = new Map(tickets.map((t) => [t.ticketId, t.token]));
  const dead = new Set<string>();

  for (const ids of expo.chunkPushNotificationReceiptIds([
    ...tokenByTicket.keys(),
  ])) {
    let receipts: Awaited<ReturnType<typeof expo.getPushNotificationReceiptsAsync>>;
    try {
      receipts = await expo.getPushNotificationReceiptsAsync(ids);
    } catch (error) {
      // Leave these tickets unchecked; the next run retries them.
      console.error("[push-receipts] fetch failed:", errorMessage(error));
      continue;
    }

    const now = new Date();
    const ops: any[] = [];

    for (const [ticketId, receipt] of Object.entries(receipts)) {
      if (!tokenByTicket.has(ticketId) || !receipt) continue;
      result.checked += 1;

      if (receipt.status === "ok") {
        result.ok += 1;
        ops.push({
          updateOne: {
            filter: { ticketId },
            update: { $set: { status: "ok", checkedAt: now } },
          },
        });
        continue;
      }

      const code = receipt.details?.error ?? "Unknown";
      result.errors[code] = (result.errors[code] ?? 0) + 1;
      if (code === "DeviceNotRegistered") {
        dead.add(tokenByTicket.get(ticketId)!);
      }
      ops.push({
        updateOne: {
          filter: { ticketId },
          update: {
            $set: {
              status: "error",
              error: code,
              message: receipt.message,
              checkedAt: now,
            },
          },
        },
      });
    }

    if (ops.length > 0) {
      try {
        await PushTicket.bulkWrite(ops, { ordered: false });
      } catch (error) {
        console.error("[push-receipts] save failed:", errorMessage(error));
      }
    }
  }

  if (dead.size > 0) {
    const tokens = [...dead];
    try {
      await Promise.all([
        User.updateMany(
          { pushTokens: { $in: tokens } },
          { $pull: { pushTokens: { $in: tokens } } },
        ),
        User.updateMany(
          { pushToken: { $in: tokens } },
          { $unset: { pushToken: "" } },
        ),
      ]);
      result.pruned = tokens.length;
    } catch (error) {
      console.error("[push-receipts] prune failed:", errorMessage(error));
    }
  }

  console.log(
    `[push-receipts] checked=${result.checked} ok=${result.ok} errors=${JSON.stringify(result.errors)}`,
  );
  return result;
}

/** Delivery health over a recent window, for the admin to read. */
export async function recentDeliveryStats(sinceMs = 24 * 3600e3): Promise<{
  total: number;
  checked: number;
  ok: number;
  errors: Record<string, number>;
  lastError?: string;
}> {
  const since = new Date(Date.now() - sinceMs);

  const [grouped, lastFailed] = await Promise.all([
    PushTicket.aggregate<{ _id: { status?: string; error?: string }; n: number }>([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { status: "$status", error: "$error" },
          n: { $sum: 1 },
        },
      },
    ]),
    PushTicket.findOne({
      createdAt: { $gte: since },
      status: "error",
    })
      .sort({ checkedAt: -1 })
      .select("error message")
      .lean<{ error?: string; message?: string }>(),
  ]);

  const stats: {
    total: number;
    checked: number;
    ok: number;
    errors: Record<string, number>;
    lastError?: string;
  } = { total: 0, checked: 0, ok: 0, errors: {} };

  for (const g of grouped) {
    stats.total += g.n;
    if (g._id.status === "ok") {
      stats.checked += g.n;
      stats.ok += g.n;
    } else if (g._id.status === "error") {
      stats.checked += g.n;
      const code = g._id.error ?? "Unknown";
      stats.errors[code] = (stats.errors[code] ?? 0) + g.n;
    }
  }

  if (lastFailed) {
    stats.lastError = lastFailed.message ?? lastFailed.error;
  }
  return stats;
}
