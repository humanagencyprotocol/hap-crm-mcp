/**
 * Company file: the test data the simulated CRM starts from. Uses the SAME file
 * format as the ERP connector's company file (name, currency, items, customers)
 * so one file can describe the whole simulated world for a pilot that runs both
 * connectors — the ERP's `items` are accepted (and validated) here but not used;
 * only `customers` seeds this connector, one contact per customer. An optional
 * top-level `contacts[]` extends that world with CRM-native records (leads,
 * partners, vendors) the ERP has no concept of.
 *
 * Validated strictly and refused whole on the first problem: a half-loaded or
 * silently "fixed" company would make every later measurement of correctness
 * compare against data nobody wrote.
 */
import { readFileSync } from "fs";

export const CONTACT_TYPES = ["customer", "lead", "partner", "vendor"] as const;
export const CONTACT_STAGES = ["new", "active", "inactive", "churned"] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];
export type ContactStage = (typeof CONTACT_STAGES)[number];

// Kept for shared-format compatibility with the ERP company file. Validated so
// the file is refused the same way the ERP would refuse it, but otherwise unused
// here — the CRM has no concept of catalog items.
export interface CompanyItem {
  id: string;
  sku: string;
  name: string;
  unit: string;
  list_price: number;
  stock: number;
}

export interface CompanyCustomer {
  id: string;
  name: string;
  email: string | null;
  country: string | null;
  credit_limit: number;
  open_balance: number;
  payment_terms: string | null;
}

export interface CompanyContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  role: string | null;
  type: ContactType;
  stage: ContactStage;
  tags: string[];
  notes: string | null;
}

export interface Company {
  name: string;
  currency: string;
  items: CompanyItem[];
  customers: CompanyCustomer[];
  contacts: CompanyContact[];
}

function fail(path: string, msg: string): never {
  throw new Error(`Company file ${path}: ${msg}`);
}

function str(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function strOrNull(v: unknown): string | null {
  return str(v) ? v : null;
}

/** Shared item-row validation — kept only for shared-format parity with the ERP company file; CRM does not use the result. */
function parseItemEntry(it: unknown, i: number, path: string, skus: Set<string>): CompanyItem {
  const o = (it ?? {}) as Record<string, unknown>;
  const at = `items[${i}]`;
  if (!str(o.sku)) fail(path, `${at}.sku is required`);
  if (skus.has(o.sku)) fail(path, `${at}.sku ${JSON.stringify(o.sku)} appears twice`);
  skus.add(o.sku);
  if (!str(o.name)) fail(path, `${at}.name is required`);
  if (!num(o.list_price) || o.list_price < 0) fail(path, `${at}.list_price must be a number >= 0`);
  if (!num(o.stock) || !Number.isInteger(o.stock) || o.stock < 0) fail(path, `${at}.stock must be a whole number >= 0`);
  return {
    id: str(o.id) ? o.id : `item-${i + 1}`,
    sku: o.sku,
    name: o.name,
    unit: str(o.unit) ? o.unit : "pcs",
    list_price: o.list_price,
    stock: o.stock,
  };
}

/** Shared customer-row validation — used by both the company file and the simulation package. */
function parseCustomerEntry(cu: unknown, i: number, path: string): CompanyCustomer {
  const o = (cu ?? {}) as Record<string, unknown>;
  const at = `customers[${i}]`;
  if (!str(o.name)) fail(path, `${at}.name is required`);
  if (!num(o.credit_limit) || o.credit_limit < 0) fail(path, `${at}.credit_limit must be a number >= 0`);
  const open = o.open_balance ?? 0;
  if (!num(open) || open < 0) fail(path, `${at}.open_balance must be a number >= 0`);
  return {
    id: str(o.id) ? o.id : `cust-${i + 1}`,
    name: o.name,
    email: strOrNull(o.email),
    country: strOrNull(o.country),
    credit_limit: o.credit_limit,
    open_balance: open,
    payment_terms: strOrNull(o.payment_terms),
  };
}

/** Shared contact-row validation — used by both the company file and the simulation package. */
function parseContactEntry(ct: unknown, i: number, path: string): CompanyContact {
  const o = (ct ?? {}) as Record<string, unknown>;
  const at = `contacts[${i}]`;
  if (!str(o.name)) fail(path, `${at}.name is required`);
  if (o.type !== undefined && !(CONTACT_TYPES as readonly string[]).includes(o.type as string)) {
    fail(path, `${at}.type must be one of ${CONTACT_TYPES.join(", ")}`);
  }
  if (o.stage !== undefined && !(CONTACT_STAGES as readonly string[]).includes(o.stage as string)) {
    fail(path, `${at}.stage must be one of ${CONTACT_STAGES.join(", ")}`);
  }
  let tags: string[] = [];
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags) || o.tags.some((t) => typeof t !== "string")) {
      fail(path, `${at}.tags must be a list of strings`);
    }
    tags = o.tags as string[];
  }
  return {
    id: str(o.id) ? o.id : `contact-${i + 1}`,
    name: o.name,
    email: strOrNull(o.email),
    phone: strOrNull(o.phone),
    company: strOrNull(o.company),
    role: strOrNull(o.role),
    type: (o.type as ContactType) ?? "customer",
    stage: (o.stage as ContactStage) ?? "new",
    tags,
    notes: strOrNull(o.notes),
  };
}

