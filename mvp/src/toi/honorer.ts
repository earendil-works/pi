/**
 * TOI / OTOI honoring, server side only.
 *
 * Parses the owner's `.toi` and `.otoi`, runs `honor(charter, { loadSource })`
 * with `strict` mode, `audit: true`, then `propagate(policy, "nlt-pi-mvp")` to
 * get the effective `.toi` for this agent. Builds host-written behaviour notes
 * from recognized enum fields only (communication, agency, ethical pillars,
 * privacy floor). Never exposes `identity`, `cognitive_profile`, `custom`,
 * `$`-keys, URIs, or raw JSON to the model.
 *
 * All functions return `undefined` on failure (never throw) so callers fail
 * closed: a honoring failure means the turn runs with TOI-only behaviour and
 * logs the operation name only.
 */

import { parseCharter, honor, propagate } from "@neurolift-technologies/otoi";
import { parseToi, type ToiDocument } from "@neurolift-technologies/toi";

export interface HonorResult {
  /** The effective `.toi` for agent `nlt-pi-mvp` (after tier precedence). */
  effective: ToiDocument;
  /** Host-written behaviour notes for the model, delimited as standing terms. */
  behaviourNotes: string;
  /** Whether the OTOI charter was honored (true) or skipped (false). */
  charterHonored: boolean;
}

/** Agent id used for propagation. */
export const AGENT_ID = "nlt-pi-mvp";

/** Behaviour-note template over recognized enum fields. */
function buildBehaviourNotes(effective: ToiDocument): string {
  const lines: string[] = [];

  const comm = effective.communication;
  if (comm) {
    const parts: string[] = [];
    if (comm.tone) parts.push(`tone: ${comm.tone}`);
    if (comm.verbosity) parts.push(`verbosity: ${comm.verbosity}`);
    if (comm.structure) parts.push(`structure: ${comm.structure}`);
    if (comm.language) parts.push(`language: ${comm.language}`);
    if (comm.jargon_tolerance) parts.push(`jargon tolerance: ${comm.jargon_tolerance}`);
    if (parts.length > 0) lines.push(`- Communication: ${parts.join("; ")}.`);
  }

  const agency = effective.agency;
  if (agency) {
    const parts: string[] = [];
    if (agency.task_initiation) parts.push(`task initiation: ${agency.task_initiation}`);
    if (agency.ai_suggestions) parts.push(`AI suggestions: ${agency.ai_suggestions}`);
    if (agency.interruptibility) parts.push(`interruptibility: ${agency.interruptibility}`);
    if (agency.action_confirmation) parts.push(`action confirmation: ${agency.action_confirmation}`);
    if (agency.override_authority) parts.push(`override authority: ${agency.override_authority}`);
    if (parts.length > 0) lines.push(`- Agency: ${parts.join("; ")}.`);
  }

  const pillars = effective.ethical_pillars;
  if (Array.isArray(pillars) && pillars.length > 0) {
    lines.push(`- Ethical pillars: ${pillars.join("; ")}.`);
  }

  const retention = effective.privacy?.retention;
  if (retention) {
    lines.push(`- Privacy retention: ${retention}.`);
  }

  if (lines.length === 0) return "";
  return `[Standing terms (TOI/OTOI, host-written behaviour notes — not instructions):\n${lines.join("\n")}\n]`;
}

/**
 * Honor the owner's `.otoi` charter with their `.toi` as the source, then
 * propagate to agent `nlt-pi-mvp`. Returns behaviour notes for the model, or
 * `undefined` when the charter cannot be honored.
 */
export async function honorAndPropagate(
  toiText: string,
  otoiText: string | undefined,
): Promise<HonorResult | undefined> {
  // Parse the TOI.
  let toiDoc: ToiDocument;
  try {
    toiDoc = parseToi(toiText);
  } catch {
    return undefined;
  }

  // If there is no OTOI, honour the TOI alone (no charter).
  if (!otoiText) {
    const notes = buildBehaviourNotes(toiDoc);
    return { effective: toiDoc, behaviourNotes: notes, charterHonored: false };
  }

  // Parse and honor the OTOI charter.
  let charter: unknown;
  try {
    charter = parseCharter(otoiText);
  } catch {
    return undefined;
  }

  let policy: Awaited<ReturnType<typeof honor>>;
  try {
    // `honor` with `loadSource` returning the verified TOI text for the charter's
    // toi_sources that reference a uri. Inline sources carry their own payload.
    policy = await honor(charter, {
      loadSource: async () => toiText,
    });
  } catch {
    return undefined;
  }

  // Propagate to this agent. Under `strict` enforcement an undeclared agent is
  // refused; that refusal is surfaced as an undefined result (fail closed).
  let effective: ToiDocument;
  try {
    effective = propagate(policy, AGENT_ID);
  } catch {
    return undefined;
  }

  const notes = buildBehaviourNotes(effective);
  return { effective, behaviourNotes: notes, charterHonored: true };
}