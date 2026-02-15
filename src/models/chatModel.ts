import mongoose, { Schema, model, Types, Document } from "mongoose";

export interface IChat extends Document {
  name?: string;
  groupChat: boolean;
  creator?: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  lastTransaction?: {
    amount: number;
    date: Date;
    remark: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IChat>(
  {
    name: {
      type: String,
      required: false,
    },
    groupChat: {
      type: Boolean,
      default: false,
    },
    creator: {
      type: Types.ObjectId,
      ref: "User",
    },
    members: [
      {
        type: Types.ObjectId,
        ref: "User",
      },
    ],
    lastTransaction: {
      amount: Number,
      date: Date,
      remark: String,
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient chat list queries (home screen sorted by last txn)
schema.index({ members: 1, "lastTransaction.date": -1 });

export const Chat = mongoose.models.Chat || model<IChat>("Chat", schema);
