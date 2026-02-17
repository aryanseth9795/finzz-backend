import mongoose, { Document, Schema } from "mongoose";

export interface IExpense extends Document {
  userId: mongoose.Types.ObjectId;
  ledgerId: mongoose.Types.ObjectId;
  amount: number;
  date: Date;
  remarks?: string;
  category?: string;
  createdAt: Date;
  updatedAt: Date;
}

const expenseSchema = new Schema<IExpense>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    ledgerId: {
      type: Schema.Types.ObjectId,
      ref: "ExpenseLedger",
      required: true,
      index: true,
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
    category: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound indexes for efficient queries
expenseSchema.index({ userId: 1, ledgerId: 1, date: -1 }); // Primary query pattern
expenseSchema.index({ userId: 1, date: -1 }); // For stats across all ledgers

export const Expense =
  mongoose.models.Expense || mongoose.model<IExpense>("Expense", expenseSchema);
