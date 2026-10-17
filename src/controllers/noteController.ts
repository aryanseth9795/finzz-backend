import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import TryCatch from "../utils/TryCatch.js";
import ErrorHandler from "../middlewares/Errorhandler.js";
import { Note, NOTES_PER_OWNER_MAX } from "../models/noteModel.js";
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
  const { scope, label, q, cursor, limit } = req.query as unknown as {
    scope: "all" | "mine" | "shared";
    label?: string;
    q?: string;
    cursor?: string;
    limit: number;
  };

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
