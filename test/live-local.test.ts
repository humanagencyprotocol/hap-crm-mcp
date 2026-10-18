/**
 * Mode/adapter wiring for the "local" live adapter: CRM_MODE=live +
 * CRM_LIVE_ADAPTER=local routes the exact same tool handlers the simulation
 * uses against a separate database — no second implementation. Pins:
 *
 * - `getLiveAdapter` reads/validates CRM_LIVE_ADAPTER the same way
 *   `getMode` reads CRM_MODE;
 * - live mode WITHOUT an adapter (or an unrecognized one) still refuses
 *   everything with LIVE_NOT_AVAILABLE, unchanged — re-pinned here using the
 *   explicit `env` parameter so it never depends on process.env state;
 * - live+local refuses the simulation-only test-data tools
 *   (load_simulation/clear_simulation) clearly, without touching the
 *   database, while every other tool runs exactly as it does in simulation
 *   — same create/read/update/delete, same change/refusal recording;
 * - the local adapter's database is a separate file from the simulation's:
 *   data created in one is never visible from the other, in either
 *   direction;
 * - `resolveLocalDatabaseUrl` defaults to `<HAP_DATA_DIR>/crm-local.sqlite`
 *   and honors an explicit CRM_LOCAL_DATABASE_URL override;
 * - the `export` CLI command follows the same mode/adapter switch as the
 *   server, so it reads the local database when the env selects local mode.
 */
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { execFileSync } from "child_process";
import { createDb, resolveLocalDatabaseUrl, type Db } from "../src/db.js";
import { callTool, SIMULATION_ONLY_TOOLS } from "../src/dispatch.js";
import { LIVE_NOT_AVAILABLE, getLiveAdapter } from "../src/mode.js";

let dataDir: string;
let simDb: Db;
let localDb: Db;

afterEach(async () => {
  if (simDb) await simDb.close();
  if (localDb) await localDb.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  simDb = undefined as unknown as Db;
  localDb = undefined as unknown as Db;
  dataDir = "";
  delete process.env.DATABASE_URL;
  delete process.env.CRM_LOCAL_DATABASE_URL;
  delete process.env.HAP_DATA_DIR;
});

describe("getLiveAdapter", () => {
  it("is undefined when unset", () => {
    expect(getLiveAdapter({})).toBeUndefined();
  });
  it("reads \"local\" (trimmed, case-insensitive)", () => {
    expect(getLiveAdapter({ CRM_LIVE_ADAPTER: " Local " })).toBe("local");
  });
  it("throws on an unknown adapter", () => {
    expect(() => getLiveAdapter({ CRM_LIVE_ADAPTER: "hubspot" })).toThrow(/CRM_LIVE_ADAPTER must be one of local/);
  });
});

describe("resolveLocalDatabaseUrl", () => {
  it("defaults to <HAP_DATA_DIR>/crm-local.sqlite", () => {
    expect(resolveLocalDatabaseUrl({ HAP_DATA_DIR: "/tmp/hap-data" })).toBe("/tmp/hap-data/crm-local.sqlite");
  });
  it("falls back to ~/.hap when HAP_DATA_DIR is unset", () => {
    expect(resolveLocalDatabaseUrl({})).toMatch(/\.hap\/crm-local\.sqlite$/);
  });
  it("honors an explicit CRM_LOCAL_DATABASE_URL override", () => {
    expect(resolveLocalDatabaseUrl({ CRM_LOCAL_DATABASE_URL: "/custom/path.sqlite", HAP_DATA_DIR: "/tmp/hap-data" }))
      .toBe("/custom/path.sqlite");
  });
});

