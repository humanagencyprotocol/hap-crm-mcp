/**
 * The revision rule (docs/contract.md): every contact, deal, and task carries
 * an integer `revision`, starting at 1. Any successful change produces the
 * next one; an action naming a stale revision is refused, naming both — the
 * same shape the ERP connector's quote revisions use. Also covers:
 * archive-instead-of-delete (contacts), convert_contact (the only way to
 * change a contact's type), and the contact_type scope check.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { createDb, type Db } from "../src/db.js";
import { callTool } from "../src/dispatch.js";

const tmp = (ext: string) => join(tmpdir(), `crm-rev-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);

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

describe("contact revisions", () => {
  it("create_contact always produces revision 1", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    expect(contact.revision).toBe(1);
    expect(contact.archived).toBe(false);
  });

  it("update_contact always produces the next revision, even when nothing material changes", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    const updated = (await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, notes: "same notes" })) as any;
    expect(updated.revision).toBe(2);
    const again = (await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 2, notes: "same notes" })) as any;
    expect(again.revision).toBe(3);
  });

  it("update_contact refuses a stale revision, naming both revisions — nothing changes", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, stage: "active" });

    const result = await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, stage: "inactive" }).catch(
      (e) => e
    );
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/revision/);
    expect((result as Error).message).toContain(`Contact ${contact.id} is at revision 2`);
    expect((result as Error).message).toContain("this request is for revision 1");

    const unchanged = (await callTool(db, "simulation", "get_contact", { id: contact.id })) as any;
    expect(unchanged.stage).toBe("active");
    expect(unchanged.revision).toBe(2);
  });

  it("the race: create (rev 1) -> update (rev 2) -> update(revision:1) refused, update(revision:2) works", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    expect(contact.revision).toBe(1);

    await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, company: "Acme Corp" });

    const refused = await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, stage: "active" }).catch((e) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/revision/);

    const ok = (await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 2, stage: "active" })) as any;
    expect(ok.revision).toBe(3);
    expect(ok.stage).toBe("active");
  });

  it("update_contact refuses changing type, pointing to convert_contact — nothing changes", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, type: "customer" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/convert_contact/);
    const unchanged = (await callTool(db, "simulation", "get_contact", { id: contact.id })) as any;
    expect(unchanged.type).toBe("lead");
    expect(unchanged.revision).toBe(1);
  });

  it("get_contact with a revision argument returns that exact historical version, not the current one", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", notes: "v1" })) as any;
    await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, notes: "v2" });

    const old = (await callTool(db, "simulation", "get_contact", { id: contact.id, revision: 1 })) as any;
    expect(old.notes).toBe("v1");
    expect(old.revision).toBe(1);

    const current = (await callTool(db, "simulation", "get_contact", { id: contact.id })) as any;
    expect(current.notes).toBe("v2");
    expect(current.revision).toBe(2);
  });

  it("get_contact refuses an unknown revision", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await expect(callTool(db, "simulation", "get_contact", { id: contact.id, revision: 99 })).rejects.toThrow(/Unknown revision/);
  });
});

describe("archive instead of delete", () => {
  it("delete_contact archives: no cascade, activities and deals survive", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "log_activity", { contact_id: contact.id, type: "note", summary: "hi" });
    const deal = (await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal" })) as any;
    const task = (await callTool(db, "simulation", "create_task", { contact_id: contact.id, title: "Follow up" })) as any;

    const result = (await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 })) as any;
    expect(result.archived).toBe(true);
    expect(result.revision).toBe(2);

    const archived = (await callTool(db, "simulation", "get_contact", { id: contact.id })) as any;
    expect(archived.archived).toBe(true);
    expect(archived.revision).toBe(2);

    expect(await db.all(`SELECT * FROM activities WHERE contact_id = ?`, [contact.id])).toHaveLength(1);
    const deals = (await callTool(db, "simulation", "get_deal", { id: deal.id })) as any;
    expect(deals.id).toBe(deal.id);
    const tasks = await db.all(`SELECT * FROM tasks WHERE id = ?`, [task.id]);
    expect(tasks).toHaveLength(1);
  });

  it("delete_contact refuses on an already-archived contact", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 });
    const result = await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 2 }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/archived/);
  });

  it("delete_contact refuses a stale revision", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, stage: "active" });
    const result = await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/revision/);
  });

  it("find_contacts excludes archived contacts by default, includes them with include_archived", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 });

    expect(await callTool(db, "simulation", "find_contacts", {})).toEqual([]);
    const withArchived = (await callTool(db, "simulation", "find_contacts", { include_archived: true })) as any[];
    expect(withArchived).toHaveLength(1);
    expect(withArchived[0].archived).toBe(true);
  });

  it("get_pipeline excludes deals whose contact is archived by default, includes them with include_archived", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal" });
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 });

    expect(await callTool(db, "simulation", "get_pipeline", {})).toEqual([]);
    const withArchived = (await callTool(db, "simulation", "get_pipeline", { include_archived: true })) as any[];
    expect(withArchived).toHaveLength(1);
  });

  it("restore_contact brings an archived contact back", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 });
    const restored = (await callTool(db, "simulation", "restore_contact", { id: contact.id, revision: 2 })) as any;
    expect(restored.archived).toBe(false);
    expect(restored.revision).toBe(3);
    expect(await callTool(db, "simulation", "find_contacts", {})).toHaveLength(1);
  });

  it("restore_contact refuses a contact that is not archived", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    const result = await callTool(db, "simulation", "restore_contact", { id: contact.id, revision: 1 }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/not archived/);
  });

  it("restore_contact refuses a stale revision", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 });
    const result = await callTool(db, "simulation", "restore_contact", { id: contact.id, revision: 1 }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/revision/);
  });
});

describe("convert_contact — the only way to change type", () => {
  it("converts a lead to a customer, logged as its own action", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const converted = (await callTool(db, "simulation", "convert_contact", { id: contact.id, revision: 1, to_type: "customer", ticket_id: "t-conv" })) as any;
    expect(converted.type).toBe("customer");
    expect(converted.revision).toBe(2);

    const rows = await db.all<any>(`SELECT tool, receipt_id, document_id FROM changes WHERE tool = 'convert_contact'`);
    expect(rows).toEqual([{ tool: "convert_contact", receipt_id: "t-conv", document_id: contact.id }]);
  });

  it("refuses converting to the contact's current type", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = await callTool(db, "simulation", "convert_contact", { id: contact.id, revision: 1, to_type: "lead" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/already type/);
  });

  it("refuses an archived contact", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 });
    const result = await callTool(db, "simulation", "convert_contact", { id: contact.id, revision: 2, to_type: "customer" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/archived/);
  });

  it("refuses a stale revision, naming both", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, stage: "active" });
    const result = await callTool(db, "simulation", "convert_contact", { id: contact.id, revision: 1, to_type: "customer" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/revision/);
  });
});

describe("contact_type — the connector checks the record's real type, not just the manifest's claim", () => {
  it("update_contact refuses when the declared contact_type does not match the real one", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = await callTool(db, "simulation", "update_contact", {
      id: contact.id, revision: 1, stage: "active", contact_type: "customer",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/contact_type/);
    expect((result as Error).message).toContain('is type "lead"');
    expect((result as Error).message).toContain('declares "customer"');
  });

  it("update_contact succeeds when the declared contact_type matches", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "customer" })) as any;
    const result = (await callTool(db, "simulation", "update_contact", {
      id: contact.id, revision: 1, stage: "active", contact_type: "customer",
    })) as any;
    expect(result.stage).toBe("active");
  });

  it("delete_contact refuses on a contact_type mismatch", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1, contact_type: "customer" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/contact_type/);
  });

  it("log_activity refuses on a contact_type mismatch", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = await callTool(db, "simulation", "log_activity", {
      contact_id: contact.id, type: "note", summary: "hi", contact_type: "customer",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/contact_type/);
  });

  it("create_deal refuses on a contact_type mismatch", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = await callTool(db, "simulation", "create_deal", {
      contact_id: contact.id, title: "Deal", contact_type: "customer",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/contact_type/);
  });

  it("update_deal refuses on a contact_type mismatch (checked via the deal's own contact)", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const deal = (await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal" })) as any;
    const result = await callTool(db, "simulation", "update_deal", {
      id: deal.id, revision: 1, stage: "qualified", contact_type: "customer",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/contact_type/);
  });

  it("create_task refuses on a contact_type mismatch when a contact_id is given", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = await callTool(db, "simulation", "create_task", {
      title: "Follow up", contact_id: contact.id, contact_type: "customer",
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/contact_type/);
  });

  it("an undeclared contact_type makes no claim, and is not checked", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", type: "lead" })) as any;
    const result = (await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, stage: "active" })) as any;
    expect(result.stage).toBe("active");
  });
});

describe("deal revisions", () => {
  it("create_deal always produces revision 1; update_deal produces the next", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    const deal = (await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal" })) as any;
    expect(deal.revision).toBe(1);
    const updated = (await callTool(db, "simulation", "update_deal", { id: deal.id, revision: 1, stage: "qualified" })) as any;
    expect(updated.revision).toBe(2);
  });

  it("update_deal refuses a stale revision, naming both", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    const deal = (await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal" })) as any;
    await callTool(db, "simulation", "update_deal", { id: deal.id, revision: 1, stage: "qualified" });
    const result = await callTool(db, "simulation", "update_deal", { id: deal.id, revision: 1, stage: "proposal" }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain(`Deal ${deal.id} is at revision 2`);
    expect((result as Error).message).toContain("this request is for revision 1");
  });

  it("get_deal with a revision argument returns the historical content", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    const deal = (await callTool(db, "simulation", "create_deal", { contact_id: contact.id, title: "Deal", stage: "lead" })) as any;
    await callTool(db, "simulation", "update_deal", { id: deal.id, revision: 1, stage: "qualified" });

    const old = (await callTool(db, "simulation", "get_deal", { id: deal.id, revision: 1 })) as any;
    expect(old.stage).toBe("lead");
    const current = (await callTool(db, "simulation", "get_deal", { id: deal.id })) as any;
    expect(current.stage).toBe("qualified");
  });
});

describe("task revisions", () => {
  it("create_task always produces revision 1; complete_task produces the next", async () => {
    await freshDb();
    const task = (await callTool(db, "simulation", "create_task", { title: "Follow up" })) as any;
    expect(task.revision).toBe(1);
    const completed = (await callTool(db, "simulation", "complete_task", { id: task.id, revision: 1 })) as any;
    expect(completed.revision).toBe(2);
    expect(completed.status).toBe("done");
  });

  it("complete_task refuses a stale revision, naming both", async () => {
    await freshDb();
    const task = (await callTool(db, "simulation", "create_task", { title: "Follow up" })) as any;
    await callTool(db, "simulation", "complete_task", { id: task.id, revision: 1 });
    const result = await callTool(db, "simulation", "complete_task", { id: task.id, revision: 1 }).catch((e) => e);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain(`Task ${task.id} is at revision 2`);
    expect((result as Error).message).toContain("this request is for revision 1");
  });

  it("get_task with a revision argument returns the historical content", async () => {
    await freshDb();
    const task = (await callTool(db, "simulation", "create_task", { title: "Follow up" })) as any;
    await callTool(db, "simulation", "complete_task", { id: task.id, revision: 1 });

    const old = (await callTool(db, "simulation", "get_task", { id: task.id, revision: 1 })) as any;
    expect(old.status).toBe("open");
    const current = (await callTool(db, "simulation", "get_task", { id: task.id })) as any;
    expect(current.status).toBe("done");
  });
});

describe("the change log carries revision and old/new values", () => {
  it("records the resulting revision, and the changed fields' old/new values, on update_contact", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme", stage: "new" })) as any;
    await callTool(db, "simulation", "update_contact", { id: contact.id, revision: 1, stage: "active" });

    const rows = await db.all<any>(`SELECT revision, old_values, new_values FROM changes WHERE tool = 'update_contact'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].revision).toBe(2);
    expect(JSON.parse(rows[0].old_values)).toEqual({ stage: "new" });
    expect(JSON.parse(rows[0].new_values)).toEqual({ stage: "active" });
  });

  it("records a null revision for activities (they carry none)", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "log_activity", { contact_id: contact.id, type: "note", summary: "hi" });
    const rows = await db.all<any>(`SELECT revision FROM changes WHERE tool = 'log_activity'`);
    expect(rows).toEqual([{ revision: null }]);
  });

  it("records old/new values for delete_contact (archived false -> true) and restore_contact (true -> false)", async () => {
    await freshDb();
    const contact = (await callTool(db, "simulation", "create_contact", { name: "Acme" })) as any;
    await callTool(db, "simulation", "delete_contact", { id: contact.id, revision: 1 });
    await callTool(db, "simulation", "restore_contact", { id: contact.id, revision: 2 });

    const deleteRow = await db.get<any>(`SELECT old_values, new_values FROM changes WHERE tool = 'delete_contact'`);
    expect(JSON.parse(deleteRow.old_values)).toEqual({ archived: false });
    expect(JSON.parse(deleteRow.new_values)).toEqual({ archived: true });

    const restoreRow = await db.get<any>(`SELECT old_values, new_values FROM changes WHERE tool = 'restore_contact'`);
    expect(JSON.parse(restoreRow.old_values)).toEqual({ archived: true });
    expect(JSON.parse(restoreRow.new_values)).toEqual({ archived: false });
  });
});
