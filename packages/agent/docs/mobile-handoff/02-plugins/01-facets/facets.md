# Plugin and Facet Architecture

> **Status:** Design specification. Supersedes the facet/service model in `plugins.md`
> where the two disagree. Read `rpc.md` for transport framing.

## 1. Shape of the system

A **plugin** is a package with up to three entry points, one per host kind:

```text
my-plugin/
  contract.ts    service tokens + JSON DTOs         (shared, no host imports)
  server.ts      server facet                        (optional)
  worker.ts      session-worker facet                (optional)
  tui.ts         presentation facet                  (optional)
```

Nothing links the entry points at runtime. They share only the tokens in
`contract.ts`. Each is built into a single JavaScript file by esbuild, pointed at
that entry.

A **facet** is the in-process unit: one object with a static manifest and one
construct function. A **host** is a process that assembles a facet graph — server,
session worker, or presentation.

The topology is a tree of connections:

```text
server
├─ TUI A
├─ web B
├─ session worker S0
└─ session worker S1
```

## 2. Tokens

A token is the identity of a service contract. It carries the service type as a
phantom, its stable ID, whether it is RPC-capable, and — critically — its **mode**.

```ts
type ServiceMode = "singleton" | "keyed" | "peer";

interface Service<T, M extends ServiceMode = ServiceMode> {
  readonly id: string;
  readonly mode: M;
  readonly rpc: boolean;
  readonly __type?: T; // phantom
}

function defineService<T>(
  id: string,
  options?: { rpc?: boolean },
): Service<T, "singleton">;

function defineKeyedService<T>(
  id: string,
  options?: { rpc?: boolean },
): Service<T, "keyed">;

/** One instance per connected peer; each peer sees exactly its own. */
function definePeerService<T>(
  id: string,
  options?: { rpc?: boolean },
): Service<T, "peer">;
```

The three modes differ only in how many instances exist and who sees them:

| mode | instances | consumer declares | consumer gets |
| --- | --- | --- | --- |
| `singleton` | one, shared | `uses` | the service |
| `keyed` | many, all visible to everyone | `observes` | one task per instance |
| `peer` | one per connected peer, visible only to that peer | `uses` | the service |

`peer` is the answer to per-client state (§10.2). It is not a fourth mechanism —
the host instantiates lazily per peer and announces to that peer alone — but the
consumer ergonomics matter: from a client's side there is exactly one, so it says
`uses` and calls it, exactly like a singleton. Watching a *set* of instances is
what `observes` is for, and per-client state is not that.

Mode lives on the token because it is a property of the contract, not a choice the
provider makes. This deletes an entire class of assembly error: a token cannot be
provided as a singleton and consumed as keyed, because there is nothing to declare.

Tokens are RPC-capable by default. `{ rpc: false }` confines a token to its
providing process; such tokens are never announced and never resolvable remotely.

## 3. Facets

```ts
const modelSelectionTui = defineFacet({
  id: "@pi/model-selection:tui",

  uses:     [Models, Tui],
  provides: [],
  observes: [],

  construct(ctx) {
    const models = ctx.use(Models);
    const tui = ctx.use(Tui);

    tui.commands.register("models.select", async (context) => { /* ... */ });

    return [];
  },
});
```

Three declaration fields, all pure token data, all readable without executing
anything:

- **`uses`** — singleton tokens this facet requires.
- **`provides`** — tokens this facet implements, singleton or keyed.
- **`observes`** — keyed tokens this facet watches instances of.

`construct` runs only after the kernel has validated the whole graph and
constructed every dependency. Everything `ctx.use()` returns is a **real object**,
never a proxy that becomes valid later. There is no phase during which a facet
holds something unusable.

**`construct` is synchronous.** It wires objects and returns provisions; it does no
I/O. Anything asynchronous registers through `ctx.onActivate`, which runs after the
entire graph is constructed, in dependency order. `ctx.onDeactivate` runs before
disposal in reverse order. Three phases, each with a single job:

| phase | sync? | may call dependencies? | purpose |
| --- | --- | --- | --- |
| `construct` | yes | no | wire objects, return provisions |
| activate | no | yes | I/O, subscriptions, initial fetches |
| deactivate | no | yes | orderly shutdown before disposal |

Keeping `construct` synchronous is what makes the ordering guarantee simple: a facet
cannot observe a half-built graph, because nothing runs until all of it exists.

### 3.1 Why not declaration-by-side-effect

`plugins.md` derives the dependency ledger from `env.use()`/`env.provide()` calls
made during a synchronous `setup()`. That avoids writing the manifest twice, but it
forces `use()` to return a disconnected lazy proxy — an object whose type is a lie
until assembly finishes. Every facet author then has to remember a rule the language
cannot enforce.

Separating declaration from construction costs one extra mention of each token and
buys:

- graph validation with **zero facet code executed** — decisive for third-party
  plugins, where a bad set should be rejected before it runs;
- honest types throughout construct;
- a facet whose entire surface is readable in ten seconds.

The duplication is eliminated by type checking (§4), so it cannot drift.

### 3.2 Construct context

```ts
interface ConstructContext<U, P> {
  /** Resolved singleton dependency. Only accepts tokens declared in `uses`. */
  use<S extends U[number]>(token: S): ServiceType<S>;

  /** Owner handle for a keyed token declared in `provides`. */
  owner<S extends KeyedOf<P>>(token: S): ServiceInstances<ServiceType<S>>;

  /** Host-built replicated state; see §9.2. */
  state<T>(definition: StateDefinition<T>, initial: T): MutableState<T>;

  /** Runs after the whole graph has constructed, in dependency order. */
  onActivate(fn: (context: Context) => void | Promise<void>): void;
  /** Runs before disposal, in reverse dependency order. */
  onDeactivate(fn: (context: Context) => void | Promise<void>): void;
}

interface ServiceInstances<T> {
  /** Invokes this facet's factory for `key`, registers it, announces it. */
  add(key: string): () => void;
}
```

`ctx.use()` is a typed lookup rather than a positional tuple or a named bag: no
invented labels, no positional matching, and passing an undeclared token is a
compile error.

Owner handles arrive through `ctx` rather than being returned, because they are
kernel-owned machinery that exists before the factory does. Construct receives
dependencies and its own handles; it returns implementations.

## 4. Return type and completeness

`construct` returns an array of entries built by two helpers:

```ts
function provide<T>(token: Service<T, "singleton">, impl: T): ProvideEntry<typeof token>;
function provide<T>(token: Service<T, "keyed">, factory: (key: string, scope: InstanceScope) => T): ProvideEntry<typeof token>;
function provide<T>(token: Service<T, "peer">, factory: (principal: Principal, scope: InstanceScope) => T): ProvideEntry<typeof token>;

/** Instance-lifetime equivalent of the construct context's state(). */
interface InstanceScope {
  state<T>(definition: StateDefinition<T>, initial: T): MutableState<T>;
}

function watch<T>(
  token: Service<T, "keyed">,
  handler: (instance: Instance<T>, context: Context) => void | Promise<void>,
): WatchEntry<typeof token>;

interface Instance<T> {
  readonly key: string;
  readonly service: T;
}
```

The union of tokens in the returned array must equal the union of `provides` plus
`observes` — mutual assignability in both directions, which gives both
**completeness** (nothing forgotten) and **no extras** (nothing undeclared):

```ts
type TokensIn<R extends readonly Entry[]> = R[number]["token"];

type CheckComplete<R extends readonly Entry[], Declared> =
  [TokensIn<R>] extends [Declared]
    ? [Declared] extends [TokensIn<R>]
      ? unknown
      : { __error: "missing implementation for declared token" }
    : { __error: "returned an undeclared token" };

function defineFacet<
  const U extends readonly AnySingleton[],
  const P extends readonly AnyService[],
  const O extends readonly AnyKeyed[],
  const R extends readonly Entry[],
>(facet: {
  id: string;
  uses: U;
  provides: P;
  observes: O;
  construct: (ctx: ConstructContext<U, P>) => R & CheckComplete<R, P[number] | O[number]>;
}): Facet;
```

Note this is an array of token/value pairs, not an object map. Tokens are objects,
and objects cannot be keys. String-ID keys reintroduce a seam between the token in
the manifest and a string literal in construct; unique symbols do not survive
`defineService`'s return type, collapsing to plain `symbol` and merging every key.
Pairing tokens with values in an array keeps each entry individually typed against
its own token and keeps completeness checkable.

> **Open:** error message ergonomics for `CheckComplete` need experimentation.
> The failure points at construct's return type, which is correct but not pretty.

### 4.1 Worked example

