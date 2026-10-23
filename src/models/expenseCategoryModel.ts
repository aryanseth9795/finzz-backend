import mongoose, { Document, Schema } from "mongoose";

/** Same bound as the expense `category` field (`shortText(50, "Category")`). */
export const EXPENSE_CATEGORY_NAME_MAX = 50;

/**
 * One saved expense category: the source of the chips on Add/Edit Expense.
 *
 * Rows are written only by services/expenseCategories.ts, which normalises the
 * name and keeps `User.expenseCategoriesVersion` in step with every real
 * insert and delete. Past expenses keep their own category text, so removing a
 * row here never touches an expense.
 */
export interface IExpenseCategory extends Document {
  userId: mongoose.Types.ObjectId;
  type: "debit" | "credit";
  /** Display form: trimmed, inner whitespace collapsed, spelling kept. */
  name: string;
  /** `name` lowercased; what matching and uniqueness use. */
  key: string;
  createdAt: Date;
  updatedAt: Date;
}

const expenseCategorySchema = new Schema<IExpenseCategory>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["debit", "credit"],
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: EXPENSE_CATEGORY_NAME_MAX,
    },
    key: {
      type: String,
      required: true,
      maxlength: EXPENSE_CATEGORY_NAME_MAX,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// One name per type per user, enforced by the database rather than a
// read-then-write check, so two saves racing on the same new name (or a phone
// whose copy is out of date) can never create a duplicate. The `userId` prefix
// also serves the list query, so no separate `userId` index is declared.
expenseCategorySchema.index({ userId: 1, type: 1, key: 1 }, { unique: true });

export const ExpenseCategory =
  mongoose.models.ExpenseCategory ||
  mongoose.model<IExpenseCategory>("ExpenseCategory", expenseCategorySchema);