function parseContactsField(rawContacts: unknown, path: string): CompanyContact[] {
  if (rawContacts !== undefined && !Array.isArray(rawContacts)) fail(path, "`contacts` must be a list");
  return ((rawContacts ?? []) as unknown[]).map((ct, i) => parseContactEntry(ct, i, path));
}

/** Contacts share one table (and one id space) with the customers they are seeded
 * alongside — a collision would silently overwrite one contact with another. */
function checkNoContactIdCollision(path: string, customers: CompanyCustomer[], contacts: CompanyContact[]): void {
  const contactIds = new Set<string>();
  for (const { id } of [...customers, ...contacts]) {
    if (contactIds.has(id)) fail(path, `contact id ${JSON.stringify(id)} appears twice (across customers and contacts)`);
    contactIds.add(id);
  }
}

export function parseCompany(raw: unknown, path = "(inline)"): Company {
  if (!raw || typeof raw !== "object") fail(path, "must be a JSON object");
  const c = raw as Record<string, unknown>;
  if (!str(c.name)) fail(path, "`name` is required");
  if (!str(c.currency) || !/^[A-Z]{3}$/.test(c.currency)) fail(path, "`currency` must be a 3-letter ISO code, e.g. EUR");
  if (!Array.isArray(c.items) || c.items.length === 0) fail(path, "`items` must be a non-empty list");
  if (!Array.isArray(c.customers) || c.customers.length === 0) fail(path, "`customers` must be a non-empty list");

  // Items: validated for shared-format parity with the ERP company file, not used further.
  const skus = new Set<string>();
  const items = c.items.map((it, i) => parseItemEntry(it, i, path, skus));
  const customers = c.customers.map((cu, i) => parseCustomerEntry(cu, i, path));
  const contacts = parseContactsField(c.contacts, path);

  for (const [label, list] of [["item", items], ["customer", customers]] as const) {
    const ids = new Set<string>();
    for (const { id } of list) {
      if (ids.has(id)) fail(path, `${label} id ${JSON.stringify(id)} appears twice`);
      ids.add(id);
    }
  }
  checkNoContactIdCollision(path, customers, contacts);

  return { name: c.name, currency: c.currency, items, customers, contacts };
}

export function loadCompanyFile(path: string): Company {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(path, `cannot be read as JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseCompany(raw, path);
}

/**
 * Simulation package: the flat JSON format shared with the ERP connector and
 * the email simulator (`name`, `currency`, `customers[]`, optional
 * `contacts[]`). Unlike the company file above, the CRM package does NOT
 * require `items`/`products` — the CRM has no concept of a catalog, so that
 * field (ERP-only) and `cases` (email-only) are accepted and ignored rather
 * than validated.
 */
export interface SimulationPackage {
  name: string;
  currency: string;
  customers: CompanyCustomer[];
  contacts: CompanyContact[];
}

export function parseSimulationPackage(raw: unknown, path = "(inline)"): SimulationPackage {
  if (!raw || typeof raw !== "object") fail(path, "must be a JSON object");
  const c = raw as Record<string, unknown>;
  if (!str(c.name)) fail(path, "`name` is required");
  if (!str(c.currency) || !/^[A-Z]{3}$/.test(c.currency)) fail(path, "`currency` must be a 3-letter ISO code, e.g. EUR");
  if (!Array.isArray(c.customers) || c.customers.length === 0) fail(path, "`customers` must be a non-empty list");

  const customers = c.customers.map((cu, i) => parseCustomerEntry(cu, i, path));
  const contacts = parseContactsField(c.contacts, path);

  const customerIds = new Set<string>();
  for (const { id } of customers) {
    if (customerIds.has(id)) fail(path, `customer id ${JSON.stringify(id)} appears twice`);
    customerIds.add(id);
  }
  checkNoContactIdCollision(path, customers, contacts);

  return { name: c.name, currency: c.currency, customers, contacts };
}

/**
 * The contacts this company (or simulation package — both share this shape)
 * seeds: one `customer`-type contact per `customers[]` entry (id reused from
 * the customer, so the same business entity has the same id in both
 * connectors sharing this file), followed by any CRM-native `contacts[]`.
 */
export function companyContacts(company: { customers: CompanyCustomer[]; contacts: CompanyContact[] }): CompanyContact[] {
  const fromCustomers: CompanyContact[] = company.customers.map((cu) => ({
    id: cu.id,
    name: cu.name,
    email: cu.email,
    phone: null,
    company: cu.name,
    role: null,
    type: "customer",
    stage: "new",
    tags: [],
    notes: cu.country ? `Country: ${cu.country}` : null,
  }));
  return [...fromCustomers, ...company.contacts];
}
