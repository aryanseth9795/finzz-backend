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

/**
 * ADMIN_SECRET_KEY is either:
 *  - a 6-character PIN of letters/digits (safe only because admin login is
 *    protected by a persistent per-IP and global lockout), or
 *  - the legacy long secret of 24+ characters.
 * Anything else is rejected.
 */
export const validateAdminSecret = (
  value: string,
  isProduction: boolean,
):
  | { ok: true; kind: "pin"; weak?: true }
  | { ok: true; kind: "secret" }
  | { ok: false; message: string } => {
  if (/^[A-Za-z0-9]{6}$/.test(value)) {
    // A digits-only PIN has just 10^6 combinations.
    return /^[0-9]{6}$/.test(value)
      ? { ok: true, kind: "pin", weak: true }
      : { ok: true, kind: "pin" };
  }
  if (value.length >= 24) return { ok: true, kind: "secret" };
  return {
    ok: false,
    message:
      `ADMIN_SECRET_KEY is ${value.length} characters and is not a valid PIN; ` +
      `it must be exactly 6 letters/digits (a PIN) or at least 24 characters. ` +
      `It is the single credential guarding every admin action.` +
      (isProduction ? "" : " (allowed in development only)"),
  };
};

const adminSecretCheck = validateAdminSecret(adminSecretKey, isProduction);
if (!adminSecretCheck.ok) {
  if (isProduction) throw new Error(adminSecretCheck.message);
  console.warn(`[config] WARNING: ${adminSecretCheck.message}`);
} else if (adminSecretCheck.kind === "pin" && adminSecretCheck.weak) {
  console.warn(
    "[config] WARNING: ADMIN_SECRET_KEY is a digits-only PIN: only 10^6 " +
      "combinations. The login lockout makes this workable, but an " +
      "alphanumeric PIN (36^6 combinations) is much stronger.",
  );
}

/** Which credential the admin login expects; drives the wording of errors. */
const adminSecretKind: "pin" | "secret" = /^[A-Za-z0-9]{6}$/.test(
  adminSecretKey,
)
  ? "pin"
  : "secret";

/** 401 message for a wrong admin credential, named after the active mode. */
export const wrongAdminCredentialMessage = (kind: "pin" | "secret"): string =>
  kind === "pin" ? "Wrong PIN" : "Wrong secret key";

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

/**
 * How many reverse proxies sit in front of this server (Express `trust proxy`).
 *
 * `req.ip` — and with it every per-IP rate limit, the admin-login per-IP lock
 * and ADMIN_LOGIN_ALLOWLIST_IPS — is read from `X-Forwarded-For`, trusting
 * exactly this many hops. Too high lets a client forge its address by sending
 * its own header; too low makes every client look like the proxy. It must match
 * the real deployment (Render: 1). Optional; defaults to 1. An invalid value
 * warns once and falls back to 1.
 */
export const parseTrustProxyHops = (
  raw: string | undefined,
  warn: (message: string) => void = console.warn,
): number => {
  const value = (raw ?? "").trim();
  if (value === "") return 1;
  if (/^\d{1,3}$/.test(value)) return parseInt(value, 10);
  warn(
    `[config] WARNING: TRUST_PROXY_HOPS="${value}" is not a whole number of ` +
      `proxy hops; falling back to 1.`,
  );
  return 1;
};

const TRUST_PROXY_HOPS = parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);

export {
  isProduction,
  JWT_SECRET,
  ACCESS_TOKEN_EXPIRES_IN,
  REFRESH_TOKEN_EXPIRES_IN,
  ADMIN_TOKEN_EXPIRES_IN,
  COOKIE_EXPIRES_IN,
  adminSecretKey,
  adminSecretKind,
  MongoURL,
  RESEND_API_KEY,
  MAIL_TRANSPORT,
  PORT,
  CLIENT_ORIGINS,
  API_URL,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  TRUST_PROXY_HOPS,
};
