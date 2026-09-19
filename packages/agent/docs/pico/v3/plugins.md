# Pico3 plugins

Status: proposal for how the hardened V3 (`pico3`) harness is extended, and how
those extensions are packaged as Chord facets in the coding agent. Companion of
`view-and-events.md`. Written against `harness-v3.zip`, `pico-handoff-v2.md`
(§8–§12, §16) and `packages/agent/docs/plugins.md` (the coding-agent facet
architecture), read in full.

Read order: §1–§5 are the harness alone (no Chord); §6 is the Chord layer; §7 tests.

## 1. Principles

1. **There is no plugin object.** The harness exposes registration capabilities;
   whoever composes the process (a Chord facet, a test, a script) calls them.
   The coding agent's "plugin" is a package of host-specific Chord facets that
   call these capabilities (§6); the harness never sees the package.
2. **One durability story.** Everything durable is one of four primitives (§2):
   entry, task checkpoint, task slot, namespace slice. Tools, hooks and custom
   task kinds use the same four; none has a private mechanism.
3. **Nothing durable belongs to a facet.** Chord service instances and
   replicated state are live process state; a reload replaces code, never state.
4. **Core authority stays core.** Extensions cannot append entries mid-turn,
   touch `turn`/`inbox`, resolve inputs, create core tasks, or write outside their
   namespace or their own task's slot. Enforced at runtime on every method, by
   type at the surface.
5. **An extension's presentation is only what it projects.** The view shows a
   namespace's declared `view` projection (nothing by default), a kind's
   `describe()` output, the core-rendered tool slot fields, and entries. Raw
   namespace state (caches, keys, secrets) and slot working state (memos,
   idempotency evidence) never appear in the view.

Here, “durable” means recoverable according to the selected storage mode. JSONL
with `fsync: false` covers process termination while the OS/filesystem remain
alive, but acknowledged tail commits may disappear after power, kernel, VM-host,
or storage-cache failure. `fsync: true` strengthens file-data durability; see
`hardening-handoff.md` §10 for the exact boundary and worst cases. Neither mode
makes an external effect exactly once without an external idempotency key.

## 2. Durable primitives

| primitive | lives in | lifetime | written by | forks / history | in the view |
|---|---|---|---|---|---|
| **entry** | transcript | forever, immutable | anyone via `c.write` (boundary-safe); core via `appendEntry` | inherited up to the fork point; rewind = `at` | `entries` |
| **task checkpoint** | task record | the task | its kind, whole replacement | no | via `describe()` → `turn.generation`, `compaction`, `tasks[id].status` |
| **task slot** | sticky document, `tasks[id]` (turn tasks: `turn.tools[i]`) | the task; retired atomically with its terminal record | its kind; tools running in it; hooks running in it | no | `tasks[id]`, `turn.tools[i]` |
| **namespace slice** | `plugins[ns]` in the session, rewindable or sticky document | the conversation / session | holders of the namespace token | rewindable slices are inherited and rewindable; sticky/session are present-only | `plugins[ns]` |

Rules:

- **Checkpoint** is the kind's recovery program counter, nothing else. It is not
  a place for working state (that is the slot) or long-lived state (namespace).
- **Slot** is working state that should die with the task: progress, streamed
  output, and **memos**. `memoOnce(slot, key, candidate)` is one operation inside
  one commit: if `Object.hasOwn(slot.memos, key)` return the stored value, else
  store `candidate` and return it (`??=` is wrong: `null` is a valid value). It
  returns the durable winner to every caller. A memo is durable coordination and
  evidence; it is **not** exactly-once execution by itself. For an external
  effect, persist the idempotency key *before* the effect and replay the effect
  with the same key, relying on the external side to dedupe or to answer a
  result lookup; persist a result *after* an effect only when a duplicate is
  otherwise harmless. Slot contents are never in the view.
- **Namespace slice** defaults are declared at registration, per document, and
  seeded lazily (`plugins[ns] ??= defaults` on first access). Choose the
  document by semantics: rewindable when a fork should see the value as it was
  (plan mode, chosen model overrides), sticky for the present (UI preferences,
  caches), session for session-wide.