describe("live mode without an adapter — unchanged", () => {
  it("still refuses with LIVE_NOT_AVAILABLE, explicit env, no process.env mutation", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crm-live-local-"));
    const dbPath = join(dataDir, "crm.db");
    simDb = await createDb(null, dbPath);
    await expect(callTool(simDb, "live", "find_contacts", {}, {})).rejects.toThrow(LIVE_NOT_AVAILABLE);
    await expect(callTool(simDb, "live", "create_contact", { name: "Nope Inc", type: "customer", ticket_id: "t-1" }, {})).rejects.toThrow(LIVE_NOT_AVAILABLE);
    expect(await simDb.all(`SELECT * FROM contacts`)).toHaveLength(0);
    expect(await simDb.all(`SELECT * FROM refusals`)).toHaveLength(0);
  });

  it("an unknown adapter value stops the call at start, same as an unknown CRM_MODE", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crm-live-local-"));
    simDb = await createDb(null, join(dataDir, "crm.db"));
    await expect(
      callTool(simDb, "live", "find_contacts", {}, { CRM_LIVE_ADAPTER: "hubspot" })
    ).rejects.toThrow(/CRM_LIVE_ADAPTER must be one of local/);
  });
});

describe("live mode, adapter=local", () => {
  function envFor(dir: string): NodeJS.ProcessEnv {
    return { CRM_LIVE_ADAPTER: "local", HAP_DATA_DIR: dir } as NodeJS.ProcessEnv;
  }

  async function setup() {
    dataDir = mkdtempSync(join(tmpdir(), "crm-live-local-"));
    localDb = await createDb(null, resolveLocalDatabaseUrl({ HAP_DATA_DIR: dataDir }));
  }

  it("refuses load_simulation/clear_simulation clearly, and touches nothing", async () => {
    await setup();
    const env = envFor(dataDir);
    for (const name of ["load_simulation", "clear_simulation"]) {
      const err = await callTool(localDb, "live", name, {}, env).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/simulation-only test-data tooling/);
      expect((err as Error).message).toMatch(/not available in live mode/);
    }
    expect(await localDb.all(`SELECT * FROM simulation_load`)).toHaveLength(0);
    expect(await localDb.all(`SELECT * FROM refusals`)).toHaveLength(0);
  });

  it("SIMULATION_ONLY_TOOLS names exactly the two test-data tools", () => {
    expect(SIMULATION_ONLY_TOOLS).toEqual(new Set(["load_simulation", "clear_simulation"]));
  });

  it("runs the exact same handlers as simulation: create, read, update, delete", async () => {
    await setup();
    const env = envFor(dataDir);

    const created = (await callTool(localDb, "live", "create_contact", {
      name: "Huber Maschinenbau", type: "customer", email: "einkauf@huber.example", ticket_id: "t-1",
    }, env)) as any;
    expect(created).toMatchObject({ name: "Huber Maschinenbau", type: "customer", revision: 1 });

    const found = (await callTool(localDb, "live", "find_contacts", { name: "Huber" }, env)) as any[];
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(created.id);

    const updated = (await callTool(localDb, "live", "update_contact", {
      id: created.id, revision: 1, contact_type: "customer", notes: "called back", ticket_id: "t-2",
    }, env)) as any;
    expect(updated).toMatchObject({ notes: "called back", revision: 2 });

    const deleted = (await callTool(localDb, "live", "delete_contact", {
      id: created.id, revision: 2, contact_type: "customer", ticket_id: "t-3",
    }, env)) as any;
    expect(deleted).toBeTruthy();

    const archived = await localDb.get<{ archived: number }>(`SELECT archived FROM contacts WHERE id = ?`, [created.id]);
    expect(archived?.archived).toBe(1);
  });

  it("records changes with ticket_id, exactly as the simulation does", async () => {
    await setup();
    const env = envFor(dataDir);
    await callTool(localDb, "live", "create_contact", { name: "Acme", type: "customer", ticket_id: "t-9" }, env);
    const changes = await localDb.all<any>(`SELECT * FROM changes`);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ tool: "create_contact", receipt_id: "t-9" });
  });

  it("records a post-gateway refusal (stale revision) in `refusals`, same as simulation", async () => {
    await setup();
    const env = envFor(dataDir);
    const created = (await callTool(localDb, "live", "create_contact", { name: "Acme", type: "customer" }, env)) as any;
    const err = await callTool(localDb, "live", "update_contact", {
      id: created.id, revision: 99, contact_type: "customer", notes: "x", ticket_id: "t-stale",
    }, env).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const refusals = await localDb.all<any>(`SELECT * FROM refusals`);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ tool: "update_contact", receipt_id: "t-stale" });
  });

  it("no simulation-specific wording leaks into an ordinary result", async () => {
    await setup();
    const env = envFor(dataDir);
    const created = (await callTool(localDb, "live", "create_contact", { name: "Acme", type: "customer" }, env)) as any;
    const text = JSON.stringify(created).toLowerCase();
    expect(text).not.toMatch(/simulation|test data|package/);
  });
});

