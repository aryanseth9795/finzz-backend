import mongoose, { Document, Schema } from "mongoose";
import { hash, compare } from "bcrypt";

/** One persisted refresh-token grant. One row per signed-in device. */
export interface IRefreshTokenGrant {
  /** SHA-256 of the JWT. Never store the token itself — see note below. */
  tokenHash: string;
  /** `jti` of the JWT, so a specific grant can be revoked by id. */
  jti: string;
  device?: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

// TypeScript interface for User document
export interface IUser extends Document {
  name: string;
  phone: string; // PRIMARY LOGIN IDENTIFIER (mobile number)
  password: string;
  email?: string;
  emailVerified: boolean;
  otp?: string; // bcrypt-hashed OTP
  otpExpiry?: Date;
  otpAttempts: number;
  avatar?: string;
  friends: mongoose.Types.ObjectId[];
  /** Expo push tokens, one per signed-in device. */
  pushTokens: string[];
  /** @deprecated Legacy single push token. Read-only; kept for migration. */
  pushToken?: string;
  refreshTokens: IRefreshTokenGrant[];
  /** @deprecated Legacy single refresh token. Accepted during grace period. */
  refreshToken?: string;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
  compareOtp(candidateOtp: string): Promise<boolean>;
}

const refreshTokenGrantSchema = new Schema<IRefreshTokenGrant>(
  {
    // Refresh tokens are bearer credentials: whoever holds one can mint access
    // tokens. Storing only a hash means a database dump does not hand the
    // attacker live sessions. SHA-256 (not bcrypt) is correct here because the
    // input is a 200+ bit random JWT, not a low-entropy human password — there
    // is nothing to brute-force, so the cost factor would buy nothing.
    tokenHash: { type: String, required: true, index: true },
    jti: { type: String, required: true },
    device: { type: String },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    phone: {
      type: String,
      required: true,
      // `unique` already creates the index; declaring `index: true` as well
      // built a duplicate index on every boot.
      unique: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
      // Never ship the hash to a client. Any query that genuinely needs it
      // must opt in with .select("+password"), which makes those call sites
      // greppable and auditable.
      select: false,
    },
    avatar: {
      type: String,
      default: "",
    },
    friends: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    email: {
      type: String,
      unique: true,
      sparse: true, // allows multiple null values
      lowercase: true,
      trim: true,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    otp: {
      type: String, // stored as bcrypt hash
      select: false,
    },
    otpExpiry: {
      type: Date,
      select: false,
    },
    otpAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    pushTokens: {
      type: [String],
      default: [],
    },
    /** @deprecated superseded by pushTokens */
    pushToken: {
      type: String,
    },
    refreshTokens: {
      type: [refreshTokenGrantSchema],
      default: [],
      select: false,
    },
    /** @deprecated superseded by refreshTokens */
    refreshToken: {
      type: String,
      select: false,
    },
  },
  {
    // Previously absent, which is why adminController reconstructed signup
    // dates by decoding the timestamp out of the ObjectId hex. Real timestamp
    // fields are indexable and survive a change of id strategy.
    timestamps: true,
  },
);

// Supports the admin user search (name/phone) and the friend phone lookup.
userSchema.index({ name: 1 });
// Lets the bulk-notification query find push-enabled users without a collection scan.
userSchema.index({ pushTokens: 1 });

userSchema.pre("save", async function (next) {
  const user = this;
  if (!user.isModified("password")) return next();

  this.password = await hash(this.password, 10);
  next();
});

// Instance method for password comparison
userSchema.methods.comparePassword = async function (
  candidatePassword: string,
): Promise<boolean> {
  // Guard against the field being absent because of `select: false`.
  if (!this.password) {
    throw new Error(
      "comparePassword called on a User loaded without +password",
    );
  }
  return compare(candidatePassword, this.password);
};

// Instance method for OTP comparison
userSchema.methods.compareOtp = async function (
  candidateOtp: string,
): Promise<boolean> {
  if (!this.otp) return false;
  return compare(candidateOtp, this.otp);
};

export const User =
  mongoose.models.User || mongoose.model<IUser>("User", userSchema);
