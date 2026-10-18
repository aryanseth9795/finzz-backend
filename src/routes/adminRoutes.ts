import express from "express";
import { adminOnly } from "../middlewares/auth.js";
import { authLimiter, heavyLimiter } from "../middlewares/rateLimit.js";
import {
  validate,
  adminLoginSchema,
  adminUserQuerySchema,
  adminIdParamSchema,
  adminExpenseQuerySchema,
  adminPoolQuerySchema,
  adminTrafficQuerySchema,
  bulkNotificationSchema,
  targetedNotificationSchema,
  appReleaseSchema,
} from "../middlewares/validation.js";
import {
  adminLogin,
  adminLogout,
  adminVerify,
  getDashboardStats,
  getTrafficAnalytics,
  getAllUsers,
  getUserDetail,
  deleteUser,
  getAllExpenses,
  getAllPools,
  getPoolDashboardStats,
  getAdminPoolDetail,
  sendBulkNotification,
  sendTargetedNotification,
  getNotificationHealth,
} from "../controllers/adminController.js";
import {
  getAdminRelease,
  updateAppRelease,
} from "../controllers/appReleaseController.js";

const router = express.Router();

/**
 * `/login` is the single most valuable endpoint in the system: one string
 * grants the ability to read every user's finances, delete accounts
 * irreversibly, and broadcast to every device. It had no rate limit, and the
 * token it issued never expired.
 *
 * `authLimiter` caps failed attempts to 10 per 15 minutes per IP+identifier
 * and does not count successes, so a legitimate admin is never locked out by
 * their own usage.
 */
router.post("/login", authLimiter, validate(adminLoginSchema), adminLogin);

// Protected (adminOnly)
router.get("/verify", adminOnly, adminVerify);
/**
 * Logout accepts POST as well as GET. GET is retained because the deployed
 * admin build calls it that way, but a state-changing GET is CSRF-reachable
 * via `<img src=…>` given the `sameSite: "none"` cookie. Migrate the admin
 * client to POST, then delete the GET route.
 */
router.get("/logout", adminOnly, adminLogout);
router.post("/logout", adminOnly, adminLogout);
router.get("/dashboard", adminOnly, getDashboardStats);
router.get(
  "/analytics/traffic",
  adminOnly,
  validate(adminTrafficQuerySchema),
  getTrafficAnalytics,
);

// Users
router.get(
  "/users",
  adminOnly,
  validate(adminUserQuerySchema),
  getAllUsers,
);
router.get(
  "/users/:id",
  adminOnly,
  validate(adminIdParamSchema),
  getUserDetail,
);
router.delete(
  "/users/:id",
  adminOnly,
  validate(adminIdParamSchema),
  deleteUser,
);

// Expenses
router.get(
  "/expenses",
  adminOnly,
  validate(adminExpenseQuerySchema),
  getAllExpenses,
);

// Pools — `/pools/dashboard` must precede `/pools/:id`, or the literal path
// is captured as an id.
router.get("/pools/dashboard", adminOnly, getPoolDashboardStats);
router.get("/pools", adminOnly, validate(adminPoolQuerySchema), getAllPools);
router.get(
  "/pools/:id",
  adminOnly,
  validate(adminIdParamSchema),
  getAdminPoolDetail,
);

// Notifications — rate limited: each call fans out to every registered device
// and cannot be recalled.
router.post(
  "/notifications/bulk",
  adminOnly,
  heavyLimiter,
  validate(bulkNotificationSchema),
  sendBulkNotification,
);
router.post(
  "/notifications/targeted",
  adminOnly,
  heavyLimiter,
  validate(targetedNotificationSchema),
  sendTargetedNotification,
);

router.get("/notifications/health", adminOnly, getNotificationHealth);

// App release — PUT can block every install below the minimum, so it is validated.
router.get("/app-release", adminOnly, getAdminRelease);
router.put(
  "/app-release",
  adminOnly,
  validate(appReleaseSchema),
  updateAppRelease,
);

export default router;
