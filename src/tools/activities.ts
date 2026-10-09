import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { requireContact, checkContactType } from "./contacts.js";
import { recordChangeMeta } from "../change-meta.js";

export interface Activity {
  id: string;
  contact_id: string;
  type: string;
  summary: string;
  detail: string | null;
  date: string;
  created_by: string | null;
}

/**
 * Activities are append-only (see docs/contract.md): no update or delete
 * tool exists for them, and this module adds none — a correction is a new
 * activity, not an edit to a past one. They carry no `revision` for the
 * same reason: nothing ever acts on a past activity by name.
 */
export async function log_activity(db: Db, args: Record<string, any>) {
  // ticket_id: Suveren mandate ticket (Content Provenance §4.1). Stored on
  // the existing receipt_id column (internal storage name, unchanged).
  const { contact_id, type, summary, detail, date, created_by, contact_type, ticket_id } = args;
  const id = uuidv4();

  const contact = await requireContact(db, contact_id);
  checkContactType(contact, contact_type);

  await db.run(
    `INSERT INTO activities (id, contact_id, type, summary, detail, date, created_by, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      contact_id,
      type,
      summary,
      detail ?? null,
      date ?? new Date().toISOString(),
      created_by ?? null,
      ticket_id ?? null,
    ]
  );

  const row = await db.get<Activity>("SELECT * FROM activities WHERE id = ?", [id]);
  recordChangeMeta(row!, { oldValues: null, newValues: { ...row! } });
  return row!;
}

export async function get_timeline(db: Db, args: Record<string, any>) {
  const { contact_id, limit = 20 } = args;

  const rows = await db.all<Activity>(
    `SELECT * FROM activities WHERE contact_id = ? ORDER BY date DESC LIMIT ?`,
    [contact_id, limit]
  );

  return rows;
}