```ts
export const questionSession = defineFacet({
  id: "@pi/question:session",

  uses:     [Tools],
  provides: [QuestionDialogs],   // keyed token
  observes: [],

  construct(ctx) {
    const tools = ctx.use(Tools);
    const dialogs = ctx.owner(QuestionDialogs);
    const pending = new Map<string, PendingQuestion>();

    tools.add((draft) => {
      draft.set("question", {
        /* ... */
        async execute(_id, params, _u, _tc, invocation, context) {
          const completion = Promise.withResolvers<QuestionResponse>();
          pending.set(invocation.invocationId, { params, completion });
          const close = dialogs.add(invocation.invocationId);
          try {
            return toResult(await awaitAbortable(completion.promise, context.abortSignal));
          } finally {
            close();
            pending.delete(invocation.invocationId);
          }
        },
      });
    });

    return [
      provide(QuestionDialogs, (key) => {
        const entry = pending.get(key)!;
        return {
          request: entry.state,
          async submitAnswer(candidate, _context) { /* memoOnce, resolve */ },
        };
      }),
    ];
  },
});
```

The factory receives the key and closes over facet-private state. `dialogs.add()`
triggers it. Construct still runs exactly once.

## 5. Ordering and cycles

`uses` and `provides` are static, so the kernel computes a topological order over
facets **before running any of them**. Every facet is constructed after all of its
dependencies. Failures — missing provider, duplicate singleton owner, cycle — are
reported against the manifest with no facet code executed.

**Cycles between facets are rejected.** No ordering satisfies them, and the survey
of coding-agent features found no genuine construction-time cycle: tools and
providers are fan-in through contribution registries; hooks are the host calling
you; telemetry is a leaf; wrappers are ordered composition.

The cases that look circular are late *call-time* references, not construction
dependencies. Those get an explicit, visible escape hatch:

```ts
uses: [Tools, deferred(QuestionDialogs)]
// ctx.use(deferred(X)) returns () => X, resolved on first call, after assembly
```

Deferral is opt-in and rare, so the cost of a knot is local and legible rather than
being paid by every facet in the form of universally unusable proxies.

### 5.1 Same-facet composition

A facet's services share module and closure scope. Two services that need each
other are ordinary JavaScript: build both inside construct, wire the references by
hand, return both. Shared private state is a variable both close over. The kernel
is not involved and there is no intra-facet graph.

If two services in one facet need each other symmetrically, that is usually one
service with two faces, or one private object behind two facades.

## 6. Hosts, connections, and direction of authority

**A host may depend only on what it connects to, and connections form a tree.**
That single rule replaces any global sort and keeps the cross-process graph acyclic
without special-casing the server as "built-ins that are just there."

Each host sorts locally. Remote provisions are **leaves** — the upstream process
constructed them before announcing, so they are already satisfied by definition.

Concretely:

- A **session worker** connects to the server, so worker facets may `use` server
  tokens. This is required: a `spawn_subagent` tool needs the server's session
  management.
- A **presentation** connects to the server, so TUI facets may `use` server tokens.
- A presentation also consumes **session** services — but the provider from its
  point of view is the server, which routes. The server's catalogue simply grows
  when a session is attached.

There is no direct presentation↔worker connection.

### 6.1 The server never depends on a worker

The server must construct before any worker exists, so it cannot `use` a worker
service. Inverted flows use a **reporting registry**: the server provides a token
that workers push into.

```ts
// contract.ts
export interface SessionStatusReporting {
  report(status: SessionStatus, context: Context): Promise<void>;
}
export const SessionStatusReporting =
  defineService<SessionStatusReporting>("pi.session-status-reporting");

export interface SessionStatusView {
  readonly state: State<Record<string, SessionStatus>>;
}
export const SessionStatusView =
  defineService<SessionStatusView>("pi.session-status");
```

The worker `uses` the reporting token and pushes; the server aggregates into
replicated state; presentations read the aggregate. Dependencies still point
upward, data flows down.

This gets the lifecycle right for free: the aggregate exists immediately and is
empty; workers appear, register, and vanish; a crashed worker is an entry removal,
which the server already knows about because it owns the connection.

## 7. Facet delivery and generations

**A presentation ships with no plugin facets.** It has host services (`Tui`) and
nothing else. All plugin facets arrive over the wire as built bundles.

This dissolves the problem of a detached presentation holding unresolved
requirements: while detached there are no requirements, because there are no
facets.

Two generations, with different lifetimes:

| generation | source | lifetime | example |
| --- | --- | --- | --- |
| **connection** | server | the server connection | session picker |
| **attachment** | session worker | one attachment | question dialog, chat |

Switching sessions tears down and rebuilds only the attachment generation. The
picker keeps running throughout — which it must, since it is what triggers the
switch.

The attachment generation resolves against the connection generation (upstream
first, per §6). The reverse is forbidden: a connection-generation facet cannot
depend on an attachment-generation token, because the attachment can go away.

### 7.1 Why the worker chooses the presentation facets

Plugins may be **global** or live in a session's **working directory**. So the set
of TUI facets depends on where the TUI was started — same binary, different
capabilities per project.

The worker therefore knows which TUI bundles belong with it, and ships them through
the server on attach. The working directory is not merely a spawn parameter; it is
an input to the graph.

> **Security:** attachment-generation bundles are third-party code arriving from a
> project directory and executing in the user's presentation process. Trust policy
> for directory-local plugins is an open decision and must be settled before this
> ships.

## 8. Startup and handshakes

### 8.1 Presentation connect

```text
TUI → server: connect
server → TUI: catalogue of server RPC provisions + connection-generation bundles
TUI: assemble, validate, construct connection generation
```

### 8.2 Reaching a session

Three routes, converging on one attach:

| invocation | route |
| --- | --- |
| `pi` (bare, in a directory) | ask server to create a session for cwd |
| `pi --resume` | invoke the picker command at startup |
| `pi --session <id>` | attach directly |

`--resume` needs no special machinery: the picker is an ordinary command registered
by the server-sourced picker facet, and resume invokes it at startup instead of
waiting for a keystroke. Same code path either way.

Create carries the working directory, since the server needs it to spawn and the
worker needs it to resolve local plugins.

### 8.3 Attach

```text
TUI → server:   attach(sessionId)
server:         authorize; tear down previous attachment generation;
                bind routing to worker
server → worker: client attached (identity)
worker → server: catalogue of session RPC provisions + TUI bundles
server → TUI:    catalogue + bundles
TUI:             assemble, validate, construct attachment generation
worker/server:   hydrate state state values
```

The TUI's kernel validates once, with the worker's catalogue already in hand. There
is no provisional or degraded resolution state.

### 8.4 Worker startup

```text
worker → server: connect
server → worker: catalogue of server RPC provisions
worker:          load global + cwd-local plugins; assemble; construct
```

The worker's own dependencies on server tokens resolve here, before any attachment.

## 9. Replication primitives

Exactly three things cross a connection.

### 9.1 Service calls

Ordinary request/response. For actions (`select`, `submitAnswer`) and one-shot
reads of things that do not change (scrolling back into chat history). Nothing is
replicated. Arguments and results are strict JSON; `Context` is stripped by the
proxy and reconstructed at the endpoint.

### 9.2 Replicated state

One authoritative writer, many readers. The stream carries one base op batch followed by delta batches; the vocabulary is in [delta.md](../../01-harness/01-delta/delta.md).

Full-value replication is the degenerate configuration where the producer explicitly replaces or rebases on every update. It is not a separate primitive: Chord emits the root replacement op `r`.

#### State is plain TypeScript

Facets never write ops. A provider mutates its state object normally; the
framework's tracker (`delta.md`) records intent and emits ops.

```ts
// contract.ts
export const TranscriptState = defineState<TranscriptTail>("pi.transcript.tail");
```

```ts
const tail = scope.state(TranscriptState, initial);

tail.mutate((s) => {
  s.entries.push(entry);            // -> splice
  s.entries[0].text += chunk;       // -> append
  delete s.pending;                 // -> delete
});
```

No mutation map, no recipes, no declared operations, no Immer. There is no
`defineValueState` / `defineReducedState` split either — an earlier draft needed
one because reduced states carried typed deltas a differ could not recover, and
the tracker recovers them.

`mutate` is synchronous and takes no `Context`. A mutation is a pure state
transition: it calls nothing, cannot be cancelled, and has no caller identity to
consult. Authority is checked in the method that decides to mutate.

#### Ops never carry provider code

Consumers apply ops. They never see mutation names and never run provider code.

This matters for a specific reason: a consumer running provider code would have
to resolve a definition from a registry, making the fold depend on ambient
registration — a reload changes the answer for the same input. Ops remove that,
and make non-JS consumers trivial, since the applier is six verbs.

Consequences:

- mutation names are not part of the wire contract and appear in no member table,
  so there is no mutation-name version skew;
- a consumer needs no schema for arguments, only for the value in the root `r` op;
- `x = undefined` normalises to `delete`, since JSON has no `undefined`.

#### Wire protocol

The producer and applier use `Op[]`; a subscription carries encoded `WireOp[]`. There is no frame type and no `seq` in the payload: the SSE binding stamps `id:`, which is where transport
metadata belongs (`delta.md` §6).