- **Entries** are the only primitive the model can see (when they carry
  `model`); everything else is invisible to the model by construction.
- Protected: `turn`, `inbox`, core config keys and other tasks' slots reject
  writes from extensions.

What is deliberately **not** durable: Chord keyed service instances (an open
approval dialog), hook handler registrations, tool and section registrations.
All are re-established by code at startup or reload.

## 3. Registration surface

```ts
const h = await Harness.open(storage, { models, processHost?, onReport? }, ctx);
// nothing runs yet; register, then:
h.resume();
```

All registration methods return an unregister function and may be called while
the harness is open (§5 for what happens then).

```ts
h.registerTool(declaration: ToolDeclaration): () => void
h.registerSection(section: SystemSection): () => void
h.registerTaskKind(kind: Kind): () => void                     // ordinary kinds only; config keys checked for collisions
h.namespace<T extends NamespaceShape>(ns: string, defaults: T, opts?: { view?: (slice: T) => JsonValue }): Namespace<T>
                                                               // token with idempotent `unregister()`; unique, not `pi.*`; no `view` ⇒ nothing in the view
h.hooks(ns: Namespace, kind, handlers: Partial<HooksOf<typeof kind>>, opts?): () => void   // harness-wide; bound to the namespace (§4.2)
c.hooks(ns, kind, handlers, { subtree? }): () => void                             // one conversation (+ owned)
defineEntry<E>(kind: string): EntryKind<E>                                      // stateless; throws on `pi.*` (§4.4)
h.conversation(id, ctx): Promise<ConversationHandle | undefined>
h.quiescent(): boolean;  h.hold(): () => void;  h.suspend(ctx): Promise<void>    // §5
```

Token identity: the object passed to `tx.plugins(ns)`, `tx.emit(ns, …)`,
`tx.createTask(kind, …)`, `h.hooks(ns, kind, …)` must be the currently
registered one; a redeclared or unregistered token rejects with
`StaleDefinition`. The namespace *string* is what persists (memo keys, state
slices); the token is only current runtime authority. This is what makes reload
safe: code from a retired generation cannot keep writing, and a replacement
registration of the same string finds the same state and memos.

Before `resume()`: task kinds whose tasks may exist in storage, and hook
handlers that recovery reruns (`beforeTool`, `systemInstructions`,
`beforeRequest`, `beforeCollapse`). A task whose kind is unregistered at
`resume()` is orphaned (open-time reconciliation, `pico-handoff-v2.md` §13). A
kind registered later only affects tasks created later. Tools, sections,
namespaces and observer hooks may be registered at any time.

Inside a commit, extensions get:

```ts
tx.plugins(ns): T                                   // typed slice in the declared document(s), tracked proxy
tx.emit(ns, name: string, data: JsonValue): void    // -> { type: `plugin.${ns}.${name}`, data } in this commit's envelope
tx.slot(task): Slot                                 // own task only (kinds); tools/hooks use the api variants
memoOnce(tx.slot(task), key, candidate)             // first writer wins; hasOwn semantics (§2)
tx.write(conversationId, entryKind, input): Promise<Id>
tx.createTask(kind, input, opts): TaskRef<K>        // ordinary kinds
```

## 4. Extension points

Each with what it may do, where its durable state lives, and a worked example
against the raw harness. The three examples are the ones §6 turns into Chord
facets.

### 4.1 Tools

`ToolDeclaration` as in the sketch (`name`, `description`, `parameters` TypeBox,
`replay`, `output` bounds, `execute(args: Static<P>, api, ctx)`), plus the
tool-facing API:

