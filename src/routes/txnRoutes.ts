

import express from "express";
import { addtxns,getTxns,verifyTxn,getAllTxnsUser } from "../controllers/txController.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

router.post("/createtx", isAuthenticated, addtxns);
router.get("/gettx", isAuthenticated, getTxns);
router.get("/usersfriend", isAuthenticated, getAllTxnsUser  );
router.post("/verifytx", isAuthenticated, verifyTxn);

export default router;