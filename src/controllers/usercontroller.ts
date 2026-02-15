import TryCatch from "../utils/TryCatch.js";
import { User, IUser } from "../models/userModel.js";
import { Request, Response, NextFunction } from "express";
import Errorhandler from "../middlewares/Errorhandler.js";
import sendToken from "../utils/sendtoken.js";
import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/envVariables.js";

// Login with mobile number + password
export const login = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone, password } = req.body; // phone field (not Phone)

    const user = await User.findOne({ phone });
    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    const isPasswordMatched = await user.comparePassword(password);
    if (!isPasswordMatched) {
      return next(new Errorhandler("Invalid credentials", 401));
    }

    sendToken(res, user, 200);
  },
);

// Register with name + phone + password (NO email)
export const register = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, phone, password } = req.body; // NO email

    const existingUser = await User.findOne({ phone });
    if (existingUser) {
      return next(new Errorhandler("User already exists", 400));
    }

    const user = await User.create({
      name,
      phone,
      password,
    });

    sendToken(res, user, 201);
  },
);

// Refresh access token using refresh token
export const refreshToken = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // Get refresh token from Authorization header or body
    const authHeader = req.headers.authorization;
    const refreshTokenFromHeader = authHeader?.startsWith("Bearer ")
      ? authHeader.substring(7)
      : null;
    const refreshTokenFromBody = req.body.refreshToken;
    const refreshTokenValue = refreshTokenFromHeader || refreshTokenFromBody;

    if (!refreshTokenValue) {
      return next(new Errorhandler("Refresh token required", 401));
    }

    try {
      // Verify refresh token
      const decoded: any = jwt.verify(refreshTokenValue, JWT_SECRET);

      // Find user and check if stored refresh token matches
      const user = await User.findById(decoded.id);
      if (!user) {
        return next(new Errorhandler("User not found", 404));
      }

      if (user.refreshToken !== refreshTokenValue) {
        return next(new Errorhandler("Invalid refresh token", 401));
      }

      // Issue new token pair
      sendToken(res, user, 200);
    } catch (error) {
      return next(new Errorhandler("Invalid or expired refresh token", 401));
    }
  },
);

// Logout - clear refresh token from DB
export const logout = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    // Nullify refresh token in DB
    await User.findByIdAndUpdate(userId, { refreshToken: null });

    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  },
);

// Get user profile
export const getUserProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userid = req.user!.id;
    const user = await User.findById(userid).select("-password -refreshToken");

    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    res.status(200).json({
      success: true,
      user,
    });
  },
);

// Update user profile (name, avatar)
export const updateProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { name, avatar } = req.body;

    const updateData: any = {};
    if (name) updateData.name = name;
    if (avatar) updateData.avatar = avatar;

    const user = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
      runValidators: true,
    }).select("-password -refreshToken");

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user,
    });
  },
);

// Update push token
export const updatePushToken = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { pushToken } = req.body;

    if (!pushToken) {
      return next(new Errorhandler("Push token is required", 400));
    }

    // Validate it's a valid Expo push token
    if (!pushToken.startsWith("ExponentPushToken[")) {
      return next(new Errorhandler("Invalid Expo push token format", 400));
    }

    await User.findByIdAndUpdate(userId, { pushToken });

    res.status(200).json({
      success: true,
      message: "Push token updated successfully",
    });
  },
);

// Upload/Update avatar image via Cloudinary
export const uploadAvatar = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    // Check if file was uploaded
    if (!req.file) {
      return next(new Errorhandler("No image file provided", 400));
    }

    try {
      // Import cloudinary service
      const { uploadToCloudinary, deleteFromCloudinary, extractPublicId } =
        await import("../services/cloudinaryService.js");

      // Get current user to check for existing avatar
      const currentUser = await User.findById(userId).select("avatar");

      // Delete old avatar from Cloudinary if it exists
      if (currentUser?.avatar) {
        const publicId = extractPublicId(currentUser.avatar);
        if (publicId) {
          await deleteFromCloudinary(publicId);
        }
      }

      // Upload new image to Cloudinary
      const uploadResult = await uploadToCloudinary(req.file.buffer);

      // Update user avatar in database
      const user = await User.findByIdAndUpdate(
        userId,
        { avatar: uploadResult.secure_url },
        { new: true, runValidators: true },
      ).select("-password -refreshToken");

      res.status(200).json({
        success: true,
        message: "Avatar uploaded successfully",
        avatar: uploadResult.secure_url,
        user,
      });
    } catch (error: any) {
      return next(
        new Errorhandler(`Failed to upload avatar: ${error.message}`, 500),
      );
    }
  },
);
