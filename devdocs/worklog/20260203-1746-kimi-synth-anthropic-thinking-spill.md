# Worklog: kimi-2.5 synthetic Anthropic thinking spill

## 2026-02-03

- Added repro harness: `tmp/kimi-synth-anthropic-thinking-repro.mjs`
  - Direct `@anthropic-ai/sdk` stream against `https://api.synthetic.new/anthropic` with thinking enabled.
  - mu-ai `streamSimple()` stream in parallel with the same prompt.
  - Logs raw event metadata (type/index/delta_type + minimal payload) and assembles blocks.
  - Flags and persists trials where normalized thinking === normalized text.

- Ran quick smoke checks:
  - `node tmp/kimi-synth-anthropic-thinking-repro.mjs --trials 3 --max-tokens 512 --mode both --scenario small`
  - `node tmp/kimi-synth-anthropic-thinking-repro.mjs --trials 5 --max-tokens 2048 --mode both --scenario toolheavy`
  - `node tmp/kimi-synth-anthropic-thinking-repro.mjs --trials 3 --max-tokens 1024 --mode both --scenario stress`
  - No duplication symptoms observed in these small runs.

Next
- Run higher trial counts (100–500) and/or craft a scenario closer to historical sessions (multi-turn, tool-results, long context).
- If any trial hits, inspect `raw-trial-*.json` to confirm whether duplication exists in the raw stream (upstream) vs only in mu output (parser).

## 2026-02-03 (later)

- Added historical-session replay script: `tmp/kimi-synth-replay-from-session.mjs`
  - Reads a session JSONL and auto-detects an assistant message that looks like the failure.
  - Replays the conversation up to just before that assistant message.
  - Runs either mu (`streamSimple`) and/or raw (`@anthropic-ai/sdk`) against the synthetic Anthropic endpoint.

- Verified on two historical sessions:
  - `~/.mu/agent/sessions/.../2026-01-29T09-57-55-601Z_5567a61a-a4da-4e57-9278-f732308c7d09.jsonl`
    - Failure message contained duplicated thinking/text and unstructured tool-call tokens.
    - Replay did **not** reproduce duplication.
  - `~/.mu/agent/sessions/.../2026-02-03T06-06-03-628Z_bf1b558c-abe6-4119-b8eb-332beea03440.jsonl`
    - Failure message contained duplicated thinking/text.
    - Replay did **not** reproduce duplication.

