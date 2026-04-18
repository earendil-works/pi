---
mode: build
---

# 1. Summary & Recommendation

Add Morph-backed compaction to the coding agent, plus a new built-in slash command:

- `/morph-compaction on|off|auto|status|toggle`

The implementation should support Morph compaction both for explicit compaction flows and automatic compaction flows.

Default policy should be:

- `auto`

In `auto` mode, Mu should use Morph when:

- `MORPH_API_KEY` is available
- Morph compaction is safe for the current compaction path
- native opaque replay semantics are not required

The Morph compaction `compression_ratio` must be selected dynamically using existing token-count heuristics so the compacted history aims to fit within `40%` of the current model context window, clamped to `0.3..0.7`.

Recommendation:

- implement a hybrid strategy, not Morph-everywhere
- keep native OpenAI/Codex compaction where hidden replay state matters
- use Morph for plain-text visible-history compaction where safe

# 2. What Must be True

- `/morph-compaction` is registered as a built-in slash command.
- `/morph-compaction` accepts exactly these modes:
  - `on`
  - `off`
  - `auto`
  - `status`
  - `toggle`
- The persisted default Morph compaction mode is `auto`.
- Morph compaction policy is stored in settings and survives restart.
- Explicit compaction flows can use Morph when the effective policy permits it.
- Automatic compaction flows can use Morph when the effective policy permits it.
- If `MORPH_API_KEY` is absent, Morph compaction is not attempted unless the design explicitly chooses warn-and-fallback behavior for forced `on` mode.
- The effective compaction strategy is derived from explicit inputs rather than scattered ad hoc checks.
- Dynamic ratio selection uses token counting heuristics already available in Mu.
- Dynamic ratio selection targets `40%` of the current model context window.
- Dynamic ratio selection clamps to `0.3..0.7`.
- If history is already at or below the target budget, the system can skip Morph compaction instead of compacting unnecessarily.
- Morph output that becomes `replacementMessages` is valid for `context_compaction` persistence and resume.
- Existing native OpenAI/Codex compact behavior continues to preserve opaque replay items where required.
- The user receives clear status, success, and fallback messages.

# 3. What Must Never Happen

- `/morph-compaction` must never silently change the meaning of `/compact`.
- `auto` mode must never force Morph in cases where native opaque replay state is required for correctness.
- Morph compaction must never be represented as a fake native `compaction` or `compaction_summary` replay item.
- Hidden replay carrier messages must never be discarded when the active compaction path depends on them.
- Dynamic ratio selection must never return a value below `0.3` or above `0.7`.
- The implementation must never guess exact token counts when only heuristic counts are available.
- A missing `MORPH_API_KEY` must never crash the command path.
- The command must never claim Morph is active when the effective strategy has fallen back to native or local summary.
- Existing session histories must never be rewritten to retrofit Morph metadata.
- The mission must never broaden into unrelated session, handoff, or provider refactors.

# 4. Inputs / Outputs

## Input

- Slash command: `/morph-compaction on`
- Slash command: `/morph-compaction off`
- Slash command: `/morph-compaction auto`
- Slash command: `/morph-compaction status`
- Slash command: `/morph-compaction toggle`
- Environment variable: `MORPH_API_KEY`
- Runtime inputs:
  - current model
  - current message history
  - token estimate for message history
  - model context window
  - explicit compaction goal when present

## Success Output

- Settings updated for `on`, `off`, `auto`, or `toggle`
- Status output includes at minimum:
  - saved Morph compaction mode
  - effective Morph compaction mode
  - whether `MORPH_API_KEY` is available
  - whether current strategy would use Morph, native compact, local fallback, or skip
- When Morph is used for compaction:
  - Morph receives a valid request shape
  - a dynamic ratio is selected and applied
  - resulting `replacementMessages` are usable by the existing session compaction path

## Failure / Fallback Output

- Clear error for invalid slash command mode
- Clear warning or fallback note when forced `on` cannot use Morph because the key is missing or the request fails
- Clear warning when `auto` selected Morph but runtime conditions forced fallback

# 5. Edge Cases

- `MORPH_API_KEY` missing and mode is `auto`
- `MORPH_API_KEY` missing and mode is `on`
- `MORPH_API_KEY` present but Morph API request fails
- Current model has a very small context window
- Current model has no usable context window information
- Estimated history already fits under `40%` target
- Estimated history far exceeds target and ratio clamps at `0.3`
- Estimated history only slightly exceeds target and ratio chooses near `0.7`
- History already contains hidden native compact replay items
- Explicit compaction on an OpenAI/Codex session that would normally preserve opaque replay state
- Automatic compaction triggered during a session with existing compacted history
- Tool-heavy or thinking-heavy sessions that require text projection into Morph-compatible request shapes
- Last user message is noisy, giant, or doc-heavy and must not become the raw Morph query
- User calls `/morph-compaction status` before any model is selected
- User toggles mode repeatedly across restarts

