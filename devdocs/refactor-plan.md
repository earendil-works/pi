# Refactor Plan: Ports/Adapters + Extension Runtime for Mu

This document proposes a concrete, incremental refactor to give **mu** an extension/plugin system similar in spirit to `~/work/pi-mono-upstream`, while staying aligned with our **Core Library Design (v2)** principles:

- keep a **small stable core**
- push churn (providers/tools/UI) into **adapters/extensions**
- make behavior **observable** via an event stream + durable history
- keep configuration **layered and explainable**

The plan is structured as vertical slices you can ship one-by-one.

---

## 0) Ground truth: where we are today (verified)

### Stable core we already have

**(A) `@kennyfrc/mu-ai`**
- Defines the provider-agnostic message contract (`Message`, `ToolCall`, `ToolResultMessage`).
- Implements `agentLoop()` that emits an **event stream** (`AgentEvent`) and executes tools.

**(B) `@kennyfrc/mu-agent-core`**
- Wraps `mu-ai` with long-lived `AgentState` + queue semantics.
- Provides a clean port boundary: `AgentTransport`.

**(C) `@kennyfrc/mu-coding-agent`**
- Host app: tool set, CLI modes, TUI renderer.
- Sessions are persisted as **linear JSONL** `type:"message"` entries.
- `/branch` creates a **new session file** with copied message prefix (not an in-file tree).

### Existing hook points (limited but real)

Today we can already intercept some boundaries:
- **Context boundary (coarse):** `AgentOptions.messageTransformer(messages: AppMessage[]) -> Message[]`
- **Tool result boundary:** `toolResultTransformer(toolResult: ToolResultMessage) -> ToolResultMessage`
- **Tool boundary (steering):** `interrupt()` injection between tool results and continuation LLM call

What we do *not* have yet:
- registries with ownership (`sourceId`) and unload semantics
- a consistent extension event model (tool_call block/patch, context transforms per-turn)
- hot-reloadable extension loader and discovery
- session entry types for extension-owned persistent state (beyond “stuff in tool result details”)

---

## 1) Target architecture (what we’re migrating to)

### 1.1 The published language

We will treat these as the **compatibility surface**:

- **Messages:** the existing `mu-ai` message + content-block types.
- **Events:** the existing agent event stream (start/update/end, tool execution lifecycle).
- **Tools:** schema + execute + optional resource key (already exists).
- **Extension hooks:** a small, versioned set of hook names with explicit composition semantics.

Importantly: **extensions are not discovered by core**. Discovery/installation stays a host concern.

### 1.2 Where extensions live

Recommended: implement the extension runtime primarily in **`@kennyfrc/mu-coding-agent` (host)**.

Rationale:
- UI churn is expected; UI extension points should be host-owned.
- Session persistence is host-owned.
- We can still extract a portable subset later (tool hooks / context hooks) if multiple hosts need it.

### 1.3 Registries (with ownership)

We will introduce registries that support:
- `sourceId` attribution for every registration (path of extension file, plus optional stable ID)
- override rules (documented: last-write-wins vs priority)
- unloading: `unregisterBySourceId(sourceId)`

Minimum registries:
- **ToolRegistry** (LLM-callable tools)
- **CommandRegistry** (slash commands)
- **ProviderRegistry** (models/providers, overrides)

### 1.4 Hook points + composition semantics

We will standardize a small set of extension hooks:

| Hook | Purpose | Semantics |
|---|---|---|
| `context` | Transform/prune/inject messages before each LLM call | Transform chain, in registration order |
| `before_tool_call` | Observe/modify/block a tool call | Block: first block wins; Transform: chain |
| `after_tool_result` | Patch tool result before it’s appended/sent back | Patch chain; default merge = last-write-wins |
| `input` | Transform or handle user input before submission | Transform chain; handled short-circuits |
| `session_*` | Reconstruct extension state on session events | Best-effort; errors isolated |

Notes:
- We already have an event-driven core; these hooks are the *extension-facing* interception layer.
- All hooks must be **fail-contained**: an extension error must not crash the host.

### 1.5 History/observability tier

We will commit to **Tier 0 (trace) immediately**, and design for **Tier 1 (resumable log)**.

- Tier 0: event stream + current linear message JSONL is good enough for observability.
- Tier 1: add explicit “custom entry” types so extensions can persist state durably and reconstruct it.

Decision checkpoint (see Phase 6):
- keep “branch = new file” (simpler), or
- migrate to an in-file session tree (`id`/`parentId`) like upstream (more powerful time travel).

---

## 2) Migration plan (vertical slices)

Each phase is shippable and should include at least one “real usage” example extension.

### Phase 0 — Decide the minimum stable core + invariants (1–2 days)

Deliverables:
- A short list of invariants we will unit test (no network/fs):
  - tool execution ordering guarantees
  - resource-key serialization behavior
  - hook composition rules (ordering, block/patch semantics)

Work:
- Document the *published language* (hook names + semantics) in `packages/coding-agent/docs/extensions.md` (new).
- Add a single “contract test” that asserts hook ordering semantics.

Verification:
- `npm test -w @kennyfrc/mu-ai`
- `npm test -w @kennyfrc/mu-agent-core`

---

### Phase 1 — Tool registry + tool interception (no loader yet)

Goal:
Enable extensions *in-process* (factory functions) to:
- register tools
- intercept tool calls/results (block/patch)

Design:
- Introduce an `ExtensionRunner` and `wrapToolWithExtensions()` similar to upstream.
- Integrate into `mu-coding-agent` tool selection by producing a final tool list:
  1) built-in tools
  2) tools registered by extensions
  3) wrapped tools (interception)

