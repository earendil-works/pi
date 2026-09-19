# Pico5 documents through Chord

This guide uses the contracts in the [Pico5 specification](pico-v5.md).

- **Session:** a durable container for conversations, entries, tasks, and documents;
  it serializes mutations on one commit line.
- **Facet:** a feature's setup unit in a Chord host. Setup declares services and
  dependencies synchronously; `onActivate` runs after dependencies are ready.
- **Context:** explicitly passed cancellation and invocation values. Forward the caller's context.
- **Service:** a typed token and implementation acquired with `env.use`. Remote
  services contain replicated state and async methods with JSON arguments plus a trailing `Context`.
- **Durable document:** JSON persisted as a complete base, Chord operations, and
  checkpoints. Its definition token declares schema, version, scope, and initialization;
  conversation scope also declares history and fork behavior.
- **Transaction draft:** the mutable tracked object from `await tx.doc`, valid
  only inside that commit callback, including all nested objects.
- **DocumentSource:** an opaque handle to one document incarnation's committed changes,
  not a mutable value or a public subscription API.
- **ReplicatedState:** Chord's immutable complete values through `value` and
  `subscribe(listener)`. `value` is `undefined` before hydration or while disconnected.
  The listener receives `(value, context, delivery)`; delivery contains `kind`
  (`hydrate` or `update`) and a stream `sequence`, not a Session commit number.

Documents are scoped directly to a Session, conversation, or task. A task is
durable work attached to a conversation; its documents retire when it becomes
terminal and never participate in conversation forks.

## Imports and the adapter boundary

Examples build on one another. Pico5 names (`defineDoc`, `defineDocFamily`,
`Session`, `DocumentSource`, `Id`, `TaskRuntime`, `DocumentObserver`)
refer to normative contracts, without a specified import path or runnable Pico5
package. In those contracts, `ConversationRecord`, `EntryRecord`, and
`TaskRecord` are persisted records, while `Conversation` is the public
conversation object and `Entry`/`Task` are typed definitions. These Chord imports
exist today:

```ts
import {
  createFacetHost, createRemoteServiceBinding, defineFacet, defineService,
  type Context, type Facet, type JsonValue, type RemoteServiceTransport,
  type ReplicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { applyImmutable } from "@earendil-works/chord/delta";

// The spec calls this JsonObject; current Chord exports JsonValue, not JsonObject.
type JsonObject = { [key: string]: JsonValue };

// Required by Pico5, but not a current Chord export yet.
declare function documentReplicatedState<T extends JsonObject>(
  source: DocumentSource<T>, context: Context,
): Promise<{ readonly state: ReplicatedState<T | null>; dispose(): void }>;
```

The adapter must register Chord-recognized state, atomically hydrate a matching
committed value and adapter-owned delivery sequence, and forward committed ops without another
tracker or re-diff. Disposal releases observation, not the document. Even Chord's
hydration requests must never flush an uncommitted draft.

Current `env.replicatedState(initial)` creates a **mutable, in-memory** tracker
with `.state` and `.publish(context)`, not a durable source adapter. There is no
`replicatedState.own(source)`. Do not mirror documents into another tracker.

## 1. A Session-wide canvas

All conversations in this Session share one canvas. Session documents are
current-only and have no history or fork settings.

