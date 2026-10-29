# Chord v2: the slice plan

Status: approved (owner, 2026-10-22); kept current. `design.md` states the rules; this file says which slice builds
what, and (section "Carry-over") what a slice deferred to a later one.

## Why slices

Building bottom-up made each layer guess the needs of callers that did not exist yet; L2 grew generic machinery
(nodes, sinks, deliveries, publications) that nobody could follow, and was deleted. A **slice** is the thinnest
end-to-end path through every layer a feature needs, so every API has a real caller from the first line. Later slices
extend earlier code; reworking it when a real need appears is expected, guessing ahead is not.

Per slice (owner, 2026-10-22): a one-page spec written by this session (`slice-N.md`, including the carry-over
entries it takes), the owner's approval, a build by a fresh Opus 5.5 subagent, reviews of the uncommitted code by this
session and by the reviewers Astra and Fable (`v2-review-astra`, `v2-review-fable`), fixes by the builder, the owner's
review of the uncommitted diff, commit. Deferred work goes into the section "Carry-over" below, under the slice
that must do it, in the same change (owner, 2026-10-22; moved here from `carry-over.md` on 2026-10-24). Every slice that touches a hot path (links, the store, relays) also adds a light benchmark script
(`packages/chord/test/next/bench/`, run by hand) for timing, memory and wire size of realistic payloads, with results
in `benchmarks.md` (owner, 2026-10-22). Every slice adds one or more runnable
examples (`packages/chord/test/next/examples/NN-topic.ts`, numbered across slices, in the format of Durable's
`test/examples/`), each on one topic: for the owner to run and dig around in, and as references for Chord's users
(owner, 2026-10-22). Implementers and reviewers read
the slice spec, the feature map below and the whole of `design.md` in full, and check the work against all three; a
slice spec's section citations are for orientation, not a reading limit (owner, 2026-10-22).

## What exists

- **L1** (`src/next/contracts`, `src/next/data`): contracts, params and identity, argument checks, principal keys,
  errors. `index.ts` for apps, `internal.ts` for Chord's own code.
- **Slices 1, 2, 3a, 3b, 4a, 4b, 5, 6a, 6b, 8** (committed; 5 `4a5b45c45`, 6a and 6b 2026-10-27/28, 8 2026-10-28): `src/next/documents`, `state`, `host`, `jobs`, `link`,
  `remote`, `store`, `registries`; examples 01-30 (Durable's 35-37); benchmarks in `benchmarks.md`.
- **Chord's shared code** (upstream pi): `src/watch.ts` (`Watch`, `NativeWatch`, `WatchHandle`, `WatchEnd`,
  `NativeWatchable`), Delta (`track`, `diffRevisions`, `applyImmutable`, encoders, `PendingOps`, `appendText`),
  context, JSON, output, SQLite drivers.

## The slices

Order (owner, 2026-10-22: routines and jobs before the store and reload; 2026-10-27: slice 8 before slice 7, whose
reload has to reload real registries; 2026-10-29: slice 7 split into 7a, 7b, 7c; the app kit as slices 10 and 11;
telemetry last, since it instruments the app kit too).

| # | Slice | In short |
| --- | --- | --- |
| 1 | **One host, local objects** | host, facets, local objects, references, in-memory documents, transactions, derives, watches |
| 2 | **Failures and natives** | `self.open`, activation failures and recovery, backoff, the drain, timeouts |
| 3a | **Remote objects over one link** | remote contracts, principals, variants, a memory link, the message format, holds, calls, one message per commit (no relay, no drops) |
| 3b | **Surviving drops** | re-holds, parking, `ref.state`, `host.hold`, `ref.retry()`, `linger` |
| 4a | **Links and relays** | host kinds, host addresses (`placement` then), routes, two-sided links, relays and principals, IPC and WebSocket, flow control, heartbeat |
| 4b | **Authority and housekeeping** | revocation, cycles across hosts, `host.references`, `host.activity`, size limits, compression |
| 5 | **Routines and jobs** | `self.routines`, `self.job` |
| 6a | **The store** | the store (backends, tables, queries, writes, commit queue, outbox, documents engine, migrations, export), persisted documents, `self.table`, keyed watches and retirement |
| 6b | **Durable and jobs on the store** | persisted jobs, Durable's `StoreStorage`, the Chord source over Durable's views (`self.follow`) |
| 8 | **Registries and `host.root`** | registries, `self.writable`, `retryOn`, Durable's `registryReader`, `host.root` (`chord(fn, context)` and the harness object are p3's base code) |
| 7a | **The dependency model** | requests that outlive providers, parked attempts without timers, wakes, the publication gate, getters, registries as dependencies, `parked_long` (`slice-7a.md`, `dependencies/model.md`) |
| 7b | **Reload in the kernel** | `host.reload`: staging, commit, rollback; swaps, restarts, removal and re-serving; holds and `accepts` across a reload; jobs and registries across a reload; per-name wakes (`slice-7b/` brief) |
| 7c | **Loader and dev** | `chord/next/loader` (discovery, `buildFacet`, `evaluateFacet`, `pluginFile`, dependencies) and `chord/next/dev` (watcher, reload control across hosts) |
| 10 | **HTTP and workers** | `chord/next/http` (server, `Http` registry, responses as descriptions, WebSocket entry) and `chord/next/workers` (a worker per address, IPC, idle stop) |
| 11 | **Web and TUI** | `chord/next/web` (page host, React hooks) and `chord/next/tui` (launcher, sandbox), from p2's code |
| 9 | **Telemetry** | spans, events, metrics across hosts |

