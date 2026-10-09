/**
 * `load_simulation` — create-only load of a simulation package into the
 * simulated CRM. Refusals are exercised harder than the success path, per
 * doc/engineering.md: the product's value is in what it refuses.
 *
 * - live mode refuses it like every other tool;
 * - the first load seeds exactly the package's customers (+ optional contacts);
 * - a second load, a load after CRM_COMPANY_FILE already seeded data, or a
 *   load after any business change is refused AND recorded in `refusals` with
 *   the gateway's ticket_id — the only trace that a ticket exists for an
 *   action that never happened;
 * - an invalid package is refused whole, naming the field;
 * - `products`/`items` and `cases` are accepted but ignored;
 * - the package hash is stable regardless of key order;
 * - delete_contact and complete_task carry ticket_id into the change record.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, readFileSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { parseSimulationPackage, parseCompany } from "../src/company.js";
import { LIVE_NOT_AVAILABLE } from "../src/mode.js";
import { callTool } from "../src/dispatch.js";
import { load_simulation, ALREADY_LOADED_MESSAGE } from "../src/tools/simulation.js";
import { canonicalSha256 } from "../src/package-hash.js";
import { exportRecord } from "../src/cli.js";

const tmp = (ext: string) => join(tmpdir(), `crm-loadsim-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

let dbPath: string;
let db: Db;

async function freshDb() {
  dbPath = tmp("db");
  process.env.DATABASE_URL = dbPath;
  db = await createDb(null);
}

afterEach(async () => {
  if (db) await db.close();
  if (dbPath) rmSync(dbPath, { force: true });
  db = undefined as unknown as Db;
  dbPath = "";
  delete process.env.CRM_COMPANY_FILE;
});

const PACKAGE = {
  name: "Bergmann Ersatzteile GmbH",
  currency: "EUR",
  customers: [
    { name: "Huber Maschinenbau GmbH", email: "einkauf@huber.example", country: "AT", credit_limit: 15000, open_balance: 2000 },
    { name: "Steiner Anlagentechnik KG", email: "office@steiner.example", country: "DE", credit_limit: 4000, open_balance: 3500 },
  ],
  products: [{ sku: "SP-100", name: "Hydraulic seal kit", list_price: 84.5, stock: 40 }], // ERP-only — CRM must ignore
  cases: [
    { id: "case-1", request: { from: { name: "X", email: "x@example.com" }, subject: "s", body: "b" }, reply: { subject: "re: s", body: "r" } },
  ],
};

describe("live mode", () => {
  it("refuses load_simulation like every other tool, touching nothing", async () => {
    await freshDb();
    await expect(callTool(db, "live", "load_simulation", { package: PACKAGE, ticket_id: "t-1" })).rejects.toThrow(LIVE_NOT_AVAILABLE);
    expect(await db.all(`SELECT * FROM simulation_load`)).toHaveLength(0);
  });
});

describe("first load", () => {
  it("seeds exactly the package's customers as customer-type contacts", async () => {
    await freshDb();
    const result = (await callTool(db, "simulation", "load_simulation", { package: PACKAGE, ticket_id: "t-load" })) as any;
    expect(result).toMatchObject({ name: PACKAGE.name, contacts_loaded: 2 });
    expect(result.package_sha256).toHaveLength(64);

    const contacts = await db.all<any>(`SELECT name, type FROM contacts ORDER BY name`);
    expect(contacts).toEqual([
      { name: "Huber Maschinenbau GmbH", type: "customer" },
      { name: "Steiner Anlagentechnik KG", type: "customer" },
    ]);
  });

  it("also seeds native contacts[] alongside customers[]", async () => {
    await freshDb();
    const withContacts = { ...PACKAGE, contacts: [{ name: "Jordan Lead", type: "lead" }] };
    const result = (await callTool(db, "simulation", "load_simulation", { package: withContacts })) as any;
    expect(result.contacts_loaded).toBe(3);
  });

  it("is recorded as a change with the gateway's ticket_id", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, ticket_id: "t-load" });
    const rows = await db.all<any>(`SELECT tool, receipt_id FROM changes`);
    expect(rows).toEqual([{ tool: "load_simulation", receipt_id: "t-load" }]);
  });

  it("stores name and sha256 in simulation_load", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, ticket_id: "t-load" });
    const rows = await db.all<any>(`SELECT name, package_sha256 FROM simulation_load`);
    expect(rows).toEqual([{ name: PACKAGE.name, package_sha256: canonicalSha256(PACKAGE) }]);
  });
});

describe("create only — refused, never edited", () => {
  it("refuses a second load and records the refusal with ticket_id", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, ticket_id: "t-first" });
    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE, ticket_id: "t-second" }))
      .rejects.toThrow(ALREADY_LOADED_MESSAGE);
    const refusals = await db.all<any>(`SELECT tool, receipt_id FROM refusals`);
    expect(refusals).toEqual([{ tool: "load_simulation", receipt_id: "t-second" }]);
    expect(await db.all(`SELECT * FROM contacts`)).toHaveLength(2); // untouched by the refused attempt
  });

  it("refuses a load when CRM_COMPANY_FILE already seeded contacts (not from an earlier load_simulation call)", async () => {
    const path = tmp("json");
    const { writeFileSync } = await import("fs");
    writeFileSync(path, JSON.stringify({
      name: "X", currency: "EUR",
      items: [{ sku: "A", name: "A", list_price: 1, stock: 1 }],
      customers: [{ name: "Seeded Co", credit_limit: 100 }],
    }));
    process.env.CRM_COMPANY_FILE = path;
    dbPath = tmp("db");
    process.env.DATABASE_URL = dbPath;
    db = await createDb(parseCompany(JSON.parse(readFileSync(path, "utf8"))));
    expect(await db.all(`SELECT * FROM contacts`)).toHaveLength(1);

    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE, ticket_id: "t-x" }))
      .rejects.toThrow(ALREADY_LOADED_MESSAGE);
    rmSync(path, { force: true });
  });

  it("refuses a load after a business change (a contact was created, no prior load_simulation call)", async () => {
    await freshDb();
    await callTool(db, "simulation", "create_contact", { name: "Someone", ticket_id: "t-create" });
    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE })).rejects.toThrow(ALREADY_LOADED_MESSAGE);
  });

  it("refuses a load after a deal exists even with zero contacts left (deal survives contact deletion)", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Someone" })) as any;
    await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal" });
    await callTool(db, "simulation", "delete_contact", { id: contact.id });
    expect(await db.all(`SELECT * FROM contacts`)).toHaveLength(0);
    await expect(callTool(db, "simulation", "load_simulation", { package: PACKAGE })).rejects.toThrow(ALREADY_LOADED_MESSAGE);
  });
});

describe("invalid package — refused whole, naming the field", () => {
  it.each([
    ["missing customers", { name: "X", currency: "EUR" }, /`customers` must be a non-empty list/],
    ["a bad currency", { ...PACKAGE, currency: "euro" }, /currency/],
    ["an unknown contact type", { ...PACKAGE, contacts: [{ name: "X", type: "enemy" }] }, /contacts\[0\]\.type/],
    ["a contact id colliding with a customer id", { ...PACKAGE, customers: [{ id: "cust-1", name: "A", credit_limit: 1 }], contacts: [{ id: "cust-1", name: "B" }] }, /appears twice/],
  ])("refuses on %s", (_label, bad, msg) => {
    expect(() => parseSimulationPackage(bad)).toThrow(msg);
  });

  it("the refusal happens before anything is written", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "load_simulation", { package: { name: "X" }, ticket_id: "t-bad" })).rejects.toThrow();
    expect(await db.all(`SELECT * FROM simulation_load`)).toHaveLength(0);
    expect(await db.all<any>(`SELECT tool, receipt_id FROM refusals`)).toEqual([{ tool: "load_simulation", receipt_id: "t-bad" }]);
  });
});

describe("ERP-only and email-only fields — accepted, ignored", () => {
  it("a package with `products` (ERP-only) and a junk `cases` still loads", async () => {
    await freshDb();
    const result = (await callTool(db, "simulation", "load_simulation", { package: { ...PACKAGE, cases: "not even an array" } })) as any;
    expect(result.contacts_loaded).toBe(2);
    // No table in the CRM schema reflects `products` at all — nothing to assert beyond "it didn't choke".
  });
});

describe("package hash", () => {
  it("is stable regardless of top-level and nested object key order", () => {
    const reorderedCustomers = PACKAGE.customers.map((c) => {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(c).reverse()) o[k] = (c as any)[k];
      return o;
    });
    const reordered = {
      cases: PACKAGE.cases,
      products: PACKAGE.products,
      customers: reorderedCustomers,
      currency: PACKAGE.currency,
      name: PACKAGE.name,
    };
    expect(canonicalSha256(reordered)).toBe(canonicalSha256(PACKAGE));
  });

  it("differs when content differs", () => {
    expect(canonicalSha256(PACKAGE)).not.toBe(canonicalSha256({ ...PACKAGE, name: "Different" }));
  });
});

describe("the shipped example package is valid", () => {
  it("parses with the expected shape (CRM ignores products/cases)", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "examples", "package.example.json"), "utf8"));
    const pkg = parseSimulationPackage(raw);
    expect(pkg.customers.length).toBe(2);
  });

  it("the old company example still works unchanged", () => {
    const raw = JSON.parse(readFileSync(join(__dirname, "..", "examples", "company.example.json"), "utf8"));
    const c = parseCompany(raw);
    expect(c.customers.length).toBeGreaterThan(0);
  });
});

describe("ticket_id now traced for delete_contact and complete_task", () => {
  it("delete_contact's change record carries the gateway's ticket_id", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "To Delete" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, ticket_id: "t-del" });
    const rows = await db.all<any>(`SELECT receipt_id FROM changes WHERE tool = 'delete_contact'`);
    expect(rows).toEqual([{ receipt_id: "t-del" }]);
  });

  it("complete_task's change record AND row carry the gateway's ticket_id", async () => {
    await freshDb();
    const task = (await callTool(db, "simulation", "create_task", { title: "Follow up" })) as any;
    await callTool(db, "simulation", "complete_task", { id: task.id, ticket_id: "t-done" });
    const changeRows = await db.all<any>(`SELECT receipt_id FROM changes WHERE tool = 'complete_task'`);
    expect(changeRows).toEqual([{ receipt_id: "t-done" }]);
    const taskRow = await db.get<any>(`SELECT receipt_id FROM tasks WHERE id = ?`, [task.id]);
    expect(taskRow!.receipt_id).toBe("t-done");
  });
});

describe("export", () => {
  it("includes simulation_load and changes", async () => {
    await freshDb();
    await callTool(db, "simulation", "load_simulation", { package: PACKAGE, ticket_id: "t-export" });
    const rec = await exportRecord(db, "simulation");
    expect(rec.simulation_load).toEqual([expect.objectContaining({ name: PACKAGE.name })]);
    expect(rec.changes).toEqual([expect.objectContaining({ tool: "load_simulation", receipt_id: "t-export" })]);
  });
});
