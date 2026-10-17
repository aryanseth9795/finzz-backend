import TryCatch from "../utils/TryCatch.js";
import { phoneVariants } from "../utils/phone.js";
import { User } from "../models/userModel.js";
import { Request, Response, NextFunction } from "express";
import Errorhandler from "../middlewares/Errorhandler.js";
import sendToken, {
  publicUser,
  issueRefreshGrant,
  revokeRefreshGrant,
  revokeAllRefreshGrants,
} from "../utils/sendtoken.js";
import {
  signAccessToken,
  verifyRefreshToken,
  hashToken,
  TokenError,
} from "../utils/tokens.js";

/** Fields never returned to a client. */
const PUBLIC_PROJECTION = "-password -refreshToken -refreshTokens -otp -otpExpiry -otpAttempts";

// Login with mobile number + password
export const login = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone, password } = req.body;

    // `password` is `select: false` on the schema, so it must be requested
    // explicitly. That is deliberate: the field is now opt-in, which makes
    // every place that touches it greppable.
    const user = await User.findOne({ phone: { $in: phoneVariants(phone) } }).select(
      "+password",
    );

    // Same response and the same amount of work whether or not the account
    // exists. Returning "User not found" for an unknown phone number turned
    // the login endpoint into a user-enumeration oracle.
    if (!user || !(await user.comparePassword(password))) {
      return next(new Errorhandler("Invalid phone number or password", 401));
    }

    await sendToken(res, user, 200, req);
  },
);

// Register with name + phone + password
export const register = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { name, phone, password } = req.body;

    const existingUser = await User.findOne({
      phone: { $in: phoneVariants(phone) },
    }).select("_id");
    if (existingUser) {
      return next(new Errorhandler("User already exists", 400));
    }

    const user = await User.create({ name, phone, password });

    await sendToken(res, user, 201, req);
  },
);

// Refresh access token using refresh token
export const refreshToken = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const fromHeader = /^Bearer\s+(.+)$/i.exec(authHeader?.trim() ?? "")?.[1];
    const refreshTokenValue = fromHeader || req.body?.refreshToken;

    if (!refreshTokenValue) {
      return next(new Errorhandler("Refresh token required", 401));
    }

    let decoded;
    try {
      // Rejects access tokens. Previously both token kinds had identical
      // payloads, so a 2-day access token could mint fresh credentials —
      // and a 30-day refresh token worked as an access token.
      decoded = verifyRefreshToken(refreshTokenValue);
    } catch (error) {
      // Grace period: tokens issued before the `type` claim existed have no
      // type. Accept them here *only* by matching the legacy stored value,
      // which proves the caller holds the exact token we persisted.
      const legacy = await tryLegacyRefresh(refreshTokenValue);
      if (!legacy) {
        const expired = error instanceof TokenError && error.expired;
        return next(
          new Errorhandler(
            expired ? "Refresh token expired" : "Invalid refresh token",
            401,
          ),
        );
      }
      await sendToken(res, legacy, 200, req);
      return;
    }

    const user = await User.findById(decoded.id).select(
      "+refreshTokens +refreshToken",
    );
    if (!user) {
      return next(new Errorhandler("Invalid refresh token", 401));
    }

    // The token must correspond to a grant we still hold. This is what makes
    // logout and "sign out this device" actually revoke access — a signature
    // check alone cannot, because a valid signature outlives any logout.
    const presentedHash = hashToken(refreshTokenValue);
    const grant = (user.refreshTokens || []).find(
      (g: { tokenHash: string; jti: string }) =>
        g.jti === decoded.jti && g.tokenHash === presentedHash,
    );

    if (!grant) {
      return next(new Errorhandler("Invalid refresh token", 401));
    }

    // Rotate: the presented token is consumed and replaced. A refresh token
    // that survives its own use can be replayed indefinitely if intercepted.
    await revokeRefreshGrant(decoded.id, decoded.jti);

    const accessToken = signAccessToken(String(user._id));
    const newRefresh = await issueRefreshGrant(
      String(user._id),
      req.headers["user-agent"]?.slice(0, 200),
    );

    res.status(200).json({
      success: true,
      access_token: accessToken,
      refresh_token: newRefresh,
      user: publicUser(user),
    });
  },
);

/**
 * Accept a pre-`type`-claim refresh token by exact match against the legacy
 * `refreshToken` field. Delete this helper — and the catch block that calls
 * it — once the 30-day refresh window has rotated.
 */
async function tryLegacyRefresh(token: string) {
  const user = await User.findOne({ refreshToken: token }).select(
    "+refreshToken +refreshTokens",
  );
  return user ?? null;
}

