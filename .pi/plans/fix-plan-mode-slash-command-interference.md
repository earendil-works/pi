# Fix Plan Mode Intercepting Slash Commands

## TL;DR
> **Quick Summary**: Plan mode's `before_agent_start` auto-activates on every user prompt, including expanded slash commands that have lost their `/` prefix. Fix by adding an `input` event handler that detects `/` commands before expansion and flags them for skip.
> **Deliverables**: Modified `plan-mode/index.ts` with input handler + guard, new test file, optional core `BeforeAgentStartEvent` improvement.
> **Estimated Effort**: Short
> **Parallel Execution**: YES — 2 waves
> **Critical Path**: TODO 1 + TODO 2 (same file, same wave) → TODO 3 (tests)

## Context

### Original Request
"Because we are in plan mode by default, when I run commands with `/`, the plan mode interrupts their logic."

### Interview Summary
Research confirmed the root cause in the `prompt()` pipeline in `agent-session.ts`:

```
User: /review code.ts
  ↓
1. Extension command check (/plan, /todos) → NOT HANDLED (this is a template)
  ↓
2. emitInput() fires with ORIGINAL text "/review code.ts"
   (plan mode has NO input handler — missed opportunity)
  ↓
3. Skill/template expansion → "Review code.ts for quality..." (/ prefix GONE)
  ↓
4. emitBeforeAgentStart(expandedText) at agent-session.ts:975-978
   Plan mode sees "Review code.ts..." with no way to know it was a slash command
  ↓
5. Plan mode: state.phase === "idle" && event.prompt → AUTO-ACTIVATES ← BUG
  ↓
6. Prometheus system prompt injected → agent plans instead of executing the command
```

Key finding: `BeforeAgentStartEvent.prompt` = **expanded** text (no `/`), but `InputEvent.text` = **original** text (with `/`). Plan mode currently ignores the `input` event entirely.

### Metis Review
Edge cases identified during analysis:
1. **Streaming race**: If user types `/` command during streaming, `emitInput()` fires (flag set) but `prompt()` returns early before `before_agent_start` — flag persists. Fix: always reset flag at start of input handler.
2. **Extension-chaining**: If another extension's `input` handler transforms `/review` → `Review...` before plan mode's handler runs, plan mode would miss the `/`. Mitigated by reset-at-start pattern and low practical likelihood.
3. **sendMessage vs sendUserMessage**: `pi.sendMessage({...}, {triggerTurn: true})` bypasses `prompt()` entirely (calls `this.agent.prompt()` directly) — neither `emitInput()` nor `before_agent_start` fires. `pi.sendUserMessage()` goes through `prompt()` with `source: "extension"`. Both are safe.

### State Machine Assessment
No stateful workflows identified — skipped. The existing plan-mode state machine (idle→interview→plan-generation→high-accuracy→execution→complete) is not being modified. We're adding a guard that prevents entry from idle when input is a slash command.

## Work Objectives

### Core Objective
Prevent plan mode from auto-activating when the user invokes slash commands (skills, prompt templates).

### Concrete Deliverables
1. Modified `plan-mode/index.ts` with `input` event handler and `before_agent_start` guard
2. New test file `test/plan-mode-slash-bypass.test.ts`
3. *(Optional)* Core types enriched with `originalPrompt`/`source` on `BeforeAgentStartEvent`

### Definition of Done
- Typing a prompt template (e.g., `/review code.ts`) does NOT activate plan mode
- Typing a skill command (e.g., `/skill:reviewer`) does NOT activate plan mode
- Typing a normal prompt (e.g., `fix the auth bug`) DOES activate plan mode as before
- All existing plan-mode tests pass
- No regressions in extension input event tests

### Must Have
- `input` event handler in plan-mode that detects `/` prefix on original text
- Guard in `before_agent_start` that skips auto-activation when flag is set
- Flag reset at start of every input event (streaming safety)
- `source !== "extension"` check to avoid false positives from `pi.sendUserMessage()`
- Tests covering: slash command bypass, normal prompt activation, extension source ignored, flag reset

