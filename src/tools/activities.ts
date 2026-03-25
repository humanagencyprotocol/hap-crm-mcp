import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";

interface Activity {
  id: string;
  contact_id: string;
  type: string;
  summary: string;
  detail: string | null;
  date: string;
  created_by: string | null;
}

export async function log_activity(db: Db, args: Record<string, any>) {
  const { contact_id, type, summary, detail, date, created_by } = args;
  const id = uuidv4();

  await db.run(
    `INSERT INTO activities (id, contact_id, type, summary, detail, date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      contact_id,
      type,
      summary,
      detail ?? null,
      date ?? new Date().toISOString(),
      created_by ?? null,
    ]
  );

  const row = await db.get<Activity>("SELECT * FROM activities WHERE id = ?", [id]);
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
