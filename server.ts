import mongoose from "mongoose";
import axios from "axios";

import app from "./src/app.js";
import {
  MongoURL,
  PORT,
  API_URL,
  isProduction,
} from "./src/config/envVariables.js";
import connectDb from "./src/db/db.js";
import {
  flushActivity,
  startActivityFlush,
} from "./src/services/activityTracker.js";
import { processPushReceipts } from "./src/services/pushReceipts.js";

/**
 * Process bootstrap. The Express application itself lives in `src/app.ts` and
 * is free of side effects, so it can be mounted by tests without opening a
 * database connection or binding a port.
 */

/**
 * Keep-alive ping for free-tier hosts that idle out.
 *
 * Three defects in the previous version: the promise had no `.catch()`, so a
 * rejection became an unhandled rejection — fatal on Node 15+; `API_URL` was
 * never defined in .env, so the request went to the literal string
 * "undefined/health" and rejected every twelve minutes; and the interval was
 * never cleared on shutdown.
 */
let pingTimer: NodeJS.Timeout | undefined;

const startKeepAlive = () => {
  if (!API_URL) {
    console.warn("[keep-alive] API_URL not set — self-ping disabled.");
    return;
  }
  pingTimer = setInterval(
    () => {
      axios
        .get(`${API_URL.replace(/\/$/, "")}/health`, { timeout: 10_000 })
        .catch((error) =>
          console.warn("[keep-alive] ping failed:", error.message),
        );
    },
    12 * 60 * 1000,
  );
  // Do not let the ping hold the event loop open during shutdown.
  pingTimer.unref();
};

/**
 * Fetch Expo push receipts every 10 minutes so delivery failures (bad FCM
 * credentials, dead tokens) are recorded and dead tokens pruned. Never throws.
 */
let receiptTimer: NodeJS.Timeout | undefined;

const startReceiptChecks = () => {
  receiptTimer = setInterval(
    () => {
      processPushReceipts().catch((error) =>
        console.error("[push-receipts] run failed:", error),
      );
    },
    10 * 60 * 1000,
  );
  receiptTimer.unref();
};

const start = async () => {
  // Previously `connectDb(...)` was called without `await`, so the server began
  // accepting requests before the database was reachable — early requests
  // failed with confusing errors instead of the process failing loudly.
  await connectDb(MongoURL);
  startReceiptChecks();

  // Persist the buffered traffic counts every 30 s (the timer is unref'd).
  const stopActivityFlush = startActivityFlush();

  const server = app.listen(PORT, () => {
    console.log(
      `Server listening on port ${PORT} (${isProduction ? "production" : "development"})`,
    );
    startKeepAlive();
  });

  /**
   * Graceful shutdown. Without this, a deploy or scale-down kills the process
   * mid-request and mid-transaction; in-flight writes are lost and sockets are
   * reset rather than closed.
   */
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} received, closing gracefully…`);
    if (pingTimer) clearInterval(pingTimer);
    stopActivityFlush();
    if (receiptTimer) clearInterval(receiptTimer);

    server.close(async () => {
      try {
        // Persist the last buffered counts while the connection is still open.
        await flushActivity();
      } catch (error) {
        console.error("[shutdown] error flushing activity:", error);
      }
      try {
        await mongoose.connection.close(false);
      } catch (error) {
        console.error("[shutdown] error closing MongoDB:", error);
      }
      process.exit(0);
    });

    // Backstop: never hang forever waiting for a stuck connection.
    setTimeout(() => {
      console.error("[shutdown] forced exit after timeout");
      process.exit(1);
    }, 15_000).unref();
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    console.error("[fatal] unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[fatal] uncaught exception:", error);
    process.exit(1);
  });
};

start().catch((error) => {
  console.error("[fatal] failed to start server:", error);
  process.exit(1);
});

export default app;
