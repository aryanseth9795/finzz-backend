import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { Note, NOTE_SHARES_MAX } from "../src/models/noteModel.js";
import { Notification } from "../src/models/notificationModel.js";
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
 * Note sharing: the owner (the note's admin) grants, changes and revokes
 * access; recipients can only read (viewer) or also edit content (editor), and
 * may remove their own access. Bob and Carol are Alice's friends; Mallory is a
 * stranger.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
let mallory: TestUser;

beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
  bob = await registerUser(app, { name: "Bob" });
  carol = await registerUser(app, { name: "Carol" });
  mallory = await registerUser(app, { name: "Mallory" });
  await befriend(app, alice, bob);
  await befriend(app, alice, carol);
});

const NOTES = "/api/v1/notes";
const as = (u: TestUser) => auth(u.accessToken);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const share = (
  owner: TestUser,
  noteId: string,
  shares: { userId: string; permission?: "view" | "edit" }[],
) =>
  request(app).put(`${NOTES}/${noteId}/shares`).set(as(owner)).send({ shares });

const listIds = async (u: TestUser, scope = "all") =>
  (
    await request(app).get(NOTES).query({ scope }).set(as(u)).expect(200)
  ).body.notes.map((n: any) => n._id);

describe("granting access", () => {
  it("sharing puts the note in the recipient's Notes", async () => {
    const note = await createNote(app, alice, { title: "Plan" });
    const res = await share(alice, note._id, [{ userId: bob.id }]).expect(200);
    expect(res.body.note.sharedWith).toBe(1);

    const shared = await request(app)
      .get(NOTES)
      .query({ scope: "shared" })
      .set(as(bob))
      .expect(200);
    expect(shared.body.notes).toHaveLength(1);
    expect(shared.body.notes[0]._id).toBe(note._id);
    expect(shared.body.notes[0].role).toBe("viewer");
    expect(shared.body.notes[0].owner._id).toBe(alice.id);
    expect(shared.body.notes[0].owner.name).toBe("Alice");

    expect(await listIds(carol)).not.toContain(note._id);
    // Shared notes are not the recipient's own.
    expect(await listIds(bob, "mine")).not.toContain(note._id);
  });

  it("notes stay private unless shared", async () => {
    const note = await createNote(app, alice, { title: "Private" });
    expect(await listIds(bob)).not.toContain(note._id);
    await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(404);
  });

  it("only friends can be shared with", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [{ userId: mallory.id }]).expect(400);
    await share(alice, note._id, [{ userId: alice.id }]).expect(400);
    await share(alice, note._id, [{ userId: bob.id }, { userId: bob.id }]).expect(400);
    await share(alice, note._id, []).expect(400);

    // A rejected batch grants nothing, not even its valid members.
    await share(alice, note._id, [{ userId: bob.id }, { userId: mallory.id }]).expect(400);
    const stored = await Note.findById(note._id).lean<any>();
    expect(stored.shares).toHaveLength(0);
  });

  it("changing permission is idempotent and keeps sharedAt", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [{ userId: bob.id }]).expect(200);
    const before = await Note.findById(note._id).lean<any>();
    await sleep(20);

    await share(alice, note._id, [{ userId: bob.id, permission: "edit" }]).expect(200);
    const after = await Note.findById(note._id).lean<any>();

    expect(after.shares).toHaveLength(1);
    expect(after.shares[0].permission).toBe("edit");
    expect(after.shares[0].sharedAt.getTime()).toBe(before.shares[0].sharedAt.getTime());
    expect(after.shares[0].updatedAt.getTime()).toBeGreaterThan(
      before.shares[0].updatedAt.getTime(),
    );
  });

  it("owner sees the share list; recipients cannot", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [
      { userId: bob.id, permission: "edit" },
      { userId: carol.id },
    ]).expect(200);

    const res = await request(app)
      .get(`${NOTES}/${note._id}/shares`)
      .set(as(alice))
      .expect(200);
    const byName = Object.fromEntries(
      res.body.shares.map((s: any) => [s.user.name, s.permission]),
    );
    expect(byName).toEqual({ Bob: "edit", Carol: "view" });
    expect(res.body.shares[0].sharedAt).toBeTruthy();

    await request(app).get(`${NOTES}/${note._id}/shares`).set(as(bob)).expect(403);
    await request(app).get(`${NOTES}/${note._id}/shares`).set(as(mallory)).expect(404);
  });

  it("enforces the 50-share cap", async () => {
    const note = await createNote(app, alice, { title: "x" });
    const now = new Date();
    await Note.updateOne(
      { _id: note._id },
      {
        $set: {
          shares: Array.from({ length: NOTE_SHARES_MAX }, () => ({
            user: new mongoose.Types.ObjectId(),
            permission: "view",
            sharedAt: now,
            updatedAt: now,
          })),
        },
      },
    );

    await share(alice, note._id, [{ userId: bob.id }]).expect(400);
    const stored = await Note.findById(note._id).lean<any>();
    expect(stored.shares).toHaveLength(NOTE_SHARES_MAX);
  });
});

