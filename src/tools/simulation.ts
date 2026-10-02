/**
 * `load_simulation` — loads a simulation package (customers + optional native
 * contacts) into an empty simulated CRM. Create only, never edit: refused once
 * test data exists — a prior load, any recorded change, or any contact, deal,
 * task or activity already present (including one seeded by CRM_COMPANY_FILE,
 * which is not "from an earlier load" either) — so the three-week test always
 * starts from the package that was actually loaded.
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
  "Refused: test data already loaded — a simulation can only be created, not edited; start from an empty database.";

/** Tables whose emptiness proves this database has never held anything but the auto-created schema. */
const MUST_BE_EMPTY = ["simulation_load", "changes", "contacts", "deals", "tasks", "activities"] as const;

async function assertLoadable(db: Db): Promise<void> {
  for (const table of MUST_BE_EMPTY) {
    const row = await db.get<{ n: number }>(`SELECT COUNT(*) as n FROM ${table}`);
    if ((row?.n ?? 0) > 0) throw new Error(ALREADY_LOADED_MESSAGE);
  }
}

const INSERT_CONTACT = `INSERT INTO contacts (id, name, email, phone, company, role, type, stage, tags, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export async function load_simulation(db: Db, args: Record<string, any>) {
  const pkg = parseSimulationPackage(args.package);
  await assertLoadable(db);

  const sha256 = canonicalSha256(args.package);
  const contacts = companyContacts(pkg);

  await db.run("BEGIN");
  try {
    for (const ct of contacts) {
      await db.run(INSERT_CONTACT, [ct.id, ct.name, ct.email, ct.phone, ct.company, ct.role, ct.type, ct.stage, JSON.stringify(ct.tags), ct.notes]);
    }
    await db.run(`INSERT INTO simulation_load (id, name, package_sha256) VALUES (?, ?, ?)`, [uuidv4(), pkg.name, sha256]);
    await db.run("COMMIT");
  } catch (err) {
    await db.run("ROLLBACK").catch(() => {});
    throw err;
  }

  return { name: pkg.name, contacts_loaded: contacts.length, package_sha256: sha256 };
}
