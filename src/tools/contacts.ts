import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { CONTACT_TYPES, type ContactType } from "../company.js";
import { refuse } from "../refuse.js";
import { requireCurrentRevision } from "../revision.js";
import { recordChangeMeta } from "../change-meta.js";

export interface ContactRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  type: string;
  stage: string;
  tags: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
  receipt_id: string | null;
  revision: number;
  archived: number;
}

/** A snapshot row from `contact_revisions` — the frozen content of one past revision. */
interface ContactRevisionRow {
  id: string;
  contact_id: string;
  revision: number;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  type: string;
  stage: string;
  tags: string;
  notes: string | null;
  archived: number;
  created_at: string;
  receipt_id: string | null;
}

function parseContact(row: ContactRow) {
  return {
    ...row,
    tags: parseTags(row.tags),
    archived: Boolean(row.archived),
  };
}

function parseTags(tags: string | null | undefined): string[] {
  try {
    return JSON.parse(tags ?? "[]");
  } catch {
    return [];
  }
}

export async function requireContact(db: Db, id: string): Promise<ContactRow> {
  const row = await db.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", [id]);
  if (!row) throw new Error(`Contact not found: ${id}`);
  return row;
}

/**
 * Refuses a write on an archived contact — delete_contact (archiving an
 * already-archived contact), update_contact, and convert_contact all take
 * this gate; restore_contact is the one tool that requires the opposite.
 */
function refuseArchived(contact: ContactRow): never {
  refuse("archived", true, false, `Contact ${contact.name} (${contact.id}) is archived; restore it first (restore_contact).`);
}

function refuseNotArchived(contact: ContactRow): never {
  refuse("archived", false, true, `Contact ${contact.name} (${contact.id}) is not archived.`);
}

/**
 * Checks the caller's declared `contact_type` (the gateway's bound scope
 * value — today a static manifest claim, soon an actual call argument)
 * against the contact's real stored type. Absent declaration is not
 * checked: callers that don't declare a scope make no claim to verify.
 */
export function checkContactType(contact: ContactRow, declaredType: unknown): void {
  if (declaredType === undefined) return;
  if (declaredType !== contact.type) {
    refuse(
      "contact_type",
      declaredType,
      contact.type,
      `Contact ${contact.name} (${contact.id}) is type ${JSON.stringify(contact.type)}; this request declares ${JSON.stringify(declaredType)}.`
    );
  }
}

