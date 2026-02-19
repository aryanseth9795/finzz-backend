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

const router = express.Router();

// Expense CRUD
router.post("/", isAuthenticated, addExpense);
router.get("/", isAuthenticated, getExpenses);
router.put("/:id", isAuthenticated, editExpense);
router.delete("/:id", isAuthenticated, deleteExpense);

// Duplicate Check
router.get("/check-duplicate", isAuthenticated, checkDuplicate);

// Stats
router.get("/stats", isAuthenticated, getStats);
router.get("/advanced-stats", isAuthenticated, getAdvancedStats);

// Ledger management
router.get("/ledgers", isAuthenticated, getLedgers);
router.post("/ledgers/close", isAuthenticated, closeLedger);

// PDF export
router.get("/export", isAuthenticated, exportPDF);

export default router;
