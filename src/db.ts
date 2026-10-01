import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadCompanyFile, companyContacts, type Company } from "./company.js";

export interface Db {
  run(sql: string, params?: any[]): Promise<void>;
  get<T>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T>(sql: string, params?: any[]): Promise<T[]>;
  close(): Promise<void>;
}

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
  receipt_id TEXT
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT CHECK(type IN ('email','call','meeting','note','purchase')) NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  date TEXT DEFAULT (datetime('now')),
  created_by TEXT,
  receipt_id TEXT
);

CREATE TABLE IF NOT EXISTS deals (
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

CREATE TABLE IF NOT EXISTS tasks (
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

-- Calls the connector refused AFTER the gateway let them through. When the gateway
-- injected a receipt_id, a ticket exists for an action that never happened; this
-- table is the only place that says so (the ticket alone reads like a done action).
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
-- document, is what lines up ticket <-> effect 1:1.
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  receipt_id TEXT,
  document_id TEXT,
  summary TEXT
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

/** Tables that carry an authorizing receipt_id (Content Provenance §4.1). */
const RECEIPT_ID_TABLES = ["contacts", "activities", "deals", "tasks"];

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

// SQLite adapter using better-sqlite3 (synchronous API wrapped in async)
async function createSqliteDb(dbPath: string, company: Company | null): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  seedSqlite(db, company);

  // Migration: add receipt_id to pre-existing tables (Content Provenance §4.1).
  // ALTER ... ADD COLUMN throws if it already exists, so guard on table_info.
  for (const table of RECEIPT_ID_TABLES) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "receipt_id")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN receipt_id TEXT`);
    }
  }

  return {
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
    // Migration: add receipt_id to pre-existing tables (Content Provenance §4.1).
    for (const table of RECEIPT_ID_TABLES) {
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS receipt_id TEXT`);
    }
    if (company) {
      const { rows } = await client.query("SELECT COUNT(*)::int as count FROM contacts");
      if (rows[0].count === 0) {
        const seed = contactRows(company);
        for (const r of seed) await client.query(adaptSql(INSERT_CONTACT), r);
        console.error(`[crm-mcp] seeded "${company.name}": ${seed.length} contacts`);
      } else {
        console.error("[crm-mcp] database already holds data — CRM_COMPANY_FILE not loaded (start from an empty database to load it)");
      }
    }
  } finally {
    client.release();
  }

  return {
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
