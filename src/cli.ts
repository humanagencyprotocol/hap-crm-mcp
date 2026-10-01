/**
 * Local operator command. Deliberately NOT an MCP tool: the agent under test must
 * be able neither to read nor to change the record its work is measured by.
 *
 *   crm-mcp export   everything needed to line up ticket -> effect (changes + refusals)
 */
import { createDb, type Db } from "./db.js";
import { getMode } from "./mode.js";

export async function exportRecord(db: Db, mode = getMode()) {
  return {
    mode,
    exported_at: new Date().toISOString(),
    contacts: await db.all<any>(`SELECT * FROM contacts ORDER BY created_at ASC`),
    deals: await db.all<any>(`SELECT * FROM deals ORDER BY created_at ASC`),
    tasks: await db.all<any>(`SELECT * FROM tasks ORDER BY created_at ASC`),
    activities: await db.all<any>(`SELECT * FROM activities ORDER BY date ASC`),
    changes: await db.all<any>(`SELECT * FROM changes ORDER BY at`),
    refusals: await db.all<any>(`SELECT * FROM refusals ORDER BY at`),
  };
}

const USAGE = `usage: crm-mcp export`;

export async function runCli(argv: string[]): Promise<number> {
  const [cmd] = argv;
  try {
    if (cmd === "export") {
      const db = await createDb();
      process.stdout.write(JSON.stringify(await exportRecord(db), null, 2) + "\n");
      await db.close();
      return 0;
    }
    process.stderr.write(USAGE + "\n");
    return 2;
  } catch (err) {
    process.stderr.write(`[crm-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
