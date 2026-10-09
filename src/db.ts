import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { loadCompanyFile, companyContacts, type Company } from "./company.js";

export interface Db {
  run(sql: string, params?: any[]): Promise<void>;
  get<T>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T>(sql: string, params?: any[]): Promise<T[]>;
  close(): Promise<void>;
}

// Kept as their own constants (not inlined in SCHEMA) so the cascade-drop
// migration below can recreate these exact tables from the same definition
// used to create them fresh — one source of truth either way.
const ACTIVITIES_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  type TEXT CHECK(type IN ('email','call','meeting','note','purchase')) NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  date TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  receipt_id TEXT
);`;

const DEALS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  title TEXT NOT NULL,
  value REAL,
  currency TEXT DEFAULT 'USD',
  stage TEXT CHECK(stage IN ('lead','qualified','proposal','negotiation','won','lost')) DEFAULT 'lead',
  expected_close TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS contacts (
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
  receipt_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);

${ACTIVITIES_TABLE_SQL}

${DEALS_TABLE_SQL}

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  status TEXT CHECK(status IN ('open','done')) DEFAULT 'open',
  assigned_to TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

-- One frozen snapshot per contact revision — the content create_contact,
-- update_contact, delete_contact (archive), restore_contact, or
-- convert_contact produced, frozen the moment the next revision exists.
-- get_contact's optional "revision" argument reads an old one from here.
CREATE TABLE IF NOT EXISTS contact_revisions (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  role TEXT,
  type TEXT NOT NULL,
  stage TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_revisions_contact_id_revision
  ON contact_revisions (contact_id, revision);

-- One frozen snapshot per deal revision — same purpose as contact_revisions.
CREATE TABLE IF NOT EXISTS deal_revisions (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  value REAL,
  currency TEXT,
  stage TEXT NOT NULL,
  expected_close TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS deal_revisions_deal_id_revision
  ON deal_revisions (deal_id, revision);

-- One frozen snapshot per task revision — same purpose as contact_revisions.
CREATE TABLE IF NOT EXISTS task_revisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  status TEXT NOT NULL,
  assigned_to TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  receipt_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS task_revisions_task_id_revision
  ON task_revisions (task_id, revision);

-- Calls the connector refused AFTER the gateway let them through. When the gateway
-- injected a ticket_id, a ticket exists for an action that never happened; this
-- table is the only place that says so (the ticket alone reads like a done action).
-- Column kept as receipt_id (internal storage name, unchanged by the v0.7 wire
-- rename of the tool argument).
CREATE TABLE IF NOT EXISTS refusals (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  receipt_id TEXT,
  message TEXT NOT NULL
);

-- Every change the CRM performed, one row per call — the effect each ticket
-- produced. A document's own receipt_id column holds only its latest ticket
-- (e.g. update_contact overwrites create_contact's), so this table, not the
-- document, is what lines up ticket <-> effect 1:1. "revision" is the
-- resulting record's revision after the change (null for record types that
-- carry none, e.g. activities). "old_values"/"new_values" are JSON objects
-- of only the fields the change actually touched. Column kept as receipt_id
-- (internal storage name, unchanged by the v0.7 wire rename of the tool
-- argument).
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  receipt_id TEXT,
  document_id TEXT,
  summary TEXT,
  revision INTEGER,
  old_values TEXT,
  new_values TEXT
);

-- The simulation package load_simulation loaded into this (then-empty) database,
-- if any. A row here is both the proof a package was loaded and the create-only
-- guard: load_simulation refuses while this table is non-empty.
CREATE TABLE IF NOT EXISTS simulation_load (
  id TEXT PRIMARY KEY,
  at TEXT DEFAULT (datetime('now')),
  name TEXT NOT NULL,
  package_sha256 TEXT NOT NULL
);
`;

/**
 * Tables that carry an authorizing ticket id (Content Provenance §4.1), stored
 * in the receipt_id column — internal storage name, unchanged by the v0.7 wire
 * rename of the tool argument (receipt_id -> ticket_id).
 */
const RECEIPT_ID_TABLES = ["contacts", "activities", "deals", "tasks"];

