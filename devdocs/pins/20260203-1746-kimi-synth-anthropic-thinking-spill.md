# Pin: kimi-2.5 (synthetic Anthropic endpoint) thinking spill into response

Goal
- Determine why kimi-2.5 via the **synthetic Anthropic Messages endpoint** sometimes shows **thinking content in the final assistant text** (“thinking spilled into ai response”), and whether that’s a harness/provider bug vs upstream model behavior.

Scope / constraints
- Context discovery only (no repo edits yet).
- Use real endpoint config from `~/.mu/agent/models.json` and `$SYNTHETIC_API_KEY`.
- Compare our Anthropic provider to anomalyco/opencode’s Anthropic setup.

Current state (facts verified via local runs)
- Synthetic provider config:
  - `~/.mu/agent/models.json` provider `synthetic`: baseUrl `https://api.synthetic.new/anthropic`, api `anthropic-messages`, model `hf:moonshotai/Kimi-K2.5`.
  - `$SYNTHETIC_API_KEY` is set.

- Our Anthropic provider implementation: `packages/ai/src/providers/anthropic.ts`.
  - Parses SSE events by `content_block.type` into blocks: `text` / `thinking` / `toolCall`.
  - **Does not** currently capture any thinking signatures from the synthetic endpoint (we only accumulate `signature_delta`; synthetic appears to return thinking blocks without signatures).

- Repro attempts against synthetic endpoint:
  - Using `streamSimple()` / `completeSimple()` with model `synthetic/hf:moonshotai/Kimi-K2.5`, requests reliably returned content blocks `[thinking, text]` in correct order for small prompts.
  - Direct `@anthropic-ai/sdk` streaming shows `content_block_start type=thinking` then `type=text` (good separation).
  - Non-streaming `messages.create` can sometimes return `stop_reason=max_tokens` with only a `thinking` block and no text (expected if `max_tokens` too low).
  - Could **not** reproduce “thinking spilled into text” on fresh runs with small prompts.

- However, historical sessions show the symptom:
  - Found synthetic Kimi sessions where `AssistantMessage.content` includes both a `thinking` block and a `text` block that are **identical** (duplication).
  - Example file: `~/.mu/agent/sessions/.../2026-01-29T09-57-55-601Z_5567a61a-a4da-4e57-9278-f732308c7d09.jsonl` line containing timestamp `2026-01-29T10:00:02.726Z`.
  - Another example: `~/.mu/agent/sessions/.../2026-02-03T06-06-03-628Z_bf1b558c-abe6-4119-b8eb-332beea03440.jsonl` includes a message where thinking begins with “The user is asking…” and the text begins with the exact same reasoning (spilled/duplicated).

- This suggests the issue is **intermittent** and may depend on prompt shape / tool usage / long contexts / tool boundary handling.

Comparison with anomalyco/opencode
- opencode sets Anthropic headers similar to ours:
  - `anthropic-beta: claude-code-20250219,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14`.
- opencode uses `@ai-sdk/anthropic` provider creation + those headers; nothing obvious about “dedupe thinking vs text”.

Hypotheses to explore next (need verification)
1) Synthetic endpoint occasionally emits thinking as plain text blocks (upstream bug / proxy bug) or emits both thinking + text with same payload.
2) Our event parser’s block-index mapping (`blocks.findIndex(b.index === event.index)`) could mis-associate deltas if `event.index` is missing/incorrect on some events from synthetic.
3) Some tool/harness prompts cause the model to intentionally echo its reasoning in final answer (model noncompliance), not a parsing bug.

Next step (most valuable concrete repro)
- Build a stress/repro script that:
  - Uses `streamAnthropic` directly against synthetic with `thinkingEnabled: true`.
  - Logs raw event stream (type + index + delta type) and final assembled blocks.
  - Repeats across many trials and also across “tool-heavy” contexts to match the historical failure mode.
- If raw events show duplicate content (thinking == text), it’s upstream.
- If raw events are clean but our assembled message duplicates, it’s our parser.

Progress
- Added a repro harness script: `tmp/kimi-synth-anthropic-thinking-repro.mjs`
  - Runs two independent streams:
    - **raw**: direct `@anthropic-ai/sdk` `.messages.stream()` against `https://api.synthetic.new/anthropic`
    - **mu**: our `streamSimple()` (provider `synthetic`, api `anthropic-messages`)
  - Flags the symptom when normalized `thinking` text === normalized `text` output.
  - When the symptom is detected, it saves:
    - `raw-trial-<n>.json` (raw event log + assembled blocks)
    - `mu-trial-<n>.json` (mu final message)
    - `summary.json` (per-trial outcome)

How to run
- From repo root:
  - `node tmp/kimi-synth-anthropic-thinking-repro.mjs --trials 200 --max-tokens 4096 --mode both --scenario toolheavy`
  - `node tmp/kimi-synth-anthropic-thinking-repro.mjs --trials 200 --max-tokens 4096 --mode both --scenario stress`
  - Output logs saved under `tmp/kimi-synth-repro-<timestamp>/`

- Added a replay harness for historical failing sessions: `tmp/kimi-synth-replay-from-session.mjs`
  - Reads a mu session JSONL from `~/.mu/agent/sessions/**.jsonl`
  - Auto-detects the first assistant message that looks like a failure (normalized thinking == normalized text, or unstructured tool-call tokens)
  - Replays the conversation up to just before that assistant message and re-requests the next assistant response.
  - Supports `--mode mu|raw|both`.

Current findings (still context discovery)
- Replaying from known failing sessions did **not** deterministically reproduce the duplication in either:
  - mu replay (`streamSimple`), or
  - raw Anthropic SDK replay.
- In at least one failing session (2026-01-29), the “spill” includes **unstructured tool-call tokens** in both thinking and text:
  - `... <|tool_call_begin|> functions.Bash:19 ...`
  - and the model did **not** emit a structured `toolCall` content block.
  - This looks like intermittent model/proxy/tool-format noncompliance rather than a deterministic parser assembly bug.

Key files
- `packages/ai/src/providers/anthropic.ts`
- `packages/ai/src/stream.ts`
- `packages/ai/src/agent/agent-loop.ts`
- `packages/agent/src/transports/ProviderTransport.ts`
- `packages/agent/src/transports/AppTransport.ts`

Note
- The earlier auto-handoff error mentioned `packages/ai/src/providers/anthropic-messages.js` which does not exist; provider file is `packages/ai/src/providers/anthropic.ts` (compiled output is `packages/ai/src/providers/anthropic.js`).
