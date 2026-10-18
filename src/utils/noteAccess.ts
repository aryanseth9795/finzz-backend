import mongoose from "mongoose";
import ErrorHandler from "../middlewares/Errorhandler.js";
import { Note, type NotePermission } from "../models/noteModel.js";

/**
 * Notes authorisation — the single place that decides who may do what.
 *
 * Every note handler resolves the caller's role through `loadNoteFor` and then
 * asks `can`/`assertCan`. Keeping the matrix in one table (spec §5) means a new
 * endpoint cannot quietly grant an editor something only the owner should have.
 *
 * The owner is the note's "admin": only they can label, share, change
 * permissions, revoke or delete. Recipients can read, editors can also edit
 * content, and either can remove their own access ("leave").
 */

export type NoteRole = "owner" | "editor" | "viewer";

export type NoteAction =
  | "read"
  | "edit"
  | "label"
  | "viewShares"
  | "manageShares"
  | "delete"
  | "leave";

const MATRIX: Record<NoteRole, ReadonlySet<NoteAction>> = {
  owner: new Set([
    "read",
    "edit",
    "label",
    "viewShares",
    "manageShares",
    "delete",
  ]),
  editor: new Set(["read", "edit", "leave"]),
  viewer: new Set(["read", "leave"]),
};

export const can = (role: NoteRole, action: NoteAction): boolean =>
  MATRIX[role].has(action);

/** An id that may be raw or populated (`{ _id }`). */
const idOf = (value: unknown): string => {
  if (value && typeof value === "object" && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
};

export const roleOf = (
  note: {
    owner: unknown;
    shares: { user: unknown; permission: NotePermission }[];
  },
  userId: string,
): NoteRole | null => {
  if (idOf(note.owner) === String(userId)) return "owner";
  const share = note.shares?.find((s) => idOf(s.user) === String(userId));
  if (!share) return null;
  return share.permission === "edit" ? "editor" : "viewer";
};

/** The raw note as `loadNoteFor` returns it (unpopulated, lean). */
export interface LeanNote {
  _id: mongoose.Types.ObjectId;
  owner: mongoose.Types.ObjectId;
  title: string;
  body: string;
  personLabel: mongoose.Types.ObjectId | null;
  shares: {
    user: mongoose.Types.ObjectId;
    permission: NotePermission;
    sharedAt: Date;
    updatedAt: Date;
  }[];
  version: number;
  editedAt: Date;
  lastEditedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** Filter matching notes `userId` can see at all. */
export const visibleToFilter = (userId: string) => ({
  $or: [{ owner: userId }, { "shares.user": userId }],
});

/**
 * Filter matching notes `userId` may edit. Used inside the write query itself,
 * so access revoked between a read and a write cannot be bypassed.
 */
export const editableByFilter = (userId: string) => ({
  $or: [
    { owner: userId },
    { shares: { $elemMatch: { user: userId, permission: "edit" } } },
  ],
});

/**
 * Load a note the caller can see, with their role.
 *
 * 404 — not 403 — for a note that exists but is not theirs, so ids cannot be
 * probed for existence (same rule as `assertChatMember`).
 */
export const loadNoteFor = async (
  noteId: string,
  userId: string,
): Promise<{ note: LeanNote; role: NoteRole }> => {
  if (!mongoose.isValidObjectId(noteId)) {
    throw new ErrorHandler("Invalid note id", 400);
  }

  const note = await Note.findOne({
    _id: noteId,
    ...visibleToFilter(userId),
  }).lean<LeanNote>();

  const role = note ? roleOf(note, userId) : null;
  if (!note || !role) {
    throw new ErrorHandler("Note not found", 404);
  }

  return { note, role };
};

/** Throws 403 unless `role` permits `action`. */
export const assertCan = (role: NoteRole, action: NoteAction): void => {
  if (!can(role, action)) {
    throw new ErrorHandler("You don't have permission to do that", 403);
  }
};
