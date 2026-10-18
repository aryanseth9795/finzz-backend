#!/usr/bin/env node

/**
 * Clears every admin-login lockout (per-IP and global) so you can sign in again.
 * Use it if you locked yourself out; it only deletes AdminLoginGuard documents.
 *
 * Environment variables:
 *   MONGO_URL  required MongoDB connection string (read from .env)
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import mongoose from "mongoose";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");

// This also works when the command is run from the repository root.
dotenv.config({ path: path.join(projectDir, ".env"), quiet: true });

const mongoUrl = process.env.MONGO_URL?.trim();
if (!mongoUrl) {
  console.error("Unlock failed: MONGO_URL is not set. Add it to server/.env.");
  process.exit(1);
}

try {
  await mongoose.connect(mongoUrl);
  // Mongoose pluralises the AdminLoginGuard model to this collection name.
  const result = await mongoose.connection.db
    .collection("adminloginguards")
    .deleteMany({});
  console.log(`Cleared ${result.deletedCount} admin login guard record(s).`);
  await mongoose.disconnect();
} catch (error) {
  console.error(`Unlock failed: ${error.message}`);
  process.exit(1);
}
