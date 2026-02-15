import mongoose, { Document, Schema } from "mongoose";

export interface ITx extends Document {
  chatId: mongoose.Types.ObjectId;
  amount: number;
  date: Date;
  remarks?: string;
  to: mongoose.Types.ObjectId;
  from: mongoose.Types.ObjectId;
  addedBy: mongoose.Types.ObjectId;
  verified: boolean;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const txSchema = new Schema<ITx>(
  {
    chatId: {
      type: Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
      index: true, // Critical for filtering txns by chat
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    remarks: {
      type: String,
      trim: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    addedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    verified: {
      type: Boolean,
      default: false,
      index: true,
    },
    verifiedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    verifiedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound indexes for scalable performance
txSchema.index({ chatId: 1, date: -1 }); // For pagination in chat view (most important)
txSchema.index({ chatId: 1, verified: 1 }); // For filtering unverified txns
txSchema.index({ addedBy: 1, verified: 1 }); // For edit/delete guards
txSchema.index({ from: 1, to: 1, date: -1 }); // For per-friend reports

export const Tx = mongoose.models.Tx || mongoose.model<ITx>("Tx", txSchema);
