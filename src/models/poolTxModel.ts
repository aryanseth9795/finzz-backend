import mongoose, { Document, Schema } from "mongoose";

export interface IPoolTx extends Document {
  poolId: mongoose.Types.ObjectId;
  amount: number;
  type: "credit" | "debit";
  date: Date;
  remarks?: string;
  addedBy: mongoose.Types.ObjectId;
  verified: boolean;
  verifiedBy?: mongoose.Types.ObjectId;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const poolTxSchema = new Schema<IPoolTx>(
  {
    poolId: {
      type: Schema.Types.ObjectId,
      ref: "Pool",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
      index: true,
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
poolTxSchema.index({ poolId: 1, date: -1 }); // For pagination in pool ledger view
poolTxSchema.index({ poolId: 1, type: 1 }); // For aggregating credits/debits
poolTxSchema.index({ poolId: 1, verified: 1 }); // For filtering unverified txns
poolTxSchema.index({ addedBy: 1, verified: 1 }); // For edit/delete guards

export const PoolTx =
  mongoose.models.PoolTx || mongoose.model<IPoolTx>("PoolTx", poolTxSchema);
