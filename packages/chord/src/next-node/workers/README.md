# workers

The workers component (slice 10 §3, §4, design §23, decision "Slice 10's points"): a forked worker process per address
of one host kind, started on demand by the route it owns, stopped when idle, never restarted by itself; its plugins are
built by the server and shipped. `workerMain` is the worker's side. Node-only. Exported as
`@earendil-works/chord/next/workers` once v2 has its entry point.

## For apps (`index.ts`)

```ts
// server.ts
const workers = createWorkers(server, Session, {
	kind: "worker", entry: "./worker.ts", execArgv: ["--import", resolver], env: { … },      // bootstrap
	authorize: (principal, address) => app.mayReach(principal, address),                   // the route's (synchronous)
	principal: (address) => ({ kind: "worker", session: address.params.id }),
	start: (address, ctx) => app.startData(address, ctx),                                  // JSON, before each start
	lock: (address) => `app:${dataDir}:worker:${address.key}`,                             // one live worker per address
	idleMs: () => app.idleMs(),                                                            // 5 min by default
	plugins,
	onOutput: (address, stream, chunk) => logs.append(address.key, stream, chunk),
	onError: (error) => log(error),                                                        // WorkersError
}, ctx);
workers.state                                   // { [address key]: WorkerState }, a JSON watchable
await workers.stop(Session({ id }), ctx);       // suspended while held, then stopped
await workers.retry(Session({ id }), ctx);      // a failed or suspended address starts again (if held)
await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, ctx);
await workers.close(ctx);

// worker.ts
workerMain(async ({ address, start, parent, plugins, onClose }, ctx) => {
	const host = createHost({ address, principal: { kind: "worker" }, store, onError });
	onClose((ctx) => host.close(ctx));                                    // closers run in reverse order
	host.connect(parent, { principal: { kind: "server" }, trusted: true }, ctx);   // first: `started` goes out now
	await plugins.load(host, { kind: "worker", core: [{ name: "@app/core", facet: core(start) }] }, ctx);
	return { busy: harness.activeTasks };                                 // extra keep-alive counts
}, { hostPackages: { "@earendil-works/chord/next": chordNext }, redact: (error) => ({ message: redacted(error) }), onError });
```

- **The route:** `createWorkers` calls `host.route(Kind, …)` itself and keeps its `RouteHandle`. A failed address's
  `resolve` rejects at once with its stored failure (its holders see `failed { waiting }`, nothing forks); the kernel
  reports that rejection (`resolve_failed`) once per new hold, so every tab opening a failed session adds one `onError`
  entry.
- **Per address:** a child's events (`started`, `ready`, `idle`, `fatal`, its exit, its link closed by this side) are
  recorded on that child as they happen (a late event of an old child changes nothing); starts and stops run one after
  another. A start waits for the previous child's exit and rejects with a crash recorded meanwhile; a stop records its
  intent before `shutdown`, so the exit it causes is no crash.
- **A start:** the app's `start(address, ctx)` (aborted by `close`), then the fork (`serialization: "advanced"`, a
  detached process group, the server's environment with `env` over it: a worker inherits every variable the server
  has, secrets included, unless the app starts the server with a trimmed one; stdout and stderr piped: the stderr tail
  kept, both mirrored to this process's own without `onOutput`), its IPC link made at once, the start message `{
  address, start, scripts, lock }` (`scripts`: the kind's current set, `plugins.scripts(kind)`). The child takes the
  lock (waiting for an old holder without polling), makes its parent link and sends `started` when the app's host
  connects; `resolve` returns the link then. The start timer (60 s) covers fork, lock and connect only. `ready` (after
  the app's function returned, with the idle state and the load report) makes the worker `running`.
- **Failures stay** (R2): a crash (an exit nobody asked for), a `fatal`, a link closed by this side (the heartbeat, a
  protocol error: the child is stopped, grace 5 s, then killed) or a failed start leaves the address `failed`
  (`worker_failed` once, `worker_exited` for the exit) until `retry` or a rollout reaching workers.
- **Keep-alive:** the child reports when its idleness flips: `host.activity`'s `references`, `jobs` and `lingering` and
  the app's `busy` (a JSON watchable of a record of numbers) all zero, no reload running; local calls send nothing.
  The server stops a worker idle since `idleMs()` (checked every second, from `ready`). A stop: `shutdown`; the child
  aborts its context, runs its closers in reverse order and exits (forced after 3 s); the server kills the tree after
  5 s.
- **`state`:** per address key `{ status: "starting" | "running" | "stopping", pid, startedAt }` or `{ status:
  "failed", error: { message, code?, reason? }, at }`; no entry when stopped. The error is public (decision "worker
  errors in public"): a `fatal` as the child's `redact` made it, else a fixed message (`worker failed to start`,
  `worker exited (SIGSEGV)`, `worker exited (code 1)`); holders see the same. The full error and the stderr tail go
  only to `onError` (`worker_failed { address, error, stderrTail }`). Every app hook of a start (`start`, the fork,
  `lock`, `principal`) is inside that boundary; a throwing `authorize` refuses the hold (`forbidden`) and is reported
  `authorize_failed`, its error private too.
- **`stop(address, ctx)`:** `RouteHandle.suspend`, then the stop: holders see `failed { waiting }` ("suspended") until
  their last release; a later hold starts it on demand; `retry` lifts it at once.
- **`close(ctx)`:** starts waiting in `start(address)` are aborted, every child stopped, new starts reject
  `released/closed`; the host's close (the route's context) closes it too, and no exit after that is a failure.
- **`step(name)`** (§4): clears the failures from before it and retries the held ones (listed `{ host, report }` with
  their load report once ready, or `{ host, error }`), then ships the kind's current set to every worker whose last
  set is older, in parallel, one reload outstanding per child: `{ host, report }`, `{ host, stopped: true }` (stopped
  cleanly meanwhile) or `{ host, error }` (a crash, a failed reload). The step's context bounds only its wait (an abort
  lists the waiting ones with the abort's error; a late reply still frees the child's slot).
- **The child** (`workerMain`): reads the start message, takes the lock, makes its parent link (`started` on the app's
  `connect`), gives the app `plugins` (`WorkerPlugins.load(host, { kind, core })` over the shipped scripts, with the
  child's own `hostPackages`), applies `reload` messages once the app's function returned (none while shutting down).
  `shutdown`, the parent's disconnect, `SIGTERM` and `SIGINT` abort its context and run the closers registered so far,
  also during startup. An uncaught error or a throwing function sends `fatal` with `redact(error)` and exits 1.
- `processLock(name, ctx)`: the lock (an abstract socket on Linux, a named pipe on Windows, a socket file elsewhere).

## Examples

`test/next/examples/`: `41-workers` (a worker started on the first hold, stopped when idle), `42-worker-crash` (a crash
stays failed, Retry brings it back), `43-rollout` (an edit rolled out to the server and its workers).

## Inside the directory

`control.ts` (control messages and errors as they cross), `lock.ts` (process locks), `process.ts` (one forked worker
as the server sees it), `workers.ts` (the component: the route, per-address records, idle stops, the rollout step,
the state), `main.ts` (`workerMain`).