```ts
type Stroke = { color: string; points: { x: number; y: number }[] };
type CanvasState = { strokes: Stroke[] };

const CanvasDoc = defineDoc<CanvasState>({
  kind: "app.canvas", version: 1, scope: "session",
  initial: () => ({ strokes: [] }),
  // This append-only example adds one stroke per commit.
  checkpointWhen: value => value.strokes.length % 100 === 0,
});

interface CanvasService {
  readonly state: ReplicatedState<CanvasState | null>;
  addStroke(stroke: Stroke, context: Context): Promise<void>;
}
const Canvas = defineService<CanvasService>("app.canvas");

async function createCanvasFacet(session: Session, context: Context): Promise<Facet> {
  const target = { scope: "session" } as const;
  // Get-or-create: an absent canvas is initialized in a serialized commit.
  const source = await session.documentSource(CanvasDoc, target, context);
  const replica = await documentReplicatedState(source, context);
  return defineFacet({
    id: "app.canvas/session",
    setup(env) {
      env.own(() => replica.dispose());
      env.provide(Canvas, {
        state: replica.state,
        async addStroke(stroke, context) {
          await session.commit(async tx => {
            const draft = await tx.doc(CanvasDoc, target);
            draft.strokes.push(stroke); // The draft now owns stroke; caller must not mutate it.
          }, context);
        },
      });
    },
  });
}

const CanvasConsumer = defineFacet({
  id: "app.canvas/consumer",
  setup(env) {
    const canvas = env.use(Canvas); // Declare now; access only after activation.
    env.onActivate(() => {
      env.own(canvas.state.subscribe((value, _context, delivery) => {
        console.log(delivery.kind, delivery.sequence, value?.strokes.length ?? "retired");
      })); // subscribe delivers the current hydrated value, then updates.
    });
  },
});

async function runCanvasExample(session: Session): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  const provider = await createCanvasFacet(session, context);
  const host = await createFacetHost({ facets: [provider, CanvasConsumer] });
  try {
    await host.services.use(Canvas).addStroke({
      color: "black", points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
    }, context);
  } finally {
    await host.dispose(); // Unsubscribes; does not delete the canvas or close Session.
  }
}
```

The application owns the open Session. Acquire state **before** synchronous
`setup`; `env.provide` cannot run in `onActivate`. Install one provider per
Session host. Chord may reload presentation facets independently, but v1 does
not use facet reload to replace Session-side task or hook implementations. A
host extension code change closes and reopens the Harness with the new
definition set.

Remote clients supply a `RemoteServiceTransport` connected to the host's `services`
provider; Chord prescribes no socket protocol. `CanvasConsumer` also works unchanged
in a UI host configured with a remote service source.

```ts
async function connectCanvas(transport: RemoteServiceTransport, context: Context) {
  const services = createRemoteServiceBinding({ services: [Canvas], transport });
  const canvas = services.use(Canvas);
  const stop = canvas.state.subscribe((value, _context, delivery) => {
    console.log(delivery.kind, delivery.sequence, value?.strokes ?? "retired");
  });
  try {
    await services.ready(context); // Initial snapshot installed; not all future updates.
  } catch (error) {
    stop();
    await services.dispose(BACKGROUND_CONTEXT);
    throw error;
  }
  return async () => {
    stop();
    await services.dispose(BACKGROUND_CONTEXT);
  };
}
```

```text
first acquisition -> commit base { strokes: [] }
addStroke(A)       -> commit A -> local and remote subscribers see A
worker restarts   -> open same durable storage; install canvas facet again
acquire source    -> load base + committed deltas, without rerunning initial()
late client       -> hydrate complete canvas including A, then ordered updates
conversation fork -> still uses this same Session canvas
```

Use persistent storage for restart survival. The memory backend is not persistent.
A method's successful commit does not promise every remote callback has run yet.

## 2. Conversation-scoped diff reviews

A **document family** uses one definition for many instances. The logical key is
`(kind, conversationId, key)`; the persisted numeric document ID identifies an
incarnation and is never reused. Initializer input is not part of the key.

