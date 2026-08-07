import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  auth,
  nextPhone,
  nextEmail,
} from "./helpers.js";
import { User } from "../src/models/userModel.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(async () => {
  await resetDb();
  clearMailbox();
});

const SECRET = process.env.JWT_SECRET as string;

describe("BE-001/BE-002 — admin token no longer carries the secret", () => {
  it("issues a token whose payload contains no secret and does expire", async () => {
    const res = await request(app)
      .post("/api/v1/admin/login")
      .send({ secretKey: process.env.ADMIN_SECRET_KEY })
      .expect(200);

    // Regression: the token must NOT be returned in the response body, which
    // defeated the httpOnly cookie it is set as.
    expect(res.body.token).toBeUndefined();

    const cookie = (res.headers["set-cookie"] as unknown as string[])[0];
    const token = cookie.split("=")[1].split(";")[0];
    const payload = jwt.decode(token) as Record<string, unknown>;

    // The whole bug: `jwt.sign(adminSecretKey, JWT_SECRET)` put the master key
    // in a base64url payload anyone holding the token could read.
    expect(JSON.stringify(payload)).not.toContain(process.env.ADMIN_SECRET_KEY);
    expect(payload.role).toBe("admin");
    expect(payload.type).toBe("admin");
    expect(payload.exp).toBeTypeOf("number");
  });

  it("rejects a wrong secret key", async () => {
    await request(app)
      .post("/api/v1/admin/login")
      .send({ secretKey: "not-the-key" })
      .expect(401);
  });

  it("refuses an admin route when the cookie is absent", async () => {
    await request(app).get("/api/v1/admin/dashboard").expect(401);
  });
});

describe("X-2 — token type claims", () => {
  it("refuses a refresh token used as an access token", async () => {
    const user = await registerUser(app);

    await request(app)
      .get("/api/v1/users/profile")
      .set(auth(user.refreshToken))
      .expect(401);

    // …while the access token works, proving the rejection is about type.
    await request(app)
      .get("/api/v1/users/profile")
      .set(auth(user.accessToken))
      .expect(200);
  });

  it("refuses an access token used to mint new credentials", async () => {
    const user = await registerUser(app);

    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(user.accessToken))
      .expect(401);
  });

  it("accepts a legacy type-less token as an access token (agreed grace period)", async () => {
    const user = await registerUser(app);
    // Exactly what the pre-fix code minted: no `type`, no distinction.
    const legacy = jwt.sign({ id: user.id }, SECRET, { expiresIn: "2d" });

    await request(app)
      .get("/api/v1/users/profile")
      .set(auth(legacy))
      .expect(200);
  });

  it("does NOT let a legacy token mint new credentials — the grace period cannot escalate", async () => {
    const user = await registerUser(app);
    const legacy = jwt.sign({ id: user.id }, SECRET, { expiresIn: "30d" });

    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(legacy))
      .expect(401);
  });

  it("refuses a token signed with a different secret", async () => {
    const forged = jwt.sign({ id: "x", type: "access" }, "wrong-secret-value");
    await request(app)
      .get("/api/v1/users/profile")
      .set(auth(forged))
      .expect(401);
  });
});

describe("BE-036 — multi-device refresh with rotation and revocation", () => {
  it("keeps both devices signed in after a second login", async () => {
    const user = await registerUser(app);

    const second = await request(app)
      .post("/api/v1/users/login")
      .send({ phone: user.phone, password: user.password })
      .expect(200);

    // The old single `refreshToken` string was overwritten on every login, so
    // signing in on a phone silently signed you out on a tablet.
    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(user.refreshToken))
      .expect(200);

    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(second.body.refresh_token))
      .expect(200);
  });

  it("rotates the refresh token and refuses to replay the consumed one", async () => {
    const user = await registerUser(app);

    const first = await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(user.refreshToken))
      .expect(200);

    expect(first.body.refresh_token).not.toBe(user.refreshToken);

    // Replaying the spent token must fail even though its signature is valid.
    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(user.refreshToken))
      .expect(401);

    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(first.body.refresh_token))
      .expect(200);
  });

  it("stores refresh tokens as hashes, never in plaintext", async () => {
    const user = await registerUser(app);
    const doc = await User.findById(user.id).select("+refreshTokens").lean();
    const grants = (doc as unknown as { refreshTokens: { tokenHash: string }[] })
      .refreshTokens;

    expect(grants).toHaveLength(1);
    expect(grants[0].tokenHash).not.toBe(user.refreshToken);
    expect(grants[0].tokenHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it("revokes only the calling device on logout", async () => {
    const user = await registerUser(app);
    const second = await request(app)
      .post("/api/v1/users/login")
      .send({ phone: user.phone, password: user.password })
      .expect(200);

    await request(app)
      .post("/api/v1/users/logout")
      .set(auth(user.accessToken))
      .send({ refreshToken: user.refreshToken })
      .expect(200);

    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(user.refreshToken))
      .expect(401);

    // The other device is untouched.
    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(second.body.refresh_token))
      .expect(200);
  });
});

describe("BE-034 — password changes revoke other sessions", () => {
  it("invalidates every refresh token after a password change", async () => {
    const user = await registerUser(app);
    const other = await request(app)
      .post("/api/v1/users/login")
      .send({ phone: user.phone, password: user.password })
      .expect(200);

    await request(app)
      .post("/api/v1/users/change-password")
      .set(auth(user.accessToken))
      .send({ oldPassword: user.password, newPassword: "NewPassw0rd!" })
      .expect(200);

    // A password change exists to lock someone out; a surviving 30-day refresh
    // token would defeat that entirely.
    await request(app)
      .post("/api/v1/users/refresh")
      .set(auth(other.body.refresh_token))
      .expect(401);
  });

  it("rejects a new password identical to the current one", async () => {
    const user = await registerUser(app);
    await request(app)
      .post("/api/v1/users/change-password")
      .set(auth(user.accessToken))
      .send({ oldPassword: user.password, newPassword: user.password })
      .expect(400);
  });
});

describe("BE-032 — user enumeration", () => {
  it("returns the same error for an unknown phone and a wrong password", async () => {
    const user = await registerUser(app);

    const unknown = await request(app)
      .post("/api/v1/users/login")
      .send({ phone: nextPhone(), password: "Passw0rd!" })
      .expect(401);

    const wrongPassword = await request(app)
      .post("/api/v1/users/login")
      .send({ phone: user.phone, password: "WrongPassw0rd!" })
      .expect(401);

    // Previously "User not found" (404) vs "Invalid credentials" (401) told an
    // attacker which phone numbers had accounts.
    expect(unknown.body.message).toBe(wrongPassword.body.message);
    expect(unknown.status).toBe(wrongPassword.status);
  });

  it("answers forgot-password identically for known and unknown addresses", async () => {
    const user = await registerUser(app);

    const known = await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ email: user.email })
      .expect(200);

    const unknown = await request(app)
      .post("/api/v1/users/forgot-password")
      .send({ email: nextEmail() })
      .expect(200);

    expect(known.body.message).toBe(unknown.body.message);
  });
});

describe("BE-062 — secrets never appear in responses", () => {
  it("omits password, otp and token records from the profile", async () => {
    const user = await registerUser(app);
    const res = await request(app)
      .get("/api/v1/users/profile")
      .set(auth(user.accessToken))
      .expect(200);

    for (const field of [
      "password",
      "otp",
      "otpExpiry",
      "otpAttempts",
      "refreshToken",
      "refreshTokens",
    ]) {
      expect(res.body.user[field]).toBeUndefined();
    }
  });
});
