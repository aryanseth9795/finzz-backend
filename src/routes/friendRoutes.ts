import express from "express";
import {
  searchByPhone,
  checkContacts,
  sendFriendRequest,
  getPendingRequests,
  acceptFriendRequest,
  rejectFriendRequest,
  getFriendsList,
  removeFriend,
} from "../controllers/friendController.js";
import isAuthenticated from "../middlewares/auth.js";
import { validate, checkContactsSchema } from "../middlewares/validation.js";

const router = express.Router();

router.post("/search", isAuthenticated, searchByPhone);
router.post(
  "/check-contacts",
  isAuthenticated,
  validate(checkContactsSchema),
  checkContacts,
); // Bulk contact sync
router.post("/request", isAuthenticated, sendFriendRequest);
router.get("/requests", isAuthenticated, getPendingRequests);
router.post("/accept", isAuthenticated, acceptFriendRequest);
router.post("/reject", isAuthenticated, rejectFriendRequest);
router.get("/list", isAuthenticated, getFriendsList);
router.delete("/remove/:friendId", isAuthenticated, removeFriend);

export default router;
