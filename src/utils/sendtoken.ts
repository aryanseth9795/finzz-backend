import { Response, Request } from "express";
import { IUser } from "../models/userModel.js";
import { User } from "../models/userModel.js";
import {
  signAccessToken,
  signRefreshToken,
  hashToken,
  MAX_REFRESH_GRANTS,
} from "./tokens.js";

/**
 * Dual token system.
 *
 * Access token  — short-lived, replayable, not revocable. Used on every call.
 * Refresh token — long-lived, revocable, single-use per device. Persisted as a
 *                 SHA-256 hash in `user.refreshTokens`, one grant per device.
 *
 * Previously `user.refreshToken` was a single string overwritten on every
 * login, so signing in on a phone silently invalidated the tablet. Grants are
 * now an array, which also makes "sign out this one device" expressible.
 */

/** Persist a new refresh grant, pruning expired ones and capping the total. */
export const issueRefreshGrant = async (
  userId: string,
  device?: string,
): Promise<string> => {
  const { token, jti, expiresAt } = signRefreshToken(userId);
  const now = new Date();

  const user = await User.findById(userId).select("+refreshTokens");
  if (!user) throw new Error("User not found while issuing refresh token");

  // Drop grants that can no longer be used. Without this the array grows
  // without bound on an account that signs in often.
  const live = (user.refreshTokens || []).filter(
    (g: { expiresAt: Date }) => g.expiresAt > now,
  );

  live.push({
    tokenHash: hashToken(token),
    jti,
    device,
    createdAt: now,
    lastUsedAt: now,
    expiresAt,
  });

  // Keep the most recent N devices; older sessions are evicted rather than
  // letting one account accumulate unlimited live credentials.
  user.refreshTokens = live.slice(-MAX_REFRESH_GRANTS);
  // Clear the legacy single-token field as accounts migrate through login.
  user.refreshToken = undefined;

  await user.save({ validateBeforeSave: false });
  return token;
};

/** Revoke one grant (single-device logout). */
export const revokeRefreshGrant = async (
  userId: string,
  jti: string,
): Promise<void> => {
  await User.updateOne(
    { _id: userId },
    { $pull: { refreshTokens: { jti } }, $unset: { refreshToken: "" } },
  );
};

/** Revoke every grant (password change, reset, "sign out everywhere"). */
export const revokeAllRefreshGrants = async (userId: string): Promise<void> => {
  await User.updateOne(
    { _id: userId },
    { $set: { refreshTokens: [] }, $unset: { refreshToken: "" } },
  );
};

/** Shape returned to clients. Never includes password, otp, or token records. */
export const publicUser = (user: IUser) => ({
  _id: user._id,
  name: user.name,
  phone: user.phone,
  avatar: user.avatar,
  email: user.email,
  emailVerified: user.emailVerified,
});

const sendToken = async (
  res: Response,
  user: IUser,
  statusCode: number,
  req?: Request,
) => {
  const accessToken = signAccessToken(String(user._id));
  const refreshToken = await issueRefreshGrant(
    String(user._id),
    req?.headers["user-agent"]?.slice(0, 200),
  );

  res.status(statusCode).json({
    success: true,
    access_token: accessToken,
    refresh_token: refreshToken,
    user: publicUser(user),
  });
};

export default sendToken;
