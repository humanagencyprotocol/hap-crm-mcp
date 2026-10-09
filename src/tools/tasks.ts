import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { requireContact, checkContactType } from "./contacts.js";
import { requireCurrentRevision } from "../revision.js";
import { recordChangeMeta } from "../change-meta.js";

export interface TaskRow {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  title: string;
  due_date: string | null;
  status: string;
  assigned_to: string | null;
  created_at: string;
  receipt_id: string | null;
  revision: number;
}

/** A snapshot row from `task_revisions` — the frozen content of one past revision. */
interface TaskRevisionRow {
  id: string;
  task_id: string;
  revision: number;
  title: string;
  due_date: string | null;
  status: string;
  assigned_to: string | null;
  created_at: string;
  receipt_id: string | null;
}

export async function requireTask(db: Db, id: string): Promise<TaskRow> {
  const row = await db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
  if (!row) throw new Error(`Task not found: ${id}`);
  return row;
}

async function recordTaskRevision(db: Db, row: TaskRow, ticketId: string | null): Promise<void> {
  await db.run(
    `INSERT INTO task_revisions (id, task_id, revision, title, due_date, status, assigned_to, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuidv4(), row.id, row.revision, row.title, row.due_date, row.status, row.assigned_to, ticketId]
  );
}

export async function create_task(db: Db, args: Record<string, any>) {
  // ticket_id: Suveren mandate ticket (Content Provenance §4.1). Stored on
  // the existing receipt_id column (internal storage name, unchanged).
  const { title, contact_id, deal_id, due_date, assigned_to, contact_type, ticket_id } = args;
  const id = uuidv4();

  if (contact_id) {
    const contact = await requireContact(db, contact_id);
    checkContactType(contact, contact_type);
  }

  await db.run(
    `INSERT INTO tasks (id, contact_id, deal_id, title, due_date, assigned_to, receipt_id, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      id,
      contact_id ?? null,
      deal_id ?? null,
      title,
      due_date ?? null,
      assigned_to ?? null,
      ticket_id ?? null,
    ]
  );

  const row = await db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
  await recordTaskRevision(db, row!, ticket_id ?? null);
  recordChangeMeta(row!, { oldValues: null, newValues: { ...row! } });
  return row!;
}

export async function list_tasks(db: Db, args: Record<string, any>) {
  const { status = "open", contact_id, deal_id, assigned_to } = args;

  const conditions: string[] = [];
  const params: any[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (contact_id) {
    conditions.push("contact_id = ?");
    params.push(contact_id);
  }
  if (deal_id) {
    conditions.push("deal_id = ?");
    params.push(deal_id);
  }
  if (assigned_to) {
    conditions.push("assigned_to = ?");
    params.push(assigned_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await db.all<TaskRow>(
    `SELECT * FROM tasks ${where} ORDER BY due_date ASC NULLS LAST, created_at ASC`,
    params
  );

  return rows;
}

export async function get_task(db: Db, args: Record<string, any>) {
  const { id, revision } = args;
  const task = await requireTask(db, id);

  if (revision === undefined || revision === task.revision) {
    return task;
  }

  const snapshot = await db.get<TaskRevisionRow>(
    "SELECT * FROM task_revisions WHERE task_id = ? AND revision = ?",
    [id, revision]
  );
  if (!snapshot) {
    throw new Error(`Unknown revision ${JSON.stringify(revision)} for task ${task.title} (${id})`);
  }
  return {
    ...task,
    revision: snapshot.revision,
    title: snapshot.title,
    due_date: snapshot.due_date,
    status: snapshot.status,
    assigned_to: snapshot.assigned_to,
  };
}

export async function complete_task(db: Db, args: Record<string, any>) {
  // ticket_id: Suveren mandate ticket (Content Provenance §4.1). Stored on
  // the existing receipt_id column (internal storage name, unchanged).
  const { id, revision, ticket_id } = args;

  const task = await requireTask(db, id);
  requireCurrentRevision("Task", id, task.revision, revision);

  const nextRevision = task.revision + 1;
  await db.run(
    "UPDATE tasks SET status = 'done', revision = ?, receipt_id = ? WHERE id = ?",
    [nextRevision, ticket_id ?? task.receipt_id ?? null, id]
  );

  const row = await db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
  await recordTaskRevision(db, row!, ticket_id ?? null);

  const result = { message: `Task "${task.title}" (${id}) marked as done.`, id, revision: nextRevision, status: "done" as const };
  recordChangeMeta(result, { oldValues: { status: task.status }, newValues: { status: "done" } });
  return result;
}
