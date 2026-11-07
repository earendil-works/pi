# Phase 0 Recon — Orchestra (Pi fork)

Date: 2026-11-07. Fork: `pi-self-recursive` (pi-mono, TS). Read before write.

## 1. Architecture map (existing Pi)

```
packages/
  agent/         pi-agent-core: Agent, agentLoop, AgentLoopConfig (beforeToolCall,
                 afterToolCall, finishTurn, prepareRequest/NextTurn,
                 getSteeringMessages/getFollowUpMessages), AgentEvent stream,
                 ToolExecutionMode, AgentTool.execute
  ai/            pi-ai: Model, Models.streamSimple, providers, usage, images,
                 client identity. ModelRuntime resolves auth.
  coding-agent/  pi-coding-agent: AgentSession (persistence, compaction, retry,
                 extension wiring, tool hooks), SessionManager (JSONL tree),
                 RPC mode, CLI, system prompt, tools (read/bash/edit/write/grep/find/ls),
                 ExtensionRunner, ResourceLoader
    src/modes/rpc/ rpc-mode, rpc-types, jsonl, rpc-client (JSONL stdin/stdout)
    src/core/extensions/ types, loader, runner, wrapper
    src/extensions/ builtins: codemode, tool-search, mcp, llama
    src/core/tools/ built-in tool definitions
    examples/extensions/ permission-gate (block), subagent (spawn pi processes),
      tool-override, protected-paths, handoff, plan-mode, …
  durable/       pi-durable: Harness (SessionImpl + TaskScheduler + Submissions +
                 InboxDoc + UsageDoc + TaskGraph), storage (sqlite/jsonl/memory/indexeddb),
                 tools, codemode. In-process task/conversation runtime.
  mcp/           pi-mcp: standalone MCP client (stdio/HTTP, tool registry)
  tui/           pi-tui: TUI library, differential rendering
  chord/         Chord runtime (substrate for durable)
  codemode/, telemetry/, schema/, env/, evals/
apps/p2/         web app (outside root check)
```

Key data flows:

- **Agent loop** (`agent-loop.ts`): `runLoop` polls `getSteeringMessages()` after each turn and `getFollowUpMessages()` when idle. `beforeToolCall` can return `{block:true}` → error tool result without executing (verified in `prepareToolCall`). `afterToolCall` can replace content/details/isError/usage. `finishTurn` can `{action:"continue"|"end"}`.
- **Agent wrapper** (`agent.ts`): `Agent.prompt/continue/steer/followUp/abort/waitForIdle`, `PendingMessageQueue` (all | one-at-a-time), `subscribe(event, signal)` awaiting listeners in order, `agent_end` emitted before `finishRun()`.
- **Session** (`agent-session.ts`): bridges `Agent` ↔ `SessionManager` ↔ `ExtensionRunner`. `_beforeToolCall` → `runner.emitToolCall({type:"tool_call"})`, `_afterToolCall` → `emitToolResult` + image normalization, `turn_end`/`agent_before_settle` boundary drafts, `agent_settled` after idle. `prompt()` with `streamingBehavior: "steer"|"followUp"` queues while streaming; `steer()/followUp()` enqueue `AgentMessage` + track display strings in `_steeringMessages/_followUpMessages`.
- **RPC** (`rpc-mode.ts` + `rpc-types.ts` + `rpc-entry.ts`): `pi --mode rpc` (bin `pi`, entry `rpc-entry.ts` → `main(["--mode","rpc",...])`). JSONL commands `prompt/steer/follow_up/abort/clear_queue/get_state/set_model/get_available_models/set_thinking_level/set_steering_mode/set_follow_up_mode/compact/bash/get_session_stats/export_html/switch_session/fork/clone/get_fork_messages/get_entries/get_tree/get_last_assistant_text/set_session_name/get_messages/get_commands`. Responses `{type:"response",command,success,data/error}`; events = `toJsonEvent(AgentSessionEvent)` streamed. Extension UI via `extension_ui_request/response`. Stdin `end` / SIGTERM/SIGHUP → `shutdown()` → `runtimeHost.dispose()`. Backpressure via `waitForRawStdoutBackpressure`.
- **Session persistence** (`session-manager.ts`): append-only JSONL, `SessionHeader{id,version3,cwd,parentSession}`, entries `message/thinking_level_change/model_change/usage/compaction/branch_summary/custom/custom_message/context_edit/label/session_info` with `id/parentId` tree, `leafId`, `buildSessionProjection/ Context`, branching via `branch()`, resume via `SessionManager.open/forkFrom/continueRecent/list`. File created on first user/assistant message. `sessionFile`/`sessionId` stable across process restart.
- **Extensions** (`extensions/types.ts`, `runner.ts`, `loader.ts`, `resource-loader.ts`): `pi.on(event,handler)`, `pi.registerTool(ToolDefinition)`, commands/flags/shortcuts, `registerMcpServer()`, provider registration (`registerProvider/registerNativeProvider/registerVirtualModel`). Events: `tool_call` (mutable input, `{block:true}` stops, `reachesTools` waits for MCP), `tool_result`, `context/context_with_system`, `before_provider_request/headers`, `before_agent_start` (systemPromptOptions), `agent_start/agent_end/agent_before_settle/agent_settled`, `turn_start/turn_end`, `input` (continue/transform/handled), `session_*`, `mcp_servers_change`, `user_bash`. CLI `-e/--extension <path>` (file or `builtin:<name>`), `--no-extensions`, `--append-system-prompt`, `--system-prompt`, `--tools/-xe`, `--session-dir`, `--model`, `--thinking`. Builtins `extensions/index.ts`: llama, codemode (replaceable), tool-search (replaceable), mcp (replaceable).
- **MCP** (`extensions/mcp/index.ts`, `mcp` pkg): built-in extension connects `mcp.json` + registered servers on `session_start`, registers `mcp__<server>__<tool>` with exposure `codemode|deferred|direct|hidden` (`codemode` default), resource tools, `/mcp` manager. Calls go through tool pipeline (hooks apply).
- **Tools**: built-ins via `createAllToolDefinitions()` (read/bash/edit/write/grep/find/ls/powershell), custom via `defineTool()`/`ToolDefinition` (TypeBox `parameters`, `execute(id,params,signal,onUpdate,ctx)`, `renderCall/renderResult`, `exposure`, `executionMode`). `executeTool()` for nested calls (codemode pattern).
- **Provider**: `pi-ai` `Models` (`streamSimple`), `ModelRuntime` (auth, catalog refresh, `getApiKeyForProvider`), `createAgentSession({model, thinkingLevel, customTools, resourceLoader, sessionManager, settingsManager})` in `sdk.ts` (used by `main.ts` → `createAgentSessionRuntime` → mode). Per-process model, runtime `set_model` in RPC, virtual models possible. `before_provider_request` can replace payload.
- **Durable Harness**: alternative in-process multi-conversation runtime. Provides restart reconciliation (`openTasks`), task ownership, submissions with requestId dedupe, inbox, usage. Not needed for process/worktree ownership; supervisor uses same ideas (sole-writer, idempotent IDs) without adopting its storage.
- **Images**: `pi-ai` provider images, `pi-tui` terminal-image, `durable` image processor (jpg/png/gif/webp + EXIF + sharp/photon). Tool results support `ImageContent`. No screenshot service exists; `apps/p2` has browser tests (`CHROMIUM_BIN`) but no CDP daemon.

## 2. Extension points chosen (native, minimal core edits)