```ts
interface ToolApi {
  readonly taskId: Id; readonly conversationId: Id; readonly callId: string;
  stream(chunk: string | Uint8Array): void;                          // kernel-bounded; becomes the result content if none returned
  progress(update: (slot: ToolSlot) => void, ctx): Promise<void>;    // own slot: progress, details, continuedBy
  memo<T extends JsonValue>(name: string, candidate: T, ctx): Promise<T>;   // memoOnce on the own slot
  memo<T extends JsonValue>(name: string, ctx): Promise<T | undefined>;     // read
  task<K>(kind: K, input: InputOf<K>, opts, ctx): Promise<TaskRef<K>>;
  conversation(spec, ctx): Promise<OwnedConversation>;
  waitForTask(ref, ctx): Promise<TaskOf<K>>;
  slot<T>(ref, ctx): Promise<T | undefined>;                         // another task's slot, read-only snapshot
}
```

Durability: the tool's **slot** (`turn.tools[i]`) for streamed output, progress
and memos; **entries** through its result. A tool has no checkpoint; it runs
inside `pi.tool`, whose `started{call}` checkpoint is the effect evidence.

How memos and `replay` interact: `beforeTool` and the `started` checkpoint
happen before `execute`; a crash after `started` re-invokes only `replay:
"safe"` tools. A safe tool that performs a keyed external effect records the
idempotency key as a memo *before* the effect and reuses it on re-invocation;
the external side dedupes or answers a result lookup for that key. Recording a
result *after* the effect (as the question tool does) is only correct when a
repeated effect is harmless, which asking a human again is. Memos are scoped to
the tool task's slot and retired with it, so they cannot leak into a later call
with the same id.

Example: a question tool that waits for a human. `ask` is whatever the host
wires in (§6.2 wires a Chord dialog service; a test wires a promise).

```ts
export function questionTool(ask: (req: QuestionRequest, api: ToolApi, ctx: Context) => Promise<QuestionResponse>): ToolDeclaration {
  return {
    name: "question", description: "Ask the user a question and wait for the answer.",
    parameters: QuestionParamsSchema, replay: "safe",
    async execute(params, api, ctx) {
      let response = await api.memo<QuestionResponse>("answer", ctx);        // answered before a crash?
      if (response === undefined) {
        const candidate = await ask(params, api, ctx);                        // may wait for a long time; abort unwinds through ctx
        response = await api.memo("answer", candidate, ctx);                  // first writer wins
      }
      return response.outcome === "cancelled"
        ? { content: [{ type: "text", text: "User cancelled" }], isError: true }
        : { content: [{ type: "text", text: `User answered: ${response.answer}` }], details: { ...params, answer: response.answer } };
    },
  };
}
```

Crash before the memo: `pi.tool` recovers `started` (safe), re-invokes, no memo,
asks again. Crash after: re-invokes, memo present, returns without asking.
Two answers racing: both call `api.memo("answer", …)`, both receive the winner.

### 4.2 Hooks

Declared per kind, typed (`GenerationHooks`, `ToolHooks`, `PostToolsHooks`,
`CollapseHooks`, plus any custom kind's `H`). Handlers receive
`(…payload, api, ctx)`. `HookApi` is identity only; each point's runner passes
a point-specific info object with exactly the capabilities that point can use:

```ts
interface HookApi { readonly kind: string; readonly taskId: Id; readonly conversationId: Id }

interface BeforeToolApi extends HookApi {
  readonly callId: string;
  waiting(ctx: Context): Promise<void>;              // commits turn.tools[i].waitingOn = <this handler's namespace>; idempotent
  memo<T extends JsonValue>(name: string, candidate: T, ctx: Context): Promise<T>;   // memoOnce on the tool task's slot, keyed (task, namespace, name)
  memo<T extends JsonValue>(name: string, ctx: Context): Promise<T | undefined>;
  emit(name: string, data: JsonValue, ctx: Context): Promise<void>;                   // plugin.<namespace>.<name>
}
// Hooks are registered with their namespace token (`h.hooks(ns, kind, handlers)`), so `waiting`, `memo` and
// `emit` need no namespace argument and two plugins cannot collide on a memo name. `waitingOn` is cleared by the
// kernel atomically with `started` (handler allowed), with the synthetic result (handler blocked or threw), or in
// its own commit when the handler unwinds on abort or suspend.

interface ToolHooks {
  beforeTool(call: ToolCall, api: BeforeToolApi, ctx: Context): { call?: ToolCall; block?: string } | void | Promise<…>;
  afterTool(call: ToolCall, result: ToolResult, api: HookApi & { readonly callId: string }, ctx: Context): ToolResult | void | Promise<…>;
}
// generation points: HookApi & { cutoff } / { attempt } as today; collapse: HookApi. A `memo` on another
// point's hosting-task slot is added to that point's info type when a real case needs it, not by default.
```

Durability: a hook has no task of its own. State tied to the invocation it is
running in goes in the **hosting task's slot** via the point's `api.memo`,
keyed by `(hosting task, namespace string, name)` so it survives recovery and
re-registration and cannot collide with another plugin's memo (retired with
that task, no cleanup code); state that outlives tasks goes in a **namespace**.
There is no hook invocation id: nothing durable identifies "the same handler
invocation" across a crash or a reload, and the rerun must find the earlier
decision. Hooks commit through `h.conversation(api.conversationId, ctx)`
handles (never from inside a transaction builder: use the builder's own `ctx`
there, see `hardening-handoff.md` §7) and may wait as long as they like; `beforeTool` handlers rerun after a
crash or a suspend/reopen (they run before `started`), which is why their
decision must be a memo.