The playground (`apps/chord-playground`) moves to the new code once slice 4 exists. Round-3 cuts (C3-C16) and
carry-over entries are decided in the slice that first needs them.

## Feature map

Every feature of `design.md`, by section, assigned to the slice that builds it. A slice's spec covers every entry
assigned to it; **implementers and reviewers check the slice spec, this map and the whole design** (owner, 2026-10-22). A feature missing here is a planning bug: add it before the slice that needs it. "Doc" means a documented
pattern, no code. Decided cuts are noted where they apply.

| § | Feature | Slice |
| --- | --- | --- |
| 3 | `createHost` with `telemetry`, `onError`; host without address | 1 |
| 3 | `createHost` with `principal`, `principalKey` (3a), `address` (4a), `revokedBy` (4b), the store (6a) | 3a, 4a, 4b, 6a |
| 3 | `load([{ name, facet }])` with static facets; start barrier (host-lifetime objects live before `load` resolves) | 1 (failed plugins reported: 2) |
| 3 | `connect`, `accept`, memory link pair, incarnations in the handshake, protocol-version handshake | 3a |
| 3 | host kinds, addresses, `route` (`authorize`, `resolve`), relayed holds and calls, re-resolve after a drop | 4a |
| 3 | IPC and WebSocket links, trusted links, the ack-clocked window per origin (K unacked state messages, pending queues, call window N per origin), relays with flow control per origin (`origin`, `closed`, senders FIFO), heartbeat | 4a |
| 3 | timeouts: `closeTimeout`, call drain, `readyTimeout` (C13: two host timeouts) | 2 |
| 3 | provider-side `linger` (C7: kept) | 3b |
| 3 | park deadline (= `readyTimeout`, C13) | 3b |
| 3 | `host.activity` (keep-alive counts) | 4b |
| 3 | `host.root(fn, …)` for code outside objects | 8 |
| 3 | requests that outlive providers: the destination by address, the publication gate, the unbound index, the check against the selected provider only; the start barrier's first outcomes (decision (a)) | 7a |
| 4 | principal type `P`, links stamp principals, principal keys in identity | 3a |
| 4 | revocation (`revokedBy`, `host.revoke`, propagation to children) | 4b |
| 5 | `local` types: params, members, checked arguments (Q15), results unchecked | 1 |
| 5 | version and fingerprint match at acquisition; reserved member names (`then`, `release`, `state`, `retry`) | 1 |
| 5 | `remote` types, variants chosen by the factory (`{ variant, members }`), identity with principal key, calls checked against the binding's variant | 3a |
| 5 | `accepts` mappings at runtime (old consumers), `contract_mismatch`/`updating` | 7 |
| 6 | lifecycle, one object per identity, lifetime from kind and params (Q-A), factory, activation, ending | 1 |
| 6 | failure causes, backoff per identity, dependency recovery (R18) | 2 |
| 6 | `retryOn` | 8 (first independently living source: registries) |
| 6 | parked attempts (no dependency deadline or backoff, wakes on every change, retry passing on), `FailureCause` `waiting`, `parked_long` and the authoring rules against cycles | 7a |
| 6 | cycle rejection on one host (Q5) | 1 |
| 6 | cycle rejection across hosts (activation chain in hold headers) | 4b |
| 6 | shared store with per-principal views; worker-wide native owners; natives following a relocation | doc (1, 3, 2) |
| 7 | `self.get`, `host.get`, hydrated references, members as watchables, `release` | 1 |
| 7 | per-reference watches (released with their reference) | 1 |
| 7 | `ctx.get` (call-scoped references) | 3a |
| 7 | `ref.state` (tagged), `ref.retry()`, `host.hold`, calls parking, failed references | 3b |
| 7 | getters wait through `waiting`; `host.hold` throws only for invalid params | 7a |
| 7 | `ref.variant` as discriminant, `RefIn` (C15: no `inVariant`/`expectVariant`) | 3a |
| 7 | `state: false` (C8: cut) | - |
| 7 | optional dependencies as registries | doc (8) |
| 8 | `ctx` with telemetry and signal | 1 |
| 8 | `ctx.principal`, `ctx.incarnation` (R20), `ctx.get` (3a); relayed incarnations (Q13, 4a) | 3a, 4a |
| 8 | `ctx.trace` (C11) | 9 |
| 8 | a job's `ctx.jobId`, `ctx.state` | 5 |
| 9 | `defineState`, singleton and keyed handles, `self.state`, in-memory documents (P2) | 1 |
| 9 | `self.tx`, `tx.draft`, `tx.retire`, drafts revoked (R12), no existence check (R13), lines per object | 1 |
| 9 | `handle.change`/`handle.retire` shorthands (C14: kept) | 1 |
| 9 | `initial()` checked once per definition (R8, D3) | 1 |
| 9 | `persist`, `checkpointWhen` (required for persisted documents), persisted only in local empty-params objects (P3), eviction | 6a |
| 9 | keyed watches (`handle.watch(key, ctx)`), `handle.at(key)`, retirement as a flag (decision "One retirement mechanism") | 6a |
| 9 | versions, `migrate`, schema fingerprints on records | 6a (in-memory migrate on reload: 7) |
| 9 | ~~facet documents, a served object's transaction spanning its facet's documents~~ (removed: C16 accepted, owner, 2026-10-26) | 1, removed in 6a |
| 9 | rules across owners, reconciling routines | doc (5) |
| 10 | the store: backends, tables, query runner, writes, commit queue, outbox, migrations, export/import | 6a |
| 11 | `Watchable`, watches (Chord's `Watch`), the batch (W1), reentrancy | 1 |
| 11 | `NativeWatchable`, `self.writable` | 8 |
| 11 | Durable's views as sources (`self.follow` over Durable's `observeXXX`) | 6b |
| 12 | `self.derive`, failures per member, lazy when unwatched, `mapShared` | 1 |
| 12 | container-width benchmark (R24) | 9 |
| 13 | `self.open`, close reasons, order, restart patterns (R16) | 2 (restarts on reload: 7) |
| 14 | `self.on` (W2b), `self.onLive`, `sleep`, `untilAborted` (C4 decided); the handover per object on reload | 5 (handover: 7) |
| 15 | `defineJob`, `self.job`, intent/run/finish, state documents, dedupe (Q9), `busy`, `running`, blocked `finish` (C3 decided); persistence, resume, restart limit; `accepts` in use | 5 (persistence: 6b; `accepts` and reload: 7) |
| 16 | `defineFacet<P>`, facet as declarations only (documents and routines removed in 6a) | 1, 6a |
| 17 | registries: `defineRegistry`, contributions, `compose`, versions (Q8), use-site guards | 8 |
| 17 | registry readers as parked dependencies (`waiting`), `host.registry` waiting, the last good value dropped when a contribution leaves | 7a |
| 18 | `constant(value)`, start data as a core object (`SessionInfo`) | 1 (core facet pattern: 4a) |
| 18 | platform bindings as core objects | doc (8) |
| 19 | `host.references` (presence) | 4b |
| 20 | flows kept by their owner, the `steps` helper, the Questions service | doc (5); deferred decisions #9, #11 |
| 21 | loading plugins (loader D), staging, atomic commit, pure swaps, native restarts, rollout, dev loop | 7 |
| 22 | message format, header schema, unknown ids, one message per commit per link, consumers apply ops, plugin errors | 3a |
| 22 | relays, size limits per part, compression at the origin, adapted bindings get diffs | 4a (relays), 4b (limits, compression), 7 |
| 22 | trace carriers (R5) | 9 |
| 23 | HTTP, channels, chunked transfers | after slice 9 (with the first real proof) |
| 24 | Durable integration: `chord(fn, context)` (Q6), a `RegistryReader` over composed registries; the harness object and its model and env registries are p3's (base code, owner, 2026-10-27) | 8 (Chord parts), p3 |
| 24 | `StoreStorage` | 6b |
| 27 | versions table: contracts (L1 done), registries 8, documents 6, jobs 5, link protocol 3a | as listed |
| 29 | telemetry spans, events, metrics, carriers | 9 (cost counters: every slice) |
| 30 | cost guards per hop | every slice |

