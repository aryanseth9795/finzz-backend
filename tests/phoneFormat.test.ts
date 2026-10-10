import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { connect, disconnect, resetDb, syncIndexes, registerUser, auth } from "./helpers.js";
import { User } from "../src/models/userModel.js";
import { phoneVariants } from "../src/utils/phone.js";

/**
 * Regression: every production account stores its phone as 10 bare digits
 * ("9795785251"), but the app — since it began normalising to E.164 — sends
 * "+919795785251". The server matched phones exactly, so nobody could log in.
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

const LEGACY_PHONE = "9876500001";
const PASSWORD = "Passw0rd!";

/** A user exactly as legacy accounts exist in production: 10-digit phone. */
const createLegacyUser = () =>
  User.create({
    name: "Legacy",
    phone: LEGACY_PHONE,
    password: PASSWORD,
    email: "legacy@example.test",
    emailVerified: true,
  });

describe("phoneVariants", () => {
  it("maps every Indian format to the same candidates", () => {
    const expected = ["9876500001", "+919876500001", "919876500001"].sort();
    expect(phoneVariants("9876500001").sort()).toEqual(expected);
    expect(phoneVariants("+919876500001").sort()).toEqual(expected);
    expect(phoneVariants("919876500001").sort()).toEqual(expected);
    expect(phoneVariants(" +91 98765-00001 ").sort()).toEqual(expected);
  });

  it("leaves non-Indian numbers alone", () => {
    expect(phoneVariants("+14155550123")).toEqual(["+14155550123"]);
  });
});

describe("login with legacy 10-digit accounts", () => {
  it("accepts the E.164 form the current app sends", async () => {
    await createLegacyUser();
    const res = await request(app)
      .post("/api/v1/users/login")
      .send({ phone: `+91${LEGACY_PHONE}`, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });

  it("still accepts the bare 10-digit form older builds send", async () => {
    await createLegacyUser();
    await request(app)
      .post("/api/v1/users/login")
      .send({ phone: LEGACY_PHONE, password: PASSWORD })
      .expect(200);
  });

  it("still rejects a wrong password", async () => {
    await createLegacyUser();
    await request(app)
      .post("/api/v1/users/login")
      .send({ phone: `+91${LEGACY_PHONE}`, password: "wrong-pass" })
      .expect(401);
  });
});

describe("other phone lookups", () => {
  it("register refuses a phone that exists in another format", async () => {
    await createLegacyUser();
    await expect(registerUser(app, { phone: `+91${LEGACY_PHONE}` })).rejects.toThrow();
    expect(await User.countDocuments({})).toBe(1);
  });

  it("friend search finds a legacy user by the E.164 form", async () => {
    const legacy = await createLegacyUser();
    const me = await registerUser(app);
    const res = await request(app)
      .post("/api/v1/friends/search")
      .set(auth(me.accessToken))
      .send({ phone: `+91${LEGACY_PHONE}` })
      .expect(200);
    expect(res.body.exists).toBe(true);
    expect(String(res.body.user._id)).toBe(String(legacy._id));
  });

  it("contact check marks a legacy user as registered in any format", async () => {
    await createLegacyUser();
    const me = await registerUser(app);
    const res = await request(app)
      .post("/api/v1/friends/check-contacts")
      .set(auth(me.accessToken))
      .send({ phoneNumbers: [`+91${LEGACY_PHONE}`, "+919999999999"] })
      .expect(200);
    expect(res.body.registered).toHaveLength(1);
    expect(res.body.unregistered).toEqual(["+919999999999"]);
  });
});
