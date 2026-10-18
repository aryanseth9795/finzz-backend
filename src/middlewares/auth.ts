import ErrorHandler from "./Errorhandler.js";
import { NextFunction, Request, Response } from "express";
import { recordActivity } from "../services/activityTracker.js";
import {
  verifyAccessToken,
  verifyAdminToken,
  TokenError,
} from "../utils/tokens.js";

/** Extract a bearer token from the Authorization header, if well-formed. */
const bearer = (req: Request): string | undefined => {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return undefined;
  // Previously `.replace("Bearer ", "")`, which also accepted a bare token and
  // silently mangled any header whose value merely contained "Bearer ".
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
};

// Users Authentication
const isAuthenticated = (req: Request, res: Response, next: NextFunction) => {
  const token = bearer(req) || req.cookies?.["token"];

  if (!token) {
    return next(new ErrorHandler("Please login to access this route", 401));
  }

  try {
    const decoded = verifyAccessToken(token);
    req.user = { id: decoded.id };
    try {
      // The app's cold start calls GET /users/profile; that counts as an open.
      recordActivity(decoded.id, {
        isOpen:
          req.method === "GET" &&
          req.originalUrl.split("?")[0] === "/api/v1/users/profile",
      });
    } catch {
      // Analytics must never fail a request.
    }
    next();
  } catch (error) {
    // 401 for every JWT failure (expired, invalid, wrong type) so the client
    // interceptor can attempt exactly one refresh and then give up.
    const message =
      error instanceof TokenError && error.expired
        ? "Token expired"
        : "Invalid token";
    return next(new ErrorHandler(message, 401));
  }
};

export default isAuthenticated;

// Admin Routes Authentication
export const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  // Accept the cookie (used by the admin web app) or a bearer token, so an
  // operator or CI job can call admin endpoints without a browser.
  const token = req.cookies?.["admin-token"] || bearer(req);

  if (!token) {
    return next(new ErrorHandler("Only Admin can access this route", 401));
  }

  try {
    verifyAdminToken(token);
    next();
  } catch {
    return next(new ErrorHandler("Only Admin can access this route", 401));
  }
};
