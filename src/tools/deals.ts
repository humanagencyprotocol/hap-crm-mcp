import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { requireContact, checkContactType } from "./contacts.js";
import { requireCurrentRevision } from "../revision.js";
import { recordChangeMeta } from "../change-meta.js";

export interface DealRow {
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
  receipt_id: string | null;
  revision: number;
}

/** A snapshot row from `deal_revisions` — the frozen content of one past revision. */
interface DealRevisionRow {
  id: string;
  deal_id: string;
  revision: number;
  title: string;
  value: number | null;
  currency: string | null;
  stage: string;
  expected_close: string | null;
  notes: string | null;
  created_at: string;
  receipt_id: string | null;
}

export async function requireDeal(db: Db, id: string): Promise<DealRow> {
  const row = await db.get<DealRow>("SELECT * FROM deals WHERE id = ?", [id]);
  if (!row) throw new Error(`Deal not found: ${id}`);
  return row;
}

async function recordDealRevision(db: Db, row: DealRow, ticketId: string | null): Promise<void> {
  await db.run(
    `INSERT INTO deal_revisions (id, deal_id, revision, title, value, currency, stage, expected_close, notes, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), row.id, row.revision, row.title, row.value, row.currency, row.stage, row.expected_close, row.notes, ticketId]
  );
}

export async function create_deal(db: Db, args: Record<string, any>) {
  // ticket_id: Suveren mandate ticket (Content Provenance §4.1). Stored on
  // the existing receipt_id column (internal storage name, unchanged).
  const { contact_id, title, value, currency, stage, expected_close, notes, contact_type, ticket_id } = args;
  const id = uuidv4();

  const contact = await requireContact(db, contact_id);
  checkContactType(contact, contact_type);

  await db.run(
    `INSERT INTO deals (id, contact_id, title, value, currency, stage, expected_close, notes, receipt_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
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

  const row = await db.get<DealRow>("SELECT * FROM deals WHERE id = ?", [id]);
  await recordDealRevision(db, row!, ticket_id ?? null);
  recordChangeMeta(row!, { oldValues: null, newValues: { ...row! } });
  return row!;
}

const UPDATABLE_FIELDS = ["title", "value", "currency", "stage", "expected_close", "notes"] as const;

export async function update_deal(db: Db, args: Record<string, any>) {
  const { id, revision, contact_type, ticket_id, ...fields } = args;

  const deal = await requireDeal(db, id);
  requireCurrentRevision("Deal", id, deal.revision, revision);

  if (contact_type !== undefined) {
    const contact = await requireContact(db, deal.contact_id);
    checkContactType(contact, contact_type);
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
    oldValues[key] = (deal as any)[key];
    newValues[key] = fields[key];
    setClauses.push(`${key} = ?`);
    params.push(fields[key]);
  }

  const nextRevision = deal.revision + 1;
  setClauses.push("revision = ?");
  params.push(nextRevision);
  setClauses.push("updated_at = datetime('now')");

  if (ticket_id !== undefined) {
    setClauses.push("receipt_id = ?");
    params.push(ticket_id);
  }

  params.push(id);

  await db.run(
    `UPDATE deals SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );

  const row = await db.get<DealRow>("SELECT * FROM deals WHERE id = ?", [id]);
  if (!row) throw new Error(`Deal not found: ${id}`);
  await recordDealRevision(db, row, ticket_id ?? null);
  recordChangeMeta(row, { oldValues, newValues });
  return row;
}

export async function get_deal(db: Db, args: Record<string, any>) {
  const { id, revision } = args;
  const deal = await requireDeal(db, id);

  if (revision === undefined || revision === deal.revision) {
    return deal;
  }

  const snapshot = await db.get<DealRevisionRow>(
    "SELECT * FROM deal_revisions WHERE deal_id = ? AND revision = ?",
    [id, revision]
  );
  if (!snapshot) {
    throw new Error(`Unknown revision ${JSON.stringify(revision)} for deal ${deal.title} (${id})`);
  }
  return {
    ...deal,
    revision: snapshot.revision,
    title: snapshot.title,
    value: snapshot.value,
    currency: snapshot.currency,
    stage: snapshot.stage,
    expected_close: snapshot.expected_close,
    notes: snapshot.notes,
  };
}

export async function get_pipeline(db: Db, args: Record<string, any>) {
  const { stage, sort_by = "expected_close", include_archived } = args;

  const allowedSortFields = ["expected_close", "value", "created_at", "updated_at", "title"];
  const sortField = allowedSortFields.includes(sort_by) ? sort_by : "expected_close";

  const conditions: string[] = [];
  const params: any[] = [];

  if (stage) {
    conditions.push("deals.stage = ?");
    params.push(stage);
  }
  if (!include_archived) {
    conditions.push("(contacts.archived IS NULL OR contacts.archived = 0)");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await db.all<DealRow>(
    `SELECT deals.* FROM deals LEFT JOIN contacts ON contacts.id = deals.contact_id ${where} ORDER BY deals.${sortField} ASC NULLS LAST`,
    params
  );

  return rows;
}