### Must NOT Have (Guardrails)
- Do NOT modify the plan-mode state machine (phases, transitions, clearance)
- Do NOT change behavior of `/plan` or `/todos` extension commands (they're already handled before `emitInput`)
- Do NOT block slash commands during active planning phases (interview, execution) — only guard the idle→auto-activate transition
- Wave 2 (core improvement) is optional and must not be a prerequisite for Wave 1

## Verification Strategy

### Test Decision
Unit tests for the flag logic. Integration tests using the `ExtensionRunner` test harness (pattern from `extensions-input-event.test.ts`).

### QA Policy
1. Run existing plan-mode test suite (regression)
2. Run new slash-bypass tests
3. Manual verification: start pi, type a template command, confirm no plan mode activation

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — extension fix + tests):
├── TODO 1: Add input handler + flag to plan-mode/index.ts
├── TODO 2: Guard before_agent_start auto-activation
└── TODO 3: Add test file for slash command bypass

Wave 2 (After Wave 1 — optional core improvement):
├── TODO 4: Add originalPrompt/source to BeforeAgentStartEvent type
├── TODO 5: Pass metadata through runner.ts
├── TODO 6: Pass metadata from agent-session.ts prompt()
└── TODO 7: Simplify plan-mode to use event.originalPrompt

Final Verification:
└── F1: Full test suite + manual QA
```

### Dependency Matrix
| Task | Depends On | Blocks |
|------|-----------|--------|
| TODO 1 | None | TODO 3, F1 |
| TODO 2 | None (same file as 1, logically paired) | TODO 3, F1 |
| TODO 3 | TODO 1 + 2 | F1 |
| TODO 4 | None | TODO 5 |
| TODO 5 | TODO 4 | TODO 6 |
| TODO 6 | TODO 5 | TODO 7 |
| TODO 7 | TODO 6, TODO 1+2 | F1 |

## TODOs

---

- [ ] 1. Add `input` event handler to detect slash commands
  **What to do**:
  1. In `packages/coding-agent/examples/extensions/plan-mode/index.ts`, add a closure variable after `let state: PlanModeState = createInitialState();` (line ~82):
     ```typescript
     // Track whether current input originated from a slash command (skill/template).
     // Set by the input handler (which sees original text before expansion),
     // consumed by before_agent_start.
     let inputIsSlashCommand = false;
     ```
  2. Register an `input` event handler after the flag registration block (after `pi.registerFlag(...)`, before the `// --- UI Helpers ---` section). Insert it alongside the other event handlers:
     ```typescript
     // Detect slash commands before template expansion strips the "/" prefix.
     // Extension commands (/plan, /todos) are handled at Layer 1 in prompt() and
     // return before emitInput() fires — they never reach this handler.
     pi.on("input", async (event) => {
     	inputIsSlashCommand = false; // Reset for every input (streaming safety)
     	if (event.text.startsWith("/") && event.source !== "extension") {
     		inputIsSlashCommand = true;
     	}
     });
     ```
  **Must NOT do**: Do not return `{ action: "handled" }` or `{ action: "transform" }` — this handler is observation-only, it must not consume or modify input.
  **Parallelization**:
    - Can Run In Parallel: YES (with TODO 2, same file)
    - Parallel Group: Wave 1
    - Blocks: TODO 3
    - Blocked By: None
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/index.ts` line 82 (state declaration)
    - `packages/coding-agent/examples/extensions/plan-mode/index.ts` lines 86-93 (flag registration)
    - `packages/coding-agent/src/core/extensions/types.ts` lines 376-393 (`InputEvent`, `InputSource`, `InputEventResult` types)
    - `packages/coding-agent/src/core/agent-session.ts` lines 880-893 (`emitInput()` call — fires before template expansion)
  **Acceptance Criteria**:
    - `inputIsSlashCommand` variable exists in the extension closure scope
    - `input` event handler is registered via `pi.on("input", ...)`
    - Handler resets flag to `false` then conditionally sets to `true`
    - Handler checks `event.source !== "extension"` to avoid false positives
    - Handler returns void (no action returned)
  **QA Scenarios**:
    Scenario: Slash command sets the flag
      Tool: Unit test
      Steps: Simulate input event with `text: "/review code.ts"`, `source: "interactive"`
      Expected Result: `inputIsSlashCommand === true`
    Scenario: Normal prompt does not set the flag
      Tool: Unit test
      Steps: Simulate input event with `text: "fix the auth bug"`, `source: "interactive"`
      Expected Result: `inputIsSlashCommand === false`
    Scenario: Extension source does not set the flag
      Tool: Unit test
      Steps: Simulate input event with `text: "/something"`, `source: "extension"`
      Expected Result: `inputIsSlashCommand === false`

---

- [ ] 2. Guard `before_agent_start` auto-activation with the flag
  **What to do**:
  1. In `packages/coding-agent/examples/extensions/plan-mode/index.ts`, modify the `before_agent_start` handler's auto-activation block (currently at ~line 470):
     **Current code:**
     ```typescript
     // Auto-activate: classify intent and enter interview phase
     if (state.phase === "idle" && event.prompt) {
     	state.userPrompt = event.prompt;
     	state.intent = classifyIntent(event.prompt);
     	_log(`INTENT: ${state.intent} for "${event.prompt.slice(0, 80)}"`);
     
     	// Trivial requests skip interview, go straight to plan-generation
     	if (state.intent === "trivial") {
     		transitionTo("plan-generation", ctx);
     	} else {
     		transitionTo("interview", ctx);
     	}
     }
     ```
     **Replace with:**
     ```typescript
     // Auto-activate: classify intent and enter interview phase
     if (state.phase === "idle" && event.prompt) {
     	// Skip auto-activation for slash commands (skills, templates).
     	// The "/" prefix is stripped by template expansion before this event fires,
     	// so we rely on the input handler (which sees original text) to set this flag.
     	if (inputIsSlashCommand) {
     		inputIsSlashCommand = false;
     		_log(`SKIP_AUTO_ACTIVATE: slash command detected, letting it pass through`);
     		return;
     	}
     
     	state.userPrompt = event.prompt;
     	state.intent = classifyIntent(event.prompt);
     	_log(`INTENT: ${state.intent} for "${event.prompt.slice(0, 80)}"`);
     
     	// Trivial requests skip interview, go straight to plan-generation
     	if (state.intent === "trivial") {
     		transitionTo("plan-generation", ctx);
     	} else {
     		transitionTo("interview", ctx);
     	}
     }
     ```
  **Must NOT do**: Do not modify any other part of the `before_agent_start` handler (system prompt injection for active planning phases, verification turn handling, user prompt capture).
  **Parallelization**:
    - Can Run In Parallel: YES (with TODO 1, same file — logically paired)
    - Parallel Group: Wave 1
    - Blocks: TODO 3
    - Blocked By: None
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/index.ts` lines 463-480 (`before_agent_start` handler, auto-activation block)
  **Acceptance Criteria**:
    - When `inputIsSlashCommand === true`, the handler returns early (no state transition, no system prompt injection)
    - Flag is consumed (set to false) after check
    - Debug log `SKIP_AUTO_ACTIVATE` is written
    - `state.phase` remains `"idle"` after a slash command
    - Existing auto-activation for normal prompts is unchanged
  **QA Scenarios**:
    Scenario: Slash command does not trigger plan mode
      Tool: Bash
      Steps: `cd packages/coding-agent && npx vitest run test/plan-mode-slash-bypass.test.ts`
      Expected Result: All tests pass, specifically the "before_agent_start skips activation when flag is set" test
    Scenario: Normal prompt still triggers plan mode
      Tool: Bash
      Steps: `cd packages/coding-agent && npx vitest run test/plan-mode-phases.test.ts`
      Expected Result: All existing tests pass (classifyIntent, clearance markers, etc.)