## Size

About 9-10k source lines in total, as estimated for the layers (owner: fine, on the order of Durable).

## Carry-over

Obligations a slice deliberately left to a later one, under the slice that must do them, with where they came from.
Rules (owner, 2026-10-22): whoever defers something (this session, a subagent, a reviewer) adds it here in the same
change; a slice's spec includes every entry of its section, and its build and review check them off; a done entry is
deleted (the slice's spec and code are the record). Moved here from `carry-over.md` (owner, 2026-10-24).

### Any slice (protocol and checks)

- **Bump `PROTOCOL_VERSION`** for any message or reason change once p3 has shipped (slice 3b added `retry`, `loading`
  and `failed`'s `retryIn`; slice 4a parts, the list `bound`, `hello`'s `calls`, `ack`, `ping`, `pong`, `closed`,
  `origin` and the hold's `address`, `principal` and `incarnation`; all without a bump: nothing is deployed). (Owner,
  slice 3b.)
- **The park deadline's per-type override** is not built: a parked call waits the reference's `readyTimeout`. Build
  it only if a real case needs it. (Slice 3b spec.)
- Failed-check paths are TypeBox's instance paths (ambiguous for keys containing `/` or `~`); documented, not fixed.
  (L1.)
- No CBOR; revisit only if benchmarks show encoding as a bottleneck (slice 3a's and 4a's do not). (L2 decisions.)
- **One N on every host:** a relay forwards calls at once, so a worker announcing a smaller N than the relay's could
  see more running calls of one origin than it accepts (a protocol error). Every host announces 256; per-link N, if
  ever needed, must bound the relay's forwarding too. (Slice 4a rework.)
- **The Durable conversation view's size on re-hold** is a known cost until pi #11327 (windowed view) lands. (Slice 4.)
- **`map(bytes())` is refused at declaration** ("unsupported keyword `~refine`"): TypeBox's `Record` copies the bytes
  schema's check as an enumerable key, which the snapshot walk refuses. An L1 bug found in slice 3a, not fixed yet.

### Slice 7b: reload and rollout (7a: the dependency model, `slice-7a.md`)

- **A native restart drains first** (owner, 2026-10-26): park new calls, await running calls (bounded by
  `closeTimeout`), then close the natives and restart; a call outliving the drain is cut off by the seal fence. Running
  job runs on a native restart: decide with the runs now owned by the object.
- **From slice 6a's second spec review** (decision "Second spec review: the majority"): remote holds and remote objects
  leaving `live` (`Hold.moved` for bound and binding holds, `RemoteObject.failed` for a live object; not reachable in
  6a, P3); old table handles' version fence (old code issuing SQL for a dropped column); the routine handover fenced
  per routine invocation; holds unsubscribed at seal and re-bound by member name; keyed members' versions mapped per
  key; in-memory `migrate` wired to reload (6a builds the slot version check and the migrate); `rebuild` (key and
  column-type changes) if a case needs it.
- **From slice 6b:** a persisted run of another job version or fingerprint stays `blocked { version }` with its record
  as stored (resolve it on reload); blocked persisted runs are retried on reload; runs of jobs the code no longer
  declares (below).
- **A run whose job the new code no longer declares** (slice 6a builder, 2026-10-27): 6a keeps it in its phase,
  waiting, not invoked (unreachable without reload); slice 7 decides `blocked` with a reason (design §15's
  `blocked { version }` family).
- **A job's new version on a live object** (slice 6a build review, 2026-10-27): 6a keeps the first declaration's job
  definition in the object's records and refuses a later declaration with another version, so a host-lifetime object
  (`local`, empty params) stays broken until the host restarts; slice 7 maps the records to the new version (or blocks
  the old runs) on reload.

- **Publications wake per name** (from slice 7a): `UnboundIndex.wakeAll()` wakes every indexed request, right for the
  one publication 7a has; a reload's or an install's publication wakes only the requests of the names it serves
  (`wake(names)`), or every refused hold on the host would re-run its start.
- **The reload handover of a parked attempt** (from slice 7a): the new attempt's requests bind before the old ones are
  released (M§3.9); the mechanism (an attempt releasing its predecessor's references after binding its own) was removed
  in 7a with R18's kept references, its only feeder.
- **Routines on reload** (from slice 5): the handover per object, bounded by `closeTimeout`; calls do not wait for it.
- **Jobs on reload** (from slice 5): `accepts` in use (args and result mapped forwards once per run; `blocked
  { version }` without an adapter or for a newer version); when an older run's state document may migrate while its
  old code still writes it, and an older run keeping its old handles valid until it settles; a native restart aborts
  running runs (`aborted`, reason `reload`) and `finish` runs on the new code; a `finish` in flight across a reload;
  (run records and state documents belong to the object: built in 6a);
  blocked runs retried on reload; a job declaration removed while runs exist; a job fingerprint over args, result and
  state (a schema change without a version bump); an `on` routine whose source failed and recovers after a provider
  reload.
- **Instance ids on restart** (from slice 4b): a retry keeps an object's instance id; a reload that restarts an object
  must give the new instance a new id, so an old chain never matches it.
- **`host.references` and removed types** (from slice 4b): a type's presence list lives from its first
  `host.references(Type)` for the host's life; a reload that removes the type drops it.

- **Holds across reloads** (from slice 3a): a hold's indexes belong to its bound version. A reload that still accepts
  that version keeps the hold: a pure object re-subscribes the hold through the version's mappings and sends
  `[["r", value]]` for each member whose value changed; a restarted object sends a fresh snapshot for the same hold (a
  second `bound` on a bound hold, which 4a's consumer applies as a re-binding). A served hold whose object leaves
  `live` while its `bound` waits for a slot goes back to pending (cut from 4a, where nothing leaves `live`; owner,
  2026-10-24: slice 7 builds and tests it in `Hold.moved` and `ProviderSide.unbind`). A reload
  that drops the version ends its holds with `gone` (`contract_mismatch`) before the new code serves anything. A
  consumer whose own code moves to a new version re-holds (new hold id) and releases the old.
- **Old-version calls** (L1): `checkArgs` returns `{ kind: "method"; args; result? }` or `{ kind: "call"; args; call }`;
  invoke the handler or the provider's `call`, and map the result back with `result` for an old-version caller.
- **Derives on reload:** derives have no names (owner, 2026-10-22); exposed derives are matched by their member name,
  internal ones are rebuilt; add matching only if a real need appears. (W1.)
- **Retrying broken failures:** reload retries a broken object as `ref.retry()` does (`ChordObject.retry`: the
  backoff skipped, an attempt now; holders are told `loading`). (Slices 2, 3b.)
- **Registries on reload** (from slice 8 §6): a reload replaces a plugin's contributions and a provider atomically, in
  one batch (staging composes nothing, decision D1 of "Review round 1"); the record keeps the provider, facet
  contributions by plugin and object contributions by object apart for it (`RegistryRecord.serve` refuses a second
  serve today). Older registry readers across a reload of the provider (their mapped values follow the new
  `accepts[old].value`). A `writable` across a pure swap: the new factory makes a new `self.writable(initial)`, so a
  contribution goes back to its initial value until the restarted routine sets it (MCP's tools would vanish briefly).
  `retryOn` watches across a reload (a reload retries failed objects anyway). (Slice 8 spec.)

### Slice 9: telemetry

- Spans for routine calls and job runs (from slice 5).
- The use of a persisted run's stored start trace carrier (`trace`, stored since slice 6b).

- Round-3 cut to decide: C11 (`ctx.trace`).

### When v2 goes upstream

- `mapShared` lives in `src/next/state/derive.ts` and moves into Delta. (L2 decisions.)
- `withLinkedAbortSignal` lives in `src/next/host/ctx.ts` and moves next to `withAbortSignal` in `src/context` (pi
  first): a call's context linked to long-lived abort signals until the call settles, instead of `AbortSignal.any`,
  which keeps cleanup entries per call while its sources live before Node 24.16.0 (nodejs/node#62367). (Slice 4a.)
- The `./next` package export returns when the new code has an entry point (removed with the frozen-kernel move).
- A `./next/node` export for `nodeCompression` (`src/next-node/`), with `./next`. (Slice 4b.)

### The sync layer (not a slice; when Radius sync is built)

- Upload, acknowledgement and `store.outbox.trim`, epochs, pull-back, the split (S5, S7); a store opened with an
  outbox (decision "The outbox is optional, internal and versioned") starts its sync from an archive.
- Snapshot reads for large exports on a second SQLite connection (S4), if exports get large.

### Outside the slices

- The playground's runtime tests fail on a stale `node_modules` copy of chord 1.3.0; relink with
  `npm install --ignore-scripts` when the playground is used again. (Frozen-kernel move.)