Example: tool approval.

```ts
export function installApproval(h: Harness, ask: (req: ApprovalRequest, ctx: Context) => Promise<ApprovalDecision>): () => void {
  const ns = h.namespace<{ autoAllow: string[] }>("approval", { sticky: { autoAllow: [] } });   // long-lived: which tools skip approval; no `view` ⇒ private

  return h.hooks(ns, kinds.tool, {
    async beforeTool(call, api, ctx) {
      const c = await h.conversation(api.conversationId, ctx);
      const auto = await c.commit((tx) => tx.plugins(ns).autoAllow.includes(call.name), ctx);
      if (auto) return;
      let d = await api.memo<ApprovalDecision>("decision", ctx);             // decided before a crash / reload? key = (task, "approval", "decision")
      if (d === undefined) {
        await api.waiting(ctx);                                               // view: turn.tools[i].waitingOn = "approval"; event tool.waiting
        const candidate = await ask({ conversationId: c.id, callId: call.id, taskId: api.taskId, name: call.name, args: call.arguments }, ctx);
        d = await api.memo("decision", candidate, ctx);                       // first writer wins
      }
      return d.decision === "deny" ? { block: `denied${d.by ? ` by ${d.by}` : ""}` } : undefined;
    },
  });
}
```

No `afterTool` cleanup: the memo lives in the tool task's slot and is retired
with it. Late joiners see `waitingOn` in the snapshot. Two clients deciding at
once both get the memo winner. Abort or suspend unwinds `ask` through `ctx`;
the kernel clears `waitingOn` when the handler returns for any reason. Asking a
human twice after a crash between `waiting` and the memo is harmless, which is
why a post-effect memo is acceptable here.

### 4.3 Custom task kinds

Shape as in the sketch and the hardening handoff: `defineTask({ name, config?,
hooks?, initial, phases, abort, describe? })`, exhaustive phase map, in-flight
phases written before an effect and entered only after reopen, `next` builders
that may checkpoint, terminalize or `"retry"`.

Durability:

| need | primitive |
|---|---|
| where to resume after a crash | **checkpoint** (`tx.checkpoint(next)` / returned `next`) |
| progress, partial output, per-run memos | **slot** (`tx.slot(current)`, `memoOnce`) — shown as `tasks[id].status` after `describe()` |
| state that outlives the task, per conversation or session | **namespace** |
| facts for the transcript / model | **entries** via `tx.write` (placed at a boundary when busy) |

`describe(task): JsonValue` turns checkpoint + slot into the rendering-shaped
status the view publishes; if omitted, the view shows `{ phase }`.

Example: a background repository indexer, resumable and observable.

