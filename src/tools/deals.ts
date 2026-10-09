import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";

interface Deal {
  id: string;
  contact_id: string;
  title: string;
  value: number | null;
  currency: string;
  stage: string;
  expected_close: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export async function create_deal(db: Db, args: Record<string, any>) {
  // ticket_id: Suveren mandate ticket (Content Provenance §4.1). Stored on
  // the existing receipt_id column (internal storage name, unchanged).
  const { contact_id, title, value, currency, stage, expected_close, notes, ticket_id } = args;
  const id = uuidv4();

  await db.run(
    `INSERT INTO deals (id, contact_id, title, value, currency, stage, expected_close, notes, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      contact_id,
      title,
      value ?? null,
      currency ?? "USD",
      stage ?? "lead",
      expected_close ?? null,
      notes ?? null,
      ticket_id ?? null,
    ]
  );

  const row = await db.get<Deal>("SELECT * FROM deals WHERE id = ?", [id]);
  return row!;
}

export async function update_deal(db: Db, args: Record<string, any>) {
  const { id, ticket_id, ...fields } = args;

  const updatable = ["title", "value", "currency", "stage", "expected_close", "notes"];
  const setClauses: string[] = [];
  const params: any[] = [];

  for (const key of updatable) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      params.push(fields[key]);
    }
  }

  // ticket_id: stored on the existing receipt_id column (internal storage
  // name, unchanged).
  if (ticket_id !== undefined) {
    setClauses.push("receipt_id = ?");
    params.push(ticket_id);
  }

  if (setClauses.length === 0) {
    throw new Error("No fields to update");
  }

  setClauses.push("updated_at = datetime('now')");
  params.push(id);

  await db.run(
    `UPDATE deals SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );

  const row = await db.get<Deal>("SELECT * FROM deals WHERE id = ?", [id]);
  if (!row) throw new Error(`Deal not found: ${id}`);
  return row;
}

export async function get_pipeline(db: Db, args: Record<string, any>) {
  const { stage, sort_by = "expected_close" } = args;

  const allowedSortFields = ["expected_close", "value", "created_at", "updated_at", "title"];
  const sortField = allowedSortFields.includes(sort_by) ? sort_by : "expected_close";

  const conditions: string[] = [];
  const params: any[] = [];

  if (stage) {
    conditions.push("stage = ?");
    params.push(stage);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await db.all<Deal>(
    `SELECT * FROM deals ${where} ORDER BY ${sortField} ASC NULLS LAST`,
    params
  );

  return rows;
}