```ts
type ReviewInput = { path: string; patch: string };
type ReviewComment = { id: string; line: number; text: string };
type ReviewState = ReviewInput & { comments: ReviewComment[] };
const ReviewDoc = defineDocFamily<ReviewState, ReviewInput>({
  kind: "app.diff-review", version: 1, family: true, scope: "conversation",
  history: "latest", fork: "current",
  initial: input => ({ path: input.path, patch: input.patch, comments: [] }),
  checkpointWhen: value => value.comments.length % 50 === 0,
});
interface DiffReviewService {
  readonly state: ReplicatedState<ReviewState | null>;
  identity(context: Context): Promise<{ conversationId: Id; key: string }>;
  addComment(comment: ReviewComment, context: Context): Promise<void>;
}
const DiffReviews = defineService<DiffReviewService>("app.diff-reviews");

function reviewFacet(
  session: Session, conversationId: Id,
  reviews: readonly { key: string; initial: ReviewInput }[], context: Context,
): Facet {
  return defineFacet({
    id: "app.diff-reviews/session",
    setup(env) {
      const instances = env.provideMany(DiffReviews);
      env.onActivate(async () => {
        for (const review of reviews) {
          const target = { scope: "conversation" as const, conversationId, ...review };
          const source = await session.documentSource(ReviewDoc, target, context);
          const replica = await documentReplicatedState(source, context);
          env.own(() => replica.dispose());
          // Chord instance keys route services; they are not numeric document incarnation IDs.
          instances.spawn(JSON.stringify([conversationId, review.key]), {
            state: replica.state,
            async identity() { return { conversationId, key: review.key }; },
            async addComment(comment, context) {
              await session.commit(async tx => {
                const draft = await tx.doc(ReviewDoc, target);
                draft.comments.push(comment); // Do not mutate comment after this assignment.
              }, context);
            },
          }); // The facet owns spawned service lifetimes automatically.
        }
      });
    },
  });
}
```

Example input: `[{ key: "review-7", initial: { path: "a.ts", patch: "-old\n+new" } }]`.
Pass distinct family keys and a real conversation ID; install the facet as above.
Keyed consumers use `env.observe(DiffReviews, handler)`, not `env.use`. The handler
receives `(review, context)`; call `review.identity(context)` to identify it and
`review.state.subscribe` to observe comments.

These comments are conversation-scoped: ending the generating task or unloading
the facet does not retire them. `current` copies every logically
present review at fork-commit time into independent child instances with new
numeric IDs, retaining family keys. Parent and child then diverge.

```text
parent review-7: comment A -> transcript entry E -> comment B
fork at E with current: child review-7 contains A and B
child adds C: parent still contains only A and B
```

With `fork: "initial"`, no instance copies; first child access uses supplied input.
`latest` cannot read history or fork `asOf`; use `history: "rewindable"` with `asOf`
to reflect E's commit. Reaccess ignores `initial`; updating the patch requires
an explicit mutation or a distinct review key.

## 3. Task-scoped output and a tool/task watch

This is a bounded progress window, not the permanent result. Scope itself gives
it task lifetime; no history, fork, owner, or conversation setting is needed.

```ts
type JobInput = { command: string };
type JobOutput = { stdout: string; chunks: number };
const JobOutputDoc = defineDoc<JobOutput>({
  kind: "app.job-output", version: 1, scope: "task",
  initial: () => ({ stdout: "", chunks: 0 }),
  checkpointWhen: value => value.chunks % 100 === 0,
});
function jobOutputTarget(taskId: Id) {
  return { scope: "task" as const, taskId };
}
async function appendJobOutput(
  runtime: TaskRuntime<JobInput, { phase: "running" }, null, {}>,
  chunk: string, context: Context,
): Promise<void> {
  // Read process output outside this callback. The runtime gates the live task.
  await runtime.commit(async tx => {
    const draft = await tx.doc(JobOutputDoc, jobOutputTarget(runtime.taskId));
    draft.stdout = (draft.stdout + chunk).slice(-50_000);
    draft.chunks += 1;
  }, context);
}
async function observeJob(
  api: DocumentObserver, producerTaskId: Id,
  finished: Promise<void>, context: Context,
): Promise<void> {
  const target = jobOutputTarget(producerTaskId);
  const watch = await api.watchDoc(JobOutputDoc, target, context);
  let value = watch.value;
  console.log(value === null ? "retired" : value.stdout);
  try {
    watch.start(async (ops, _context) => {
      value = applyImmutable(value, ops);
      await render(value === null ? "retired" : value.stdout);
    }); // Serialized callbacks never overlap.
    await finished; // Caller-supplied observation lifetime; outside any commit.
  } finally {
    watch.stop(); // Idempotent; prevents another callback from starting.
    await watch.closed; // Wait for an in-flight callback to settle.
  }
}
```

