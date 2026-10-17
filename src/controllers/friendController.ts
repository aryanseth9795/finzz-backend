import { Request, Response, NextFunction } from "express";
import TryCatch from "../utils/TryCatch.js"; // default export
import { phoneVariants, canonicalPhone } from "../utils/phone.js";
import { User } from "../models/userModel.js";
import { FriendRequest } from "../models/friendRequestModel.js";
import { Chat, buildPairKey } from "../models/chatModel.js";
import { Note } from "../models/noteModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import { sendPushNotification } from "../services/notificationService.js";
import mongoose from "mongoose";

// Search for a user by phone number
export const searchByPhone = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone } = req.body;

    /**
     * `phone` is now guaranteed to be a string by `searchPhoneSchema` on the
     * route, and re-checked here as defence in depth.
     *
     * The route previously had no schema, so `express.json()` parsed
     * `{"phone": {"$ne": null}}` into an object and `User.findOne({ phone })`
     * became `User.findOne({ phone: { $ne: null } })` — an operator query that
     * returned an arbitrary user. With `{"$regex": "^"}` an attacker could walk
     * the entire user table, harvesting every name and phone number.
     *
     * The fix is a type check, not escaping: MongoDB's query language treats a
     * nested object as operators, so the vulnerability is "an object arrived
     * where a scalar was expected".
     */
    if (typeof phone !== "string" || !phone.trim()) {
      return next(new ErrorHandler("Phone number is required", 400));
    }

    const user: any = await User.findOne({ phone: { $in: phoneVariants(phone) } })
      .select("_id name phone avatar")
      .lean();

    if (user) {
      return res.status(200).json({
        success: true,
        exists: true,
        user: {
          _id: user._id,
          name: user.name,
          phone: user.phone,
          avatar: user.avatar,
        },
      });
    } else {
      return res.status(200).json({
        success: true,
        exists: false,
        message: "User not on Finzz. Send invite?",
      });
    }
  },
);

// Check multiple contacts (bulk) - Contact Sync Feature
export const checkContacts = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phoneNumbers } = req.body;

    if (!Array.isArray(phoneNumbers)) {
      return next(new ErrorHandler("phoneNumbers must be an array", 400));
    }

    if (phoneNumbers.length > 200) {
      return next(new ErrorHandler("Maximum 200 contacts per request", 400));
    }

    // Every element must be a string. Without this, an array containing an
    // object turns `$in` into an operator match — the same injection as
    // searchByPhone, just wrapped in an array.
    const safeNumbers = phoneNumbers
      .filter((p: unknown): p is string => typeof p === "string")
      .map((p: string) => p.trim())
      .filter(Boolean);

    if (safeNumbers.length === 0) {
      return res
        .status(200)
        .json({ success: true, registered: [], unregistered: [] });
    }

    const registeredUsers: any = await User.find({
      phone: { $in: safeNumbers.flatMap(phoneVariants) },
    })
      .select("_id name phone avatar")
      .lean();

    // Create a Set of registered phone numbers for fast lookup
    // Compared by canonical key: a contact saved as "+91…" must match an
    // account stored as 10 digits, and vice versa.
    const registeredPhones = new Set(
      registeredUsers.map((u: any) => canonicalPhone(u.phone)),
    );

    // Filter unregistered phone numbers
    const unregistered = phoneNumbers.filter(
      (phone) => !registeredPhones.has(canonicalPhone(String(phone))),
    );

    return res.status(200).json({
      success: true,
      registered: registeredUsers,
      unregistered,
    });
  },
);

// Send friend request
export const sendFriendRequest = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { toUserId } = req.body;
    const fromUserId = req.user.id;

    // Validate sender ≠ receiver
    if (fromUserId === toUserId) {
      return next(
        new ErrorHandler("You cannot send friend request to yourself", 400),
      );
    }

    const currentUser: any = await User.findById(fromUserId)
      .select("friends")
      .lean();

    if (currentUser?.friends.some((id: any) => id.toString() === toUserId)) {
      return next(new ErrorHandler("Already friends", 400));
    }

    // Check for existing pending request (in either direction)
    const existingRequest = await FriendRequest.findOne({
      $or: [
        { from: fromUserId, to: toUserId, status: "pending" },
        { from: toUserId, to: fromUserId, status: "pending" },
      ],
    }).lean();

    if (existingRequest) {
      return next(new ErrorHandler("Friend request already exists", 400));
    }

    // Create friend request
    await FriendRequest.create({
      from: fromUserId,
      to: toUserId,
      status: "pending",
    });

    // Send push notification
    const senderName = await User.findById(fromUserId)
      .select("name")
      .lean<{ name: string }>();
    await sendPushNotification(
      toUserId,
      "Friend Request",
      `${senderName?.name} wants to be your friend`,
      {
        type: "friend_request",
        senderId: fromUserId,
      },
    );

    return res.status(201).json({
      success: true,
      message: "Friend request sent successfully",
    });
  },
);

// Get pending friend requests (incoming and sent)
export const getPendingRequests = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    // Find incoming requests
    const incoming = await FriendRequest.find({
      to: userId,
      status: "pending",
    })
      .populate("from", "name phone avatar")
      .lean()
      .limit(50)
      .sort({ createdAt: -1 });

    // Find sent requests
    const sent = await FriendRequest.find({
      from: userId,
      status: "pending",
    })
      .populate("to", "name phone avatar")
      .lean()
      .limit(50)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      incoming,
      sent,
    });
  },
);

