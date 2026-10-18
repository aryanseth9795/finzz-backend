import { NOTE_PREVIEW_CHARS, type NotePermission } from "../models/noteModel.js";
import { roleOf, type NoteRole } from "./noteAccess.js";

/**
 * Role-shaped JSON for a note.
 *
 * The one place owner-only fields are stripped. A recipient never receives the
 * person label (the owner's private filing) or the list of other recipients,
 * so no endpoint can leak them by returning a raw document.
 */

/** `populate` paths every note response needs. */
export const NOTE_POPULATE = [
  { path: "owner", select: "name avatar" },
  { path: "lastEditedBy", select: "name" },
  { path: "personLabel", select: "name avatar" },
];

interface PersonRef {
  _id: unknown;
  name?: string;
  avatar?: string;
}

export interface PopulatedNote {
  _id: unknown;
  owner: PersonRef | unknown;
  title: string;
  body: string;
  personLabel: PersonRef | unknown | null;
  shares: {
    user: unknown;
    permission: NotePermission;
    sharedAt: Date;
    updatedAt: Date;
  }[];
  version: number;
  editedAt: Date;
  lastEditedBy: PersonRef | unknown | null;
  createdAt: Date;
}

export interface NotePerson {
  _id: string;
  name: string;
  avatar?: string;
}

export interface NoteDto {
  _id: string;
  title: string;
  body: string;
  bodyTruncated?: boolean;
  version: number;
  createdAt: Date;
  editedAt: Date;
  role: NoteRole;
  owner: NotePerson;
  lastEditedBy: { _id: string; name: string } | null;
  // owner only
  personLabel?: NotePerson | null;
  sharedWith?: number;
  // recipients only
  sharedAt?: Date;
}

const person = (value: unknown): NotePerson | null => {
  if (!value) return null;
  if (typeof value === "object" && "_id" in value) {
    const p = value as PersonRef;
    return {
      _id: String(p._id),
      name: p.name ?? "",
      ...(p.avatar !== undefined ? { avatar: p.avatar } : {}),
    };
  }
  // Unpopulated (or a deleted user populated to null upstream).
  return { _id: String(value), name: "" };
};

const idOf = (value: unknown) =>
  value && typeof value === "object" && "_id" in value
    ? String((value as { _id: unknown })._id)
    : String(value);

export const toNoteDto = (
  note: PopulatedNote,
  viewerId: string,
  opts: { preview?: boolean } = {},
): NoteDto => {
  const role = roleOf(note, viewerId);
  if (!role) {
    // Callers only pass notes the viewer can see; reaching here is a bug, and
    // failing loudly beats serialising someone else's note.
    throw new Error("toNoteDto: viewer has no access to this note");
  }

  const fullBody = note.body ?? "";
  const truncate = opts.preview && fullBody.length > NOTE_PREVIEW_CHARS;
  const lastEditor = person(note.lastEditedBy);

  const dto: NoteDto = {
    _id: String(note._id),
    title: note.title ?? "",
    body: truncate ? fullBody.slice(0, NOTE_PREVIEW_CHARS) : fullBody,
    ...(opts.preview ? { bodyTruncated: !!truncate } : {}),
    version: note.version,
    createdAt: note.createdAt,
    editedAt: note.editedAt,
    role,
    owner: person(note.owner) ?? { _id: "", name: "" },
    lastEditedBy: lastEditor ? { _id: lastEditor._id, name: lastEditor.name } : null,
  };

  if (role === "owner") {
    dto.personLabel = person(note.personLabel);
    dto.sharedWith = note.shares?.length ?? 0;
  } else {
    const mine = note.shares.find((s) => idOf(s.user) === String(viewerId));
    dto.sharedAt = mine?.sharedAt;
  }

  return dto;
};
