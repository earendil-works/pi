/**
 * @pi-mono/self-evolver — Pi-mono Self-Evolution Engine
 *
 * Turn pi-mono into a self-evolving agent by adding a 5D gene/genome equivalent.
 *
 * Core insight: 5D memory IS the Gene/Genome. Do not build a parallel SKILL pool.
 * The 5D system already has everything needed for self-evolution:
 *
 *   importance       ←→ fitness score
 *   dream()          ←→ evolution cycle (decay + promote + dedup)
 *   health().deltaG  ←→ system-level fitness indicator
 *   relate()         ←→ gene regulatory network
 *   5 dimensions     ←→ 5 gene chromosomes
 *
 * Usage:
 *
 * ```ts
 * import { createSelfEvolver } from "@pi-mono/self-evolver";
 *
 * const { engine, run } = createSelfEvolver();
 *
 * const result = await run(
 *   { intent: "fix_git_merge_conflict", context: "pilotdeck/*", raw: "..." },
 *   async (task) => {
 *     // execute task — return success/failure + tool calls
 *     const r = await agent.run(task.raw);
 *     return { success: !r.error, output: r.output, error: r.error, duration_ms: r.duration, tool_calls: r.tools };
 *   }
 * );
 *
 * console.log(`fitness=${result.fitness}, evolved=${result.actions.length} actions`);
 * ```
 *
 * The 5D system does the rest.
 */

import { createMemoryEngine, type MemoryEngine } from "./memory/index.ts";
import {
  apex_search,
  apex_search_best_skill,
  type TaskFingerprint,
} from "./apex_search.ts";
import {
  apex_scoring,
  apex_scoring_pool,
  type ExecutionResult,
} from "./apex_scoring.ts";
import {
  apex_evolve,
  apex_evolver_maintain,
  type EvolutionAction,
  type EvolverStats,
} from "./apex_evolver.ts";
import { apex_distill, type DistillResult } from "./apex_distill.ts";

// ─── Re-exports ─────────────────────────────────────────────────────────────

export type { TaskFingerprint } from "./apex_search.ts";
export type { ExecutionResult } from "./apex_scoring.ts";
export type { EvolutionAction, EvolverStats } from "./apex_evolver.ts";
export type { DistillResult } from "./apex_distill.ts";
export type { MemoryEngine } from "./memory/types.ts";
export { createMemoryEngine } from "./memory/index.ts";

// ─── Main Factory ─────────────────────────────────────────────────────────────

export interface SelfEvolverConfig {
  /** Minimum importance (fitness) for SKILL reuse. Default: 0.3 */
  minImportance?: number;
  /** Write SKILL.md cache on distill. Default: false */
  writeSkillCache?: boolean;
  /** Skills directory for cache. Default: ./skills */
  skillsDir?: string;
}

export interface SelfEvolver {
  engine: MemoryEngine;
  /**
   * Run one self-evolution cycle: search → execute → distill → score → evolve.
   * Returns the evolved memory record and all actions taken.
   */
  run(
    task: TaskFingerprint,
    executor: (task: TaskFingerprint) => Promise<ExecutionResult>,
    config?: SelfEvolverConfig
  ): Promise<{
    usedSkill: boolean;
    record: MemoryRecord | null;
    distillResult: DistillResult | null;
    actions: EvolutionAction[];
    fitness: number;
  }>;
  /**
   * Periodic maintenance: check system health, trigger dream if needed.
   * Call on a schedule (e.g., daily or every 100 tasks).
   */
  maintain(): Promise<{ stats: EvolverStats; actions: EvolutionAction[] }>;
  /**
   * Direct access to the 5D memory engine.
   */
  memory: MemoryEngine;
}

/**
 * Create a self-evolution engine backed by a 5D memory store.
 * The engine is initialized with an in-memory store by default.
 * Replace it with a persistent store (SQLite/FTS5) for production.
 */
export function createSelfEvolver(config: SelfEvolverConfig = {}): SelfEvolver {
  const engine = createMemoryEngine();

  return {
    engine,
    memory: engine,

    async run(
      task: TaskFingerprint,
      executor: (task: TaskFingerprint) => Promise<ExecutionResult>,
      cfg: SelfEvolverConfig = {}
    ): Promise<ReturnType<SelfEvolver["run"]>> {
      const minImportance = cfg.minImportance ?? config.minImportance ?? 0.3;
      const writeCache = cfg.writeCache ?? config.writeSkillCache ?? false;
      const skillsDir = cfg.skillsDir ?? config.skillsDir ?? "./skills";

      // 1. Search 5D for relevant skills
      const bestSkill = await apex_search_best_skill(engine, task, { minImportance });

      // 2. Execute the task
      const result = await executor(task);

      // 3. Distill into 5D
      const distillResult = await apex_distill(engine, task, result, { writeCache, tags: [], importance: 0.5 });

      // 4. Score the record
      let fitness = distillResult.record.importance;
      if (bestSkill?.hit.record) {
        const score = await apex_scoring(engine, bestSkill.hit.record, result);
        fitness = score.profile.overallFitness;
      }

      // 5. Evolve 5D
      const scoreBreakdown = await apex_scoring(engine, distillResult.record, result);
      const actions = await apex_evolve(engine, {
        task,
        result,
        record: bestSkill?.hit.record ?? null,
        score: scoreBreakdown,
      });

      return {
        usedSkill: !!bestSkill,
        record: distillResult.record,
        distillResult,
        actions,
        fitness,
      };
    },

    async maintain() {
      return apex_evolver_maintain(engine);
    },
  };
}