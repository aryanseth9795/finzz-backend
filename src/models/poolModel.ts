import mongoose, { Schema, model, Types, Document } from "mongoose";

export interface IPool extends Document {
  name: string;
  description?: string;
  image?: string; // Cloudinary URL
  rules?: string;
  admin: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  status: "active" | "closed";
  lastTransaction?: {
    amount: number;
    date: Date;
    remark: string;
    addedBy: mongoose.Types.ObjectId;
  };
  createdAt: Date;
  updatedAt: Date;
}

const poolSchema = new Schema<IPool>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
    },
    description: {
      type: String,
      trim: true,
      maxlength: 500,
    },
    image: {
      type: String,
    },
    rules: {
      type: String,
      maxlength: 1000,
    },
    admin: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    members: [
      {
        type: Types.ObjectId,
        ref: "User",
      },
    ],
    status: {
      type: String,
      enum: ["active", "closed"],
      default: "active",
      index: true,
    },
    lastTransaction: {
      amount: Number,
      date: Date,
      remark: String,
      addedBy: {
        type: Types.ObjectId,
        ref: "User",
      },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound index for efficient pool list queries (sorted by last activity)
poolSchema.index({ members: 1, "lastTransaction.date": -1 });

// Index for admin-only queries
poolSchema.index({ admin: 1 });

export const Pool = mongoose.models.Pool || model<IPool>("Pool", poolSchema);
