import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { Note, NOTES_PER_OWNER_MAX } from "../src/models/noteModel.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  befriend,
  auth,
  createNote,
  type TestUser,
} from "./helpers.js";

/**
 * Notes CRUD, person labels, listing and search.
 *
 * Alice and Bob are friends; Mallory is a stranger to both. Sharing has its own
 * file (notesSharing.test.ts) — everything here is about a private note and its
 * owner-only label, which must never grant anyone access.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
let bob: TestUser;
let mallory: TestUser;

beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
  bob = await registerUser(app, { name: "Bob" });
  mallory = await registerUser(app, { name: "Mallory" });
  await befriend(app, alice, bob);
});

const NOTES = "/api/v1/notes";
const as = (u: TestUser) => auth(u.accessToken);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("create", () => {
  it("creates a private note with timestamps", async () => {
    const res = await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({ title: "  Groceries ", body: "milk" })
      .expect(201);

    const note = res.body.note;
    expect(note.title).toBe("Groceries");
    expect(note.role).toBe("owner");
    expect(note.version).toBe(1);
    expect(note.owner._id).toBe(alice.id);
    expect(note.lastEditedBy._id).toBe(alice.id);
    expect(note.personLabel).toBeNull();
    expect(note.sharedWith).toBe(0);
    expect(
      Math.abs(Date.parse(note.editedAt) - Date.parse(note.createdAt)),
    ).toBeLessThan(1000);
  });

  it("rejects an empty note", async () => {
    await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({ title: "  ", body: "" })
      .expect(400);
    await request(app).post(NOTES).set(as(alice)).send({}).expect(400);
  });

  it("rejects over-long title and body", async () => {
    await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({ title: "x".repeat(121) })
      .expect(400);
    await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({ title: "ok", body: "x".repeat(20_001) })
      .expect(400);
  });

  it("strips mass-assigned fields", async () => {
    const res = await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({
        title: "x",
        owner: mallory.id,
        shares: [{ user: bob.id, permission: "edit" }],
        version: 99,
        editedAt: "2000-01-01T00:00:00.000Z",
      })
      .expect(201);

    expect(res.body.note.owner._id).toBe(alice.id);
    expect(res.body.note.version).toBe(1);
    expect(res.body.note.sharedWith).toBe(0);
    expect(new Date(res.body.note.editedAt).getUTCFullYear()).toBeGreaterThan(2000);

    const shared = await request(app)
      .get(NOTES)
      .query({ scope: "shared" })
      .set(as(bob))
      .expect(200);
    expect(shared.body.notes).toHaveLength(0);
  });

  it("label must be a friend", async () => {
    await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({ title: "x", personLabel: mallory.id })
      .expect(400);

    const res = await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({ title: "x", personLabel: bob.id })
      .expect(201);
    expect(res.body.note.personLabel._id).toBe(bob.id);
    expect(res.body.note.personLabel.name).toBe("Bob");
  });

  it("enforces the per-owner cap", async () => {
    const owner = new mongoose.Types.ObjectId(alice.id);
    await Note.insertMany(
      Array.from({ length: NOTES_PER_OWNER_MAX }, (_, i) => ({
        owner,
        title: `n${i}`,
        lastEditedBy: owner,
      })),
    );
    await request(app)
      .post(NOTES)
      .set(as(alice))
      .send({ title: "one too many" })
      .expect(400);
  });
});

describe("labels are not sharing", () => {
  it("labelling never shares", async () => {
    const note = await createNote(app, alice, {
      title: "About Bob",
      personLabel: bob.id,
    });

    const list = await request(app).get(NOTES).set(as(bob)).expect(200);
    expect(list.body.notes.map((n: any) => n._id)).not.toContain(note._id);

    await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(404);
    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(bob))
      .send({ body: "hijack", version: 1 })
      .expect(404);

    const stored = await Note.findById(note._id).lean<any>();
    expect(stored.shares).toHaveLength(0);
  });

  it("setting a label does not bump editedAt or version", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await sleep(20);

    const res = await request(app)
      .put(`${NOTES}/${note._id}/label`)
      .set(as(alice))
      .send({ personLabel: bob.id })
      .expect(200);
    expect(res.body.note.personLabel._id).toBe(bob.id);
    expect(res.body.note.editedAt).toBe(note.editedAt);
    expect(res.body.note.version).toBe(note.version);

    const cleared = await request(app)
      .put(`${NOTES}/${note._id}/label`)
      .set(as(alice))
      .send({ personLabel: null })
      .expect(200);
    expect(cleared.body.note.personLabel).toBeNull();
  });

  it("refuses a label that is not a friend", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await request(app)
      .put(`${NOTES}/${note._id}/label`)
      .set(as(alice))
      .send({ personLabel: mallory.id })
      .expect(400);
  });
});

describe("edit", () => {
  it("edit bumps version, editedAt and lastEditedBy", async () => {
    const note = await createNote(app, alice, { title: "x", body: "old" });
    await sleep(20);

    const res = await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(alice))
      .send({ body: "new", version: 1 })
      .expect(200);

    expect(res.body.note.body).toBe("new");
    expect(res.body.note.title).toBe("x");
    expect(res.body.note.version).toBe(2);
    expect(Date.parse(res.body.note.editedAt)).toBeGreaterThan(
      Date.parse(res.body.note.createdAt),
    );
    expect(res.body.note.lastEditedBy._id).toBe(alice.id);
  });

  it("a stale version gets 409 with the latest note", async () => {
    const note = await createNote(app, alice, { title: "x" });

    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(alice))
      .send({ body: "first", version: 1 })
      .expect(200);

    const res = await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(alice))
      .send({ body: "second", version: 1 })
      .expect(409);

    expect(res.body.success).toBe(false);
    expect(res.body.note.version).toBe(2);
    expect(res.body.note.body).toBe("first");
  });

  it("refuses an edit that would empty the note", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(alice))
      .send({ title: " ", body: "", version: 1 })
      .expect(400);
  });

  it("requires a version and some content", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(alice))
      .send({ body: "y" })
      .expect(400);
    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(alice))
      .send({ version: 1 })
      .expect(400);
  });
});

describe("strangers", () => {
  it("strangers get 404 on every route", async () => {
    const note = await createNote(app, alice, { title: "private" });
    const id = note._id;

    const real = await request(app).get(`${NOTES}/${id}`).set(as(mallory)).expect(404);
    const fake = await request(app)
      .get(`${NOTES}/000000000000000000000000`)
      .set(as(mallory))
      .expect(404);
    expect(real.body.message).toBe(fake.body.message);

    await request(app)
      .patch(`${NOTES}/${id}`)
      .set(as(mallory))
      .send({ body: "x", version: 1 })
      .expect(404);
    await request(app)
      .put(`${NOTES}/${id}/label`)
      .set(as(mallory))
      .send({ personLabel: null })
      .expect(404);
    await request(app).delete(`${NOTES}/${id}`).set(as(mallory)).expect(404);

    await request(app).get(`${NOTES}/abc`).set(as(mallory)).expect(400);
  });

  it("requires authentication", async () => {
    await request(app).get(NOTES).expect(401);
    await request(app).post(NOTES).send({ title: "x" }).expect(401);
  });
});

describe("list", () => {
  it("lists newest-edited first, filters by scope and label", async () => {
    const first = await createNote(app, alice, { title: "first" });
    await sleep(5);
    await createNote(app, alice, { title: "second", personLabel: bob.id });
    await sleep(5);
    await createNote(app, alice, { title: "third" });
    await sleep(5);
    await request(app)
      .patch(`${NOTES}/${first._id}`)
      .set(as(alice))
      .send({ body: "edited", version: 1 })
      .expect(200);

    const mine = await request(app)
      .get(NOTES)
      .query({ scope: "mine" })
      .set(as(alice))
      .expect(200);
    expect(mine.body.notes.map((n: any) => n.title)).toEqual([
      "first",
      "third",
      "second",
    ]);
    expect(mine.body.hasMore).toBe(false);
    expect(mine.body.nextCursor).toBeNull();

    const labelled = await request(app)
      .get(NOTES)
      .query({ label: bob.id })
      .set(as(alice))
      .expect(200);
    expect(labelled.body.notes.map((n: any) => n.title)).toEqual(["second"]);

    const unlabelled = await request(app)
      .get(NOTES)
      .query({ label: "none" })
      .set(as(alice))
      .expect(200);
    expect(unlabelled.body.notes).toHaveLength(2);

    await request(app)
      .get(NOTES)
      .query({ scope: "shared", label: bob.id })
      .set(as(alice))
      .expect(400);
  });

  it("paginates ties without skipping", async () => {
    const owner = new mongoose.Types.ObjectId(alice.id);
    const editedAt = new Date("2026-10-10T10:00:00.000Z");
    const inserted = await Note.insertMany(
      Array.from({ length: 25 }, (_, i) => ({
        owner,
        title: `n${i}`,
        lastEditedBy: owner,
        editedAt,
      })),
    );

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await request(app)
        .get(NOTES)
        .query({ scope: "mine", limit: 10, ...(cursor ? { cursor } : {}) })
        .set(as(alice))
        .expect(200);
      seen.push(...res.body.notes.map((n: any) => n._id));
      if (!res.body.hasMore) break;
      cursor = res.body.nextCursor;
    }

    expect(new Set(seen).size).toBe(25);
    expect(seen).toHaveLength(25);
    expect(new Set(seen)).toEqual(new Set(inserted.map((n: any) => String(n._id))));
  });

  const insert25 = () => {
    const owner = new mongoose.Types.ObjectId(alice.id);
    return Note.insertMany(
      Array.from({ length: 25 }, (_, i) => ({
        owner,
        title: `n${i}`,
        lastEditedBy: owner,
      })),
    );
  };

  it("uses the default page size when no limit is sent", async () => {
    await insert25();

    const res = await request(app)
      .get(NOTES)
      .query({ scope: "mine" })
      .set(as(alice))
      .expect(200);

    expect(res.body.notes).toHaveLength(20);
    expect(res.body.hasMore).toBe(true);
    expect(typeof res.body.nextCursor).toBe("string");
    expect(res.body.nextCursor.length).toBeGreaterThan(0);
  });

  it("honours a numeric limit from the query string", async () => {
    await insert25();
    const spy = vi.spyOn(mongoose.Query.prototype, "limit");
    try {
      const res = await request(app)
        .get(NOTES)
        .query({ scope: "mine", limit: 10 })
        .set(as(alice))
        .expect(200);

      expect(res.body.notes).toHaveLength(10);
      expect(res.body.hasMore).toBe(true);
      // limit + 1 must be numeric addition (11), not string concatenation ("101").
      expect(spy).toHaveBeenCalledWith(11);
    } finally {
      spy.mockRestore();
    }
  });

  it("trims the search term", async () => {
    await createNote(app, alice, { title: "Trip (Goa)" });
    await createNote(app, alice, { title: "unrelated" });

    const res = await request(app)
      .get(NOTES)
      .query({ q: "  trip  " })
      .set(as(alice))
      .expect(200);
    expect(res.body.notes).toHaveLength(1);
  });

  it("search is case-insensitive and treats regex characters literally", async () => {
    await createNote(app, alice, { title: "Trip (Goa)" });
    await createNote(app, alice, { title: "x", body: "trip budget" });
    await createNote(app, alice, { title: "unrelated" });

    const q = async (term: string) =>
      (
        await request(app).get(NOTES).query({ q: term }).set(as(alice)).expect(200)
      ).body.notes.length;

    expect(await q("TRIP")).toBe(2);
    expect(await q("(goa)")).toBe(1);
    expect(await q(".*")).toBe(0);

    await request(app)
      .get(NOTES)
      .query({ q: "x".repeat(65) })
      .set(as(alice))
      .expect(400);
  });

  it("list returns a 300-character preview, detail returns the full body", async () => {
    const note = await createNote(app, alice, { title: "long", body: "y".repeat(1000) });

    const list = await request(app).get(NOTES).set(as(alice)).expect(200);
    expect(list.body.notes[0].body).toHaveLength(300);
    expect(list.body.notes[0].bodyTruncated).toBe(true);

    const detail = await request(app).get(`${NOTES}/${note._id}`).set(as(alice)).expect(200);
    expect(detail.body.note.body).toHaveLength(1000);
  });

  it("rejects an invalid scope and limit", async () => {
    await request(app).get(NOTES).query({ scope: "everyone" }).set(as(alice)).expect(400);
    await request(app).get(NOTES).query({ limit: 51 }).set(as(alice)).expect(400);
    await request(app).get(NOTES).query({ label: "nope" }).set(as(alice)).expect(400);
  });
});

describe("labels endpoint", () => {
  it("labels endpoint counts my labels only", async () => {
    await createNote(app, alice, { title: "a", personLabel: bob.id });
    await createNote(app, alice, { title: "b", personLabel: bob.id });
    await createNote(app, alice, { title: "c" });

    const res = await request(app).get(`${NOTES}/labels`).set(as(alice)).expect(200);
    expect(res.body.labels).toHaveLength(1);
    expect(res.body.labels[0].user._id).toBe(bob.id);
    expect(res.body.labels[0].user.name).toBe("Bob");
    expect(res.body.labels[0].count).toBe(2);

    const bobs = await request(app).get(`${NOTES}/labels`).set(as(bob)).expect(200);
    expect(bobs.body.labels).toEqual([]);
  });
});

describe("delete", () => {
  it("owner can delete; the note is gone", async () => {
    const note = await createNote(app, alice, { title: "bye" });
    await request(app).delete(`${NOTES}/${note._id}`).set(as(alice)).expect(200);
    await request(app).get(`${NOTES}/${note._id}`).set(as(alice)).expect(404);
    expect(await Note.countDocuments({})).toBe(0);
  });
});
