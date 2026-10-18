import mongoose, { Document, Schema } from "mongoose";

export interface IAdminLoginGuard extends Document {
  /** "ip:<address>" for a per-IP counter, or "global" for the all-IP counter. */
  key: string;
  /** Consecutive failures (per IP), or failures inside the current window (global). */
  failures: number;
  /** While in the future, login attempts are refused. */
  lockedUntil: Date | null;
  /** Start of the current counting window. Used by the global counter only. */
  windowStart: Date | null;
  /** How many times this key has been locked; drives the doubling lock time. */
  lockCount: number;
  /** MongoDB removes the row once this passes (TTL index below). */
  expiresAt: Date;
}

/**
 * Persistent brute-force guard for the admin login.
 *
 * An in-memory limiter resets on every restart or deploy and cannot see
 * requests handled by another instance, so an attacker could simply wait for
 * (or provoke) a restart. Because the admin credential can be a short PIN, the
 * lockout state must survive restarts, so it lives in the database.
 */
const adminLoginGuardSchema = new Schema<IAdminLoginGuard>(
  {
    key: { type: String, required: true, unique: true },
    failures: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    windowStart: { type: Date, default: null },
    lockCount: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// Stale rows (an IP that tried once and never came back) clean themselves up.
adminLoginGuardSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminLoginGuard =
  mongoose.models.AdminLoginGuard ||
  mongoose.model<IAdminLoginGuard>("AdminLoginGuard", adminLoginGuardSchema);

/** Rows are kept for 7 days after their last activity or lock. */
export const GUARD_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
