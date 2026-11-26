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
(`packages/chord/test/bench/`, run by hand) for timing, memory and wire size of realistic payloads, with results
in `benchmarks.md` (owner, 2026-10-22). Every slice adds one or more runnable
examples (`packages/chord/test/examples/NN-topic.ts`, numbered across slices, in the format of Durable's
`test/examples/`), each on one topic: for the owner to run and dig around in, and as references for Chord's users
(owner, 2026-10-22). Implementers and reviewers read
the slice spec, the feature map below and the whole of `design.md` in full, and check the work against all three; a
slice spec's section citations are for orientation, not a reading limit (owner, 2026-10-22).

## What exists

- **L1** (`src/contracts`, `src/data`): contracts, params and identity, argument checks, principal keys,
  errors. `index.ts` for apps, `internal.ts` for Chord's own code.
- **Slices 1, 2, 3a, 3b, 4a, 4b, 5, 6a, 6b, 8, 7a** (committed; 5 `4a5b45c45`, 6a and 6b 2026-10-27/28, 8 2026-10-28, 7a
  2026-10-29): `src/documents`, `state`, `host`, `jobs`, `link`, `remote`, `store`, `registries`; examples 01-32
  (Durable's 35-37); benchmarks in `benchmarks.md`.
- **Slice 7b** (built 2026-10-29, `slice-7b.md`): `host.reload`, staging (`host/staging.ts`), fates, adapted members
  (`host/adapted.ts`), references, jobs and registries across a reload; examples 33-34; `test/bench/reload.ts`.
- **Slice 7c** (committed 2026-10-30, `slice-7c.md`): `src/node/plugins/` (discovery, builds, evaluation,
  `pluginFile`, `mapStack`, `installDependencies`, the watcher, `rollout`), per-plugin `load` and `reload`; examples 35-39.
- **Slice 10** (built 2026-10-31, `slice-10.md`): `src/node/http/` (a `fetch` core with the security baseline,
  Chord's Node listener, `nodeRequest`, plugin sockets, links), `src/node/workers/`, `createPluginRuntime`, kinds,
  the kernel's `RouteHandle` and anonymous `host.root`, origins only from relays; examples 40-48.
- **Slice 12** (committed 2026-11-01, `slice-12.md`): the plugin model in `src/node/plugins/` (the app's versioned
  API, per-kind files, single-file plugins, installs from git and npm, `testPlugin`); examples 49-52.
- **Slice 13** (committed 2026-11-02, `slice-13.md`): the app kit, `src/node/app/` (`startServer`, `startWorker`,
  sign-ins, owner link, pairing, `Files`, `exportData`/`importData`); examples 53-55.
- **Slice 11** (committed 2026-11-03, `slice-11.md`): `src/surfaces/` (scripts objects, registered scripts, the
  connection loop, clients, themes), `src/web/`, `src/react/`, `src/tui/`, `src/node/surfaces/`, `src/node/tui/` (the
  launcher and its child-process sandbox); examples 56-59.
- **Live queries** (built 2026-11-03, decision "Live queries over an object's own tables"): `self.query` in
  `src/store/live-query.ts`; examples 59 and 61 use it; `test/bench/live-query.ts`.
- **Slice 9** (built 2026-11-04, `slice-9.md`): telemetry, `src/telemetry.ts` (`CHORD_TELEMETRY_SCHEMA`, the span sites'
  NOOP rule, open spans, typed instruments), spans of calls, methods, relays, holds, activations, natives, loads,
  reloads, resolves, revocations, routines, job phases and HTTP requests, carriers on `hold` and `call`, `ctx.trace`,
  commit events and the host-wide metrics, `telemetry` options of `createHttp`, `startServer` and `startWorker`;
  example 62; `test/bench/telemetry.ts` (with R24's container width).
- **Reload restarts every affected object** (built 2026-11-05, decision "Reload restarts every affected object; old
  work finishes on old code"): the pure swap removed; old work through the call chain (`host/old-work.ts`) and
  `call.old`, a restart's readiness (`host/readiness.ts`), reload cycles (`host/reload-cycle.ts`),
  `reloadDrainTimeout`; example 64.
- **Events and call windows by trust** (built 2026-11-11, spec `events/spec.md` §2, §3, §5, §6; decisions "Events:
  fire-and-forget members", "Call windows only for untrusted links"): the third member kind (contracts' `events` and
  `event(schema)`, edits, `accepts.events`), `host/events.ts` (the emit counter, the event flush, sources,
  subscriptions), `host/reference-events.ts` (references' event members, re-exposure), event mappings in
  `host/adapted.ts`, the `event` message and `ack.events` (both codecs), event windows and tickets in
  `remote/provider.ts`, `useEvents`, `TuiScope.on`; `callWindow` (none announced on trusted links) and relayed calls
  queued per upstream window; example 67; `test/bench/events.ts`.
- **Slice 14, first part** (built 2026-11-15, `slice-14.md`; committed `92e1db6ca`): column sets (`defineColumns`,
  `exposes`), `exists`, `existsNode`, the one-to-one `join`, conditions as data (`compile`, `whereNode`) in
  `src/store/` (`column-set.ts`, `expression.ts`, `query.ts`, `read-plan.ts`); the store's reads with the skip test
  and the keyed probe (`read.ts`, `reads.ts`, `skip.ts`, `open-query.ts`, `page.ts`), `self.query` rebuilt over
  them; the `queries` member kind and `self.queries`, `self.liveQuery`, `self.count`, `page` (`host/named-query.ts`,
  `host/query-reader.ts`, `host/read-declarations.ts`); lists over one source, `self.list` (`host/list.ts`,
  `host/tiling.ts`; `state/framed.ts`); examples 70, 71 and 72; `test/bench/slice-14.ts`. The rest of the slice is under "Carry-over".
- **Slice 14, second part** (built 2026-11-15, `slice-14.md` §2, §6; not committed): admission with a typed value
  (`admission` in a remote contract, `host.serve(Type, factory, { admit })`, `host/admission.ts`: the decision an
  attempt parks on, hands its factory and follows; the seal on a change in `host/object.ts`; staging's rehearsal by
  admission fingerprint), the failure kind `denied` in both codecs, the binding fence per acknowledgement
  (`remote/hold.ts`), a route's admission (`host/route-admission.ts`, the gated path and its fence in
  `remote/path.ts`, `Channel.fence`, `createWorkers`' `admit`), `deleteHostData(address, ctx, { plugin })`; example
  69.
- **Slice 15, grantable members and flags** (built 2026-11-25, `slice-15.md` §1): `grantable(...)` and `flags` in
  remote contracts (`contracts/declare.ts`, `schema.ts`; members, grantable names and flags in `VersionData`, the
  shape a grant leaves in `grantedMembers`), `GrantableName`, `allow({ granted })` read against the contract
  (`host/admission.ts`), builders called for granted members only (`host/members.ts`), references with optional
  grantable members and `granted` (`host/reference.ts`), `granted` indexes on the wire's `bound`, `useLive` and
  `TuiScope.live` (`surfaces/live.ts`); variants removed everywhere (contracts, `evolve`, `accepts`, factories,
  references, wire, React and TUI bindings); example 77.
- **Slice 15, denials with a message** (built 2026-11-25, `slice-15.md` §2): `deny(reason, message?)`, the message
  as data in the `forbidden` error's `details.message` and part of the decision (`host/admission.ts`);
  `MessageData` and `MessageSchema` (in `contracts/message.ts` since flag labels are messages; re-exported by `data` and `surfaces`); example 78.
- **Slice 15, the commit index** (built 2026-11-25, `slice-15.md` §3): `store/read-index.ts` (buckets by the
  equalities a read's plan fixes, `ReadPlan.equalities`; kept keys, kept current by the read, `Read.kept`), used by
  `Reads.candidates` in a commit's refresh; the oracle's world shared by `test/store/skip.test.ts` and
  `read-index.test.ts` (`test/store/read-world.ts`); `test/bench/commit-index.ts`.
- **Slice 15, stale holders** (built 2026-11-25, `slice-15.md` §4, §8): reproduced across processes
  (`test/link/channel.test.ts`, fixtures `stall.ts`, `socket-link.ts`); no holder live and old; why a link closed
  (`LinkCloseReason` in `link/channel.ts`), `chord.links.closed { reason }` and the `link_closed` report of a heartbeat
  close (`remote/host-link.ts`).
- **Slice 15, lazy named queries** (built 2026-11-25, `slice-15.md` §5): a reference's `queries` member makes its
  `ReferenceQuery`s on first use (`referenceQueries` in `host/named-query.ts`, a class per member and contract
  version, cached weakly), labels built when asked; `test/bench/reference-heap.ts`.
- **Hold memory** (built 2026-11-25 on slice 15, no slice of its own; `benchmarks.md` "Hold memory"): what an object
  keeps while it is held, about halved with no change of behaviour. Maps, sets and lists of an attempt, an object,
  its documents, a decision and a reference are made by their first entry (`host/attempt.ts`, `object.ts`,
  `admission.ts`, `reference.ts`, `documents/documents.ts`); short lists are built without a `push`'s slack
  (`src/lists.ts`: `appended`, `NO_ITEMS`); a source keeps none or one dependent without a set
  (`state/dependents.ts`, telling whom a set's iteration tells whatever its dependents do meanwhile); a decision
  follows its references' states directly (`Binding.followState`), no promise and abort listener per reference, and
  ends all its follows by one listener of a signal depending on its context's; a granted set is shared by the decisions granting the same names of a contract version, held weakly
  (`grantedSet` in `host/admission.ts`), a member order by every binding of the same members (`memberOrder` in
  `contracts/contract.ts`); canonical JSON, labels and
  instance ids are flat strings (`data/principal.ts`, `host/object.ts`, `host/uuid.ts`); a read plan of an unjoined
  query shares its sides and keeps exact lists (`store/read-plan.ts`, `query.ts`, `read.ts`, `live-query.ts`).
  `test/bench/hold-heap.ts`; cost guards in `test/lists.test.ts`, `test/state/dependents.test.ts`,
  `test/host/object.test.ts` and `test/host/admission.test.ts`.
- **Hot paths** (built 2026-11-26 on the hold-memory pass, no slice of its own; `benchmarks.md` "Hot paths"): time,
  garbage and retained memory of admitted objects held over a link, of live queries and of the commit step, for plain
  data (values handed to Chord are immutable by convention: never copied, compared by identity first). An admission's
  re-read compares the value with the one it read last, field by field (`sameJson` in `data/plain-json.ts`), and its
  names as bits of the version's grant indexes (`grantTable` in `host/admission.ts`), no canonical text; granted sets
  are found by a hash of those indexes, granted members and grant indexes by the shared set, a combination's members
  held weakly by its names (`grantedMembers` in `contracts/contract.ts`); a checked implementation keeps the object's
  values over the contract's names (`MemberValues` in `host/members.ts`); the rare fields of an attempt and an object
  sit in records made on first use (`AttemptExtras`, `ObjectExtras`); holders and followers keep one member without a
  set (`src/small-set.ts`); instance ids are built from numbers (`host/uuid.ts`). The binary codec encodes into one
  kept buffer with one exact copy per message and decodes lists by readers (`link/binary.ts`); a hold's followed
  member is its own subscriber, its encoder and pending queue made at first use, a served hold keeps its params as
  their text (`remote/hold.ts`); a remote object keeps one binding without a set (`remote/bindings.ts`), makes its
  hold request per hold, and shares its granted set per version and names (`remote/consumer.ts`). A live query keeps
  its rows' values, not the backend's rows (`store/live-query.ts`; the backend's row contract in `store/backend.ts`);
  reads of one named query share their plan's shape, each still compiled and checked in full (`PlanShape` in
  `store/read-plan.ts`); the commit index files a value's one read without a set and files a read run again by
  difference (`store/read-index.ts`). What a host retains after work came and went: `test/host/retained.test.ts`
  (every cache evicts; no growth round after round). Benches `test/bench/hot-paths.ts`, `list-heap.ts`,
  `hold-heap.ts` (client heap, case 8), `commit-index.ts` (case 3).
- **Chord's shared code** (upstream pi): `src/watch.ts` (`Watch`, `NativeWatch`, `WatchHandle`, `WatchEnd`,
  `NativeWatchable`), Delta (`track`, `diffRevisions`, `applyImmutable`, encoders, `PendingOps`, `appendText`),
  context, JSON, output, SQLite drivers.

## The slices

Order (owner, 2026-10-22: routines and jobs before the store and reload; 2026-10-27: slice 8 before slice 7, whose
reload has to reload real registries; 2026-10-29: slice 7 split into 7a, 7b, 7c; the app kit as slices 10 and 11;
telemetry last, since it instruments the app kit too; 2026-11-01: the plugin model (12) and the app kit (13) before web and TUI (11), which builds into the kit).

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
| 7b | **Reload in the kernel** | `host.reload`: staging, commit, rollback; restarts (swaps until 2026-11-05), removal and re-serving; holds and `accepts` across a reload; jobs and registries across a reload; per-name wakes (`slice-7b/` brief) |
| 7c | **Plugins** | `chord/plugins` (discovery, `buildFacet`, `evaluateFacet`, `pluginFile`, `installDependencies`, the watcher, `rollout`, `mapStack`; no dev/prod split; the kernel's `load`/`reload` per plugin; `slice-7c.md`) |
| 10 | **HTTP and workers** | `chord/http` (server, `Http` registry, responses as descriptions, WebSocket entry) and `chord/workers` (a worker per address, IPC, idle stop) |
| 12 | **The plugin model** | imports (relative within a repository, package names pinned across), versioned app API with Chord re-exported, per-kind API modules and contract files with the build's import check, single-file plugins, git installs, `testPlugin`, a required root (`slice-12.md`) |
| 13 | **The app kit** | `chord/app`: `startServer`, `startWorker`, layout, worker kinds, owner link, deny by default, sign-ins, CLI tokens, storage, the files plugin, export per address, plugin roots and "apply changes", base code as API, bootstrap and a start-data facet (`slice-13.md`) |
| 11 | **Web and TUI** | `chord/web` (page host), `chord/react` (React hooks), `chord/tui` with `chord/tui/launcher` (sandbox, launcher) and `chord/surfaces` (their server side), from p2's code |
| 9 | **Telemetry** | spans, events, metrics across hosts |
| 14 | **Admission, named live queries, lists, joins by key** | admission with a typed value, route admission, named queries read live by any object on the store's host with a skip test and a keyed probe, counts, lists, column sets with `exists` and a one-to-one join, conditions as data (`slice-14.md`; built in parts, see "What exists" and "Carry-over") |
| 15 | **Grantable members and flags, denials with a message, the commit index, stale holders, lazy queries** | variants replaced by grantable members and flags, `deny(reason, message?)`, an index of open reads by equality and kept keys for the commit step, holders never left live and stale after a stall, a reference's named queries built on first use (`slice-15.md`) |

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
| 3 | call windows by trust (`callWindow`, none announced on trusted links, optional `hello.calls`), relays honouring each upstream window (relayed calls queued per upstream link and origin); the event window per link and origin (`eventWindow`), event tickets, relays forwarding and filtering events without acks of their own | events |
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
| 5 | `remote` types, identity with principal key, calls checked against the binding | 3a |
| 5 | grantable members and flags (`grantable`, `flags`, `GrantableName`), `allow({ granted })`, builders called only if granted, `forbidden` for a member not granted; variants removed | 15 |
| 5 | `accepts` mappings at runtime (old consumers), keyed members per key, `contract_mismatch` | 7b |
| 5 | event members (remote `events`, local `event(schema)`), `EventMember`/`EventSource`/`EventSubscription`, the member check for event members | events |
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
| 7 | a reference's grantable members (optional, there while granted or before it was first live) and `granted` | 15 |
| 7 | `state: false` (C8: cut) | - |
| 7 | remote references of one host sharing one wire hold (sharing key per path, seen members, a non-final release cancelling its own calls newest first, the private retry after `too_large/part`, the hold span as shared work; spec `shared-holds/design.md`) | shared holds |
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
| 9 | versions, `migrate`, schema fingerprints on records | 6a (in-memory migrate on reload: 7b) |
| 9 | ~~facet documents, a served object's transaction spanning its facet's documents~~ (removed: C16 accepted, owner, 2026-10-26) | 1, removed in 6a |
| 9 | rules across owners, reconciling routines | doc (5) |
| 10 | the store: backends, tables, query runner, writes, commit queue, outbox, migrations, export/import | 6a |
| 11 | `Watchable`, watches (Chord's `Watch`), the batch (W1), reentrancy | 1 |
| 11 | `NativeWatchable`, `self.writable` | 8 |
| 11 | Durable's views as sources (`self.follow` over Durable's `observeXXX`) | 6b |
| 11 | live queries (`self.query(table, q, limit)`: run before live, re-run per touching commit, diffed) | after 11 |
| 10 | column sets (`defineColumns`, `exposes`), `exists`, `existsNode`, the one-to-one `join`, conditions as data (`compile`, `whereNode`), the store's reads, the skip test and the probe | 14 |
| 11 | named queries (`queries`, `self.queries`), `self.liveQuery` (arguments that follow a value), `self.count`, `page` | 14 |
| 11 | lists over one named query (`self.list`: pages between bookmarks, `more`, splits and merges, overflow, bookmarks across a reload) | 14 |
| 11 | lists over several named queries merged into one | 14 (carry-over) |
| 11 | the commit index: a commit skip-tests only the reads its writes can concern (buckets by equality, kept keys) | 15 |
| 3 | why a link closed (`chord.links.closed { reason }`), a heartbeat close reported (`link_closed`); a stall leaves no holder live and old | 15 |
| 11 | a reference's named queries made on first use | 15 |
| 6 | admission with a typed value (`admission`, `admit`, the watch table, staging's rehearsal, no jobs in an admitted object) | 14 |
| 6 | `deny(reason, message?)`: a message as data for the person in the denial's `details.message` | 15 |
| 3 | a route's admission (`RouteOptions.admit`, one decision per principal and address, the fence after a denial, `createWorkers`' `admit`) | 14 |
| 10 | `deleteHostData(address, ctx, { plugin })` | 14 |
| 22 | the failure kind `denied`; binding fences per acknowledgement | 14 |
| 11 | events: the emit counter, the event flush after published state, eligibility per binding, listeners outside the fence, re-exposure, `self.events` | events |
| 12 | `self.derive`, failures per member, lazy when unwatched, `mapShared` | 1 |
| 12 | container-width benchmark (R24) | 9 |
| 13 | `self.open`, close reasons, order, restart patterns (R16) | 2 (restarts on reload: 7b) |
| 14 | `self.on` (W2b), `self.onLive`, `sleep`, `untilAborted` (C4 decided); routines across a restart | 5 (reload: 7b) |
| 15 | `defineJob`, `self.job`, intent/run/finish, state documents, dedupe (Q9), `busy`, `running`, blocked `finish` (C3 decided); persistence, resume, restart limit; `accepts` in use | 5 (persistence: 6b; `accepts` and reload: 7b) |
| 16 | `defineFacet<P>`, facet as declarations only (documents and routines removed in 6a) | 1, 6a |
| 17 | registries: `defineRegistry`, contributions, `compose`, versions (Q8), use-site guards | 8 |
| 17 | registry readers as parked dependencies (`waiting`), `host.registry` waiting, the last good value dropped when a contribution leaves | 7a |
| 18 | `constant(value)`, start data as a core object (`SessionInfo`) | 1 (core facet pattern: 4a) |
| 18 | platform bindings as core objects | doc (8) |
| 19 | `host.references` (presence) | 4b |
| 20 | flows kept by their owner, the `steps` helper, the Questions service | doc (5); deferred decisions #9, #11 |
| 21 | `host.reload`: staging, atomic commit, restarts with old work on old code, removal and re-serving | 7b, restart-only 2026-11-05 |
| 21 | loading plugins (loader D), dev loop; the rollout across hosts is the app's (decision "Slice 7b's open points" (3)) | 7c |
| 22 | message format, header schema, unknown ids, one message per commit per link, consumers apply ops, plugin errors | 3a |
| 22 | relays, size limits per part, compression at the origin, adapted bindings get diffs | 4a (relays), 4b (limits, compression), 7b |
| 22 | trace carriers (R5) | 9 |
| 22 | the `event` message, `ack.events`, both codecs, part limits and compression for event values | events |
| 23 | `useEvents` (`chord/react`), `TuiScope.on` | events |
| 23 | `useLive` (`chord/react`), `TuiScope.live`: a reference read while live, following its `granted` (replace `useVariant` and `TuiScope.variant`) | 15 |
| 23 | workers: a worker's exit published after its link's work ended, its incarnation in `WorkerState`; a route's `opened(incarnation)` (§3) | after 14 (2026-11-15) |
| 27 | event edits (`event`, `addEvent`, `removeEvent`), `accepts.events`, one mapping per emit per older version (`event_mapping_failed`) | events |
| 23 | HTTP (routes, wraps, responses as descriptions, request bodies, plugin sockets), workers; channels and chunked transfers stay owner patterns until a second user | 10 |
| 23 | the app kit: `startServer`, `startWorker`, start-data objects, deny by default, sign-ins (`SignIns`), owner link and token file, device pairing, files (with chunked transfers), export and import per address, plugin roots and "apply changes", optional users, invite and ephemeral-login plugins | 13 |
| 23 | web and TUI: base bundles, registered plugin scripts and the combined file, `WebScripts`/`TuiScripts`, `startPage` with the connection loop and in-place reloads, React bindings, the sandboxed terminal (launcher, sandbox, `TuiScope`), themes (`Themes`, `ThemeChoice`, CSS variables, terminal colours), CSS modules | 11 |
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


### Host-keyed data (decision "Documents and table rows can belong to a host"; spec `host-keyed/spec.md` §9)

- **Converting stored string-keyed documents to host keys** needs an explicit one-off store migration (the
  discriminator refuses an implicit one); none is built.
- **Adding a host column to an existing table:** `evolveTable` refuses (a host column has no default); a new base works.
- **Migration on import needs the owner's code on the importing host:** a store without its owner served refuses an
  archive whose table is older or was exported `migrating`.

### Any slice (protocol and checks)

- **Bump `PROTOCOL_VERSION`** for any message or reason change (it is 2 since slice 15, which covers every change
  listed here; slice 3b added `retry`, `loading` and `failed`'s `retryIn`; slice 4a parts, the list `bound`,
  `hello`'s `calls`, `ack`, `ping`, `pong`, `closed`,
  `origin` and the hold's `address`, `principal` and `incarnation`; the reload build `call`'s `old` and the
  `unavailable` reasons `version` and `reload_cycle`; the events build `event`, `ack`'s `events` and an optional
  `hello.calls`; all without a bump: nothing is deployed). (Owner, slice 3b.)
- **The park deadline's per-type override** is not built: a parked call waits the reference's `readyTimeout`. Build
  it only if a real case needs it. (Slice 3b spec.)
- No CBOR; revisit only if benchmarks show encoding as a bottleneck (slice 3a's and 4a's do not). (L2 decisions.)
- **The Durable conversation view's size on re-hold** is a known cost until pi #11327 (windowed view) lands. (Slice 4.)

### Any slice (memory of held objects and hot paths; from the hold-memory pass, 2026-11-25, and the hot-path pass, 2026-11-26)

- **A decision with references keeps a signal depending on its context's** (`AbortSignal.any`, 1.2 KiB with its one
  listener, `Decision.#followUntilAborted`), only to end its follows at the place of an abort's dispatch they always
  ended at: after the listeners of the context's own signal, ahead of the signals made from it later (an opener's, a
  resolver's). Both orders are observable (`test/host/admission.test.ts` "whose opener timed out…",
  `test/host/route-admission.test.ts` "is still told of a reference that fails in a listener…"). Decide the rule (an
  attempt's follows end before its abort is dispatched, say) and the owner can end them with one call, for nothing.
- **A reference is an object in dictionary mode.** Its `state`, its `granted` and each grantable member are own
  accessors (`Object.defineProperty`), which V8 keeps in a dictionary (256 B and about 130 B per accessor, for every
  `self.get`, `host.get` and hold). Accessors on a prototype per contract version would be fast properties, but they
  are no own properties then (`Object.keys`, a spread); decide whether that may change.
- **An activation's steps are async functions** (`#activate`, `#runAdmission`, `#ownSteps`, `#decide`, `settle` and
  others: 0.3 to 1.2 KiB each). Running the ones whose common path never awaits as plain functions saved about 3 KiB
  of garbage per hold and per rebuild, with the turns kept; taken out again as too brittle (owner, 2026-11-26).
- **A list's pages keep the backend's rows** (`host/tiling.ts`): node:sqlite returns a row as an object in dictionary
  mode, about 240 B more per row of two columns than an array of its values. Keeping the values, with one column
  list per statement as a live query's `DecodedRows` does, costs about 11 µs per page of 50 rows run. Undecided trade
  (`test/bench/list-heap.ts`).
- **node:sqlite's `setReturnArrays`** in the backend: a select of 100 rows 43 → 30 µs in a micro-bench and no
  dictionary rows at the source, but every row access of the store changes.
- **`Binding.followInstance`** hands each reader of a named query a release closure (about 40 B per live query); a
  token instead needs `ReferenceQuery.follow` to return something else.
- **Composite keys are identified by a JSON text per row** (`identity` in `store/read.ts`; made once per fetched row
  for the read and its decoding). Nested maps by column were built and taken out: more memory where the first key
  columns differ (8-column keys 2,621 against 363 B per row), another equality (bigint) and other set sizes. A design
  that beats the text for every key shape: choose per kept set (nested maps only where one first value covers many
  rows), normalize values to JSON's equality first (non-finite numbers to null, bigint refused), keep `Set`'s API.
- **A remote object stringifies its params per hold** (`remote/remote-object.ts`): about 100 B less per reference on
  the client; a re-hold (after a reconnect, or a route admitting it again on the same link) pays the text again (a
  32 KB param: 91 against 31 µs per re-hold). Keeping the text is 50 B per reference.
- **The commit index has no recorded trace:** the reviews compared candidates, their order, the lookup SQL and the
  skip, probe and run counts of seeded random worlds against the code before the pass. Kept as a fixture (recorded
  once, replayed by a test, re-recorded on purpose), later changes of the index would be checked the same way.
- **Decoded lists of 2 to 17 items have `push`'s capacity** (`link/binary.ts`: a decoded `bound` of two grants 314
  against 192 B per hold, transient). Exact-size lists cost the decode 142 → 219 ns per message.
- **A served hold placed again walks its params' text** when it is longer than a third of a link limit (`within` in
  `link/part.ts`; the base read the kept bytes' length): 1 MiB of params under 2 MiB limits 13.2 against 3.1 ms per
  republish. A kept byte length per served hold would end it.
- **A long text encoded where no native UTF-8 count exists** (a browser: no `Buffer`; `Writer` in `link/binary.ts`)
  reserves the rest of a text that did not fit at three bytes a unit and copies the frame right-sized: a text of 1 Mi
  two-byte units 5.77 MB of buffers and 1,437 µs against 3.16 MB and 744 µs before the pass. On Node the rest is
  counted exactly.
- **The encoder sizes a frame past its kept buffer from the message** (`partsLength` in `link/binary.ts`: parts and
  their prefixes exactly, a failure by a flat 72 B, an event by 24 B, a text by its units and, once one fell short,
  every text at its UTF-8). Of 51 frame shapes the review measured against the code before the pass (Node, medians)
  none is above it in both buffers and time; above it in one: failures whose errors are long (1.06 to 1.39 times
  the buffers, at 0.3 to 1.0 times the time), events with small ids and stamps (1.44 to 1.55 times the buffers, at a
  sixth of the time), one megabyte text that is not ASCII (the same buffers, 1.09 to 1.25 times the time: the
  native count of its bytes). The estimate runs for every message: about 0.3 KiB of garbage per rebuilt object in
  `hot-paths.ts` (its loops over holds and members); indexed loops would end that.
- **Small items** (30 to 60 B each): an open query's compiled-plan wrapper, a given query's argument wrapper, a read
  plan's equality entries; a consumer's `#move` batch closure and list copy (about 0.3 KiB of garbage per move).

### Any slice (lifetimes)

- **An ended attempt kept by plugin code keeps its object's past** (found in the events build, pre-existing): code that
  keeps a factory's `self` (or a handle reaching it: a source, a writable) after its attempt ended keeps the attempt,
  its object and what they reach, among them a provider side its link retired. Reproduced at the commit before the
  events build (`8a88d13ba`): a remote type whose factory pushes `self` into an array of the test, served over
  `rawLinked`; the raw peer holds it, gets `bound` and releases it; `expectCollected` over
  `instancesOf(ProviderSide, "message")` fails while the array holds the `self`, and passes without it. Not covered by
  any test: the events GC tests clear what they keep of an attempt before collecting (`test/remote/provider.test.ts`,
  "retire a provider side's record only once its event tickets drained"). Whether an ended attempt should cut what it
  reaches (its object, its links' records) is undecided. (Events build reviews.)

### Workers: what the exit order left (decision "A worker's exit is published after its link's work ended")

- **A call an exited worker made that the server relayed** to another host is cancelled there when the cancel
  arrives: its transaction on that host may commit after the server published the exit. Waiting for it needs the
  other host's answer; build it when a case reports through a relay.
- **p2 keeps its hand-written generation checks** (its principal's `generation`, the checks in its report methods)
  until it is ported: it passes `store` to `createWorkers` now, so they are redundant, not wrong.
- **`useLive`'s snapshot** (the reference's `granted`, so two `live` states with different grants differ to React) is
  tested through the page (a grant change while mounted), not with a forced coalesced render.

### Later: reload (when a case needs it)

- **`rebuild` of tables** (key and column-type changes): `evolveTable` has no edit for them; build one only when a
  real case needs it. (Slice 6a's second spec review; out of slice 7b's scope, `slice-7b.md` §12.)

- **Content-compared plugin marks:** a plugin's `dirty` mark stays latched until the plugin is applied (a rewrite with
  the same bytes, or a change and its revert, dirties it); compare a plugin's files with the bytes its last applied
  build read (`BuiltFacet.inputs` already holds their hashes), as `base` now does. (p3 step 0a,
  `apps/p3/docs/step-0a/book.md`.)

### Slice 14: what its two parts left (spec `slice-14.md`; the builds' reports, 2026-11-15)

Not built yet:

- **Lists over several sources** (§4 "Sources"; a third of the list tests; §9 item 3's merged list). The owner
  allowed it to wait; until then a sparse person's drivers are separate reads (`test/bench/slice-14.ts` measures
  them so).
- Examples `73-sidebar.ts`, `74-access.ts` and `75-reload.ts` (§9 items 1, 7, 9, 10, 11); the page, server and
  worker reload suite's cases of tests 17 to 22 (the kernel-level reload tests exist: named queries, column sets and
  lists in `test/host/query-reader.test.ts`, `named-query.test.ts`, `list.test.ts` and `tiling.test.ts`; admission
  and route admission in `test/host/admission.test.ts` and `route-admission.test.ts`); a list's re-hold within
  `linger` over a link (§9 item 8); "a server restart with a new `admit` uses it" (test 21's integration case).

Left by the second part (admission, route admission, `deleteHostData({ plugin })`; built 2026-11-15):

- **A failed admitted object follows a denial and another allowed value, nothing else:** a source that fails
  while the object is failed changes nothing, and an object whose admission itself broke (a value that is no
  decision, an `admit` that threw) follows nothing until `ref.retry()` or a reload.
- **An ended admission source** (revoked, its host closed) breaks the attempt as an ended dependency does
  (`broken`, design §6), not `failed { waiting }` as §2.2's table words it; it never comes back, so nothing would
  wake a waiting attempt. Tested through the dependency check, not by an admission test of its own.
- **`AdmitSelf` has no type parameter** (the spec writes `AdmitSelf<P>`): nothing of it depends on the principal
  type.
- **Two persons cannot widen a read by params** (§10 test 13) is still not written: it wants the worked example's
  `PersonAccess` (the condition from the admission's sources), which is p3's.
- Bump `PROTOCOL_VERSION` for `denied` with p3's first release. Done: it is 2 since slice 15.

Left by the first part itself:

- **A list's bookmarks are kept by its object** (`ChordObject.listMemory`), not in an in-memory document as §4
  says: the same life (across attempts, gone with the object), no document machinery in a read's adoption.
- **Test files:** `store/read.ts`, `store/open-query.ts` and `store/page.ts` have no test file of their own; they
  are tested in `test/store/reads.test.ts`, `test/store/skip.test.ts` and `test/store/read-plan.test.ts`.
  `host/query-reader.ts` is tested through live queries and lists (`test/host/query-reader.test.ts`,
  `list.test.ts`, `named-query.test.ts`); `state/framed.ts` and `host/read-declarations.ts` have their own since
  (`test/state/framed.test.ts`, `test/host/read-declarations.test.ts`).
- **`self.count` has no opt-in** (round 4's decision: the `counts` list is dropped; `slice-14.md` §3.1). Any reader
  may count any named query; the guide says what to count.
- **A reader's arguments from a followed source or a native** are not available when it opens: readers open before
  the natives (a waiting attempt holds none), so their argument derives read references, registries, writables and
  earlier reads only; one that reads something else fails the attempt `broken` with that rule. The case: a list
  whose arguments come from `self.follow`.
- **A removed provider's readers keep its named query** (its mapping, so its code) with their last rows until they
  end or the provider is served again: a run a commit made before the removal may still need decoding. A restarted
  provider's old queries are collected once its readers read the successor's (tested).
- **An `exists` inside a condition passed as data** (`compile`, then `whereNode` or `existsNode`) carries no column
  types: its operands are checked against the table bound now, not against the set the condition was written for
  (a typed `exists(Set, …)` is). Conditions are built by server code; a node has no types to carry.
- **`store/reads.ts` holds three things** (the index of reads, the set bindings with held tables and their
  watchers, `ReadRefresh`): to split into `reads.ts`, `set-bindings.ts` and `read-refresh.ts` with the next change
  there. Not done in code review round 2: `store.reads` is the name the reviews' reproductions use.
- **Small leftovers of code review round 1:** `QueryPage` (contracts) and `Page` (store) are one shape with two
  names; a list decodes every loaded row's identity on each page adoption (0.6 ms a message at 20 pages); a list's
  method is `more` beside the values `more` and `moreAfter`, as the spec has it.
- **The commit index refiles every kept key of a read on each run** (ERNDL-1176, its test 8): 15 % of the checklist
  profile at 100 identical reads before sharing (`read-index.ts` `kept`, `refile`). Refiling only the keys that
  changed between two runs makes it per changed row.
- **A window shift diffs the whole window** (ERNDL-1176, its test 9): 11 % of the notes profile (`delta/diff.ts`
  `identityAnchors`, `permutation`); a shift by k rows should cost about k.
- **A list's pages are not shared between lists** (decision "Identical live reads share one source"; ERNDL-1176):
  live queries and counts share one read per (provider instance, query, arguments, shape); two lists of one query
  with equal arguments are still two tilings. Next: share pages keyed by (query, arguments, bookmarks), every fresh
  list's first page, pages behind a list's own `more` its own.
- **A failed migration's held reads** keep their rows and stay held; §5 asks for `failed unavailable` ("table X is
  not ready") with the rows as last values. The case: a screen that must say why it is stale.
- **Staging knows a recorded handle as a table, a named query of the object, or anything else.** A table given to
  a reader and a named query given to `self.query` are refused in staging; a reader given a reference's member
  that is no named query (a state member, a method) is found at activation, when the reference is bound: the
  recorded reference does not carry its contract's member kinds. The case: a wrong member name in a reload that
  should keep the old code.
- **`evolve` and `accepts` edits for named queries**: the first released contract with a `queries` member that
  changes. A `queries` member is carried over unchanged by `evolve` today.
- **A partner's row type in `map`** is `{ [column: string]: unknown }`: typed from the joined set when a second
  user asks.
- `self.list`'s carry-over of the spec's §12 (opening at a bookmark, `more` towards the start, a live `moreAfter`,
  sources that follow a value, offsets), a probe for counts, an in-memory evaluator before the probe, a left join,
  aggregates, `matches`.

### Later: live queries (when a case needs it)

- **Maintaining a page from the written rows** (decision "Live queries over an object's own tables"; slice 14): an
  ordered, limited result kept from row-level changes in memory instead of running the read again. Slice 14 built
  the skip test (a commit that cannot change a read does not run it); a read it cannot rule out still runs whole.
  The case: §9's "a touch of a session every open list shows", if judged too high.

### After slice 11

- **A tagged "building" state for the scripts object** (review of f86677f79, Opus, 2026-11-26): before its surface
  built, the scripts object shows `ScriptSet` with `base: ""`, which clients skip (`surfaces/client.ts`). A tagged
  value (`{ kind: "building" } | { kind: "built", set }`) would say it in the type instead of a sentinel. With it, decide
  what a client that reconnected during the build shows when the first push then fails: today it keeps its old code
  silently until the next step's push sends the set.
- **Small examples** (owner, 2026-10-30: the 7c examples are complete but complex): once HTTP, workers, web and TUI
  exist, a pass of small, easy-to-read examples, each showing one thing a plugin author or app does.

### When v2 goes upstream

- `mapShared` lives in `src/state/derive.ts` and moves into Delta. (L2 decisions.)
- `withLinkedAbortSignal` lives in `src/host/ctx.ts` and moves next to `withAbortSignal` in `src/context` (pi
  first): a call's context linked to long-lived abort signals until the call settles, instead of `AbortSignal.any`,
  which keeps cleanup entries per call while its sources live before Node 24.16.0 (nodejs/node#62367). (Slice 4a.)

### The sync layer (not a slice; when Radius sync is built)

- Upload, acknowledgement and `store.outbox.trim`, epochs, pull-back, the split (S5, S7); a store opened with an
  outbox (decision "The outbox is optional, internal and versioned") starts its sync from an archive.
- Snapshot reads for large exports on a second SQLite connection (S4), if exports get large.

### Outside the slices

- The playground's runtime tests fail on a stale `node_modules` copy of chord 1.3.0; relink with
  `npm install --ignore-scripts` when the playground is used again. (Frozen-kernel move.)
