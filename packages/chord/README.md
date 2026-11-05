# @earendil-works/chord

Chord builds applications out of **objects** that live in several processes (a server, workers, browser tabs) and keep running while their plugins are **reloaded**.

- An **object type** is a contract: a name, params that select the instance, the host it lives on, its members (state and methods) and a version. Contracts are runtime values described with JSON Schema, written with the builders of `@earendil-works/pi-schema`.
- A **facet** is a plugin's declarations for one host: the types it serves and its contributions to registries. A factory only declares; Chord activates.
- Everyone gets a **reference**, never the object. A reference is live and hydrated once its `get` resolves, works the same locally and across links, and keeps its object alive.
- **Documents** are named JSON values an object owns, written in transactions and persisted in Chord's store; **derives** compute values from watchables; **jobs** are owned work that outlives the call that started it.
- Every call has a **principal**: links stamp it, the app types it, and objects are kept per principal key.
- A **reload** swaps a plugin's code inside the running app, rolled out host by host: hosts keep running, data, connections and running work survive where they can.

The design, the rule book for all of this, is [docs/design.md](docs/design.md).

## Entry points

| Import | Contents | Runs in |
|--------|----------|---------|
| `@earendil-works/chord` | Contracts (`local`, `remote`, `method`, the schema builders), errors (`ChordError`, `isChordError`), hosts and facets (`createHost`, `defineFacet`), documents (`defineState`), derives and natives (`constant`, `mapShared`), routines and jobs (`defineJob`), links (`memoryLinkPair`, `ipcLink`, `webSocketLink`), registries (`defineRegistry`), the store (`openStore`, `defineTable`, queries, export and import), and the client surfaces' shared part (`Themes`, `ThemeChoice`, `WebScripts`, `TuiScripts`, messages and languages: `defineMessages`, `Translations`, `LocaleChoice`, `formatTime`, `formatNumber`). | Node and browsers |
| `@earendil-works/chord/http` | HTTP: a Web-standard `fetch` handler (`createHttp`) built from the routes, wraps and sockets plugins contribute to the registry `Http`, authenticators (`Authenticators`), responses as descriptions, a security baseline on by default, Chord's Node listener and `nodeRequest`, the links endpoint. | Node |
| `@earendil-works/chord/workers` | Workers: `createWorkers` runs a forked worker per address of a host kind, started on demand and stopped when idle; `workerMain` is a worker's entry; `processLock`. | Node |
| `@earendil-works/chord/workers/child` | The worker's side alone: `workerMain` and `processLock`, without esbuild (a worker entry imports this). | Node |
| `@earendil-works/chord/plugins` | Plugins: discovery, builds with esbuild (`buildFacet`), evaluation, the watcher, rollouts, `createPlugins`, `installPlugin`, `testPlugin`, `pluginFile`. | Node |
| `@earendil-works/chord/plugins/runtime` | `createPluginRuntime`: loads built plugins without esbuild (a worker's side). | Node |
| `@earendil-works/chord/app` | The app kit: `startServer`, `startWorker`, the start-data objects, sessions and the owner's sign-in, device pairing, files, export and import per address, optional plugins (users, invites, ephemeral login). | Node |
| `@earendil-works/chord/surfaces` | The client surfaces' server side: `webSurface` (base bundle, plugin scripts, the page) and `tuiSurface` (the terminal surface). | Node |
| `@earendil-works/chord/web` | The web surface's browser side: `startPage` in the app's web entry, `followThemes`, `followLanguage`. | Browsers |
| `@earendil-works/chord/react` | Optional React bindings: `HostProvider`, `useHold`, `useWatch`, `useRefState`, `useRegistry`, `usePageState`, `useMessages`, `watchStore`. | Browsers |
| `@earendil-works/chord/tui` | The terminal surface's sandbox side: `startTerminalRuntime` in the app's terminal entry, `BridgeTerminal`, `TerminalTheme`, `TuiScope`. | Node (sandboxed) |
| `@earendil-works/chord/tui/launcher` | The terminal launcher, the trusted side of a terminal client: `startTerminal`, `requireSandboxNode`. | Node |
| `@earendil-works/chord/context` | Explicit cancellation, telemetry, and invocation values: `BACKGROUND_CONTEXT`, `withCancel`, `withAbortSignal`, `withoutAbortSignal`, `withTelemetry`, `traceIn`, `withContextValue`, `awaitWithContext`. | Node and browsers |
| `@earendil-works/chord/delta` | The transactional JSON tracker, structural diff, immutable apply, and the wire encoder/decoder for operation batches. | Node and browsers |
| `@earendil-works/chord/json` | `JsonValue`, `JsonRepresentation`, `copyJson`, `isJsonValue`. | Node and browsers |
| `@earendil-works/chord/watch` | The watch types `Watchable`, `WatchHandle`, `NativeWatchable`, `NativeWatchHandle`, `WatchCall`, `NativeWatchCall`, and `WatchEnd`, with their implementations `Watch` and `NativeWatch`. | Node and browsers |
| `@earendil-works/chord/output` | Bounded output streams and paced progress: `OutputBuffer` (head or tail window of a stream, `OutputLimits`, `OutputSkip`), `boundOutput`, `sanitizeOutput`, `utf8ByteLength`, and `Progress` (adaptive commits of a changing value). | Node and browsers |
| `@earendil-works/chord/telemetry-sqlite` | `createSqliteTelemetry(db, { retentionMs?, maxQueuedSpans? })`: buffered recording and backend-independent `TelemetryStore` queries. | Any SQLite adapter |
| `@earendil-works/chord/sqlite` | Portable `SqliteDatabase`, `SqliteExecutor`, and `SqliteValue`, atomic `applySqliteMigrations(database, migrations, { table })`, and `validateSqliteSchemaPrefix`. The metadata table must be a valid, non-reserved SQLite identifier; migration versions start at 1 and are contiguous. | Any SQLite adapter |
| `@earendil-works/chord/sqlite/node` | `NodeSqliteDatabase`, `openNodeSqliteDatabase`, and `NodeSqliteDatabaseOptions`. | Node |
| `@earendil-works/chord/sqlite/cloudflare` | `DurableObjectSqliteDatabase` and the structural `DurableObjectSqliteStorage` binding type. | Cloudflare Durable Objects |
| `@earendil-works/chord/sync` | Sync (experimental): a store's outbox commits uploaded to a remote into slots created once (`uploadSession`), applied on another copy (`pullSession`), folded into snapshots (`foldSession`); `FlushScheduler`; the remote and sync-state interfaces, and directory-backed ones over a `SyncFileSystem` for development and tests. | Node and browsers |

`esbuild` (for `/plugins`, `/surfaces` and `/workers`), `ws` (for `/http` and `/tui/launcher`) and `react` (for `/react`) are optional peer dependencies, imported only there; `/app` uses all but `react`.

## Quick start

```ts
import { createHost, defineFacet, local, method, obj, str, constant } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const context = BACKGROUND_CONTEXT; // every call takes a context, used for cancellation

// A contract: params select the instance (one object per language), members are state and methods.
const Greeter = local("example.greeter", {
	version: 1,
	params: { language: str() },
	members: { language: str(), greet: method(obj({ name: str() }), str()) },
});

// A facet serves types with factories; a factory only declares and returns the implementation.
const facet = defineFacet((host) => {
	host.serve(Greeter, ({ language }) => ({
		language: constant(language),
		greet: async ({ name }) => (language === "de" ? `Hallo ${name}` : `Hello ${name}`),
	}));
});

const host = createHost({ onError: (error) => console.error(error) });
await host.load([{ name: "@example/greeter", facet }], context);

const german = await host.get(Greeter, { language: "de" }, context); // live: state has values, methods can be called
console.log(german.language.value, await german.greet({ name: "Mario" }, context)); // de Hallo Mario
german.release(); // the last reference released ends the object
await host.close(context);
```

## Documentation

- [Design](docs/design.md): the target design, the one current statement of every rule; [decisions](docs/decisions.md): the decision log; [slices](docs/slices.md): the build plan and its carry-over.
- [Plugins and hosts](docs/guide-plugins-hosts/book.md): a tutorial building a notes app with plugins, HTTP and workers; [plugin authoring](docs/plugin-authoring.md): the guide for agents writing plugins.
- [Examples](test/examples/): runnable references, one topic each. Run from `packages/chord`: `node --conditions=source --experimental-strip-types test/examples/01-objects.ts`.
- Each layer's README in `src/*/README.md` and `src/node/*/README.md`; the [delta guide](src/delta/README.md): ownership, lifecycle, operation, and replica contracts of `@earendil-works/chord/delta`.

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
