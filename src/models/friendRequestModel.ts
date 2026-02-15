import mongoose, { Document, Schema } from "mongoose";

// TypeScript interface for FriendRequest document
export interface IFriendRequest extends Document {
  from: mongoose.Types.ObjectId;
  to: mongoose.Types.ObjectId;
  status: "pending" | "accepted" | "rejected";
  createdAt: Date;
  updatedAt: Date;
}

const friendRequestSchema = new Schema<IFriendRequest>(
  {
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true, // For filtering by status
    },
  },
  {
    timestamps: true,
  },
);

// Compound unique index: prevent duplicate requests
friendRequestSchema.index({ from: 1, to: 1 }, { unique: true });

// Compound indexes for efficient queries
friendRequestSchema.index({ to: 1, status: 1 }); // For getting incoming pending requests
friendRequestSchema.index({ from: 1, status: 1 }); // For getting sent pending requests

export const FriendRequest =
  mongoose.models.FriendRequest ||
  mongoose.model<IFriendRequest>("FriendRequest", friendRequestSchema);
