# Worklog: Robust handoff file selection

- Discovery: `selectHandoffFiles()` uses a text transcript that omits tool-call arguments, which hides `Read.path` and other critical file references.
- Verified via scripts against real session JSONL logs: baseline transcript misses many file paths; including tool-call args yields 100% path coverage.
- Found parser failure cases for `parseHandoffFileSelections()` (single-quote attrs, escaped tags, backtick-wrapped paths).

- Implemented parser hardening:
  - Accepts single-quoted attrs (`path='...'`).
  - Unescapes `&lt;`/`&gt;`/`&amp;` (including common double-escaped forms) so escaped `<file>` tags parse.
  - Strips wrapping backticks/quotes from extracted values.
  - Added tests for these variants.
  - Verified: `npx vitest --run packages/coding-agent/test/handoff-file-selection.test.ts`.

- Implemented robust handoff selection transcript:
  - Added `formatMessagesForHandoffSelection()` that includes tool-call arguments (especially `Read.path`) and truncates aggressively.
  - Wired `TuiRenderer.formatMessagesForHandoff()` to use the new formatter.
  - Added unit test verifying tool-call args are present in transcript.
  - Verified:
    - `npx vitest --run packages/coding-agent/test/handoff-selection-transcript.test.ts`
    - `npx vitest --run packages/coding-agent/test/handoff-file-selection.test.ts`

- Tightened handoff file selection prompt to explicitly forbid escaped tags and backticks/quotes.
- Verified repo-wide: `npm run check`.

Next: Implement improved transcript formatting (include tool-call args + truncation), harden XML parsing, tighten prompt, add tests, and run `npm run check`.
