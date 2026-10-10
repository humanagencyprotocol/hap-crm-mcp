/**
 * The revision rule, independent of which record type it applies to (see
 * docs/contact.md's general rule, mirrored from the ERP connector's quote
 * revision rule): a record that can be changed after creation, and that a
 * caller later acts on by name, carries an integer `revision` starting at 1.
 * Any successful change produces the next revision; an action naming a stale
 * one is refused, naming both.
 */
import { refuse } from "./refuse.js";

/**
 * Refuses the call when the caller's declared `revision` does not match the
 * record's current one — the same refuse() shape every other declared-value
 * mismatch in this connector uses, naming both revisions explicitly so a
 * caller can tell whether it is behind or ahead.
 */
export function requireCurrentRevision(doc: string, id: string, currentRevision: number, declaredRevision: unknown): void {
  if (declaredRevision !== currentRevision) {
    refuse(
      "revision",
      declaredRevision,
      currentRevision,
      `${doc} ${id} is at revision ${currentRevision}; this request is for revision ${declaredRevision}.`
    );
  }
}
