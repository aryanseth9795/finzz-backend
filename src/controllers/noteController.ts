import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import TryCatch from "../utils/TryCatch.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import {
  Note,
  NOTES_PER_OWNER_MAX,
  NOTE_SHARES_MAX,
  type NotePermission,
} from "../models/noteModel.js";
import { User } from "../models/userModel.js";
import {
  assertCan,
  editableByFilter,
  loadNoteFor,
  visibleToFilter,
} from "../utils/noteAccess.js";
import { NOTE_POPULATE, toNoteDto, type PopulatedNote } from "../utils/noteDto.js";
import { cursorFilter, decodeCursor, paginateBy } from "../utils/cursor.js";
import { escapeRegex } from "../utils/escapeRegex.js";
import { listNotesSchema } from "../middlewares/validation.js";
import { sendBulkPushNotifications } from "../services/notificationService.js";

// ========================
// Helpers
// ========================

const isBlank = (title: string, body: string) =>
  title.trim() === "" && body.trim() === "";

/** Throws 400 unless `friendId` is currently a friend of `userId`. */
const assertFriend = async (userId: string, friendId: string, message: string) => {
  const isFriend = await User.exists({ _id: userId, friends: friendId });
  if (!isFriend) throw new ErrorHandler(message, 400);
};

/** Load a note the caller can see, populated for a DTO. 404 when not visible. */
const findPopulated = async (noteId: string, userId: string) => {
  const note = await Note.findOne({ _id: noteId, ...visibleToFilter(userId) })
    .populate(NOTE_POPULATE)
    .lean<PopulatedNote>();
  if (!note) throw new ErrorHandler("Note not found", 404);
  return note;
};

const noteResponse = async (noteId: unknown, userId: string) =>
  toNoteDto(await findPopulated(String(noteId), userId), userId);

// ========================
// List & labels
// ========================

export const listNotes = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const me = new mongoose.Types.ObjectId(userId);
  // Express 5's `req.query` is a getter that re-parses the URL on every read, so
  // validate()'s coercions/defaults never reach it. Parse it again here to get
  // the typed values (scope default, trimmed q, numeric limit with its default).
  const { scope, label, q, cursor, limit } = listNotesSchema.shape.query.parse(req.query);

  if (label && scope === "shared") {
    throw new ErrorHandler("Person filters apply to your own notes only", 400);
  }

  // Each condition is its own `$and` clause so the scope's `$or`, the search's
  // `$or` and the cursor's `$or` never overwrite one another.
  const clauses: Record<string, unknown>[] = [];

  if (label) {
    // A label is owner-only metadata, so filtering by one only ever matches
    // the caller's own notes — never notes shared with them.
    clauses.push({
      owner: me,
      personLabel: label === "none" ? null : new mongoose.Types.ObjectId(label),
    });
  } else if (scope === "mine") {
    clauses.push({ owner: me });
  } else if (scope === "shared") {
    clauses.push({ "shares.user": me });
  } else {
    clauses.push(visibleToFilter(userId));
  }

  if (q) {
    const pattern = { $regex: escapeRegex(q), $options: "i" };
    clauses.push({ $or: [{ title: pattern }, { body: pattern }] });
  }

  const after = cursorFilter(decodeCursor(cursor), "editedAt");
  if (Object.keys(after).length > 0) clauses.push(after);

  const rows = await Note.find({ $and: clauses })
    .sort({ editedAt: -1, _id: -1 })
    .limit(limit + 1)
    .populate(NOTE_POPULATE)
    .lean<(PopulatedNote & { _id: mongoose.Types.ObjectId })[]>();

  const page = paginateBy(rows, limit, (row) => row.editedAt);

  return res.status(200).json({
    success: true,
    notes: page.items.map((n) => toNoteDto(n, userId, { preview: true })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
});

/** People used as labels on the caller's notes, with counts, for filter chips. */
export const getNoteLabels = TryCatch(async (req: Request, res: Response) => {
  const me = new mongoose.Types.ObjectId(req.user.id);

  const labels = await Note.aggregate([
    { $match: { owner: me, personLabel: { $ne: null } } },
    { $group: { _id: "$personLabel", count: { $sum: 1 } } },
    {
      $lookup: {
        from: User.collection.name,
        localField: "_id",
        foreignField: "_id",
        as: "user",
      },
    },
    // A label pointing at a deleted account has no user; drop it.
    { $unwind: "$user" },
    {
      $project: {
        _id: 0,
        count: 1,
        user: { _id: "$user._id", name: "$user.name", avatar: "$user.avatar" },
      },
    },
    { $sort: { count: -1, "user.name": 1 } },
  ]);

  return res.status(200).json({ success: true, labels });
});

// ========================
// CRUD
// ========================

export const createNote = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const title: string = req.body.title ?? "";
  const body: string = req.body.body ?? "";
  const personLabel: string | null = req.body.personLabel ?? null;

  if (isBlank(title, body)) {
    throw new ErrorHandler("A note needs a title or some text", 400);
  }

  const owned = await Note.countDocuments({ owner: userId });
  if (owned >= NOTES_PER_OWNER_MAX) {
    throw new ErrorHandler(
      `You can keep at most ${NOTES_PER_OWNER_MAX} notes. Delete some to add more.`,
      400,
    );
  }

  if (personLabel) {
    await assertFriend(userId, personLabel, "You can only label a note with a friend");
  }

  const note = await Note.create({
    owner: userId,
    title,
    body,
    personLabel,
    shares: [],
    editedAt: new Date(),
    lastEditedBy: userId,
  });

  return res.status(201).json({
    success: true,
    note: await noteResponse(note._id, userId),
  });
});

