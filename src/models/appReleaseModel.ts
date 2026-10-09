import mongoose, { Document, Schema } from "mongoose";

export interface IAppRelease extends Document {
  key: string;
  latestVersion: string;
  minSupportedVersion: string;
  apkUrl: string;
  releaseNotes: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Singleton: one document per platform, addressed by `key`. Only Android is
 * distributed as an APK today.
 */
const appReleaseSchema = new Schema<IAppRelease>(
  {
    key: { type: String, required: true, unique: true, default: "android" },
    latestVersion: { type: String, required: true },
    minSupportedVersion: { type: String, required: true },
    apkUrl: { type: String, required: true },
    releaseNotes: { type: String, default: "" },
  },
  { timestamps: true },
);

export const AppRelease = mongoose.model<IAppRelease>(
  "AppRelease",
  appReleaseSchema,
);
