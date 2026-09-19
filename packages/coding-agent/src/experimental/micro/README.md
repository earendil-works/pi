# micro

A small local coding agent built on the experimental Pico3 harness. Unlike `mini`, it has no server,
worker, RPC, or client/session process split. One process owns the model runtime, Pico harness, JSONL
storage, and TUI.

The boundary is still presentation-shaped: the TUI receives only a plain observable `MicroView` and
a narrow `MicroController`. It never receives the harness, conversation handle, model runtime, or
storage. Command failures and Pico events are folded into the view, so rendering has no event or
result side channel.

```bash
./node_modules/.bin/tsx --tsconfig tsconfig.json packages/coding-agent/src/experimental/micro/main.ts
./node_modules/.bin/tsx --tsconfig tsconfig.json packages/coding-agent/src/experimental/micro/main.ts --continue
```

New sessions default to `openai-codex/gpt-5.6-sol`. `--continue` keeps the session's stored model and
opens the newest session for the current working directory. Sessions live under
`~/.pi/agent/experimental/micro-sessions/<cwd-hash>/`. Each session is a Pico3 `JsonlStorage`
directory containing `main.jsonl` and its sticky/task sidecars. A filesystem lock prevents two
processes from owning one session concurrently.

## Commands

- ordinary submit: prompt while idle, steer while a turn is active
- configured follow-up key: queue a follow-up
- escape: abort the active turn and compaction
- `/compact`: start manual compaction
- `/model` or Ctrl+L: select a model
- Shift+Tab: cycle the current model's supported thinking levels
- `/login`: configure provider authentication
- configured clear key or Ctrl+D: exit while preserving durable work for `--continue`

The footer shows cumulative input/output/cache tokens, the latest cache-hit rate, total session cost,
and current context-window usage. After compaction, context usage remains unknown until the next model response.

Pico validates tool arguments before the mini-tool adapter runs. The edit tool therefore accepts its
canonical `edits` array shape but cannot apply mini's compatibility fixes to arguments that fail
Pico's initial schema validation.
