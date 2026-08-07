import mongoose, { Document, Schema } from "mongoose";

export type OtpPurpose = "verification" | "reset";

export interface IOtpRequest extends Document {
  email: string;
  /** bcrypt hash of the 6-digit code. Never the code itself. */
  otpHash: string;
  purpose: OtpPurpose;
  attempts: number;
  /** Set once the code has been checked successfully. */
  verifiedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One-time codes live here, not on the User document.
 *
 * Previously `sendOtp` created a real `User` row with sentinel values
 * (`phone: "pending_<email>_otp"`, `name: "__pending__"`, `password: <the
 * hashed OTP>`) to have somewhere to hang the code. That had four consequences:
 * fake accounts appeared in the admin user list and in every user count; the
 * OTP hash was reused as a password hash; a failed registration stranded a
 * half-created verified account that the user could not recover; and the OTP
 * lifecycle was tangled with the account lifecycle.
 *
 * A dedicated collection with a TTL index removes all four. The public API is
 * unchanged, so no client needs to be updated.
 */
const otpRequestSchema = new Schema<IOtpRequest>(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    otpHash: { type: String, required: true },
    purpose: {
      type: String,
      enum: ["verification", "reset"],
      required: true,
    },
    attempts: { type: Number, default: 0 },
    verifiedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);

// One live request per (email, purpose): requesting a new code invalidates the
// previous one, so an attacker cannot keep several valid codes in flight.
otpRequestSchema.index({ email: 1, purpose: 1 }, { unique: true });

// MongoDB deletes the document once `expiresAt` passes. Expiry is enforced by
// the database rather than by remembering to check it at every call site, and
// spent codes cannot accumulate.
otpRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OtpRequest =
  mongoose.models.OtpRequest ||
  mongoose.model<IOtpRequest>("OtpRequest", otpRequestSchema);

/** Codes are valid for 10 minutes. */
export const OTP_TTL_MS = 10 * 60 * 1000;

/**
 * A verified code stays usable for 15 minutes so the client can complete
 * registration, then expires. Without a bound, a verification from days ago
 * would still authorise account creation.
 */
export const OTP_VERIFIED_GRACE_MS = 15 * 60 * 1000;

/** Wrong guesses allowed before the code is destroyed. */
export const OTP_MAX_ATTEMPTS = 5;
