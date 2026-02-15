import { Request, Response, NextFunction } from "express";
import TryCatch from "../utils/TryCatch.js"; // default export
import { Chat } from "../models/chatModel.js";
import ErrorHandler from "../middlewares/Errorhandler.js";

// Get all chats for the current user (WhatsApp-style home screen)
export const getUserChats = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const userId = req.user.id;

    // Find all chats where user is a member
    const chats: any = await Chat.find({ members: userId })
      .populate("members", "name phone avatar")
      .sort({ "lastTransaction.date": -1 }) // Latest transaction first (like WhatsApp)
      .lean();

    // Filter out the current user from members for cleaner response
    const formattedChats = chats.map((chat: any) => ({
      ...chat,
      members: chat.members.filter(
        (member: any) => member._id.toString() !== userId,
      ),
    }));

    return res.status(200).json({
      success: true,
      chats: formattedChats,
    });
  },
);

// Get a specific chat by ID
export const getChatById = TryCatch(
  async (req: Request, res: Response, next: NextFunction) => {
    const { chatId } = req.params;
    const userId = req.user.id;

    const chat: any = await Chat.findById(chatId)
      .populate("members", "name phone avatar")
      .lean();

    if (!chat) {
      return next(new ErrorHandler("Chat not found", 404));
    }

    // Validate user is a member of this chat
    const isMember = chat.members.some(
      (member: any) => member._id.toString() === userId,
    );

    if (!isMember) {
      return next(new ErrorHandler("You are not a member of this chat", 403));
    }

    return res.status(200).json({
      success: true,
      chat,
    });
  },
);
