import express from "express";
import {
  addtxns,
  getTxns,
  reviewTxn,
  editTxn,
  deleteTxn,
  getAllTxnsUser,
} from "../controllers/txController.js";
import isAuthenticated from "../middlewares/auth.js";
import {
  validate,
  addTxnSchema,
  reviewTxnSchema,
  editTxnSchema,
  txnIdParamSchema,
  getTxnsSchema,
  verifyTxnSchema,
} from "../middlewares/validation.js";

const router = express.Router();

router.post("/createtx", isAuthenticated, validate(addTxnSchema), addtxns);
router.get(
  "/gettx/:chatId",
  isAuthenticated,
  validate(getTxnsSchema),
  getTxns,
); // chatId in URL, cursor in query

/**
 * `/edittx/:txnId` previously had no schema. Combined with the handler
 * assigning `to`/`from` directly onto the document without re-running
 * participant validation, that allowed arbitrary user ids to be written into a
 * transaction and propagated into MonthlySummary.
 */
router.put("/edittx/:txnId", isAuthenticated, validate(editTxnSchema), editTxn);
router.delete(
  "/deletetx/:txnId",
  isAuthenticated,
  validate(txnIdParamSchema),
  deleteTxn,
);
router.post("/reviewtx", isAuthenticated, validate(reviewTxnSchema), reviewTxn);
router.post("/verifytx", isAuthenticated, validate(verifyTxnSchema), reviewTxn);
router.get("/usersfriend", isAuthenticated, getAllTxnsUser);

export default router;
