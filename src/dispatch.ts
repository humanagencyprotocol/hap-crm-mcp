/**
 * One entry point for every tool call — used by the MCP server and by the tests,
 * so the tests exercise exactly what the server runs.
 */
import { randomUUID } from "crypto";
import type { Db } from "./db.js";
import { LIVE_NOT_AVAILABLE, type CrmMode } from "./mode.js";
import { create_contact, find_contacts, update_contact, delete_contact } from "./tools/contacts.js";
import { log_activity, get_timeline } from "./tools/activities.js";
import { create_deal, update_deal, get_pipeline } from "./tools/deals.js";
import { create_task, list_tasks, complete_task } from "./tools/tasks.js";
import { export_crm } from "./tools/export.js";
import { load_simulation } from "./tools/simulation.js";

/**
 * Tools that change the CRM — the ones the gateway issues a ticket for (matches
 * the write overrides in the shipped `crm.json` manifest). All of these now
 * carry `receipt_id` in their schema (see index.ts) and so get a non-null
 * receipt_id in the change/refusal record when the gateway supplies one.
 */
export const CHANGE_TOOLS = new Set([
  "create_contact",
  "update_contact",
  "delete_contact",
  "log_activity",
  "create_deal",
  "update_deal",
  "create_task",
  "complete_task",
  "load_simulation",
]);

async function runTool(db: Db, name: string, args: Record<string, any>): Promise<unknown> {
  switch (name) {
    case "create_contact": return create_contact(db, args);
    case "find_contacts": return find_contacts(db, args);
    case "update_contact": return update_contact(db, args);
    case "delete_contact": return delete_contact(db, args);
    case "log_activity": return log_activity(db, args);
    case "get_timeline": return get_timeline(db, args);
    case "create_deal": return create_deal(db, args);
    case "update_deal": return update_deal(db, args);
    case "get_pipeline": return get_pipeline(db, args);
    case "create_task": return create_task(db, args);
    case "list_tasks": return list_tasks(db, args);
    case "complete_task": return complete_task(db, args);
    case "export_crm": return export_crm(db, args);
    case "load_simulation": return load_simulation(db, args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

/** A short summary of the effect, in the spirit of "type/stage/title" — enough to
 * tell what happened without re-reading the document. */
function describeChange(name: string, args: Record<string, any>, result: unknown): { documentId: string | null; summary: string } {
  const doc = (result ?? {}) as Record<string, unknown>;
  switch (name) {
    case "create_contact":
    case "update_contact":
      return { documentId: (doc.id as string) ?? null, summary: `${doc.type ?? "?"}/${doc.stage ?? "?"}` };
    case "delete_contact":
      return { documentId: typeof args.id === "string" ? args.id : null, summary: typeof doc.message === "string" ? doc.message : "deleted" };
    case "log_activity":
      return { documentId: (doc.id as string) ?? null, summary: `${doc.type ?? "?"}` };
    case "create_deal":
    case "update_deal":
      return { documentId: (doc.id as string) ?? null, summary: `${doc.stage ?? "?"}/${doc.title ?? "?"}` };
    case "create_task":
      return { documentId: (doc.id as string) ?? null, summary: `${doc.title ?? "?"}` };
    case "complete_task":
      return { documentId: typeof args.id === "string" ? args.id : null, summary: typeof doc.message === "string" ? doc.message : "completed" };
    case "load_simulation":
      return { documentId: null, summary: typeof doc.name === "string" ? doc.name : "" };
    default:
      return { documentId: (doc.id as string) ?? null, summary: "" };
  }
}

/**
 * Run a tool in the given mode. Every successful change is recorded (`changes`)
 * with the receipt_id the gateway injected; a call the connector refuses AFTER
 * the gateway let it through is recorded in `refusals` with the same
 * receipt_id — that is the trace of a ticket whose action never happened. In
 * live mode nothing runs and nothing is recorded locally: there is no local
 * system to have refused anything. Reads record nothing either way.
 */
export async function callTool(db: Db, mode: CrmMode, name: string, args: Record<string, any>): Promise<unknown> {
  if (mode === "live") throw new Error(LIVE_NOT_AVAILABLE);
  const receiptId = typeof args.receipt_id === "string" ? args.receipt_id : null;
  try {
    const result = await runTool(db, name, args);
    if (CHANGE_TOOLS.has(name)) {
      const { documentId, summary } = describeChange(name, args, result);
      await db.run(
        `INSERT INTO changes (id, at, tool, receipt_id, document_id, summary) VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), new Date().toISOString(), name, receiptId, documentId, summary],
      );
    }
    return result;
  } catch (err) {
    if (CHANGE_TOOLS.has(name)) {
      const message = err instanceof Error ? err.message : String(err);
      await db.run(`INSERT INTO refusals (id, at, tool, receipt_id, message) VALUES (?, ?, ?, ?, ?)`, [
        randomUUID(), new Date().toISOString(), name, receiptId, message,
      ]);
    }
    throw err;
  }
}
