import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";

// Routes
import userRoutes from "./routes/userRoutes.js";
import txRoutes from "./routes/txnRoutes.js";
import friendRoutes from "./routes/friendRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import statsRoutes from "./routes/statsRoutes.js";
import poolRoutes from "./routes/poolRoutes.js";
import expenseRoutes from "./routes/expenseRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import appRoutes from "./routes/appRoutes.js";

import { CLIENT_ORIGINS } from "./config/envVariables.js";
import { apiLimiter } from "./middlewares/rateLimit.js";
import errorMiddleware from "./middlewares/error.js";
import ErrorHandler from "./middlewares/Errorhandler.js";

/**
 * The Express application, with no side effects.
 *
 * Previously all of this lived in `server.ts` alongside `connectDb()` and
 * `app.listen()`, so importing the app opened a database connection and bound
 * a port. That made the HTTP layer untestable: there was no way to exercise a
 * route without starting the real server against the real database.
 *
 * Splitting construction from bootstrap is what lets the test suite mount this
 * app against a disposable local database via supertest.
 */
const app = express();

// Render/Heroku-style platforms terminate TLS at a proxy. Without this,
// `req.ip` is the proxy's address, which would make every rate limiter treat
// all traffic as one client, and `secure` cookies would be misjudged.
app.set("trust proxy", 1);

// Baseline security headers: HSTS, nosniff, frameguard, referrer policy.
// `contentSecurityPolicy` is disabled because this process serves only JSON —
// a CSP belongs on the static hosts.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(
  cors({
    origin: CLIENT_ORIGINS,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Cap the body size. Express's default is 100 kB for JSON but unlimited for
// urlencoded `extended`, which is a trivial memory-exhaustion vector.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Health check — above the limiter so uptime probes are never throttled, and
// deliberately does not touch the database.
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// Global rate limit. Stricter, route-specific limits are applied on the auth
// and OTP endpoints inside their own routers.
app.use("/api", apiLimiter);

// API Routes
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/txns", txRoutes);
app.use("/api/v1/friends", friendRoutes);
app.use("/api/v1/chats", chatRoutes);
app.use("/api/v1/stats", statsRoutes);
app.use("/api/v1/pools", poolRoutes);
app.use("/api/v1/expenses", expenseRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/app", appRoutes);

// Unknown route → JSON 404. Previously an unmatched path fell through to
// Express's HTML error page, which clients parsing JSON could not read.
app.use((req, _res, next) => {
  next(
    new ErrorHandler(`Route ${req.method} ${req.originalUrl} not found`, 404),
  );
});

// Error handling middleware (must be last)
app.use(errorMiddleware);

export default app;