---

- [ ] 3. Add tests for slash command bypass
  **What to do**:
  Create `packages/coding-agent/test/plan-mode-slash-bypass.test.ts`. Follow the patterns from `test/plan-mode-phases.test.ts` (pure function tests) and `test/extensions-input-event.test.ts` (ExtensionRunner integration tests).

  Tests to write:

  **Unit tests** (testing the logic directly):
  1. `classifyIntent` still works for normal prompts (sanity check)
  2. Verify the flag variable behavior matches the contract

  **Integration tests** (using ExtensionRunner or manual handler invocation):
  3. `input` event with `/review code.ts` + `source: "interactive"` → sets flag
  4. `input` event with `fix the bug` + `source: "interactive"` → does not set flag
  5. `input` event with `/something` + `source: "extension"` → does not set flag (extension messages exempt)
  6. `input` event with `/something` + `source: "rpc"` → sets flag (RPC users also type slash commands)
  7. Flag is consumed after `before_agent_start` checks it — second call to `before_agent_start` without new input does activate
  8. Flag reset at start of input handler — leftover flag from previous input is cleared
  9. End-to-end: input(`/review`) → before_agent_start() → state remains `idle`, no system prompt returned
  10. End-to-end: input(`fix bug`) → before_agent_start() → state transitions to `interview` or `plan-generation`

  **Test file structure:**
  ```typescript
  import { describe, expect, it } from "vitest";
  // Import pure functions for unit tests
  import { classifyIntent, createInitialState } from "../examples/extensions/plan-mode/phases.js";

  describe("plan-mode slash command bypass", () => {
    describe("classifyIntent sanity (unchanged)", () => {
      it("still classifies normal prompts", () => { ... });
    });

    describe("input handler flag behavior", () => {
      // Test the flag logic — may need to extract it or test via ExtensionRunner
      it("sets flag for interactive slash commands", () => { ... });
      it("does not set flag for normal prompts", () => { ... });
      it("does not set flag for extension source", () => { ... });
      it("resets flag at start of each input event", () => { ... });
    });

    describe("before_agent_start guard", () => {
      it("skips auto-activation when flag is set", () => { ... });
      it("activates normally when flag is not set", () => { ... });
      it("consumes flag after check", () => { ... });
    });
  });
  ```

  **Must NOT do**: Do not import or depend on private closure variables from `index.ts` — test through the public extension interface (ExtensionRunner) or test the extracted pure functions.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 1 (after TODO 1+2)
    - Blocks: F1
    - Blocked By: TODO 1, TODO 2
  **References**:
    - `packages/coding-agent/test/plan-mode-phases.test.ts` (test pattern for pure function tests)
    - `packages/coding-agent/test/extensions-input-event.test.ts` (test pattern for ExtensionRunner integration)
    - `packages/coding-agent/examples/extensions/plan-mode/phases.ts` (imports)
  **Acceptance Criteria**:
    - Test file exists and runs with `npx vitest run test/plan-mode-slash-bypass.test.ts`
    - Minimum 8 test cases covering the scenarios listed above
    - All tests pass
    - No modifications to existing test files
  **QA Scenarios**:
    Scenario: All new tests pass
      Tool: Bash
      Steps: `cd packages/coding-agent && npx vitest run test/plan-mode-slash-bypass.test.ts`
      Expected Result: Exit code 0, all tests pass
    Scenario: Existing tests unaffected
      Tool: Bash
      Steps: `cd packages/coding-agent && npx vitest run test/plan-mode-phases.test.ts test/plan-mode-utils.test.ts`
      Expected Result: Exit code 0, all tests pass

