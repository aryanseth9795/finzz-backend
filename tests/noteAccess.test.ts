import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import {
  can,
  roleOf,
  type NoteRole,
  type NoteAction,
} from "../src/utils/noteAccess.js";
import { toNoteDto } from "../src/utils/noteDto.js";
import { NOTE_PREVIEW_CHARS } from "../src/models/noteModel.js";
import {
  cursorFilter,
  encodeCursor,
  paginateBy,
} from "../src/utils/cursor.js";

/**
 * Pure tests for the Notes authorisation table, the role-shaped DTO and the
 * cursor helpers. No database: these are the rules every note endpoint is
 * built on, so they are pinned on their own.
 */

const oid = () => new mongoose.Types.ObjectId();

const ACTIONS: NoteAction[] = [
  "read",
  "edit",
  "label",
  "viewShares",
  "manageShares",
  "delete",
  "leave",
];

const ALLOWED: Record<NoteRole, NoteAction[]> = {
  owner: ["read", "edit", "label", "viewShares", "manageShares", "delete"],
  editor: ["read", "edit", "leave"],
  viewer: ["read", "leave"],
};

describe("can() — the Notes permission matrix (spec §5)", () => {
  it("can() matches the spec permission matrix", () => {
    for (const role of Object.keys(ALLOWED) as NoteRole[]) {
      for (const action of ACTIONS) {
        expect(
          can(role, action),
          `${role} → ${action}`,
        ).toBe(ALLOWED[role].includes(action));
      }
    }
  });
});

describe("roleOf()", () => {
  const owner = oid();
  const editor = oid();
  const viewer = oid();
  const note = {
    owner,
    shares: [
      { user: editor, permission: "edit" as const },
      { user: viewer, permission: "view" as const },
    ],
  };

  it("roleOf resolves owner, editor, viewer and stranger", () => {
    expect(roleOf(note, String(owner))).toBe("owner");
    expect(roleOf(note, String(editor))).toBe("editor");
    expect(roleOf(note, String(viewer))).toBe("viewer");
    expect(roleOf(note, String(oid()))).toBeNull();
  });

  it("compares populated and raw ids alike", () => {
    const populated = {
      owner: { _id: owner, name: "A" },
      shares: [{ user: { _id: editor, name: "B" }, permission: "edit" as const }],
    };
    expect(roleOf(populated, String(owner))).toBe("owner");
    expect(roleOf(populated, String(editor))).toBe("editor");
  });
});

describe("toNoteDto()", () => {
  const ownerId = oid();
  const bobId = oid();
  const carolId = oid();
  const sharedAt = new Date("2026-10-01T10:00:00Z");
  const now = new Date("2026-10-02T10:00:00Z");

  const base = (body = "hello") => ({
    _id: oid(),
    owner: { _id: ownerId, name: "Alice", avatar: "" },
    title: "T",
    body,
    personLabel: { _id: carolId, name: "Carol", avatar: "" },
    shares: [
      { user: bobId, permission: "edit" as const, sharedAt, updatedAt: sharedAt },
      { user: carolId, permission: "view" as const, sharedAt, updatedAt: sharedAt },
    ],
    version: 3,
    editedAt: now,
    lastEditedBy: { _id: ownerId, name: "Alice" },
    createdAt: sharedAt,
    updatedAt: now,
  });

  it("toNoteDto strips label and shares for recipients", () => {
    const ownerDto = toNoteDto(base(), String(ownerId));
    expect(ownerDto.role).toBe("owner");
    expect(ownerDto.personLabel?._id).toBe(String(carolId));
    expect(ownerDto.sharedWith).toBe(2);
    expect("sharedAt" in ownerDto).toBe(false);

    const editorDto = toNoteDto(base(), String(bobId));
    expect(editorDto.role).toBe("editor");
    expect("personLabel" in editorDto).toBe(false);
    expect("sharedWith" in editorDto).toBe(false);
    expect("shares" in editorDto).toBe(false);
    expect(editorDto.sharedAt).toEqual(sharedAt);
  });

  it("toNoteDto preview cuts body to 300 and flags it", () => {
    const long = toNoteDto(base("x".repeat(500)), String(ownerId), {
      preview: true,
    });
    expect(long.body.length).toBe(NOTE_PREVIEW_CHARS);
    expect(NOTE_PREVIEW_CHARS).toBe(300);
    expect(long.bodyTruncated).toBe(true);

    const short = toNoteDto(base("x".repeat(10)), String(ownerId), {
      preview: true,
    });
    expect(short.body.length).toBe(10);
    expect(short.bodyTruncated).toBe(false);
  });

  it("returns ids as strings and keeps a null label null", () => {
    const dto = toNoteDto({ ...base(), personLabel: null }, String(ownerId));
    expect(dto.personLabel).toBeNull();
    expect(dto._id).toMatch(/^[0-9a-f]{24}$/);
    expect(dto.owner._id).toBe(String(ownerId));
  });

  it("throws for a viewer with no access, so a bug cannot leak a note", () => {
    expect(() => toNoteDto(base(), String(oid()))).toThrow();
  });
});

describe("cursor helpers on a custom field", () => {
  it("paginateBy splits on an arbitrary date field", () => {
    const rows = [0, 1, 2].map((i) => ({
      _id: oid(),
      editedAt: new Date(Date.UTC(2026, 9, 10 - i)),
    }));
    const page = paginateBy(rows, 2, (r) => r.editedAt);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(encodeCursor(rows[1].editedAt, rows[1]._id));
  });

  it("cursorFilter honours a custom field", () => {
    const d = new Date("2026-10-10T00:00:00Z");
    const id = oid();
    expect(cursorFilter({ date: d, id }, "editedAt")).toEqual({
      $or: [
        { editedAt: { $lt: d } },
        { editedAt: d, _id: { $lt: id } },
      ],
    });
    expect(cursorFilter({ date: d }, "editedAt")).toEqual({
      editedAt: { $lt: d },
    });
    // Default field is unchanged for the existing ledgers.
    expect(cursorFilter({ date: d })).toEqual({ date: { $lt: d } });
  });
});
