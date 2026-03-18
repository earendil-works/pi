# Plan: Orchestrator as Default Router with Auto-Debug Summoning

**Date:** 2026-03-17

## TL;DR
> **Quick Summary**: Add a triage layer to the plan-mode extension that classifies user input into 4 categories (bug, question, simple, complex) and routes accordingly — bugs to the debug agent, questions passthrough without planning, simple tasks to lightweight planning, complex tasks to full Prometheus flow.
> **Deliverables**: Extended intent classification, new `bug` and `question` intent types, bug detection heuristics, debug agent auto-summoning, updated orchestrator.md with triage logic, tests
> **Estimated Effort**: Medium
> **Parallel Execution**: YES - 2 waves
> **Critical Path**: Wave 1 (phases.ts + utils.ts + orchestrator.md) → Wave 2 (index.ts + prompts.ts + tests)

## Context

### Original Request
Make the orchestrator the default mode that understands when to use simple plan vs advanced plan mode vs debug agent. Add bug detection that auto-summons the debug agent.

### State Machine Assessment
No stateful workflows identified — skipped. This adds routing branches to existing intent classification, not new stateful flows.

### Memory Recall
No relevant prior learnings found.

### Metis Review (self-applied)
Key insight: We're NOT replacing the existing planning flow. We're adding a **triage layer before it** that can short-circuit for bugs and questions. The existing trivial/simple/complex classification stays, but gets two new siblings: `bug` and `question`.

## Work Objectives

### Core Objective
Stop routing ALL user input through the Prometheus planning flow. Bugs should go to the debug agent. Questions should get direct answers. Only build/implement/refactor tasks need planning.

### Concrete Deliverables
1. Extended `IntentClass` type: `"bug" | "question" | "trivial" | "simple" | "complex"`
2. Bug detection heuristics in `classifyIntent()` that catch error reports, stack traces, "not working" signals
3. Auto-delegation to debug agent when bug intent detected (via subagent tool call injection)
4. Passthrough mode for questions (no Prometheus system prompt injection)
5. Updated `orchestrator.md` with triage/routing documentation
6. Tests for new classifications

### Definition of Done
- User says "X is broken" → debug agent is auto-summoned, no planning flow
- User says "how does X work?" → direct answer, no planning flow
- User says "build X with Y" → existing Prometheus planning flow (unchanged)
- All existing 156 tests pass, new tests cover bug/question classification
- `npm run check` clean

### Must Have
- Bug detection that catches: error keywords, stack traces, "not working" / "broken" / "fails"
- Question detection that catches: "how", "what", "why", "explain", pure questions
- `bug` intent → auto-delegate to debug agent via `pi.sendMessage()` with instruction to use subagent
- `question` intent → no system prompt injection (passthrough to normal agent behavior)
- Existing trivial/simple/complex flow completely unchanged for non-bug non-question inputs

### Must NOT Have (Guardrails)
- NO changes to the Prometheus planning flow for trivial/simple/complex intents
- NO changes to interview, plan-generation, high-accuracy, or execution phases
- NO changes to the debug agent definition (debug.md stays as-is)
- NO new extensions or separate triage extension — this hooks into the existing plan-mode extension
- NO LLM-based triage (classification must be deterministic regex/heuristic, like `classifyIntent()` already is)
- NO removal of existing `classifyIntent()` logic — extend it, don't replace it

## Verification Strategy

### Test Decision
Add unit tests for extended `classifyIntent()` covering bug and question patterns. Run existing suite for regressions.

### QA Policy
- `npm run check` after all changes
- All 5 plan-mode test files pass
- Manual smoke: type "the login page is broken, I get a 500 error" and verify debug agent is summoned

## Execution Strategy

### Wave 1 (Start Immediately — types + heuristics + agent doc, parallel, no file overlap)

Task 1: Extend IntentClass and classifyIntent() in phases.ts
Task 2: Update orchestrator.md with triage/routing documentation
Task 3: Add bugTriagePrompt() to prompts.ts

### Wave 2 (After Wave 1 — routing logic + tests, depends on phases.ts changes)

Task 4: Wire new intents into before_agent_start handler in index.ts
Task 5: Add tests for bug/question classification and routing

## TODOs