---

- [ ] 4. *(Optional)* Add `originalPrompt` and `source` to `BeforeAgentStartEvent`
  **What to do**:
  1. In `packages/coding-agent/src/core/extensions/types.ts`, add two optional fields to `BeforeAgentStartEvent`:
     ```typescript
     export interface BeforeAgentStartEvent {
     	type: "before_agent_start";
     	prompt: string;
     	/** The user's original input before skill/template expansion. Undefined for extension-originated messages. */
     	originalPrompt?: string;
     	images?: ImageContent[];
     	systemPrompt: string;
     	/** Where the input originated: "interactive", "rpc", or "extension". */
     	source?: InputSource;
     }
     ```
  **Must NOT do**: Do not make `originalPrompt` or `source` required — they must be optional for backward compatibility.
  **Parallelization**:
    - Can Run In Parallel: YES
    - Parallel Group: Wave 2
    - Blocks: TODO 5
    - Blocked By: None
  **References**:
    - `packages/coding-agent/src/core/extensions/types.ts` lines 303-308 (`BeforeAgentStartEvent`)
    - `packages/coding-agent/src/core/extensions/types.ts` lines 371-374 (`InputSource` type)
  **Acceptance Criteria**:
    - `BeforeAgentStartEvent` has `originalPrompt?: string` and `source?: InputSource`
    - TypeScript compiles with `npx tsc --noEmit`
  **QA Scenarios**:
    Scenario: Type check passes
      Tool: Bash
      Steps: `cd packages/coding-agent && npx tsc --noEmit`
      Expected Result: Exit code 0

