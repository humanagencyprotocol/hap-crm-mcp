/**
 * AU10 §5 (doc/au10-request-context.md): `get_activity { id }`, and
 * `get_timeline` by `contact_id` (unchanged) / `email` / `email_domain`
 * (new) — the connector-side reads the gateway's "latest entries for this
 * customer" history feature is built on. Both are reads: nothing here is
 * recorded in `changes` or `refusals`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { callTool } from "../src/dispatch.js";

const tmp = (ext: string) => join(tmpdir(), `crm-ctx-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

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
});

async function makeContact(overrides: Record<string, any> = {}) {
  return (await callTool(db, "simulation", "create_contact", {
    name: "Huber Maschinenbau",
    type: "customer",
    email: "einkauf@huber.example",
    ...overrides,
  })) as any;
}

describe("get_activity", () => {
  it("found: returns the activity with contact_id, contact name, and ticket_id", async () => {
    await freshDb();
    const contact = await makeContact();
    const activity = (await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id,
      type: "call",
      summary: "Called about the quote",
      contact_type: "customer",
      ticket_id: "t-100",
    })) as any;

    const result = (await callTool(db, "simulation", "get_activity", { id: activity.id })) as any;
    expect(result.id).toBe(activity.id);
    expect(result.contact_id).toBe(contact.id);
    expect(result.contact_name).toBe("Huber Maschinenbau");
    expect(result.ticket_id).toBe("t-100");
    expect(result.summary).toBe("Called about the quote");
  });

  it("not found: refused with a clear message, never a silent empty result", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "get_activity", { id: "no-such-activity" })).rejects.toThrow(
      /Activity not found: no-such-activity/
    );
  });

  it("is readable even when the linked contact is archived — a direct by-id read, like get_contact", async () => {
    await freshDb();
    const contact = await makeContact();
    const activity = (await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id,
      type: "note",
      summary: "Note before archiving",
      contact_type: "customer",
    })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1, contact_type: "customer" });

    const result = (await callTool(db, "simulation", "get_activity", { id: activity.id })) as any;
    expect(result.contact_id).toBe(contact.id);
    expect(result.contact_name).toBe("Huber Maschinenbau");
  });
});

describe("get_timeline — lookup keys", () => {
  it("mutually exclusive: none of contact_id/email/email_domain is refused", async () => {
    await freshDb();
    await expect(callTool(db, "simulation", "get_timeline", {})).rejects.toThrow(
      /exactly one of contact_id, email, email_domain/
    );
  });

  it("mutually exclusive: more than one of contact_id/email/email_domain is refused", async () => {
    await freshDb();
    const contact = await makeContact();
    await expect(
      callTool(db, "simulation", "get_timeline", { contact_id: contact.id, email: contact.email })
    ).rejects.toThrow(/exactly one of contact_id, email, email_domain/);
  });

  it("existing contact_id calls behave as before, now also carrying contact name and ticket_id", async () => {
    await freshDb();
    const contact = await makeContact();
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id,
      type: "note",
      summary: "First note",
      contact_type: "customer",
      ticket_id: "t-1",
    });

    const timeline = (await callTool(db, "simulation", "get_timeline", { contact_id: contact.id })) as any[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].contact_id).toBe(contact.id);
    expect(timeline[0].contact_name).toBe("Huber Maschinenbau");
    expect(timeline[0].ticket_id).toBe("t-1");
  });

  it("unknown contact_id yields an empty list, not an error (unchanged)", async () => {
    await freshDb();
    expect(await callTool(db, "simulation", "get_timeline", { contact_id: "no-such-contact" })).toEqual([]);
  });

  it("by email: exact, case-insensitive match on contacts.email", async () => {
    await freshDb();
    const contact = await makeContact({ email: "Einkauf@Huber.example" });
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id,
      type: "email",
      summary: "Sent the quote",
      contact_type: "customer",
      ticket_id: "t-2",
    });

    const timeline = (await callTool(db, "simulation", "get_timeline", { email: "einkauf@huber.example" })) as any[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].contact_id).toBe(contact.id);
    expect(timeline[0].contact_name).toBe("Huber Maschinenbau");
    expect(timeline[0].ticket_id).toBe("t-2");
  });

  it("by email: a different contact's email does not match", async () => {
    await freshDb();
    await makeContact({ email: "einkauf@huber.example" });
    const timeline = (await callTool(db, "simulation", "get_timeline", { email: "someone-else@other.example" })) as any[];
    expect(timeline).toEqual([]);
  });

  it("by email_domain: matches every contact on that domain, excludes a different domain", async () => {
    await freshDb();
    const a = await makeContact({ name: "Huber Maschinenbau", email: "einkauf@huber.example" });
    const b = await makeContact({ name: "Huber Zweigstelle", email: "zweigstelle@HUBER.example" });
    const other = await makeContact({ name: "Other Co", email: "info@other.example" });

    await callTool(db, "simulation", "log_activity", { contact_id: a.id, type: "note", summary: "A note", contact_type: "customer" });
    await callTool(db, "simulation", "log_activity", { contact_id: b.id, type: "note", summary: "B note", contact_type: "customer" });
    await callTool(db, "simulation", "log_activity", { contact_id: other.id, type: "note", summary: "Other note", contact_type: "customer" });

    const timeline = (await callTool(db, "simulation", "get_timeline", { email_domain: "huber.example" })) as any[];
    expect(timeline).toHaveLength(2);
    const contactIds = timeline.map((t) => t.contact_id).sort();
    expect(contactIds).toEqual([a.id, b.id].sort());
    expect(timeline.find((t) => t.summary === "Other note")).toBeUndefined();
  });

  it("since: keeps only activities at or after the given timestamp", async () => {
    await freshDb();
    const contact = await makeContact();
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "Old note", contact_type: "customer", date: "2026-01-01T00:00:00.000Z",
    });
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "New note", contact_type: "customer", date: "2026-06-01T00:00:00.000Z",
    });

    const timeline = (await callTool(db, "simulation", "get_timeline", {
      contact_id: contact.id, since: "2026-03-01T00:00:00.000Z",
    })) as any[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].summary).toBe("New note");
  });

  it("since also applies when looking up by email_domain", async () => {
    await freshDb();
    const contact = await makeContact({ email: "einkauf@huber.example" });
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "Old note", contact_type: "customer", date: "2026-01-01T00:00:00.000Z",
    });
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "New note", contact_type: "customer", date: "2026-06-01T00:00:00.000Z",
    });

    const timeline = (await callTool(db, "simulation", "get_timeline", {
      email_domain: "huber.example", since: "2026-03-01T00:00:00.000Z",
    })) as any[];
    expect(timeline).toHaveLength(1);
    expect(timeline[0].summary).toBe("New note");
  });

  it("archived contacts are excluded from email/email_domain matching by default, like find_contacts", async () => {
    await freshDb();
    const contact = await makeContact({ email: "einkauf@huber.example" });
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "Before archiving", contact_type: "customer",
    });
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1, contact_type: "customer" });

    const byEmail = (await callTool(db, "simulation", "get_timeline", { email: "einkauf@huber.example" })) as any[];
    expect(byEmail).toEqual([]);
    const byDomain = (await callTool(db, "simulation", "get_timeline", { email_domain: "huber.example" })) as any[];
    expect(byDomain).toEqual([]);

    const withArchived = (await callTool(db, "simulation", "get_timeline", {
      email: "einkauf@huber.example", include_archived: true,
    })) as any[];
    expect(withArchived).toHaveLength(1);
  });

  it("archived contacts are NOT excluded via contact_id — a direct by-id read, unchanged", async () => {
    await freshDb();
    const contact = await makeContact();
    await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "Before archiving", contact_type: "customer",
    });
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1, contact_type: "customer" });

    const timeline = (await callTool(db, "simulation", "get_timeline", { contact_id: contact.id })) as any[];
    expect(timeline).toHaveLength(1);
  });
});

describe("reads record nothing", () => {
  it("get_activity and get_timeline leave changes/refusals empty", async () => {
    await freshDb();
    const contact = await makeContact();
    const activity = (await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "hi", contact_type: "customer",
    })) as any;

    await callTool(db, "simulation", "get_activity", { id: activity.id });
    await callTool(db, "simulation", "get_timeline", { contact_id: contact.id });
    await callTool(db, "simulation", "get_timeline", { email: contact.email });

    const changes = await db.all<any>(`SELECT * FROM changes WHERE tool IN ('get_activity', 'get_timeline')`);
    const refusals = await db.all<any>(`SELECT * FROM refusals WHERE tool IN ('get_activity', 'get_timeline')`);
    expect(changes).toEqual([]);
    expect(refusals).toEqual([]);
  });
});
