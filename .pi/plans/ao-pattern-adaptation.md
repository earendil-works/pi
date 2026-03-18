# Plan: Adapt ComposioHQ Agent Orchestrator Patterns into Pi Plan-Mode

**Date:** 2026-03-17

## TL;DR
> **Quick Summary**: Add 3 patterns from ComposioHQ/agent-orchestrator to our plan-mode extension: sibling awareness in parallel wave dispatch, atomic/composite task classification in plan generation prompts, and automated reaction patterns with escalation in execution.
> **Deliverables**: Modified prompts.ts, index.ts, utils.ts; updated prometheus.md; new/updated tests
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Wave 1 (prompts + utils) → Wave 2 (index.ts execution logic + tests)

## Context

### Original Request
Adapt 3 high-value patterns from ComposioHQ/agent-orchestrator into our pi-mono plan-mode extension:
1. Sibling awareness for parallel wave execution
2. Atomic/composite task classification heuristic for plan generation
3. Automated reaction patterns with escalation in execution phase

### Research Summary
Full analysis of AO's codebase revealed their orchestrator-prompt.ts, decomposer.ts, prompt-builder.ts, and lifecycle-manager.ts. Key extractable patterns documented in `.pi/drafts/composio-orchestrator-analysis.md`.

### State Machine Assessment
No stateful workflows identified — skipped. These are prompt text changes + deterministic execution logic changes. No payment, auth, subscription, or job queue flows.

### Memory Recall
Memory agent returned no relevant results (Neo4j empty for this topic).

### Metis Review
Metis agent hit model fallback. Self-review applied: validated assumptions against source code, confirmed file paths exist, verified test infrastructure.

## Work Objectives

### Core Objective
Enhance plan-mode extension with coordination patterns that reduce duplication in parallel execution, improve task granularity in planning, and add smart failure recovery during execution.

### Concrete Deliverables
1. `executionPrompt()` and `dispatchNextWave()` inject sibling context into parallel wave tasks
2. `planGenerationPrompt()` includes atomic/composite classification guidance
3. Execution `agent_end` handler has enhanced retry with error context + human escalation
4. `prometheus.md` agent file updated to match prompt changes
5. New utility functions with tests
6. Existing tests pass, new tests cover new functionality

### Definition of Done
- All 146 existing tests pass unchanged
- New tests cover: `formatSiblingContext()`, `formatEscalationContext()`, updated `executionPrompt()`
- Manual verification: a plan with parallel waves shows sibling annotations in execution dispatch

### Must Have
- Sibling context injected for BOTH single-step and multi-step wave dispatch paths in `dispatchNextWave()`
- Atomic/composite heuristic text in plan generation prompt
- MAX_RETRIES increased to 2 with error context in retry messages
- Human escalation when max retries exhausted (via `ctx.ui.select()`)

