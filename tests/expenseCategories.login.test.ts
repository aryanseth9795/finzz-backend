import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox, lastOtp } from "./mailbox.js";
import app from "../src/app.js";
import { User } from "../src/models/userModel.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  nextPhone,
  nextEmail,
} from "./helpers.js";

/**
 * The category version on the login and registration replies. A fresh sign-in
 * doesn't go through the launch Profile call, so the app syncs its saved list
 * from this reply instead. A brand-new account at 0 then costs no list request.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  clearMailbox();
});

const login = (phone: string, password: string) =>
  request(app).post("/api/v1/users/login").send({ phone, password }).expect(200);

describe("the version on the login and registration replies", () => {
  it("registration replies with version 0", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);
    await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp: lastOtp(email, "verification") })
      .expect(200);

    const res = await request(app)
      .post("/api/v1/users/register")
      .send({ name: "Alice", phone: nextPhone(), email, password: "Passw0rd!" })
      .expect(201);

    expect(res.body.user.expenseCategoriesVersion).toBe(0);
  });

  it("login replies with the account's version", async () => {
    const user = await registerUser(app);
    await User.updateOne({ _id: user.id }, { $set: { expenseCategoriesVersion: 4 } });

    const res = await login(user.phone, user.password);
    expect(res.body.user.expenseCategoriesVersion).toBe(4);
  });

  it("an account older than the feature has no version on its login reply", async () => {
    const user = await registerUser(app);
    await User.updateOne({ _id: user.id }, { $unset: { expenseCategoriesVersion: "" } });

    const res = await login(user.phone, user.password);
    expect(res.body.user).not.toHaveProperty("expenseCategoriesVersion");
  });
});