export const getNote = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  return res.status(200).json({
    success: true,
    note: await noteResponse(req.params.noteId, userId),
  });
});

/**
 * Edit title/body with optimistic concurrency.
 *
 * The final write repeats both the version check and the edit-access check in
 * its own filter, so a save that raced a revoke, a downgrade or another edit
 * cannot land. When it matches nothing, the caller's current access decides
 * the status: 404 (gone), 403 (now a viewer) or 409 (someone else saved).
 */
export const updateNote = TryCatch(
  async (req: Request, res: Response, _next: NextFunction) => {
    const userId = req.user.id;
    const noteId = req.params.noteId as string;
    const { title, body, version } = req.body as {
      title?: string;
      body?: string;
      version: number;
    };

    const conflict = async () =>
      res.status(409).json({
        success: false,
        message: "This note was changed by someone else",
        note: await noteResponse(noteId, userId),
      });

    const { note, role } = await loadNoteFor(noteId, userId);
    assertCan(role, "edit");
    if (note.version !== version) return conflict();

    const nextTitle = title ?? note.title;
    const nextBody = body ?? note.body;
    if (isBlank(nextTitle, nextBody)) {
      throw new ErrorHandler("A note needs a title or some text", 400);
    }

    const set: Record<string, unknown> = {
      editedAt: new Date(),
      lastEditedBy: userId,
    };
    if (title !== undefined) set.title = title;
    if (body !== undefined) set.body = body;

    const updated = await Note.findOneAndUpdate(
      { $and: [{ _id: noteId, version }, editableByFilter(userId)] },
      { $set: set, $inc: { version: 1 } },
      { new: true },
    )
      .populate(NOTE_POPULATE)
      .lean<PopulatedNote>();

    if (!updated) {
      const current = await loadNoteFor(noteId, userId);
      assertCan(current.role, "edit");
      return conflict();
    }

    return res.status(200).json({ success: true, note: toNoteDto(updated, userId) });
  },
);

/** Owner-only. Never touches `editedAt`, `version` or `shares`. */
export const setNoteLabel = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const noteId = req.params.noteId as string;
  const personLabel: string | null = req.body.personLabel;

  const { role } = await loadNoteFor(noteId, userId);
  assertCan(role, "label");

  if (personLabel) {
    await assertFriend(userId, personLabel, "You can only label a note with a friend");
  }

  await Note.updateOne({ _id: noteId, owner: userId }, { $set: { personLabel } });

  return res.status(200).json({
    success: true,
    note: await noteResponse(noteId, userId),
  });
});

export const deleteNote = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const noteId = req.params.noteId as string;

  const { role } = await loadNoteFor(noteId, userId);
  assertCan(role, "delete");

  await Note.deleteOne({ _id: noteId, owner: userId });

  return res.status(200).json({ success: true, message: "Note deleted" });
});

// ========================
// Sharing (owner-controlled)
// ========================

/** Owner-only: who has access and at what level. */
export const getNoteShares = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const noteId = req.params.noteId as string;

  const { role } = await loadNoteFor(noteId, userId);
  assertCan(role, "viewShares");

  const note = await Note.findById(noteId)
    .select("shares")
    .populate("shares.user", "name avatar")
    .lean<{
      shares: {
        user: { _id: unknown; name: string; avatar?: string } | null;
        permission: NotePermission;
        sharedAt: Date;
        updatedAt: Date;
      }[];
    }>();

  const shares = (note?.shares ?? [])
    // A deleted account populates to null; it has no access to show.
    .filter((s) => s.user)
    .map((s) => ({
      user: { _id: String(s.user!._id), name: s.user!.name, avatar: s.user!.avatar },
      permission: s.permission,
      sharedAt: s.sharedAt,
      updatedAt: s.updatedAt,
    }));

  return res.status(200).json({ success: true, shares });
});

