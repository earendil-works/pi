# Pico rendering

This document defines how a presentation renders a replicated Pico conversation. It covers local and
remote clients, initial attachment, live streaming, terminal handoff, renderer registration and stable
component identity. The harness model remains defined by `pico-v3.md`; the examples and client-facing
surface belong in `pico-usage-guide.md`.

The target is the directness of coding-agent interactive mode and `experimental/mini`, without their
hard-coded event vocabulary or duplicate hydration logic.

## 1. The presentation owns a replica, not agent state

A presentation owns one `ConversationView`. It does not read storage, parse commits or hold live task,
provider, tool or model objects.

Opening a watch atomically captures the view and registers its listener. The harness buffers changes
until delivery starts. Each committed change is folded into the view before listeners observe its
events. An in-process client uses the harness-owned view; a remote client applies the same exported
kind-free reducer before notifying its UI.

Delivery over one WebSocket or SSE connection is ordered and gap-free. If delivery fails or a bounded
queue overflows, that watch closes. Reconnection opens a new watch and receives a fresh view. There are
no cursors, epochs, acknowledgements, deduplication, replay requests or in-place resnapshot protocol.

The view is authoritative. Events identify the affected portion so a live renderer can avoid scanning
the whole view; they are not a second source of presentation state.

## 2. Local view access

The raw collections remain serializable. A local wrapper adds indexed and typed access:

```ts
interface ConversationView {
  readonly conversation: Conversation;
  readonly entries: readonly Entry[];
  readonly tasks: readonly Task[];
  readonly previews: ReadonlyMap<Id, JsonValue>;
  readonly inbox: readonly Element<QueuedInput>[];
  readonly values: ReadonlyMap<Address, JsonValue>;
  readonly context: readonly Id[];
  readonly faulted: boolean;
  readonly readAt: Id;

  entry(id: Id): Entry | undefined;
  task(id: Id): Task | undefined;

  entriesOf<K extends EntryDefinition>(kind: K): readonly EntryOf<K>[];
  tasksOf<K extends TaskDefinition>(kind: K): readonly TaskOf<K>[];

  preview<S extends TaskStateBase, H extends HookPoints, C extends ConfigSpec, P,
          R extends TaskRoles<S>>(
    kind: TaskKind<S, H, C, P, R>, taskId: Id,
  ): P | undefined;
}
```

`preview(kind, taskId)` returns `undefined` when the task is absent, has another kind or has no live
preview. Built-in and plugin renderers use it without casts. `task(id)` is sufficient to classify a
`task_output` event because the reducer has already folded that event before the listener runs.

A remote wire view may remain arrays and maps encoded as JSON. The wrapper builds its indexes locally;
those indexes are not another replicated representation.

## 3. Two rendering paths

Both paths use the same registered renderers and component keys. They differ only in how much of the
view they visit.

### 3.1 Hydration

Hydration runs on first attachment and after opening a replacement watch. It walks the current entries
and live tasks and upserts their blocks:

```ts
function hydrate(view: ConversationView): void {
  for (const entry of view.entries) entryRenderers.render(entry, view);
  for (const task of view.tasks) taskRenderers.render(task, view);
  chrome.sync(view);
}
```

This is the view-driven path used by Mini. Existing blocks are reconciled by stable key, so a fresh
view need not tear down unchanged terminal components.

### 3.2 Live events

Normal streaming uses targeted event handling, as interactive mode does:

```ts
function handle(event: ConversationEvent, view: ConversationView): void {
  switch (event.type) {
    case "entry":
      entryRenderers.render(event.entry, view);
      break;
    case "task_start":
    case "task_update":
      taskRenderers.render(event.task, view);
      break;
    case "task_output": {
      const task = view.task(event.task);
      if (task) taskRenderers.render(task, view);
      break;
    }
    case "task_end":
      taskRenderers.end(event.task, view);
      break;
    case "inbox":
    case "value":
    case "context":
      chrome.sync(view, event);
      break;
    case "fault":
    case "closed":
      chrome.connection(event);
      break;
  }
}
```

A streamed token therefore updates one task renderer. It does not rebuild every transcript block or
run every layout. A client that does not need the optimization may ignore the event payload and call
`hydrate(view)` after every notification; it remains correct.

The renderer callbacks, not a mandatory full-tree diff, are the shared path between hydration and live
updates.

## 4. Renderer registry

Entry and task renderers are registered by kind. Registration is typed by the kind object even though
the wire and internal registry use its string token:

```ts
renderers.entry(noteKind, previous => ({
  render(entry, host, view) { /* entry is NoteEntry */ },
}));

renderers.task(downloadKind, previous => ({
  render(task, preview, host, view) { /* typed task and DownloadPreview */ },
  end(task, host, view) { /* terminal typed task */ },
}));
```

The exact component type belongs to the presentation package, not Pico. The common contract is:

- `render` upserts components through the host using stable keys;
- `end` handles terminal live-state cleanup and does not need a retired preview;
- renderers do not directly parent components in the transcript container;
- registration may replace or wrap `previous`;
- built-ins and plugins use the same API;
- removing renderer code does not affect the replicated view.

An unregistered entry kind uses a generic renderer: model text when present, otherwise collapsed
kind/data. An unregistered task kind uses kind, status and a collapsed raw preview when present.
Unknown kinds must remain visible and must not break hydration.

The heterogeneous registry may erase renderer types internally. That cast or validation boundary is
owned once by the registry; renderer authors do not cast task state, entry data or previews.

## 5. Renderer host

The host owns component instances and placement. Renderers only describe or update blocks through it.
At minimum it maintains:

