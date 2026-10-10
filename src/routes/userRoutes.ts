import express from "express";
import {
  login,
  logout,
  getUserProfile,
  updateProfile,
  refreshToken,
  updatePushToken,
  removePushToken,
  uploadAvatar,
} from "../controllers/usercontroller.js";
import {
  sendOtp,
  verifyOtp,
  registerWithEmail,
  forgotPassword,
  resetPassword,
  changePassword,
  verifyEmail,
  sendVerifyEmailOtp,
} from "../controllers/otpController.js";
import isAuthenticated from "../middlewares/auth.js";
import {
  authLimiter,
  otpRequestLimiter,
  otpVerifyLimiter,
  heavyLimiter,
} from "../middlewares/rateLimit.js";
import {
  validate,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  updatePushTokenSchema,
  sendOtpSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  forgotPasswordSchema,
  changePasswordSchema,
  verifyEmailSchema,
} from "../middlewares/validation.js";
import { upload } from "../middlewares/upload.js";

const router = express.Router();

/**
 * ─── Public Routes ────────────────────────────────────────────
 *
 * Rate limits are the missing control that made several other defects
 * exploitable rather than merely wrong. `/verify-otp` and `/reset-password` in
 * particular: a 6-digit code with no attempt counter and no request limit is a
 * 10^6 online search, which is minutes of traffic. The per-code counter in
 * otpController is the primary fix; these limits stop an attacker from simply
 * requesting fresh codes to reset it.
 */
router.post("/login", authLimiter, validate(loginSchema), login);
router.post(
  "/register",
  authLimiter,
  validate(registerSchema),
  registerWithEmail,
);
router.post("/refresh", refreshToken);

// OTP - public
router.post("/send-otp", otpRequestLimiter, validate(sendOtpSchema), sendOtp);
router.post(
  "/verify-otp",
  otpVerifyLimiter,
  validate(verifyOtpSchema),
  verifyOtp,
);
router.post(
  "/forgot-password",
  otpRequestLimiter,
  validate(forgotPasswordSchema),
  forgotPassword,
);
router.post(
  "/reset-password",
  otpVerifyLimiter,
  validate(resetPasswordSchema),
  resetPassword,
);

// ─── Protected Routes ─────────────────────────────────────────
// POST is the correct verb for a state-changing logout; GET is retained
// because deployed app builds call it that way.
router.get("/logout", isAuthenticated, logout);
router.post("/logout", isAuthenticated, logout);
router.get("/profile", isAuthenticated, getUserProfile);
router.put(
  "/profile",
  isAuthenticated,
  validate(updateProfileSchema),
  updateProfile,
);
router.post(
  "/push-token",
  isAuthenticated,
  validate(updatePushTokenSchema),
  updatePushToken,
);
router.post(
  "/remove-push-token",
  isAuthenticated,
  removePushToken,
);
router.post(
  "/upload-avatar",
  isAuthenticated,
  heavyLimiter,
  upload.single("avatar"),
  uploadAvatar,
);

// OTP - protected
router.post(
  "/send-verify-email-otp",
  isAuthenticated,
  otpRequestLimiter,
  validate(sendOtpSchema),
  sendVerifyEmailOtp,
);
router.post(
  "/verify-email",
  isAuthenticated,
  validate(verifyEmailSchema),
  verifyEmail,
);
router.post(
  "/change-password",
  isAuthenticated,
  validate(changePasswordSchema),
  changePassword,
);

export default router;