/**
 * Columns added to tables that may already exist from before this column was
 * introduced. `sqliteDdl`/`postgresDdl` are the full `ADD COLUMN` type+default
 * clause for each backend — kept separate because SQLite and Postgres accept
 * slightly different syntax for the same default (here they happen to agree,
 * but the ERP connector's equivalent table needed the split, so this connector
 * keeps the same shape for consistency).
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; sqliteDdl: string; postgresDdl: string }> = [
  { table: "contacts", column: "revision", sqliteDdl: "INTEGER NOT NULL DEFAULT 1", postgresDdl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "contacts", column: "archived", sqliteDdl: "INTEGER NOT NULL DEFAULT 0", postgresDdl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "deals", column: "revision", sqliteDdl: "INTEGER NOT NULL DEFAULT 1", postgresDdl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "tasks", column: "revision", sqliteDdl: "INTEGER NOT NULL DEFAULT 1", postgresDdl: "INTEGER NOT NULL DEFAULT 1" },
  { table: "changes", column: "revision", sqliteDdl: "INTEGER", postgresDdl: "INTEGER" },
  { table: "changes", column: "old_values", sqliteDdl: "TEXT", postgresDdl: "TEXT" },
  { table: "changes", column: "new_values", sqliteDdl: "TEXT", postgresDdl: "TEXT" },
];

/** The company to seed from: CRM_COMPANY_FILE if set (refused whole if invalid), else none. */
export function resolveCompany(env: NodeJS.ProcessEnv = process.env): Company | null {
  const path = env.CRM_COMPANY_FILE?.trim();
  return path ? loadCompanyFile(path) : null;
}

const INSERT_CONTACT = `INSERT INTO contacts (id, name, email, phone, company, role, type, stage, tags, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function contactRows(company: Company): any[][] {
  return companyContacts(company).map((ct) => [
    ct.id, ct.name, ct.email, ct.phone, ct.company, ct.role, ct.type, ct.stage, JSON.stringify(ct.tags), ct.notes,
  ]);
}

function seedSqlite(db: import("better-sqlite3").Database, company: Company | null): void {
  if (!company) return;
  const { count } = db.prepare("SELECT COUNT(*) as count FROM contacts").get() as { count: number };
  if (count > 0) {
    console.error("[crm-mcp] database already holds data — CRM_COMPANY_FILE not loaded (start from an empty database to load it)");
    return;
  }
  const rows = contactRows(company);
  const insert = db.prepare(INSERT_CONTACT);
  db.transaction(() => {
    for (const r of rows) insert.run(...r);
  })();
  console.error(`[crm-mcp] seeded "${company.name}": ${rows.length} contacts`);
}

interface ContactRowForBackfill {
  id: string; revision: number; name: string; email: string | null; phone: string | null;
  company: string | null; role: string | null; type: string; stage: string; tags: string;
  notes: string | null; archived: number; created_at: string; receipt_id: string | null;
}
interface DealRowForBackfill {
  id: string; revision: number; title: string; value: number | null; currency: string | null;
  stage: string; expected_close: string | null; notes: string | null; created_at: string; receipt_id: string | null;
}
interface TaskRowForBackfill {
  id: string; revision: number; title: string; due_date: string | null; status: string;
  assigned_to: string | null; created_at: string; receipt_id: string | null;
}

/**
 * Backfills the revision snapshot tables for any contact/deal/task that does
 * not yet have a snapshot at its current revision — a database created
 * before these tables existed has records but no snapshots at all; one
 * created after they exist has them for every record going forward.
 * Idempotent: inserts nothing for a record that already has its snapshot, so
 * re-running this on an already-migrated database (including a demo
 * database on a real machine) is a no-op.
 */
async function backfillRevisionSnapshots(db: Db): Promise<void> {
  const contacts = await db.all<ContactRowForBackfill>("SELECT * FROM contacts");
  for (const c of contacts) {
    const existing = await db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM contact_revisions WHERE contact_id = ? AND revision = ?",
      [c.id, c.revision]
    );
    if ((existing?.n ?? 0) > 0) continue;
    await db.run(
      `INSERT INTO contact_revisions (id, contact_id, revision, name, email, phone, company, role, type, stage, tags, notes, archived, created_at, receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), c.id, c.revision, c.name, c.email, c.phone, c.company, c.role, c.type, c.stage, c.tags, c.notes, c.archived ?? 0, c.created_at, c.receipt_id ?? null]
    );
  }

  const deals = await db.all<DealRowForBackfill>("SELECT * FROM deals");
  for (const d of deals) {
    const existing = await db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM deal_revisions WHERE deal_id = ? AND revision = ?",
      [d.id, d.revision]
    );
    if ((existing?.n ?? 0) > 0) continue;
    await db.run(
      `INSERT INTO deal_revisions (id, deal_id, revision, title, value, currency, stage, expected_close, notes, created_at, receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), d.id, d.revision, d.title, d.value, d.currency, d.stage, d.expected_close, d.notes, d.created_at, d.receipt_id ?? null]
    );
  }

  const tasks = await db.all<TaskRowForBackfill>("SELECT * FROM tasks");
  for (const t of tasks) {
    const existing = await db.get<{ n: number }>(
      "SELECT COUNT(*) as n FROM task_revisions WHERE task_id = ? AND revision = ?",
      [t.id, t.revision]
    );
    if ((existing?.n ?? 0) > 0) continue;
    await db.run(
      `INSERT INTO task_revisions (id, task_id, revision, title, due_date, status, assigned_to, created_at, receipt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), t.id, t.revision, t.title, t.due_date, t.status, t.assigned_to, t.created_at, t.receipt_id ?? null]
    );
  }
}

