/**
 * Migration from the pre-revision schema: a demo database on a real machine
 * already exists with the OLD schema (no revision/archived columns, no
 * snapshot tables, and the ON DELETE CASCADE from contacts to
 * activities/deals that let delete_contact silently destroy history). This
 * must migrate safely, idempotently, and without losing anything — built
 * directly against an OLD-schema fixture (not through createDb), run twice.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { createDb, type Db } from "../src/db.js";

const tmp = (ext: string) => join(tmpdir(), `crm-migrate-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

/** The schema this connector shipped before the revision rule — verbatim from
 * src/db.ts at the commit before this migration was added (see git history). */
const OLD_SCHEMA = `
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  role TEXT,
  type TEXT CHECK(type IN ('customer','lead','partner','vendor')) DEFAULT 'customer',
  stage TEXT CHECK(stage IN ('new','active','inactive','churned')) DEFAULT 'new',
  tags TEXT DEFAULT '[]',
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

CREATE TABLE activities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT CHECK(type IN ('email','call','meeting','note','purchase')) NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  date TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  receipt_id TEXT
);

CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  value REAL,
  currency TEXT DEFAULT 'USD',
  stage TEXT CHECK(stage IN ('lead','qualified','proposal','negotiation','won','lost')) DEFAULT 'lead',
  expected_close TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  status TEXT CHECK(status IN ('open','done')) DEFAULT 'open',
  assigned_to TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

CREATE TABLE refusals (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  receipt_id TEXT,
  message TEXT NOT NULL
);

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  receipt_id TEXT,
  document_id TEXT,
  summary TEXT
);

CREATE TABLE simulation_load (
  id TEXT PRIMARY KEY,
  at TEXT DEFAULT (datetime('now')),
  name TEXT NOT NULL,
  package_sha256 TEXT NOT NULL
);
`;

let dbPath: string;
let db: Db | undefined;

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined;
  dbPath = "";
});

/** Builds a fixture database on the OLD schema, with real data: a contact,
 * an activity and a deal tied to it (both under the old cascading FK), and a
 * task — exactly what a demo account on a real machine would already hold. */
