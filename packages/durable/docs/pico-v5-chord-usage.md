# Pico5 documents through Chord

This guide uses the contracts in the [Pico5 specification](spec.md). Its code
compiles and runs as `test/chord-guide.test.ts`; keep the two in sync.

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
- **Transaction draft:** the revocable copy-on-write object from `await tx.doc`,
  valid only inside that commit callback, including all nested objects.
- **DocumentState:** a disposable read-only Chord state bound to one document incarnation.
- **ReplicatedState:** Chord's immutable complete values through `value` and
  `subscribe(listener)`. `value` is `undefined` before hydration or while disconnected.
  The listener receives `(value, context, delivery)`; delivery contains `kind`
  (`hydrate` or `update`) and a stream `sequence`, not a Session commit number.

Documents are scoped directly to a Session, conversation, or task. A task is
durable work attached to a conversation; its documents retire when it becomes
terminal and never participate in conversation forks.

## Imports and the adapter boundary

Examples build on one another. `ConversationRecord`, `EntryRecord`, and
`TaskRecord` are persisted records, while `Conversation` is the public
conversation object and `Entry`/`Task` are typed definitions. The imports:

```ts
import {
  createFacetHost, createRemoteServiceBinding, defineFacet, defineService,
  type Context, type Facet, type FacetHost, type RemoteServiceTransport, type ReplicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  type ConversationId, defineDoc, defineDocFamily, type DocumentObserver,
  type Harness, type Session, type TaskId, type TaskRuntime,
} from "@earendil-works/pi-durable";
```

A `Harness` is a `Session`, so every function below also takes an open Harness.

`documentState()` performs Chord adoption internally: it atomically captures a
committed snapshot, registers for every later exact frame, and returns an already
hydrated read-only state. Operations covered by the snapshot are never
redelivered. Disposing the state releases observation, not the document. Pico
remains the sole mutator.

## 1. A Session-wide canvas

All conversations in this Session share one canvas. Session documents are
current-only and have no history or fork settings.

```ts
type Stroke = { color: string; points: { x: number; y: number }[] };
type CanvasState = { strokes: Stroke[] };

const CanvasDoc = defineDoc<CanvasState>({
  kind: "app.canvas", version: 1, scope: "session",
  initial: () => ({ strokes: [] }),
  // Store a complete base after at most 99 replayed deltas.
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 99,
});

interface CanvasService {
  readonly state: ReplicatedState<CanvasState | null>;
  addStroke(stroke: Stroke, context: Context): Promise<void>;
}
const Canvas = defineService<CanvasService>("app.canvas");

async function createCanvasFacet(session: Session, context: Context): Promise<Facet> {
  // Creation is explicit; observation never writes.
  await session.commit(async tx => {
    await tx.doc(CanvasDoc);
  }, context);
  const state = await session.documentState(CanvasDoc, context);
  if (state === undefined) throw new Error("canvas was retired during setup");
  return defineFacet({
    id: "app.canvas/session",
    setup(env) {
      env.own(() => state.dispose());
      env.provide(Canvas, {
        state,
        async addStroke(stroke, context) {
          await session.commit(async tx => {
            const draft = await tx.doc(CanvasDoc);
            draft.strokes.push(stroke); // Chord copies the assigned stroke by value.
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

The application owns the open Session. Acquire the document state asynchronously
before synchronous `setup`, then transfer its disposal to the facet;
`env.provide` cannot run in `onActivate`. Install one provider per
Session host. Chord may reload presentation facets independently. Session-side
tools, hooks, tasks, and prompt sections reload through the Harness
registry: install the replacement extension under the same name (spec section 7.5).
Work already running keeps the old code, so the facet manages its old resources'
lifetime itself.

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
explicit first tx.doc -> commit base { strokes: [] }
addStroke(A)       -> commit A -> local and remote subscribers see A
worker restarts   -> open same durable storage; install canvas facet again
acquire source    -> load base + committed deltas, without rerunning initial()
late client       -> hydrate complete canvas including A, then ordered updates
conversation fork -> still uses this same Session canvas
```

