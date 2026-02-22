import express from "express";
import { adminOnly } from "../middlewares/auth.js";
import {
  adminLogin,
  adminLogout,
  adminVerify,
  getDashboardStats,
  getAllUsers,
  getUserDetail,
  deleteUser,
  getAllExpenses,
  getAllPools,
  getPoolDashboardStats,
  getAdminPoolDetail,
  sendBulkNotification,
  sendTargetedNotification,
} from "../controllers/adminController.js";

const router = express.Router();

// Public
router.post("/login", adminLogin);

// Protected (adminOnly)
router.get("/verify", adminOnly, adminVerify);
router.get("/logout", adminOnly, adminLogout);
router.get("/dashboard", adminOnly, getDashboardStats);

// Users
router.get("/users", adminOnly, getAllUsers);
router.get("/users/:id", adminOnly, getUserDetail);
router.delete("/users/:id", adminOnly, deleteUser);

// Expenses
router.get("/expenses", adminOnly, getAllExpenses);

// Pools
router.get("/pools", adminOnly, getAllPools);
router.get("/pools/dashboard", adminOnly, getPoolDashboardStats);
router.get("/pools/:id", adminOnly, getAdminPoolDetail);

// Notifications
router.post("/notifications/bulk", adminOnly, sendBulkNotification);
router.post("/notifications/targeted", adminOnly, sendTargetedNotification);

export default router;
