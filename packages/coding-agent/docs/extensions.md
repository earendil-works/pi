# Extensions

Extensions are TypeScript modules that add executable behavior to Pi. Use one when a workflow needs tools, commands, event handlers, model providers, session state, or terminal UI rather than instructions alone.

An extension runs inside the Pi process with the same operating-system permissions. It can inspect prompts, tool calls, files, credentials, and session history, so load extensions only from sources you trust.

## Choose an extension when needed

Start with the least powerful mechanism that solves the problem:

| Need | Use |
|---|---|
| Reuse prompt text | [Prompt template](prompt-templates.md) |
| Supply task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable behavior or intercept Pi | Extension |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Distribute several resources | [Pi package](packages.md) |

Typical extensions add an agent tool, protect paths, confirm dangerous commands, react to session events, modify context, expose a command, or display persistent status.

<a id="quick-start"></a>
<a id="writing-an-extension"></a>

## Create an extension

An extension exports a default factory that receives `ExtensionAPI`. The factory registers capabilities for the current extension runtime.

Create `~/.pi/agent/extensions/hello.ts`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

Start Pi and run `/hello`. During development, load a file directly:

```bash
pi --extension ./hello.ts
```

Pi uses `jiti`, so local TypeScript extensions do not need a separate compilation step. Use [Pi packages](packages.md) for distributed extensions and dependencies.

<a id="extension-locations"></a>
<a id="available-imports"></a>

## Choose where it loads

Pi discovers extension files and directory entry points from:

| Scope | Location |
|---|---|
| Personal | `~/.pi/agent/extensions/*.ts` and `*/index.ts` |
| Project | `.pi/extensions/*.ts` and `*/index.ts` after trust |
| Package | An `extensions/` directory or `pi.extensions` manifest entry |
| Settings | Paths in the `extensions` array |
| One invocation | Repeatable `--extension` or `-e` options |

Use a single file for small extensions and an `index.ts` directory for multi-file implementations. Put an extension’s npm dependencies in a nearby `package.json`.

Run `/reload` after changing a discovered extension. A reload tears down the current extension runtime and creates a new one; code after `await ctx.reload()` still belongs to the old command invocation and must not reuse invalidated state.

Project extensions load only after project trust is granted. Only personal and explicit command-line extensions can participate in the earlier `project_trust` event.

## Understand the lifecycle

The factory can be synchronous or asynchronous. Pi waits for an asynchronous factory before startup continues, which allows it to fetch configuration or register dynamically discovered providers.

Do not start processes, sockets, watchers, or timers in the factory. Some invocations load extensions without starting a session. Start long-lived resources from `session_start` or from the command or tool that needs them.

Close session-scoped resources from an idempotent `session_shutdown` handler. Shutdown runs for exit, reload, new sessions, resumed sessions, and forks.

A normal agent run progresses through these stages:

1. Input is dispatched to extension commands or the `input` event.
2. `before_agent_start` can add context or alter the system prompt.
3. Agent and turn events surround each model request.
4. Message events report streaming and finalized messages.
5. Tool events surround validation, execution, updates, and results.
6. `agent_end` closes one low-level run.
7. Automatic retries, recovery, compaction, and queued work finish.
8. `agent_before_settle` can append entries and request one continuation.
9. `agent_settled` reports final, notification-only completion.

Use `agent_settled`, not `agent_end`, when an integration needs to know that Pi will not continue automatically.

<a id="extensionapi-methods"></a>

## Choose an integration point

| Capability | Main API |
|---|---|
| Observe or modify lifecycle behavior | `pi.on()` |
| Add a model-callable operation | `pi.registerTool()` |
| Add a `/` command | `pi.registerCommand()` |
| Add a shortcut or CLI flag | `pi.registerShortcut()` or `pi.registerFlag()` |
| Send user or custom messages | `pi.sendUserMessage()` or `pi.sendMessage()` |
| Persist non-context session data | `pi.appendEntry()` |
| Change active tools, model, or thinking level | Session control methods on `pi` |
| Add a model provider | `pi.registerProvider()` |
| Add terminal rendering | Renderer registration and `ctx.ui` |
| Communicate with another extension | `pi.events` |

