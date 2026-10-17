import mongoose, { Document, Schema } from "mongoose";

export interface IPushTicket extends Document {
  /** Expo ticket id; the key used to fetch the delivery receipt later. */
  ticketId: string;
  /** Device token the message was addressed to. */
  token: string;
  userId?: mongoose.Types.ObjectId;
  createdAt: Date;
  /** Set once the receipt has been fetched. */
  checkedAt?: Date;
  status?: "ok" | "error";
  /** `details.error` from the receipt, e.g. `InvalidCredentials`. */
  error?: string;
  message?: string;
}

/**
 * A push *ticket* only means Expo queued the message. Whether FCM/APNs
 * actually delivered it is reported later in a push *receipt*, which can only
 * be fetched by ticket id. This collection remembers the ids of accepted
 * tickets so the receipts can be fetched and real delivery failures surfaced.
 */
const pushTicketSchema = new Schema<IPushTicket>(
  {
    ticketId: { type: String, required: true, unique: true },
    token: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    createdAt: { type: Date, default: Date.now },
    checkedAt: { type: Date },
    status: { type: String, enum: ["ok", "error"] },
    error: { type: String },
    message: { type: String },
  },
  { versionKey: false },
);

/** Expo only keeps receipts for about a day; keep rows a little longer for stats. */
export const PUSH_TICKET_TTL_SECONDS = 3 * 24 * 60 * 60;

pushTicketSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: PUSH_TICKET_TTL_SECONDS },
);

export const PushTicket =
  mongoose.models.PushTicket ||
  mongoose.model<IPushTicket>("PushTicket", pushTicketSchema);
