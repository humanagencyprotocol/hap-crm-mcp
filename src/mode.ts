/**
 * Connector mode: `simulation` answers from the built-in simulated CRM (SQLite);
 * `live` talks to a real CRM through a live adapter.
 *
 * The switch exists so a three-week test runs on exactly the connector, tools and
 * profile that go live later — only the system behind the connector changes.
 * `live` requires CRM_LIVE_ADAPTER naming an installed adapter; without one it
 * refuses every call loudly instead of silently falling back to the simulation:
 * a test that believes it is live (or a go-live that is secretly still
 * simulated) is the failure this must not hide.
 *
 * `local` is this connector's first live adapter: the same CRM tools (create
 * contact, log activity, run a deal, ...) against their own database, separate
 * from the simulation's — a real, working CRM on this machine, no simulation
 * tools. Other live adapters (HubSpot, ...) plug in the same way — same
 * CRM_MODE=live switch, a different CRM_LIVE_ADAPTER value.
 */

export type CrmMode = "simulation" | "live";

export const MODES: readonly CrmMode[] = ["simulation", "live"];

export type LiveAdapter = "local";

export const LIVE_ADAPTERS: readonly LiveAdapter[] = ["local"];

/** Reads CRM_MODE (default `simulation`). An unknown value stops the server at start. */
export function getMode(env: NodeJS.ProcessEnv = process.env): CrmMode {
  const raw = (env.CRM_MODE ?? "").trim().toLowerCase();
  if (raw === "") return "simulation";
  if ((MODES as readonly string[]).includes(raw)) return raw as CrmMode;
  throw new Error(`CRM_MODE must be one of ${MODES.join(", ")} — got ${JSON.stringify(env.CRM_MODE)}.`);
}

/**
 * Reads CRM_LIVE_ADAPTER. Undefined (unset) means "no adapter installed" —
 * the caller falls back to LIVE_NOT_AVAILABLE. An unknown non-empty value
 * stops the server at start, the same way an unknown CRM_MODE does.
 */
export function getLiveAdapter(env: NodeJS.ProcessEnv = process.env): LiveAdapter | undefined {
  const raw = (env.CRM_LIVE_ADAPTER ?? "").trim().toLowerCase();
  if (raw === "") return undefined;
  if ((LIVE_ADAPTERS as readonly string[]).includes(raw)) return raw as LiveAdapter;
  throw new Error(`CRM_LIVE_ADAPTER must be one of ${LIVE_ADAPTERS.join(", ")} — got ${JSON.stringify(env.CRM_LIVE_ADAPTER)}.`);
}

export const LIVE_NOT_AVAILABLE =
  "Refused: this CRM connector is in live mode, but no live CRM adapter is installed. " +
  "Nothing was read or changed. Set CRM_MODE=simulation, or set CRM_LIVE_ADAPTER (e.g. \"local\") to install one.";
