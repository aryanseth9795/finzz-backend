import { Request, Response } from "express";
import TryCatch from "../utils/TryCatch.js";
import { AppRelease } from "../models/appReleaseModel.js";

const RELEASE_KEY = "android";

/** What clients see before any release is published: blocks nobody. */
const ZERO_RELEASE = {
  latestVersion: "0.0.0",
  minSupportedVersion: "0.0.0",
  apkUrl: "",
  releaseNotes: "",
};

const loadRelease = async () => {
  const doc = await AppRelease.findOne({ key: RELEASE_KEY }).lean();
  if (!doc) return ZERO_RELEASE;
  return {
    latestVersion: doc.latestVersion,
    minSupportedVersion: doc.minSupportedVersion,
    apkUrl: doc.apkUrl,
    releaseNotes: doc.releaseNotes ?? "",
    updatedAt: doc.updatedAt,
  };
};

/** Public — the app calls this before login, so no auth. */
export const getPublicRelease = TryCatch(
  async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ success: true, release: await loadRelease() });
  },
);

export const getAdminRelease = TryCatch(
  async (_req: Request, res: Response) => {
    res.status(200).json({ success: true, release: await loadRelease() });
  },
);

export const updateAppRelease = TryCatch(
  async (req: Request, res: Response) => {
    const { latestVersion, minSupportedVersion, apkUrl, releaseNotes } =
      req.body;
    await AppRelease.findOneAndUpdate(
      { key: RELEASE_KEY },
      { latestVersion, minSupportedVersion, apkUrl, releaseNotes },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.status(200).json({ success: true, release: await loadRelease() });
  },
);