---

- [ ] 5. *(Optional)* Pass metadata through `ExtensionRunner.emitBeforeAgentStart()`
  **What to do**:
  1. In `packages/coding-agent/src/core/extensions/runner.ts`, add an optional `options` parameter to `emitBeforeAgentStart()`:
     ```typescript
     async emitBeforeAgentStart(
     	prompt: string,
     	images: ImageContent[] | undefined,
     	systemPrompt: string,
     	options?: { originalPrompt?: string; source?: InputSource },
     ): Promise<BeforeAgentStartCombinedResult | undefined>
     ```
  2. Include the new fields in the event object at ~line 765:
     ```typescript
     const event: BeforeAgentStartEvent = {
     	type: "before_agent_start",
     	prompt,
     	originalPrompt: options?.originalPrompt,
     	images,
     	systemPrompt: currentSystemPrompt,
     	source: options?.source,
     };
     ```
  **Must NOT do**: Do not change the existing 3-parameter call signature — `options` must be optional.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: TODO 6
    - Blocked By: TODO 4
  **References**:
    - `packages/coding-agent/src/core/extensions/runner.ts` lines 749-770 (`emitBeforeAgentStart`)
  **Acceptance Criteria**:
    - Method accepts optional 4th parameter
    - Event object includes `originalPrompt` and `source` when provided
    - Existing callers (without options) still work
  **QA Scenarios**:
    Scenario: Type check passes
      Tool: Bash
      Steps: `cd packages/coding-agent && npx tsc --noEmit`
      Expected Result: Exit code 0

---

- [ ] 6. *(Optional)* Pass original text from `agent-session.ts`
  **What to do**:
  1. In `packages/coding-agent/src/core/agent-session.ts`, modify the `emitBeforeAgentStart` call at ~line 975:
     ```typescript
     // BEFORE:
     const result = await this._extensionRunner.emitBeforeAgentStart(
     	expandedText,
     	currentImages,
     	this._baseSystemPrompt,
     );
     
     // AFTER:
     const result = await this._extensionRunner.emitBeforeAgentStart(
     	expandedText,
     	currentImages,
     	this._baseSystemPrompt,
     	{ originalPrompt: text, source: options?.source ?? "interactive" },
     );
     ```
     Where `text` is the first parameter of `prompt()` (the original, unexpanded user input).
  **Must NOT do**: Do not modify the `steer()` or `followUp()` methods — they don't call `emitBeforeAgentStart`.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: TODO 7
    - Blocked By: TODO 5
  **References**:
    - `packages/coding-agent/src/core/agent-session.ts` lines 975-978 (`emitBeforeAgentStart` call)
    - `packages/coding-agent/src/core/agent-session.ts` line 865 (`text` parameter of `prompt()`)
  **Acceptance Criteria**:
    - `emitBeforeAgentStart` is called with the original `text` as `originalPrompt`
    - `source` defaults to `"interactive"` when not specified
  **QA Scenarios**:
    Scenario: Full test suite passes
      Tool: Bash
      Steps: `cd packages/coding-agent && npx vitest run`
      Expected Result: Exit code 0

