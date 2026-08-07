import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import {
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from "../config/envVariables.js";

/**
 * Rate limiting.
 *
 * There was none anywhere in the service, despite `.env` defining
 * RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS that nothing read and
 * `express-rate-limit` not being installed. The consequence was not abstract:
 * the login endpoint, the admin secret-key endpoint, and the OTP verification
 * endpoint were all unlimited, which is what turned a 6-digit OTP with no
 * attempt counter into a practical account-takeover path.
 *
 * Limits are tiered by what an endpoint protects, because a single global
 * number is either too loose for credentials or too tight for normal browsing.
 */

const jsonHandler = (message: string) => ({
  success: false,
  message,
});

/** Broad limit for the whole API surface. Generous; catches runaway clients. */
export const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true, // RateLimit-* headers so clients can back off
  legacyHeaders: false,
  message: jsonHandler("Too many requests. Please try again shortly."),
});

/**
 * Credential endpoints: login, register, admin login.
 *
 * Keyed by IP *and* by the identifier being attempted, so one attacker cycling
 * through many accounts from one address is limited, and a distributed attack
 * against a single account is also limited. `ipKeyGenerator` is used rather
 * than raw `req.ip` because it normalises IPv6 addresses to a /64 prefix —
 * without it, an attacker with an IPv6 range gets a fresh bucket per request.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed attempts count toward the limit
  keyGenerator: (req) => {
    const identifier =
      (req.body?.phone as string) ||
      (req.body?.email as string) ||
      "anonymous";
    return `${ipKeyGenerator(req.ip ?? "")}:${identifier}`;
  },
  message: jsonHandler(
    "Too many failed attempts. Please try again in 15 minutes.",
  ),
});

/**
 * OTP issuance. Strict, because each request sends an email — an unlimited
 * endpoint is both an account-enumeration tool and a way to use this service
 * to spam a third party's inbox.
 */
export const otpRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? "")}:${(req.body?.email as string) || "anonymous"}`,
  message: jsonHandler(
    "Too many OTP requests. Please wait before requesting another.",
  ),
});

/**
 * OTP verification. The per-code attempt counter in otpController is the
 * primary defence; this bounds how fast an attacker can burn through codes by
 * requesting new ones.
 */
export const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip ?? "")}:${(req.body?.email as string) || "anonymous"}`,
  message: jsonHandler("Too many verification attempts. Please try again later."),
});

/** Expensive or abusable endpoints: search, contact sync, exports, uploads. */
export const heavyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: jsonHandler("Too many requests. Please slow down."),
});
