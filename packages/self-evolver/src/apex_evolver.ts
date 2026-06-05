/**
 * apex_evolver — 5D-native self-evolution engine
 * Pi-mono Self-Evolution Engine
 *
 * Core insight: 5D IS the gene pool. Evolve it via ingest + dream + relate.
 *
 * 5D → Gene/Genome mapping:
 *   MemoryRecord.importance  ←→ gene fitness
 *   MemoryRecord.dimension  ←→ gene type (procedural=skill)
 *   MemoryRecord.accessCount←→ gene usage frequency
 *   engine.dream()          ←→ evolution cycle (decay + promote + dedup)
 *   engine.health().deltaG  ←→ system-level fitness indicator
 *   engine.relate()         ←→ gene regulatory network
 */

import type { MemoryEngine, MemoryRecord } from "./memory/types.ts";
import type { ExecutionResult } from "./apex_scoring.ts";
import type { TaskFingerprint } from "./apex_search.ts";
import { THRESHOLD_ACTIVE, THRESHOLD_REDISTILL } from "./apex_scoring.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

export type EvolutionAction =
  | { type: "keep"; record: MemoryRecord }
  | { type: "bump_importance"; record: MemoryRecord; newImportance: number }
  | { type: "trigger_dream"; reason: string }
  | { type: "inject"; record: MemoryRecord; reason: string }
  | { type: "relate"; src: string; rel: string; dst: string };

export interface EvolverContext {
  task: TaskFingerprint;
  result: ExecutionResult;
  record: MemoryRecord | null;
  score: import("./apex_scoring.js").ScoreBreakdown;
}

export interface EvolverStats {
  systemDeltaG: number;
  poolHealth: "healthy" | "degraded" | "critical";
  totalMemories: number;
  proceduralCount: number;
  semanticCount: number;
  dreamTriggered: boolean;
  lastDreamAt: number | null;
}

// ─── Config ────────────────────────────────────────────────────────────────

const DREAM_TRIGGER_DELTA_G = 0.2;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Core evolution step: given a task execution, evolve the 5D gene pool.
 *
 * @param engine — the 5D memory engine
 * @param ctx    — evolution context (task, result, record, score)
 * @returns evolution actions taken
 */
export async function apex_evolve(
  engine: MemoryEngine,
  ctx: EvolverContext
): Promise<EvolutionAction[]> {
  const actions: EvolutionAction[] = [];

  // Step 1: Ingest the experience into 5D
  const record = await ingest_experience(engine, ctx);
  if (!record) return actions;

  const importance = record.importance;

  // Step 2: Apply threshold-based evolution
  if (importance >= THRESHOLD_ACTIVE) {
    if (ctx.result.success) {
      const newImportance = Math.min(1, importance + 0.05);
      await engine.ingest({ id: record.id, content: record.content, dimension: record.dimension, tags: record.tags, importance: newImportance, meta: record.meta });
      actions.push({ type: "bump_importance", record, newImportance });
    }
    actions.push({ type: "keep", record });
  } else if (importance >= THRESHOLD_REDISTILL) {
    const newImportance = Math.min(1, importance + 0.02);
    await engine.ingest({ id: record.id, content: record.content, dimension: record.dimension, tags: record.tags, importance: newImportance, meta: record.meta });
    actions.push({ type: "bump_importance", record, newImportance });
    const health = await engine.health();
    if (health.deltaG < DREAM_TRIGGER_DELTA_G) {
      await engine.dream();
      actions.push({ type: "trigger_dream", reason: `deltaG=${health.deltaG.toFixed(3)} below ${DREAM_TRIGGER_DELTA_G}` });
    }
  } else {
    // Critical — inject re-analysis
    const injectRecord = await engine.ingest({
      content: `[RE-EVOLVE] Task "${ctx.task.intent}" failed. Error: ${ctx.result.error ?? "unknown"}. Re-examine approach.`,
      dimension: "episodic",
      tags: ["evolution:critical", `task:${ctx.task.intent}`],
      importance: 0.9,
      meta: { taskIntent: ctx.task.intent, taskContext: ctx.task.context, executionError: ctx.result.error },
    });
    actions.push({ type: "inject", record: injectRecord, reason: `importance=${importance.toFixed(3)} < ${THRESHOLD_REDISTILL}` });
    if (ctx.result.error) {
      await engine.relate(injectRecord.id, "caused_by", `error:${ctx.result.error.slice(0, 50)}`, 0.6, "episodic");
      actions.push({ type: "relate", src: injectRecord.id, rel: "caused_by", dst: `error:${ctx.result.error.slice(0, 50)}` });
    }
  }

  return actions;
}

/**
 * Periodic system maintenance — check health, trigger dream if needed.
 * Call on a schedule (e.g., daily or every 100 tasks).
 */
export async function apex_evolver_maintain(
  engine: MemoryEngine
): Promise<{ stats: EvolverStats; actions: EvolutionAction[] }> {
  const actions: EvolutionAction[] = [];
  const stats = await engine.stats();
  const health = await engine.health();

  let poolHealth: "healthy" | "degraded" | "critical";
  if (health.deltaG > 0.5) poolHealth = "healthy";
  else if (health.deltaG > 0) poolHealth = "degraded";
  else poolHealth = "critical";

  const evolverStats: EvolverStats = {
    systemDeltaG: health.deltaG,
    poolHealth,
    totalMemories: stats.total,
    proceduralCount: stats.byDimension.procedural ?? 0,
    semanticCount: stats.byDimension.semantic ?? 0,
    dreamTriggered: false,
    lastDreamAt: stats.lastDreamAt,
  };

  if (health.deltaG < DREAM_TRIGGER_DELTA_G) {
    const dreamResult = await engine.dream();
    actions.push({ type: "trigger_dream", reason: `deltaG=${health.deltaG.toFixed(3)} < ${DREAM_TRIGGER_DELTA_G} | decayed=${dreamResult.decayed}` });
    evolverStats.dreamTriggered = true;
  }

  if ((stats.byDimension.procedural ?? 0) < 5) {
    const injectRecord = await engine.ingest({
      content: `[GROW] Procedural pool is sparse (${stats.byDimension.procedural ?? 0} skills). Distill successful patterns into procedural memories.`,
      dimension: "semantic",
      tags: ["evolution:growth", "pool:sparse"],
      importance: 0.8,
    });
    actions.push({ type: "inject", record: injectRecord, reason: "procedural pool too small" });
  }

  return { stats: evolverStats, actions };
}

// ─── Internal ─────────────────────────────────────────────────────────────

async function ingest_experience(
  engine: MemoryEngine,
  ctx: EvolverContext
): Promise<MemoryRecord | null> {
  const { task, result } = ctx;
  const dimension = result.success ? "procedural" : "episodic";
  const importance = result.success ? 0.5 : 0.7;
  const tags = [...(result.success ? ["evolution:success"] : ["evolution:failure"]), `task:${task.intent}`];

  const content = result.success
    ? `# SKILL: ${task.intent}\n> Context: ${task.context}\n## Steps\n${(result.tool_calls ?? []).map(t => `- ${t}`).join("\n")}\n## Output\n${result.output ?? "(success)"}`
    : `# FAILED: ${task.intent}\n> Context: ${task.context}\n## Error\n${result.error ?? "(unknown)"}`;

  return engine.ingest({ content, dimension: dimension as never, tags, importance, meta: { taskIntent: task.intent, taskContext: task.context, duration_ms: result.duration_ms, tool_calls: result.tool_calls } });
}