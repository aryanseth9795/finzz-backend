import mongoose, { Schema, model, Types, Document } from "mongoose";

export interface IChat extends Document {
  name?: string;
  groupChat: boolean;
  creator?: mongoose.Types.ObjectId;
  members: mongoose.Types.ObjectId[];
  /**
   * Canonical identity of a 1:1 chat: both member ids sorted and joined.
   *
   * A multikey index on `members` cannot express "this PAIR is unique" — a
   * unique index on an array field would mean a user may appear in only one
   * chat in total. Projecting the pair onto a single scalar makes the
   * constraint expressible, so duplicate chats become impossible at the
   * database level rather than merely avoided by application logic.
   */
  pairKey?: string;
  lastTransaction?: {
    amount: number;
    date: Date;
    remark: string;
    to?: mongoose.Types.ObjectId;
    from?: mongoose.Types.ObjectId;
    status?: "pending" | "verified" | "rejected";
  };
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<IChat>(
  {
    name: {
      type: String,
      required: false,
    },
    groupChat: {
      type: Boolean,
      default: false,
    },
    creator: {
      type: Types.ObjectId,
      ref: "User",
    },
    members: [
      {
        type: Types.ObjectId,
        ref: "User",
      },
    ],
    pairKey: {
      type: String,
    },
    lastTransaction: {
      amount: Number,
      date: Date,
      remark: String,
      to: {
        type: Types.ObjectId,
        ref: "User",
      },
      from: {
        type: Types.ObjectId,
        ref: "User",
      },
      status: {
        type: String,
        enum: ["pending", "verified", "rejected"],
      },
    },
  },
  {
    timestamps: true,
  },
);

// Compound index for efficient chat list queries (home screen sorted by last txn)
schema.index({ members: 1, "lastTransaction.date": -1 });

/**
 * Uniqueness for 1:1 chats.
 *
 * `partialFilterExpression` restricts the constraint to documents that
 * actually have a `pairKey`, so existing chats created before this field
 * existed are unaffected and no backfill is required for the index to build.
 */
schema.index(
  { pairKey: 1 },
  {
    unique: true,
    partialFilterExpression: { pairKey: { $type: "string" } },
  },
);

/** Canonical pair key: member ids sorted so ordering cannot vary. */
export const buildPairKey = (a: string, b: string): string =>
  [String(a), String(b)].sort().join(":");

export const Chat = mongoose.models.Chat || model<IChat>("Chat", schema);