/**
 * Grant access or change permission, for one or more friends.
 *
 * Each recipient is one atomic update: `$push` guarded by "not already shared"
 * and the size cap (a new share, which notifies), falling back to a positional
 * permission change (silent). The guard makes duplicate rows impossible even
 * when two requests race.
 */
export const upsertNoteShares = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const noteId = req.params.noteId as string;
  const shares = req.body.shares as { userId: string; permission: NotePermission }[];

  const { note, role } = await loadNoteFor(noteId, userId);
  assertCan(role, "manageShares");

  if (shares.some((s) => s.userId === userId)) {
    throw new ErrorHandler("You already own this note", 400);
  }

  const me = await User.findById(userId)
    .select("name friends")
    .lean<{ name: string; friends: mongoose.Types.ObjectId[] }>();
  const friends = new Set((me?.friends ?? []).map(String));
  if (shares.some((s) => !friends.has(s.userId))) {
    throw new ErrorHandler("You can only share with friends", 400);
  }

  // Reject a batch that cannot fit before writing any of it, so a request is
  // never half-applied. The per-user guard below still holds under races.
  const existing = new Set(note.shares.map((s) => String(s.user)));
  const newCount = shares.filter((s) => !existing.has(s.userId)).length;
  if (note.shares.length + newCount > NOTE_SHARES_MAX) {
    throw new ErrorHandler(
      `A note can be shared with at most ${NOTE_SHARES_MAX} people`,
      400,
    );
  }

  const now = new Date();
  const added: string[] = [];

  for (const { userId: recipient, permission } of shares) {
    const pushed = await Note.updateOne(
      {
        _id: noteId,
        owner: userId,
        "shares.user": { $ne: recipient },
        $expr: { $lt: [{ $size: "$shares" }, NOTE_SHARES_MAX] },
      },
      {
        $push: {
          shares: { user: recipient, permission, sharedAt: now, updatedAt: now },
        },
      },
    );
    if (pushed.modifiedCount === 1) {
      added.push(recipient);
      continue;
    }

    const changed = await Note.updateOne(
      { _id: noteId, owner: userId, "shares.user": recipient },
      { $set: { "shares.$.permission": permission, "shares.$.updatedAt": now } },
    );
    if (changed.matchedCount === 0) {
      throw new ErrorHandler(
        `A note can be shared with at most ${NOTE_SHARES_MAX} people`,
        400,
      );
    }
  }

  // Lock-screen privacy: the push names the sender, never the note's content.
  await sendBulkPushNotifications(
    added.map((recipient) => ({
      userId: recipient,
      title: "New shared note",
      body: `${me?.name ?? "A friend"} shared a note with you`,
      data: { type: "note_shared", senderId: userId, noteId },
    })),
  );

  return res.status(200).json({
    success: true,
    note: await noteResponse(noteId, userId),
  });
});

/**
 * Revoke one recipient (owner), or remove yourself from a note shared with you
 * ("leave"). A recipient can never remove anyone else.
 */
export const revokeNoteShare = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const noteId = req.params.noteId as string;
  const target = req.params.userId as string;

  const { role } = await loadNoteFor(noteId, userId);

  if (target === userId) {
    if (role === "owner") {
      throw new ErrorHandler("Owners can't leave their own note", 400);
    }
    assertCan(role, "leave");
    await Note.updateOne({ _id: noteId }, { $pull: { shares: { user: userId } } });
    return res.status(200).json({ success: true, message: "Removed from your notes" });
  }

  assertCan(role, "manageShares");

  const result = await Note.updateOne(
    { _id: noteId, owner: userId, "shares.user": target },
    { $pull: { shares: { user: target } } },
  );
  if (result.modifiedCount === 0) {
    throw new ErrorHandler("Share not found", 404);
  }

  return res.status(200).json({ success: true, message: "Access removed" });
});

/** Owner-only: revoke everyone and make the note private again. */
export const revokeAllNoteShares = TryCatch(async (req: Request, res: Response) => {
  const userId = req.user.id;
  const noteId = req.params.noteId as string;

  const { role } = await loadNoteFor(noteId, userId);
  assertCan(role, "manageShares");

  await Note.updateOne({ _id: noteId, owner: userId }, { $set: { shares: [] } });

  return res.status(200).json({
    success: true,
    note: await noteResponse(noteId, userId),
  });
});
