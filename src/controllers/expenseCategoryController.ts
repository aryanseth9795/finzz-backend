import { NextFunction, Request, Response } from "express";
import TryCatch from "../utils/TryCatch.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import { parseTzOffset } from "../utils/dates.js";
import {
  listCategories,
  removeCategory,
} from "../services/expenseCategories.js";

// ==========================================
// List saved categories (both types)
// ==========================================
export const listExpenseCategories = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // The offset only matters for the one-time first fill, which reads the
    // current and previous month in the USER's calendar (services/expenseCategories.ts).
    const tzOffset = parseTzOffset(req.query.tzOffsetMinutes);

    const { version, categories } = await listCategories(req.user.id, tzOffset);

    res.status(200).json({ success: true, version, categories });
  },
);

// ==========================================
// Remove one saved category
// ==========================================
export const deleteExpenseCategory = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    // Deletes by `{ _id, userId }`, so someone else's id matches nothing and
    // gets the same 404 as one already removed from another phone. Past
    // expenses keep their category text.
    const result = await removeCategory(req.user.id, String(req.params.id));

    if (!result) {
      return next(new ErrorHandler("Category not found", 404));
    }

    res.status(200).json({ success: true, categoriesVersion: result.version });
  },
);