`Op` and its encoding — six verbs, array paths, tuple form, second-use path interning — are specified in [delta.md](../../01-harness/01-delta/delta.md) §2 and §4. They are not restated here.

**A replacement is an op**, `["r", value]`. There is no frame discriminator. A batch whose first op is `r` is a **base batch**, and batch zero is always one. This collapses several things `plugins.md` treats separately:

- there is no distinct wire hydration shape — the snapshot is simply the first batch;
- snapshot buffering remains a local adapter detail rather than a second wire protocol;
- cold start, reconnect, provider reload, session switch, a sequence gap, and a
  fold that could not apply are **one code path**: send a fresh base batch.

That last item is why there is no `Rebase` type anywhere in this design.

The SSE `id:` is stamped by the host binding, starts at zero on every
subscription, and is contiguous. A consumer seeing a gap discards its replica and
resubscribes.

#### Resubscription is a base batch plus buffered batches

There is no cross-subscription resume and no `Last-Event-ID`. Resubscribing works
the way the harness already hands out lane state: snapshot the current value as
base batch zero, buffer whatever arrives while the client is catching up, then deliver the buffer as ordinary batches once it is ready.

That is the same two-phase shape as `AgentHarness.watch` — `snapshot` then
`start` — and it is a purely local detail of the provider binding, invisible on
the wire. A consumer sees a base batch followed by contiguous batches, exactly as on cold start.