| Concern | Native point | File / flag |
|---|---|---|
| Identity + roster | `before_agent_start` prompt sections + `session_start` + `getSystemPrompt()` | `system-prompt.ts` |
| Edit guard (lease) | `pi.on("tool_call")` for `edit/write/bash` returning `{block:true,reason}` | `extensions/runner.ts` `emitToolCall` |
| Messaging tools | `pi.registerTool({name:"send_message"|"read_inbox"|"reply"|"spawn"})` | `ToolDefinition` |
| Live delivery | RPC `steer` / `follow_up` commands (already polls `Agent` queues) | `modes/rpc/rpc-types.ts` |
| Goal loop | Supervisor awaits `agent_end`/`agent_settled` (RPC events), runs checks in worktree, re-prompts via `prompt` | `AgentSessionEvent` |
| Budget | Supervisor counts `message_end` usage + wall-clock + `turn_end`; `abort` command | `usage-totals.ts` |
| Session resume | `--session <file>` or RPC `switch_session` | `main.ts` `createSessionManager` |
| Extension loading | `-e <abs path to agent-ext dist/index.js>` at spawn; `--append-system-prompt <temp>` for identity (subagent pattern) | `cli/args.ts` |
| MCP (shotd) | Native: add to `mcp.json` `{shotd:{command,args}}` or `--extension` that registers server; exposure `direct` for shot tools | `extensions/mcp/config.ts` |
| Fake LR provider | `virtualModels`/`registerNativeProvider` optional; tests use `Agent` + fake `StreamFn` directly (no provider registration needed) | `agent-core` `StreamFn` |
| Status view | `orchestra-cli` reads SQLite (read-only) | new pkg, no TUI change |

Core edits intended: **none**. All new code in `packages/orchestra-*/`, `packages/shotd/`, `packages/orchestra-mcp/`? (shotd itself is MCP server). One-line justification requirement satisfied (no core touch).

## 3. Verified-vs-assumed

| Hypothesis (architecture.md) | Verdict | Evidence |
|---|---|---|
| (a) RPC accepts steer/follow-up into running agent | **VERIFIED YES** | RPC cmds `steer`/`follow_up` (`rpc-mode.ts:437-445` → `session.steer/followUp` → `agent.steer/followUp` → `AgentLoopConfig.getSteeringMessages/getFollowUpMessages` polled each turn, between tool calls). `prompt` also accepts `streamingBehavior`. Events stream as JSONL. |
| (b) Extensions intercept/block tool call pre-exec | **VERIFIED YES** | `AgentLoopConfig.beforeToolCall` → `{block:true}` (`agent-loop.ts:prepareToolCall`); `AgentSession._beforeToolCall` → `ExtensionRunner.emitToolCall` with mutable `input`; `permission-gate.ts` blocks `bash`; `tool_call` result `{block,reason}` documented in `types.ts:1266-1276`. `tool_result` can mutate after. |
| (c) Agent-end hook usable for goal loops | **VERIFIED YES** | `agent_end`, `agent_before_settle:{entries,continue,context}`, `agent_settled:{aborted}`, `turn_end:{continue}` (`types.ts:1049-1093`). Supervisor can also do external loop without hook (wait `agent_end` → checks → `prompt` failure report). |
| (d) MCP native vs wrapped | **VERIFIED NATIVE** | Built-in MCP extension (`extensions/mcp/index.ts`) + `pi-mcp` client. Servers from `mcp.json` + `pi.registerMcpServer()`. Tools via pipeline (`mcp__*`), so guard sees them. No extension-tool wrapper needed; shotd = plain MCP stdio server. |
| Extension loading + RPC startup flags | **VERIFIED** | `--mode rpc`, `--session/--session-dir`, `--extension/-e`, `--append-system-prompt`, `--model`, `--tools`, `--no-mcp` (`cli/args.ts`, `main.ts`, `rpc-entry.ts`). |
| Session resume after restart | **VERIFIED** | JSONL `SessionManager.open/forkFrom`, `--session/--resume/--continue`, RPC `switch_session/fork/clone`. |
| Per-role provider/model | **VERIFIED** | `createAgentSession({model})`, `ModelRuntime`, RPC `set_model/get_available_models`. |
| SQLite WAL in Node | **VERIFIED AVAILABLE** | Node v26.4.0, `node:sqlite` present. `durable` already ships sqlite storage. Supervisor uses `node:sqlite` + `PRAGMA journal_mode=WAL` (no new dep). |
| Chromium/WebP for shotd | **PARTIAL** | Chrome app present (`/Applications/Google Chrome.app`), no playwright/puppeteer in lockfile; `sharp` present for WebP encode. `Page.captureScreenshot` format is jpeg/png — encode WebP via `sharp`. CDP via raw WebSocket (`WebSocket` global). 1920×1080 DSF=2 → 3840×2160 (never change layout viewport). |
| Image limits 2576/1568 px | **ASSUMED, confirm per model** | `pi-ai` models carry `inputLimits.images.resize`. Default conservative `maxLongEdge=1568`, configurable per model. |

