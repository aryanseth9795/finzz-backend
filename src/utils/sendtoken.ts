import { Response } from "express";
import jwt, { Secret } from "jsonwebtoken";
import { JWT_SECRET } from "../config/envVariables.js";
import { IUser } from "../models/userModel.js";

/**
 * Dual Token System: Access Token (2 days) + Refresh Token (30 days)
 * For mobile app: tokens returned in response (stored in AsyncStorage/SecureStore)
 * - Access token: Used for API authentication, short-lived
 * - Refresh token: Used to get new access token, long-lived, stored in DB
 */
const sendToken = async (res: Response, user: IUser, statusCode: number) => {
  if (!JWT_SECRET) throw new Error("JWT_SECRET is not defined");

  // Generate Access Token (2 days)
  const accessToken = jwt.sign({ id: user._id }, JWT_SECRET as Secret, {
    expiresIn: "2d", // 2 days
  });

  // Generate Refresh Token (30 days)
  const refreshToken = jwt.sign({ id: user._id }, JWT_SECRET as Secret, {
    expiresIn: "30d", // 30 days (1 month)
  });

  // Save refresh token to user document
  user.refreshToken = refreshToken;
  await user.save({ validateBeforeSave: false });

  // Send response with both tokens (mobile app will store in AsyncStorage/SecureStore)
  res.status(statusCode).json({
    success: true,
    access_token: accessToken,
    refresh_token: refreshToken,
    user: {
      _id: user._id,
      name: user.name,
      phone: user.phone,
      avatar: user.avatar,
      // Do NOT send password or refreshToken
    },
  });
};

export default sendToken;