```ts
type IndexInput = { root: string };
type IndexCheckpoint = { phase: "scanning"; cursor: string | null } | { phase: "writing"; batchKey: string };
type IndexSlot = { files: number; lastFile?: string; memos?: Record<string, JsonValue> };

export const indexer = defineTask<IndexInput, IndexCheckpoint, { files: number }, { reason: string }, null>({
  name: "repo.indexer",
  config: { rewindable: { indexIgnore: [] as string[] } },
  describe: (task) => ({ stage: task.checkpoint?.phase ?? "starting", files: task.slot?.files ?? 0 }),

  async initial(task, rt, ctx) {
    await rt.commit((tx) => { tx.slot(task).files = 0; tx.checkpoint({ phase: "scanning", cursor: null }); }, ctx);
    return scan(task, null, rt, ctx);
  },
  phases: {
    scanning: (task, rt, ctx) => scan(task, task.checkpoint.cursor, rt, ctx),
    // in-flight: only entered after a crash. The batch key was persisted before the effect; the write is
    // repeated with the same key and is safe only because writeBatch(key) is idempotent on the receiving side.
    async writing(task, rt, ctx) {
      await writeBatch(task.checkpoint.batchKey, ctx);
      return { next: { phase: "scanning", cursor: task.checkpoint.batchKey } };
    },
  },
  async abort() { return () => null; },
});

async function scan(task, cursor, rt, ctx) {
  const ignore = (await rt.rewindable(task.conversationId, ctx)).indexIgnore;
  const batch = await nextBatch(task.input.root, cursor, ignore, ctx);
  if (batch === undefined) {
    return { done: async (tx, current) => {
      await tx.write(current.conversationId, entries.notice, { model: [{ role: "user", content: `Indexed ${tx.slot(current).files} files.`, timestamp: rt.now() }] });
      return { status: "completed", result: { files: tx.slot(current).files } };
    } };
  }
  await rt.commit((tx) => tx.checkpoint({ phase: "writing", batchKey: batch.key }), ctx);   // idempotency key before the effect
  await writeBatch(batch.key, ctx);
  return { next: (tx, current) => {
    const s = tx.slot(current); s.files += batch.files.length; s.lastFile = batch.files.at(-1);
    return { phase: "scanning", cursor: batch.key };
  } };
}
```

Registered with `h.registerTaskKind(indexer)` before `resume()`; started with
`c.commit((tx) => tx.createTask(indexer, { root }, { background: true }), ctx)`
or from a tool via `api.task(indexer, …)`. The view shows
`tasks[id] = { kind: "repo.indexer", background: true, status: { stage, files } }`;
a UI renders it from that alone.

### 4.4 Custom entries

```ts
interface CiEntry extends Entry { kind: "ci.result"; data: { run: number; ok: boolean }; model: [UserMessage] }
const ci = defineEntry<CiEntry>("ci.result");

await c.write(ci, { data: { run: 812, ok: false }, model: [{ role: "user", content: "CI run 812 failed.", timestamp: now }] }, ctx);
const last = await c.commit((tx) => tx.newestEntry(c.id, ci), ctx);     // CiEntry | undefined
for (const e of view.entries) if (ci.is(e)) render(e.data.run);
```

Omit `model` for bookkeeping the model must not see. `head` and `edits` are
core-only. `defineEntry` throws on a `pi.*` name and `c.write`/`tx.write` reject
`pi.*` at runtime for non-core callers even after a cast, with one allow-listed
exception: `pi.notice` (one user message, optional `data`, no `head`/`edits`),
which hosts, jobs and tools use for notices. No entry registry or schema is
required. Placement is boundary-safe: immediately when idle, otherwise at the
next boundary (`view-and-events.md` §6.1).

### 4.5 Namespaces

```ts
const ns = h.namespace<{ planMode: { enabled: boolean }; cache: Record<string, string> }>(
  "plan",
  { rewindable: { planMode: { enabled: false } }, sticky: { cache: {} } },
  { view: (s) => ({ planMode: s.planMode }) },                 // only this projection reaches the view; `cache` never does
);
await c.commit((tx) => { tx.plugins(ns).planMode.enabled = true; tx.emit(ns, "toggled", { enabled: true }); }, ctx);
// view: plugins.plan.planMode; envelope: ["s", ["plugins","plan","planMode","enabled"], true] + { type: "plugin.plan.toggled", data }
env.own(ns.unregister);                                        // idempotent; state stays, token goes stale
```

