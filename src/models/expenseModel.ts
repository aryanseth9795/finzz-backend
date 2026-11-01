import mongoose, { Document, Schema } from "mongoose";

/** How an expense was paid. Optional: absent means "not recorded". */
export const PAYMENT_MODES = ["cash", "online"] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** How an online payment was made (Card covers debit and credit cards). */
export const PAYMENT_METHODS = ["upi", "card", "netbanking", "wallet", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface IExpense extends Document {
  userId: mongoose.Types.ObjectId;
  ledgerId: mongoose.Types.ObjectId;
  amount: number;
  type: "debit" | "credit";
  date: Date;
  remarks?: string;
  category?: string;
  paymentMode?: PaymentMode;
  paymentMethod?: PaymentMethod;
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
    type: {
      type: String,
      enum: ["debit", "credit"],
      default: "debit",
      required: true,
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
    // Both optional with no default: rows without them (every row saved
    // before this field, and any the user leaves blank) mean "not recorded".
    // `paymentMethod` is only meaningful when `paymentMode` is "online";
    // validation and editExpense keep it off every other row. No index:
    // nothing filters on them yet.
    paymentMode: {
      type: String,
      enum: PAYMENT_MODES,
    },
    paymentMethod: {
      type: String,
      enum: PAYMENT_METHODS,
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