False/changed assumptions:
- **Unix socket IPC → localhost HTTP.** Pi extensions can `fetch()` (Node 22). Supervisor listens `127.0.0.1:<port>` persisted in DB/env (`ORCHESTRA_SUPERVISOR_URL`). Simpler, cross-platform, same request/response semantics. RPC JSONL still carries control/events; HTTP carries extension-tool calls (message/lease/spawn). Dedupe/acks unchanged.
- **"Done means checks pass" + guard composition.** `turn_end continue` exists but supervisor (not model) runs checks and sends follow-up; agent's `done` claim is logged as a message, never a state transition.
- **Durable Harness not adopted as storage.** Its `sqlite`/document model is conversation-centric; supervisor needs relational leases/messages/checks. Use plain `node:sqlite` tables (same durability idea, simpler). Reuse patterns (sole-writer, ULID/message IDs, restart reconcile), not the code.

## 4. Chosen design (Pi-native iteration)

```
orchestra-cli ──► supervisor daemon (Node, TS, ESM)
                    │  node:sqlite WAL (sole writer)
                    │  ├─ HTTP 127.0.0.1 (extension-tool transport)
                    │  ├─ RPC stdio JSONL ◄──► pi --mode rpc (per agent, worktree cwd)
                    │  └─ MCP stdio ──► shotd (1 Chromium, N contexts, CDP)
                    │       ▲
                    │       │ -e agent-ext dist/index.js + identity via
                    │       │   --append-system-prompt (temp) + env ORCHESTRA_*
                    │       │
                    └───────┴── agent-ext: tool_call guard + send_message/read_inbox/reply/spawn
```

Packages (all new, no core edit):
- `packages/orchestra-core` — types, ULID, schema/migrations (node:sqlite), IPC DTOs, fake `StreamFn` + `FakeModel` for tests, port allocator, signature hash.
- `packages/orchestra-supervisor` — daemon, `Store` (sole writer), `RpcAgentRunner` (spawn pi RPC, parse events, steer/followUp/abort) + `InMemoryAgentRunner` (Agent + fake provider, tests), reconciler (2s loop), lease manager, message bus (deliveries + acks), goal engine + check runner (cmd/screenshot_diff/dom_assert), budget governor, integrator, proxy-me (optional LLM call via pi-ai on escalation only).
- `packages/orchestra-agent-ext` — Pi extension (TS, built to `dist`, loaded with `-e`). On `tool_call` asks supervisor `canEdit(agent,path)`; on `before_agent_start` injects identity/roster; registers tools.
- `packages/orchestra-cli` — `orchestra up|down|status|goal|spawn|send|escalations` (bin `orchestra`).
- `packages/shotd` — MCP stdio server (`shot`, `zoom`, `dom_metrics`, `baseline_save`, `baseline_diff`, `close_context`), CDP browser manager, WebP via `sharp`, content-addressed store, model-view resizer (`CDP clip.scale` when possible else `sharp.resize`).
- `docs/ORCHESTRATION.md`, `docs/DEVIATIONS.md` (filled after S0).

State machines mirror §5 (agents/tasks/deliveries/leases). Messages typed (`handoff/blocked/question/answer/info/done`). Leases non-blocking, reads always allowed. Budgets (turns/tokens/wall-clock/depth/children) enforced in supervisor from events, not prompts. Stall signature = `sha256(check_id + normalize(output))`, N=3 → escalate.

Build order S1→S10 per §12; shotd parallel. Tests use fake provider (no spend); one real smoke only if keys exist (explicitly skipped otherwise). Chaos/E2E in S10.

