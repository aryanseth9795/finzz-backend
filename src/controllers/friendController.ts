import { Request, Response, NextFunction } from "express";
import TryCatch from "../utils/TryCatch.js"; // default export
import { User } from "../models/userModel.js";
import { FriendRequest } from "../models/friendRequestModel.js";
import { Chat } from "../models/chatModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import { sendPushNotification } from "../services/notificationService.js";
import mongoose from "mongoose";

// Search for a user by phone number
export const searchByPhone = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { phone } = req.body;

    if (!phone) {
      return next(new ErrorHandler("Phone number is required", 400));
    }

    const user: any = await User.findOne({ phone })
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

    const registeredUsers: any = await User.find({
      phone: { $in: phoneNumbers },
    })
      .select("_id name phone avatar")
      .lean();

    // Create a Set of registered phone numbers for fast lookup
    const registeredPhones = new Set(registeredUsers.map((u: any) => u.phone));

    // Filter unregistered phone numbers
    const unregistered = phoneNumbers.filter(
      (phone) => !registeredPhones.has(phone),
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

    // 1. Update friend request status
    friendRequest.status = "accepted";
    await friendRequest.save();

    // 2. Add each user to other's friends array
    await User.updateOne({ _id: fromUser }, { $addToSet: { friends: toUser } });
    await User.updateOne({ _id: toUser }, { $addToSet: { friends: fromUser } });

    // 3. Auto-create Chat (1-to-1 "conversation" for transactions)
    const chat = await Chat.create({
      groupChat: false,
      members: [fromUser, toUser],
    });
    const chatId = chat._id.toString();

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

    // Remove from both users' friends arrays
    await User.updateOne({ _id: userId }, { $pull: { friends: friendId } });
    await User.updateOne({ _id: friendId }, { $pull: { friends: userId } });

    return res.status(200).json({
      success: true,
      message: "Friend removed successfully",
    });
  },
);
