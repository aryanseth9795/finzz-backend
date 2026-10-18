import mongoose, { Document, Schema, Types } from "mongoose";

export interface IDailyActivity extends Document {
  /** Local calendar day, "YYYY-MM-DD" (see ANALYTICS_TZ_OFFSET_MINUTES). */
  day: string;
  user: Types.ObjectId;
  /** Authenticated requests made by `user` on `day`. */
  requests: number;
  /** App opens (GET /users/profile) by `user` on `day`. */
  opens: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  /** Start of `day` + 180 days; the TTL index deletes the row after this. */
  expiresAt: Date;
}

export interface IDailyTraffic extends Document {
  day: string;
  /** Every API request that day, authenticated or not. */
  requests: number;
  authedRequests: number;
  expiresAt: Date;
}

/** Rows are kept for 180 days. */
export const ACTIVITY_RETENTION_DAYS = 180;

/**
 * One row per (day, user). Privacy: only the user id, the day, counters and
 * first/last seen times are stored. No IP addresses, paths or request content.
 */
const dailyActivitySchema = new Schema<IDailyActivity>(
  {
    day: { type: String, required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    requests: { type: Number, default: 0 },
    opens: { type: Number, default: 0 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// Unique (day, user); its prefix also serves queries on `day` alone.
dailyActivitySchema.index({ day: 1, user: 1 }, { unique: true });
// Retention is enforced by the database.
dailyActivitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const dailyTrafficSchema = new Schema<IDailyTraffic>(
  {
    day: { type: String, required: true, unique: true },
    requests: { type: Number, default: 0 },
    authedRequests: { type: Number, default: 0 },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

dailyTrafficSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DailyActivity =
  (mongoose.models.DailyActivity as mongoose.Model<IDailyActivity>) ||
  mongoose.model<IDailyActivity>("DailyActivity", dailyActivitySchema);

export const DailyTraffic =
  (mongoose.models.DailyTraffic as mongoose.Model<IDailyTraffic>) ||
  mongoose.model<IDailyTraffic>("DailyTraffic", dailyTrafficSchema);
