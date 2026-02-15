import express from "express";
import {
  login,
  register,
  logout,
  getUserProfile,
  updateProfile,
  refreshToken,
  updatePushToken,
  uploadAvatar,
} from "../controllers/usercontroller.js";
import isAuthenticated from "../middlewares/auth.js";
import {
  validate,
  loginSchema,
  registerSchema,
  updateProfileSchema,
  updatePushTokenSchema,
} from "../middlewares/validation.js";
import { upload } from "../middlewares/upload.js";

const router = express.Router();

// Public routes
router.post("/login", validate(loginSchema), login);
router.post("/register", validate(registerSchema), register);
router.post("/refresh", refreshToken); // No auth - uses refresh token

// Protected routes
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

// Image upload route - uses multer middleware
router.post(
  "/upload-avatar",
  isAuthenticated,
  upload.single("avatar"),
  uploadAvatar,
);

export default router;
