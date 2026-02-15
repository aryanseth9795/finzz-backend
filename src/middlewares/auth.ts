import jwt from "jsonwebtoken";
import ErrorHandler from "./Errorhandler.js";
import { NextFunction, Request,Response } from "express";
import { JWT_SECRET,adminSecretKey } from "../config/envVariables.js";

// Users Authentication ----->
const isAuthenticated = (req:Request & { user?: { id: string } }, res:Response, next:NextFunction) => {
  const token = req.cookies["token"] || req.headers["authorization"]?.replace("Bearer ", "");
  if (!token)
    return next(new ErrorHandler("Please login to access this route", 401));
  const user = jwt.verify(token,JWT_SECRET ) as { id: string } | null;

  if (!user) return next(new ErrorHandler("Please login ! Token Expired", 401));
console.log(user);
  req.user = {id:user.id};
  next();
};
export default isAuthenticated;

// admin Routes authentication
export const adminOnly = (req:Request & { user?: { id: string } }, res:Response, next:NextFunction) => {
  const token = req.cookies["admin-token"];

  if (!token)
    return next(new ErrorHandler("Only Admin can access this route", 401));

  const secretKey = jwt.verify(token, JWT_SECRET) as string | null;

  const isMatched = secretKey === adminSecretKey;

  if (!isMatched)
    return next(new ErrorHandler("Only Admin can access this route", 401));
  next();
};