async function recordContactRevision(db: Db, row: ContactRow, ticketId: string | null): Promise<void> {
  await db.run(
    `INSERT INTO contact_revisions (id, contact_id, revision, name, email, phone, company, role, type, stage, tags, notes, archived, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), row.id, row.revision, row.name, row.email, row.phone, row.company, row.role, row.type, row.stage, row.tags, row.notes, row.archived, ticketId]
  );
}

export async function create_contact(db: Db, args: Record<string, any>) {
  // ticket_id: the Suveren mandate ticket that authorized this write (Content
  // Provenance §4.1). Injected by the gateway; absent on direct calls. Stored
  // on the existing receipt_id column (internal storage name, unchanged).
  const { name, email, phone, company, role, type, stage, tags, notes, ticket_id } = args;
  const id = uuidv4();
  const tagsJson = JSON.stringify(tags ?? []);

  await db.run(
    `INSERT INTO contacts (id, name, email, phone, company, role, type, stage, tags, notes, receipt_id, revision, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    [
      id,
      name,
      email ?? null,
      phone ?? null,
      company ?? null,
      role ?? null,
      type ?? "customer",
      stage ?? "new",
      tagsJson,
      notes ?? null,
      ticket_id ?? null,
    ]
  );

  const row = await db.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", [id]);
  await recordContactRevision(db, row!, ticket_id ?? null);
  const result = parseContact(row!);
  recordChangeMeta(result, { oldValues: null, newValues: { ...result } });
  return result;
}

export async function find_contacts(db: Db, args: Record<string, any>) {
  const { query, type, stage, include_archived, limit = 50 } = args;

  const conditions: string[] = [];
  const params: any[] = [];

  if (query) {
    conditions.push(
      "(name LIKE ? OR email LIKE ? OR company LIKE ?)"
    );
    const like = `%${query}%`;
    params.push(like, like, like);
  }
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }
  if (stage) {
    conditions.push("stage = ?");
    params.push(stage);
  }
  if (!include_archived) {
    conditions.push("archived = 0");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = await db.all<ContactRow>(
    `SELECT * FROM contacts ${where} ORDER BY created_at DESC LIMIT ?`,
    params
  );

  return rows.map(parseContact);
}

export async function get_contact(db: Db, args: Record<string, any>) {
  const { id, revision } = args;
  const contact = await requireContact(db, id);

  if (revision === undefined || revision === contact.revision) {
    return parseContact(contact);
  }

  // An older revision: the current row's timestamps apply (a contact has one
  // creation/update timestamp pair regardless of how many content revisions
  // it went through), but its content comes from the frozen snapshot.
  const snapshot = await db.get<ContactRevisionRow>(
    "SELECT * FROM contact_revisions WHERE contact_id = ? AND revision = ?",
    [id, revision]
  );
  if (!snapshot) {
    throw new Error(`Unknown revision ${JSON.stringify(revision)} for contact ${contact.name} (${id})`);
  }
  return parseContact({
    ...contact,
    revision: snapshot.revision,
    name: snapshot.name,
    email: snapshot.email,
    phone: snapshot.phone,
    company: snapshot.company,
    role: snapshot.role,
    type: snapshot.type,
    stage: snapshot.stage,
    tags: snapshot.tags,
    notes: snapshot.notes,
    archived: snapshot.archived,
  });
}

const UPDATABLE_FIELDS = ["name", "email", "phone", "company", "role", "stage", "tags", "notes"] as const;

export async function update_contact(db: Db, args: Record<string, any>) {
  const { id, revision, type, contact_type, ticket_id, ...fields } = args;

  const contact = await requireContact(db, id);
  if (contact.archived) refuseArchived(contact);
  requireCurrentRevision("Contact", id, contact.revision, revision);
  checkContactType(contact, contact_type);

  if (type !== undefined) {
    refuse("type", type, contact.type, "Contact type cannot change via update_contact — use convert_contact.");
  }

  const changedKeys = UPDATABLE_FIELDS.filter((k) => k in fields);
  if (changedKeys.length === 0) {
    throw new Error("No fields to update");
  }

  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  const setClauses: string[] = [];
  const params: any[] = [];

  for (const key of changedKeys) {
    oldValues[key] = key === "tags" ? parseTags(contact.tags) : (contact as any)[key];
    newValues[key] = fields[key];
    setClauses.push(`${key} = ?`);
    params.push(key === "tags" ? JSON.stringify(fields[key]) : fields[key]);
  }

  const nextRevision = contact.revision + 1;
  setClauses.push("revision = ?");
  params.push(nextRevision);
  setClauses.push("updated_at = datetime('now')");

  if (ticket_id !== undefined) {
    setClauses.push("receipt_id = ?");
    params.push(ticket_id);
  }

  params.push(id);

  await db.run(
    `UPDATE contacts SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );

  const row = await db.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", [id]);
  if (!row) throw new Error(`Contact not found: ${id}`);
  await recordContactRevision(db, row, ticket_id ?? null);

  const result = parseContact(row);
  recordChangeMeta(result, { oldValues, newValues });
  return result;
}

export async function delete_contact(db: Db, args: Record<string, any>) {
  // ticket_id: Suveren mandate ticket (Content Provenance §4.1), stored on
  // the row's existing receipt_id column (internal storage name, unchanged).
  // delete_contact archives rather than deletes (see docs/contract.md): no
  // cascade, activities/deals/tasks tied to this contact survive untouched.
  const { id, revision, contact_type, ticket_id } = args;

  const contact = await requireContact(db, id);
  if (contact.archived) refuseArchived(contact);
  requireCurrentRevision("Contact", id, contact.revision, revision);
  checkContactType(contact, contact_type);

  const nextRevision = contact.revision + 1;
  await db.run(
    "UPDATE contacts SET archived = 1, revision = ?, updated_at = datetime('now'), receipt_id = ? WHERE id = ?",
    [nextRevision, ticket_id ?? contact.receipt_id ?? null, id]
  );

  const row = await db.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", [id]);
  await recordContactRevision(db, row!, ticket_id ?? null);

  const result = {
    message: `Contact "${contact.name}" (${id}) archived.`,
    id,
    revision: nextRevision,
    archived: true,
  };
  recordChangeMeta(result, { oldValues: { archived: false }, newValues: { archived: true } });
  return result;
}

export async function restore_contact(db: Db, args: Record<string, any>) {
  const { id, revision, ticket_id } = args;

  const contact = await requireContact(db, id);
  if (!contact.archived) refuseNotArchived(contact);
  requireCurrentRevision("Contact", id, contact.revision, revision);

  const nextRevision = contact.revision + 1;
  await db.run(
    "UPDATE contacts SET archived = 0, revision = ?, updated_at = datetime('now'), receipt_id = ? WHERE id = ?",
    [nextRevision, ticket_id ?? contact.receipt_id ?? null, id]
  );

  const row = await db.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", [id]);
  await recordContactRevision(db, row!, ticket_id ?? null);

  const result = parseContact(row!);
  recordChangeMeta(result, { oldValues: { archived: true }, newValues: { archived: false } });
  return result;
}

export async function convert_contact(db: Db, args: Record<string, any>) {
  const { id, revision, to_type, contact_type, ticket_id } = args;

  const contact = await requireContact(db, id);
  if (contact.archived) refuseArchived(contact);
  requireCurrentRevision("Contact", id, contact.revision, revision);
  checkContactType(contact, contact_type);

  if (!(CONTACT_TYPES as readonly string[]).includes(to_type)) {
    throw new Error(`to_type must be one of ${CONTACT_TYPES.join(", ")} — got ${JSON.stringify(to_type)}`);
  }
  if (to_type === contact.type) {
    refuse("to_type", to_type, contact.type, `Contact ${contact.name} (${id}) is already type ${JSON.stringify(contact.type)}.`);
  }

  const nextRevision = contact.revision + 1;
  await db.run(
    "UPDATE contacts SET type = ?, revision = ?, updated_at = datetime('now'), receipt_id = ? WHERE id = ?",
    [to_type as ContactType, nextRevision, ticket_id ?? contact.receipt_id ?? null, id]
  );

  const row = await db.get<ContactRow>("SELECT * FROM contacts WHERE id = ?", [id]);
  await recordContactRevision(db, row!, ticket_id ?? null);

  const result = parseContact(row!);
  recordChangeMeta(result, { oldValues: { type: contact.type }, newValues: { type: to_type } });
  return result;
}
