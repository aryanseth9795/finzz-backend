import express from "express";
import { login, register, logout } from "../controllers/usercontroller.js";
import isAuthenticated from "../middlewares/auth.js";

const router = express.Router();

router.post("/login", login);
router.post("/register", register);
router.get("/logout", isAuthenticated, logout);

export default router;
