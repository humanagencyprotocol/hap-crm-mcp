/**
 * `clear_simulation` — deletes all test data so the same cases can run again under
 * another setup, or other cases under the same setup: clear, then load.
 *
 * - live mode refuses it like every other tool, deleting nothing;
 * - it deletes every table that holds test data, changes and refusals included;
 * - the clear itself stays recorded as one change with its receipt_id (the trace
 *   of its ticket), and that row does not block the next load;
 * - clear → load → work → clear → load runs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, readFileSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { LIVE_NOT_AVAILABLE } from "../src/mode.js";
import { callTool } from "../src/dispatch.js";
import { ALREADY_LOADED_MESSAGE } from "../src/tools/simulation.js";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
const TABLES = ["contacts", "activities", "deals", "tasks", "refusals", "simulation_load"];

let dbPath = "";
let db: Db | undefined;

async function freshDb() {
  dbPath = join(tmpdir(), `crm-clear-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  process.env.DATABASE_URL = dbPath;
  db = await createDb(null);
  return db;
}

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined;
  dbPath = "";
});

/** Load the package, then log an activity, open a deal and a task, and get one call refused. */
async function useIt(db: Db) {
  await callTool(db, "simulation", "load_simulation", { package: pkg, receipt_id: "t-load" });
  const [contact] = (await callTool(db, "simulation", "find_contacts", {})) as any[];
  await callTool(db, "simulation", "log_activity", { contact_id: contact.id, type: "note", summary: "called" });
  const deal = (await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal" })) as any;
  await callTool(db, "simulation", "create_task", { contact_id: contact.id, deal_id: deal.id, title: "Follow up" });
  await expect(callTool(db, "simulation", "load_simulation", { package: pkg, receipt_id: "t-refused" })).rejects.toThrow(ALREADY_LOADED_MESSAGE);
}

const count = async (db: Db, table: string) => Number((await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`))!.n);

describe("clear_simulation", () => {
  it("live mode refuses it and deletes nothing", async () => {
    const db = await freshDb();
    await useIt(db);
    await expect(callTool(db, "live", "clear_simulation", { receipt_id: "t-clear" })).rejects.toThrow(LIVE_NOT_AVAILABLE);
    expect(await count(db, "deals")).toBe(1);
    expect(await count(db, "simulation_load")).toBe(1);
  });

  it("deletes every table that holds test data, and records only the clear itself", async () => {
    const db = await freshDb();
    await useIt(db);
    for (const t of TABLES) expect(await count(db, t), t).toBeGreaterThan(0);

    const result = (await callTool(db, "simulation", "clear_simulation", { receipt_id: "t-clear" })) as any;
    expect(result.cleared).toBe(true);
    expect(result.deleted).toMatchObject({ deals: 1, tasks: 1, activities: 1, simulation_load: 1, refusals: 1 });

    for (const t of TABLES) expect(await count(db, t), t).toBe(0);
    expect(await db.all(`SELECT tool, receipt_id FROM changes`)).toEqual([{ tool: "clear_simulation", receipt_id: "t-clear" }]);
  });

  it("clear → load → work → clear → load runs", async () => {
    const db = await freshDb();
    await callTool(db, "simulation", "clear_simulation", {}); // on an empty CRM: harmless
    await useIt(db);
    await callTool(db, "simulation", "clear_simulation", { receipt_id: "t-clear" });
    const again = (await callTool(db, "simulation", "load_simulation", { package: pkg, receipt_id: "t-load-2" })) as any;
    expect(again.contacts_loaded).toBeGreaterThan(0);
    expect(await db.all(`SELECT tool, receipt_id FROM changes ORDER BY at`)).toEqual([
      { tool: "clear_simulation", receipt_id: "t-clear" },
      { tool: "load_simulation", receipt_id: "t-load-2" },
    ]);
  });
});
