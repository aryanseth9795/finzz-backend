import mongoose, { Document, Schema } from "mongoose";

export interface IExpenseLedger extends Document {
  userId: mongoose.Types.ObjectId;
  year: number;
  month: number; // 1-12
  status: "open" | "closed";
  closedAt?: Date;
  totalExpenses: number;
  createdAt: Date;
  updatedAt: Date;
}

const expenseLedgerSchema = new Schema<IExpenseLedger>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    year: {
      type: Number,
      required: true,
      min: 2020,
      max: 2100,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    status: {
      type: String,
      enum: ["open", "closed"],
      default: "open",
      index: true,
    },
    closedAt: {
      type: Date,
    },
    totalExpenses: {
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

// Unique constraint: one ledger per user per month
expenseLedgerSchema.index({ userId: 1, year: 1, month: 1 }, { unique: true });

// For fetching ledgers by status
expenseLedgerSchema.index({ userId: 1, status: 1, year: -1, month: -1 });

export const ExpenseLedger =
  mongoose.models.ExpenseLedger ||
  mongoose.model<IExpenseLedger>("ExpenseLedger", expenseLedgerSchema);