Use the exported declarations in [`extensions/types.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts) for exact event, context, tool, and result types.

## Work with events

Event handlers run in extension load and registration order. `pi.on()` returns a function that unsubscribes that registration; changes do not affect a dispatch already in progress. Some events are notifications; others can transform data, replace results, or cancel an operation. Use the event’s declared result type rather than assuming every return value has an effect.

Important groups include:

- Resource events add skill, prompt-template, and theme paths during startup or reload.
- Session events surround replacement, fork, compaction, tree navigation, and shutdown.
- Agent and message events expose prompts, turns, streaming updates, and final messages.
- Provider events inspect or alter headers and request payloads, then observe response metadata.
- Tool events can inspect, mutate, block, or replace tool execution and results.
- Input events can continue, transform, or fully handle raw user input.

`before_agent_start` exposes both the current prompt and its structured `systemPromptOptions`. Prefer changing prompt sections, selected tools, or guidelines so Pi can append a transcript delta. Returning `systemPrompt`, or setting `forceSystemPrompt`, replaces the whole prompt for that run while the transcript continues recording the structured sections. Providers receive the forced text as their leading system prompt.

`message_end` can replace a finalized message while preserving its role. `tool_call` can mutate input before execution or block the call. `tool_result` handlers compose in load order, with each handler seeing prior changes.

`context` transforms conversation messages without prompt and tool system messages; Pi restores that state afterward. Use `context_with_system` only when a request-local transformation must own the complete transcript, and keep a system message at index zero.

`turn_end` and `agent_before_settle` are actionable boundaries. Their handlers can chain proposed `custom`, `custom_message`, `context_edit`, or `compaction` entries and return `continue: true` for one next model request. Guard continuation conditions because an unconditional continuation can loop. Use the exported event declarations for the complete validation and ordering contract.

`cache_warming_decision` can override an idle prompt-cache refresh with `{ action: "warm" }` or `{ action: "stop" }`. The last handler that returns an action wins.

Tool calls from one assistant message can execute in parallel. Do not assume one sibling tool has finished when another tool’s events run.

Use `ctx.signal` for nested network, model, or process work started during an active turn. It is often undefined in commands and idle session events, where no agent operation owns cancellation.

A `user_bash` handler that returns `undefined` passes the command to the next handler and then to local execution if no handler handles it. Returning `operations` or `result` stops propagation. A handler failure blocks the command rather than falling through to local execution.

<a id="custom-tools"></a>

## Register tools

A custom tool defines a name, model-facing description, TypeBox parameter schema, and `execute()` function. Its result contains content for the model and a required `details` field for rendering or state reconstruction.

Use `details: undefined` when a tool has no structured details to return.

Use `StringEnum` from `@earendil-works/pi-ai` for string choices that must work with Google APIs. Keep the public schema strict; use `prepareArguments` only to migrate stored calls from older sessions into the current shape.

Throw from `execute()` to report a failed tool result. Returning an object never marks the result as an error.

Return `terminate: true` only when the agent should skip its automatic follow-up after every completed tool in that batch agrees to terminate.

Models can call sibling tools concurrently. Use a sequential execution mode when shared in-memory state cannot be updated safely. File-mutating tools should use `withFileMutationQueue()` around the complete read-modify-write operation.

Tool output enters model context. Truncate large results and tell the model where it can read the complete output. Pi exports head, tail, and line truncation helpers with the same 50 KB or 2,000-line default limits as built-in tools.

Custom tools can provide compact call and result renderers. Keep model-facing content independent from display details so non-interactive modes still receive useful results.

See [`hello.ts`](../examples/extensions/hello.ts), [`todo.ts`](../examples/extensions/todo.ts), [`dynamic-tools.ts`](../examples/extensions/dynamic-tools.ts), and [`truncated-tool.ts`](../examples/extensions/truncated-tool.ts).

### Activate tools dynamically

Register every tool first, keep optional tools inactive, and use `pi.setActiveTools()` from a loader tool to select the desired active tools. Names must already be registered; unknown names are ignored.

Pi records the initial prompt and tool set in the transcript's first system message, then appends tool and prompt changes before the next model request. Providers that cannot represent the transition receive a complete transcript checkpoint, which can invalidate the cached prefix.

<a id="extensioncontext"></a>
<a id="extensioncommandcontext"></a>

## Use extension context

Event handlers and tools receive an `ExtensionContext`. It provides the current working directory, mode, UI, session manager, model runtime, abort signal, context usage, and controls for compaction and shutdown.

Read session state from `ctx.sessionManager`. During `tool_call`, it is synchronized through the current assistant tool-calling message, but sibling results from the same parallel batch might not exist yet.

Use `ctx.modelRegistry.streamSimple()` for provider-neutral nested model calls. It resolves configured credentials and providers, including providers registered by extensions.

Return nested model usage from tools or tool-result handlers so session totals remain accurate.

Command handlers receive `ExtensionCommandContext`. It adds operations that wait for idle, reload resources, navigate the tree, and replace the active session.

Those operations are restricted to commands because calling them from lifecycle handlers can deadlock the runtime.

Session replacement invalidates the previous context. The `withSession` callback receives a fresh context after the replacement starts. Capture only plain data before switching, then use the callback context for all session-bound work.

<a id="state-management"></a>

## Persist state

Choose storage based on how the state participates in the conversation:

- Store tool state in tool-result `details` when it should follow the active session branch.
- Use `pi.appendEntry()` for durable extension data that should not enter model context.
- Use `pi.sendMessage()` for custom content that should be stored and sent to the model.
- Use external storage for state that belongs outside one session.

Reconstruct branch-sensitive state from `ctx.sessionManager.getBranch()` during `session_start`. Do not rebuild it from every entry in the file because abandoned branches represent alternative histories.

Pair custom entries with `pi.registerEntryRenderer()` when they should appear in the transcript. Pair custom messages with `pi.registerMessageRenderer()` when they participate in both display and model context.

See [`todo.ts`](../examples/extensions/todo.ts), [`entry-renderer.ts`](../examples/extensions/entry-renderer.ts), and [`message-renderer.ts`](../examples/extensions/message-renderer.ts).

<a id="custom-ui"></a>

## Interact with the user

`ctx.ui` provides selection, confirmation, text input, an editor, notifications, status text, widgets, titles, and editor content. These methods are enough for most extension interaction.

Use `ctx.ui.custom()` only when the workflow needs a component with its own rendering and input. Extensions can also replace the header, footer, or editor and register renderers for tools, messages, and custom entries.

Guard terminal-only features with `ctx.mode === "tui"`. Use `ctx.hasUI` for interactions that work in both interactive and RPC modes. See [Terminal UI](tui.md) for focus, overlays, component rendering, themes, and performance.

<a id="mode-behavior"></a>

## Account for each mode

Extensions load in interactive, RPC, JSON, and print modes. Their available UI differs:

| Mode | `ctx.mode` | `ctx.hasUI` | Behavior |
|---|---|---:|---|
| Interactive | `"tui"` | `true` | Complete terminal UI |
| RPC | `"rpc"` | `true` | Supported dialogs and notifications use the RPC UI protocol |
| JSON | `"json"` | `false` | UI calls are unavailable; events are written to stdout |
| Print | `"print"` | `false` | UI calls are unavailable; the process exits after its prompts |

Design tools and event handlers so their core behavior does not depend on terminal rendering. In RPC mode, custom terminal components are unavailable even though basic UI requests can be forwarded to the client.

<a id="error-handling"></a>

## Handle errors and shutdown

Pi reports extension handler errors and continues where possible. A `tool_call` handler failure blocks the tool as a fail-safe. A tool execution failure becomes an error result for the model.

Release resources in `session_shutdown`, even if the normal operation already attempted cleanup. Keep shutdown idempotent because cancellation, reload, session replacement, and process exit can converge on the same cleanup path.

Use `ctx.shutdown()` to request an orderly process shutdown. Interactive and RPC modes wait for the appropriate idle boundary; print mode exits after its work normally.

<a id="examples-reference"></a>

## Use examples as the implementation reference

The [extension examples](../examples/extensions/) are checked with the repository and cover:

- safety gates and lifecycle events
- custom and dynamically loaded tools
- commands, flags, shortcuts, and session control
- persistent state and custom rendering
- terminal components, overlays, headers, footers, and editors
- remote and sandboxed tool execution
- model providers and OAuth
- compaction, system prompts, and inter-extension communication

Start with the smallest example matching your integration point. Copying a focused checked example is safer than extracting fragments from several unrelated examples.

Use [Custom Providers](custom-provider.md) for provider-specific design and testing. Use [Pi Packages](packages.md) when the extension should be installed or shared with other resources.