Real resume would need a retained op log so a client could ask for "everything after seq N". We deliberately do not keep one: the durable form is a list of batches per *value* ([delta.md §9](../../01-harness/01-delta/delta.md#9-durable-form)), retired with its scope, not a per-subscription history. Buffering costs a bounded amount of memory for the duration of a handshake; an op log would cost unbounded disk forever.

The landed tracker emits structural ops without a serialized-size heuristic. Provider replacement, reconnect, and policy-driven recovery bounds call `replace()`/`rebase()` explicitly; those are the only sources of a root `r` batch.

#### The harness does not emit ops

The harness emits typed `HarnessEvent`s and always will. Ops appear one layer up.

A lane facet calls the harness in process, subscribes to typed events, and folds
them into **its own** state shape by plain mutation. The tracker turns that into
ops. The facet never writes an op and never thinks about paths.

This fold has to exist regardless, because **the replicated shape is a facet's
choice, not the harness's**. Emitting ops from the harness would not remove the
fold; it would only replace "events into state" with "ops into state, with worse
types", and it would make `LaneSnapshot`'s field layout the wire contract.

```ts
// packages/agent/src/harness/runtime/reducer.ts
export function reduceLaneSnapshot(view: LaneView, event: HarnessEvent): void;
```

Plain mutation, no Immer, no return value. See `harness-tools.md` §6.

#### Shaping state to avoid write amplification

Two rules, both consequences of the tracker recording intent:

- **Keep growing strings at stable paths** — one per content block, one per tool
  operation's output. A delta then touches exactly one path, which is also what
  makes path interning collapse it to a single integer.
- **No derived fields in replicated state.** A parsed value recomputed from a raw
  one is a fresh reference on every parse, so it ships as a whole-value `set` and
  duplicates information already present. Derive on demand instead
  (`message-update.md` §5.2).

An array of content blocks is fine: it takes one `splice` when a block appears and
then nothing. What changes afterwards is a string *inside* a block.

#### Requesting a state value

A provider asks the host to build the state value during `construct`. Facets never
construct one themselves, because the state value is a binding: the host owns its
subscriber table, revision stamping, and disposal.

```ts
interface State<T> {
  readonly value: T | undefined;                    // undefined until base batch zero
  subscribe(listener: (value: T) => void): void;   // returns nothing (§13)
}

// on ConstructContext and InstanceScope
state<T>(definition: StateDefinition<T>, initial: T): MutableState<T>;
```

Provider side:

```ts
export const transcriptSession = defineFacet({
  id: "@pi/transcript:session",
  uses: [Agent],
  provides: [Transcript],
  observes: [],

  construct(ctx) {
    const agent = ctx.use(Agent);
    const tail = ctx.state(TranscriptState, { entries: [] });

    agent.onEntry((entry, context) => {
      tail.append([entry]);
      if (tail.value.entries.length > TAIL_LIMIT) {
        tail.evict(tail.value.entries.at(-TAIL_LIMIT)!.id);
      }
    });

    return [
      provide(Transcript, {
        tail,
        page: (params, context) => archive.read(params.before, params.limit, context),
      }),
    ];
  },
});
```

A `mutate()` call advances the authoritative value **and** publishes the resulting ops — one statement, so the value and the wire cannot disagree. `replace()` publishes an explicit root `r` batch and is what reconnect, provider reload, resnapshot, and policy-driven recovery bounds use.

Consumer side:

```ts
export const transcriptTui = defineFacet({
  id: "@pi/transcript:tui",
  uses: [Transcript, Tui],
  provides: [],
  observes: [],

  construct(ctx) {
    const transcript = ctx.use(Transcript);
    const tui = ctx.use(Tui);

    transcript.tail.subscribe((tail) => render(tail.entries));   // base batch zero arrives here too
    tui.commands.register("transcript.older", async (context) =>
      render(await transcript.page({ before: oldestId(), limit: 100 }, context)),
    );

    return [];
  },
});
```

The consumer never sees opcodes. It receives values, and base batch zero is delivered as an ordinary update — so there is no separate "ready" callback and no hydration
branch in facet code.

#### Worked: adapting `AgentHarness.watch`

The real API is asynchronous throughout:

```ts
interface AgentHarness {
  lane(name: string, context: Context): Promise<AgentLane>;
  lanes(context: Context): Promise<LaneInfo[]>;
}
interface AgentLane {
  watch(context: Context): Promise<WatchHandle<LaneSnapshot>>;
}
interface WatchHandle<T> {
  snapshot: T;
  start(listener: EventListener): void;
  resnapshot(context: Context): Promise<T>;
  unsubscribe(): void;
}
```

`watch()` installs the subscription **and** captures the snapshot inside a single
`readLane` critical section, so both are taken under the same lock. Events arriving
before `start()` are buffered, then flushed. `resnapshot()` does the same with a
`markBoundary()` callback re-establishing where the stream resumes. That is exactly
the guarantee base batch zero needs, so the adapter is thin.

`LaneSnapshot` is per lane, so `Lane` is keyed — one instance per lane, each taking
its own `watch()`. The harness already filters by lane
(`event.type === "usage" || !("lane" in event) || event.lane === this.name`), so the
adapter does no routing.

Because `watch()` is async, **instance factories may be async**. The instance is
announced once the factory resolves; `add(key)` returns its closer immediately.

```ts
export const Lane = defineKeyedService<LaneView>("pi.lane");   // key = lane name

export const laneSession = defineFacet({
  id: "@pi/lane:session",
  uses:     [Harness],
  provides: [Lane],
  observes: [],

  construct(ctx) {
    const harness = ctx.use(Harness);
    const lanes = ctx.owner(Lane);

    ctx.onActivate(async (context) => {
      for (const info of await harness.lanes(context)) lanes.add(info.name);
    });

    return [
      provide(Lane, async (laneName, scope, context) => {
        const lane = await harness.lane(laneName, context);
        const handle = await lane.watch(context);          // phase 1: snapshot + subscribe
        // The facet's own shape, not LaneSnapshot. reduceLaneView is its code.
        const state = scope.state(LaneState, toLaneView(handle.snapshot));

        handle.start((event) => {                          // phase 2: buffered, then live
          if (event.type === "navigation_end") {
            void handle.resnapshot(context).then((fresh) => state.replace(toLaneView(fresh)));
            return;
          }
          state.mutate((v) => reduceLaneView(v, event));   // plain mutation; ops fall out
        });

        return { snapshot: state, setModel: (ref, ctx2) => lane.setModel(ref, ctx2) };
      }),
    ];
  },
});
```

Consumers declare `observes: [Lane]` and get one task per lane, each with its own
replica.

Four things to notice.

- **The `watch`/`start` handshake does not cross the wire.** It is a local detail of
  one adapter. Remote consumers see base batch zero, then ops. Mini's buffering dance
  disappears, because the harness already buffers between the two phases and the flush
  lands as ordinary mutations after the initial value.
- **The facet owns the replicated shape.** `LaneView` is the facet's, not the
  harness's — hence `toLaneView`. This is the point made above: the fold exists
  regardless, so the harness gains nothing by emitting ops itself.
- **Rebase never reaches consumers, and is not a type.** `navigation_end` is an
  ordinary event the adapter answers with `resnapshot()` plus `replace()` — the
  same base batch a reconnecting client receives. `markBoundary()` supplies the
  ordering. No reducer signals anything by returning a value.
- **`HarnessEvent` is not a wire format.** `message_update` today carries the full
  message *and* an `AssistantMessageEvent` holding a second copy *and* the delta,
  so shipping it would be worse than shipping a snapshot. See `message-update.md`.
  It never ships here, because ops travel.
- **Most of the union is already lane state.** `usage` folds into `stats.usage`; config
  `value_update` into `configuration.*`; `message_update` into
  `operation.streamingMessage`; `tool_start`/`tool_update` into
  `operation.runningTools`; retries into `operation.retry`. The state value is very
  nearly everything a presentation needs.

The three that do **not** belong in it are a useful test of §9.4:

| event | why not a mutation | where it goes |
| --- | --- | --- |
| `lane_created` | creates a lane, does not change one | `lanes.add(name)` — a new instance |
| `handler_error` | diagnostic; no late joiner needs it | events primitive |
| global `value_update` | not lane-scoped | state on whichever service owns that value |

Note `lane_created` is delivered on the lane event stream, so discovering new lanes
after startup requires a session-level watch rather than the per-lane ones above —
an open question in §16.

#### Host responsibilities

Everything below is host machinery, not facet API:

- stamping `seq` per batch within the provider binding, so business snapshots and ops carry no transport metadata;
- delivering a root `r` base batch before deltas on a fresh subscription;
- resetting each subscriber's encoder dictionary on that base batch;
- applying only consecutive batches, and requesting a fresh base batch after a gap, reconnect, or provider replacement;
- hardening values as they cross the boundary (§14.3);
- announcing the state value definition ID in the member table. Mutation names are
  **not** announced, because they never travel — ops are structural, so a consumer
  needs no knowledge of how a value was produced.

Two rules follow from the provider and every replica running the same fold:

> **A reducer's state must be part of the replicated value.** Anything accumulated
> beside it — the classic case being a raw JSON string being parsed incrementally —
> diverges on any consumer that did not run the producer's fold.

> **The durable path uses only host-owned reducers.** Plugin-interpreted data must be
> skippable, so an unreadable stream degrades that one value instead of failing the
> record that contains it.

Mutation-name version skew does not exist: mutations never cross a boundary, so
adding, renaming or removing one is not a breaking change. The version-skew surface
is the *value shape* alone, which the root `r` batch's schema describes.

Prefer several coarse state values to one large value. A cold replica has
`value === undefined`; that is local readiness and never crosses the wire.

### 9.3 Events

Fire-and-forget broadcast. No history, no durability, dropped on disconnect. For
presence, cursors, in-progress drags, transient notifications.

### 9.4 Which to use

> **Does a late joiner need it?**
> Yes → replicated state. No → event.

State: transcript, model catalogue, session status, chat tail, canvas document.
Events: who is typing, where someone's cursor is, an uncommitted stroke.

### 9.5 Worked: chat, and the tail/archive split

A chat room is not one state. It splits along the same line:

- **live tail** — last N messages as a state value. The first batch replaces with
  the window; appends and evictions are ops.
- **archive** — a plain service call returning a page of older messages. Immutable
  history, no liveness requirement, not replicated onto anything.

There is no `subscribe` method. Attaching to the state value *is* the subscription, and it
produces the snapshot, so the server registers the reader before it reads. That
closes the window between a query and a later subscribe, and means the server never
has to answer "what happened after an arbitrary client-supplied cursor" — the
class of race that client-chosen timestamps create.

The lane transcript is the same pattern: recent entries in the state value, older ones
fetched by query when the user scrolls up.

### 9.6 Worked: shared canvas

Document state is a state value; strokes are ops. Multi-writer is handled by
**optimistic apply with acknowledgement**, not CRDT:

1. client generates an op ID, applies locally as unacknowledged, sends it;
2. server accepts first-come-first-served and publishes the resulting ops;
3. client sees its own op ID return and promotes it to acknowledged.

Note this is the one place the single-writer assumption behind `delta.md` is
relaxed, and it is relaxed by serialising at the server rather than by merging.
The op vocabulary has no `test` verb precisely because there is no conflict model
to support.

In-progress drags never touch the document. They are events, keyed by peer,
latest-wins, dropped on disconnect — which is exactly why the events primitive
exists.

## 10. Peers, principals, and authority

### 10.1 Principals on the context

Every service method already takes a `Context`. The proxy strips it on the way out
and **reconstructs it at the endpoint**, so the kernel fills in the caller's
principal from the authenticated connection. It is control-plane data: never an
argument, never forgeable.

```ts
type Principal =
  | { kind: "local" }                                   // same process, full authority
  | { kind: "user"; peer: PeerId; userId: string; role: Role }
  | { kind: "process"; peer: PeerId; host: "worker" | "server"; sessionId?: string };

interface Context {
  readonly abortSignal: AbortSignal;
  readonly principal: Principal;
  // ...
}
```

There is exactly one `Context` type, and `principal` is always populated — the
same interface locally and across a connection, so a method body reads
`context.principal` without knowing which it was. That is the point: a service must
not have an unchecked path that only appears in-process.

Peers are not only humans — a worker calling the server through a reporting
registry is a peer too, and server facets often want to distinguish *my own worker*
from *some TUI*. In-process calls carry an explicit `local` principal rather than an
absent one, so a missing check cannot masquerade as a missing peer.

### 10.2 Per-peer services

**Authority-bearing state belongs on a `peer` service, not a singleton.** A
singleton has one value by definition, so it cannot show an owner and a guest
different roots — there is nowhere for the difference to live.

The provider declares the token `peer` and returns a factory. The host calls it
once per connected peer, passing that peer's principal, and announces the result to
that peer only. Each instance gets its own state values from its own `scope`.

The consumer declares it in `uses` and calls it. No `observes`, no reconciliation,
no set to watch — from a client's side exactly one instance exists, because exactly
one was ever announced to it.

### 10.3 Worked example: file browsing

```ts
// contract.ts
export interface BrowseRoot {
  readonly handle: string;   // opaque, per-principal, revocable
  readonly label: string;
}

export interface BrowseView {
  readonly roots: BrowseRoot[];
  readonly note?: string;    // e.g. "Ask the owner for wider access"
}

export const BrowseState = defineState<BrowseView>("pi.browse.view");

export interface FileBrowsing {
  readonly view: State<BrowseView>;
  list(handle: string, path: string, context: Context): Promise<DirEntry[]>;
}

export const FileBrowsing = definePeerService<FileBrowsing>("pi.file-browsing");
```

Server facet:

```ts
export const fileBrowsingServer = defineFacet({
  id: "@pi/file-browsing:server",

  uses:     [Fleet],
  provides: [FileBrowsing],
  observes: [],

  construct(ctx) {
    const fleet = ctx.use(Fleet);

    return [
      provide(FileBrowsing, (principal, scope) => {
        // One table per instance. Handles are minted here, so a handle a peer
        // was never given is not merely rejected — it does not exist for them.
        const table = new Map<string, string>();

        function publish() {
          const roots = rootsForPrincipal(principal, fleet).map((path) => {
            const handle = newHandle();
            table.set(handle, path);
            return { handle, label: labelFor(path) };
          });
          return roots.length > 0
            ? { roots }
            : { roots: [], note: "No browsable locations for this account" };
        }

        const view = scope.state(BrowseState, publish());

        return {
          view,

          async list(handle, path, context) {
            const root = table.get(handle);
            if (root === undefined) throw new ServiceError("forbidden", "unknown root");
            return readDirectory(root, path, context);
          },
        };
      }),
    ];
  },
});

function rootsForPrincipal(principal: Principal, fleet: Fleet): string[] {
  if (principal.kind === "local") return [ROOT];
  if (principal.kind === "user" && principal.role === "owner") return [ROOT, ...fleet.workspaces()];
  if (principal.kind === "user") return fleet.workspacesFor(principal.userId);
  return [];
}
```

TUI facet — note that it contains no permission logic at all:

```ts
export const fileBrowsingTui = defineFacet({
  id: "@pi/file-browsing:tui",

  uses:     [FileBrowsing, Tui],
  provides: [],
  observes: [],

  construct(ctx) {
    const browsing = ctx.use(FileBrowsing);
    const tui = ctx.use(Tui);

    tui.commands.register("files.browse", async (context) => {
      const view = browsing.view.value;
      if (view === undefined) return;

      if (view.roots.length === 0) {
        await tui.notify(view.note ?? "Browsing unavailable");
        return;
      }

      const root = await tui.select(
        "Browse",
        view.roots.map((r) => ({ label: r.label, value: r })),
        { signal: context.abortSignal },
      );
      if (root === undefined) return;

      let path = "";
      for (;;) {
        const entries = await browsing.list(root.handle, path, context);
        const chosen = await tui.select(
          root.label,
          entries.map((e) => ({ label: e.name, value: e })),
          { signal: context.abortSignal },
        );
        if (chosen === undefined) return;
        if (!chosen.isDirectory) return void open(root.handle, join(path, chosen.name));
        path = join(path, chosen.name);
      }
    });

    return [];
  },
});
```

An owner's `view` state carries both a machine root and workspace roots; a guest's
carries one or none. Same bundle, same code path, different data. The TUI never
branches on a role, never greys anything out, and cannot construct a handle it was
not given.

### 10.4 Server-side validation is still mandatory

The state governs rendering. It does not constrain the wire: a hostile client can
call any method with any argument, including one it never received.

`list()` therefore checks its handle against the instance's table. Prefer
**unforgeable handles over parsed paths** — a table lookup fails by construction,
where path validation invites `..`, symlink, normalisation and case-folding bugs.
Revocation is free: drop the entry and outstanding handles stop working.

Where an argument cannot be a handle, the method reads `context.principal` and
decides. The rule is that authority is checked at the provider, every time, no
matter what the client was previously shown.

### 10.5 The peers cell

Presence is replicated state the host provides:

```ts
export const ConnectedPeers =
  defineService<{ readonly state: State<Record<PeerId, Principal>> }>("pi.peers");
```

Server and worker facets read it to enumerate who is attached. A facet needs it
only for genuinely multi-peer features — a presence roster, a "3 viewers" badge.
Per-peer state does **not** need it, because `peer` mode handles instantiation and
teardown for you.

### 10.6 Keyed instances

`keyed` remains what it always was: many instances, all visible to every consumer,
each producing one abortable task under `observes`. Question dialogs are the
canonical case — three concurrent invocations produce three instances, and every
attached presentation sees all three.

An instance is addressed by `(service, key, generation, member)`, so its state values are
naturally per-instance. Reusing a closed key creates a new generation, so stale
proxies cannot address the replacement.

The distinction to keep straight:

- **Do I want all of them?** → `keyed` + `observes`.
- **Do I want mine?** → `peer` + `uses`.


## 11. The presentation surface

`Tui` is an ordinary singleton token, declared in `uses` and resolved through
`ctx.use` like any other. It is provided by the presentation kernel rather than a
plugin, so it sits at the root of the local sort, but facets cannot tell the
difference.

```ts
interface TuiHost {
  readonly slots: SlotContributions;
  readonly commands: CommandContributions;   // handlers take an AbortSignal; see §11.3
  readonly keybindings: KeybindingContributions;
  readonly toolRenderers: ToolRendererContributions;
  notify(message: string): Promise<void>;
  acquireModal(signal: AbortSignal): Promise<TuiModal>;
  select<T>(title: string, items: SelectItem<T>[], options: { signal: AbortSignal }): Promise<T | undefined>;
}

const Tui = defineService<TuiHost>("pi.local.tui", { rpc: false });
```

### 11.1 Slots

A slot is a named region of host chrome a facet may fill.

```ts
interface SlotContributions {
  /** Exclusive. A second claim on the same slot is an assembly error. */
  claim<P>(slot: string, factory: (props: P) => Component): void;
  /** Additive. Ordered by contribution order. */
  add<P>(slot: string, factory: (props: P) => Component): void;
}
```

```ts
ctx.use(Tui).slots.claim("footer", (props) => new FooterComponent(props, models));
```

`claim` is exclusive and a duplicate is an **assembly error, not last-write-wins** —
two plugins silently fighting over the footer is a bug that must surface at
validation, alongside missing providers and duplicate singletons.

Props are DTOs. A factory never receives the `TUI` or `Theme` instance, so a
component cannot reach back into host internals through its own arguments.

### 11.2 Mounting is host-owned

Facets do not mount or unmount. They contribute a factory; the host instantiates
it, tracks the mount against the contributing facet, and **unmounts it on
disposal** — restoring the built-in chrome for a claimed slot, or dropping the
entry for an additive one.

There is therefore no `dispose?()` on a contribution, and no teardown for a facet
author to forget. This is the same rule as §13: registration is ownership.

Two consequences fall out of the generation model in §7:

- **Attachment drop** — presentation facets consuming session services are
  disposed, so their mounts vanish and host chrome renders in their slots. Only
  connection-generation chrome reads attachment state.
- **Session switch** — attachment-generation facets are disposed and their mounts
  go with them; connection-generation mounts survive, so there is no flicker and
  no lost scroll state.

### 11.3 Contributions with in-flight work

§11.2 covers *removal*: the host tracks each mount against its contributing facet
and unmounts on disposal, so there is no teardown to forget. That is complete for
anything whose disposal is synchronous.

It is not complete for contributions that can be **executing** when their
contributor is disposed — the presentation analogue of an in-flight tool call
(§13.2). Three cases, and only one of them is hard.

**Synchronous callbacks are free.** A keypress handler, a render call, a click
listener. JavaScript is single-threaded, so a handler runs to completion before
disposal can be scheduled — disposal cannot interleave with a synchronous frame.
Deregistration is a list removal. Nothing further is needed, and this is most of
the surface: slots, keybindings, tool renderers, theme tokens.

**Modals and pickers already carry a signal.** `acquireModal(signal)` and
`select(title, items, { signal })` take an `AbortSignal` because the host may need
to dismiss them. Disposal aborts it, the promise rejects, and the facet's
`await` unwinds. The mechanism exists; disposal just has to use it.

**Async command handlers are the hard case**, and they are exactly a tool call in
different clothing:

```ts
ctx.use(Tui).commands.add("deploy", async (args, signal) => {
  await longRunningThing(signal);
});
```

The user runs `/deploy`, the facet is disposed ten seconds later, and the handler
is still awaiting. So `CommandContributions` is a registry with in-flight work and
takes the same four phases as the tool registry: deregister, signal, race the
kernel deadline, and settle by outcome — here dismissing any progress UI and
restoring host chrome rather than producing a `ToolResultMessage`.

Two consequences for the API:

- **A command handler receives an `AbortSignal`.** Not optional. Without it the
  registry can deregister but cannot signal, and phase 2 is unavailable.
- **The host renders command progress, not the facet.** If a facet paints its own
  progress and is disposed mid-command, the paint outlives the painter. Host-owned
  progress is removed with the mount, which is the §11.2 rule applied to a case
  §11.2 did not name.

The rule this generalises to:

> A contribution registry needs settlement machinery **iff** a contribution can be
> mid-execution across disposal. Synchronous contributions never can; anything
> handed an `AbortSignal` always can.

Which makes the signal the marker. A registry whose contributions take a signal
owns invocation tracking and a deadline; one whose contributions do not is a plain
list and disposal is a removal.

### 11.4 Reload

Reload is unload plus load, so mounts are torn down and rebuilt by the same path.
Cross-host reload is two-phase, so no facet is ever alive with a dead provider:

```text
1. server → presentations with dependent facets: dispose, ack
   (the provider is still ALIVE, so in-flight calls abort against a live peer)
2. server → session worker: dispose + reload
3. server → presentations: load
race(acks, 2s); a presentation that misses the window goes degraded,
which disposes those facets anyway.
```

Calls carry a caller generation and the provider drops retired ones. Because a
reload is a round trip to every connected presentation, it stays user-initiated —
it must not be wired to a file watcher.

## 12. Contribution registries

Services are one owner, many consumers. Providers and tools invert that: many
contributors, one host-owned result. A registry replays ordered contributions over
a fresh working copy, so removal is a rebuild rather than an inverse mutation.
(Unrelated to the tracker in `delta.md`; nothing here is replicated.)

```text
fresh working copy
→ built-in providers      (@pi/providers-builtin)
→ remote catalogue        (@pi/providers-catalog)
→ models.json transform   (@pi/providers-models-json)
→ auth/availability mark  (@pi/auth)
→ validated state
```

Tools additionally support ordered wrapping — `telemetry(permission(sandbox(bash)))`
— which recomposes deterministically when a contributor disappears. Only the host
finalizes a draft; facets never call `setTools()`.

Slots, commands, keybindings, and tool renderers (§11) are all instances of this
same shape on the presentation host.

**Registries split by whether a contribution can be in flight.** A registry whose
contributions are values — slots, keybindings, theme tokens, tool renderers — is a
list, and disposal is a removal (§11.2). A registry whose contributions are
*invoked and take an `AbortSignal`* — tools, commands — owns invocation tracking, a
signal chained from the caller's, and settlement against the kernel's disposal
deadline (§13.2). The signal in the contribution's signature is the marker for
which kind it is.

Contributions configure rebuilt behaviour; hooks intercept live operations. They
remain separate mechanisms.

## 13. Lifecycle, failure, disposal

- Construct in dependency order; dispose in reverse.
- A facet owns its provisions, keyed instances, and observations. Ownership is
  **implicit**: every handle a facet receives is a host-built binding that
  registers its own disposer, so `subscribe`, `on`, timers, and instance handles
  are released with the facet. There is no `own()` and nothing to remember.
  This covers handles the host hands over; it does not cover ambient authority a
  facet can reach without being handed anything (§14.3).
  Consequently `subscribe()` returns nothing — there is no unsubscribe handle to
  hold or leak.
- Admitted inbound calls may finish while their provider deactivates; withdrawal
  rejects new calls.
- Disconnect aborts in-flight requests and closes that peer's subscriptions and
  instance tasks. It must **not** perform service-owned or durable cancellation.
- Three cancellation domains stay distinct: per-invocation, service-owned
  (`job.cancel()`), and durable Harness (`requestAbort()`).
- Never blindly replay a mutation after an uncertain disconnect. Reconnect,
  hydrate, reconcile — or design around a stable operation ID.
- Errors cross as `{ code, message }` with stable codes; unexpected exceptions
  become `internal_error` with no stack.

Reload: shape-preserving replacement by `Facet.id` is permitted when the
replacement declares an identical manifest. Because the manifest is static, this
check happens **before** constructing the candidate — a real improvement over
validating shape by running setup. Structural changes require graph reassembly or a
process restart.

### 13.1 Teardown, not swapping

The alternative is a proxy per dependent, swapping the implementation behind
consumers so they are never torn down. It is rejected, and the prior art is
unusually clear.

**OSGi ships both.** Bundle refresh computes the transitive closure of everything
wired to the old exports and restarts it; Declarative Services also offers
`ReferencePolicy.DYNAMIC`, where a consumer keeps running across a swap. Their own
guidance makes `STATIC` the default, because dynamic requires every consumer to be
defensive about the service vanishing mid-call.

**Cordis is the proxy model, and the ergonomics show.** `ctx.get(name)` returns
`undefined` when absent and the guidance is to *"handle their absence"* — the
defensive check is the recommended path. `inject` opts *into* teardown: the plugin
enters waiting and is reactivated when the service returns.

**JS HMR is this design with one addition.** Updates propagate up the import graph
until a module calls `import.meta.hot.accept()`; if nothing accepts, full reload.
React Fast Refresh bails to full reload when a hook signature changes — the same
conclusion, reached from a different direction: implementation swaps survive, shape
changes do not.

**Erlang is the counterexample and it does not transfer.** Two module versions
coexist and `code_change/3` migrates state at the transition. That works because
contracts are messages rather than types, so a process can handle both shapes
during changeover, and because isolation means there is no shared state to
reconcile. Neither holds here.

Three specific objections, in increasing order of severity:

**Contract changes.** JVM HotSwap permits method bodies only; DCEVM and JRebel go
further and still break on shape change. We are better placed than any of them,
because a token's `protocol` block carries a TypeBox schema and `CheckComplete`
already does mutual assignability — so a swap *could* be gated on the new
provider's schema being assignable both ways. This is the one objection we can
actually answer.

**In-flight registrations.** A tool contributed by the old provider may be
mid-execution. It cannot be cancelled (side effects have happened), handed over
(different closure), or allowed to settle into a registry that no longer contains
it. A proxy does not help: the invocation is bound to the implementation that
started it. §13.2 is required either way, which is most of why the proxy earns
nothing.

**State.** This is the one with no answer. A facet holds a replica derived from the
old provider's stream. After a swap it is either stale — silently wrong — or the
new provider sends a base batch, which *is* a resubscribe. The state was torn down;
only the facet was not. Erlang solves this with an explicit migration hook, which
is Erlang's design without Erlang's isolation.

**Cached references make the proxy worse, not better.** Cordis's guard lives on the
access path, not on the value: `ctx.foo` throws if the service is gone, but a
reference you stored keeps working and calls into the dead plugin's closure. Our
`ctx.use(Token)` returns a value at construct time by design, so we have the same
hazard — and teardown-of-dependents is what makes it safe, because the holder dies
with the provider. A proxy does not fix cached references; it makes them silently
wrong instead of impossible.

> **Deferred, not adopted.** If teardown ever proves too coarse, the addition is
> HMR's `accept()` rather than OSGi's dynamic policy: a per-dependency opt-in,
> `uses: [Harness, accepts(Models)]`, meaning *my acquisition can be re-pointed, I
> derive no state from this provider, and I hold no in-flight registrations against
> it*. The kernel would permit the swap only if the schema check passes and
> silently fall back to teardown otherwise. **Teardown must remain the path that
> always works**; the moment `accepts` is load-bearing for correctness, every
> consumer is writing defensive code again.
>
> Worth measuring the cost of teardown before building it. If disposing a
> presentation facet is a repaint, the mechanism buys nothing.

### 13.2 Disposal with in-flight work

Disposal removes a registration. That is sufficient for a service, and **not** for
a registry whose contributions can be executing when their contributor goes away.

The forcing constraint is settlement, not cleanup: the harness owes the model a
`ToolResultMessage` for every call it started. "The facet went away" is not a
result, and an operation waiting on one hangs.

Neither reference system solves this. Cordis's `_unload` is
`await Promise.all(disposers)` with a try/catch and no deadline — a disposer that
hangs hangs the reload. DSH goes further and places the obligation on the tool
author: async work must *"observe or forward `exec.signal` and settle only after"*
reaching *"quiescence"*, with the registry rechecking cancellation afterwards. That
is the settlement concept Cordis lacks, but it is stated in prose and enforced by
nothing, so a tool that ignores its signal still wedges the unload.

**Four phases, and the last two are what neither system has:**

1. **Deregister.** The contribution leaves the registry immediately. Synchronous,
   cheap, and it stops the problem growing.
2. **Signal.** Abort each in-flight invocation.
3. **Race a deadline.** Kernel-imposed, on every disposer.
4. **Settle by outcome.** At expiry the registry resolves *its own* promise with an
   aborted outcome and abandons the contributor's, attaching a catch and dropping
   the reference. The harness sees an ordinary aborted invocation and its existing
   `abortedMessage` path produces the result. No new settlement machinery.

Phase 4 is what makes the deadline safe rather than a leak with extra steps: **the
invocation settles even when the contribution does not.**

**Layering.** The kernel knows facets and contributions, not invocations, so it
bounds disposal generically: every disposer gets a deadline, and one that overruns
is logged and dropped. A registry with in-flight work is what makes that deadline
meaningful, because only it knows a call is outstanding.

The signal is **registry-owned and chained** from the harness signal, never the
harness signal itself — so deregistering one tool aborts that tool's invocations
without cancelling the operation. DSH's warning that *"replacement cannot detach
caller cancellation"* is about exactly this; the chain must be one-way.

**Invocation tracking belongs to the registry, not the contributor.** A facet could
track its own outstanding calls and signal them, but then a buggy or hostile facet
has no bound at all. Every invocation already routes through the registry, so it
can hold the signal and the count without trusting anyone.

**What the deadline actually guarantees, stated honestly:** disposal completes in
bounded time and the kernel holds no reference afterwards. **Not** that the bundle
is collected. If the abandoned contribution has a live interval, an open socket, or
a pending child process, its own async work still references the closure and the
compartment stays alive. We can bound our retention; we cannot bound the runtime's.
The only real fix is process isolation, where teardown is a kill — which is why
Erlang supervisors terminate rather than negotiate, and why OSGi `refresh` can hang
on a bundle that will not stop.

## 14. Isolation and trust

Condensed; a full treatment lives in the isolation spec. Recorded here because it
constrains the API surface above.

### 14.1 Threat model

**A malicious server ships a facet to an unsuspecting client.**

§7 states that a presentation ships with no plugin facets and that all of them
arrive over the wire as built bundles. So third-party code executes in the user's
process by design, and connecting to a server is not consent to run its code. The
victim is the *user*, with their filesystem, their credentials, their SSH keys —
not the operator.

An earlier draft scoped this to "a careless plugin author, not a hostile one",
with a determined attacker explicitly out of scope. **That was wrong** and it
selected the wrong mechanism. The attacker is hostile, the delivery is remote, and
the target is a workstation.

**Availability is not in scope.** A malicious server can already refuse to serve,
hang, or send garbage; crashing the client is a subset of that. What must be
prevented is **disk access and exfiltration**.

That asymmetry decides several things below, and it is the reason this section is
shorter than a general sandboxing treatment would be.

### 14.2 Mechanism: a V8 isolate behind a string-only membrane

Facet code runs in an `isolated-vm` isolate. Measured behaviour, not inference —
see the sandbox PoC:

```
require / process / fetch     undefined
globals visible               64
Function("return process")()  undefined
spinning guest                interrupted at its timeout, isolate reusable after
```

**What was rejected, and why.**

*SES / `lockdown()`* — an earlier draft chose this. It hardens intrinsics but
leaves guest and host **in the same VM**, which is precisely the class Figma's
Realms shim failed on: "confusing an object from outside the sandbox with an
object from inside... possible because the shim uses the same JavaScript VM for
all code both inside and outside". Figma shipped Realms, was breached within two
months, and moved to a different VM. Choosing SES repeats their first attempt.

*Node `worker_threads`* — `terminate()` is a genuine kill (3 ms on a tight loop),
but a worker has full `fs`, `env` and `child_process`. Node's `--permission` model
does apply inside workers, but Node documents it as a **"seat belt"** that
"malicious code can bypass", and it does not inherit per-worker. Availability
without authority is the wrong half for this threat model.

*Deno workers* — `permissions: "none"` gives real per-worker authority reduction,
verified. But `terminate()` does **not** stop a spinning worker: 2990 ms of CPU
over 3 s wall, measured after terminate. And it is a runtime switch.

*QuickJS-WASM* — a genuinely different VM, so object confusion is impossible, and
it is what Figma shipped. Rejected on two measurements: **8–17× slower** (300
markdown components repaint in 1118 ms versus 108 ms), and **no `Intl`**, which
`packages/tui` needs for grapheme segmentation in every width calculation. It
remains the fallback if a native addon is unacceptable.

*ShadowRealm* — same thread, same VM, and its own explainer disclaims being "a
full spectrum mechanism against security issues". Not a successor for this
purpose.

**The membrane is what makes `isolated-vm` safe, and it is structural.**

`isolated-vm` can be used unsafely, and an earlier draft rejected it for exactly
that: handing the guest a live handle via `derefInto()`, or returning a
`Reference` from a host call, lets the guest walk that object's prototype chain
into the host realm. (The draft also called the project "maintenance mode" — that
is out of date; releases run 6.0.1 in Jul 2025 through 7.0.1 in Aug 2026.)

The membrane forecloses it by construction rather than by care:

1. `encode()` is the only path from host to guest, and it is `JSON.stringify`
   with a replacer. **Its output is a string.** A string cannot carry a reference.
2. Host callables never cross. They become an integer id into a host-side table.
   The guest receives a **number**.
3. Exactly **one** `Reference` reaches the guest — the single call-in point — and
   its `deref()` throws cross-isolate.
4. `derefInto()` is used once, on the guest's **own** global. No host object is
   ever its argument.

The guest's entire view of the host is `{ number, string }`. There is no object
graph, so there is nothing to walk. Audited: `deref`, `copySync` and `getSync` all
blocked; `derefInto()` yields an inert marker that is not callable and exposes no
host globals.

**One isolate, N contexts** — not one isolate per facet. Contexts give separate
globals, and a timeout on one context leaves the others running. They share a
`memoryLimit`, so one facet's allocation bomb disposes the isolate and every
context in it — which does not matter here, because availability is out of scope
(§14.1). The cost difference is real: **164 KB per context versus 1124 KB per
isolate**.

A facet that must survive its neighbours — host chrome running as a facet — takes
its own isolate. That is a per-facet decision, not a global one.

**Limits worth knowing.**

- **Budgets do not nest.** A timeout bounds one evaluation. A guest function
  re-entered *by the host* — a contributed callback, a component method — gets its
  own budget, not the outer one. Bounding total facet time needs separate
  accounting.
- **References release, but lazily.** The membrane interns by id with `WeakRef`
  plus a `FinalizationRegistry`, which both gives identity across crossings and
  releases on collection. Finalization is not prompt, so **do not create
  references in a hot path**: a factory registered at construct is one reference
  forever; a component method returning a fresh closure each frame is one per
  frame.
- **Native addon.** Prebuilds cover linux-x64/arm64, darwin-arm64 and win32-x64
  for Node 22 and 24 only; anything else falls back to a source build needing
  Python and a toolchain. Shipping SEA builds moves that from every user's install
  to CI.
- **Still one engine.** A separate isolate is a far stronger boundary than SES,
  but it is not Figma's "different VM" claim. The guarantee here is V8's isolate
  boundary plus the membrane's discipline.

### 14.3 Ambient authority defeats registration-is-ownership

§13 states that every handle a facet receives is a host-built binding that
registers its own disposer, so there is nothing to remember. That holds for
handles the host *hands over*. It says nothing about authority a facet can reach
**without** being handed anything: `setInterval`, `process.on`,
`document.addEventListener`, a WebSocket.

Registration-is-ownership is a property of the API surface, and it is only as
complete as the surface is exclusive. Where a facet has another way to reach the
outside world, disposal is back to author discipline — exactly the position §13.1
criticises Cordis for (*"do not assume unload automatically removes arbitrary
third-party callbacks"*).

How complete we can make it is **not uniform**, and pretending otherwise would be
the wrong kind of tidy.

**Session and server facets: closable, and this argues for compartments.** They run
in Node with full ambient authority today — a facet can `import` timers, `fs`,
`net`. Inside a compartment with no module access, the only globals are the ones we
endow, so an endowed `setTimeout` that registers its own disposer is the *only*
`setTimeout`. That is a real argument for resolving the open question above toward
compartmenting session facets, on ergonomics rather than on trust.

**TUI: closable for the same reason.** A presentation facet already gets a
compartment (§14.2) and reaches the terminal only through the `TuiHost` facade.
There is no ambient terminal to grab. Endow timers the same way and the surface is
exclusive.

**Web: not closable, and it is worth being explicit about why.** The DOM is an
ambient mutable graph reachable from *any node in it*. Hand a component one
element and it has `ownerDocument`, `parentNode`, `window` — and from there
`addEventListener`, `MutationObserver`, a detached subtree that outlives its
mount. `lockdown()` does not help: the escape is not a prototype, it is a live
object graph we deliberately gave away.

Two mechanisms would actually close it, and both cost more than the problem is
currently worth:

- **An iframe per facet.** Real isolation, `postMessage` boundary, teardown is
  removing the frame. VS Code does this for webviews. The cost is no shared DOM:
  styling, layout, and focus all become protocol.

  Figma goes further and is worth studying, because it is the strongest form of
  "make the surface exclusive". They split by *capability*: plugin logic runs in
  QuickJS-on-WASM with the scene graph and **no browser APIs at all**, while UI
  runs in an iframe with browser APIs and **no scene access**, connected by
  `postMessage`. Plugin code never touches the DOM — not "sandboxed DOM access",
  no `document` in the environment. That is what lets them guarantee cleanup.

  Two things to take from their history. They shipped **Realms** first and it was
  found insecure within two months, which is the same escape class §14.2 cites for
  rejecting `isolated-vm` — production evidence rather than inference. And the
  QuickJS cost is real: practitioners report *"truly impenetrable errors"* and a
  badly degraded debugging story, which §14.2 should weigh when it names QuickJS as
  the upgrade path. As one put it, sandboxing is a thing *"everyone wants, but
  there are so few examples of it actually ever working."*
- **Declarative-only components.** The facet never receives a node — it returns a
  description and the host reconciles. §11.1 already points this way (*"props are
  DTOs; a factory never receives the `TUI` or `Theme` instance"*), and extending it
  to *never receives a DOM node* would hold. But it rules out refs, and therefore
  most component frameworks worth using.

**So the rule is: make the safe path the easy path, and do not pretend the escape
is closed.**

Provide `ctx.dom.on(el, event, fn)` and `ctx.timer.every(ms, fn)` that register
their own disposers, and make them the obvious way to do the thing. §14.1's threat
model is a *careless* author, not a hostile one, and a careless author uses the
ergonomic path. The escape remains reachable; it just is not the one you fall into.

Where the surface can be made exclusive — session, server, TUI — enforce it with
endowments rather than relying on the ergonomics. Where it cannot — web — document
that facet authors own their own DOM cleanup, and treat the iframe as the upgrade
path if the threat model ever moves from careless to hostile.

This is the same shape as §14.2's isolate decision: take the mechanism that fits
the current threat model, name the stronger one, and record what would trigger
moving to it.

### 14.4 Consequences for the API

Isolation does not change the shapes in §3–§4, but it fixes three things that would
otherwise be conventions:

- **Ownership is implicit.** Every handle a facet receives is a host-built binding
  that registers its own disposer. Hence no `own()`, and `subscribe()`/`on()`
  return nothing — there is no unsubscribe handle to hold, and therefore none to
  leak. Local `{ rpc: false }` services are the exception: they hand back the raw
  implementation with no interception and no auto-disposal.
- **Every object a binding returns is itself a binding** — host-built, plain
  prototype, hardened, registering its own disposer. This is the invariant that
  makes the previous point hold transitively.
- **Borrowed immutable JSON is enforced, not advised.** Values are hardened as they
  cross the boundary and rejected if unfrozen, so §9's no-clone rule is safe rather
  than a documented hope.

  This does **not** extend to a replica's internal buffer. `apply` from `delta.md`
  mutates a plain object in place and would throw against a frozen one, so the host
  keeps the replica mutable and hardens only the value it hands to a facet through
  `State.value`. Freezing happens at the binding, not at the buffer. The same rule
  governs the producer side: the tracker proxies a mutable object and hardens what
  it exposes.

Facets are built with `await` compiled to generators, so the host owns resumption.
Disposal then stops three distinct things, none of which subsumes the others:
cancel the scope's root context (stops the **operation**), unwind the driver
(stops the **continuation**, running every `finally` and no `catch`), then release
registrations in reverse (stops the **effects**).

Endowments are minimal: `Date` and `Math` are replaced with clock-backed versions,
timers return opaque integers and are scope-owned, `process` and `console` are
shape-only stubs, and `fetch`, `Buffer`, `require`, and `process.exit` are never
endowed. **Network access is a binding, never an endowment.**

## 15. Protocol: exposing services to foreign clients

Everything above assumes both ends are TypeScript compiling against the same tokens.
A browser, a script, or another language cannot do that — it needs a description it
can fetch.

**Schemas are opt-in and per service.** Most plugins never expose anything, and pay
nothing. A service with no `protocol` block is in-process and native-RPC only: it is
absent from the catalogue and the HTTP router returns `no_such_member`.

### 15.1 Declaring a protocol

```ts
import { object, array, string, int, oneOf, literal } from "@pi/schema";

export const TranscriptEntry = object({
  id: string(),
  role: oneOf([literal("user"), literal("assistant")]),
  text: string(),
});
export type TranscriptEntry = Static<typeof TranscriptEntry>;

export const TranscriptState = defineState<TranscriptTail>("pi.transcript.tail", {
  schema: object({ entries: array(TranscriptEntry) }),
});

export interface Transcript {
  readonly tail: State<TranscriptTail>;
  page(params: { before: string; limit: number }, context: Context): Promise<TranscriptEntry[]>;
  subscribeRaw(sink: (e: TranscriptEntry) => void): Unsubscribe;
}

export const Transcript = defineService<Transcript>("pi.transcript", {
  protocol: {
    methods: { page: { params: object({ before: string(), limit: int() }),
                       result: array(TranscriptEntry) } },
    state:   { tail: TranscriptState },
  },
});
```

`page` and `tail` are published. `subscribeRaw` is absent from `protocol`, so it is
local — nothing marks it, and publishing it later means adding one entry.

Only the state **value** needs a schema, for the root `r` batch. Mutations do not,
because recipes never leave the provider (§9.2) and ops are structural.

Method parameters are a single object, not positional. Names then survive into the
TypeScript signature, into the JSON Schema as `properties`, and into the request body,
and adding an optional field does not change arity.

`@pi/schema` re-exports TypeBox constructors as free functions so declarations stay
readable. They are functions rather than constants because TypeBox schemas are mutable
objects and a shared constant would alias into every schema referencing it.

### 15.2 The protocol must match the type

A schema that drifts from the interface is the failure this design exists to prevent,
so it is checked, with the same mutual-assignability technique as `CheckComplete` (§4):

- every key in `protocol.methods` must exist on the service interface — a typo is a
  compile error, not a silently unpublished member;
- for each, `(params: Static<P>, context: Context) => Promise<Static<R>>` must be
  assignable to the interface member and vice versa;
- every key in `protocol.state` must be a `State<T>` member whose `T` matches the
  definition's value schema.

Omission is always legal. Omission is the feature.

### 15.3 Routes

```
GET  /v1/catalogue
POST /v1/call/{service}/{member}
POST /v1/call/{service}/{key}/{member}          keyed instance
GET  /v1/state/{service}/{member}               SSE
GET  /v1/state/{service}/{key}/{member}         SSE
```

`peer` services take no key: the server resolves the instance from the authenticated
session, so a client cannot address another peer's (§10.2).

**Catalogue**

```json
{ "version": "1",
  "services": {
    "pi.transcript": {
      "mode": "singleton",
      "methods": { "page": { "params": { "$ref": "#/definitions/PageParams" },
                             "result": { "type": "array",
                                         "items": { "$ref": "#/definitions/TranscriptEntry" } } } },
      "state": { "tail": { "value": { "$ref": "#/definitions/TranscriptTail" } } }
    }
  },
  "definitions": { "TranscriptEntry": { "type": "object", "properties": { "...": {} } } } }
```

**Call**

```
POST /v1/call/pi.transcript/page
{ "before": "entry_88", "limit": 50 }

200 { "result": [ { "id": "entry_87", "role": "assistant", "text": "..." } ] }
403 { "code": "forbidden", "message": "unknown root" }
404 { "code": "no_such_member" }            ← unpublished members land here
422 { "code": "invalid_params", "message": "limit: expected integer" }
```

**State over SSE**

```
GET /v1/state/pi.lane/main/snapshot
Accept: text/event-stream
id: 0
event: ops
data: [["r",{"lane":"main","transcript":[],"operation":null}]]

id: 1
event: ops
data: [["p",["transcript"],12,0,[{"id":"e12"}]]]

id: 2
event: ops
data: [["a",["operation","streamingMessage","content",0,"text"],"Sure, I"]]
```

`id` is stamped by the binding, not carried in the payload. The first batch is
always a base batch, so hydration is not
a separate route. `Last-Event-ID` is **not** honoured: `seq` restarts per
subscription, and resubscription is a base batch plus buffered batches (§9.2); a gap, an unknown id, and a provider reload all take that same path. A
closed keyed instance ends the stream with `event: closed` and the client does not
retry.

A foreign client needs only the six ops of [delta.md §2](../../01-harness/01-delta/delta.md#2-ops) — `replace`, `set`, `delete`, `append`, `truncate`, `splice`. No mutation names, no recipes, no provider code. The applier is
a page of code in any language.

**This is where non-conformance becomes visible**, and it is the one place worth
being deliberate about it. The format is JSON-Patch-*shaped*, not RFC 6902: paths are
arrays rather than string pointers, and `append`, `truncate` and `splice` have no
RFC equivalent. A client reaching for an off-the-shelf `jsonpatch` library will not
work.

Two mitigations, neither of which is "conform":

- The catalogue advertises the op vocabulary explicitly, so a client discovers the
  six verbs rather than assuming a different vocabulary.
- If a client genuinely needs RFC 6902, the server can offer a lossy downgrade behind
  a content negotiation header — join paths with slashes and `~0`/`~1` escaping,
  materialise `append` and `truncate` into whole-value `replace`, expand `splice`
  into `add`/`remove` runs. About fifteen lines. It reintroduces the quadratic text
  cost, which is the point: conformance is available and it is the client paying for
  it.

Conforming by default would impose that cost on every consumer to serve a
hypothetical one, and would not even buy real interoperability, since Immer's output
was never conformant either (§9.2).

### 15.4 What publishing commits you to

A member in the catalogue is a compatibility promise in a way an internal token is not.
Members should carry a stability marker from the start so that publishing does not
silently mean freezing, and §16 lists version negotiation as unresolved.

## 16. Deltas against `plugins.md`

| topic | `plugins.md` | here |
| --- | --- | --- |
| dependency declaration | derived from `setup()` side effects | static `uses`/`provides`/`observes` |
| handles during setup | disconnected lazy proxies | real objects, after validation |
| validation | requires running facet code | pure manifest analysis |
| mode | declared per call site, validated | property of the token |
| cycles | tolerated via laziness | rejected; explicit `deferred()` escape |
| replication | `ReplicatedState` full-value; `DeltaState` deferred | one primitive; explicit root `r` + six-verb ops |
| hydration | separate atomic snapshot + buffering | base batch zero of the stream |
| presentation facets | loaded locally | delivered by server and worker |
| server↔worker | unspecified inversion | reporting registries; deps point upstream |
| authority | `requireClientIdentity` in method bodies | principal on context; filtered views + handle checks |
| per-client state | not addressed | `peer` mode: one instance per peer, consumed as a singleton |
| resource ownership | explicit `own()` | implicit; every handle is a self-disposing binding |
| state updates | hand-written patch unions | plain mutation on the provider; six-verb ops on the wire |
| UI mounting | facet-owned panels, unspecified host API | slots with `claim`/`add`; host unmounts on disposal |
| isolation | trusted code, unspecified | SES compartment per presentation facet |
| foreign clients | not addressed | opt-in `protocol` block; JSON Schema catalogue + HTTP/SSE |
| lifecycle | `setup` only | sync `construct`, async activate / deactivate |

## 17. Open decisions

- Whether cwd-sourced *session* facets need compartments too (§14.2).
- `CheckComplete` error message ergonomics.
- Where roles come from, and whether they are per-server or per-session.
- Whether handle tables are facet-owned or a kernel-provided utility.
- How an owner grants and revokes guest access at runtime.
- Protocol version negotiation, and how a state value definition's reducer participates
  in source-generation skew (§9.2).
- Flow control for high-frequency state values; gap recovery is settled (§9.2).
- Discovering lanes created after startup (§9.2).
- Whether `reduceLaneSnapshot` becomes a draft mutator now or later; until it does,
  lane state is replace-only.
- Whether `deferred()` survives contact with real plugins, or should be removed.
- Property tests for the tracker (`delta.md` §3.3) before any facet depends on it.
- Which durable values need an explicit periodic `rebase()` cadence to bound recovery work.
