import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import app from "../src/app.js";
import { connect, disconnect, resetDb, syncIndexes, adminCookie } from "./helpers.js";
import { compareVersions, isValidVersion } from "../src/utils/semver.js";

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);
beforeEach(resetDb);

const valid = {
  latestVersion: "1.1.0",
  minSupportedVersion: "1.1.0",
  apkUrl: "https://github.com/x/finzz/releases/download/v1.1.0/finzz.apk",
  releaseNotes: "Vault and fixes",
};

describe("semver", () => {
  it("compares numerically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1", "1.0.2")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });
  it("validates format", () => {
    expect(isValidVersion("1.2.3")).toBe(true);
    expect(isValidVersion("1.2")).toBe(false);
    expect(isValidVersion("v1.2.3")).toBe(false);
  });
});

describe("GET /api/v1/app/version", () => {
  it("returns the zero release when none is set", async () => {
    const res = await request(app).get("/api/v1/app/version").expect(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body.release).toMatchObject({
      latestVersion: "0.0.0",
      minSupportedVersion: "0.0.0",
      apkUrl: "",
      releaseNotes: "",
    });
  });
});

describe("/api/v1/admin/app-release", () => {
  it("rejects unauthenticated writes", async () => {
    const res = await request(app).put("/api/v1/admin/app-release").send(valid);
    expect([401, 403]).toContain(res.status);
  });

  it("rejects bad semver, http URL, and min > latest", async () => {
    const cookie = await adminCookie(app);
    const bad = [
      { ...valid, latestVersion: "1.1" },
      { ...valid, apkUrl: "http://example.com/a.apk" },
      { ...valid, minSupportedVersion: "1.2.0" },
    ];
    for (const body of bad) {
      await request(app)
        .put("/api/v1/admin/app-release")
        .set("Cookie", cookie)
        .send(body)
        .expect(400);
    }
  });

  it("saves (trimming versions) and serves publicly", async () => {
    const cookie = await adminCookie(app);
    await request(app)
      .put("/api/v1/admin/app-release")
      .set("Cookie", cookie)
      .send({ ...valid, latestVersion: " 1.1.0 " })
      .expect(200);

    const pub = await request(app).get("/api/v1/app/version").expect(200);
    expect(pub.body.release).toMatchObject(valid);

    const adm = await request(app)
      .get("/api/v1/admin/app-release")
      .set("Cookie", cookie)
      .expect(200);
    expect(adm.body.release).toMatchObject(valid);
  });

  it("updates the singleton instead of inserting a second document", async () => {
    const cookie = await adminCookie(app);
    await request(app).put("/api/v1/admin/app-release").set("Cookie", cookie).send(valid).expect(200);
    await request(app)
      .put("/api/v1/admin/app-release")
      .set("Cookie", cookie)
      .send({ ...valid, latestVersion: "1.2.0" })
      .expect(200);
    const pub = await request(app).get("/api/v1/app/version").expect(200);
    expect(pub.body.release.latestVersion).toBe("1.2.0");
  });
});