### Must NOT Have (Guardrails)
- NO LLM-based classification calls (AO uses LLM for classify — we add it as prompt guidance only)
- NO new agent definitions (orchestrator.md and debug.md already exist, don't modify them)
- NO changes to the subagent extension (index.ts in the subagent dir)
- NO changes to plan-mode phases.ts (state machine remains unchanged)
- NO changes to the interview or high-accuracy phases
- NO polling loops or async lifecycle monitoring (we're single-session)
- NO changes to wave extraction/creation logic in utils.ts (createWaves, extractWavePlan stay as-is)

## Verification Strategy

### Test Decision
Add new unit tests for new utility functions. Run existing test suite to confirm no regressions.

### QA Policy
- Run `npm run check` after all changes
- Run all 5 plan-mode test files
- Manual smoke test: create a plan with `/plan`, verify sibling context appears in execution dispatch

## Execution Strategy

### Wave 1 (Start Immediately — prompts + utils, parallel, no file overlap)

Task 1: Add sibling context formatter to utils.ts
Task 2: Add atomic/composite guidance to plan generation prompt in prompts.ts
Task 3: Update prometheus.md agent definition

### Wave 2 (After Wave 1 — execution logic + tests, depends on utils.ts and prompts.ts changes)

Task 4: Inject sibling awareness + enhanced reactions into index.ts
Task 5: Add tests for new functionality

## TODOs

- [ ] 1. Add `formatSiblingContext()` and `formatEscalationContext()` to utils.ts
  **What to do**:
  - Add a new exported function `formatSiblingContext(currentStep: TodoItem, allWaveSteps: TodoItem[]): string`
  - Returns a formatted string listing sibling tasks (all wave steps except current)
  - Format:
    ```
    ## Parallel Siblings (DO NOT duplicate)
    - Step N: [text]
    - Step M: [text]
    Stay focused on YOUR task only. Do not implement functionality that belongs to sibling tasks.
    If you need interfaces/types from siblings, define reasonable local stubs.
    ```
  - Return empty string if 0 or 1 steps (no siblings)
  - Add exported function `formatEscalationContext(step: TodoItem, retryCount: number, maxRetries: number, errorContext: string): string`
  - Returns a formatted retry/escalation message:
    ```
    [Step N — RETRY {retryCount}/{maxRetries}] Previous attempt failed.
    
    Error context:
    {errorContext}
    
    Re-do: {step text}
    
    Fix the issue described above. If you need a different approach, explain what you'll change.
    ```
  **Must NOT do**: Modify existing functions. Do not change `TodoItem` type, `ExecutionWave` type, or any existing exports.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: 4, 5
    - Blocked By: None
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/utils.ts` — add after `generateVerificationChecks()` (around line 290)
    - AO's sibling pattern: `formatSiblings()` in `packages/core/src/decomposer.ts`
  **Acceptance Criteria**:
    - `formatSiblingContext({step:1,text:"A",completed:false}, [{step:1,text:"A",completed:false}])` returns `""`
    - `formatSiblingContext({step:1,text:"A",completed:false}, [{step:1,...},{step:2,text:"B",...}])` returns string containing "Step 2" and "DO NOT duplicate"
    - Output contains "stubs" guidance
    - `formatEscalationContext()` output contains step text, retry count, max retries, and error context verbatim
  **Size**: S

- [ ] 2. Add atomic/composite classification guidance to `planGenerationPrompt()`
  **What to do**:
  - In `planGenerationPrompt()` in prompts.ts, add a new section inside the plan template, after the existing TODO item spec's `**Parallelization**` field block and before `**References**`
  - Add this block to the TODO template guidance:
    ```
    ### Task Atomicity Check (apply to every TODO before finalizing)
    Classify each TODO:
    - **Atomic**: Single feature, endpoint, component, or module. One developer implements directly. KEEP as one task.
    - **Composite**: Contains 2+ independent concerns that should be separate. SPLIT into separate TODOs.

    Heuristics:
    - Single feature/endpoint/component → atomic
    - Bundles unrelated concerns (e.g., "auth + database + UI") → composite, split it
    - Already scoped to a specific wave → almost certainly atomic
    - When in doubt, choose atomic. Over-decomposition creates more overhead than under-decomposition.

    Anti-padding rules:
    - Break into MINIMUM number of tasks needed (2 for simple, up to 7 for complex)
    - Do NOT pad with extra tasks. Do NOT create "test and polish" or "cleanup" filler tasks.
    - Do NOT create tasks that overlap or restate each other.
    - Each task must represent real, distinct work.
    ```
  - Add to the Post-Plan Self-Review Checklist (the `□` checklist near end of prompt): `□ Every TODO is atomic (single concern)? Composite tasks split?`
  **Must NOT do**: Change the plan structure/format. Do not modify `executionPrompt()`, `verificationPrompt()`, `highAccuracyPrompt()`, `interviewPrompt()`, or `prometheusIdentity()`. Do not add LLM classification calls.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: 4
    - Blocked By: None
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/prompts.ts` — `planGenerationPrompt()` function starting at line 135
    - AO's `CLASSIFY_SYSTEM` and `DECOMPOSE_SYSTEM` prompts in their `decomposer.ts`
  **Acceptance Criteria**:
    - `planGenerationPrompt("")` output contains "Atomic" and "Composite" classification text
    - Contains "When in doubt, choose atomic"
    - Contains "MINIMUM number of tasks"
    - Contains "Do NOT pad" and "Do NOT create" anti-padding rules
    - Self-Review Checklist includes atomicity check line
  **Size**: S

- [ ] 3. Update `prometheus.md` agent definition to reflect new guidance
  **What to do**:
  - In `~/.pi/agent/agents/prometheus.md`, in the `## PHASE 2: PLAN GENERATION` section:
  - Add after the existing task format line (`size: S/M/L`), a new line: `- [ ] Task N: [Action] -> file: path -> verify: [check] -> size: S/M/L -> atomic: YES`
  - Add a brief note under Phase 2:
    ```
    ### Task Atomicity
    Every task must be atomic (single concern). If a task bundles 2+ independent concerns, split it.
    When in doubt, keep it atomic — over-decomposition hurts more than under-decomposition.
    Plans with parallel waves get sibling context injected at execution time — design tasks to be independently executable.
    ```
  - Add to the Post-Plan Self-Review list: `- Each TODO is atomic (single concern)? Split composites?`
  **Must NOT do**: Change the agent's model, tools, name, or description frontmatter. Do not modify Phase 1 or Phase 3 sections.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: None
    - Blocked By: None
  **References**:
    - `~/.pi/agent/agents/prometheus.md` — full file, currently 67 lines
  **Acceptance Criteria**:
    - File contains "atomic" classification guidance
    - Post-Plan Self-Review mentions atomicity
    - Mentions sibling awareness at execution time
    - Frontmatter (name, description, tools, model, fallback-model) unchanged
  **Size**: S

- [ ] 4. Inject sibling awareness + enhanced reactions into execution logic in index.ts
  **What to do**:

  **Part A — Sibling Awareness in dispatch:**
  - Import `formatSiblingContext` from `./utils.js` at top of index.ts
  - Modify `executionPrompt()` signature in prompts.ts: add optional parameter `siblingContext?: string` (default `""`)
  - In `executionPrompt()` body: if `siblingContext` is non-empty, append it after the current step text block
  - In `dispatchNextWave()` in index.ts, **single-step path** (the `if (remaining.length === 1)` branch around line 233):
    - Get all wave steps (not just remaining): `const allWaveSteps = wave.steps.map(n => state.todoItems.find(t => t.step === n)).filter(Boolean)`
    - Call `formatSiblingContext(step, allWaveSteps)` to get sibling text
    - Pass sibling text to `executionPrompt(step, wave, allRemaining, siblingText)`
  - In `dispatchNextWave()`, **multi-step path** (the `else` branch around line 244):
    - For each step in the `remaining` list, compute its siblings (the other remaining steps)
    - Modify the step list format to include per-step sibling annotations:
      ```
      - Step N: [text]
        Siblings: Step M ([text]), Step P ([text])
        DO NOT duplicate sibling work. Use stubs for sibling interfaces.
      ```

  **Part B — Enhanced Reactions:**
  - Change `const MAX_RETRIES = 1` to `const MAX_RETRIES = 2` (line 14 of index.ts)
  - Import `formatEscalationContext` from `./utils.js`
  - In the `agent_end` execution handler, modify the three retry dispatch points:
    1. **Tool audit retry** (~line 310): Replace the basic retry message with `formatEscalationContext(step, state.stepRetryCount, MAX_RETRIES, audit.reason)`
    2. **Verification command retry** (~line 335): Replace with `formatEscalationContext(step, state.stepRetryCount, MAX_RETRIES, failures.join('\n'))`
    3. **Verifier turn retry** (~line 360 in the verification sub-section): Replace with `formatEscalationContext(step, state.stepRetryCount, MAX_RETRIES, lastMsg ? getTextContent(lastMsg) : 'Verification failed')`
  - **Escalation when max retries exhausted**: In each of the three retry paths, where the code currently falls through when `stepRetryCount >= MAX_RETRIES` (silently marking the step complete), add escalation:
    ```typescript
    if (state.stepRetryCount >= MAX_RETRIES && ctx.hasUI) {
      const choice = await ctx.ui.select(
        `Step ${step.step} failed after ${MAX_RETRIES} retries. What to do?`,
        ["Retry once more", "Skip this step", "Abort execution"]
      );
      if (choice === "Retry once more") {
        state.stepRetryCount = 0;
        state.stepToolCalls = [];
        // re-dispatch same step
        pi.sendMessage({ customType: "plan-mode-execute", content: executionPrompt(step, wave, allRemaining), display: true }, { triggerTurn: true });
        return;
      } else if (choice === "Abort execution") {
        completeExecution(ctx);
        return;
      }
      // "Skip this step" falls through to mark complete
    }
    ```
  - Check `ctx.hasUI` before calling `ctx.ui.select()` — if no UI, fall through to skip (existing behavior).

  **Must NOT do**: Change phase transitions, tool filtering, clearance logic, or session persistence. Do not modify interview/plan-generation/high-accuracy `agent_end` handlers. Do not change wave extraction logic. Keep `executionPrompt()` backward-compatible (siblingContext defaults to `""`).
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: 5
    - Blocked By: 1, 2
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/index.ts` — `dispatchNextWave()` (line ~218), `agent_end` execution handler (line ~295)
    - `packages/coding-agent/examples/extensions/plan-mode/prompts.ts` — `executionPrompt()` (line ~260)
    - AO's reaction pattern: lifecycle-manager.ts retry + escalation logic
  **Acceptance Criteria**:
    - `executionPrompt(step, wave, remaining)` (3 args) produces identical output to before (backward compat)
    - `executionPrompt(step, wave, remaining, "sibling text")` appends sibling text
    - Single-step dispatch in `dispatchNextWave()` includes sibling context string
    - Multi-step dispatch includes per-task sibling annotations
    - `MAX_RETRIES` is 2
    - Retry messages use `formatEscalationContext()` with specific error details
    - Human escalation dialog appears when `stepRetryCount >= MAX_RETRIES` and `ctx.hasUI`
    - Escalation offers "Retry once more" / "Skip this step" / "Abort execution"
    - "Abort execution" calls `completeExecution(ctx)`
  **Size**: M

- [ ] 5. Add tests for new functionality
  **What to do**:
  - In `packages/coding-agent/test/plan-mode-utils.test.ts`, add a new `describe("formatSiblingContext")` block:
    - Test: returns empty string for empty array
    - Test: returns empty string for single-step array (no siblings)
    - Test: returns sibling list for 2-step array, excluding current
    - Test: returns sibling list for 3+ step array
    - Test: output contains "DO NOT duplicate" and "stubs" guidance text
  - In same file, add `describe("formatEscalationContext")` block:
    - Test: output contains step text, retry count, max retries
    - Test: output contains error context verbatim
  - In `packages/coding-agent/test/plan-mode-verification.test.ts`, add tests for updated `executionPrompt()`:
    - Test: calling with 3 args (no sibling context) produces output containing step text and remaining list (backward compat)
    - Test: calling with 4th arg (sibling context string) produces output containing that string
    - Test: calling with empty string 4th arg produces same as 3-arg call
  - Run ALL 5 existing test files to verify no regressions:
    ```bash
    cd packages/coding-agent
    npx tsx ../../node_modules/vitest/dist/cli.js --run test/plan-mode-phases.test.ts
    npx tsx ../../node_modules/vitest/dist/cli.js --run test/plan-mode-utils.test.ts
    npx tsx ../../node_modules/vitest/dist/cli.js --run test/plan-mode-complexity.test.ts
    npx tsx ../../node_modules/vitest/dist/cli.js --run test/plan-mode-waves.test.ts
    npx tsx ../../node_modules/vitest/dist/cli.js --run test/plan-mode-verification.test.ts
    ```
  **Must NOT do**: Modify existing test assertions or test descriptions. Keep test style consistent with existing patterns (vitest, `describe`/`it` blocks). Do not add integration tests or mock process spawning.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: None
    - Blocked By: 1, 2, 4
  **References**:
    - `packages/coding-agent/test/plan-mode-utils.test.ts` — existing 48 tests, add to end
    - `packages/coding-agent/test/plan-mode-verification.test.ts` — existing 25 tests, add to end
  **Acceptance Criteria**:
    - All 146 existing tests pass unchanged
    - At least 5 new tests for `formatSiblingContext()`
    - At least 2 new tests for `formatEscalationContext()`
    - At least 3 new tests for `executionPrompt()` backward compat + sibling param
    - `npm run check` passes with no errors
  **Size**: M

## Final Verification Wave

- [ ] F1. Run `npm run check` from repo root — zero errors, zero warnings
- [ ] F2. Run all 5 plan-mode test files — all pass including new tests
- [ ] F3. Verify symlinks still work: `ls -la ~/.pi/agent/extensions/plan-mode/`

## Success Criteria
1. Parallel wave execution includes sibling context for every dispatched task
2. Plan generation prompt guides task atomicity classification
3. Execution retries include error context and escalate to human after 2 failures
4. All tests pass (existing 146 + ~10 new)
5. `npm run check` clean

## Risks
1. **index.ts complexity**: The `agent_end` handler is already ~150 lines. Mitigation: `formatEscalationContext()` lives in utils.ts, escalation is a small `if` block.
2. **Prompt token budget**: Sibling context adds tokens per parallel task. Mitigation: `cleanStepText()` truncates to 50 chars, and sibling lists are typically 2-7 items.
3. **Backward compatibility**: `executionPrompt()` signature change. Mitigation: optional parameter with default `""`.
4. **Escalation UX blocking**: `ctx.ui.select()` blocks the agent loop during execution. This is intentional (human must decide). Guard with `ctx.hasUI` check.

## Follow-Up (Out of Scope)
- Auto-summon `debug` agent when user reports a bug (separate task, noted by user)
- Integration of `debug` agent into reaction patterns for automated failure diagnosis before retry
