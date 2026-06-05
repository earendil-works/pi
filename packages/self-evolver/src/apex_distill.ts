/**
 * apex_distill — 5D-native skill synthesis
 * Pi-mono Self-Evolution Engine
 *
 * Distills successful executions into 5D procedural memories.
 * Primary store: 5D (importance = fitness)
 * Optional cache: SKILL.md (human-readable, generated from 5D)
 */

import type { MemoryEngine, MemoryRecord } from "./memory/types.ts";
import type { TaskFingerprint } from "./apex_search.ts";
import type { ExecutionResult } from "./apex_scoring.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DistillConfig {
  skillsDir?: string;
  writeCache?: boolean;
  tags?: string[];
  importance?: number;
}

export interface DistillResult {
  record: MemoryRecord;
  cachePath: string | null;
  isNew: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Distill a successful task execution into 5D memory.
 * Optionally writes a human-readable SKILL.md cache.
 */
export async function apex_distill(
  engine: MemoryEngine,
  task: TaskFingerprint,
  result: ExecutionResult,
  config: DistillConfig = {}
): Promise<DistillResult> {
  const { writeCache = false, tags = [], importance = 0.5 } = config;

  // Failures go to episodic — evolver handles them separately
  if (!result.success) {
    const rec = await engine.ingest({
      content: build_content(task, result),
      dimension: "episodic",
      tags: [...tags, `task:${task.intent}`, "evolution:failure"],
      importance: 0.7,
      meta: { taskIntent: task.intent, taskContext: task.context, executionError: result.error, duration_ms: result.duration_ms },
    });
    return { record: rec, cachePath: null, isNew: true };
  }

  // Success → procedural skill
  const rec = await engine.ingest({
    content: build_content(task, result),
    dimension: "procedural",
    tags: [...tags, `task:${task.intent}`, "evolution:success"],
    importance,
    meta: { taskIntent: task.intent, taskContext: task.context, duration_ms: result.duration_ms, tool_calls: result.tool_calls },
  });

  let cachePath: string | null = null;
  if (writeCache && config.skillsDir) {
    cachePath = await write_skill_cache(config.skillsDir, task, result, rec);
  }

  return { record: rec, cachePath, isNew: true };
}

// ─── Internal ─────────────────────────────────────────────────────────────

function build_content(task: TaskFingerprint, result: ExecutionResult): string {
  const toolList = (result.tool_calls ?? []).map(t => `- ${t}`).join("\n");
  return [
    `# SKILL: ${task.intent}`,
    `> Context: ${task.context || "(none)"}`,
    ``,
    `## When to use`,
    `Use when the user asks for: **${task.intent}**`,
    ``,
    `## Steps`,
    ...(result.tool_calls ?? []).map((tool, i) => `${i + 1}. **${tool}**`),
    ``,
    `## Tools`,
    toolList || "(none)",
    ``,
    `## Expected Outcome`,
    result.success ? `✅ ${result.output ?? "success"}` : `❌ ${result.error}`,
  ].join("\n");
}

async function write_skill_cache(
  _skillsDir: string,
  task: TaskFingerprint,
  result: ExecutionResult,
  record: MemoryRecord
): Promise<string | null> {
  // SKILL.md cache writing — requires node:fs which may not be available in all environments
  // In production pi-mono deployments, use the apex_distill tool registered via pi extensions
  // This is a no-op in the core library — SKILL.md writing is handled by the extension layer
  return null;
}