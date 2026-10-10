import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import "./mailbox.js";
import { clearMailbox, lastOtp, mailbox, mailCount } from "./mailbox.js";
import app from "../src/app.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  nextEmail,
  nextPhone,
  auth,
} from "./helpers.js";
import { User } from "../src/models/userModel.js";
import { OtpRequest } from "../src/models/otpModel.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  clearMailbox();
});

describe("BE-004 — OTP generation", () => {
  it("always produces exactly six digits", async () => {
    // `Math.floor(100000 + Math.random() * 900000)` could never emit a code
    // below 100000, shrinking the keyspace. crypto.randomInt + padStart can.
    for (let i = 0; i < 25; i++) {
      const email = nextEmail();
      await request(app)
        .post("/api/v1/users/send-otp")
        .send({ email })
        .expect(200);
      expect(lastOtp(email)).toMatch(/^\d{6}$/);
    }
  });

  it("does not repeat codes across requests", async () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const email = nextEmail();
      await request(app).post("/api/v1/users/send-otp").send({ email });
      codes.add(lastOtp(email));
    }
    // A collision or two is statistically possible; a low-entropy generator
    // would show far heavier clustering than this.
    expect(codes.size).toBeGreaterThanOrEqual(18);
  });

  it("stores only a hash, never the plaintext code", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);

    const otp = lastOtp(email);
    const doc = await OtpRequest.findOne({ email }).lean();

    expect(doc!.otpHash).not.toBe(otp);
    expect(doc!.otpHash).toMatch(/^\$2[aby]\$/); // bcrypt
    expect(JSON.stringify(doc)).not.toContain(otp);
  });
});

describe("BE-005 — the missing attempt counter", () => {
  it("destroys the code after five wrong guesses", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);
    const real = lastOtp(email);
    const wrong = real === "000000" ? "111111" : "000000";

    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/v1/users/verify-otp")
        .send({ email, otp: wrong })
        .expect(400);
    }

    // Sixth attempt is refused outright…
    const blocked = await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp: wrong });
    expect([400, 429]).toContain(blocked.status);

    // …and the CORRECT code no longer works either, because the code is gone.
    // Without this, unlimited guesses against a 10^6 space was an online
    // account-takeover primitive.
    await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp: real })
      .expect(400);
  });

  it("counts down remaining attempts in the message", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);
    const wrong = lastOtp(email) === "000000" ? "111111" : "000000";

    const res = await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp: wrong })
      .expect(400);

    expect(res.body.message).toMatch(/attempt\(s\) remaining/);
  });

  it("resets the counter when a new code is issued", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email });
    const wrong = "000000";
    for (let i = 0; i < 3; i++) {
      await request(app).post("/api/v1/users/verify-otp").send({ email, otp: wrong });
    }

    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);
    const doc = await OtpRequest.findOne({ email }).lean();
    expect(doc!.attempts).toBe(0);

    await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp: lastOtp(email) })
      .expect(200);
  });
});

describe("BE-033 — sentinel users are gone", () => {
  it("does not create a User row when an OTP is requested", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);

    // `sendOtp` used to create a real User with phone "pending_<email>_otp",
    // name "__pending__" and the OTP hash as the password — fake accounts that
    // appeared in the admin user list and every user count.
    expect(await User.countDocuments()).toBe(0);
    expect(await User.countDocuments({ name: "__pending__" })).toBe(0);
    expect(await OtpRequest.countDocuments({ email })).toBe(1);
  });

  it("leaves nothing behind when registration fails after verification", async () => {
    const taken = await registerUser(app);
    const email = nextEmail();

    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);
    await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp: lastOtp(email) })
      .expect(200);

    // Register with an ALREADY-TAKEN phone: must fail cleanly.
    await request(app)
      .post("/api/v1/users/register")
      .send({
        name: "Someone",
        phone: taken.phone,
        email,
        password: "Passw0rd!",
      })
      .expect(400);

    // Previously this stranded a verified sentinel account holding the email,
    // which the user could never recover or reuse.
    expect(await User.countDocuments({ email })).toBe(0);

    // The user can retry with a different phone and succeed.
    await request(app)
      .post("/api/v1/users/register")
      .send({
        name: "Someone",
        phone: nextPhone(),
        email,
        password: "Passw0rd!",
      })
      .expect(201);
  });

  it("keeps one live code per email and purpose", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email });
    await request(app).post("/api/v1/users/send-otp").send({ email });
    await request(app).post("/api/v1/users/send-otp").send({ email });

    // Requesting a new code invalidates the previous one, so several valid
    // codes are never in flight at once.
    expect(await OtpRequest.countDocuments({ email, purpose: "verification" })).toBe(1);

    const stale = mailbox[0].otp;
    const fresh = mailbox[mailbox.length - 1].otp;
    if (stale !== fresh) {
      await request(app)
        .post("/api/v1/users/verify-otp")
        .send({ email, otp: stale })
        .expect(400);
    }
    await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp: fresh })
      .expect(200);
  });
});

