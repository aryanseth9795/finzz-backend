import express from "express";
import {
  addtxns,
  getTxns,
  verifyTxn,
  editTxn,
  deleteTxn,
  getAllTxnsUser,
} from "../controllers/txController.js";
import isAuthenticated from "../middlewares/auth.js";
import { validate, addTxnSchema } from "../middlewares/validation.js";

const router = express.Router();

router.post("/createtx", isAuthenticated, validate(addTxnSchema), addtxns);
router.get("/gettx/:chatId", isAuthenticated, getTxns); // chatId in URL, cursor in query
router.put("/edittx/:txnId", isAuthenticated, editTxn); // NEW
router.delete("/deletetx/:txnId", isAuthenticated, deleteTxn); // NEW
router.post("/verifytx", isAuthenticated, verifyTxn);
router.get("/usersfriend", isAuthenticated, getAllTxnsUser);

export default router;
