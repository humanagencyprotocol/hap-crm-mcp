import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";

interface Task {
  id: string;
  contact_id: string | null;
  deal_id: string | null;
  title: string;
  due_date: string | null;
  status: string;
  assigned_to: string | null;
  created_at: string;
}

export async function create_task(db: Db, args: Record<string, any>) {
  const { title, contact_id, deal_id, due_date, assigned_to } = args;
  const id = uuidv4();

  await db.run(
    `INSERT INTO tasks (id, contact_id, deal_id, title, due_date, assigned_to)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      contact_id ?? null,
      deal_id ?? null,
      title,
      due_date ?? null,
      assigned_to ?? null,
    ]
  );

  const row = await db.get<Task>("SELECT * FROM tasks WHERE id = ?", [id]);
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

  const rows = await db.all<Task>(
    `SELECT * FROM tasks ${where} ORDER BY due_date ASC NULLS LAST, created_at ASC`,
    params
  );

  return rows;
}

export async function complete_task(db: Db, args: Record<string, any>) {
  const { id } = args;

  const row = await db.get<Task>("SELECT id, title FROM tasks WHERE id = ?", [id]);
  if (!row) throw new Error(`Task not found: ${id}`);

  await db.run("UPDATE tasks SET status = 'done' WHERE id = ?", [id]);

  return { message: `Task "${row.title}" (${id}) marked as done.` };
}
