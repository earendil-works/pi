# Code Reading Map

This page is for the moment when the docs stop being enough and you want to understand how the repo actually runs.

The key idea is to read the code in the same order a request flows through the system: start at the CLI entry point, then move into session orchestration, then into the generic agent runtime, and only then into the lower-level LLM transport layer.

## Recommended reading order

### 1. `packages/coding-agent/src/cli.ts`

Start here if you want the narrowest possible entry point.

What you learn:

- the executable is named `pi`
- process setup happens immediately
- control transfers straight into `main(process.argv.slice(2))`

Why it matters: this file confirms that the real CLI behavior lives in `main.ts`, so you can stop looking for argument handling elsewhere.

### 2. `packages/coding-agent/src/main.ts`

This is the real top-level control plane for the coding agent.

What to look for:

- CLI argument parsing
- package/config commands
- stdin handling
- session manager creation
- model and tool selection
- the call to `createAgentSession(...)`
- mode dispatch into interactive / print / rpc paths

If you only read one large file to understand the product shell, make it this one.

### 3. `packages/coding-agent/src/core/sdk.ts`

This is the bridge between CLI concerns and reusable runtime setup.

What to look for:

- how `createAgentSession()` assembles auth, model registry, settings, resource loading, session state, and default tools
- how the repo decides on an initial model and thinking level
- how the `Agent` from `@mariozechner/pi-agent-core` is created
- how the higher-level `AgentSession` wrapper is returned

This file answers the question: “What pieces have to exist before pi can actually run?”

### 4. `packages/coding-agent/src/core/agent-session.ts`

This is the most important file once you want to understand day-to-day runtime behavior.

What to look for:

- prompt handling and queueing
- session persistence
- extension/resource integration
- model switching
- compaction and retry behavior
- the boundary between product-specific session logic and the generic `Agent`

This file is large, so do not try to memorize it. Read it in slices based on the behavior you care about.

Suggested sub-passes:

1. constructor and runtime setup
2. `prompt()` and message queueing
3. session switching and model management
4. compaction / retry / event handling

### 5. `packages/agent/src/agent.ts`

After you understand `AgentSession`, move down one layer.

What you learn here:

- what the generic `Agent` abstraction owns
- how state is stored
- how prompts, steering, follow-up messages, and continuation are exposed
- how the class delegates execution to `runAgentLoop()` and `runAgentLoopContinue()`

This file gives you the reusable runtime API that `coding-agent` builds on top of.

### 6. `packages/agent/src/agent-loop.ts`

This is the best file for understanding the actual execution cycle.

What to look for:

- when user messages enter context
- when assistant messages are streamed
- when tool calls are discovered and executed
- how steering and follow-up queues are polled
- where the conversion from `AgentMessage[]` to LLM-compatible messages happens

If you want to answer “what happens after the model responds with a tool call?”, this is the file.

### 7. `packages/ai/src/stream.ts`

This is the cleanest lower-level file in the stack.

What you learn:

- built-in providers are registered up front
- a model’s `api` is resolved to a provider implementation
- `stream`, `complete`, `streamSimple`, and `completeSimple` are thin dispatchers over that provider layer

This file is useful because it shows the boundary between generic model usage and provider-specific code without forcing you to read every provider implementation.

### 8. `packages/tui/src/index.ts`

Read this only when the terminal UI itself matters.

What you learn:

- which TUI primitives are public
- which components exist (`Editor`, `Markdown`, `SelectList`, overlays, terminals, key handling)
- how the terminal rendering layer is organized

This is a map of exports, not the best place to learn behavior first. Use it as an index when debugging UI questions.

## Read by question, not just by layer

If you are debugging a specific kind of behavior, use this shortcut table.

| Question | Start here |
|---|---|
| How does `pi` start up? | `packages/coding-agent/src/cli.ts` then `src/main.ts` |
| How is a session created? | `packages/coding-agent/src/core/sdk.ts` |
| Where do prompts, retries, compaction, and extensions live? | `packages/coding-agent/src/core/agent-session.ts` |
| How does the generic agent work? | `packages/agent/src/agent.ts` |
| How do tool calls run turn by turn? | `packages/agent/src/agent-loop.ts` |
| How do model calls reach provider implementations? | `packages/ai/src/stream.ts` |
| Where is terminal UI exported from? | `packages/tui/src/index.ts` |

## A practical first pass for contributors

For most first contributions, this lighter reading path is enough:

1. `packages/coding-agent/src/main.ts`
2. `packages/coding-agent/src/core/sdk.ts`
3. the relevant section of `packages/coding-agent/src/core/agent-session.ts`
4. `packages/agent/src/agent.ts` or `packages/agent/src/agent-loop.ts`, depending on whether the bug is product-level or runtime-level

That usually gives you enough context without getting lost in the full stack.

## See also

- [Architecture Overview](./architecture.md)
- [Package Guide](./package-guide.md)
- [Development Workflow](./development-workflow.md)
