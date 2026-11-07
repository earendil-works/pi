# DEVIATIONS — Orchestra (from architecture.md)

## S0 verified (2026-11-07, see docs/RECON.md)

| # | Architecture.md assumption | Reality in fork | Deviation |
|---|---|---|---|
| D1 | RPC steer/follow-up queueing | Exists natively (`prompt/streamingBehavior`, `steer`, `follow_up`, `abort`) | Use RPC push at safe points (Agent queues drain between tool calls). Pull fallback (extension polls inbox on `before_agent_start`/`context`) kept only if a delivery is missed; reconciler redelivers. |
| D2 | Extensions can block tool calls | `tool_call` → `{block:true,reason}`; `Agent.beforeToolCall` block | Guard = `tool_call` handler asking supervisor over HTTP. No core edit. |
| D3 | Agent-end hook for goal loops | `agent_end`/`agent_before_settle`/`agent_settled`/`turn_end` + `finishTurn` | Goal loop external to agent (supervisor runs checks, re-prompts). Hooks not required; supervisor observes events via RPC. |
| D4 | MCP must be wrapped as extension tool if not native | MCP is native (built-in extension + `pi-mcp` client) | `shotd` is a plain MCP stdio server, added to `mcp.json`. Optional `direct` exposure; no wrapper extension needed. |
| D5 | Unix socket for agent→supervisor IPC | Pi extensions can `fetch()` localhost | Use `http://127.0.0.1:<port>` (stored in DB, injected via `ORCHESTRA_SUPERVISOR_URL`). RPC JSONL still carries agent events/control. |
| D6 | Session resume from file | JSONL tree, `--session`/`switch_session` | Store `session_file` + `sessionId` per agent; restart reopens same file. |
| D7 | Per-role provider/model | `createAgentSession({model})` + RPC `set_model` | Worker model and `proxy-me` model configured separately in supervisor config; no new provider code. |
| D8 | SQLite WAL + JSONL | Node v26 `node:sqlite` available; sessions are already JSONL | Supervisor uses `node:sqlite` (`PRAGMA journal_mode=WAL, synchronous=NORMAL`) + Pi session JSONL. No Redis/Kafka/better-sqlite3 dep. |
| D9 | shotd WebP via CDP | `Page.captureScreenshot` emits jpeg/png | Capture PNG → `sharp` → WebP (quality/lossless). Model view via CDP `clip.scale` or `sharp` resize. |
| D10 | Image long-edge 2576/1568 | Per-model `inputLimits.images.resize` | Default `maxLongEdge=1568`; per-model override map. Never return oversized image. |

## S1–S10 notes
- Filled as stages complete. See `docs/ORCHESTRATION.md` for how to run.
