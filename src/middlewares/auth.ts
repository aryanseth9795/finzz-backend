import jwt from "jsonwebtoken";
import ErrorHandler from "./Errorhandler.js";
import { NextFunction, Request, Response } from "express";
import { JWT_SECRET, adminSecretKey } from "../config/envVariables.js";

// Users Authentication
const isAuthenticated = (
  req: Request & { user?: { id: string } },
  res: Response,
  next: NextFunction,
) => {
  const token =
    req.cookies["token"] ||
    req.headers["authorization"]?.replace("Bearer ", "");

  if (!token) {
    return next(new ErrorHandler("Please login to access this route", 401));
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string } | null;
    if (!decoded) {
      return next(new ErrorHandler("Invalid token", 401));
    }
    req.user = { id: decoded.id };
    next();
  } catch (error: any) {
    // Return 401 for ALL JWT errors (expired, invalid, malformed)
    // This allows the client interceptor to attempt a refresh
    if (error.name === "TokenExpiredError") {
      return next(new ErrorHandler("Token expired", 401));
    }
    return next(new ErrorHandler("Invalid token", 401));
  }
};

export default isAuthenticated;

// Admin Routes Authentication
export const adminOnly = (
  req: Request & { user?: { id: string } },
  res: Response,
  next: NextFunction,
) => {
  const token = req.cookies["admin-token"];

  if (!token)
    return next(new ErrorHandler("Only Admin can access this route", 401));

  try {
    const secretKey = jwt.verify(token, JWT_SECRET) as string | null;
    const isMatched = secretKey === adminSecretKey;
    if (!isMatched)
      return next(new ErrorHandler("Only Admin can access this route", 401));
    next();
  } catch {
    return next(new ErrorHandler("Only Admin can access this route", 401));
  }
};