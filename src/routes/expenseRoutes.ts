import express from "express";
import {
  addExpense,
  getExpenses,
  editExpense,
  deleteExpense,
  getStats,
  getLedgers,
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

// Stats
router.get("/stats", isAuthenticated, getStats);

// Ledger management
router.get("/ledgers", isAuthenticated, getLedgers);
router.post("/ledgers/close", isAuthenticated, closeLedger);

// PDF export
router.get("/export", isAuthenticated, exportPDF);

export default router;