describe("local adapter database is separate from the simulation's", () => {
  it("a contact created in simulation is invisible to local, and vice versa", async () => {
    dataDir = mkdtempSync(join(tmpdir(), "crm-live-local-"));
    const env = { CRM_LIVE_ADAPTER: "local", HAP_DATA_DIR: dataDir } as NodeJS.ProcessEnv;

    simDb = await createDb(null, join(dataDir, "crm.db"));
    localDb = await createDb(null, resolveLocalDatabaseUrl({ HAP_DATA_DIR: dataDir }));

    await callTool(simDb, "simulation", "create_contact", { name: "Simulated Co", type: "customer" }, env);
    await callTool(localDb, "live", "create_contact", { name: "Real Co", type: "customer" }, env);

    const simContacts = await simDb.all<any>(`SELECT name FROM contacts`);
    const localContacts = await localDb.all<any>(`SELECT name FROM contacts`);
    expect(simContacts).toEqual([{ name: "Simulated Co" }]);
    expect(localContacts).toEqual([{ name: "Real Co" }]);

    // Different files on disk.
    expect(join(dataDir, "crm.db")).not.toBe(resolveLocalDatabaseUrl({ HAP_DATA_DIR: dataDir }));
    expect(existsSync(join(dataDir, "crm.db"))).toBe(true);
    expect(existsSync(resolveLocalDatabaseUrl({ HAP_DATA_DIR: dataDir }))).toBe(true);
  });
});

describe("CLI export follows the same mode/adapter switch", () => {
  const CLI_PATH = join(__dirname, "..", "dist", "index.js");

  it("exports from the local database when CRM_MODE=live, CRM_LIVE_ADAPTER=local", () => {
    if (!existsSync(CLI_PATH)) {
      // dist/ is built by `npm run build` before `npm test` in CI; skip gracefully
      // if invoked without a build (e.g. a bare `vitest run` during development).
      return;
    }
    dataDir = mkdtempSync(join(tmpdir(), "crm-live-local-cli-"));
    const env = { ...process.env, HAP_DATA_DIR: dataDir, CRM_MODE: "live", CRM_LIVE_ADAPTER: "local", DATABASE_URL: "" };
    delete (env as any).DATABASE_URL;

    const out = execFileSync(process.execPath, [CLI_PATH, "export"], { env }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.mode).toBe("live");
    expect(parsed.contacts).toEqual([]);
    expect(existsSync(join(dataDir, "crm-local.sqlite"))).toBe(true);
    expect(existsSync(join(dataDir, "crm.db"))).toBe(false);
  });

  it("exports from the simulation database by default (unchanged)", () => {
    if (!existsSync(CLI_PATH)) return;
    dataDir = mkdtempSync(join(tmpdir(), "crm-live-local-cli-"));
    const env = { ...process.env, HAP_DATA_DIR: dataDir };
    delete (env as any).DATABASE_URL;
    delete (env as any).CRM_MODE;
    delete (env as any).CRM_LIVE_ADAPTER;

    const out = execFileSync(process.execPath, [CLI_PATH, "export"], { env }).toString();
    const parsed = JSON.parse(out);
    expect(parsed.mode).toBe("simulation");
    expect(existsSync(join(dataDir, "crm.db"))).toBe(true);
    expect(existsSync(join(dataDir, "crm-local.sqlite"))).toBe(false);
  });
});
