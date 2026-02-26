import express from "express";
import {
  login,
  logout,
  getUserProfile,
  updateProfile,
  refreshToken,
  updatePushToken,
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
  validate,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  updatePushTokenSchema,
  sendOtpSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  changePasswordSchema,
  verifyEmailSchema,
} from "../middlewares/validation.js";
import { upload } from "../middlewares/upload.js";

const router = express.Router();

// ─── Public Routes ────────────────────────────────────────────
router.post("/login", validate(loginSchema), login);
router.post("/register", validate(registerSchema), registerWithEmail);
router.post("/refresh", refreshToken);

// OTP - public
router.post("/send-otp", validate(sendOtpSchema), sendOtp);
router.post("/verify-otp", validate(verifyOtpSchema), verifyOtp);
router.post("/forgot-password", validate(sendOtpSchema), forgotPassword);
router.post("/reset-password", validate(resetPasswordSchema), resetPassword);

// ─── Protected Routes ─────────────────────────────────────────
router.get("/logout", isAuthenticated, logout);
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
  "/upload-avatar",
  isAuthenticated,
  upload.single("avatar"),
  uploadAvatar,
);

// OTP - protected
router.post(
  "/send-verify-email-otp",
  isAuthenticated,
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