Defaults are per document; a slice may span documents (`{ rewindable: …, sticky:
… }`) and `tx.plugins(ns)` returns the merged typed object with each key routed
to its document (same mechanism as core `config`). `view` is a pure projection
the kernel re-evaluates when the slice changes; without it the namespace has no
presence in the view. Re-registering the same string with changed defaults adds
new keys lazily and leaves removed keys as inert stored data.

### 4.6 Owned conversations and jobs

Subagents (`api.conversation`) and processes (`pi.job` via `api.task(kinds.job, …)`)
are core features with their own durability; extensions use them, they do not
extend them. See `pico-handoff-v2.md` §8, §10.5 and the hardening handoff §15.

## 5. Unregister, re-register, reload

Every registration can be undone and redone while the harness is open.

| contribution | on unregister | on re-register |
|---|---|---|
| namespace (`ns.unregister()`, idempotent) | token stale; `tx.plugins`/`tx.emit`/`h.hooks(ns, …)` with it reject | new token for the same string; stored state and memos untouched; new defaults seeded lazily |
| hooks | removed from future chains; a handler already running continues to completion (it is cancelled only by abort or `suspend`) | joins the chain |
| task kind | pending tasks of the kind are not dispatched (not orphaned; orphaning is open-time only); running invocations keep the kind object they captured | pending tasks dispatch with the new implementation; config keys re-checked |
| tool / section | revision bump; in-flight invocations keep their captured declaration; preparation snapshots retry | same |
| entry kind | nothing | nothing |

Reload replaces code, never durable state. Two modes, chosen by the host:

- **Quiescent reload.** `h.quiescent()` is true when the scheduler holds **no
  invocation**, running or sleeping: no phase handler, no `retrying`/`deferred`
  sleep, no job poll, no waiting `beforeTool`. Live task *records* may exist
  (pending, or between invocations). Then: `release = h.hold()` (defers new
  dispatch and new hook chains; commits and reads continue) → deactivate old
  facets (their disposals unregister) → activate new ones (re-register) →
  `release()`.
- **Suspend and reopen** when not quiescent (the first safe version for active
  work). `h.suspend(ctx)`: stop dispatch, cancel every in-process invocation
  context, await unwind, close storage; task records stay live and nothing is
  terminalized. Reopen with the new registrations and let ordinary recovery run:
  pre-effect phases rerun, `started` tools replay if safe and still safe, unsafe
  ones become interrupted results, other phases recover per their kind. Memos
  make reruns cheap (an approval already decided is not asked again). The
  injected `ProcessHost` must outlive the harness instance so running jobs
  reconcile through `status(key)` instead of becoming `unknown`.

Cancelling live calls of a tool or kind that the new generation no longer
registers is not a transparent migration: it durably aborts them, cannot undo
external effects, and post-tools observes aborted results. It is an explicit
host policy (`suspend({ abortRemoved: true })`), never the default. Generation
leases (old registrations kept alive until captured invocations drain while new
work uses replacements) are a possible later refinement; they are not required
for v1.

Registration belongs in `onActivate`, not `setup`: during a shape-preserving
reload the replacement's `setup` runs before the old facet is deactivated, and
two live registrations of one namespace string would collide.

## 6. The Chord layer

The coding agent composes the harness and its extensions as Chord facets
(`packages/agent/docs/plugins.md`). Nothing in §1–§5 changes; this section only
says which facet calls what.

### 6.1 Built-in facets (plumbing)

Provided once by the coding agent, consumed by every feature:

