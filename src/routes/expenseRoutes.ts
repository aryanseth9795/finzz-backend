import express from "express";
import {
  addExpense,
  getExpenses,
  editExpense,
  deleteExpense,
  getStats,
  getAdvancedStats,
  getLedgers,
  checkDuplicate,
  closeLedger,
  exportPDF,
} from "../controllers/expenseController.js";
import isAuthenticated from "../middlewares/auth.js";
import { heavyLimiter } from "../middlewares/rateLimit.js";
import {
  validate,
  addExpenseSchema,
  editExpenseSchema,
  expenseIdParamSchema,
  getExpensesSchema,
  closeLedgerSchema,
  checkDuplicateSchema,
  expenseStatsSchema,
  exportLedgerSchema,
} from "../middlewares/validation.js";

const router = express.Router();

/**
 * Every route on this router previously ran with NO validation middleware.
 * That is how `amount` reached `ledger.totalExpenses += amount` as a raw body
 * value of any type, and how `closeLedger` received `year` as a string and
 * bypassed its "past months only" guard.
 *
 * Note the ordering below: the literal paths (`/check-duplicate`, `/stats`,
 * `/ledgers`, `/export`) are declared BEFORE `/:id`. Express matches in
 * declaration order, so with `/:id` first a GET of `/check-duplicate` would
 * bind `id = "check-duplicate"`.
 */

// Duplicate check
router.get(
  "/check-duplicate",
  isAuthenticated,
  validate(checkDuplicateSchema),
  checkDuplicate,
);

// Stats
router.get("/stats", isAuthenticated, validate(expenseStatsSchema), getStats);
router.get(
  "/advanced-stats",
  isAuthenticated,
  validate(expenseStatsSchema),
  getAdvancedStats,
);

// Ledger management
router.get("/ledgers", isAuthenticated, getLedgers);
router.post(
  "/ledgers/close",
  isAuthenticated,
  validate(closeLedgerSchema),
  closeLedger,
);

// PDF export — rate limited: it renders a full month of data per call.
router.get(
  "/export",
  isAuthenticated,
  heavyLimiter,
  validate(exportLedgerSchema),
  exportPDF,
);

// Expense CRUD
router.post("/", isAuthenticated, validate(addExpenseSchema), addExpense);
router.get("/", isAuthenticated, validate(getExpensesSchema), getExpenses);
router.put("/:id", isAuthenticated, validate(editExpenseSchema), editExpense);
router.delete(
  "/:id",
  isAuthenticated,
  validate(expenseIdParamSchema),
  deleteExpense,
);

export default router;
