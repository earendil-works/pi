# Final Answer Streaming

This note documents Pi's first-class final-answer stream so future updates and merge-conflict fixes can preserve the behavior intentionally.

## Why this exists

Pi needs to separate agent trace from the canonical user-facing answer:

- Debug surfaces can show thinking, scratch text, tool calls, retries, and the final answer.
- Product/IDE/web surfaces can subscribe to and render only the final answer.
- Session history should persist meaning as structured content, not literal XML markers that every client must parse again.

## Behavior contract

Assistant messages can contain these content blocks:

- `thinking`
- `text`
- `toolCall`
- `finalAnswer`

The model-facing fallback contract is:

```xml
<final_answer>
The user-facing answer.
</final_answer>
```

Pi strips those markers from ordinary text and emits structured stream events:

- `final_answer_start`
- `final_answer_delta`
- `final_answer_end`

Persisted JSONL session history stores final answers as:

```json
{ "type": "finalAnswer", "text": "The user-facing answer." }
```

## Important implementation files

Core type and stream handling:

- `packages/ai/src/types.ts`
  - Adds `FinalAnswerContent` and `final_answer_*` assistant message events.
- `packages/ai/src/utils/final-answer-stream.ts`
  - Parses `<final_answer>` markers across streamed `text_delta` chunks.
  - Strips markers from text.
  - Emits `final_answer_*` events and stores `finalAnswer` blocks.
- `packages/ai/src/models.ts`
- `packages/ai/src/compat.ts`
- `packages/coding-agent/src/core/model-runtime.ts`
  - Wrap provider streams with the final-answer marker parser.

Provider/replay compatibility:

- `packages/ai/src/api/pi-messages.ts`
- `packages/agent/src/proxy.ts`
  - Reconstruct compact stream events with `finalAnswer` support.
- `packages/ai/src/api/transform-messages.ts`
- `packages/ai/src/api/mistral-conversations.ts`
- `packages/ai/src/utils/estimate.ts`
  - Treat `finalAnswer` as replayable text for providers that do not have a native concept.

Agent/session/UI surfaces:

- `packages/agent/src/agent-loop.ts`
  - Propagates `final_answer_*` as `message_update` events.
- `packages/coding-agent/src/core/system-prompt.ts`
  - Appends invariant model guidance to use final-answer markers once per completed user request for both default prompts and custom `SYSTEM.md` prompts.
- `packages/coding-agent/src/core/agent-session.ts`
  - Makes copy-last-assistant prefer `finalAnswer` when present.
- `packages/coding-agent/src/core/session-manager.ts`
  - Includes `finalAnswer` in session listing/search text extraction.
- `packages/coding-agent/src/modes/interactive/components/assistant-message.ts`
  - Renders a distinct `Final answer` label.
- `packages/coding-agent/src/core/export-html/template.js`
- `packages/coding-agent/src/core/export-html/template.css`
  - Preserves and displays final answers in HTML export.
- `packages/coding-agent/docs/rpc.md`
  - Documents `final_answer_*` RPC streaming events and `finalAnswer` content.

Tests:

- `packages/ai/test/faux-provider.test.ts`
  - Covers marker parsing across streamed chunks.
  - Covers marker-only answers without empty text blocks.
  - Covers native `finalAnswer` faux blocks.

## UAT finding: do not trust Codex phase yet

During tmux UAT, OpenAI/Codex Responses exposed `phase: "final_answer"`, but it covered the whole response when the model produced scratch text plus markers. That caused scratch text and literal markers to be stored as final-answer content.

Decision: keep `phase` metadata for replay/signatures, but do not map Codex/OpenAI Responses `phase: "final_answer"` directly to `final_answer_*` events yet. The marker parser is the active implementation.

If upstream later provides a reliable native final-answer item/phase that starts exactly at the answer boundary, map it deliberately and add UAT proving scratch text remains outside `finalAnswer`.

## Manual UAT

Run from the repo root:

```bash
./pi-test.sh
```

Prompt normally, without mentioning markers, for default-prompt compliance:

```text
Say hi in one sentence.
```

Expected TUI behavior:

- A `Final answer` label appears.
- The user-facing answer appears under that label.
- Literal `<final_answer>` markers are not visible.

For parser-specific UAT, force a trace plus marker response:

```text
Do not use tools. First write exactly: Scratch sentence. Then write exactly: <final_answer>Final answer streaming UAT passed.</final_answer>
```

Expected TUI behavior:

- `Scratch sentence.` appears as ordinary assistant text.
- `Final answer` appears as a separate labelled block.
- `Final answer streaming UAT passed.` appears under that label.
- Markers are stripped.

Check JSONL persistence:

```bash
rg -n 'finalAnswer|Final answer streaming UAT passed|<final_answer>' ~/.pi/agent/sessions -g '*.jsonl' --sort modified | tail -20
```

Expected assistant content includes:

```json
{ "type": "text", "text": "Scratch sentence.\n" }
{ "type": "finalAnswer", "text": "Final answer streaming UAT passed." }
```

Markers should appear only in the user prompt or diagnostic/tool output, not in assistant `finalAnswer` content.

## Validation commands

After changes:

```bash
cd packages/ai && ./node_modules/.bin/vitest --run test/faux-provider.test.ts
cd ../..
npm run check
```

The repo rule still applies: do not run the full vitest suite directly; use focused tests or `./test.sh` when broader non-e2e coverage is needed.

## Merge-conflict checklist

When rebasing onto a newer Pi version:

1. Preserve `FinalAnswerContent` and `final_answer_*` event types in `packages/ai/src/types.ts`.
2. Ensure all model/runtime stream dispatch paths still wrap provider streams with `parseFinalAnswerMarkers()`.
3. Ensure compact event reconstructors (`pi-messages`, proxy paths) know `final_answer_*`.
4. Ensure provider message transforms replay `finalAnswer` as plain text unless a provider has a proven native final-answer contract.
5. Keep the system prompt guidance as a builder-level invariant that applies to both default prompts and custom `SYSTEM.md` prompts, unless Pi has moved the behavior to a different prompt/resource layer.
6. Re-run parser UAT and inspect JSONL for structured `finalAnswer` blocks.
7. Do not re-enable direct Codex/OpenAI `phase: "final_answer"` mapping without fresh UAT proving the phase boundary is exact.
