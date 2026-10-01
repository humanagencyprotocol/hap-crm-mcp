/**
 * Simulation mode: the three-week test runs on this connector, its tools and its
 * profile — only the system behind it is simulated. These tests pin what makes
 * that test trustworthy:
 *
 * - live mode refuses loudly (no adapter in 0.x) and touches nothing — a go-live
 *   that is secretly still simulated, or a test that believes it is live, must
 *   not be silent;
 * - the company file (shared format with the ERP connector) is loaded whole or
 *   refused whole;
 * - every successful change is its own row in `changes`, and a call refused
 *   after the gateway let it through is recorded in `refusals` with its
 *   receipt_id — the only trace that a ticket exists for an action that never
 *   happened;
 * - reads carry no ticket and record nothing, success or failure.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, writeFileSync } from "fs";
import { createDb, resolveCompany, type Db } from "../src/db.js";
import { parseCompany } from "../src/company.js";
import { getMode, LIVE_NOT_AVAILABLE } from "../src/mode.js";
import { callTool } from "../src/dispatch.js";
import { exportRecord } from "../src/cli.js";

const tmp = (ext: string) => join(tmpdir(), `crm-sim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

let dbPath: string;
let db: Db;

async function freshDb(company = resolveCompany()) {
  dbPath = tmp("db");
  process.env.DATABASE_URL = dbPath;
  db = await createDb(company);
}

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined as unknown as Db;
  dbPath = "";
  delete process.env.CRM_COMPANY_FILE;
});

describe("mode switch", () => {
  it("defaults to simulation", () => {
    expect(getMode({})).toBe("simulation");
    expect(getMode({ CRM_MODE: "Simulation " })).toBe("simulation");
  });

  it("refuses an unknown mode at start instead of guessing", () => {
    expect(() => getMode({ CRM_MODE: "production" })).toThrow(/CRM_MODE must be one of simulation, live/);
  });

  it("live mode refuses every tool, reads included, and changes nothing", async () => {
    await freshDb();
    await expect(callTool(db, "live", "find_contacts", {})).rejects.toThrow(LIVE_NOT_AVAILABLE);
    await expect(callTool(db, "live", "create_contact", { name: "Nope Inc", receipt_id: "t-1" })).rejects.toThrow(/live mode/);
    expect(await db.all(`SELECT * FROM contacts`)).toHaveLength(0);
    // Nothing local refused it — there is no local system in live mode — so nothing is recorded.
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
    expect(await db.all(`SELECT * FROM changes`)).toHaveLength(0);
  });
});

describe("company file (shared format with the ERP connector)", () => {
  const company = {
    name: "Bergmann Ersatzteile GmbH",
    currency: "EUR",
    items: [{ sku: "SP-100", name: "Hydraulic seal kit", list_price: 84.5, stock: 40 }],
    customers: [{ name: "Huber Maschinenbau", email: "einkauf@huber.example", country: "AT", credit_limit: 15000, open_balance: 2000 }],
  };

  it("seeds an empty database from the file: one customer-type contact per customer", async () => {
    await freshDb(parseCompany(company));
    const contacts = (await callTool(db, "simulation", "find_contacts", {})) as any[];
    expect(contacts).toEqual([
      expect.objectContaining({
        id: "cust-1", name: "Huber Maschinenbau", company: "Huber Maschinenbau", email: "einkauf@huber.example",
        type: "customer", notes: "Country: AT",
      }),
    ]);
  });

  it("the ERP's items are accepted (and validated) but not used", async () => {
    // Same object both connectors would load — the CRM must not choke on `items`.
    await freshDb(parseCompany(company));
    expect(await db.all(`SELECT * FROM contacts`)).toHaveLength(1);
  });

  it("also seeds CRM-native contacts[] — leads and partners the ERP has no concept of", async () => {
    const withContacts = {
      ...company,
      contacts: [
        { name: "Jordan Lead", type: "lead", stage: "active", tags: ["inbound"] },
        { name: "Acme Partner Co", type: "partner" },
      ],
    };
    await freshDb(parseCompany(withContacts));
    const contacts = (await callTool(db, "simulation", "find_contacts", {})) as any[];
    expect(contacts).toHaveLength(3);
    expect(contacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "contact-1", name: "Jordan Lead", type: "lead", stage: "active", tags: ["inbound"] }),
      expect.objectContaining({ id: "contact-2", name: "Acme Partner Co", type: "partner", stage: "new" }),
    ]));
  });

  it("does not reload CRM_COMPANY_FILE into a database that already holds data", async () => {
    await freshDb(parseCompany(company));
    // Re-create the Db against the same path with a *different* company — must be a no-op.
    const other = parseCompany({ ...company, customers: [{ name: "Someone Else", credit_limit: 100 }] });
    const db2 = await createDb(other);
    const contacts = await db2.all<any>(`SELECT name FROM contacts`);
    expect(contacts).toEqual([{ name: "Huber Maschinenbau" }]);
    await db2.close();
  });

  it.each([
    ["a duplicate sku", { ...company, items: [company.items[0], company.items[0]] }, /sku "SP-100" appears twice/],
    ["a missing credit_limit", { ...company, customers: [{ name: "X" }] }, /customers\[0\]\.credit_limit/],
    ["a bad currency", { ...company, currency: "euro" }, /currency/],
    ["no items", { ...company, items: [] }, /items/],
    ["an unknown contact type", { ...company, contacts: [{ name: "X", type: "enemy" }] }, /contacts\[0\]\.type/],
    ["an unknown contact stage", { ...company, contacts: [{ name: "X", stage: "zombie" }] }, /contacts\[0\]\.stage/],
    ["non-string tags", { ...company, contacts: [{ name: "X", tags: [1, 2] }] }, /contacts\[0\]\.tags/],
    ["a contact id colliding with a customer id", { ...company, contacts: [{ id: "cust-1", name: "Dup" }] }, /appears twice/],
  ])("refuses the whole file on %s", (_label, bad, msg) => {
    expect(() => parseCompany(bad)).toThrow(msg);
  });

  it("the shipped example company file is valid", () => {
    const c = resolveCompany({ CRM_COMPANY_FILE: join(__dirname, "..", "examples", "company.example.json") });
    expect(c).not.toBeNull();
    expect(c!.customers.length).toBeGreaterThan(0);
  });

  it("refuses an unreadable file at start rather than silently seeding nothing", () => {
    expect(() => resolveCompany({ CRM_COMPANY_FILE: tmp("json") })).toThrow(/cannot be read as JSON/);
  });

  it("without CRM_COMPANY_FILE, resolves to no company (today's behaviour: an empty database)", () => {
    expect(resolveCompany({})).toBeNull();
  });
});

describe("changes and refusals", () => {
  it("records a successful change as a change, not a refusal", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Nova Systems", receipt_id: "t-ok" })) as any;
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
    expect(await db.all<any>(`SELECT tool, receipt_id, document_id, summary FROM changes`)).toEqual([
      { tool: "create_contact", receipt_id: "t-ok", document_id: contact.id, summary: "customer/new" },
    ]);
  });

  it("keeps one change row per ticket even when several tickets act on the same contact", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Nova Systems", receipt_id: "t-create" })) as any;
    await callTool(db, "simulation", "update_contact", { id: contact.id, stage: "active", receipt_id: "t-update" });
    expect(await db.all<any>(`SELECT tool, receipt_id, document_id FROM changes ORDER BY at`)).toEqual([
      { tool: "create_contact", receipt_id: "t-create", document_id: contact.id },
      { tool: "update_contact", receipt_id: "t-update", document_id: contact.id },
    ]);
  });

  it("records a failed update with the ticket's receipt_id", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "update_contact", { id: "nope", name: "X", receipt_id: "t-false" }))
      .rejects.toThrow(/Contact not found/);
    const rows = await db.all<any>(`SELECT * FROM refusals`);
    expect(rows).toEqual([expect.objectContaining({ tool: "update_contact", receipt_id: "t-false" })]);
    expect(rows[0].message).toMatch(/Contact not found/);
    expect(await db.all(`SELECT * FROM changes`)).toHaveLength(0);
  });

  it("records a change tool's call with receipt_id null when the caller omits it (delete_contact)", async () => {
    // delete_contact's schema now declares receipt_id (additive) — this just
    // exercises the caller not supplying it, same as any other optional field.
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "To Delete" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id });
    const rows = await db.all<any>(`SELECT tool, receipt_id, document_id FROM changes WHERE tool = 'delete_contact'`);
    expect(rows).toEqual([{ tool: "delete_contact", receipt_id: null, document_id: contact.id }]);
  });

  it("records a change tool's call with receipt_id null when the caller omits it (complete_task)", async () => {
    // complete_task's schema now declares receipt_id (additive) — see
    // load-simulation.test.ts for the case where the gateway DOES supply one.
    await freshDb();
    const task = (await callTool(db, "simulation", "create_task", { title: "Follow up", receipt_id: "t-task" })) as any;
    await callTool(db, "simulation", "complete_task", { id: task.id });
    const rows = await db.all<any>(`SELECT tool, receipt_id, document_id FROM changes WHERE tool = 'complete_task'`);
    expect(rows).toEqual([{ tool: "complete_task", receipt_id: null, document_id: task.id }]);
  });

  it("records a failed delete (unknown id) as a refusal with receipt_id null", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "delete_contact", { id: "nope" })).rejects.toThrow(/Contact not found/);
    expect(await db.all<any>(`SELECT tool, receipt_id FROM refusals`)).toEqual([{ tool: "delete_contact", receipt_id: null }]);
  });

  it("records no change for a successful read", async () => {
    await freshDb();
    await callTool(db, "simulation", "create_contact", { name: "Reader Test" });
    await callTool(db, "simulation", "find_contacts", {});
    expect(await db.all<any>(`SELECT tool FROM changes`)).toEqual([{ tool: "create_contact" }]);
  });

  it("does not record anything for a failing call outside the change set — reads (and unknown tools) carry no ticket", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "not_a_real_tool", {})).rejects.toThrow(/Unknown tool/);
    expect(await db.all(`SELECT * FROM refusals`)).toHaveLength(0);
    expect(await db.all(`SELECT * FROM changes`)).toHaveLength(0);
  });

  it("logging an activity and creating a deal are recorded with the right summaries", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "log_activity", { contact_id: contact.id, type: "call", summary: "intro call", receipt_id: "t-act" });
    await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Acme renewal", stage: "proposal", receipt_id: "t-deal" });
    const rows = await db.all<any>(`SELECT tool, receipt_id, summary FROM changes WHERE tool != 'create_contact' ORDER BY at`);
    expect(rows).toEqual([
      { tool: "log_activity", receipt_id: "t-act", summary: "call" },
      { tool: "create_deal", receipt_id: "t-deal", summary: "proposal/Acme renewal" },
    ]);
  });
});

describe("export", () => {
  it("lines up changes and refusals by receipt_id, and states the mode", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", receipt_id: "t-create" })) as any;
    await expect(callTool(db, "simulation", "update_contact", { id: "nope", name: "X", receipt_id: "t-false" })).rejects.toThrow();

    const rec = await exportRecord(db, "simulation");
    expect(rec.mode).toBe("simulation");
    expect(rec.contacts).toEqual([expect.objectContaining({ id: contact.id, name: "Acme" })]);
    expect(rec.changes).toEqual([expect.objectContaining({ tool: "create_contact", receipt_id: "t-create" })]);
    expect(rec.refusals).toEqual([expect.objectContaining({ tool: "update_contact", receipt_id: "t-false" })]);
    expect(rec.deals).toEqual([]);
    expect(rec.tasks).toEqual([]);
    expect(rec.activities).toEqual([]);
  });
});
