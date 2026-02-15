import { NextFunction, Request, Response } from "express";

const errorMiddleware = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  err.message ||= "Internal Server Error";
  err.statusCode ||= 500;

  // Log all errors to console for debugging
  console.error(`❌ [${req.method}] ${req.originalUrl} →`, err.message);
  if (process.env.NODE_ENV !== "production") {
    console.error(err.stack || err);
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const error = Object.keys(err.keyPattern).join(", ");
    err.message = `Duplicate field - ${error}`;
    err.statusCode = 400;
  }

  // Mongoose CastError (invalid ObjectId, etc.)
  if (err.name === "CastError") {
    const errorPath = err.path;
    err.message = `Invalid Format of ${errorPath}`;
    err.statusCode = 400;
  }

  // Mongoose ValidationError (required fields, enum, min/max, etc.)
  if (err.name === "ValidationError") {
    const errors = Object.values(err.errors).map((e: any) => e.message);
    err.message = errors.join(", ");
    err.statusCode = 400;
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    err.message = "Invalid token, please login again";
    err.statusCode = 401;
  }

  if (err.name === "TokenExpiredError") {
    err.message = "Token has expired, please login again";
    err.statusCode = 401;
  }

  const response: any = {
    success: false,
    message: err.message,
  };

  return res.status(err.statusCode).json(response);
};

export default errorMiddleware;