```text
entry id       -> settled transcript block
live task id   -> live task block or region
tool-call id   -> tool component
inbox item id  -> queued-input component
```

It provides keyed `get`, `upsert`, `move`/`adopt` and `remove` operations. A renderer can update an
existing component without knowing which container currently parents it. The host preserves expansion,
selection and other local UI state while adopting or moving a block.

No persistent `tool task id -> tool-call id` map is required. Every tool-task state variant carries
its call:

- on `task_output`, `view.task(event.task).state.call.id` identifies the component;
- on `task_end`, the event's terminal task carries the same call;
- tool-result entries use their indexed call key.

A renderer may cache expensive presentation-only products such as parsed Markdown. Such caches are
never authoritative and may be discarded on hydration.

## 6. Stable identity and terminal handoff

Every rendered object has a stable semantic key:

| Object | Key |
| --- | --- |
| transcript entry | entry ID |
| live generation | generation task ID |
| assistant content block | generation task ID + content index |
| tool component | tool-call ID |
| live tool preview lookup | tool task ID |
| inbox item | list-element/input ID |
| compaction, job or plugin task | task ID |

A component may change ownership without changing its semantic identity.

### Assistant handoff

A generation preview renders a partial assistant message under the generation task ID. The final
assistant entry has `byTaskId` equal to that generation task. Its renderer adopts the existing live
component, applies the immutable final message and then associates the settled transcript position
with the entry ID. It does not append a duplicate assistant component.

If no matching live component exists, as on initial attachment, the entry renderer creates the same
settled component directly.

### Tool handoff

Tool-call components are born while the assistant preview streams and are keyed immediately by the
call ID. A later tool-task start marks that same component running. Tool output updates it from the
typed preview. The terminal tool-result entry updates the same call-ID component with immutable final
output. No phase creates a second tool component.

### Other tasks

A task that has no terminal entry removes or finalizes its live block in `end`. A task kind that
requires a durable transcript representation writes that entry in the same commit in which it
settles. The view is already folded to the whole commit before listeners run, so no client-visible idle
or missing-result state exists between those events.

## 7. Task provenance required by rendering

Task creation records generic provenance just as entry creation does:

```ts
interface Task {
  // ...
  readonly byTaskId?: Id;
}
```

`ConversationTx` fills `byTaskId` from the invocation whose commit created the task; it is absent for
tasks created outside a task invocation. Task kinds do not write it themselves.

This replaces kind-specific provenance such as `JobState.origin`. A job created by a tool has
`byTaskId` equal to the tool task. A renderer follows that task and narrows it with `toolKind.is` to
select the originating tool renderer. Nested delegated work follows the chain as needed.

## 8. Structured previews

A preview is the complete current render model for one live task, not a text delta.

The generation preview is the full partial `AssistantMessage` assembled from
`AssistantMessageFrame`s. It retains ordered content blocks, text, thinking, signatures, partial tool
arguments, provider metadata, usage and diagnostics. `task_output.ops` only transports changes; the
renderer reads the already-updated message through `view.preview(generationKind, task.id)`.

A tool preview is the complete current `ToolOutputState`: text or structured content, plugin details,
images, usage, delegation, handoff, added tools, termination, diagnostics and truncation metadata. Tool
renderers own plugin-specific interpretation. The generic host does not flatten it to text.

Terminal rendering uses immutable entries or terminal task state because settlement retires the live
preview.

## 9. Layouts are optional presentation policy

Grouping tool calls, collapsing a run until its final answer and similar structures are useful, but a
general composable layout/reconciliation pipeline is not required by the Pico watch or renderer
contract.

A presentation may add layouts above the keyed renderer host. Layouts must preserve block keys and
must not make preview delivery depend on rebuilding the complete transcript. They should initially run
only for structural changes unless a particular layout explicitly depends on live preview content.

The first coding-agent client should reach feature parity with direct keyed placement. Add a general
layout API only after at least two concrete layouts demonstrate that a shared abstraction is smaller
than their local implementations.

## 10. Client-owned visible work

A client operation that runs over time and should survive in the transcript is an ordinary task kind,
not a presentation-only event stream. For example, `!cmd` is a `pi.user_bash` task owned by the coding
agent or bash plugin. It shares process-output helpers with jobs, publishes a typed preview, and writes
its terminal entry in the same commit as settlement.

The presentation starts it with a command and then handles its generic `task_start`, `task_output`,
`task_end` and `entry` events. Escape calls `abortTask(id)`. Plugins use exactly the same pattern for
client-initiated work.

## 11. Mapping from interactive mode

| Interactive-mode event | Pico rendering |
| --- | --- |
| `agent_start` / `turn_start` / assistant `message_start` | generation `task_start` |
| `message_update` | generation `task_output`; read typed assistant preview |
| `message_end` | assistant `entry`; adopt by `byTaskId` |
| `tool_execution_start` | tool `task_start`; identify component by call ID |
| `tool_execution_update` | tool `task_output`; read typed tool preview |
| `tool_execution_end` | tool `task_end` plus tool-result `entry` |
| `compaction_start` / `_end` | collapse `task_start` / `task_end`; summary `entry` |
| retry events | generation or collapse `task_update` |
| `agent_end` / `agent_settled` | no live foreground task after the commit |
| `queue_update` | `inbox` |
| thinking/model change | typed configuration `value` |
| custom entry | registered entry renderer or generic fallback |
| `bash_execution_update` | `pi.user_bash` `task_output` |

The generic vocabulary changes dispatch, not component behavior. Compared with interactive mode, Pico
removes the second independently authored hydration implementation. Compared with Mini, it replaces
hard-coded operation fields with typed task kinds and replaceable renderers while retaining the same
small keyed-component model.
