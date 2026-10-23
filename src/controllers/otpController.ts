import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { hash, compare } from "bcrypt";
import TryCatch from "../utils/TryCatch.js";
import { phoneVariants } from "../utils/phone.js";
import { maskEmail } from "../utils/maskEmail.js";
import { User } from "../models/userModel.js";
import {
  OtpRequest,
  OtpPurpose,
  OTP_TTL_MS,
  OTP_VERIFIED_GRACE_MS,
  OTP_MAX_ATTEMPTS,
} from "../models/otpModel.js";
import Errorhandler from "../middlewares/Errorhandler.js";
import { sendOTPEmail } from "../services/emailService.js";
import sendToken, { revokeAllRefreshGrants } from "../utils/sendtoken.js";

/**
 * Generate a 6-digit OTP.
 *
 * `crypto.randomInt` draws from the OS CSPRNG. The previous
 * `Math.floor(100000 + Math.random() * 900000)` used V8's xorshift128+, which
 * is not a cryptographic generator: its internal state is recoverable from a
 * modest number of observed outputs, after which every subsequent code is
 * predictable. For a value that is the sole credential in a password reset,
 * that is the difference between a 10^6 search and no search at all.
 */
const generateOTP = (): string => crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");

const normalizeEmail = (email: string) => email.toLowerCase().trim();

