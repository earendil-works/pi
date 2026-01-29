# Pin: Robust handoff file selection (auto/explicit handoff)

## Goal
Make `/handoff` and auto-handoff **robust** by ensuring the file-selection step always has enough information (tool-call arguments + sensible truncation) and by hardening XML parsing so we don’t fail with `No files selected for handoff`.

## Context / Problem
Current behavior:
- `TuiRenderer.selectHandoffFiles()` calls an LLM with `historyText` built by `formatMessagesForHandoff()`.
- That formatter currently **drops tool-call arguments** and includes only `[Tool: <name>]` markers.
- The `Read` tool result does **not** include the file path, so the selector often cannot infer what files were actually touched.
- When the LLM output parses to zero `<file>` entries, we throw `Error("No files selected for handoff")`.

Verified via local probes over real session JSONLs:
- Baseline formatter often misses many `Read.path` values; adding tool-call args makes coverage 100%.
- `parseHandoffFileSelections()` currently fails on common model variants:
  - `<file path='src/a.ts'/>` (single quotes)
  - `&lt;file&gt;...&lt;/file&gt;` (escaped XML)
  - `<file>` values wrapped in backticks (parses but returns backticks, later failing file lookup)

## Constraints
- Keep changes tight (no refactors).
- Keep tool outputs small enough for “context is already high” scenarios (truncate aggressively).
- No `any` (unless absolutely necessary).
- Must run `npm run check` at repo root after code changes.

## Planned Approach
1) Improve the handoff selection input:
   - Replace/extend `formatMessagesForHandoff()` to include tool-call arguments in a compact, safe format.
   - Truncate large argument fields (e.g. `content`, `input`, `oldText`, `newText`) and long strings.
   - Keep tool results truncated (already 500 chars); also consider truncating user/assistant text blocks.

2) Tighten `getHandoffFileSelectionPrompt()` instructions:
   - Explicitly forbid backticks/quotes around file values.
   - Specify “do not escape `<`/`>`; output literal XML”.
   - Prefer repo-root relative paths.

3) Harden `parseHandoffFileSelections()`:
   - Accept single-quote attributes.
   - Unescape `&lt;` / `&gt;` / `&amp;` at least for tag delimiters.
   - Strip wrapping backticks/quotes/whitespace around extracted file values.

4) Tests:
   - Extend `packages/coding-agent/test/handoff-file-selection.test.ts` with the known failing variants.
   - Add unit tests for the new “handoff selection transcript” formatter to ensure it includes tool-call paths.

## Current Slice (Implementation Loop required)
Done (all planned slices complete).

Verification (must run):
- `npx vitest --run packages/coding-agent/test/handoff-file-selection.test.ts`
- `npx vitest --run packages/coding-agent/test/**/*.test.ts` (if quick enough; otherwise targeted new tests)
- `npm run check`

## Files to Touch
- packages/coding-agent/src/tui/tui-renderer.ts
- packages/coding-agent/src/handoff-file-selection.ts
- packages/coding-agent/src/prompts/index.ts
- packages/coding-agent/test/handoff-file-selection.test.ts
- (new) packages/coding-agent/test/handoff-selection-transcript.test.ts (or similar)