Key APIs (host-owned):
- `registerTool(toolDef, { sourceId })`
- hook handlers: `before_tool_call`, `after_tool_result`

Key files (new, suggested):
- `packages/coding-agent/src/extensions/types.ts`
- `packages/coding-agent/src/extensions/runner.ts`
- `packages/coding-agent/src/extensions/wrapper.ts`

Example:
- A `bash_guard` extension that blocks dangerous bash patterns.

Verification:
- Add unit tests: “block tool call prevents execution”, “tool_result patch applied”.

---

### Phase 2 — JIT loader + discovery + `/reload`

Goal:
Make tools/providers/UI changeable without rebuilding the host.

Design:
- Add a JIT extension loader (Node):
  - Use `jiti` with `moduleCache: false`.
  - Define discovery locations:
    - global: `~/.mu/agent/extensions/`
    - project: `./.mu/extensions/` (recommended because `.mu/` is already gitignored)
    - explicit CLI flags (optional)

Host behavior:
- On startup: discover + load extensions.
- Implement `/reload` to re-run discovery + load fresh modules.
- On reload: re-bind registries, rebuild active tool list, re-render UI.

Verification:
- Integration test that edits an extension file, triggers reload, and observes new tool behavior.

---

### Phase 3 — Context hook before *each* LLM call (not just at prompt start)

Goal:
Allow extensions to:
- prune messages
- inject context
- implement context-window policy

Design options (pick one):

**Option A (preferred): use `mu-ai AgentLoopConfig.preprocessor`**
- Implement `preprocessor(messages)` in the transport so it runs before every LLM call inside a multi-turn run.
- This mirrors upstream’s `context` event.

**Option B: re-run from host between turns**
- More invasive; not recommended.

Deliverables:
- `context` hook with transform chaining semantics.
- One extension implementing “context tail window” to prove it works.

Verification:
- Unit test: when extension prunes messages, the model sees fewer messages (assert via fake streamFn).

---

### Phase 4 — Commands + input pipeline (slash commands become extensible)

Goal:
Make UI/interaction surface changeable without hardcoding everything in `TuiRenderer`.

Deliverables:
- Command registry:
  - `registerCommand('/name', handler)`
  - conflict rules (built-ins win or extension wins; choose + document)
- Input hook:
  - `input` handlers can transform text, or mark it handled.

Integration plan:
- Refactor `TuiRenderer` input handling to:
  1) run `input` hook chain
  2) if handled, stop
  3) else dispatch command registry
  4) else send message to agent

Verification:
- Test: extension adds `/hello` and it executes.

---

### Phase 5 — Provider/model registry + extension-managed providers

Goal:
Providers change constantly; we want provider churn isolated.

Deliverables:
- Introduce a `ModelRegistry` (host-owned) similar to upstream:
  - loads built-in models
  - overlays `~/.mu/agent/models.json`
  - allows runtime `registerProvider(name, config)`
  - resolves API keys with provenance

Integration:
- Replace ad-hoc model loading in `model-config.ts` with a registry object.
- Expose to extensions via context: `ctx.modelRegistry.registerProvider(...)`.

Verification:
- Test: extension registers a provider + model and it becomes selectable.

---

### Phase 6 — History tier upgrade: extension state that survives reload + branching

Goal:
Support the upstream meta-pattern: **code is ephemeral, state is derived, history is permanent**.

Two viable approaches:

**Approach 1 (minimal): keep “branch = new session file”**
- Add new JSONL entry types alongside `type:"message"`:
  - `type:"custom"` (not sent to LLM)
  - `type:"custom_message"` (sent to LLM, optionally hidden in UI)
- Implement APIs:
  - `appendEntry(customType, data)`
  - `sendMessage(customType, content, details, display)`
- Extensions reconstruct state by scanning the current session file.

**Approach 2 (upstream parity): migrate to in-file session tree**
- Adopt `id`/`parentId` entries and branch navigation inside one file.
- Enables `/tree`, labels, compaction hooks, and much stronger time-travel workflows.

Recommendation:
- Do Approach 1 first (unblocks extension state reconstruction with minimal disruption).
- Schedule Approach 2 only if we want full upstream `/tree` + compaction ecosystem.

Verification:
- Example extension that stores durable state in `custom` entries and reconstructs correctly after `/reload`.

---

## 3) Verification/backpressure strategy

We’ll keep verification tight per phase:
- prefer unit/integration tests with fake stream functions (no network)
- avoid relying on real providers for correctness

Suggested command set per phase:
- `npm test -w @kennyfrc/mu-ai`
- `npm test -w @kennyfrc/mu-agent-core`
- `npm test -w @kennyfrc/mu-coding-agent`

(Do **not** run the root `npm run check` in development unless you intend Biome to rewrite files.)

---

## 4) Key design decisions (make early)

1) **Session history model**
- Keep new-file branching vs in-file tree.

2) **Extension discovery locations**
- Recommend: `~/.mu/agent/extensions/` and `./.mu/extensions/`.

3) **Override rules**
- Tools: last-write-wins vs explicit priority.
- Commands: built-ins win vs extension win.

4) **Failure policy**
- Hooks should be fail-open by default (log errors), with explicit “policy gate” hooks optionally fail-closed.

---

## 5) Mapping upstream concepts to mu (for orientation)

| Upstream concept | Mu equivalent today | Refactor target |
|---|---|---|
| `ExtensionRunner` | none | add runner in `mu-coding-agent` |
| `wrapToolWithExtensions` | none | wrap `AgentTool.execute` |
| `context` event | none (per-turn) | implement via `preprocessor` |
| tree session entries | new-file `/branch` | Phase 6 decision |
| hot reload via jiti | none | Phase 2 `/reload` |
| custom session entries | none | Phase 6 Approach 1 |

