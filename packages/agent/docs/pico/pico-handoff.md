# Handoff: outstanding pico decisions

Remaining additions for `packages/agent/docs/pico/`, to reconcile with `pico-v3.md`,
`pico-usage-guide.md` and `pico-work.md` before implementation. Incorporated decisions and rejected
or superseded proposals are omitted. Two parts: harness additions, then presentation additions
that also require task provenance and typed preview access.

---

# Part 1 — Harness

## 1.1 Preview delivery is coalesced

Scratch commits are never delayed, but `task_output` delivery to watchers is coalesced per task to
a frame interval (the rules in `docs/mobile-handoff/01-harness/04-tool-output/rate-limiting.md`),
so a fast stream produces one event per frame instead of one per token. Without this a TUI redraws
per token.

Where: §9.4, next to the tracker paragraph.

## 1.2 Hook handlers receive the task's scratch

A handler that waits on a person (approval, a question) must be able to memoize its answer durably,
or a crash mid-wait re-asks and a crash after the answer asks again. Give handlers `scratch` and
the task id in their context, and state the pattern: read-then-set in one scratch commit, first
writer wins; a crash before the answer asks again, a crash after replays to the same answer; the
memo retires with the task. This replaces `plugins.md`'s `memoOnce` and invocation-memo API, and it
is the same shape the question extension needs.

```typescript
h.hooks.on(toolKind, 'before_tool', async ({ toolName, args, scratch, taskId }, call) => {
  if (toolName !== 'bash') return;
  const decision = scratchValue<'allow' | 'deny'>('approval');
  let d = await scratch(sc => sc.value(decision).get(), call);
  if (d === undefined) {
    const answer = await approvals.ask(taskId, args, call); // keyed instance every presentation observes
    d = await scratch(async sc => {
      const stored = await sc.value(decision).get();
      if (stored !== undefined) return stored;
      sc.value(decision).set(answer);
      return answer;
    }, call);
  }
  return d === 'allow' ? { args } : { block: { reason: 'denied by user' } };
});
```

Where: §8.7 and the guide's Hooks section.

## 1.3 Budget ownership transfer

The work plan already flags arbitrary tool-work adoption as unresolved. Give it its own package
when the ownership design is settled: adopting a non-delegating tool's in-flight work after the
budget expires needs an explicit transfer of effect and sink ownership before the source invocation
releases its slot. The job-first path ships first.

Where: `pico-work.md`.

---

# Part 2 — Presentation

## 2.1 Task provenance is `byTaskId`, not `JobState.origin`

`origin: { tool, task, callId }` is a kind-specific enum for something the harness knows
generically. Replace it with a field the `Tx` fills from the committing invocation:

```typescript
interface Task { …; readonly byTaskId?: Id }   // task whose commit created it; absent = created outside any task
```

A tool's job has `byTaskId` = the tool task, so a renderer reads that task, `toolKind.is(t)`, and
uses the tool's component. A schedule is a job with `every` in its own state; nothing else marks it.
Subagent tasks chain `byTaskId` up to the `run`/`spawn` tool. `Entry.byTaskId` already exists; this
makes tasks symmetric. Remove `origin` from `JobState`, from the bash example in §8.3 and from the
notice text (derive it from the creating task).

Where: §5.1, §8.3, §8.6.

## 2.2 `!cmd` is a client-owned task kind

User-run bash is initiated by the UI, not by the model or a tool, so it is its own kind owned by
the coding agent (or its bash plugin), sharing the exec-into-scratch helper with `jobKind`. Its
settlement records the transcript write in the same commit as `settle`, so a client that dies in
between leaves nothing to repair. Use `tx.write`: it appends immediately when safe, otherwise queues
until the next turn boundary:

```typescript
type UserBashInput = { cmd: string; cwd: string; includeInContext: boolean; limits?: ShellOutputLimits };
type UserBashStates = UserBashInput & (
  | { status: 'planned' }
  | { status: 'running' }
  | { status: 'done'; exitCode: number }
  | { status: 'killed' }
  | { status: 'lost' }
);
function userBashInput(state: UserBashStates): UserBashInput {
  return { cmd: state.cmd, cwd: state.cwd, includeInContext: state.includeInContext,
    ...(state.limits === undefined ? {} : { limits: state.limits }) };
}

const userBashKind = defineTaskKind<UserBashStates>()({
  kind: 'pi.user_bash',
  initialStatus: 'planned',
  roles: { planned: 'start', running: 'inflight', done: 'terminal', killed: 'terminal', lost: 'terminal' },
  preview: { init: async scratch => (await scratch.value(output).get()) ?? emptyOutput() },

  async execute(task, runtime, call) {
    await runtime.commit(tx => tx.patch(task, 'running', userBashInput(task.state)), call);
    const result = await execIntoScratch(runtime, task.state, call);       // same helper as jobKind
    const out = runtime.preview.state;
    await runtime.commit(tx => {
      tx.write(userBashKind.entry, {
        data: { cmd: task.state.cmd, exitCode: result.exitCode, output: out },
        model: task.state.includeInContext ? [userBashMessage(task.state.cmd, out, result.exitCode)] : undefined,
      });
      tx.settle(task, 'done', { ...userBashInput(task.state), exitCode: result.exitCode });
    }, call);
  },
  async recover(task, runtime, call) {
    await runtime.commit(tx => tx.settle(task, 'lost', userBashInput(task.state)), call);
  },
  async abort(task, runtime, call) {
    await runtime.commit(tx => tx.settle(task, 'killed', userBashInput(task.state)), call);
  },
});

// the "!" handler
await c.commit(tx => tx.task(userBashKind, {
  background: true, state: { status: 'planned', cmd, cwd, includeInContext, limits },
}), call);
// Escape → h.abortTask(id, call); the renderer's task_start / task_output / entry cases do the rest
```