```ts
// session worker
export const Harness = defineService<HarnessHandle>("pi.harness", { local: true });   // the in-process handle from §3; never remote
export const ConversationService = defineService<{                                  // keyed by conversation id; remote
  view: ReplicatedState<ConversationView>;                                            // view-and-events.md; one publish per commit, on the line
  send(input: SendInput, ctx): Promise<Id>;  write(entry: NewEntry, ctx): Promise<Id>;
  inputAbort(id: Id, ctx): Promise<"aborted" | "already_placed" | "not_found">;
  configSet(patch: Partial<Config>, ctx): Promise<void>;
  abort(ctx): Promise<void>;  reset(handoff: string | undefined, ctx): Promise<void>;  collapse(instructions: string | undefined, ctx): Promise<Id>;
  fork(at: Id | "start", spec: ForkSpec, ctx): Promise<Id>;  entries(scan: EntryScan, ctx): Promise<Entry[]>;
}>("pi.conversation");

export const harnessSessionFacet = defineFacet({
  id: "@pi/harness",
  setup(env) {
    const conversations = env.provideMany(ConversationService);
    const handle = createHarnessHandle();                       // wraps Harness.open/resume/hold and the registration surface
    env.provide(Harness, handle);
    env.onActivate(async () => {
      await handle.open(storage, { models, processHost }, ctx);
      handle.onConversation((c) => {                            // existing at open, and every fork/subagent created later
        const view = env.replicatedState(c.snapshot());         // built on the line
        c.attachView(view);                                     // bounded ordered adapter: raw envelopes → view.state + publish(), off the line (below)
        env.own(conversations.spawn(String(c.id), { view, send: (i, cx) => c.send(i, cx).then((r) => r.id), /* … */ }));
      });
    });
    // resume() is called by the session worker after the facet host reports activation complete (all registrations done)
  },
});
```

`ConversationView` gains `commit: { events }` so events ride inside the
replicated member; a subscriber reads `value.commit.events` after each delivery.
No revision or storage sequence is placed in the view: Chord's
`ReplicatedStateDelivery.sequence` is contiguous per member and plays that role.

Publication must not happen on the Session line. Chord's `publish()` invokes
source and subscriber listeners synchronously and a subscriber may throw or be
slow, and `subscribe()` itself publishes pending mutations. The bridge is a
bounded ordered adapter: the kernel enqueues raw envelopes from its own view
tracker; the adapter, off the line, applies one envelope's ops to
`view.state`, sets `commit.events`, and calls `publish(ctx)` in the **same
synchronous block** (no await between apply and publish). One raw envelope =
one publish = one Chord sequence. If the queue overflows or `publish` throws,
close that keyed instance and respawn it with a fresh snapshot; a persisted Pico
commit is never turned into a failure. Chord's subscription snapshot then gives
late joiners the member at its current sequence, so §9 of
`view-and-events.md` is implemented by Chord, not by us.

### 6.2 A feature: contract + session facet + presentation facet

The rule from `plugins.md`: one shared contract module, one facet per host,
connected by service IDs. The session facet calls §3; the presentation facet
observes services and the view. Facets keep **no durable state**: everything
durable is in the harness through §2, and keyed service instances are channels.

**Approval** (hook + dialog service):

```ts
// contract.ts
export interface ApprovalRequest { conversationId: Id; callId: string; taskId: Id; name: string; args: JsonValue }
export type ApprovalDecision = { decision: "allow" | "deny"; by?: string };
export interface ApprovalDialog { readonly request: ReplicatedState<ApprovalRequest>; decide(d: ApprovalDecision, ctx: Context): Promise<void> }
export const ApprovalDialogs = defineService<ApprovalDialog>("pi.approval-dialog");   // keyed `${conversationId}:${callId}`

// session.ts
export const approvalSessionFacet = defineFacet({
  id: "@pi/approval",
  setup(env) {
    const harness = env.use(Harness);
    const dialogs = env.provideMany(ApprovalDialogs);
    env.onActivate(() => {
      env.own(installApproval(harness, (req, ctx) => {                       // §4.2, unchanged
        const completion = Promise.withResolvers<ApprovalDecision>();
        const close = dialogs.spawn(`${req.conversationId}:${req.callId}`, {
          request: env.replicatedState(req),
          async decide(d, _ctx) { completion.resolve(d); },
        });
        return awaitAbortable(completion.promise, ctx.abortSignal).finally(close);
      }));
    });
  },
});

// tui.ts
export const approvalTuiFacet = defineFacet({
  id: "@pi/approval",
  setup(env) {
    const tui = env.use(Tui);
    env.observe(ApprovalDialogs, async (dialog, ctx) => {                    // one task per open instance, incl. hydrated ones
      const r = dialog.request.value!;
      const modal = await tui.acquireModal(ctx.abortSignal);
      try { await dialog.decide({ decision: (await modal.confirm(`Allow ${r.name}?`, pretty(r.args))) ? "allow" : "deny", by: "tui" }, ctx); }
      finally { modal.close(); }
    });
  },
});
```