// Logout - revoke this device's refresh grant
export const logout = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { refreshToken: presented, allDevices } = req.body ?? {};

    if (allDevices) {
      await revokeAllRefreshGrants(userId);
    } else if (typeof presented === "string" && presented) {
      // Revoke only the grant matching the token this device holds, so
      // logging out on a phone does not sign the user out on their tablet.
      const hash = hashToken(presented);
      await User.updateOne(
        { _id: userId },
        { $pull: { refreshTokens: { tokenHash: hash } } },
      );
    } else {
      // No token supplied (older clients): fall back to revoking everything,
      // which is the safe direction to be wrong in.
      await revokeAllRefreshGrants(userId);
    }

    // Also drop this device's push token so notifications for this account
    // stop arriving on a device the user has signed out of.
    const { pushToken } = req.body ?? {};
    if (typeof pushToken === "string" && pushToken) {
      await User.updateOne(
        { _id: userId },
        { $pull: { pushTokens: pushToken } },
      );
    }

    res.clearCookie("token");
    res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  },
);

// Get user profile
export const getUserProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const user = await User.findById(req.user.id).select(PUBLIC_PROJECTION);

    if (!user) {
      return next(new Errorhandler("User not found", 404));
    }

    res.status(200).json({ success: true, user });
  },
);

// Update user profile (name, avatar)
export const updateProfile = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { name, avatar } = req.body;

    const updateData: Record<string, unknown> = {};
    if (name) updateData.name = name;
    if (avatar) updateData.avatar = avatar;

    if (Object.keys(updateData).length === 0) {
      return next(new Errorhandler("Nothing to update", 400));
    }

    const user = await User.findByIdAndUpdate(userId, updateData, {
      new: true,
      runValidators: true,
    }).select(PUBLIC_PROJECTION);

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user,
    });
  },
);

// Register this device's push token
export const updatePushToken = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { pushToken } = req.body;

    if (!pushToken || typeof pushToken !== "string") {
      return next(new Errorhandler("Push token is required", 400));
    }

    if (!pushToken.startsWith("ExponentPushToken[")) {
      return next(new Errorhandler("Invalid Expo push token format", 400));
    }

    // A device can only belong to one account at a time. Detaching the token
    // from every other user prevents the previous owner's notifications from
    // being delivered to whoever is signed in now.
    await User.updateMany(
      { _id: { $ne: userId }, pushTokens: pushToken },
      { $pull: { pushTokens: pushToken } },
    );
    await User.updateMany(
      { _id: { $ne: userId }, pushToken },
      { $unset: { pushToken: "" } },
    );

    // $addToSet keeps the array free of duplicates without a read-modify-write.
    await User.updateOne(
      { _id: userId },
      { $addToSet: { pushTokens: pushToken } },
    );

    res.status(200).json({
      success: true,
      message: "Push token updated successfully",
    });
  },
);

// Record how this device's push registration went, so the admin can see why a
// user is not receiving notifications.
export const updatePushStatus = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { outcome, detail } = req.body;

    await User.updateOne(
      { _id: req.user.id },
      {
        $set: {
          pushStatus: {
            outcome,
            ...(typeof detail === "string" && detail ? { detail } : {}),
            at: new Date(),
          },
        },
      },
    );

    res.status(200).json({ success: true, message: "Push status recorded" });
  },
);

// Remove this device's push token (called on logout)
export const removePushToken = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;
    const { pushToken } = req.body ?? {};

    if (typeof pushToken === "string" && pushToken) {
      await User.updateOne(
        { _id: userId },
        { $pull: { pushTokens: pushToken } },
      );
    } else {
      await User.updateOne(
        { _id: userId },
        { $set: { pushTokens: [] }, $unset: { pushToken: "" } },
      );
    }

    res.status(200).json({ success: true, message: "Push token removed" });
  },
);

// Upload/Update avatar image via Cloudinary
export const uploadAvatar = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    if (!req.file) {
      return next(new Errorhandler("No image file provided", 400));
    }

    const { uploadToCloudinary, deleteFromCloudinary, extractPublicId } =
      await import("../services/cloudinaryService.js");

    const currentUser = await User.findById(userId).select("avatar");
    const previousAvatar = currentUser?.avatar;

    // Upload FIRST, then delete the old image. The previous order deleted the
    // old avatar before the upload, so a failed upload left the user with no
    // avatar at all and no way to recover the original.
    const uploadResult = await uploadToCloudinary(req.file.buffer);

    const user = await User.findByIdAndUpdate(
      userId,
      { avatar: uploadResult.secure_url },
      { new: true, runValidators: true },
    ).select(PUBLIC_PROJECTION);

    if (previousAvatar) {
      const publicId = extractPublicId(previousAvatar);
      // Best-effort cleanup: a failure here costs storage, not correctness,
      // and must not fail a request whose primary work already succeeded.
      if (publicId) {
        deleteFromCloudinary(publicId).catch((error) =>
          console.error("[avatar] failed to delete previous image:", error),
        );
      }
    }

    res.status(200).json({
      success: true,
      message: "Avatar uploaded successfully",
      avatar: uploadResult.secure_url,
      user,
    });
  },
);
