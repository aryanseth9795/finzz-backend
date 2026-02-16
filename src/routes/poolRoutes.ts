import express from "express";
import isAuthenticated from "../middlewares/auth.js";
import {
  validate,
  createPoolSchema,
  updatePoolSchema,
  addPoolTxSchema,
  poolMemberSchema,
} from "../middlewares/validation.js";
import {
  createPool,
  getMyPools,
  getPoolById,
  updatePool,
  deletePool,
  addMember,
  removeMember,
  leavePool,
  closePool,
  reopenPool,
  addPoolTx,
  getPoolTxns,
  editPoolTx,
  deletePoolTx,
  verifyPoolTx,
  getPoolStats,
} from "../controllers/poolController.js";

const router = express.Router();

// ========================
// Pool CRUD
// ========================
router.post("/create", isAuthenticated, validate(createPoolSchema), createPool);
router.get("/my", isAuthenticated, getMyPools);
router.get("/:poolId", isAuthenticated, getPoolById);
router.put("/:poolId", isAuthenticated, validate(updatePoolSchema), updatePool);
router.delete("/:poolId", isAuthenticated, deletePool);

// ========================
// Membership
// ========================
router.post(
  "/:poolId/add-member",
  isAuthenticated,
  validate(poolMemberSchema),
  addMember,
);
router.post(
  "/:poolId/remove-member",
  isAuthenticated,
  validate(poolMemberSchema),
  removeMember,
);
router.post("/:poolId/leave", isAuthenticated, leavePool);

// ========================
// Status
// ========================
router.put("/:poolId/close", isAuthenticated, closePool);
router.put("/:poolId/reopen", isAuthenticated, reopenPool);

// ========================
// Transactions
// ========================
router.post(
  "/tx/create",
  isAuthenticated,
  validate(addPoolTxSchema),
  addPoolTx,
);
router.get("/tx/:poolId", isAuthenticated, getPoolTxns);
router.put("/tx/:txnId", isAuthenticated, editPoolTx);
router.delete("/tx/:txnId", isAuthenticated, deletePoolTx);
router.post("/tx/verify", isAuthenticated, verifyPoolTx);

// ========================
// Stats
// ========================
router.get("/:poolId/stats", isAuthenticated, getPoolStats);

export default router;