The decision memo (`api.memo("approval", …)`) is written by the hook in the
session worker, so `decide` only resolves the local promise; the first-writer
rule is applied where the durability is. A second client's `decide` resolves an
already-resolved promise: harmless.

**Question tool** (tool + dialog service): identical shape with `questionTool`
from §4.1 as the session contribution (`harness.registerTool(questionTool(ask))`)
and `ToolApi.memo` instead of `BeforeToolApi.memo`. This is the `packages/agent/docs/plugins.md`
question example with `memoOnce` replaced by the slot memo.

**Indexer** (custom kind, no service of its own):

```ts
// session.ts
export const indexerSessionFacet = defineFacet({
  id: "@pi/indexer",
  setup(env) {
    const harness = env.use(Harness);
    env.onActivate(() => { env.own(harness.registerTaskKind(indexer)); });   // before resume(): tasks may exist in storage
  },
});
// tui.ts: nothing to provide; render view.tasks[id].status for kind "repo.indexer" from ConversationService.view,
// and offer a /index slash command that calls conversation.commit-equivalent RPC (or a tiny IndexerService.start method).
```

### 6.3 What the session worker does at reload

```text
if (harness.quiescent()) {
  release = harness.hold()
  FacetHost.reload(candidates)    // old facets' env.own() disposals unregister; new onActivate re-registers
  release()
} else {
  await harness.suspend(ctx)      // cancel invocations, close storage; task records stay live
  FacetHost.reload(candidates)
  await harness.reopen(ctx)       // recovery runs against the new registrations
}
```

Durable state, task records and open conversations are untouched either way
(§5).

## 7. Tests the hardening must include

- Memo: two concurrent `api.memo` writers receive the same winner; `null` is a
  stored value (hasOwn, not `??=`); a crash after the memo skips `ask`, before it
  re-asks; the memo is gone after the tool task terminalizes; two namespaces
  using the same memo name on one task do not collide.
- Hooks: `await api.waiting(ctx)` sets `waitingOn` in its own commit and it is
  cleared atomically with `started`, with the synthetic result on block/throw,
  and in its own commit on abort/suspend; the decision memo survives a crash
  between `waiting` and `started`; memos never appear in the view.
- Custom kind: crash in the in-flight phase re-enters it and repeats the keyed
  effect (test with a fake idempotent sink and a crash between effect and the
  next checkpoint); `describe()` output appears in `tasks[id].status`;
  unregistered kind leaves pending tasks pending and orphans only at open.
- Namespaces: writes outside `plugins[ns]` reject; stale token rejects;
  `unregister` is idempotent; re-register keeps values and memos and seeds new
  defaults; only the `view` projection appears in the view; rewindable slice is
  inherited by a fork and readable at an entry.
- Entries: `defineEntry("pi.x")` throws; `write` of any `pi.*` except `pi.notice`
  rejects at runtime after a cast; `pi.notice` with `head`/`edits` rejects.
- Reload: `quiescent()` is false while any invocation exists (including a
  waiting `beforeTool` and a polling job); `hold()` defers dispatch and hook
  chains but not commits; suspend/reopen with the approval facet lets a pending
  call be approved through the new generation without asking twice when a
  memo exists; `ProcessHost` survives suspend/reopen and a running job
  reconciles.
- Chord: loopback facet tests for approval and question (session + presentation
  fixtures), late-joiner hydration of an open dialog instance, and
  `ConversationService.view` sequence equals commit sequence.
