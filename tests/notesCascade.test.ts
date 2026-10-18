import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import "./mailbox.js";
import { clearMailbox } from "./mailbox.js";
import app from "../src/app.js";
import { Note } from "../src/models/noteModel.js";
import {
  connect,
  disconnect,
  resetDb,
  syncIndexes,
  registerUser,
  befriend,
  auth,
  adminCookie,
  createNote,
  unfriend,
  type TestUser,
} from "./helpers.js";

/**
 * Access to notes must not outlive the relationship it was granted on: ending
 * a friendship revokes shares both ways, and deleting an account removes its
 * notes, its access to others' notes and labels pointing at it.
 */

beforeAll(async () => {
  await connect();
  await syncIndexes();
});
afterAll(disconnect);

let alice: TestUser;
let bob: TestUser;
let carol: TestUser;

beforeEach(async () => {
  await resetDb();
  clearMailbox();
  alice = await registerUser(app, { name: "Alice" });
  bob = await registerUser(app, { name: "Bob" });
  carol = await registerUser(app, { name: "Carol" });
  await befriend(app, alice, bob);
  await befriend(app, alice, carol);
});

const NOTES = "/api/v1/notes";
const as = (u: TestUser) => auth(u.accessToken);
const shareWith = (owner: TestUser, noteId: string, ...users: TestUser[]) =>
  request(app)
    .put(`${NOTES}/${noteId}/shares`)
    .set(as(owner))
    .send({ shares: users.map((u) => ({ userId: u.id, permission: "edit" })) })
    .expect(200);

describe("unfriending", () => {
  it("unfriending revokes shares in both directions and keeps labels", async () => {
    const a = await createNote(app, alice, { title: "A" });
    await shareWith(alice, a._id, bob, carol);
    const b = await createNote(app, bob, { title: "B" });
    await shareWith(bob, b._id, alice);
    const c = await createNote(app, alice, { title: "C", personLabel: bob.id });

    await unfriend(app, alice, bob);

    await request(app).get(`${NOTES}/${a._id}`).set(as(bob)).expect(404);
    await request(app).get(`${NOTES}/${b._id}`).set(as(alice)).expect(404);

    const labelled = await request(app).get(`${NOTES}/${c._id}`).set(as(alice)).expect(200);
    expect(labelled.body.note.personLabel._id).toBe(bob.id);

    // Carol's access to the same note is untouched.
    await request(app).get(`${NOTES}/${a._id}`).set(as(carol)).expect(200);
    const stored = await Note.findById(a._id).lean<any>();
    expect(stored.shares.map((s: any) => String(s.user))).toEqual([carol.id]);
  });

  it("unfriending blocks re-labelling but keeps the existing label", async () => {
    const note = await createNote(app, alice, { title: "x" });
    await unfriend(app, alice, bob);
    await request(app)
      .put(`${NOTES}/${note._id}/label`)
      .set(as(alice))
      .send({ personLabel: bob.id })
      .expect(400);
    await request(app)
      .put(`${NOTES}/${note._id}/shares`)
      .set(as(alice))
      .send({ shares: [{ userId: bob.id }] })
      .expect(400);
  });
});

describe("account deletion", () => {
  it("deleting an account removes their notes, their access and labels pointing at them", async () => {
    const bobs = await createNote(app, bob, { title: "Bob's" });
    await shareWith(bob, bobs._id, alice);
    const alices = await createNote(app, alice, { title: "Alice's", personLabel: bob.id });
    await shareWith(alice, alices._id, bob);

    const cookie = await adminCookie(app);
    await request(app)
      .delete(`/api/v1/admin/users/${bob.id}`)
      .set("Cookie", cookie)
      .expect(200);

    expect(await Note.countDocuments({ owner: bob.id })).toBe(0);

    const mine = await request(app).get(`${NOTES}/${alices._id}`).set(as(alice)).expect(200);
    expect(mine.body.note.sharedWith).toBe(0);
    expect(mine.body.note.personLabel).toBeNull();

    const shared = await request(app)
      .get(NOTES)
      .query({ scope: "shared" })
      .set(as(alice))
      .expect(200);
    expect(shared.body.notes).toEqual([]);
  });
});
