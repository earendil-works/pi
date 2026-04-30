# Changelog

## [Unreleased]

## [0.70.6] - 2026-04-28

## [0.70.5] - 2026-04-27

## [0.70.4] - 2026-04-27

## [0.70.3] - 2026-04-27

## [0.70.2] - 2026-04-24

## [0.70.1] - 2026-04-24

## [0.70.0] - 2026-04-23

## [0.69.0] - 2026-04-22

### Breaking Changes

- Migrated public TypeBox-facing types and examples from `@sinclair/typebox` 0.34.x to `typebox` 1.x. Install and import from `typebox` instead of relying on `@sinclair/typebox` transitively ([#3112](https://github.com/badlogic/pi-mono/issues/3112))

### Added

- Added `terminate: true` tool-result hints to skip the automatic follow-up LLM call when every finalized tool result in the current batch opts into early termination ([#3525](https://github.com/badlogic/pi-mono/issues/3525))

## [0.68.1] - 2026-04-22

### Fixed

- Fixed `streamProxy()` to preserve the proxy-safe serializable subset of stream options, including session, transport, retry-delay, metadata, header, cache-retention, and thinking-budget settings ([#3512](https://github.com/badlogic/pi-mono/issues/3512))
- Fixed parallel tool execution to emit `tool_execution_end` as soon as each tool is finalized, while still emitting persisted tool-result messages in assistant source order ([#3503](https://github.com/badlogic/pi-mono/issues/3503))

## [0.68.0] - 2026-04-20

### Changed

- Clarified parallel tool execution ordering docs to specify that final tool lifecycle and tool-result artifacts are emitted in tool completion order.

## [0.67.68] - 2026-04-17

## [0.67.67] - 2026-04-17

### Fixed

- Fixed parallel tool-call finalization to convert `afterToolCall` hook throws into error tool results instead of aborting the batch ([#3084](https://github.com/badlogic/pi-mono/issues/3084))

## [0.67.6] - 2026-04-16

## [0.67.5] - 2026-04-16

## [0.67.4] - 2026-04-16

## [0.67.3] - 2026-04-15

## [0.67.2] - 2026-04-14

## [0.67.1] - 2026-04-13

## [0.67.0] - 2026-04-13

## [0.66.1] - 2026-04-08

## [0.66.0] - 2026-04-08

## [0.65.2] - 2026-04-06

## [0.65.1] - 2026-04-05

## [0.65.0] - 2026-04-03

### Breaking Changes

- `AgentState` has been reshaped:
  - `streamMessage` was renamed to `streamingMessage`
  - `error` was renamed to `errorMessage`
  - `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage` are now readonly in the public API
  - `pendingToolCalls` is now typed as `ReadonlySet<string>`
  - `tools` and `messages` are now accessor properties, and assigning either field copies the provided top-level array instead of preserving array identity
- `AgentOptions.initialState` no longer accepts runtime-owned fields. Remove `isStreaming`, `streamingMessage`, `pendingToolCalls`, and `errorMessage` from `initialState` values.
- Removed `Agent` mutator methods in favor of direct property access:
  - `agent.setSystemPrompt(value)` -> `agent.state.systemPrompt = value`
  - `agent.setModel(model)` -> `agent.state.model = model`
  - `agent.setThinkingLevel(level)` -> `agent.state.thinkingLevel = level`
  - `agent.setTools(tools)` -> `agent.state.tools = tools`
  - `agent.replaceMessages(messages)` -> `agent.state.messages = messages`
  - `agent.appendMessage(message)` -> `agent.state.messages.push(message)`
  - `agent.clearMessages()` -> `agent.state.messages = []`
  - `agent.setToolExecution(mode)` -> `agent.toolExecution = mode`
  - `agent.setBeforeToolCall(fn)` -> `agent.beforeToolCall = fn`
  - `agent.setAfterToolCall(fn)` -> `agent.afterToolCall = fn`
  - `agent.setTransport(transport)` -> `agent.transport = transport`
- Removed queue mode getter/setter methods in favor of properties:
  - `agent.setSteeringMode(mode)` -> `agent.steeringMode = mode`
  - `agent.getSteeringMode()` -> `agent.steeringMode`
  - `agent.setFollowUpMode(mode)` -> `agent.followUpMode = mode`
  - `agent.getFollowUpMode()` -> `agent.followUpMode`
- `Agent.subscribe()` listeners are now awaited and receive the active `AbortSignal`:
  - `agent.subscribe((event) => { ... })` -> `agent.subscribe(async (event, signal) => { ... })`
  - `agent_end` is now the final emitted event for a run, but not the idle boundary
  - `agent.waitForIdle()`, `agent.prompt(...)`, and `agent.continue()` now settle only after awaited `agent_end` listeners finish
  - `agent.state.isStreaming` remains `true` until that settlement completes

## [0.64.0] - 2026-03-29

### Added

- Added `AgentTool.prepareArguments` hook to prepare raw tool call arguments before schema validation, enabling compatibility shims for resumed sessions with outdated tool schemas

## [0.63.2] - 2026-03-29

### Added

- Added `Agent.signal` to expose the active abort signal for the current turn, allowing callers to forward cancellation into nested async work ([#2660](https://github.com/badlogic/pi-mono/issues/2660))

## [0.63.1] - 2026-03-27

## [0.63.0] - 2026-03-27

## [0.62.0] - 2026-03-23

## [0.61.1] - 2026-03-20

## [0.61.0] - 2026-03-20

## [0.60.0] - 2026-03-18

## [0.59.0] - 2026-03-17

## [0.58.4] - 2026-03-16

### Fixed

- Fixed steering messages to wait until the current assistant message's tool-call batch fully finishes instead of skipping pending tool calls.

## [0.58.3] - 2026-03-15

## [0.58.2] - 2026-03-15

## [0.58.1] - 2026-03-14

## [0.58.0] - 2026-03-14

### Added

- Added `beforeToolCall` and `afterToolCall` hooks to `AgentOptions` and `AgentLoopConfig` for preflight blocking and post-execution tool result mutation.

### Changed

- Added configurable tool execution mode to `Agent` and `agentLoop` via `toolExecution: "parallel" | "sequential"`, with `parallel` as the default. Parallel mode preflights tool calls sequentially, executes allowed tools concurrently, and emits final tool results in assistant source order.

## [0.57.1] - 2026-03-07

## [0.57.0] - 2026-03-07

## [0.56.3] - 2026-03-06

## [0.56.2] - 2026-03-05

## [0.56.1] - 2026-03-05

## [0.56.0] - 2026-03-04

## [0.55.4] - 2026-03-02

## [0.55.3] - 2026-02-27

## [0.55.2] - 2026-02-27

## [0.55.1] - 2026-02-26

## [0.55.0] - 2026-02-24

## [0.54.2] - 2026-02-23

## [0.54.1] - 2026-02-22

## [0.54.0] - 2026-02-19

## [0.53.1] - 2026-02-19

## [0.53.0] - 2026-02-17

## [0.52.12] - 2026-02-13

### Added

- Added `transport` to `AgentOptions` and `AgentLoopConfig` forwarding, allowing stream transport preference (`"sse"`, `"websocket"`, `"auto"`) to flow into provider calls.

## [0.52.11] - 2026-02-13

## [0.52.10] - 2026-02-12

## [0.52.9] - 2026-02-08

## [0.52.8] - 2026-02-07

## [0.52.7] - 2026-02-06

### Fixed

- Fixed `continue()` to resume queued steering/follow-up messages when context currently ends in an assistant message, and preserved one-at-a-time steering ordering during assistant-tail resumes ([#1312](https://github.com/badlogic/pi-mono/pull/1312) by [@ferologics](https://github.com/ferologics))

## [0.52.6] - 2026-02-05

## [0.52.5] - 2026-02-05

## [0.52.4] - 2026-02-05

## [0.52.3] - 2026-02-05

## [0.52.2] - 2026-02-05

## [0.52.1] - 2026-02-05

## [0.52.0] - 2026-02-05

## [0.51.6] - 2026-02-04

## [0.51.5] - 2026-02-04

## [0.51.4] - 2026-02-03

## [0.51.3] - 2026-02-03

## [0.51.2] - 2026-02-03

## [0.51.1] - 2026-02-02

## [0.51.0] - 2026-02-01

## [0.50.9] - 2026-02-01

## [0.50.8] - 2026-02-01

### Added

- Added `maxRetryDelayMs` option to `AgentOptions` to cap server-requested retry delays. Passed through to the underlying stream function. ([#1123](https://github.com/badlogic/pi-mono/issues/1123))

## [0.50.7] - 2026-01-31

## [0.50.6] - 2026-01-30

## [0.50.5] - 2026-01-30

## [0.50.3] - 2026-01-29

## [0.50.2] - 2026-01-29

## [0.50.1] - 2026-01-26

## [0.50.0] - 2026-01-26

## [0.49.3] - 2026-01-22

## [0.49.2] - 2026-01-19

## [0.49.1] - 2026-01-18

## [0.49.0] - 2026-01-17

## [0.48.0] - 2026-01-16

## [0.47.0] - 2026-01-16

## [0.46.0] - 2026-01-15

## [0.45.7] - 2026-01-13

## [0.45.6] - 2026-01-13

## [0.45.5] - 2026-01-13

## [0.45.4] - 2026-01-13

## [0.45.3] - 2026-01-13

## [0.45.2] - 2026-01-13

## [0.45.1] - 2026-01-13

## [0.45.0] - 2026-01-13

## [0.44.0] - 2026-01-12

## [0.43.0] - 2026-01-11

## [0.42.5] - 2026-01-11

## [0.42.4] - 2026-01-10

## [0.42.3] - 2026-01-10

## [0.42.2] - 2026-01-10

## [0.42.1] - 2026-01-09

## [0.42.0] - 2026-01-09

## [0.41.0] - 2026-01-09

## [0.40.1] - 2026-01-09

## [0.40.0] - 2026-01-08

## [0.39.1] - 2026-01-08

## [0.39.0] - 2026-01-08

## [0.38.0] - 2026-01-08

### Added

- `thinkingBudgets` option on `Agent` and `AgentOptions` to customize token budgets per thinking level ([#529](https://github.com/badlogic/pi-mono/pull/529) by [@melihmucuk](https://github.com/melihmucuk))

## [0.37.8] - 2026-01-07

## [0.37.7] - 2026-01-07

## [0.37.6] - 2026-01-06

## [0.37.5] - 2026-01-06

## [0.37.4] - 2026-01-06

## [0.37.3] - 2026-01-06

### Added

- `sessionId` option on `Agent` to forward session identifiers to LLM providers for session-based caching.

## [0.37.2] - 2026-01-05

## [0.37.1] - 2026-01-05

## [0.37.0] - 2026-01-05

### Fixed

- `minimal` thinking level now maps to `minimal` reasoning effort instead of being treated as `low`.

## [0.36.0] - 2026-01-05

## [0.35.0] - 2026-01-05

## [0.34.2] - 2026-01-04

## [0.34.1] - 2026-01-04

## [0.34.0] - 2026-01-04

## [0.33.0] - 2026-01-04

## [0.32.3] - 2026-01-03

## [0.32.2] - 2026-01-03

## [0.32.1] - 2026-01-03

## [0.32.0] - 2026-01-03

### Breaking Changes

- **Queue API replaced with steer/followUp**: The `queueMessage()` method has been split into two methods with different delivery semantics ([#403](https://github.com/badlogic/pi-mono/issues/403)):
  - `steer(msg)`: Interrupts the agent mid-run. Delivered after current tool execution, skips remaining tools.
  - `followUp(msg)`: Waits until the agent finishes. Delivered only when there are no more tool calls or steering messages.
- **Queue mode renamed**: `queueMode` option renamed to `steeringMode`. Added new `followUpMode` option. Both control whether messages are delivered one-at-a-time or all at once.
- **AgentLoopConfig callbacks renamed**: `getQueuedMessages` split into `getSteeringMessages` and `getFollowUpMessages`.
- **Agent methods renamed**:
  - `queueMessage()` → `steer()` and `followUp()`
  - `clearMessageQueue()` → `clearSteeringQueue()`, `clearFollowUpQueue()`, `clearAllQueues()`
  - `setQueueMode()`/`getQueueMode()` → `setSteeringMode()`/`getSteeringMode()` and `setFollowUpMode()`/`getFollowUpMode()`

### Fixed

- `prompt()` and `continue()` now throw if called while the agent is already streaming, preventing race conditions and corrupted state. Use `steer()` or `followUp()` to queue messages during streaming, or `await` the previous call.

## [0.31.1] - 2026-01-02

## [0.31.0] - 2026-01-02

### Breaking Changes

- **Transport abstraction removed**: `ProviderTransport`, `AppTransport`, and `AgentTransport` interface have been removed. Use the `streamFn` option directly for custom streaming implementations.

- **Agent options renamed**:
  - `transport` → removed (use `streamFn` instead)
  - `messageTransformer` → `convertToLlm`
  - `preprocessor` → `transformContext`

- **`AppMessage` renamed to `AgentMessage`**: All references to `AppMessage` have been renamed to `AgentMessage` for consistency.

- **`CustomMessages` renamed to `CustomAgentMessages`**: The declaration merging interface has been renamed.

- **`UserMessageWithAttachments` and `Attachment` types removed**: Attachment handling is now the responsibility of the `convertToLlm` function.

- **Agent loop moved from `@mariozechner/pi-ai`**: The `agentLoop`, `agentLoopContinue`, and related types have moved to this package. Import from `@mariozechner/pi-agent-core` instead.

### Added

- `streamFn` option on `Agent` for custom stream implementations. Default uses `streamSimple` from pi-ai.

- `streamProxy()` utility function for browser apps that need to proxy LLM calls through a backend server. Replaces the removed `AppTransport`.

- `getApiKey` option for dynamic API key resolution (useful for expiring OAuth tokens like GitHub Copilot).

- `agentLoop()` and `agentLoopContinue()` low-level functions for running the agent loop without the `Agent` class wrapper.

- New exported types: `AgentLoopConfig`, `AgentContext`, `AgentTool`, `AgentToolResult`, `AgentToolUpdateCallback`, `StreamFn`.

### Changed

- `Agent` constructor now has all options optional (empty options use defaults).

- `queueMessage()` is now synchronous (no longer returns a Promise).