This is the pattern for any client-owned "thing that runs and should appear in the transcript": a
kind, not a flag on a built-in. Use it as the guide's example of a client-defined task kind; it is
better than the reminder.

Where: the guide's "Writing Kinds".

## 2.3 Two rendering styles are first-class

§9.4 presents `apply(view)` diffing as the way to render. It is one of two, and the other is the
coding agent's interactive mode unchanged:

- **Event-driven**: `task_start` on a generation makes a streaming component; `task_output` updates
  it from the view's preview; `task_start` on a tool makes a tool component; `task_end` retires it;
  `entry` finalizes. Bookkeeping is one streaming component and one map, as today.
- **View-driven**: `apply(view)` diffing against what was last drawn, for clients that attach
  mid-turn or resnapshot.

The view is authoritative in both: it is what a client renders on attach, and it has been folded
before the listener runs. Rewrite the "The view is authoritative and the events are wake-ups"
paragraph accordingly, and lead the guide's Rendering section with the event switch.

Mapping from `packages/coding-agent/src/modes/interactive/interactive-mode.ts` (`handleEvent`,
`renderSessionEntries`):

| interactive mode | pico |
|---|---|
| `agent_start` / `turn_start` / `message_start(assistant)` | `task_start`, `generationKind.is(t)` |
| `message_update`, including tool components born from streaming tool calls (keyed by call id) | `task_output` on the generation; preview is the partial `AssistantMessage` |
| `message_end`; aborted/error → pending tools get error results, else `setArgsComplete` | `entry`, `assistantKind.is(e)` |
| `tool_execution_start` / `_update` / `_end` | `task_start` / `task_output` / `task_end` on the tool task; result via `entry`, `toolResultKind.is(e)`, keyed by `e.key` |
| `compaction_start` / `_end` | `task_start` / `task_end`, `collapseKind.is(t)`; re-render on the summary `entry` |
| `auto_retry_start` / `_end` | `task_update` to/from `retry_wait`; failure on `task_end` `failed` |
| `summarization_retry_*` | `task_update` on the collapse task |
| `agent_end` / `agent_settled` | after any `task_end`: no live foreground task in the view |
| `queue_update` | `inbox` |
| `thinking_level_changed` | `value`, `addr === generationKind.config.thinking` |
| `session_info_changed` | session watch `value` |
| `entry_appended(custom)` | `entry` of a plugin or unregistered kind |
| `bash_execution_update` | `task_output` on a `pi.user_bash` task (2.2) |

One map more than today: tool task id → call id, because tool components are created while the
assistant message streams (by call id) and only later associated with their task.

## 2.4 Typed preview access

Renderers should not cast. The view offers a typed accessor witnessed by the kind, alongside the
raw map the reducer and the wire use:

```typescript
interface ConversationView {
  readonly previews: ReadonlyMap<Id, JsonValue>;                          // raw, kind-free
  preview<S extends TaskStateBase, H extends HookPoints, C extends ConfigSpec, P, R extends TaskRoles<S>>(
    kind: TaskKind<S, H, C, P, R>, task: Id): P | undefined; // typed; undefined if missing or another kind
}
const msg = w.view.preview(generationKind, event.task);   // AssistantMessage | undefined
const out = w.view.preview(toolKind, event.task);         // ToolOutputState | undefined
```

`kind.is(task)` already narrows `task.state` in the `task_*` cases.

Where: §9.4 and every example that currently casts.

## 2.5 Renderer registry and layouts

Rendering has two jobs and the client keeps them apart:

- **Renderers**, one per kind, replaceable: `renderers.entry(kind, previous => …)` and
  `renderers.task(kind, previous => ({ start, output?, update?, end }))`. Built-ins register the
  same way, so a plugin replaces or wraps one by re-registering under the same kind and receiving
  the previous renderer. An unregistered kind gets a generic fallback: model text or collapsed
  data for entries, kind + status + preview for tasks. Renderers never parent components.
- **Layouts**, pure functions over the ordered list of rendered blocks:
  `Layout = (blocks: Block[], view) => LayoutNode[]`, where a node is a block or a group
  `{ key, label, collapsed, children }`. Applied in registration order; the client reconciles the
  tree with the chat container by key and keeps open/closed state by key.

Grouping tool calls per exchange and collapsing a run until its final answer are each about ten
lines of layout, and they compose. Hydration on attach and live rendering share one path: build
blocks from `view.entries` and `view.tasks`, run the layouts, reconcile. The non-rendering
concerns of today's handler (Escape-handler swaps for retry and compaction, the working indicator,
the post-summary re-render, shutdown checks) stay in the mode; a plugin does not get to hijack
Escape.

This is presentation-side only, the contribution shape `plugins.md` already describes for tool
renderers, keyed by kind string on the wire and by kind object in code. It belongs in the guide's
Rendering section and in `pico-work.md` package 20 as the TUI's parity target.
