import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox, lastOtp, mailCount } from "./mailbox.js";
import app from "../src/app.js";
import { connect, disconnect, resetDb, syncIndexes, registerUser } from "./helpers.js";
import { User } from "../src/models/userModel.js";
import { maskEmail } from "../src/utils/maskEmail.js";

/**
 * Forgot password by phone: the user gives only the number they log in with;
 * the server finds the account's email and sends the OTP there.
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

describe("maskEmail", () => {
  it("keeps two characters at each end of the local part", () => {
    expect(maskEmail("aryan.seth51@gmail.com")).toBe("ar********51@gmail.com");
  });
  it("masks short local parts more heavily", () => {
    expect(maskEmail("abcd@x.io")).toBe("a***@x.io");
    expect(maskEmail("ab@x.io")).toBe("a*@x.io");
    expect(maskEmail("a@x.io")).toBe("*@x.io");
  });
});

describe("POST /users/forgot-password { phone }", () => {
  it("sends the OTP to the account's email and returns it masked", async () => {
    const user = await registerUser(app);
    clearMailbox();
    const res = await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ phone: user.phone })
      .expect(200);
    expect(res.body.maskedEmail).toBe(maskEmail(user.email));
    expect(mailCount(user.email)).toBe(1);
    expect(lastOtp(user.email, "reset")).toMatch(/^\d{6}$/);
  });

  it("finds a legacy 10-digit account from the +91 form", async () => {
    await User.create({
      name: "Legacy",
      phone: "9876500001",
      password: "Passw0rd!",
      email: "legacy.user@example.test",
      emailVerified: true,
    });
    await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ phone: "+919876500001" })
      .expect(200);
    expect(mailCount("legacy.user@example.test")).toBe(1);
  });

  it("explains when the account has no email, and sends nothing", async () => {
    await User.create({ name: "NoMail", phone: "9876500002", password: "Passw0rd!" });
    const res = await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ phone: "9876500002" })
      .expect(400);
    expect(res.body.message).toMatch(/no email is linked/i);
  });

  it("no longer accepts an email", async () => {
    const user = await registerUser(app);
    clearMailbox();
    await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ email: user.email })
      .expect(400);
    expect(mailCount(user.email)).toBe(0);
  });
});

describe("POST /users/reset-password { phone, otp, newPassword }", () => {
  it("resets using the OTP sent to the account's email", async () => {
    const user = await registerUser(app);
    clearMailbox();
    await request(app).post("/api/v1/users/forgot-password").send({ phone: user.phone }).expect(200);
    await request(app)
      .post("/api/v1/users/reset-password")
      .send({ phone: user.phone, otp: lastOtp(user.email, "reset"), newPassword: "BrandNew123" })
      .expect(200);
    await request(app)
      .post("/api/v1/users/login")
      .send({ phone: user.phone, password: "BrandNew123" })
      .expect(200);
  });

  it("rejects a wrong OTP", async () => {
    const user = await registerUser(app);
    await request(app).post("/api/v1/users/forgot-password").send({ phone: user.phone }).expect(200);
    await request(app)
      .post("/api/v1/users/reset-password")
      .send({ phone: user.phone, otp: "000000", newPassword: "BrandNew123" })
      .expect(400);
  });

  it("no longer accepts an email", async () => {
    const user = await registerUser(app);
    await request(app)
      .post("/api/v1/users/reset-password")
      .send({ email: user.email, otp: "123456", newPassword: "BrandNew123" })
      .expect(400);
  });
});