async function buildOldFixture(): Promise<{ path: string; contactId: string; activityId: string; dealId: string; taskId: string }> {
  const { default: Database } = await import("better-sqlite3");
  const path = tmp("db");
  const raw = new Database(path);
  raw.pragma("foreign_keys = ON");
  raw.exec(OLD_SCHEMA);

  const contactId = randomUUID();
  const activityId = randomUUID();
  const dealId = randomUUID();
  const taskId = randomUUID();

  raw.prepare(
    `INSERT INTO contacts (id, name, email, type, stage, tags, notes, receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(contactId, "Huber Maschinenbau", "einkauf@huber.example", "customer", "active", "[\"vip\"]", "Existing demo contact", "t-old");
  raw.prepare(
    `INSERT INTO activities (id, contact_id, type, summary, receipt_id) VALUES (?, ?, ?, ?, ?)`
  ).run(activityId, contactId, "call", "intro call", "t-old-act");
  raw.prepare(
    `INSERT INTO deals (id, contact_id, title, value, currency, stage, receipt_id) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(dealId, contactId, "Renewal", 4500, "EUR", "proposal", "t-old-deal");
  raw.prepare(
    `INSERT INTO tasks (id, contact_id, title, status, receipt_id) VALUES (?, ?, ?, ?, ?)`
  ).run(taskId, contactId, "Follow up", "open", "t-old-task");

  // Sanity: the OLD schema really does cascade — confirms the fixture matches
  // what shipped before this migration, not an accidental copy of the new one.
  const fks = raw.prepare(`PRAGMA foreign_key_list(activities)`).all() as Array<{ on_delete: string }>;
  if (!fks.some((fk) => fk.on_delete === "CASCADE")) {
    throw new Error("fixture setup error: OLD_SCHEMA was expected to cascade on delete");
  }

  raw.close();
  return { path, contactId, activityId, dealId, taskId };
}

describe("migrating a database created on the pre-revision schema", () => {
  it("adds revision/archived columns, defaulting existing rows to revision 1 and not archived", async () => {
    const fixture = await buildOldFixture();
    dbPath = fixture.path;
    process.env.DATABASE_URL = dbPath;
    db = await createDb(null);

    const contact = await db.get<any>(`SELECT * FROM contacts WHERE id = ?`, [fixture.contactId]);
    expect(contact.revision).toBe(1);
    expect(contact.archived).toBe(0);
    expect(contact.name).toBe("Huber Maschinenbau"); // nothing lost

    const deal = await db.get<any>(`SELECT * FROM deals WHERE id = ?`, [fixture.dealId]);
    expect(deal.revision).toBe(1);
    expect(deal.title).toBe("Renewal");

    const task = await db.get<any>(`SELECT * FROM tasks WHERE id = ?`, [fixture.taskId]);
    expect(task.revision).toBe(1);
  });

  it("backfills a revision-1 snapshot for every existing contact/deal/task", async () => {
    const fixture = await buildOldFixture();
    dbPath = fixture.path;
    process.env.DATABASE_URL = dbPath;
    db = await createDb(null);

    const contactSnap = await db.get<any>(`SELECT * FROM contact_revisions WHERE contact_id = ? AND revision = 1`, [fixture.contactId]);
    expect(contactSnap.name).toBe("Huber Maschinenbau");
    expect(contactSnap.notes).toBe("Existing demo contact");

    const dealSnap = await db.get<any>(`SELECT * FROM deal_revisions WHERE deal_id = ? AND revision = 1`, [fixture.dealId]);
    expect(dealSnap.title).toBe("Renewal");

    const taskSnap = await db.get<any>(`SELECT * FROM task_revisions WHERE task_id = ? AND revision = 1`, [fixture.taskId]);
    expect(taskSnap.title).toBe("Follow up");
  });

  it("drops the ON DELETE CASCADE from contacts to activities and deals — data integrity is enforced, not silently lost", async () => {
    const fixture = await buildOldFixture();
    dbPath = fixture.path;
    process.env.DATABASE_URL = dbPath;
    db = await createDb(null);

    // Before this migration, this raw delete would have silently taken the
    // activity and deal with it. Now it must be rejected outright — nothing
    // is destroyed, visibly or invisibly.
    await expect(db.run(`DELETE FROM contacts WHERE id = ?`, [fixture.contactId])).rejects.toThrow(/FOREIGN KEY constraint failed/);

    expect(await db.get(`SELECT * FROM contacts WHERE id = ?`, [fixture.contactId])).toBeDefined();
    expect(await db.get(`SELECT * FROM activities WHERE id = ?`, [fixture.activityId])).toBeDefined();
    expect(await db.get(`SELECT * FROM deals WHERE id = ?`, [fixture.dealId])).toBeDefined();
  });

  it("loses nothing: every pre-existing row and column value survives the migration", async () => {
    const fixture = await buildOldFixture();
    dbPath = fixture.path;
    process.env.DATABASE_URL = dbPath;
    db = await createDb(null);

    expect(await db.all(`SELECT * FROM contacts`)).toHaveLength(1);
    expect(await db.all(`SELECT * FROM activities`)).toHaveLength(1);
    expect(await db.all(`SELECT * FROM deals`)).toHaveLength(1);
    expect(await db.all(`SELECT * FROM tasks`)).toHaveLength(1);

    const activity = await db.get<any>(`SELECT * FROM activities WHERE id = ?`, [fixture.activityId]);
    expect(activity.receipt_id).toBe("t-old-act");
    const deal = await db.get<any>(`SELECT * FROM deals WHERE id = ?`, [fixture.dealId]);
    expect(deal.value).toBe(4500);
    expect(deal.receipt_id).toBe("t-old-deal");
  });

  it("is idempotent: running the migration twice changes nothing further", async () => {
    const fixture = await buildOldFixture();
    dbPath = fixture.path;
    process.env.DATABASE_URL = dbPath;
    db = await createDb(null);
    await db.close();

    // Second run: a fresh createDb() call against the now-migrated database —
    // the guarded ALTER/backfill/cascade-drop steps must all no-op.
    db = await createDb(null);

    const contact = await db.get<any>(`SELECT * FROM contacts WHERE id = ?`, [fixture.contactId]);
    expect(contact.revision).toBe(1);
    expect(contact.archived).toBe(0);

    expect(await db.all(`SELECT * FROM contact_revisions WHERE contact_id = ?`, [fixture.contactId])).toHaveLength(1);
    expect(await db.all(`SELECT * FROM deal_revisions WHERE deal_id = ?`, [fixture.dealId])).toHaveLength(1);
    expect(await db.all(`SELECT * FROM task_revisions WHERE task_id = ?`, [fixture.taskId])).toHaveLength(1);

    await expect(db.run(`DELETE FROM contacts WHERE id = ?`, [fixture.contactId])).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("the migrated database works with the new tools — update_contact and delete_contact (archive) both succeed", async () => {
    const fixture = await buildOldFixture();
    dbPath = fixture.path;
    process.env.DATABASE_URL = dbPath;
    db = await createDb(null);

    const { callTool } = await import("../src/dispatch.js");
    const updated = (await callTool(db, "simulation", "update_contact", { id: fixture.contactId, revision: 1, stage: "inactive", contact_type: "customer" })) as any;
    expect(updated.revision).toBe(2);

    const archived = (await callTool(db, "simulation", "delete_contact", { id: fixture.contactId, revision: 2, contact_type: "customer" })) as any;
    expect(archived.archived).toBe(true);

    // Still no cascade: the activity and deal survive the archive too.
    expect(await db.get(`SELECT * FROM activities WHERE id = ?`, [fixture.activityId])).toBeDefined();
    expect(await db.get(`SELECT * FROM deals WHERE id = ?`, [fixture.dealId])).toBeDefined();
  });
});
