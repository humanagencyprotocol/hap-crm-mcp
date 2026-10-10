/**
 * The one refusal shape every declared-value mismatch in this connector uses —
 * naming the field, what was declared, and what was expected or actual.
 * Mirrors the ERP connector's `refuse()` exactly (same message format), so a
 * caller reading refusals from either connector sees one consistent shape.
 */

export class RefusalError extends Error {}

/** Refuse naming the field, the declared value, and the expected/actual value. */
export function refuse(field: string, declared: unknown, expected: unknown, extra?: string): never {
  const suffix = extra ? ` ${extra}` : "";
  throw new RefusalError(
    `Refused: ${field} mismatch — declared ${JSON.stringify(declared)}, expected ${JSON.stringify(expected)}.${suffix}`
  );
}