/** Create or replace the live OTP for (email, purpose) and email the code. */
const issueOtp = async (email: string, purpose: OtpPurpose): Promise<void> => {
  const otp = generateOTP();
  const otpHash = await hash(otp, 10);

  await OtpRequest.findOneAndUpdate(
    { email, purpose },
    {
      email,
      purpose,
      otpHash,
      attempts: 0,
      verifiedAt: undefined,
      expiresAt: new Date(Date.now() + OTP_TTL_MS),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  await sendOTPEmail(email, otp, purpose);
};

/**
 * Check a submitted code, counting failures.
 *
 * The attempt counter is the fix for the most serious hole in the old flow:
 * there was none. A 6-digit code has a 10^6 keyspace, the window was 10
 * minutes, and nothing limited guesses — so `resetPassword`, which accepts
 * `{email, otp, newPassword}` in a single call, was a brute-forceable account
 * takeover for any address an attacker knew.
 */
const consumeOtp = async (
  email: string,
  purpose: OtpPurpose,
  submitted: string,
): Promise<{ ok: true } | { ok: false; message: string; status: number }> => {
  const request = await OtpRequest.findOne({ email, purpose });

  if (!request) {
    return {
      ok: false,
      status: 400,
      message: "OTP not found or expired. Please request a new one.",
    };
  }

  if (request.expiresAt < new Date()) {
    await OtpRequest.deleteOne({ _id: request._id });
    return {
      ok: false,
      status: 400,
      message: "OTP has expired. Please request a new one.",
    };
  }

  if (request.attempts >= OTP_MAX_ATTEMPTS) {
    await OtpRequest.deleteOne({ _id: request._id });
    return {
      ok: false,
      status: 429,
      message: "Too many incorrect attempts. Please request a new OTP.",
    };
  }

  const isValid = await compare(submitted, request.otpHash);

  if (!isValid) {
    // $inc is atomic, so concurrent guesses cannot race the counter back down.
    const updated = await OtpRequest.findOneAndUpdate(
      { _id: request._id },
      { $inc: { attempts: 1 } },
      { new: true },
    );
    if (updated && updated.attempts >= OTP_MAX_ATTEMPTS) {
      await OtpRequest.deleteOne({ _id: request._id });
    }
    const remaining = Math.max(0, OTP_MAX_ATTEMPTS - (updated?.attempts ?? 0));
    return {
      ok: false,
      status: 400,
      message: remaining
        ? `Invalid OTP. ${remaining} attempt(s) remaining.`
        : "Invalid OTP. Please request a new one.",
    };
  }

  // Mark verified rather than deleting: registration is a second call that
  // must be able to prove this email was verified moments ago.
  await OtpRequest.updateOne(
    { _id: request._id },
    {
      $set: {
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + OTP_VERIFIED_GRACE_MS),
        attempts: 0,
      },
    },
  );

  return { ok: true };
};

/** True when this email completed verification inside the grace window. */
const hasFreshVerification = async (
  email: string,
  purpose: OtpPurpose,
): Promise<boolean> => {
  const request = await OtpRequest.findOne({ email, purpose });
  return Boolean(
    request?.verifiedAt && request.expiresAt > new Date(),
  );
};

// ─────────────────────────────────────────────
// POST /api/v1/users/send-otp   { email }
// Public – sends a registration/verification OTP.
// ─────────────────────────────────────────────
export const sendOtp = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const email = normalizeEmail((req.body as { email: string }).email);

    // No sentinel User row is created any more. The OTP lives in its own
    // collection, so an abandoned registration leaves nothing behind.
    await issueOtp(email, "verification");

    res.status(200).json({
      success: true,
      message: "OTP sent to your email address",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/verify-otp   { email, otp }
// ─────────────────────────────────────────────
export const verifyOtp = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email, otp } = req.body as { email: string; otp: string };
    const result = await consumeOtp(normalizeEmail(email), "verification", otp);

    if (!result.ok) {
      return next(new Errorhandler(result.message, result.status));
    }

    res.status(200).json({
      success: true,
      message: "OTP verified successfully",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/register   { name, phone, email, password }
// Public – registers after the email OTP was verified.
// ─────────────────────────────────────────────
export const registerWithEmail = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, phone, password, email } = req.body as {
      name: string;
      phone: string;
      password: string;
      email: string;
    };

    const normalizedEmail = normalizeEmail(email);

    if (!(await hasFreshVerification(normalizedEmail, "verification"))) {
      return next(new Errorhandler("Please verify your email OTP first", 400));
    }

    // Both uniqueness checks run before any write, so a rejected registration
    // leaves no partial state. Previously a failed register could strand a
    // verified sentinel account holding the user's email.
    const [existingPhone, existingEmail] = await Promise.all([
      User.findOne({ phone: { $in: phoneVariants(phone) } }).select("_id"),
      User.findOne({ email: normalizedEmail }).select("_id"),
    ]);

    if (existingPhone) {
      return next(
        new Errorhandler("User already exists with this phone number", 400),
      );
    }
    if (existingEmail) {
      return next(new Errorhandler("This email is already registered", 400));
    }

    // A new account has no expenses, so its category list is already "filled"
    // and empty. Set here rather than as a schema default: a default would also
    // apply to old accounts on read, and their one-time first fill would never
    // run (services/expenseCategories.ts).
    const user = await User.create({
      name: name.trim(),
      phone,
      password,
      email: normalizedEmail,
      emailVerified: true,
      expenseCategoriesVersion: 0,
    });

    // The verification has been spent.
    await OtpRequest.deleteOne({
      email: normalizedEmail,
      purpose: "verification",
    });

    await sendToken(res, user, 201, req);
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/forgot-password   { email }
// ─────────────────────────────────────────────
/**
 * POST /api/v1/users/forgot-password   { phone }
 *
 * The user gives only the phone they log in with; the OTP goes to the email
 * registered on that account, which is returned MASKED so they know which
 * inbox to check. Asking for the email instead made users remember (and
 * disclose) an address the server already knows.
 *
 * Whether a phone has an account is already observable through registration
 * ("User already exists with this phone number"), so reporting an unknown
 * number here reveals nothing new; `otpRequestLimiter` bounds probing.
 */
export const forgotPassword = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone } = req.body as { phone: string };

    const user = await User.findOne({ phone: { $in: phoneVariants(phone) } }).select("email");
    if (!user) {
      return next(new Errorhandler("No account found with this number.", 404));
    }
    if (!user.email) {
      return next(
        new Errorhandler(
          "No email is linked to this account. Contact support to reset your password.",
          400,
        ),
      );
    }

    await issueOtp(normalizeEmail(user.email), "reset");

    res.status(200).json({
      success: true,
      message: "A password reset OTP has been sent to your email.",
      maskedEmail: maskEmail(user.email),
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/reset-password   { phone, otp, newPassword }
// ─────────────────────────────────────────────
export const resetPassword = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone, otp, newPassword } = req.body as {
      phone: string;
      otp: string;
      newPassword: string;
    };

    // The OTP was issued to the account's email, so resolve it from the phone.
    const user = await User.findOne({ phone: { $in: phoneVariants(phone) } }).select(
      "+password email",
    );
    if (!user || !user.email) {
      return next(new Errorhandler("Unable to reset password", 400));
    }
    const normalizedEmail = normalizeEmail(user.email);

    const result = await consumeOtp(normalizedEmail, "reset", otp);
    if (!result.ok) {
      return next(new Errorhandler(result.message, result.status));
    }

    user.password = newPassword; // pre-save hook hashes it
    await user.save();

    // A password reset exists to lock an attacker out. Leaving their refresh
    // tokens live would defeat that entirely: they keep access for 30 days
    // regardless of the new password.
    await revokeAllRefreshGrants(String(user._id));
    await OtpRequest.deleteOne({ email: normalizedEmail, purpose: "reset" });

    res.status(200).json({
      success: true,
      message: "Password reset successfully. Please sign in again.",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/change-password   { oldPassword, newPassword }
// ─────────────────────────────────────────────
export const changePassword = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { oldPassword, newPassword } = req.body as {
      oldPassword: string;
      newPassword: string;
    };

    if (oldPassword === newPassword) {
      return next(
        new Errorhandler("New password must differ from the current one", 400),
      );
    }

    const user = await User.findById(userId).select("+password");
    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    if (!(await user.comparePassword(oldPassword))) {
      return next(new Errorhandler("Current password is incorrect", 401));
    }

    user.password = newPassword; // pre-save hook hashes it
    await user.save();

    // Same reasoning as reset: other sessions must not survive.
    await revokeAllRefreshGrants(userId);

    // Re-issue credentials so the device that made the change stays signed in.
    await sendToken(res, user, 200, req);
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/send-verify-email-otp   { email }
// Protected – sends an OTP to link an email to the signed-in account.
// ─────────────────────────────────────────────
export const sendVerifyEmailOtp = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const normalizedEmail = normalizeEmail(
      (req.body as { email: string }).email,
    );

    const emailUser = await User.findOne({ email: normalizedEmail }).select(
      "_id",
    );
    if (emailUser && String(emailUser._id) !== userId) {
      return next(
        new Errorhandler(
          "This email is already associated with another account",
          400,
        ),
      );
    }

    await issueOtp(normalizedEmail, "verification");

    res.status(200).json({
      success: true,
      message: "Verification OTP sent to your email",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/verify-email   { email, otp }
// Protected – links and verifies an email for an existing account.
// ─────────────────────────────────────────────
export const verifyEmail = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { email, otp } = req.body as { email: string; otp: string };
    const normalizedEmail = normalizeEmail(email);

    const emailUser = await User.findOne({ email: normalizedEmail }).select(
      "_id",
    );
    if (emailUser && String(emailUser._id) !== userId) {
      return next(
        new Errorhandler(
          "This email is already associated with another account",
          400,
        ),
      );
    }

    const result = await consumeOtp(normalizedEmail, "verification", otp);
    if (!result.ok) {
      return next(new Errorhandler(result.message, result.status));
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { email: normalizedEmail, emailVerified: true },
      { new: true },
    ).select("_id email emailVerified");

    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    await OtpRequest.deleteOne({
      email: normalizedEmail,
      purpose: "verification",
    });

    res.status(200).json({
      success: true,
      message: "Email verified successfully",
      user: {
        _id: user._id,
        email: user.email,
        emailVerified: user.emailVerified,
      },
    });
  },
);