describe("roles", () => {
  it("default permission is view and viewers cannot edit", async () => {
    const note = await createNote(app, alice, { title: "x", body: "orig" });
    await share(alice, note._id, [{ userId: bob.id }]).expect(200);

    await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(200);
    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(bob))
      .send({ body: "changed", version: 1 })
      .expect(403);
    await request(app)
      .put(`${NOTES}/${note._id}/label`)
      .set(as(bob))
      .send({ personLabel: null })
      .expect(403);
    await request(app).delete(`${NOTES}/${note._id}`).set(as(bob)).expect(403);

    const stored = await Note.findById(note._id).lean<any>();
    expect(stored.body).toBe("orig");
  });

  it("editors can edit content but nothing else", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [{ userId: bob.id, permission: "edit" }]).expect(200);

    const edited = await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(bob))
      .send({ body: "from bob", version: 1 })
      .expect(200);
    expect(edited.body.note.lastEditedBy._id).toBe(bob.id);
    expect(edited.body.note.lastEditedBy.name).toBe("Bob");
    expect(edited.body.note.role).toBe("editor");

    await request(app)
      .put(`${NOTES}/${note._id}/label`)
      .set(as(bob))
      .send({ personLabel: alice.id })
      .expect(403);
    await request(app).get(`${NOTES}/${note._id}/shares`).set(as(bob)).expect(403);
    await share(bob, note._id, [{ userId: alice.id }]).expect(403);
    await request(app).delete(`${NOTES}/${note._id}/shares`).set(as(bob)).expect(403);
    await request(app).delete(`${NOTES}/${note._id}`).set(as(bob)).expect(403);
  });

  it("recipients never see the label or the share list", async () => {
    const note = await createNote(app, alice, { title: "x", personLabel: carol.id });
    await share(alice, note._id, [
      { userId: bob.id, permission: "edit" },
      { userId: carol.id },
    ]).expect(200);

    const detail = await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(200);
    const list = await request(app).get(NOTES).set(as(bob)).expect(200);
    const patched = await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(bob))
      .send({ body: "y", version: 1 })
      .expect(200);

    for (const dto of [detail.body.note, list.body.notes[0], patched.body.note]) {
      expect("personLabel" in dto).toBe(false);
      expect("sharedWith" in dto).toBe(false);
      expect("shares" in dto).toBe(false);
      expect(dto.sharedAt).toBeTruthy();
    }
    expect(JSON.stringify(detail.body)).not.toContain(carol.id);

    const owner = await request(app).get(`${NOTES}/${note._id}`).set(as(alice)).expect(200);
    expect(owner.body.note.sharedWith).toBe(2);
    expect(owner.body.note.personLabel._id).toBe(carol.id);
  });

  it("a recipient's label filter never matches shared notes", async () => {
    const note = await createNote(app, alice, { title: "x", personLabel: bob.id });
    await share(alice, note._id, [{ userId: bob.id }]).expect(200);

    const res = await request(app)
      .get(NOTES)
      .query({ label: "none" })
      .set(as(bob))
      .expect(200);
    expect(res.body.notes).toHaveLength(0);
  });
});

