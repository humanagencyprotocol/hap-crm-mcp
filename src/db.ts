import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT CHECK(type IN ('email','call','meeting','note','purchase')) NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  date TEXT DEFAULT (datetime('now')),
  created_by TEXT
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
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_date TEXT,
  status TEXT CHECK(status IN ('open','done')) DEFAULT 'open',
  assigned_to TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`;

// SQLite adapter using better-sqlite3 (synchronous API wrapped in async)
async function createSqliteDb(dbPath: string): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

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
async function createPostgresDb(connectionString: string): Promise<Db> {
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

export async function createDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    console.error("[crm-mcp] using Postgres");
    return createPostgresDb(databaseUrl);
  }

  // SQLite path — honor HAP_DATA_DIR so docker (with a mounted /app/data) and
  // local dev (~/.hap) write to the same place the gateway uses. The gateway
  // injects HAP_DATA_DIR into the child env when spawning this MCP server.
  const hapDir = process.env.HAP_DATA_DIR ?? join(homedir(), ".hap");
  if (!existsSync(hapDir)) {
    mkdirSync(hapDir, { recursive: true });
  }

  const dbPath = databaseUrl || join(hapDir, "crm.db");
  maybeBackupSqlite(dbPath);

  console.error(`[crm-mcp] using SQLite at ${dbPath}`);
  return createSqliteDb(dbPath);
}
