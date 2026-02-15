/**
 * One-time repair script: Creates missing Chat documents for accepted friend requests.
 *
 * Run: npx tsx src/scripts/repairMissingChats.ts
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import { Chat } from "../models/chatModel.js";
import { FriendRequest } from "../models/friendRequestModel.js";

dotenv.config();

async function repair() {
  const mongoUrl = process.env.MONGO_URL || "mongodb://localhost:27017/finzz";

  await mongoose.connect(mongoUrl);
  console.log("Connected to DB");

  // Find all accepted friend requests
  const acceptedRequests = await FriendRequest.find({
    status: "accepted",
  }).lean();
  console.log(`Found ${acceptedRequests.length} accepted friend requests`);

  let created = 0;

  for (const req of acceptedRequests) {
    const fromUser = req.from.toString();
    const toUser = req.to.toString();

    // Check if a chat already exists between these two users
    const existingChat = await Chat.findOne({
      groupChat: false,
      members: { $all: [fromUser, toUser] },
    }).lean();

    if (!existingChat) {
      await Chat.create({
        groupChat: false,
        members: [fromUser, toUser],
      });
      console.log(`Created chat for: ${fromUser} <-> ${toUser}`);
      created++;
    }
  }

  console.log(`Done! Created ${created} missing chats.`);
  await mongoose.disconnect();
}

repair().catch((err) => {
  console.error("Repair failed:", err);
  process.exit(1);
});