describe("revoking access", () => {
  it("owner revokes one recipient", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [{ userId: bob.id }, { userId: carol.id }]).expect(200);

    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${bob.id}`)
      .set(as(alice))
      .expect(200);

    await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(404);
    expect(await listIds(bob)).toEqual([]);
    await request(app).get(`${NOTES}/${note._id}`).set(as(carol)).expect(200);

    // Revoking someone who has no access is a 404, not a silent success.
    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${bob.id}`)
      .set(as(alice))
      .expect(404);
  });

  it("owner makes the note private again", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [{ userId: bob.id }, { userId: carol.id }]).expect(200);

    const res = await request(app)
      .delete(`${NOTES}/${note._id}/shares`)
      .set(as(alice))
      .expect(200);
    expect(res.body.note.sharedWith).toBe(0);

    await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(404);
    await request(app).get(`${NOTES}/${note._id}`).set(as(carol)).expect(404);
  });

  it("a recipient can leave but cannot remove others", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [{ userId: bob.id }, { userId: carol.id }]).expect(200);

    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${carol.id}`)
      .set(as(bob))
      .expect(403);
    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${bob.id}`)
      .set(as(bob))
      .expect(200);
    await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(404);
    await request(app).get(`${NOTES}/${note._id}`).set(as(carol)).expect(200);

    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${alice.id}`)
      .set(as(alice))
      .expect(400);
  });

  it("a save from a downgraded editor is refused even with a fresh version", async () => {
    const note = await createNote(app, alice, { title: "x", body: "orig" });
    await share(alice, note._id, [{ userId: bob.id, permission: "edit" }]).expect(200);

    const fresh = await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(200);
    await share(alice, note._id, [{ userId: bob.id, permission: "view" }]).expect(200);

    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(bob))
      .send({ body: "too late", version: fresh.body.note.version })
      .expect(403);

    const stored = await Note.findById(note._id).lean<any>();
    expect(stored.body).toBe("orig");
  });

  it("a save from a revoked editor is refused", async () => {
    const note = await createNote(app, alice, { title: "x", body: "orig" });
    await share(alice, note._id, [{ userId: bob.id, permission: "edit" }]).expect(200);
    const fresh = await request(app).get(`${NOTES}/${note._id}`).set(as(bob)).expect(200);

    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${bob.id}`)
      .set(as(alice))
      .expect(200);

    await request(app)
      .patch(`${NOTES}/${note._id}`)
      .set(as(bob))
      .send({ body: "too late", version: fresh.body.note.version })
      .expect(404);
    expect((await Note.findById(note._id).lean<any>()).body).toBe("orig");
  });

  it("share and label changes don't bump editedAt", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await sleep(20);
    await share(alice, note._id, [{ userId: bob.id }]).expect(200);
    await share(alice, note._id, [{ userId: bob.id, permission: "edit" }]).expect(200);
    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${bob.id}`)
      .set(as(alice))
      .expect(200);

    const res = await request(app).get(`${NOTES}/${note._id}`).set(as(alice)).expect(200);
    expect(res.body.note.editedAt).toBe(note.editedAt);
    expect(res.body.note.version).toBe(note.version);
  });

  it("deleting a shared note removes it for every recipient", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await share(alice, note._id, [{ userId: bob.id }, { userId: carol.id }]).expect(200);
    await request(app).delete(`${NOTES}/${note._id}`).set(as(alice)).expect(200);
    expect(await listIds(bob)).toEqual([]);
    expect(await listIds(carol)).toEqual([]);
  });
});

describe("notifications", () => {
  it("push for a new share carries no note content", async () => {
    const note = await createNote(app, alice, { title: "Secret plan", body: "the details" });
    await share(alice, note._id, [{ userId: bob.id }]).expect(200);

    const docs = await Notification.find({ recipient: bob.id, type: "note_shared" }).lean<any[]>();
    expect(docs).toHaveLength(1);
    expect(docs[0].title).toBe("New shared note");
    expect(docs[0].body).toBe("Alice shared a note with you");
    expect(docs[0].data.noteId).toBe(note._id);
    expect(String(docs[0].sender)).toBe(alice.id);
    expect(JSON.stringify(docs[0])).not.toContain("Secret plan");
    expect(JSON.stringify(docs[0])).not.toContain("the details");

    // A permission change is silent.
    await share(alice, note._id, [{ userId: bob.id, permission: "edit" }]).expect(200);
    expect(
      await Notification.countDocuments({ recipient: bob.id, type: "note_shared" }),
    ).toBe(1);

    // Revoking is silent too.
    await request(app)
      .delete(`${NOTES}/${note._id}/shares/${bob.id}`)
      .set(as(alice))
      .expect(200);
    // (Bob also holds the fixture's friend_request notification.)
    expect(
      await Notification.countDocuments({ recipient: bob.id, type: /^note_/ }),
    ).toBe(1);
  });
});