- [ ] 1. Extend `IntentClass` type and `classifyIntent()` in phases.ts
  **What to do**:
  - Change `IntentClass` type from `"trivial" | "simple" | "complex"` to `"bug" | "question" | "trivial" | "simple" | "complex"`
  - In `classifyIntent()`, add bug detection BEFORE the existing trivial check (bugs take priority):
    ```typescript
    // Bug signals — error reports, broken functionality, stack traces
    const BUG_PATTERNS = [
      /\b(bug|broken|crash|error|fail|exception|stack\s*trace|not\s+working|stopped\s+working)\b/i,
      /\b(500|404|403|401|ECONNREFUSED|ENOENT|TypeError|ReferenceError|SyntaxError)\b/,
      /\b(undefined is not|cannot read|null pointer|segfault|panic|FATAL)\b/i,
      /\b(regression|broke|breaking|breaks|doesn't work|does not work|won't work|isn't working)\b/i,
    ];
    ```
  - Classification logic for bugs: if ANY bug pattern matches AND the prompt is NOT a build/create request (avoid "build error handling" being classified as bug), classify as `"bug"`
  - Add question detection AFTER bug check, BEFORE trivial check:
    ```typescript
    // Question signals — pure information requests
    const isQuestion = /^\s*(what|how|why|where|when|who|which|can you explain|tell me|is it|are there|does|do|should|could|would)\b/i.test(prompt);
    const hasQuestionMark = prompt.trim().endsWith("?");
    ```
  - If `isQuestion` or `hasQuestionMark`, and the prompt doesn't contain build/implement verbs, classify as `"question"`
  - Keep ALL existing trivial/simple/complex logic unchanged after these new checks
  - Add anti-collision guard: prompts starting with build/create/implement/make/set up verbs should NEVER be classified as bug or question, even if they contain error-like words (e.g., "build an error handling system")
  **Must NOT do**: Change existing trivial/simple/complex classification logic. Do not modify `ClearanceCheck`, `PlanModeState`, or any other types. Do not add new state machine phases.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: 4, 5
    - Blocked By: None
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/phases.ts` — `IntentClass` type (line 16), `classifyIntent()` function (line 86)
  **Acceptance Criteria**:
    - `classifyIntent("the login page is broken, I get a 500 error")` returns `"bug"`
    - `classifyIntent("TypeError: Cannot read property 'map' of undefined in UserList.tsx")` returns `"bug"`
    - `classifyIntent("how does the session manager work?")` returns `"question"`
    - `classifyIntent("what is the purpose of phases.ts?")` returns `"question"`
    - `classifyIntent("build an error handling system")` returns `"simple"` or `"complex"` (NOT `"bug"`)
    - `classifyIntent("fix the bug")` returns `"trivial"` (short fix request stays trivial, as before)
    - All existing trivial/simple/complex test cases still pass unchanged
  **Size**: M

- [ ] 2. Update `orchestrator.md` with triage/routing documentation
  **What to do**:
  - Add a `## Triage Mode` section to `~/.pi/agent/agents/orchestrator.md` that documents the routing logic:
    ```
    ## Triage Mode
    When invoked as a router, classify user input into:
    - **Bug**: Error reports, stack traces, "not working" signals → delegate to `debug` agent
    - **Question**: Pure information requests, "how/what/why" → answer directly or delegate to `explore`/`librarian`
    - **Simple task**: Single-file changes, config tweaks, minor fixes → handle directly or delegate to one specialist
    - **Complex task**: Multi-file builds, architecture changes, new features → invoke full Prometheus planning flow
    ```
  - Add the debug agent to the Agent Selection table:
    ```
    | `debug` | Diagnosing bugs, error investigation, root cause analysis |
    ```
  - Add a `### Bug Routing` subsection explaining what context to pass to the debug agent:
    - Error message / stack trace
    - Affected file paths (if mentioned)
    - Recent changes (suggest git log/diff)
    - Reproduction steps (if provided)
  **Must NOT do**: Change the agent's model, tools, name, or description frontmatter. Do not remove existing content.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: None
    - Blocked By: None
  **References**:
    - `~/.pi/agent/agents/orchestrator.md` — full file
  **Acceptance Criteria**:
    - File contains "Triage Mode" section
    - Agent Selection table includes `debug` agent
    - Bug Routing subsection documents context to pass
  **Size**: S