Use persistent storage for restart survival. The memory backend is not persistent.
A method's successful commit does not promise every remote callback has run yet.

Shut down in reverse: detach clients and dispose the facet host, which withdraws
its services and disposes the document states it owns, then close the Harness.
Closing the Harness first would end the states under still-connected clients:
they keep the last value and never update again.

```ts
async function shutdown(host: FacetHost, detachClients: () => Promise<void>, harness: Harness, context: Context) {
  await detachClients();
  await host.dispose();
  await harness.close(context);
}
```

## 2. Conversation-scoped diff reviews

A **document family** uses one definition for many instances. The logical key is
`(kind, conversationId, key)`; the persisted numeric document ID identifies an
incarnation and is never reused. The creation seed is not part of the key.

```ts
type ReviewInput = { path: string; patch: string };
type ReviewComment = { id: string; line: number; text: string };
type ReviewState = ReviewInput & { comments: ReviewComment[] };
const ReviewDoc = defineDocFamily<ReviewState, ReviewInput>({
  kind: "app.diff-review", version: 1, family: true, scope: "conversation",
  history: "latest", fork: "current",
  initial: seed => ({ path: seed.path, patch: seed.patch, comments: [] }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 49,
});
interface DiffReviewService {
  readonly state: ReplicatedState<ReviewState | null>;
  identity(context: Context): Promise<{ conversationId: ConversationId; key: string }>;
  addComment(comment: ReviewComment, context: Context): Promise<void>;
}
const DiffReviews = defineService<DiffReviewService>("app.diff-reviews");

function reviewFacet(
  session: Session, conversationId: ConversationId,
  reviews: readonly { key: string; seed: ReviewInput }[], context: Context,
): Facet {
  return defineFacet({
    id: "app.diff-reviews/session",
    setup(env) {
      const instances = env.provideMany(DiffReviews);
      env.onActivate(async () => {
        for (const review of reviews) {
          await session.commit(async tx => {
            await tx.doc(ReviewDoc, conversationId, review.key, review.seed);
          }, context);
          const state = await session.documentState(ReviewDoc, conversationId, review.key, context);
          if (state === undefined) throw new Error("review was retired during setup");
          env.own(() => state.dispose());
          // Chord instance keys route services; they are not numeric document incarnation IDs.
          instances.spawn(JSON.stringify([conversationId, review.key]), {
            state,
            async identity() { return { conversationId, key: review.key }; },
            async addComment(comment, context) {
              await session.commit(async tx => {
                const draft = await tx.doc(ReviewDoc, conversationId, review.key, review.seed);
                draft.comments.push(comment); // Chord copies the assigned comment by value.
              }, context);
            },
          }); // The facet owns spawned service lifetimes automatically.
        }
      });
    },
  });
}
```

Example input: `[{ key: "review-7", seed: { path: "a.ts", patch: "-old\n+new" } }]`.
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