describe("Registration requires a verified email", () => {
  it("refuses registration when the OTP was never verified", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);

    await request(app)
      .post("/api/v1/users/register")
      .send({ name: "X", phone: nextPhone(), email, password: "Passw0rd!" })
      .expect(400);
  });

  it("refuses registration with no OTP request at all", async () => {
    await request(app)
      .post("/api/v1/users/register")
      .send({
        name: "X",
        phone: nextPhone(),
        email: nextEmail(),
        password: "Passw0rd!",
      })
      .expect(400);
  });
});

describe("BE-032 / BE-034 — password reset", () => {
  it("reports an unknown phone and emails nothing", async () => {
    const res = await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ phone: nextPhone() })
      .expect(404);
    expect(res.body.message).toBe("No account found with this number.");
  });

  it("completes a reset and invalidates the old password", async () => {
    const user = await registerUser(app);
    clearMailbox();

    await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ phone: user.phone })
      .expect(200);

    await request(app)
      .post("/api/v1/users/reset-password")
      .send({
        phone: user.phone,
        otp: lastOtp(user.email, "reset"),
        newPassword: "BrandNewPassw0rd!",
      })
      .expect(200);

    await request(app)
      .post("/api/v1/users/login")
      .send({ phone: user.phone, password: user.password })
      .expect(401);

    await request(app)
      .post("/api/v1/users/login")
      .send({ phone: user.phone, password: "BrandNewPassw0rd!" })
      .expect(200);
  });

  it("revokes existing sessions on reset", async () => {
    const user = await registerUser(app);
    clearMailbox();

    await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ phone: user.phone })
      .expect(200);
    await request(app)
      .post("/api/v1/users/reset-password")
      .send({
        phone: user.phone,
        otp: lastOtp(user.email, "reset"),
        newPassword: "BrandNewPassw0rd!",
      })
      .expect(200);

    // A reset exists to lock an attacker out; a surviving 30-day refresh token
    // would defeat it entirely.
    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(user.refreshToken))
      .expect(401);
  });

  it("does not accept a verification code as a reset code", async () => {
    const user = await registerUser(app);
    clearMailbox();

    // Issue a VERIFICATION code…
    await request(app)
      .post("/api/v1/users/send-otp")
      .send({ email: user.email })
      .expect(200);
    const verificationCode = lastOtp(user.email, "verification");

    // …and try to spend it on a password reset.
    await request(app)
      .post("/api/v1/users/reset-password")
      .send({
        phone: user.phone,
        otp: verificationCode,
        newPassword: "BrandNewPassw0rd!",
      })
      .expect(400);
  });
});

describe("OTP expiry is enforced by the database", () => {
  it("declares a TTL index on expiresAt", async () => {
    const indexes = await mongoose.connection
      .db!.collection("otprequests")
      .indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl!.key).toEqual({ expiresAt: 1 });
  });

  it("refuses an expired code", async () => {
    const email = nextEmail();
    await request(app).post("/api/v1/users/send-otp").send({ email }).expect(200);
    const otp = lastOtp(email);

    await OtpRequest.updateOne(
      { email },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );

    await request(app)
      .post("/api/v1/users/verify-otp")
      .send({ email, otp })
      .expect(400);
  });
});
