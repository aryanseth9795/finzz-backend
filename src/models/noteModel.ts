import mongoose, { Document, Schema, model } from "mongoose";

// ========================
// Limits
// ========================
// Shared by the schema, the zod validators and the controller so every layer
// agrees on what a valid note is.
export const NOTE_TITLE_MAX = 120;
export const NOTE_BODY_MAX = 20_000;
/** Bounded by the owner's friend count in practice; capped so the embedded array stays small. */
export const NOTE_SHARES_MAX = 50;
export const NOTES_PER_OWNER_MAX = 2000;
/** Characters of body returned by the list endpoint. */
export const NOTE_PREVIEW_CHARS = 300;

export type NotePermission = "view" | "edit";

/** One recipient's access to a note. The owner never appears here. */
export interface INoteShare {
  user: mongoose.Types.ObjectId;
  permission: NotePermission;
  /** When access was first granted. */
  sharedAt: Date;
  /** When the permission last changed. */
  updatedAt: Date;
}

export interface INote extends Document {
  /** The note's admin: the only user who can label, share, revoke or delete. */
  owner: mongoose.Types.ObjectId;
  title: string;
  body: string;
  /**
   * Owner-only organising tag. Deliberately independent of `shares`:
   * labelling a note with a friend grants that friend nothing.
   */
  personLabel: mongoose.Types.ObjectId | null;
  shares: INoteShare[];
  /** Optimistic-concurrency counter, incremented on every content edit. */
  version: number;
  /** Last title/body change. Label and sharing changes do not move it. */
  editedAt: Date;
  lastEditedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const noteShareSchema = new Schema<INoteShare>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    permission: {
      type: String,
      enum: ["view", "edit"],
      default: "view",
      required: true,
    },
    sharedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const noteSchema = new Schema<INote>(
  {
    owner: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    title: {
      type: String,
      trim: true,
      maxlength: NOTE_TITLE_MAX,
      default: "",
    },
    body: {
      type: String,
      maxlength: NOTE_BODY_MAX,
      default: "",
    },
    personLabel: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    shares: {
      type: [noteShareSchema],
      default: [],
      validate: {
        validator: (v: INoteShare[]) => v.length <= NOTE_SHARES_MAX,
        message: `A note can be shared with at most ${NOTE_SHARES_MAX} people`,
      },
    },
    version: { type: Number, default: 1, min: 1 },
    editedAt: { type: Date, default: Date.now },
    lastEditedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// "Mine", newest edit first — the keyset predicate in utils/cursor.ts seeks
// straight to the page boundary on this index.
noteSchema.index({ owner: 1, editedAt: -1, _id: -1 });
// "Shared with me" — multikey over the embedded recipients.
noteSchema.index({ "shares.user": 1, editedAt: -1, _id: -1 });
// Person-label filter chips.
noteSchema.index({ owner: 1, personLabel: 1, editedAt: -1, _id: -1 });

export const Note = mongoose.models.Note || model<INote>("Note", noteSchema);
