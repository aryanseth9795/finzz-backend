import express from "express";
import { getPublicRelease } from "../controllers/appReleaseController.js";

const router = express.Router();

// Public: the mobile app checks this before login to decide whether to block.
router.get("/version", getPublicRelease);

export default router;
