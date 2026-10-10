/**
 * `load_simulation` — loads a simulation package (customers + optional native
 * contacts) into an empty simulated CRM. Create only, never edit: refused once
 * test data exists — a prior load, any recorded change, or any contact, deal,
 * task or activity already present (including one seeded by CRM_COMPANY_FILE,
 * which is not "from an earlier load" either) — so the three-week test always
 * starts from the package that was actually loaded.
 *
 * `clear_simulation` deletes all of it, the record of changes and refusals
 * included, so the same cases can run again under a different setup (or other
 * cases under the same setup): clear, then load.
 *
 * Unlike the ERP connector, the CRM has no auto-seeded demo data to replace:
 * with no package loaded yet the database is simply empty, so the guard never
 * has to distinguish "seed data" from "real data" the way the ERP's does.
 */
import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { parseSimulationPackage, companyContacts } from "../company.js";
import { canonicalSha256 } from "../package-hash.js";

export const ALREADY_LOADED_MESSAGE =
  "Refused: test data already loaded — a simulation can only be created, not edited; clear it first (clear_simulation), then load.";

/** Tables whose emptiness proves this database has never held anything but the auto-created schema. */
const MUST_BE_EMPTY = ["simulation_load", "contacts", "deals", "tasks", "activities"] as const;

async function assertLoadable(db: Db): Promise<void> {
  for (const table of MUST_BE_EMPTY) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
    if ((row?.n ?? 0) > 0) throw new Error(ALREADY_LOADED_MESSAGE);
  }
  // The clear itself is recorded as a change (the trace of its ticket); it must not block the load after it.
  const changes = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM changes WHERE tool <> 'clear_simulation'`);
  if ((changes?.n ?? 0) > 0) throw new Error(ALREADY_LOADED_MESSAGE);
}

/**
 * Every table that holds test data, children before parents — the revision
 * snapshot tables cascade from their parent record on delete (same as the
 * ERP connector's quote_revisions), but are listed explicitly anyway so this
 * report's per-table counts reflect what was actually in each one rather
 * than a cascaded 0.
 */
const CLEAR_ORDER = [
  "task_revisions", "tasks",
  "activities",
  "deal_revisions", "deals",
  "contact_revisions", "contacts",
  "changes", "refusals", "simulation_load",
] as const;

const INSERT_CONTACT = `INSERT INTO contacts (id, name, email, phone, company, role, type, stage, tags, notes, revision, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`;
const INSERT_CONTACT_REVISION = `INSERT INTO contact_revisions (id, contact_id, revision, name, email, phone, company, role, type, stage, tags, notes, archived) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`;

export async function load_simulation(db: Db, args: Record<string, any>) {
  const pkg = parseSimulationPackage(args.package);
  await assertLoadable(db);

  const sha256 = canonicalSha256(args.package);
  const contacts = companyContacts(pkg);

  await db.run("BEGIN");
  try {
    for (const ct of contacts) {
      await db.run(INSERT_CONTACT, [ct.id, ct.name, ct.email, ct.phone, ct.company, ct.role, ct.type, ct.stage, JSON.stringify(ct.tags), ct.notes]);
      await db.run(INSERT_CONTACT_REVISION, [uuidv4(), ct.id, ct.name, ct.email, ct.phone, ct.company, ct.role, ct.type, ct.stage, JSON.stringify(ct.tags), ct.notes]);
    }
    await db.run(`INSERT INTO simulation_load (id, name, package_sha256) VALUES (?, ?, ?)`, [uuidv4(), pkg.name, sha256]);
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }

  return { name: pkg.name, contacts_loaded: contacts.length, package_sha256: sha256 };
}

export async function clear_simulation(db: Db, _args: Record<string, any>) {
  const deleted: Record<string, number> = {};
  await db.run("BEGIN");
  try {
    for (const table of CLEAR_ORDER) {
      const row = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
      deleted[table] = Number(row?.n ?? 0);
      await db.run(`DELETE FROM ${table}`);
    }
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }
  return { cleared: true, deleted };
}
