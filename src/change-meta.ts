/**
 * Side channel for the `changes` table's old/new value columns. A write tool
 * attaches the before/after values it actually changed to its own return
 * value through this registry, keyed by object identity rather than a
 * visible property — so dispatch.ts can read them while JSON.stringify and
 * MCP's structuredContent (which only see an object's own enumerable
 * properties) stay exactly the document, nothing extra.
 */

export interface ChangeMeta {
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
}

const registry = new WeakMap<object, ChangeMeta>();

export function recordChangeMeta(result: object, meta: ChangeMeta): void {
  registry.set(result, meta);
}

export function readChangeMeta(result: unknown): ChangeMeta {
  if (result && typeof result === "object") return registry.get(result as object) ?? {};
  return {};
}
