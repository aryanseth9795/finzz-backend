import mongoose from "mongoose";

const statsSchema = new mongoose.Schema({
  chatid: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Chat",
    required: true,
  },
  totalAmount: {
    type: Number,
    required: true,
  },
  totalMembers: {
    type: Number,
    required: true,
  },
  totalTransactions: {
    type: Number,
    required: true,
  },
});

export const Stats =
  mongoose.models.Stats || mongoose.model("Stats", statsSchema);
