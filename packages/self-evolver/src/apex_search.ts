/**
 * apex_search — 5D-native task matching
 * Pi-mono Self-Evolution Engine
 *
 * Queries 5D memory directly for relevant skills/procedural memories.
 * importance field IS the fitness score — no separate metadata needed.
 */

import type { MemoryEngine, MemoryHit, SearchInput } from "./memory/types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TaskFingerprint {
  intent: string;    // e.g. "fix_git_merge_conflict"
  context: string;   // e.g. "pilotdeck/src/mcp/*"
  raw: string;       // original user message
}

export interface SkillMatch {
  hit: MemoryHit;
  dimension: string;
  content: string;
  importance: number;   // importance = fitness proxy
  accessCount: number;
}

export interface SearchResult {
  matches: SkillMatch[];
  totalScore: number;
  systemDeltaG: number;
}

// ─── Dimension weights (gene type importance) ───────────────────────────────

const DIM_WEIGHTS: Record<string, number> = {
  procedural: 0.40,   // skills — highest weight
  semantic:   0.25,
  episodic:   0.20,
  declarative:0.10,
  working:    0.05,
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Query 5D memory for relevant skill matches.
 * Returns SkillMatch[] sorted by weighted 5D score.
 */
export async function apex_search(
  engine: MemoryEngine,
  task: TaskFingerprint,
  opts: { topK?: number; includeHealth?: boolean } = {}
): Promise<SearchResult> {
  const topK = opts.topK ?? 6;
  const query = build_query(task);

  const hits = await engine.search({
    query,
    topK: topK * 2,
    dimensions: ["procedural", "semantic", "episodic"],
    expandGraph: true,
  });

  const weighted = hits
    .map(hit => ({
      hit,
      dimension: hit.record.dimension,
      content: hit.record.content,
      importance: hit.record.importance,
      accessCount: hit.record.accessCount,
      weightedScore: hit.score * (DIM_WEIGHTS[hit.record.dimension] ?? 0.1),
    }))
    .filter(h => h.dimension === "procedural" || h.dimension === "semantic")
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, topK);

  const totalScore = weighted.reduce((s, h) => s + h.weightedScore, 0);

  let systemDeltaG = 0;
  if (opts.includeHealth) {
    const health = await engine.health();
    systemDeltaG = health.deltaG;
  }

  return { matches: weighted, totalScore, systemDeltaG };
}

/**
 * Find the single best procedural skill for a task.
 * Returns null if no skill meets minImportance threshold.
 */
export async function apex_search_best_skill(
  engine: MemoryEngine,
  task: TaskFingerprint,
  opts: { minImportance?: number } = {}
): Promise<SkillMatch | null> {
  const minImportance = opts.minImportance ?? 0.3;
  const result = await apex_search(engine, task, { topK: 1 });
  return result.matches.find(m => m.importance >= minImportance) ?? null;
}

function build_query(task: TaskFingerprint): string {
  const parts = [task.intent];
  if (task.context) parts.push(task.context);
  if (task.raw.length > 20 && task.raw !== task.intent) parts.push(task.raw.slice(0, 200));
  return parts.join(" ");
}