/**
 * SQLite cannot alter a foreign key's ON DELETE action in place — the only
 * way to drop it is to recreate the table. Detects whether `table`'s FK to
 * its parent still cascades (true only for a database created before this
 * migration existed) and, if so, recreates it from `createSql` (the exact
 * definition this file creates the table from when fresh), copying every
 * row across inside a transaction with foreign keys held off for the swap.
 * Idempotent: a table already recreated (no cascade left) is left alone on
 * a second run, so running this twice — or against a database that was
 * never on the old schema — is a no-op either way.
 */
function dropCascadeSqlite(db: import("better-sqlite3").Database, table: string, createSql: string): void {
  const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ on_delete: string }>;
  const hasCascade = fks.some((fk) => fk.on_delete === "CASCADE");
  if (!hasCascade) return;

  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const colList = cols.join(", ");
  const oldTable = `${table}_cascade_old`;

  const foreignKeysWereOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  db.pragma("foreign_keys = OFF");
  const tx = db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${oldTable}`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${table} (${colList}) SELECT ${colList} FROM ${oldTable}`);
    db.exec(`DROP TABLE ${oldTable}`);
  });
  tx();
  if (foreignKeysWereOn) db.pragma("foreign_keys = ON");
  console.error(`[crm-mcp] migrated ${table}: dropped ON DELETE CASCADE to contacts`);
}

/**
 * Postgres equivalent of dropCascadeSqlite: a foreign key's ON DELETE action
 * can be altered without touching the table's rows (DROP CONSTRAINT / ADD
 * CONSTRAINT), so no copy is needed. `confdeltype = 'c'` is Postgres's own
 * marker for CASCADE. Idempotent for the same reason as the SQLite version.
 */
/** Minimal shape of a pg client/pool query method — kept local instead of importing
 * pg's own types, since pg is an optional peer dependency not always installed. */
interface SqlQueryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

