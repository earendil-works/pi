/**
 * Governance gate for the NLT Coding Agent MVP governed turn.
 *
 * Decides whether an ASFDK assessment permits an agent turn to run. This is
 * deliberately kept free of coding-agent runtime imports so it can be tested in
 * isolation.
 *
 * Fail-closed rules:
 * - A critical or emergency crisis reading blocks the turn.
 * - Any explicit suicidal ideation / self-harm / inability-to-ensure-safety flag blocks the turn.
 * - A failed interaction, an unavailable emotional assessment, or a missing emotional state blocks the turn.
 *   The foundation returns no emotional state (and involves no components) in modes that disable Sleepwalker,
 *   for example `crisis_only` and `framework`, so those modes cannot clear this gate.
 *
 * Crisis levels are compared against the foundation's own `rrt.CrisisLevel` enum
 * values ("critical" and "emergency"), not their member names ("RED"/"BLACK").
 */

import { rrt, type FoundationResponse } from "@neurolift-technologies/asfdk";

/** Crisis levels that require human escalation before any agent turn may run. */
const BLOCKING_CRISIS_LEVELS: ReadonlySet<string> = new Set<string>([
  rrt.CrisisLevel.RED,
  rrt.CrisisLevel.BLACK,
]);

const HIGH_RISK_FLAGS = ["explicitSuicidalIdeation", "selfHarmIndicators", "inabilityToEnsureSafety"] as const;

export interface GateDecision {
  allowed: boolean;
  crisisLevel: string | null;
  blockedReason: string | null;
  /** True when the turn was blocked because the assessment could not run or was incomplete (not because of a crisis reading). */
  assessmentFailed: boolean;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

export function extractCrisisLevel(
  interaction: FoundationResponse | undefined,
  emotionalState: unknown,
): string | null {
  const rrtResult = toRecord(toRecord(interaction?.content).rrt);
  if (typeof rrtResult.crisisLevel === "string") {
    return rrtResult.crisisLevel;
  }
  const state = toRecord(emotionalState);
  const stateLevel = state.crisisLevel ?? state.level;
  return typeof stateLevel === "string" ? stateLevel : null;
}

/**
 * The foundation nests the flags: `emotionalState` is `{ emotionalState: { ...flags }, ... }`,
 * and the interaction content carries another copy. Check every location.
 */
function hasHighRiskFlag(interaction: FoundationResponse | undefined, emotionalState: unknown): boolean {
  const outer = toRecord(emotionalState);
  const candidates = [outer, toRecord(outer.emotionalState), toRecord(toRecord(interaction?.content).emotionalState)];
  return candidates.some((candidate) => HIGH_RISK_FLAGS.some((flag) => candidate[flag] === true));
}

export function evaluateGate(interaction: FoundationResponse | undefined, emotionalState: unknown): GateDecision {
  const crisisLevel = extractCrisisLevel(interaction, emotionalState);
  const highRisk = BLOCKING_CRISIS_LEVELS.has(crisisLevel ?? "") || hasHighRiskFlag(interaction, emotionalState);
  if (highRisk) {
    return {
      allowed: false,
      crisisLevel,
      blockedReason: `Crisis intervention required before agent turn execution (level: ${crisisLevel ?? "unknown"})`,
      assessmentFailed: false,
    };
  }

  const assessmentFailed =
    interaction === undefined ||
    interaction.success === false ||
    emotionalState === null ||
    emotionalState === undefined ||
    toRecord(emotionalState).error !== undefined;
  if (assessmentFailed) {
    return {
      allowed: false,
      crisisLevel,
      blockedReason: "Governance assessment failed before agent turn execution",
      assessmentFailed: true,
    };
  }

  return { allowed: true, crisisLevel, blockedReason: null, assessmentFailed: false };
}
