import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db.js";
import { requireContact, checkContactType } from "./contacts.js";
import { recordChangeMeta } from "../change-meta.js";

export interface Activity {
  id: string;
  contact_id: string;
  type: string;
  summary: string;
  detail: string | null;
  date: string;
  created_by: string | null;
  receipt_id: string | null;
}

/**
 * The shape get_activity and get_timeline return for one activity: the raw
 * row plus the linked contact's name, with the storage column `receipt_id`
 * exposed under its wire name `ticket_id` (same rename every other tool's
 * input already went through — see docs/contract.md and CHANGELOG "v0.7
 * wire rename"). No tool edits an activity's receipt_id after the fact, so
 * unlike contacts/deals/tasks there is no ambiguity about which ticket this
 * is: the one that logged it.
 */
function mapActivity(row: Activity, contactName: string | null) {
  return {
    id: row.id,
    contact_id: row.contact_id,
    contact_name: contactName,
    type: row.type,
    summary: row.summary,
    detail: row.detail,
    date: row.date,
    created_by: row.created_by,
    ticket_id: row.receipt_id ?? null,
  };
}

/** Escapes LIKE's own wildcard characters so a literal domain (which may
 * contain neither in practice, but must not be trusted blindly) can't widen
 * the match. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

async function requireActivity(db: Db, id: string): Promise<Activity> {
  const row = await db.get<Activity>("SELECT * FROM activities WHERE id = ?", [id]);
  if (!row) throw new Error(`Activity not found: ${id}`);
  return row;
}

/**
 * One activity by id, with its contact's name and `ticket_id` (AU10 §5) —
 * same archived policy as get_contact (a direct by-id read, not a search):
 * the activity is returned regardless of whether its contact is currently
 * archived. The exclude-archived-by-default policy applies only to
 * find_contacts/get_pipeline-style searches, and to get_timeline's
 * email/email_domain resolution below (which is such a search).
 */
export async function get_activity(db: Db, args: Record<string, any>) {
  const { id } = args;
  const row = await requireActivity(db, id);
  const contact = await db.get<{ name: string }>("SELECT name FROM contacts WHERE id = ?", [row.contact_id]);
  return mapActivity(row, contact?.name ?? null);
}

/**
 * Activities are append-only (see docs/contract.md): no update or delete
 * tool exists for them, and this module adds none — a correction is a new
 * activity, not an edit to a past one. They carry no `revision` for the
 * same reason: nothing ever acts on a past activity by name.
 */
export async function log_activity(db: Db, args: Record<string, any>) {
  // ticket_id: Suveren mandate ticket (Content Provenance §4.1). Stored on
  // the existing receipt_id column (internal storage name, unchanged).
  const { contact_id, type, summary, detail, date, created_by, contact_type, ticket_id } = args;
  const id = uuidv4();

  const contact = await requireContact(db, contact_id);
  checkContactType(contact, contact_type);

  await db.run(
    `INSERT INTO activities (id, contact_id, type, summary, detail, date, created_by, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      contact_id,
      type,
      summary,
      detail ?? null,
      date ?? new Date().toISOString(),
      created_by ?? null,
      ticket_id ?? null,
    ]
  );

  const row = await db.get<Activity>("SELECT * FROM activities WHERE id = ?", [id]);
  recordChangeMeta(row!, { oldValues: null, newValues: { ...row! } });
  return row!;
}

/**
 * A contact's timeline — by `contact_id` (unchanged from before AU10), or,
 * new in AU10 (§5), by `email` or `email_domain`: an exact, case-insensitive
 * match against `contacts.email` or the part after its `@`. Exactly one of
 * the three must be given.
 *
 * Archived contacts: `contact_id` is a direct-by-id lookup (like get_contact)
 * and is never filtered by archived status — an archived contact's timeline
 * is still readable by its id, unchanged from before. `email`/`email_domain`
 * resolve to a contact the same way find_contacts' search does, so they
 * follow find_contacts' policy: archived contacts are excluded unless
 * `include_archived` is passed.
 *
 * `email_domain` can match more than one contact (the test this is written
 * for: two contacts on the same domain, a third on another domain excluded)
 * — every matching contact's activities are included, interleaved by date.
 *
 * `since` (optional, ISO 8601) keeps only activities with `date >= since`.
 * Every returned item carries `contact_id`, the contact's `name`, and
 * `ticket_id` (AU10 §5) — see mapActivity.
 */
export async function get_timeline(db: Db, args: Record<string, any>) {
  const { contact_id, email, email_domain, since, limit = 20, include_archived } = args;

  const given = [contact_id, email, email_domain].filter((v) => v !== undefined && v !== null && v !== "");
  if (given.length !== 1) {
    throw new Error(
      `get_timeline requires exactly one of contact_id, email, email_domain — got ${given.length}.`
    );
  }

  const namesById = new Map<string, string>();
  let contactIds: string[];

  if (contact_id !== undefined && contact_id !== null && contact_id !== "") {
    // Unchanged from before AU10: no existence check, no archived filter —
    // a contact_id with no matching activities simply yields an empty list.
    contactIds = [contact_id];
  } else {
    const archivedClause = include_archived ? "" : "AND archived = 0";
    let matches: Array<{ id: string; name: string }>;
    if (email !== undefined && email !== null && email !== "") {
      matches = await db.all<{ id: string; name: string }>(
        `SELECT id, name FROM contacts WHERE LOWER(email) = ? ${archivedClause}`,
        [String(email).toLowerCase()]
      );
    } else {
      const domain = String(email_domain).toLowerCase();
      matches = await db.all<{ id: string; name: string }>(
        `SELECT id, name FROM contacts WHERE LOWER(email) LIKE ? ESCAPE '\\' ${archivedClause}`,
        [`%@${escapeLike(domain)}`]
      );
    }
    for (const m of matches) namesById.set(m.id, m.name);
    contactIds = matches.map((m) => m.id);
    if (contactIds.length === 0) return [];
  }

  const placeholders = contactIds.map(() => "?").join(", ");
  const conditions = [`contact_id IN (${placeholders})`];
  const params: any[] = [...contactIds];
  if (since !== undefined && since !== null && since !== "") {
    conditions.push("date >= ?");
    params.push(since);
  }
  params.push(limit);

  const rows = await db.all<Activity>(
    `SELECT * FROM activities WHERE ${conditions.join(" AND ")} ORDER BY date DESC LIMIT ?`,
    params
  );

  // The contact_id path never looked up a name above — do it now (one lookup
  // covers every row, since they all share the same contact_id).
  if (namesById.size === 0 && rows.length > 0) {
    const contacts = await db.all<{ id: string; name: string }>(
      `SELECT id, name FROM contacts WHERE id IN (${placeholders})`,
      contactIds
    );
    for (const c of contacts) namesById.set(c.id, c.name);
  }

  return rows.map((row) => mapActivity(row, namesById.get(row.contact_id) ?? null));
}
