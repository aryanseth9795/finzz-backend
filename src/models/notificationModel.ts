import mongoose, { Document, Schema } from "mongoose";

export interface INotification extends Document {
  recipient: mongoose.Types.ObjectId;
  /** Absent for admin-originated (system) notifications. */
  sender?: mongoose.Types.ObjectId;
  type:
    | "friend_request"
    | "friend_accepted"
    | "txn_added"
    | "txn_verified"
    | "txn_rejected"
    | "txn_reworked"
    | "txn_deleted"
    | "pool_tx_added"
    | "pool_tx_verified"
    | "pool_member_added"
    | "pool_member_removed"
    | "note_shared"
    | "admin_broadcast"
    | "admin_targeted";
  title?: string;
  body?: string;
  data?: Record<string, any>;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    recipient: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sender: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },
    type: {
      type: String,
      enum: [
        "friend_request",
        "friend_accepted",
        "txn_added",
        "txn_verified",
        "txn_rejected",
        "txn_reworked",
        "txn_deleted",
        "pool_tx_added",
        "pool_tx_verified",
        "pool_member_added",
        "pool_member_removed",
        "note_shared",
        "admin_broadcast",
        "admin_targeted",
      ],
      required: true,
    },
    title: {
      type: String,
      trim: true,
    },
    body: {
      type: String,
      trim: true,
    },
    data: {
      type: Schema.Types.Mixed,
    },
    read: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient notification queries (unread first, sorted by time)
notificationSchema.index({ recipient: 1, read: 1, createdAt: -1 });

export const Notification =
  mongoose.models.Notification ||
  mongoose.model<INotification>("Notification", notificationSchema);
