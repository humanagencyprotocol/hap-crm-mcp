import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";

interface Contact {
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
}

function parseContact(row: Contact) {
  return {
    ...row,
    tags: (() => {
      try {
        return JSON.parse(row.tags ?? "[]");
      } catch {
        return [];
      }
    })(),
  };
}

export async function create_contact(db: Db, args: Record<string, any>) {
  const { name, email, phone, company, role, type, stage, tags, notes } = args;
  const id = uuidv4();
  const tagsJson = JSON.stringify(tags ?? []);

  await db.run(
    `INSERT INTO contacts (id, name, email, phone, company, role, type, stage, tags, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ]
  );

  const row = await db.get<Contact>("SELECT * FROM contacts WHERE id = ?", [id]);
  return parseContact(row!);
}

export async function find_contacts(db: Db, args: Record<string, any>) {
  const { query, type, stage, limit = 50 } = args;

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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);

  const rows = await db.all<Contact>(
    `SELECT * FROM contacts ${where} ORDER BY created_at DESC LIMIT ?`,
    params
  );

  return rows.map(parseContact);
}

export async function update_contact(db: Db, args: Record<string, any>) {
  const { id, ...fields } = args;

  const updatable = ["name", "email", "phone", "company", "role", "type", "stage", "tags", "notes"];
  const setClauses: string[] = [];
  const params: any[] = [];

  for (const key of updatable) {
    if (key in fields) {
      setClauses.push(`${key} = ?`);
      params.push(key === "tags" ? JSON.stringify(fields[key]) : fields[key]);
    }
  }

  if (setClauses.length === 0) {
    throw new Error("No fields to update");
  }

  setClauses.push("updated_at = datetime('now')");
  params.push(id);

  await db.run(
    `UPDATE contacts SET ${setClauses.join(", ")} WHERE id = ?`,
    params
  );

  const row = await db.get<Contact>("SELECT * FROM contacts WHERE id = ?", [id]);
  if (!row) throw new Error(`Contact not found: ${id}`);
  return parseContact(row);
}

export async function delete_contact(db: Db, args: Record<string, any>) {
  const { id } = args;

  const row = await db.get<Contact>("SELECT id, name FROM contacts WHERE id = ?", [id]);
  if (!row) throw new Error(`Contact not found: ${id}`);

  await db.run("DELETE FROM contacts WHERE id = ?", [id]);

  return { message: `Contact "${row.name}" (${id}) deleted successfully.` };
}