async function dropCascadePostgres(client: SqlQueryable, table: string, column: string, refTable: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT con.conname, con.confdeltype FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = $1 AND con.contype = 'f'`,
    [table]
  );
  for (const row of rows as Array<{ conname: string; confdeltype: string }>) {
    if (row.confdeltype === "c") {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT ${row.conname}`);
      await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${row.conname} FOREIGN KEY (${column}) REFERENCES ${refTable}(id)`);
      console.error(`[crm-mcp] migrated ${table}: dropped ON DELETE CASCADE to ${refTable}`);
    }
  }
}

// SQLite adapter using better-sqlite3 (synchronous API wrapped in async)
async function createSqliteDb(dbPath: string, company: Company | null): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedSqlite(db, company);

  // Migration: add receipt_id column to pre-existing tables (Content Provenance §4.1).
  // ALTER ... ADD COLUMN throws if it already exists, so guard on table_info.
  for (const table of RECEIPT_ID_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "receipt_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN receipt_id TEXT`);
    }
  }
  // Migration: revision/archived/change-log columns (see ADDED_COLUMNS) — same guarded-ALTER pattern.
  for (const { table, column, sqliteDdl } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqliteDdl}`);
    }
  }
  // Migration: drop the ON DELETE CASCADE from contacts to activities/deals —
  // a database from before this version silently destroyed activities and
  // deals when their contact was deleted; archiving replaces deletion going
  // forward, but a database still on the old schema must stop cascading too.
  dropCascadeSqlite(db, "activities", ACTIVITIES_TABLE_SQL);
  dropCascadeSqlite(db, "deals", DEALS_TABLE_SQL);

  const wrapped: Db = {
    async run(sql: string, params: any[] = []): Promise<void> {
      db.prepare(sql).run(...params);
    },
    async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: any[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async close(): Promise<void> {
      db.close();
    },
  };
  await backfillRevisionSnapshots(wrapped);
  return wrapped;
}

// Postgres adapter using pg Pool
async function createPostgresDb(connectionString: string, company: Company | null): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });

  // Adapt SQLite-style ? placeholders to Postgres $1, $2, ... style
  function adaptSql(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  // Postgres uses SERIAL/TIMESTAMP differently — run schema adapted for PG
  const pgSchema = SCHEMA
    .replace(/datetime\('now'\)/g, "NOW()")
    .replace(/TEXT CHECK\(type IN \('email','call','meeting','note','purchase'\)\)/g,
      "TEXT CHECK(type IN ('email','call','meeting','note','purchase'))")
    .replace(/TEXT CHECK\(type IN \('customer','lead','partner','vendor'\)\)/g,
      "TEXT CHECK(type IN ('customer','lead','partner','vendor'))")
    .replace(/TEXT CHECK\(stage IN \('new','active','inactive','churned'\)\)/g,
      "TEXT CHECK(stage IN ('new','active','inactive','churned'))")
    .replace(/TEXT CHECK\(stage IN \('lead','qualified','proposal','negotiation','won','lost'\)\)/g,
      "TEXT CHECK(stage IN ('lead','qualified','proposal','negotiation','won','lost'))")
    .replace(/TEXT CHECK\(status IN \('open','done'\)\)/g,
      "TEXT CHECK(status IN ('open','done'))");

  const client = await pool.connect();
  try {
    await client.query(pgSchema);
    // Migration: add receipt_id column to pre-existing tables (Content Provenance §4.1).
    for (const table of RECEIPT_ID_TABLES) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS receipt_id TEXT`);
    }
    // Migration: revision/archived/change-log columns (see ADDED_COLUMNS) — same guarded-ALTER pattern.
    for (const { table, column, postgresDdl } of ADDED_COLUMNS) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${postgresDdl}`);
    }
    // Migration: drop the ON DELETE CASCADE from contacts to activities/deals (see the SQLite path above).
    await dropCascadePostgres(client, "activities", "contact_id", "contacts");
    await dropCascadePostgres(client, "deals", "contact_id", "contacts");

    const { rows } = await client.query("SELECT COUNT(*)::int as count FROM contacts");
    if (company && rows[0].count === 0) {
      const seed = contactRows(company);
      for (const r of seed) await client.query(adaptSql(INSERT_CONTACT), r);
      console.error(`[crm-mcp] seeded "${company.name}": ${seed.length} contacts`);
    } else if (company) {
      console.error("[crm-mcp] database already holds data — CRM_COMPANY_FILE not loaded (start from an empty database to load it)");
    }
  } finally {
    client.release();
  }

  const wrapped: Db = {
    async run(sql: string, params: any[] = []): Promise<void> {
      await pool.query(adaptSql(sql), params);
    },
    async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows[0] as T | undefined;
    },
    async all<T>(sql: string, params: any[] = []): Promise<T[]> {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows as T[];
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
  await backfillRevisionSnapshots(wrapped);
  return wrapped;
}

function maybeBackupSqlite(dbPath: string): void {
  const backupPath = dbPath.replace(/\.db$/, ".backup.db");
  if (!existsSync(dbPath)) return;

  const shouldBackup =
    !existsSync(backupPath) ||
    Date.now() - statSync(backupPath).mtimeMs > 24 * 60 * 60 * 1000;

  if (shouldBackup) {
    try {
      copyFileSync(dbPath, backupPath);
      console.error(`[crm-mcp] backup written to ${backupPath}`);
    } catch (err) {
      console.error(`[crm-mcp] backup failed: ${err}`);
    }
  }
}

export async function createDb(company: Company | null = resolveCompany()): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    console.error("[crm-mcp] using Postgres");
    return createPostgresDb(databaseUrl, company);
  }

  // SQLite path — honor HAP_DATA_DIR so docker (with a mounted /app/data) and
  // local dev (~/.hap) write to the same place the gateway uses. The gateway
  // injects HAP_DATA_DIR into the child env when spawning this MCP server.
  // Only create the data directory when the default path is actually used — an
  // explicit DATABASE_URL must not leave an empty ~/.hap behind.
  let dbPath = databaseUrl;
  if (!dbPath) {
    const hapDir = process.env.HAP_DATA_DIR ?? join(homedir(), ".hap");
    if (!existsSync(hapDir)) mkdirSync(hapDir, { recursive: true });
    dbPath = join(hapDir, "crm.db");
  }
  maybeBackupSqlite(dbPath);

  console.error(`[crm-mcp] using SQLite at ${dbPath}`);
  return createSqliteDb(dbPath, company);
}