---

- [ ] 7. *(Optional)* Simplify plan-mode to use `event.originalPrompt`
  **What to do**:
  1. In `packages/coding-agent/examples/extensions/plan-mode/index.ts`, update the `before_agent_start` handler to use the new event field as primary check, keeping the flag as fallback:
     ```typescript
     if (state.phase === "idle" && event.prompt) {
     	// Skip auto-activation for slash commands.
     	// Primary: check original prompt (available after core improvement).
     	// Fallback: check flag from input handler.
     	const isSlashCommand = event.originalPrompt?.startsWith("/") ?? inputIsSlashCommand;
     	if (isSlashCommand) {
     		inputIsSlashCommand = false;
     		_log(`SKIP_AUTO_ACTIVATE: slash command detected`);
     		return;
     	}
     	// ...existing logic
     }
     ```
  **Must NOT do**: Do not remove the `input` event handler or the `inputIsSlashCommand` flag — keep them as fallback for backward compatibility.
  **Parallelization**:
    - Can Run In Parallel: NO
    - Parallel Group: Wave 2
    - Blocks: F1
    - Blocked By: TODO 6, TODO 1+2
  **References**:
    - `packages/coding-agent/examples/extensions/plan-mode/index.ts` (before_agent_start handler)
  **Acceptance Criteria**:
    - Handler checks `event.originalPrompt?.startsWith("/")` first
    - Falls back to `inputIsSlashCommand` flag
    - All existing tests still pass
  **QA Scenarios**:
    Scenario: Full plan-mode test suite passes
      Tool: Bash
      Steps: `cd packages/coding-agent && npx vitest run test/plan-mode-*.test.ts`
      Expected Result: Exit code 0

---

## Final Verification Wave

- [ ] F1. Run full test suite
  ```bash
  cd packages/coding-agent && npx vitest run
  ```
  Expected: all tests pass, zero regressions.

- [ ] F2. Manual QA
  1. Start pi with plan-mode extension loaded
  2. Type a prompt template (e.g., `/review somefile.ts`) → confirm agent executes the template normally (no Prometheus system prompt, no interview questions)
  3. Type a normal prompt (e.g., `build a REST API for user management`) → confirm plan mode activates (interview phase, Prometheus behavior)
  4. Type `/plan` → confirm plan mode toggle works as before

- [ ] F3. Scope Fidelity Check
  Verify that ONLY the auto-activation guard was changed. No modifications to:
  - State machine phases or transitions
  - Clearance check logic
  - Execution wave dispatch
  - Tool restrictions during planning
  - `/plan` or `/todos` command handlers

## Risk Flags

| Risk | Severity | Mitigation |
|------|----------|------------|
| Extension load order: another extension's `input` handler transforms `/` prefix before plan-mode sees it | Low | Reset-at-start pattern; only matters with transform-returning input handlers on `/` text |
| Stale flag from streaming: `emitInput()` fires but `before_agent_start` doesn't (streaming) | Low | Flag reset at start of every `input` event; next prompt always resets |
| Symlink: `~/.pi/agent/extensions/plan-mode/` → source in `examples/extensions/plan-mode/` | Info | Changes to source file automatically reflected via symlink |

## Success Criteria
1. Slash commands (skills, templates) execute without plan mode interference
2. Normal prompts still auto-activate plan mode
3. All existing tests pass (zero regressions)
4. New tests cover flag lifecycle (set, consume, reset, source check)
