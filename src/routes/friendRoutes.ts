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
import { heavyLimiter } from "../middlewares/rateLimit.js";
import {
  validate,
  checkContactsSchema,
  searchPhoneSchema,
  friendRequestSchema,
  friendRequestActionSchema,
  friendIdParamSchema,
} from "../middlewares/validation.js";

const router = express.Router();

/**
 * `/search` now validates and is rate limited.
 *
 * It had neither. Without a schema, `{"phone": {"$ne": null}}` reached
 * `User.findOne({ phone })` as an operator query — a full user-table read
 * primitive. Without a limit, it was also a bulk phone-number enumeration
 * endpoint even when used as intended.
 */
router.post(
  "/search",
  isAuthenticated,
  heavyLimiter,
  validate(searchPhoneSchema),
  searchByPhone,
);

router.post(
  "/check-contacts",
  isAuthenticated,
  heavyLimiter,
  validate(checkContactsSchema),
  checkContacts,
); // Bulk contact sync

router.post(
  "/request",
  isAuthenticated,
  validate(friendRequestSchema),
  sendFriendRequest,
);
router.get("/requests", isAuthenticated, getPendingRequests);
router.post(
  "/accept",
  isAuthenticated,
  validate(friendRequestActionSchema),
  acceptFriendRequest,
);
router.post(
  "/reject",
  isAuthenticated,
  validate(friendRequestActionSchema),
  rejectFriendRequest,
);
router.get("/list", isAuthenticated, getFriendsList);
router.delete(
  "/remove/:friendId",
  isAuthenticated,
  validate(friendIdParamSchema),
  removeFriend,
);

export default router;