The running phase calls `appendJobOutput` and must also commit its next checkpoint
or terminal outcome. `api` is the invocation's `DocumentObserver`; `TaskRuntime`
includes that interface. Acquisition validates the target task is live and
derives its conversation from the task record.

```text
watchDoc: capture immutable V0 + register for later committed operation batches
producer commits D1 and D2 before start: queue D1, D2
pending operation count exceeds its limit: replace suffix with [["r", V2]]
start: caller has initialized from V0; deliver the reset through the async listener
producer commits D3 while listener awaits: queue D3; never overlap callbacks
unrelated commit has no source ops: enqueue nothing
producer becomes terminal: queue [["r", null]], deliver it, then close as retired
```

Watches automatically stop when their invocation ends. A Session-acquired watch
is caller-owned and stops on Session close. Previously delivered snapshots never
mutate. Slow or unstarted delivery may coalesce an undelivered suffix into a
complete reset, so a watch is convergent state observation rather than a
transition journal. Retirement ends the incarnation's stream; recreation
requires a new watch/source and a new numeric document ID. A terminal task cannot
create more output. Task-scoped documents
never copy into forks. Preserve required output in result entries or Session- or
conversation-scoped documents in the terminal commit before retirement. Use a
task-scoped family only when one task needs several independently keyed documents.

## 4. Built-in conversation views and commit delivery

`ConversationView` contains `conversation`, raw transcript `entries`, and
`docs: Readonly<Record<string, JsonObject>>`. Selected built-in singletons mount
under `docs` by stable document kind, not numeric incarnation ID. The spec's
illustrative path mapping is:

```text
document ["s", ["message"], value]
 -> view ["s", ["docs", "pi.live", "message"], value]
```

Built-in kinds and fields await approval; `pi.live` is illustrative, not an available API.
The mount publishes one batch per complete Session commit: entry/head changes and
changed mounted documents together, without a tracker or semantic projection.
Third-party documents are **not automatically mounted**; use their own Chord
services or trusted invocation watches. A retired source publishes `null`; a
dynamic service should then withdraw its instance rather than expose stale data.

```text
addStroke -> hold Session mutation line -> await tx.doc -> mutate tracked draft
callback succeeds -> tracker flush: incremental ops + candidate value
Session checkpoint predicate selects a base or delta exactly once
atomic storage commit: persist selected document and record writes
storage succeeds -> materialize immutable published value + enqueue value/ops, still on line
release line -> deliver committed source ops -> adapter -> local/remote Chord consumers
late subscriber -> atomically capture committed value + adapter sequence + subscription
```

No visible-undurable path exists. Callback failure restores the unchanged
baseline. Failure after flush, including checkpoint/storage failure, publishes
nothing and poisons the open Session; close and reopen it instead of continuing.

## Footguns

- Never retain drafts, nested proxies, or bound array methods across commits.
  Never mutate inserted aliases or insert one mutable object at multiple paths.
- Async commit holds the line through storage settlement and baseline adoption.
  Await document access there, not models, processes, network calls, or humans.
- Normal `snapshot`, `documentSource`, and `watchDoc` reads are get-or-create and
  lazily migrate through the supplied token. Harness open does not scan ordinary
  documents. Family `initial` is first-creation input, not an update.
- Initialize from the fixed `watch.value` before `start()`. Slow or unstarted
  delivery may coalesce an undelivered suffix into a root replacement when its
  operation count exceeds the limit, omitting intermediate states. Queue
  accounting never serializes operations to estimate bytes. Do not use a watch
  as an audit log.
- A listener may call `stop()`, but must not await its own `closed` promise.
- Definitions own checkpoints, not storage heuristics. Revise the counting predicates
  above if mutations change. Keep document kinds, versions, fork policies, and
  public paths stable; schema changes require migration, not a source-only rename.

Chord sources: [types](../../chord/src/types.ts), [facet examples](../../chord/test/facets.test.ts),
[state](../../chord/src/services/state.ts), [provider](../../chord/src/services/provider.ts),
[Context](../../chord/src/context/index.ts), [Delta](../../chord/src/delta/README.md).
