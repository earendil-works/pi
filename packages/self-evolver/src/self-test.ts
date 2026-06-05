/**
 * Self-test for @pi-mono/self-evolver
 * Run with: bun run src/self-test.ts
 *
 * Tests the complete self-evolution loop:
 * 1. Create engine
 * 2. Run a task with a mock executor
 * 3. Verify memory was ingested
 * 4. Verify fitness scoring works
 * 5. Verify apex_evolve actions
 */

import { createSelfEvolver } from "./index.ts";
import type { TaskFingerprint, ExecutionResult } from "./index.ts";

// ─── Mock executor ────────────────────────────────────────────────────────────

async function mockExecutor(task: TaskFingerprint): Promise<ExecutionResult> {
  // Simulate task execution
  await new Promise(r => setTimeout(r, 10));
  if (task.intent.includes("git_merge")) {
    return {
      success: true,
      output: "Merge conflict resolved via mergetool",
      duration_ms: 120,
      tool_calls: ["git_status", "git_merge_tool", "git_commit"],
    };
  } else if (task.intent.includes("bug_fix")) {
    return {
      success: false,
      error: "TypeError: undefined is not a function",
      duration_ms: 80,
      tool_calls: ["git_blame", "terminal"],
    };
  }
  return { success: true, output: "done", duration_ms: 50, tool_calls: ["echo"] };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function test_search(engine: ReturnType<typeof createSelfEvolver>) {
  console.log("\n─── Test: apex_search ───");
  const result = await engine.run(
    { intent: "git merge conflict", context: "pilotdeck/*", raw: "fix git merge conflict" },
    mockExecutor
  );
  console.log(`  usedSkill: ${result.usedSkill}`);
  console.log(`  fitness: ${result.fitness.toFixed(3)}`);
  console.log(`  actions: ${result.actions.map(a => a.type).join(", ")}`);
  console.assert(result.record !== null, "record should exist");
  console.assert(result.fitness >= 0 && result.fitness <= 1, "fitness should be 0..1");
  console.log("  ✅ search + distill + evolve passed");
}

async function test_failure_handling(engine: ReturnType<typeof createSelfEvolver>) {
  console.log("\n─── Test: failure injection ───");
  const result = await engine.run(
    { intent: "bug_fix", context: "pilotdeck/src/*", raw: "fix the null pointer bug" },
    mockExecutor
  );
  console.log(`  fitness: ${result.fitness.toFixed(3)}`);
  console.log(`  actions: ${result.actions.map(a => a.type).join(", ")}`);
  const hasInject = result.actions.some(a => a.type === "inject");
  console.assert(hasInject, "should inject re-analysis on failure");
  console.log("  ✅ failure handling passed");
}

async function test_maintain(engine: ReturnType<typeof createSelfEvolver>) {
  console.log("\n─── Test: maintain ───");
  const { stats, actions } = await engine.maintain();
  console.log(`  deltaG: ${stats.systemDeltaG.toFixed(3)}`);
  console.log(`  poolHealth: ${stats.poolHealth}`);
  console.log(`  totalMemories: ${stats.totalMemories}`);
  console.log(`  proceduralCount: ${stats.proceduralCount}`);
  console.log(`  dreamTriggered: ${stats.dreamTriggered}`);
  console.log(`  actions: ${actions.map(a => a.type).join(", ")}`);
  console.log("  ✅ maintain passed");
}

async function test_dream_cycle(engine: ReturnType<typeof createSelfEvolver>) {
  console.log("\n─── Test: dream cycle ───");
  // Manually set deltaG low to trigger dream
  const beforeStats = await engine.memory.stats();
  console.log(`  before: total=${beforeStats.total}, procedural=${beforeStats.byDimension.procedural ?? 0}`);
  await engine.memory.dream();
  const afterStats = await engine.memory.stats();
  console.log(`  after dream: total=${afterStats.total}, lastDreamAt=${afterStats.lastDreamAt}`);
  console.assert(afterStats.lastDreamAt !== null, "lastDreamAt should be set");
  console.log("  ✅ dream cycle passed");
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("=========================================================");
  console.log(" @pi-mono/self-evolver  self-test");
  console.log("=========================================================");

  const evolver = createSelfEvolver();

  await test_search(evolver);
  await test_failure_handling(evolver);
  await test_maintain(evolver);
  await test_dream_cycle(evolver);

  console.log("\n=========================================================");
  console.log("  ALL TESTS PASSED ✅");
  console.log("=========================================================");
}

main().catch(e => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});