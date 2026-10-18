import express from "express";
import isAuthenticated from "../middlewares/auth.js";
import {
  validate,
  createNoteSchema,
  listNotesSchema,
  noteIdParamSchema,
  updateNoteSchema,
  noteLabelSchema,
  shareNoteSchema,
  noteShareUserParamSchema,
} from "../middlewares/validation.js";
import {
  listNotes,
  createNote,
  getNoteLabels,
  getNote,
  updateNote,
  setNoteLabel,
  deleteNote,
  getNoteShares,
  upsertNoteShares,
  revokeNoteShare,
  revokeAllNoteShares,
} from "../controllers/noteController.js";

const router = express.Router();

router.use(isAuthenticated);

// ========================
// List & labels
// ========================
router.get("/", validate(listNotesSchema), listNotes);
router.post("/", validate(createNoteSchema), createNote);
// Must precede `/:noteId`, or "labels" is captured as an id.
router.get("/labels", getNoteLabels);

// ========================
// Single note
// ========================
router.get("/:noteId", validate(noteIdParamSchema), getNote);
router.patch("/:noteId", validate(updateNoteSchema), updateNote);
router.put("/:noteId/label", validate(noteLabelSchema), setNoteLabel);
router.delete("/:noteId", validate(noteIdParamSchema), deleteNote);

// ========================
// Sharing (owner-controlled; recipients may only remove themselves)
// ========================
router.get("/:noteId/shares", validate(noteIdParamSchema), getNoteShares);
router.put("/:noteId/shares", validate(shareNoteSchema), upsertNoteShares);
router.delete(
  "/:noteId/shares/:userId",
  validate(noteShareUserParamSchema),
  revokeNoteShare,
);
router.delete("/:noteId/shares", validate(noteIdParamSchema), revokeAllNoteShares);

export default router;
