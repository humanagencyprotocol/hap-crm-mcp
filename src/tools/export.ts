import type { Db } from "../db.js";

export async function export_crm(db: Db, _args: Record<string, any>) {
  const [contacts, activities, deals, tasks] = await Promise.all([
    db.all("SELECT * FROM contacts ORDER BY created_at ASC"),
    db.all("SELECT * FROM activities ORDER BY date ASC"),
    db.all("SELECT * FROM deals ORDER BY created_at ASC"),
    db.all("SELECT * FROM tasks ORDER BY created_at ASC"),
  ]);

  return {
    contacts,
    activities,
    deals,
    tasks,
    exported_at: new Date().toISOString(),
  };
}