# 6. Constraints

- Keep the implementation tightly scoped to compaction policy, compaction strategy, and command handling.
- Do not introduce any `any` types.
- Reuse existing settings, TUI, and compaction infrastructure where possible.
- Do not remove or weaken native replay support for existing OpenAI/Codex compaction paths unless explicitly approved later.
- Use existing token-estimation heuristics rather than adding new exact tokenizer dependencies.
- Verification must include both targeted automated checks and at least one real interactive command path using XTUI.
- Real verification of Morph behavior must use the live API when `MORPH_API_KEY` is available.
- The implementation must not require `npm run dev`.

# 7. Definition of Done

- `/morph-compaction` exists as a built-in slash command.
- The command accepts `on`, `off`, `auto`, `status`, and `toggle` with clear messaging.
- Morph compaction mode persists in settings and restores correctly.
- Dynamic ratio selection is implemented, bounded to `0.3..0.7`, and targets `40%` of context window.
- The compaction strategy selector chooses among Morph, native replay compact, local summary fallback, and skip in a deterministic, testable way.
- Explicit compaction can use Morph when effective policy and safety checks allow it.
- Automatic compaction can use Morph when effective policy and safety checks allow it.
- Native replay sessions remain correct and preserve hidden replay items.
- Morph-projected message history produces valid `replacementMessages` for `context_compaction`.
- XTUI verification demonstrates the real command path end-to-end.
- `npm run check` passes after implementation.

## Verification Contract

### Red checks

- `/morph-compaction` parser does not yet accept `auto` / `toggle` / `status` correctly before implementation.
- No persisted Morph compaction mode exists before implementation.
- Strategy selection cannot yet distinguish Morph-safe cases from native-replay-required cases.
- Dynamic ratio selection does not yet exist.
- Automatic compaction cannot yet switch to Morph based on policy.

### Green checks

- Slash command parser and mode application tests pass.
- Settings round-trip tests for default `auto` and explicit `on` / `off` pass.
- Ratio selection tests pass for:
  - under-budget skip
  - near-target light compaction
  - midrange compaction
  - hard clamp to `0.3`
  - hard clamp to `0.7`
- Strategy selection tests pass for:
  - Morph disabled
  - Morph forced on with key present
  - Morph auto with key present and safe path
  - Morph auto with key absent
  - native replay required
  - remote failure fallback
- Projection tests pass for:
  - user messages
  - assistant text
  - tool results
  - thinking/tool-call text projection where applicable
- Context compaction integration tests pass with Morph-derived `replacementMessages`.
- Existing native replay compact tests continue to pass.

### Live Morph checks

- A real session transcript from `~/.mu/agent/sessions/...` can be projected into Morph request format.
- A live `POST /v1/compact` call succeeds using that projected request.
- A live `POST /v1/responses` call with `model: "morph-compactor"` succeeds.
- A verbatim-line assertion confirms that retained non-marker lines exist in the original input.

### XTUI checks

- Launch the real CLI in a controlled workspace.
- Enter `/morph-compaction status` and assert the mode/status message appears.
- Enter `/morph-compaction on` and assert confirmation appears.
- Trigger an explicit compaction path and assert the UI reports Morph usage or a clear fallback reason.
- Optionally verify that `/morph-compaction auto` on a native-replay-required path reports native strategy rather than incorrectly forcing Morph.

# 8. What needs to be done to deliver the spec

- Add a new Morph compaction mode type and parser.
- Add settings persistence for Morph compaction mode.
- Register `/morph-compaction` in the built-in slash command list and dispatch it in the TUI.
- Add an effective-mode + strategy selector for compaction backends.
- Add a dedicated Morph projection helper for message history and query construction.
- Add a dynamic ratio selector that uses heuristic token counts and the `40%` target.
- Integrate Morph strategy into explicit compaction flow.
- Integrate Morph strategy into automatic compaction flow.
- Preserve native replay compaction behavior for safety-critical paths.
- Add targeted tests for parser, settings, ratio logic, strategy selection, projection, and session-compaction integration.
- Add XTUI verification coverage for the real slash command path.
- Run `npm run check`.

## Test Fixture Requirements

- At least one fixture conversation with:
  - mixed user / assistant / tool-result history
  - enough context to require compaction
- At least one fixture case with native replay carrier items already present
- At least one XTUI verification script or harness flow exercising `/morph-compaction`
- At least one live Morph probe script under `/tmp` used during mission execution to validate request shape assumptions

