import mongoose, { Document, Schema } from "mongoose";

export type TxStatus = "pending" | "verified" | "rejected";

export interface ITx extends Document {
  chatId: mongoose.Types.ObjectId;
  amount: number;
  date: Date;
  remarks?: string;
  to: mongoose.Types.ObjectId;
  from: mongoose.Types.ObjectId;
  addedBy: mongoose.Types.ObjectId;
  status: TxStatus;
  verified: boolean;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  rejectedBy?: mongoose.Types.ObjectId;
  rejectedAt?: Date;
  rejectionRemark?: string;
  editedAt?: Date;
  editCount: number;
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
    status: {
      type: String,
      enum: ["pending", "verified", "rejected"],
      default: "pending",
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
    rejectedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    rejectedAt: {
      type: Date,
    },
    rejectionRemark: {
      type: String,
      trim: true,
    },
    editedAt: {
      type: Date,
    },
    editCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

txSchema.pre("save", function (this: ITx, next) {
  const nextStatus = this.status || (this.verified ? "verified" : "pending");

  this.status = nextStatus;
  this.verified = nextStatus === "verified";

  if (nextStatus !== "verified") {
    this.verifiedBy = undefined;
    this.verifiedAt = undefined;
  }

  if (nextStatus !== "rejected") {
    this.rejectedBy = undefined;
    this.rejectedAt = undefined;
    this.rejectionRemark = undefined;
  }

  next();
});

// Compound indexes for scalable performance
txSchema.index({ chatId: 1, date: -1 }); // For pagination in chat view (most important)
txSchema.index({ chatId: 1, status: 1 }); // For filtering by lifecycle state
txSchema.index({ addedBy: 1, status: 1 }); // For edit/delete guards
txSchema.index({ from: 1, to: 1, date: -1 }); // For per-friend reports

export const Tx = mongoose.models.Tx || mongoose.model<ITx>("Tx", txSchema);
