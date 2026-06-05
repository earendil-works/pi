# @pi-mono/self-evolver

**Turn pi-mono into a self-evolving agent** — adds a 5D gene/genome equivalent on top of the existing pi-mono agent runtime.

> Built on the insight that **5D memory IS the Gene/Genome**. Do not build a parallel SKILL pool. The 5D system already has everything needed for self-evolution.

---

## Core Insight

| Gene/Genome concept | 5D equivalent |
|---------------------|---------------|
| Gene fitness | `MemoryRecord.importance` (0..1) |
| Evolution cycle | `engine.dream()` (decay + promote + dedup) |
| System health | `engine.health().deltaG` (-1..1) |
| Gene regulatory network | `engine.relate()` graph edges |
| Gene types | 5 dimensions (procedural/semantic/episodic/declarative/working) |
| Gene pool | 5D memory store |

**Fitness is derived from 5D importance — no separate storage needed.**

---

## Quick Start

```bash
npm install @pi-mono/self-evolver
```

```typescript
import { createSelfEvolver } from "@pi-mono/self-evolver";

const { run, maintain, memory } = createSelfEvolver();

// ── Self-evolution cycle ──────────────────────────────────────────────
const result = await run(
  { intent: "fix_git_merge_conflict", context: "pilotdeck/*", raw: "fix merge conflict" },
  async (task) => {
    // Your pi-mono agent executes the task
    const r = await agent.execute(task.raw);
    return {
      success: !r.error,
      output: r.output,
      error: r.error,
      duration_ms: r.duration,
      tool_calls: r.tools,
    };
  }
);

console.log(`fitness=${result.fitness.toFixed(3)}, actions=${result.actions.length}`);

// ── Periodic maintenance (call on schedule) ────────────────────────────
const { stats, actions } = await maintain();
console.log(`deltaG=${stats.systemDeltaG.toFixed(3)}, pool=${stats.poolHealth}`);
```

---

## Architecture

```
Task → apex_search(5D engine.search())
              ↓
        executor → pi-mono agent
              ↓
        apex_distill → 5D procedural memory (primary)
              ↓
        apex_scoring → derive fitness from importance
              ↓
        apex_evolve → ingest + dream + relate
              ↓
        engine.dream() → evolution cycle (decay + promote + dedup)
```

### 5D Dimension → Gene Type

| Dimension | Decay | Role | Weight |
|-----------|-------|------|--------|
| `procedural` | 365d | Skill genes | **0.40** |
| `semantic` | 180d | Knowledge genes | 0.25 |
| `episodic` | 7d | Event genes | 0.20 |
| `declarative` | 5y | Fact genes | 0.10 |
| `working` | 1h | Active context | 0.05 |

---

## Fitness Formula

```
fitness = record.importance    # directly from 5D
bump on success: importance += 0.05
decay on failure: importance -= 0.10
evolution: engine.dream() governs all decay + promotion
```

| Threshold | Action |
|-----------|--------|
| importance ≥ 0.6 | active — keep, bump on success |
| 0.3 ≤ importance < 0.6 | re_distill — bump + check deltaG |
| importance < 0.3 | critical — inject high-importance re-analysis |

---

## Modules

| Module | File | Responsibility |
|--------|------|----------------|
| Memory | `memory/types.ts`, `memory/in-memory.ts` | 5D memory engine interface + reference implementation |
| apex_search | `apex_search.ts` | Query 5D for relevant skill matches |
| apex_scoring | `apex_scoring.ts` | Derive fitness from 5D importance |
| apex_evolver | `apex_evolver.ts` | Drive 5D evolution via ingest + dream + relate |
| apex_distill | `apex_distill.ts` | Synthesize successful executions into 5D procedural memories |
| Factory | `index.ts` | `createSelfEvolver()` entry point |

---

## Integration with pi-mono

The self-evolver is designed to integrate with pi-mono's extension system. Once installed:

```typescript
// In your pi-mono extension or agent setup:
import { createSelfEvolver } from "@pi-mono/self-evolver";

const selfEvolver = createSelfEvolver();

// Hook into the pi-mono agent's task completion events:
agent.on("taskComplete", async ({ task, result }) => {
  const fp = { intent: task.intent, context: task.context, raw: task.raw };
  await selfEvolver.run(fp, async () => result);
});

// Hook into periodic maintenance:
setInterval(async () => {
  const { stats } = await selfEvolver.maintain();
  console.log(`[self-evolver] deltaG=${stats.systemDeltaG.toFixed(3)}`);
}, 24 * 60 * 60 * 1000); // daily
```

---

## Comparison: Before vs After

| | pi-mono without self-evolver | pi-mono with @pi-mono/self-evolver |
|--|------------------------------|-------------------------------------|
| Skill storage | SKILL.md files only | 5D procedural memories + SKILL.md cache |
| Fitness tracking | None | `importance` field (fitness proxy) |
| Evolution cycle | None | `engine.dream()` (decay + promote + dedup) |
| System health | None | `health().deltaG` (-1..1) |
| Skill adaptation | Manual | Automatic — fitness-driven |
| Failure handling | Log only | Injects re-analysis into episodic memory |
| Gene regulatory network | None | `engine.relate()` graph edges |

---

## API Reference

### `createSelfEvolver(config?) → SelfEvolver`

```typescript
const { engine, run, maintain, memory } = createSelfEvolver({
  minImportance: 0.3,     // minimum fitness for SKILL reuse
  writeSkillCache: false,  // write SKILL.md on distill
  skillsDir: "./skills",   // cache directory
});
```

### `evolver.run(task, executor) → Promise<SelfEvolverResult>`

- `task: TaskFingerprint` — `{ intent, context, raw }`
- `executor: (task) → Promise<ExecutionResult>` — your pi-mono agent
- Returns `{ usedSkill, record, distillResult, actions, fitness }`

### `evolver.maintain() → Promise<{ stats, actions }>`

Periodic maintenance. Call on a schedule (daily or every 100 tasks).

### `evolver.memory → MemoryEngine`

Direct access to the underlying 5D memory engine for advanced usage.

---

## License

MIT — same as pi-mono. Free to use, modify, and distribute.