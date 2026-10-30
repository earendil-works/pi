# @earendil-works/chord

Chord builds applications out of **objects** that live in several processes (a server, workers, browser tabs) and can be **hot reloaded** while they run.

- An **object** is state plus code at an address. It is created on demand and lives while someone references it.
- Everyone gets a **reference**, never the object. References work the same locally and across processes, and survive reloads.
- Every object knows its **principal**: an owner and a guest get different objects, with different methods.
- **State** is observable JSON. Remote viewers get a snapshot followed by deltas.
- **Hot reload** swaps code while it runs. Work in flight finishes on the code it started with, state is kept, and incompatible changes migrate at a safe point.

Contracts are runtime values described with [TypeBox](https://github.com/sinclairzx81/typebox) schemas. Hosts exchange JSON frames over links: in memory, a Node IPC channel, or a WebSocket.

## Entry points

| Import | Contents | Runs in |
|--------|----------|---------|
| `@earendil-works/chord` | Contracts (`local`, `remote`, `method`, `opaque`), declarations (through the factory's `self`: `state`, `derive`, `resource`, `on`, `task`), hosts (`createHost`, `defineFacet`, `defineRegistry`), links (`memoryLinkPair`, `ipcLink`, `webSocketLink`, `acceptWebSockets`), errors (`ChordError`, `isChordError`, `forbidden`, `invalid`). Also the shared base: `Context`, `JsonValue`, `JsonRepresentation`, `Draft`, `copyJson`, `isJsonValue`, `replicatedState` with its types, and the watch types `WatchHandle`, `NativeWatchHandle`, `WatchCall`, `NativeWatchCall`, and `WatchEnd` with their implementations `Watch` and `NativeWatch`. | Node and browsers |
| `@earendil-works/chord/node` | Child host processes: `createHostManager`, `forkDriver`, `childControl`, `processLock`; the facet module loader `nodeLoader`. | Node |
| `@earendil-works/chord/context` | Explicit cancellation, telemetry, and invocation values: `BACKGROUND_CONTEXT`, `withCancel`, `withAbortSignal`, `withoutAbortSignal`, `withTelemetry`, `traceIn`, `withContextValue`, `awaitWithContext`. | Node and browsers |
| `@earendil-works/chord/delta` | The transactional JSON tracker, structural diff, immutable apply, and the wire encoder/decoder for operation batches. | Node and browsers |
| `@earendil-works/chord/output` | Bounded output streams and paced progress: `OutputBuffer` (head or tail window of a stream, `OutputLimits`, `OutputSkip`), `boundOutput`, `sanitizeOutput`, `utf8ByteLength`, and `Progress` (adaptive commits of a changing value). | Node and browsers |
| `@earendil-works/chord/telemetry-sqlite` | `createSqliteTelemetry(db, { retentionMs?, maxQueuedSpans? })`: buffered recording and backend-independent `TelemetryStore` queries. | Any SQLite adapter |
| `@earendil-works/chord/sqlite` | Portable `SqliteDatabase`, `SqliteExecutor`, and `SqliteValue`, atomic `applySqliteMigrations(database, migrations, { table })`, and `validateSqliteSchemaPrefix`. The metadata table must be a valid, non-reserved SQLite identifier; migration versions start at 1 and are contiguous. | Any SQLite adapter |
| `@earendil-works/chord/sqlite/node` | `NodeSqliteDatabase`, `openNodeSqliteDatabase`, and `NodeSqliteDatabaseOptions`. | Node |
| `@earendil-works/chord/sqlite/cloudflare` | `DurableObjectSqliteDatabase` and the structural `DurableObjectSqliteStorage` binding type. | Cloudflare Durable Objects |

## Quick start

```ts
import { Type } from "typebox";
import { createHost, hostNamed, method, remote } from "@earendil-works/chord";

// contract.ts: shared by provider and consumers
export const Counter = remote("demo.counter", {
	version: 1,
	input: Type.Object({ name: Type.String() }),
	host: hostNamed("server"), // where its objects live; callers never name a host
	variants: {
		default: {
			state: { count: Type.Number() },
			methods: { increment: method(Type.Object({ by: Type.Number() })) },
		},
	},
});

const host = createHost({ name: "server", self: { kind: "server" } });

host.serve(Counter, ({ name }, _principal, self) => {
	const count = self.state("count", Type.Number(), 0);
	return {
		variant: "default",
		count,
		increment: async ({ by }, ctx) => {
			count.change(ctx, (n) => n + by);
		},
	};
});

await host.root(async (ctx) => {
	const clicks = await ctx.get(Counter, { name: "clicks" }); // ready, with its state; released when this root ends
	clicks.count.subscribe((n) => console.log("count", n));
	await clicks.increment({ by: 2 }, ctx); // logs 0, then 2
});
```

## Documentation

- [Tutorial](docs/tutorial.md): a shared todo list, built up section by section. Every example runs as `test/tutorial.test.ts`.
- [Usage guide](docs/guide.md): API reference for contracts, objects, state, roots, lifetime, plugins, hot reload, hosts, and links.
- [Specification](docs/spec.md): compatibility, lifetime, and reload semantics, plus known limitations and implementation decisions.
- [Delta guide](src/delta/README.md): ownership, lifecycle, operation, and replica contracts of `@earendil-works/chord/delta`.

## Explicit Context telemetry

`Context` always carries a `telemetry: TelemetrySpan`, alongside `abortSignal`. `BACKGROUND_CONTEXT` and `TODO_CONTEXT` use the shared no-op span `NOOP_TELEMETRY_CONTEXT`. Adapters (`TelemetryContext`) belong to hosts and start root spans; adapters are never placed in a `Context`.

```ts
import { BACKGROUND_CONTEXT, traceIn, withTelemetry } from '@earendil-works/chord/context';
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';

const telemetry = new InMemoryTelemetryContext();
await telemetry.startSpan({ name: 'app.request' }, async (span) => {
  const context = withTelemetry(span, BACKGROUND_CONTEXT);
  await traceIn(
    { name: 'app.load' },
    async (child) => {
      child.telemetry.addEvent('cache.miss');
      return traceIn({ name: 'app.read' }, (nested) => readAccount(nested), child);
    },
    context,
  );
});
```

`withTelemetry(span, context)` derives a new context; it never changes its parent, cancellation, or typed values. `traceIn(options, fn, context)` creates a callback-managed child span, and `fn` receives its derived context. Every context already supports `telemetry.addEvent()` and `telemetry.addLink()`. Values, cancellation, callback results, and rejection identities are preserved. Concurrent calls keep independent parents; there is no ambient current span. `value()`, `ContextKey`, and `withContextValue()` remain supported.

These helpers operate on the standalone `Context` API. They do not yet instrument Chord hosts, methods, or network frames.

## SQLite telemetry

```ts
import { createSqliteTelemetry } from '@earendil-works/chord/telemetry-sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { renderTrace } from '@earendil-works/pi-telemetry/render';

const db = await openNodeSqliteDatabase('telemetry.db');
const telemetry = await createSqliteTelemetry(db);
try {
  await telemetry.startSpan({ name: 'app.request' }, async (span) => {
    span.addEvent('request.accepted');
    await span.startSpan({ name: 'app.read' }, () => readAccount());
  });
  await telemetry.flush();
  const { traces } = await telemetry.findTraces({ name: 'app.request', limit: 10 });
  for (const trace of traces) console.log(renderTrace(trace.spans));
} finally {
  try { await telemetry.close(); } finally { await db.close(); }
}
```

The adapter is portable over `SqliteDatabase` and owns no connection. Recording performs no SQL. A one-second timer flushes settled spans and completed ten-second metric intervals in one transaction, including retention cleanup. Metrics retain count, sum, minimum, and maximum per name/kind/unit/attribute series, not raw samples, buckets, or exemplars. `close()` stops recording and drains partial metric intervals without waiting for business callbacks or closing the database. Late span completions are ignored.

Retention defaults to seven days. `maxQueuedSpans` defaults to 10,000 and counts settled spans awaiting commit, including an in-flight batch. The same limit independently bounds pending metric interval/series pairs. Overflow increments `droppedSpans` or `droppedMeasurements`; the limits bound counts, not bytes or active spans. A write failure stops recording permanently: `flush()` and `close()` reject with the original error without retrying.

The adapter implements `TelemetryStore`: `findTraces()`, `getTrace()`, and `findMetrics()` read committed rows, including after adapter close while the database remains open. See [stored telemetry](../telemetry/README.md#stored-telemetry) for filters, pagination, and cross-process trace assembly. Schema tables are `telemetry_spans`, `telemetry_metrics`, and `telemetry_schema`.

## Tracking JSON deltas

Import the standalone transactional tracker from `@earendil-works/chord/delta`:

```ts
import { applyImmutable, track } from "@earendil-works/chord/delta";

const tracker = track({ output: "", count: 0 });
const change = tracker.beginChange();
change.state.output += "done\n";
change.state.count += 1;
const prepared = change.prepare();

tracker.adopt(prepared);
const replica = applyImmutable(prepared.base, prepared.ops);
```

`tracker.value` is always the latest adopted immutable revision. Preparation does
not change authority; adoption validates the preparation and swaps the root pointer.
Assigned containers are copied by value and unchanged subtrees may be shared between
revisions.

The tracker uses trusted immutable ownership rather than defensive copying or
freezing. `track(initial)`, `prepareReplace(value)`, `replicatedState(initial)`, and
`replace(context, value)` take ownership of alias-free strict-JSON roots without
walking them. Callers must not mutate transferred or published data. Values placed
through drafts are already copied, so that walk also rejects non-strict JSON before
the draft changes. Published values are not frozen. In-process consumers may share
their containers with the provider; mutating a consumed value violates the contract
and can corrupt authority. Clone or serialize at any mutable trust boundary.

Replicated state provides the same model through a callback. `replicatedState` is a
standalone observable value, independent of hosts:

```ts
import { replicatedState } from "@earendil-works/chord";

const initial = { output: "", count: 0 };
const status = replicatedState(initial); // transfers ownership of initial
status.change(context, (draft) => {
	draft.output += "done\n";
	draft.count += 1;
});
```

A successful `change()` publishes exactly one atomic revision. If its callback
throws, the original value and sequence remain unchanged. Draft references become
unusable when the callback returns. The tracker emits string append and
front-truncate operations, array splices and permutations, sets, and deletes; large
edit sets may fold into a complete replacement.

`replicatedState(source, { onError })` instead attaches a publication-only state to
an authoritative revision source (`ReplicatedStateSource`): it captures a snapshot,
then publishes every committed frame in cursor order.

### Public state subscriptions

`state.subscribe(async (value, context, delivery) => { ... })` serializes callbacks
independently for each subscription. Hydration starts immediately when a value is
available, and its returned promise must settle before updates start. Synchronous
callbacks still run synchronously. Read the captured `value` inside an asynchronous
callback: `state.value` may already refer to a later revision.

Each subscription retains at most 100 pending complete-value deliveries, excluding
the running callback. On overflow, only the newest pending value, context, and
delivery metadata are retained; a not-yet-started initial hydration is preserved.
Thus public delivery sequences may skip. This is a frame-count policy, not a byte
limit.

The returned unsubscribe function immediately discards pending work and prevents
new callbacks. It neither aborts nor waits for the running callback. Synchronous
throws and promise rejections are observed, reported, and do not stop other
subscriptions or subsequent callbacks. Attached sources use their `onError`
handler; mutable states (and attached sources without a handler) report failures
by throwing in a microtask. Unsubscribing does not hide a later rejection from the
running callback.

Cells of Chord objects and their remote readables have their own subscription
model; see [State](docs/guide.md#state) in the usage guide.

### Watches

`WatchHandle<T>` is the one watch interface, implemented by watch sources such as
Durable's documents, conversation views, and task graph. `watch.value` is the value
at acquisition until `start(listener)` installs the sole asynchronous listener; each
later change arrives as `(call, context)`, one call at a time, with
`call: WatchCall<T>` tagged by `kind` (plain data; the context is the second
argument):

- `{ kind: "value", value, ops, retired }`: the new value, and `watch.value`
  advances to it;
- `{ kind: "failed", error }`: the source cannot compute its value now. The watch
  stays open and `watch.value` keeps the last value; the next value arrives as
  `[["r", value]]`.

```ts
watch.start(async (call) => {
	if (call.kind === "failed") return showError(call.error);
	render(call.value);
});
```

Changes made while the listener runs (or before `start`) arrive in one call: the
newest value, the ops of all of them folded by Delta's `PendingOps`, and the newest
change's context. Past 10,000 pending ops after folding the call gets one root
replacement `[["r", newest]]` instead. A failure drops the pending values and waits
as one `failed` call (the newest failure); a value after it replaces it, as one
`[["r", value]]` call.

`retired` says the document the watch follows was retired since the previous value
call. It does not end the watch: the call carries what the address shows after the
retirement (the source decides; a Durable document keeps the last value the watch
was given, with no ops), and a document created there later arrives as
`[["r", value]]`, folded with what is pending, so one call can report a retirement
and carry the new value.

A watch ends only for good. `stop()` is idempotent, drops pending frames, and
neither aborts nor awaits a running call; it and `closed` give the `WatchEnd`,
tagged by `kind`:

- `stopped`: `stop()` was called;
- `aborted`: the context the watch was acquired with was aborted;
- `ended`: the source closed (its owner ended or closed);
- `listener_error` with `error`: the listener threw or rejected;
- `failed` with `error`: the source failed for good.

An ended watch drops every reference into its source, so a stopped watch that is
still referenced keeps only its last value alive.

Sources implement handles with `Watch<T>`, fed through `advance(call, context)`
(a `WatchCall`: a value with `retired` set for a retirement, or a failure),
`fail(error, context)` (a failure the source may recover from), `end(end)` (a
`WatchEnd`, at once, dropping what is pending), `endAfterDelivery()` (take no more
frames, deliver what is pending, then end `ended` once the last call returned; the
source's `end()` still ends it first), and `observeAbort(signal)`.
`NativeWatch<T>` implements `NativeWatchHandle<T>`, the same lifecycle for
in-process values: the listener gets a `NativeWatchCall<T>`
(`{ kind: "value", value }` without ops, or `{ kind: "failed", error }`), one call
per value in order; past 100 pending values they collapse to one, the value of the
optional `replace()` or the newest. A failure drops the pending values; values
after it are delivered in order.
