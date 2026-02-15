import mongoose, { Document, Schema } from "mongoose";

export interface IMonthlySummary extends Document {
  chatId: mongoose.Types.ObjectId;
  year: number;
  month: number; // 1-12
  members: Map<string, { totalSent: number; totalReceived: number }>;
  txCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const monthlySummarySchema = new Schema<IMonthlySummary>(
  {
    chatId: {
      type: Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
    },
    year: {
      type: Number,
      required: true,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    members: {
      type: Map,
      of: {
        totalSent: { type: Number, default: 0 },
        totalReceived: { type: Number, default: 0 },
      },
      default: {},
    },
    txCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// One document per chat per month — the key index for O(1) lookups
monthlySummarySchema.index({ chatId: 1, year: 1, month: 1 }, { unique: true });

// For fetching all available months for a chat
monthlySummarySchema.index({ chatId: 1, year: -1, month: -1 });

export const MonthlySummary =
  mongoose.models.MonthlySummary ||
  mongoose.model<IMonthlySummary>("MonthlySummary", monthlySummarySchema);