- [ ] 3. Add `bugTriagePrompt()` to prompts.ts
  **What to do**:
  - Add a new exported function `bugTriagePrompt(userPrompt: string): string` that returns a prompt instructing the main agent to delegate to the debug agent:
    ```typescript
    export function bugTriagePrompt(userPrompt: string): string {
      return `[BUG REPORT DETECTED — Auto-delegating to debug agent]

    The user reported a bug or error. Delegate this to the debug agent for systematic diagnosis.

    Use the subagent tool to run the **debug** agent with this task:
    "${userPrompt}"

    The debug agent will:
    1. Gather context (error messages, stack traces, affected files)
    2. Generate 5-7 hypotheses
    3. Narrow to 1-2 most likely causes
    4. Validate before fixing
    5. Ask for confirmation before applying changes

    After the debug agent completes, summarize its findings and any fixes applied.`;
    }
    ```
  - Also add `questionPassthroughPrompt()` — but this is a NO-OP: for questions, we simply don't inject any system prompt, letting the main agent respond naturally. So this function is NOT needed — document this decision in a comment instead.
  **Must NOT do**: Modify existing prompt functions. Do not change `buildSystemPrompt()` yet (that's Task 4).
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 1
    - Blocks: 4
    - Blocked By: None
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/prompts.ts` — add after `postExecutionPrompt()`, before `buildSystemPrompt()`
  **Acceptance Criteria**:
    - `bugTriagePrompt("login page broken")` returns string containing "debug agent" and the user's prompt
    - String contains "subagent" tool instruction
    - String contains "5-7 hypotheses" (references debug agent's methodology)
  **Size**: S

- [ ] 4. Wire new intents into `before_agent_start` and `agent_end` in index.ts
  **What to do**:
  Part A — before_agent_start handler:
  - In the idle→classification block (where `classifyIntent()` is called), add handling for the two new intents:
  - For `"bug"` intent:
    - Do NOT transition to any planning phase (stay idle-like, but with full tool access)
    - Instead, inject a message that instructs the agent to delegate to the debug agent
    - Use `pi.sendMessage()` with `bugTriagePrompt(event.prompt)` content and `triggerTurn: true`
    - Return without injecting Prometheus system prompt (the agent stays as itself, not Prometheus)
    - Set `state.phase` to `"idle"` (or leave it — the key is no Prometheus prompt injection)
  - For `"question"` intent:
    - Simply return without injecting any system prompt
    - The main agent handles the question directly with full tool access
    - Log: `_log("QUESTION: passthrough, no planning")`
  - Keep existing trivial→plan-generation and simple/complex→interview transitions unchanged

  Part B — Prevent stale bug/question handling:
  - After the bug triage message is sent and the debug agent responds, the `agent_end` handler will fire
  - Make sure the agent_end handler's interview/plan-generation/high-accuracy/execution sections don't accidentally trigger for bug/question intents
  - The safest approach: for `bug` and `question` intents, the `state.phase` stays `"idle"`, so none of the existing agent_end handlers activate (they all check `state.phase`)

  **Must NOT do**: Change the existing trivial/simple/complex routing logic. Do not add new phases to the state machine. Do not modify agent_end handlers for interview/plan-generation/high-accuracy/execution. Do not change tool filtering for any existing phase.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: 5
    - Blocked By: 1, 3
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/index.ts` — `before_agent_start` handler (line ~487), specifically the idle classification block (line ~497)
    - `packages/coding-agent/examples/extensions/plan-mode/prompts.ts` — `bugTriagePrompt()`
  **Acceptance Criteria**:
    - Bug input → no Prometheus system prompt injected, `bugTriagePrompt()` message sent with `triggerTurn: true`
    - Question input → no system prompt injected, agent handles naturally
    - `state.phase` remains `"idle"` for both bug and question intents
    - Existing trivial/simple/complex flow completely unchanged
    - Debug log shows `INTENT: bug` or `INTENT: question` for appropriate inputs
  **Size**: M

- [ ] 5. Add tests for new classification and routing
  **What to do**:
  - In `packages/coding-agent/test/plan-mode-phases.test.ts`, add a new `describe("classifyIntent — bug detection")` block:
    - "the login page is broken, I get a 500 error" → `"bug"`
    - "TypeError: Cannot read property 'map' of undefined" → `"bug"`
    - "the API endpoint stopped working after yesterday's deploy" → `"bug"`
    - "I'm getting a ECONNREFUSED when connecting to the database" → `"bug"`
    - "there's a regression in the payment flow" → `"bug"`
    - "build an error handling middleware" → NOT `"bug"` (anti-collision)
    - "create a bug tracking system" → NOT `"bug"` (anti-collision)
    - "implement crash reporting" → NOT `"bug"` (anti-collision)
  - Add `describe("classifyIntent — question detection")` block:
    - "how does the session manager work?" → `"question"`
    - "what is the purpose of phases.ts?" → `"question"`
    - "why are we using Neo4j for memory?" → `"question"`
    - "can you explain the wave execution flow?" → `"question"`
    - "is there a test for the login component?" → `"question"`
    - "how do I build a React component?" → `"question"` (NOT simple/complex — it's a question even with "build")
  - Verify ALL existing `classifyIntent` tests still pass (these test trivial/simple/complex and must not change)
  - In `packages/coding-agent/test/plan-mode-verification.test.ts`, add test for `bugTriagePrompt()`:
    - Output contains "debug agent"
    - Output contains the user prompt text
    - Output contains "subagent" tool instruction
  - Run all 5 test files to verify no regressions
  **Must NOT do**: Modify existing test assertions. Keep test style consistent.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: None
    - Blocked By: 1, 3, 4
  **References**:
    - `packages/coding-agent/test/plan-mode-phases.test.ts` — existing 22 tests for classifyIntent
    - `packages/coding-agent/test/plan-mode-verification.test.ts` — add bugTriagePrompt test
  **Acceptance Criteria**:
    - All 156 existing tests pass unchanged
    - At least 8 new tests for bug detection (5 positive, 3 anti-collision)
    - At least 5 new tests for question detection
    - At least 2 new tests for bugTriagePrompt()
    - `npm run check` passes
  **Size**: M

## Final Verification Wave

- [ ] F1. Run `npm run check` from repo root — zero errors, zero warnings
- [ ] F2. Run all 5 plan-mode test files — all pass including new tests
- [ ] F3. Verify symlinks still work: `ls -la ~/.pi/agent/extensions/plan-mode/`

## Success Criteria
1. Bug reports auto-delegate to the debug agent without entering planning flow
2. Questions get direct answers without Prometheus system prompt injection
3. Existing trivial/simple/complex planning flow unchanged
4. All tests pass (existing 156 + ~15 new)
5. `npm run check` clean

## Risks
1. **Bug/build anti-collision**: "build an error handling system" must NOT classify as bug. Mitigation: build/create/implement verbs take priority as exclusion guard.
2. **Question/trivial overlap**: "fix the bug?" has a question mark but is a fix request, not a question. Mitigation: check for action verbs before classifying as question.
3. **Debug agent availability**: If debug agent isn't defined, the subagent tool will return an error. Mitigation: the agent file exists at `~/.pi/agent/agents/debug.md` — already verified.
4. **State leakage**: After bug triage completes, state.phase is still idle. Next user message will be classified fresh. This is correct — each message gets independent triage.

## Design Decisions

### Why not a separate extension?
The plan-mode extension already owns the `before_agent_start` hook that classifies intent. Adding a separate triage extension would create hook conflicts. Extending the existing extension is cleaner.

### Why deterministic classification, not LLM-based?
Matches the existing pattern (`classifyIntent()` is pure regex/heuristic). Deterministic = testable, predictable, no token cost. The debug agent itself uses LLM reasoning — the triage layer just needs to detect the signal.

### Why not make the orchestrator agent the actual router?
The orchestrator is an agent invoked via subagent tool — it runs in a separate process with its own context window. Making it the router would mean every user message spawns a subprocess just to decide routing. Instead, the extension does fast deterministic routing, and the orchestrator remains available for explicit multi-agent coordination tasks.

### Why questions passthrough (no prompt injection) instead of a question-answering prompt?
The main pi agent is already good at answering questions. Injecting a "you are a question answerer" prompt would be worse than letting it use its default behavior with full tool access. Less is more.
