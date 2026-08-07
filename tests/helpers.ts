import mongoose from "mongoose";
import request from "supertest";
import type { Express } from "express";
import { lastOtp } from "./mailbox.js";

/** Connect once for the whole suite. */
export const connect = async () => {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URL as string);
  }
  // Transactions require a replica set. Fail here with a clear message rather
  // than letting every transactional test fail with a cryptic driver error.
  const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
  if (!hello.setName) {
    throw new Error(
      "Test database is a STANDALONE mongod. MongoDB transactions require a " +
        "replica set, so the transactional code paths cannot be exercised. " +
        "Start mongod with --replSet and run rs.initiate().",
    );
  }
};

export const disconnect = async () => {
  await mongoose.connection.close();
};

/** Truncate every collection between tests, keeping indexes intact. */
export const resetDb = async () => {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
};

/** Ensure schema indexes exist (unique constraints, TTL). */
export const syncIndexes = async () => {
  await Promise.all(
    Object.values(mongoose.models).map((model) =>
      model.syncIndexes().catch(() => undefined),
    ),
  );
};

let phoneCounter = 0;
/** Unique valid E.164 phone per call. */
export const nextPhone = () => `+9199${String(++phoneCounter).padStart(8, "0")}`;

let emailCounter = 0;
export const nextEmail = () => `user${++emailCounter}@example.test`;

export interface TestUser {
  id: string;
  phone: string;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

/**
 * Register a user through the real HTTP surface, including the OTP handshake,
 * so the fixture exercises the same code path a client would.
 */
export const registerUser = async (
  app: Express,
  overrides: Partial<{ name: string; phone: string; email: string; password: string }> = {},
): Promise<TestUser> => {
  const phone = overrides.phone ?? nextPhone();
  const email = overrides.email ?? nextEmail();
  const password = overrides.password ?? "Passw0rd!";
  const name = overrides.name ?? "Test User";

  await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);

  // The plaintext OTP only leaves the server by email, so the fixture reads it
  // from the intercepted mailbox — the same way a real user would.
  const otp = lastOtp(email, "verification");

  await request(app)
    .post("/api/v1/users/verify-otp")
    .send({ email, otp })
    .expect(200);

  const res = await request(app)
    .post("/api/v1/users/register")
    .send({ name, phone, email, password })
    .expect(201);

  return {
    id: res.body.user._id,
    phone,
    email,
    password,
    accessToken: res.body.access_token,
    refreshToken: res.body.refresh_token,
  };
};

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Make two users friends and return the chat id they now share. */
export const befriend = async (
  app: Express,
  a: TestUser,
  b: TestUser,
): Promise<string> => {
  await request(app)
    .post("/api/v1/friends/request")
    .set(auth(a.accessToken))
    .send({ toUserId: b.id })
    .expect(201);

  const pending = await request(app)
    .get("/api/v1/friends/requests")
    .set(auth(b.accessToken))
    .expect(200);

  const requestId = pending.body.incoming[0]._id;

  const accepted = await request(app)
    .post("/api/v1/friends/accept")
    .set(auth(b.accessToken))
    .send({ requestId })
    .expect(200);

  return accepted.body.chatId ?? accepted.body.chat?._id;
};

/** Log in as admin and return the session cookie. */
export const adminCookie = async (app: Express): Promise<string> => {
  const res = await request(app)
    .post("/api/v1/admin/login")
    .send({ secretKey: process.env.ADMIN_SECRET_KEY })
    .expect(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  return cookies.map((c) => c.split(";")[0]).join("; ");
};