With `fork: "initial"`, no instance copies; the first child `tx.doc()` uses its supplied seed.
`latest` cannot read history or fork `asOf`; use `history: "rewindable"` with `asOf`
to reflect E's commit. Reaccess ignores later seeds; updating the patch requires
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
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 99,
});
async function appendJobOutput(
  runtime: TaskRuntime<JobInput, { phase: "running" }, null, object>,
  chunk: string, context: Context,
): Promise<void> {
  // Read process output outside this callback. The runtime gates the live task.
  await runtime.commit(async tx => {
    const draft = await tx.doc(JobOutputDoc, runtime.taskId);
    draft.stdout = (draft.stdout + chunk).slice(-50_000);
    draft.chunks += 1;
  }, context);
}
async function observeJob(
  api: DocumentObserver, producerTaskId: TaskId,
  finished: Promise<void>, context: Context,
): Promise<void> {
  const watch = await api.watchDoc(JobOutputDoc, producerTaskId, context);
  if (watch === undefined) return;
  console.log(watch.value === null ? "retired" : watch.value.stdout);
  try {
    watch.start(async (value, ops, _context) => {
      await sendCommittedFrame(value, ops);
      await render(value === null ? "retired" : value.stdout);
    }); // Serialized callbacks never overlap.
    await finished; // Caller-supplied observation lifetime; outside any commit.
  } finally {
    await watch.stop(); // Idempotent; prevents another callback from starting.
  }
}
```

The running phase calls `appendJobOutput` and must also commit its next checkpoint
or terminal outcome. `api` is the invocation's `DocumentObserver`; `TaskRuntime`
includes that interface. `tx.doc()` creation validates that the target task is live and derives its
conversation from the task record. A later non-creating watch lookup returns
`undefined` after the task is terminal and its document has retired.

```text
watchDoc: capture immutable V0 + register for later exact committed frames
producer commits D1 and D2 before start: buffer (V1, D1), (V2, D2)
start: caller has initialized from V0; deliver D1, then D2 serially
producer commits D3 while listener awaits: buffer D3; never overlap callbacks
101 pending frames: replace the pending suffix with [["r", newestValue]]
producer becomes terminal: deliver [["r", null]], then close as retired
```

Watches automatically stop when their invocation ends. A Session-acquired watch
is caller-owned and stops on Session close. Previously delivered snapshots never
mutate. Slow or unstarted delivery retains up to 100 exact frames, then replaces
the undelivered suffix with a full-value root replacement. A watch is convergent
state observation rather than a transition journal. Retirement ends the
incarnation's stream; a service exposing that state must withdraw or remain
terminal at `null`. Recreation requires a new watch/state and numeric document ID. A terminal task cannot
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
document ["s", ["generation", "message"], value]
 -> view ["s", ["docs", "pi.live", "generation", "message"], value]
```

`pi.live` is specified in `spec.md` section 8.2.
The mount publishes one batch per complete Session commit: entry/head changes and
changed mounted documents together, without a tracker or semantic projection.
Third-party documents are **not automatically mounted**; use their own Chord
services or trusted invocation watches. A retired source publishes `null`; a
dynamic service should then withdraw its instance rather than expose stale data.

```text
addStroke -> hold Session mutation line -> await tx.doc -> mutate tracker change draft
callback succeeds -> tracker prepare: immutable candidate + immutable ops
Session checkpoint predicate selects a base or delta exactly once
atomic storage commit: persist selected document and record writes
storage succeeds -> adopt candidate + enqueue candidate/ops, still on line
release line -> deliver committed source ops -> adapter -> local/remote Chord consumers
late subscriber -> atomically capture committed value + adapter sequence + subscription
```

No visible-undurable path exists. Callback, tracker preparation, and checkpoint
failure abort normally before Storage admission. An uncertain Storage failure
publishes nothing and poisons the open Session; close and reopen it instead of
continuing.

## Footguns

- Never retain drafts, nested proxies, or bound array methods across commits;
  they are revoked. Assigned containers are copied by value.
- Async commit holds the line through storage settlement and baseline adoption.
  Await document access there, not models, processes, network calls, or humans.
- Only `tx.doc()` creates. `snapshot`, `documentState`, and `watchDoc` return
  `undefined` when absent and never write. Family seeds are used only when the
  first `tx.doc()` creates an incarnation; later seeds are ignored.
- Initialize from the fixed `watch.value` before `start()`. Slow or unstarted
  delivery retains up to 100 exact frames, then replaces the pending suffix with
  one full-value root replacement. No serialized-byte accounting is performed.
  Do not use a watch as an audit log.
- `stop()` prevents future callbacks but does not abort or join one already running.
- Definitions own checkpoints, not storage heuristics. Keep document kinds, versions, fork policies, and
  public paths stable; schema changes require migration, not a source-only rename.

Chord sources: [types](../../chord/src/types.ts), [facet examples](../../chord/test/facets.test.ts),
[state](../../chord/src/services/state.ts), [provider](../../chord/src/services/provider.ts),
[Context](../../chord/src/context/index.ts), [Delta](../../chord/src/delta/README.md).
