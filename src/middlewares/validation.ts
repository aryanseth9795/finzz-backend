import { z } from "zod";
import { Request, Response, NextFunction } from "express";

//======= Validation Schemas =======//

export const registerSchema = z.object({
  body: z.object({
    name: z.string().min(1, "Name is required").trim(),
    phone: z
      .string()
      .regex(
        /^\+?[1-9]\d{1,14}$/,
        "Invalid phone number format (use E.164 format)",
      ),
    password: z.string().min(6, "Password must be at least 6 characters"),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    phone: z.string().regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number"),
    password: z.string().min(1, "Password is required"),
  }),
});

export const addTxnSchema = z.object({
  body: z.object({
    chatId: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid chatId"),
    amount: z.number().positive("Amount must be greater than 0"),
    date: z.string().datetime("Invalid date format (ISO 8601 required)"),
    remarks: z.string().optional(),
    to: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid 'to' user ID"),
    from: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid 'from' user ID"),
  }),
});

export const checkContactsSchema = z.object({
  body: z.object({
    phoneNumbers: z
      .array(z.string())
      .max(200, "Maximum 200 contacts per request")
      .min(1, "At least one phone number required"),
  }),
});

export const updateProfileSchema = z.object({
  body: z.object({
    name: z.string().min(1).trim().optional(),
    avatar: z.string().url("Invalid avatar URL").optional(),
  }),
});

export const updatePushTokenSchema = z.object({
  body: z.object({
    pushToken: z
      .string()
      .startsWith("ExponentPushToken[", "Invalid Expo push token format"),
  }),
});

//======= Middleware Factory =======//

/**
 * Zod validation middleware factory
 * Usage: validate(registerSchema)
 */
export const validate = (schema: z.ZodSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      schema.parse({
        body: req.body,
        query: req.query,
        params: req.params,
      });
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const fieldErrors = error.issues.map((err: z.ZodIssue) => ({
          field: err.path.join("."),
          message: err.message,
        }));
        console.error(
          `❌ [${req.method}] ${req.originalUrl} → Validation error:`,
          fieldErrors,
        );
        return res.status(400).json({
          success: false,
          message: "Validation error",
          errors: fieldErrors,
        });
      }
      next(error);
    }
  };
};
