import { Request, Response, NextFunction } from "express";
import { hash } from "bcrypt";
import TryCatch from "../utils/TryCatch.js";
import { User } from "../models/userModel.js";
import Errorhandler from "../middlewares/Errorhandler.js";
import { sendOTPEmail } from "../services/emailService.js";
import sendToken from "../utils/sendtoken.js";

// Helper: generate a 6-digit OTP
const generateOTP = (): string =>
  Math.floor(100000 + Math.random() * 900000).toString();

// Helper: 10 minutes from now
const otpExpiry = () => new Date(Date.now() + 10 * 60 * 1000);

// ─────────────────────────────────────────────
// POST /api/v1/users/send-otp
// Body: { email }
// Public – sends an OTP to the given email.
// Used for: registration, forgot-password, and existing-user email linking.
// ─────────────────────────────────────────────
export const sendOtp = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email } = req.body as { email: string };

    const otp = generateOTP();
    const hashedOtp = await hash(otp, 10);

    // Try to find an existing user by email (could be empty if new registration)
    let user = await User.findOne({ email: email.toLowerCase().trim() });

    if (user) {
      // Update OTP fields on existing user
      user.otp = hashedOtp;
      user.otpExpiry = otpExpiry();
      await user.save({ validateBeforeSave: false });
    } else {
      // Store OTP temporarily using a placeholder phone (will be replaced on register)
      // Actually, we store the OTP in a pending user record keyed by email only
      // For new registrations, we create a temporary user with minimal data
      // We use a sentinel phone to hold the OTP – replaced on actual register
      const tempPhone = `pending_${email.replace(/[^a-z0-9]/gi, "_")}_otp`;
      const existing = await User.findOne({ phone: tempPhone });
      if (existing) {
        existing.otp = hashedOtp;
        existing.otpExpiry = otpExpiry();
        await existing.save({ validateBeforeSave: false });
      } else {
        await User.create({
          name: "__pending__",
          phone: tempPhone,
          password: hashedOtp, // placeholder, will be replaced or deleted
          email: email.toLowerCase().trim(),
          emailVerified: false,
          otp: hashedOtp,
          otpExpiry: otpExpiry(),
        });
      }
    }

    await sendOTPEmail(email, otp, "verification");

    res.status(200).json({
      success: true,
      message: "OTP sent to your email address",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/verify-otp
// Body: { email, otp }
// Public – verifies OTP. Returns { verified: true } on success.
// ─────────────────────────────────────────────
export const verifyOtp = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email, otp } = req.body as { email: string; otp: string };

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !user.otp || !user.otpExpiry) {
      return next(
        new Errorhandler("OTP not found. Please request a new OTP.", 400),
      );
    }

    if (user.otpExpiry < new Date()) {
      return next(
        new Errorhandler("OTP has expired. Please request a new one.", 400),
      );
    }

    const isValid = await user.compareOtp(otp);
    if (!isValid) {
      return next(new Errorhandler("Invalid OTP", 400));
    }

    // Clear OTP fields after successful verification
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save({ validateBeforeSave: false });

    res.status(200).json({
      success: true,
      message: "OTP verified successfully",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/register  (UPDATED)
// Body: { name, phone, email, password }
// Public – registers after OTP was verified for email.
// ─────────────────────────────────────────────
export const registerWithEmail = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, phone, password, email } = req.body as {
      name: string;
      phone: string;
      password: string;
      email: string;
    };

    const normalizedEmail = email.toLowerCase().trim();

    // Check phone uniqueness
    const existingPhone = await User.findOne({ phone });
    if (existingPhone && existingPhone.name !== "__pending__") {
      return next(
        new Errorhandler("User already exists with this phone number", 400),
      );
    }

    // Find the temp user created during OTP send
    const tempPhone = `pending_${normalizedEmail.replace(/[^a-z0-9]/gi, "_")}_otp`;
    const tempUser = await User.findOne({ phone: tempPhone });

    // If tempUser exists AND OTP is still present it means verify-otp was not called
    if (tempUser && tempUser.otp) {
      return next(new Errorhandler("Please verify your email OTP first", 400));
    }

    // Delete temp record
    if (tempUser) {
      await User.deleteOne({ _id: tempUser._id });
    }

    // Also check if any real user has this email
    const emailUser = await User.findOne({ email: normalizedEmail });
    if (emailUser && emailUser.name !== "__pending__") {
      return next(new Errorhandler("This email is already registered", 400));
    }
    if (emailUser && emailUser.name === "__pending__") {
      await User.deleteOne({ _id: emailUser._id });
    }

    const user = await User.create({
      name: name.trim(),
      phone,
      password,
      email: normalizedEmail,
      emailVerified: true,
    });

    sendToken(res, user, 201);
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/forgot-password
// Body: { email }
// Public – sends password-reset OTP.
// ─────────────────────────────────────────────
export const forgotPassword = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email } = req.body as { email: string };

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return next(
        new Errorhandler("No account found with this email address", 404),
      );
    }

    const otp = generateOTP();
    user.otp = await hash(otp, 10);
    user.otpExpiry = otpExpiry();
    await user.save({ validateBeforeSave: false });

    await sendOTPEmail(email, otp, "reset");

    res.status(200).json({
      success: true,
      message: "Password reset OTP sent to your email",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/reset-password
// Body: { email, otp, newPassword }
// Public – resets password after OTP verification.
// ─────────────────────────────────────────────
export const resetPassword = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { email, otp, newPassword } = req.body as {
      email: string;
      otp: string;
      newPassword: string;
    };

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user || !user.otp || !user.otpExpiry) {
      return next(
        new Errorhandler("OTP not found. Please request a new one.", 400),
      );
    }

    if (user.otpExpiry < new Date()) {
      return next(
        new Errorhandler("OTP has expired. Please request a new one.", 400),
      );
    }

    const isValid = await user.compareOtp(otp);
    if (!isValid) {
      return next(new Errorhandler("Invalid OTP", 400));
    }

    // Update password and clear OTP
    user.password = newPassword; // pre-save hook will hash it
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save();

    res.status(200).json({
      success: true,
      message: "Password reset successfully",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/change-password
// Body: { oldPassword, newPassword }
// Protected – changes password using old password.
// ─────────────────────────────────────────────
export const changePassword = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { oldPassword, newPassword } = req.body as {
      oldPassword: string;
      newPassword: string;
    };

    const user = await User.findById(userId);
    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    const isMatch = await user.comparePassword(oldPassword);
    if (!isMatch) {
      return next(new Errorhandler("Current password is incorrect", 401));
    }

    user.password = newPassword; // pre-save hook will hash it
    await user.save();

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  },
);

// ─────────────────────────────────────────────
// POST /api/v1/users/verify-email
// Body: { email, otp }
// Protected – links and verifies email for existing users who don't have one.
// ─────────────────────────────────────────────
export const verifyEmail = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { email, otp } = req.body as { email: string; otp: string };

    const normalizedEmail = email.toLowerCase().trim();

    // Check if that email is already taken by another user
    const emailUser = await User.findOne({ email: normalizedEmail });
    if (emailUser && emailUser._id.toString() !== userId) {
      return next(
        new Errorhandler(
          "This email is already associated with another account",
          400,
        ),
      );
    }

    const user = await User.findById(userId);
    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    if (!user.otp || !user.otpExpiry) {
      return next(
        new Errorhandler("OTP not found. Please request a new OTP.", 400),
      );
    }

    if (user.otpExpiry < new Date()) {
      return next(
        new Errorhandler("OTP has expired. Please request a new one.", 400),
      );
    }

    const isValid = await user.compareOtp(otp);
    if (!isValid) {
      return next(new Errorhandler("Invalid OTP", 400));
    }

    user.email = normalizedEmail;
    user.emailVerified = true;
    user.otp = undefined;
    user.otpExpiry = undefined;
    await user.save({ validateBeforeSave: false });

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

// ─────────────────────────────────────────────
// POST /api/v1/users/send-verify-email-otp
// Body: { email }
// Protected – sends OTP to the given email for linking to existing account.
// ─────────────────────────────────────────────
export const sendVerifyEmailOtp = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { email } = req.body as { email: string };

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email is already taken by another user
    const emailUser = await User.findOne({ email: normalizedEmail });
    if (emailUser && emailUser._id.toString() !== userId) {
      return next(
        new Errorhandler(
          "This email is already associated with another account",
          400,
        ),
      );
    }

    const user = await User.findById(userId);
    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    const otp = generateOTP();
    user.otp = await hash(otp, 10);
    user.otpExpiry = otpExpiry();
    await user.save({ validateBeforeSave: false });

    await sendOTPEmail(normalizedEmail, otp, "verification");

    res.status(200).json({
      success: true,
      message: "Verification OTP sent to your email",
    });
  },
);
