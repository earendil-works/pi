/**
 * apex_scoring — 5D-native fitness evaluation
 * Pi-mono Self-Evolution Engine
 *
 * Fitness IS the importance field in 5D — derived, not stored separately.
 * This is the core insight: no parallel fitness metadata needed.
 */

import type { MemoryEngine, MemoryRecord } from "./memory/types.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  duration_ms: number;
  tool_calls?: string[];
}

export interface FitnessProfile {
  importance: number;        // directly from 5D = fitness
  accessCount: number;       // invocation count
  recencyScore: number;       // 0..1, exponential decay (30d half-life)
  systemDeltaG: number;      // system-level health
  overallFitness: number;   // weighted
}

export interface ScoreBreakdown {
  executionSuccess: boolean;
  profile: FitnessProfile;
  thresholds: {
    active: boolean;      // importance >= 0.6
    reDistill: boolean;   // 0.3 <= importance < 0.6
    deprecated: boolean;  // importance < 0.3
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
const THRESHOLD_ACTIVE = 0.6;
const THRESHOLD_REDISTILL = 0.3;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Score a memory record after an execution result.
 * Fitness is derived from 5D importance — no separate storage.
 */
export async function apex_scoring(
  engine: MemoryEngine,
  record: MemoryRecord,
  result: ExecutionResult
): Promise<ScoreBreakdown> {
  const now = Date.now();
  const ageMs = now - record.accessedAt;
  const recencyScore = Math.exp(-ageMs / RECENCY_HALF_LIFE_MS);

  const health = await engine.health();
  const systemDeltaG = health.deltaG;

  // Bump on success, decay on failure
  const importanceDelta = result.success ? 0.05 : -0.1;
  const overallFitness = Math.max(0, Math.min(1, record.importance + importanceDelta));

  return {
    executionSuccess: result.success,
    profile: {
      importance: record.importance,
      accessCount: record.accessCount,
      recencyScore,
      systemDeltaG,
      overallFitness,
    },
    thresholds: {
      active: overallFitness >= THRESHOLD_ACTIVE,
      reDistill: overallFitness >= THRESHOLD_REDISTILL && overallFitness < THRESHOLD_ACTIVE,
      deprecated: overallFitness < THRESHOLD_REDISTILL,
    },
  };
}

/**
 * Score an entire pool of memory hits — aggregate fitness of the skill pool.
 */
export async function apex_scoring_pool(
  engine: MemoryEngine,
  hits: MemoryHit[]
): Promise<{
  avgImportance: number;
  maxImportance: number;
  systemDeltaG: number;
  poolHealth: "healthy" | "degraded" | "critical";
}> {
  if (hits.length === 0) {
    return { avgImportance: 0, maxImportance: 0, systemDeltaG: -1, poolHealth: "critical" };
  }
  const health = await engine.health();
  const deltaG = health.deltaG;
  const importances = hits.map(h => h.record.importance);
  const avgImportance = importances.reduce((a, b) => a + b, 0) / importances.length;
  const maxImportance = Math.max(...importances);

  let poolHealth: "healthy" | "degraded" | "critical";
  if (deltaG > 0.5 && avgImportance > 0.5) poolHealth = "healthy";
  else if (deltaG > 0 || avgImportance > 0.3) poolHealth = "degraded";
  else poolHealth = "critical";

  return { avgImportance, maxImportance, systemDeltaG: deltaG, poolHealth };
}

export { THRESHOLD_ACTIVE, THRESHOLD_REDISTILL };