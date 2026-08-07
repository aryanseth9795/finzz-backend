import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

/**
 * Environment configuration.
 *
 * Every secret is REQUIRED and validated at boot. There are deliberately no
 * fallback values: a hard-coded default secret is worse than a crash, because
 * a crash is noticed on the next deploy while a default secret silently makes
 * every token in the system forgeable by anyone who has read this file.
 */

const isProduction = process.env.NODE_ENV === "production";

/** Read a required variable or collect the failure. */
const missing: string[] = [];
const required = (name: string): string => {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    missing.push(name);
    return "";
  }
  return value;
};

const JWT_SECRET = required("JWT_SECRET");
const adminSecretKey = required("ADMIN_SECRET_KEY");
const MongoURL = required("MONGO_URL");

// Fail fast, listing everything that is wrong in one pass rather than making
// the operator restart once per missing variable.
if (missing.length > 0) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(", ")}. ` +
      `Refer to .env.example. The server will not start without them.`,
  );
}

// A short secret makes brute-forcing the HMAC feasible offline. 32 bytes is the
// output size of SHA-256, which is what HS256 uses; anything shorter adds no
// security beyond the key length itself.
if (JWT_SECRET.length < 32) {
  const message =
    `JWT_SECRET is ${JWT_SECRET.length} characters; at least 32 is required. ` +
    `Generate one with: openssl rand -base64 48`;
  if (isProduction) throw new Error(message);
  console.warn(`[config] WARNING: ${message}`);
}

if (adminSecretKey.length < 24) {
  const message =
    `ADMIN_SECRET_KEY is ${adminSecretKey.length} characters; at least 24 is required. ` +
    `It is the single credential guarding every admin action.`;
  if (isProduction) throw new Error(message);
  console.warn(`[config] WARNING: ${message}`);
}

// ── Token lifetimes ────────────────────────────────────────────────────────
// Access tokens are short-lived because they are replayable until they expire.
// Refresh tokens are long-lived but revocable (stored per-device server-side).
const ACCESS_TOKEN_EXPIRES_IN = process.env.ACCESS_TOKEN_EXPIRES_IN || "2d";
const REFRESH_TOKEN_EXPIRES_IN = process.env.REFRESH_TOKEN_EXPIRES_IN || "30d";
const ADMIN_TOKEN_EXPIRES_IN = process.env.ADMIN_TOKEN_EXPIRES_IN || "12h";

const COOKIE_EXPIRES_IN = process.env.COOKIE_EXPIRES_IN
  ? parseInt(process.env.COOKIE_EXPIRES_IN, 10)
  : 7;

const RESEND_API_KEY = process.env.RESEND_API || "";

/**
 * Mail transport.
 *
 * "console" logs the OTP instead of sending it — for local development and
 * automated tests, where delivering real email to real inboxes is both useless
 * and harmful. It is refused in production so it can never be reached by an
 * environment misconfiguration.
 *
 * Making this an explicit setting rather than inferring it from "is the API
 * key missing?" matters: an absent key is ambiguous — it could equally mean a
 * broken production deploy — and silently degrading to console output there
 * would mean password resets appearing to succeed while no email is ever sent.
 */
const MAIL_TRANSPORT: "resend" | "console" =
  process.env.MAIL_TRANSPORT === "console" && !isProduction
    ? "console"
    : "resend";

if (MAIL_TRANSPORT === "resend" && !RESEND_API_KEY) {
  console.warn(
    "[config] RESEND_API is not set — OTP and verification emails will fail. " +
      "Set MAIL_TRANSPORT=console for local development.",
  );
}

const PORT = parseInt(process.env.PORT || "3000", 10);

/**
 * Origins permitted to send credentialed cross-site requests.
 * Configurable so a new admin deployment does not require a code change.
 */
const CLIENT_ORIGINS = (
  process.env.CLIENT_ORIGINS ||
  "https://finzzadmin.netlify.app,http://localhost:5173"
)
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/** Public URL of this service, used by the keep-alive ping. Optional. */
const API_URL = process.env.API_URL || "";

const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env.RATE_LIMIT_WINDOW_MS || "900000", // 15 minutes
  10,
);
const RATE_LIMIT_MAX_REQUESTS = parseInt(
  process.env.RATE_LIMIT_MAX_REQUESTS || "300",
  10,
);

export {
  isProduction,
  JWT_SECRET,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
  ADMIN_TOKEN_EXPIRES_IN,
  COOKIE_EXPIRES_IN,
  adminSecretKey,
  MongoURL,
  RESEND_API_KEY,
  MAIL_TRANSPORT,
  PORT,
  CLIENT_ORIGINS,
  API_URL,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
};