// Accept friend request
export const acceptFriendRequest = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { requestId } = req.body;
    const userId = req.user.id;

    const friendRequest = await FriendRequest.findById(requestId);

    if (!friendRequest) {
      return next(new ErrorHandler("Friend request not found", 404));
    }

    // Validate ownership (request must be TO this user)
    if (friendRequest.to.toString() !== userId) {
      return next(
        new ErrorHandler("You are not authorized to accept this request", 403),
      );
    }

    if (friendRequest.status !== "pending") {
      return next(new ErrorHandler("Friend request is not pending", 400));
    }

    const fromUser = friendRequest.from.toString();
    const toUser = friendRequest.to.toString();

    /**
     * All three writes now happen in one transaction, and chat creation is
     * idempotent.
     *
     * Before: the status update, the two `friends` updates, and `Chat.create`
     * were four independent awaits. A failure between them left a friendship
     * with no chat — the exact corruption that `scripts/repairMissingChats.ts`
     * was written to clean up. And because the client reports a failure of the
     * *follow-up* chat refetch as "Failed to accept", users retried an already
     * accepted request, and the unconditional `Chat.create` produced a second
     * chat for the same pair, splitting their transaction history in two.
     */
    let chatId = "";
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        friendRequest.status = "accepted";
        await friendRequest.save({ session });

        await User.updateOne(
          { _id: fromUser },
          { $addToSet: { friends: toUser } },
          { session },
        );
        await User.updateOne(
          { _id: toUser },
          { $addToSet: { friends: fromUser } },
          { session },
        );

        /**
         * Idempotent chat creation.
         *
         * The obvious `findOneAndUpdate({ members: { $all: [...], $size: 2 } },
         * …, { upsert: true })` does NOT work: with `upsert`, MongoDB derives
         * the new document from the query's equality conditions, and `members`
         * appearing under both `$all` and `$size` is rejected outright with
         * `NotSingleValueField: path 'members' is matched twice`.
         *
         * Upserting on the scalar `pairKey` avoids the inference problem
         * entirely, and its unique index makes a duplicate impossible even if
         * two requests race — the loser gets E11000 and re-reads.
         */
        const pairKey = buildPairKey(fromUser, toUser);

        // Adopt a chat created before `pairKey` existed, so legacy pairs are
        // not duplicated by the new lookup.
        const legacy = await Chat.findOne({
          groupChat: false,
          pairKey: { $exists: false },
          members: { $all: [fromUser, toUser] },
        }).session(session);

        if (legacy && legacy.members.length === 2) {
          legacy.pairKey = pairKey;
          await legacy.save({ session });
          chatId = legacy._id.toString();
        } else {
          const chat = await Chat.findOneAndUpdate(
            { pairKey },
            {
              $setOnInsert: {
                groupChat: false,
                members: [fromUser, toUser],
                pairKey,
              },
            },
            { upsert: true, new: true, session },
          );
          chatId = chat._id.toString();
        }
      });
    } finally {
      await session.endSession();
    }

    // Send push notification
    const accepterName = await User.findById(userId)
      .select("name")
      .lean<{ name: string }>();
    await sendPushNotification(
      fromUser,
      "Friend Request Accepted",
      `${accepterName?.name} accepted your friend request`,
      {
        type: "friend_accepted",
        senderId: userId,
        chatId,
      },
    );

    return res.status(200).json({
      success: true,
      message: "Friend request accepted",
      chatId,
    });
  },
);

// Reject friend request
export const rejectFriendRequest = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { requestId } = req.body;
    const userId = req.user.id;

    const friendRequest = await FriendRequest.findById(requestId);

    if (!friendRequest) {
      return next(new ErrorHandler("Friend request not found", 404));
    }

    // Validate ownership
    if (friendRequest.to.toString() !== userId) {
      return next(
        new ErrorHandler("You are not authorized to reject this request", 403),
      );
    }

    friendRequest.status = "rejected";
    await friendRequest.save();

    return res.status(200).json({
      success: true,
      message: "Friend request rejected",
    });
  },
);

// Get friends list
export const getFriendsList = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    const user: any = await User.findById(userId)
      .populate("friends", "name phone avatar")
      .lean();

    return res.status(200).json({
      success: true,
      friends: user?.friends || [],
    });
  },
);

// Remove friend
export const removeFriend = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { friendId } = req.params;
    const userId = req.user.id;

    /**
     * Ending a friendship also ends note access between the pair, both ways:
     * notes can only be shared with friends, so a share must not outlive the
     * friendship it was granted on. Person labels are kept — a label is the
     * owner's own filing and grants nothing.
     *
     * One transaction, so a failure cannot leave them unfriended but still
     * reading each other's notes.
     */
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await User.updateOne(
          { _id: userId },
          { $pull: { friends: friendId } },
          { session },
        );
        await User.updateOne(
          { _id: friendId },
          { $pull: { friends: userId } },
          { session },
        );
        await Note.updateMany(
          { owner: userId, "shares.user": friendId },
          { $pull: { shares: { user: friendId } } },
          { session },
        );
        await Note.updateMany(
          { owner: friendId, "shares.user": userId },
          { $pull: { shares: { user: userId } } },
          { session },
        );
      });
    } finally {
      await session.endSession();
    }

    return res.status(200).json({
      success: true,
      message: "Friend removed successfully",
    });
  },
);
