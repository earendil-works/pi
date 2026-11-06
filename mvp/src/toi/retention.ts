/**
 * Learned-memory gating from TOI retention, server side only.
 *
 * The phase-1 interim rule (`NLT_MEMORY_ENABLED=1`) is superseded by the
 * verified TOI's `privacy.retention`:
 *   - `user-controlled` / `long-term` / `permanent` → learned memories allowed
 *   - `session-only` / `short-term` → learned-memory recall and writes off
 *   - missing / unverifiable TOI → off
 *
 * This is the single source of truth for whether learned memory is on for a
 * turn. The runner consults it before any Mem0 recall; the save route consults
 * it before any Mem0 write.
 */

import type { ToiDocument } from "@neurolift-technologies/toi";

/** Retention values that permit learned-memory persistence. */
export const ALLOWED_RETENTION: ReadonlySet<string> = new Set([
  "user-controlled",
  "long-term",
  "permanent",
]);

/** Whether learned-memory recall and writes are allowed given the effective TOI. */
export function memoryAllowedByRetention(
  effectiveDoc: ToiDocument | undefined,
): boolean {
  const retention =
    effectiveDoc?.privacy?.retention ??
    (effectiveDoc?.custom as Record<string, unknown> | undefined)?.retention;
  if (typeof retention !== "string") return false;
  return ALLOWED_RETENTION.has(retention);
}