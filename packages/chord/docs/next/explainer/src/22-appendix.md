
# API Reference {.appendix #api lede="Every name the guide uses, grouped by where you meet it. Working names; only the contract layer is built."}

## Hosts

| Call | Meaning | Chapter |
| --- | --- | --- |
| `createHost<P, R>({ address?, principal?, storage?, principalKey?, revokedBy?, telemetry?, onError?, timeouts })` | a host; with an address it is addressable and its own code acts as `principal`; without, a client | I |
| `host.load([{ name, facet }])` | load facets by plugin name; base code passes its core facet the same way | I |
| `host.connect(link, { principal })` | the link to the parent (at most one) | I |
| `host.accept(link, { principal })` | a link from a client; every request on it acts as `principal` | I |
| `host.route(Kind, { authorize, resolve })` | how to reach hosts of a kind; `resolve` returns `{ link, principal }` | I |
| `host.revoke(r)` | end matching objects and links here and below | VII |
| `host.root(fn, { principal?, signal?, telemetry? })` | a call scope with a `ctx` for code outside objects | VI |
| `host.get(Type, input, { signal, state?, parkTimeout? })`, `host.hold(…)` | a reference from outside objects; `release()` ends it | VI |
| `host.serve(Type, factory, { lifetime?, linger? })` | serve an object type (in a facet) | II |
| `host.registry(Registry)` | the composed value of a registry, a readable | XIII |
| `host.references(Type)` | who holds references to objects of a type on this host (presence) | VIII |
| `host.activity` | `{ references, calls, jobs, lingering }`, for keep-alive | I |
| `host.close()` | end the host: objects, natives, links | I |

## Inside a factory: `self`

| Member | Meaning | Chapter |
| --- | --- | --- |
| `self.state(Definition)` | a document handle | V |
| `self.tx(async (tx) => …, ctx)` | a transaction on the object's line | V |
| `self.derive(name, [sources], fn)` | a derived readable | VIII |
| `self.get(Type, input)` | a reference held for the object's life | VI |
| `self.open(open, close, { closeTimeout? })` | a native; `.value` once open | IX |
| `self.routines.on(readable, fn)`, `.every(interval, fn)`, `.loop(fn)`, `.custom(…)` | standing behaviour | X |
| `self.job(Job, { run, finish? })` | owned work that outlives its call | XI |
| `self.contribute(Registry, value)` | a contribution (facets and `lifetime: "host"` objects only) | XIII |
| `self.writable(initial)` | a host-local readable of any in-process value, with `set` | XIII |
| `self.retryOn(readable)` | a trigger that retries a broken activation | VI |

**Document handles:** `value`, `get(key)` (keyed), `keys`, `change(fn, ctx)` / `change(key, fn, ctx)` and `retire(ctx)` / `retire(key, ctx)` (shorthands for
one-document transactions). **Transactions:** `tx.draft(handle, key?, { tags? })`, `tx.retire(handle, key?)`,
`tx.start(job, args, { key? })`. **Jobs:** `job.start(args, ctx, { key? })`, `job.abort(id)`, `job.running`,
`run.outcome(ctx)`.

## References and `ctx`

| Member | Meaning |
| --- | --- |
| `ref.<member>` | a state member (readable: `.value`, subscribe) or a method |
| `ref.state`, `ref.onState(fn)` | `loading`, `live`, `failed` (cause, `retryAt`), `released` |
| `ref.retry()` | retry a failed reference now |
| `ref.release()` | end a reference taken outside objects |
| `ref.members` | the variant's members |
| `ctx.signal`, `ctx.principal`, `ctx.incarnation`, `ctx.get` | cancellation, caller, calling host's incarnation, call-scoped references |
| `ctx.telemetry`, `ctx.trace(name, attributes, fn)` | the current span; a child span with a child `ctx` |
| `ctx.jobId`, `ctx.progress(value)` | in a job's `run` |

## Definitions

| Name | What it declares | Chapter |
| --- | --- | --- |
| `hostKind(name, input?)` | a kind of host and its address | I |
| `remote(name, { version, input, placement, variants })` | an object type reachable across links | II |
| `local(name, { version, input, members })` | an object type on its own host | IV |
| `method(args?, result?)` | a method in a base declaration | II |
| `evolve(prev, (e) => …)`, `checkAccepts(contract, accepts)` | the next contract version; the provider's mappings (**built**) | XVI |
| `Implementation<typeof C>` | the type of a provider for the current version (**built**) | XVI |
| `str num int bool nul lit oneOf union obj arr map opt bytes unknown`, `Static` | schema helpers (**built**) | II |
| `defineState(name, { schema, version, initial, checkpointWhen, persist?, keyed?, ordered?, migrate? })` | a document | V |
| `defineTag<T>(name)` | a tag; `store.retireByTag(tag, value)` | V |
| `defineJob(name, { version, args, progress, result, concurrency?, persist?, accepts? })` | a job type | XI |
| `defineRegistry(name, { version, compose, accepts? })` | an extension point | XIII |
| `bindFacet<P>()` | base code's `defineFacet`, with factories' principals typed as the app's `P` (working name) | III |
| `defineFacet((host, self) => …)` | a plugin's setup for one kind of host; imported from base code (`@studio/core`) | II, III |
| `constant(value)` | a readable that never changes (start data) | IX |
| `broken(error)` | a failure that is not retried by the backoff | VI |
| `inVariant(ref, …)`, `expectVariant(ref, …)`, `RefIn<…>` | narrowing a reference by variant | III |
| `mapShared(fn)` | an array map that keeps unchanged items identical (planned in Delta) | VIII |
| `OutputBuffer`, `Progress` | bounded output and throttled progress (`@earendil-works/chord/output`) | XI |
| `memoryLinkPair()`, `ipcLink(child)`, `webSocketLink(ws)` | link adapters | I |
| `DocumentStorage`, `registerDocumentStorageConformance` | the storage port and its shared test suite | V |

# Timeouts and Defaults {.appendix #defaults}

| Timeout or default | Bounds | Default | Override |
| --- | --- | --- | --- |
| `closeTimeout` | a native's `close`, then reported as a possible leak | 30 s | per native |
| call drain | an ending object's own call handlers | = `closeTimeout` | per type |
| `readyTimeout` | activation; an awaited `get` | 60 s | per `get` |
| park deadline | parked calls (link drop, loading, rollout) | 60 s | per `get` (`parkTimeout`); per type |
| routine handover | a new routine waiting for the old handler on reload | 10 s | per routine |
| `finish` retry | backoff of a throwing job `finish` | 1 s to 60 s | per job |
| rollout install | one host installing a revision | 60 s | none |
| linger | an object kept alive after its last reference | per type | per type |
| backoff | retries of transient failures, per address | 1 s doubling to 60 s | none |
| eviction | keyed persisted documents idle in memory | 10 minutes | |
| client WebSocket limits | per part | 16 MiB compressed, 64 MiB decoded | per link kind |
| compression | JSON parts compressed at their origin | above about 16 KiB | |
| worker keep-alive (p2, app code) | idle time before the supervisor stops a worker | 5 minutes | app |

# Versions {.appendix #versions}

| Surface | Version | On change | Chapter |
| --- | --- | --- | --- |
| object type | `version` plus fingerprint | `evolve` and `checkAccepts`; otherwise `contract_mismatch` | XVI |
| document | `version` plus schema fingerprint | pure `migrate` on access; no bump fails `broken` | V |
| job | `version` | `accepts` on outcomes and `running`; `blocked` without | XI |
| registry | `version` | `accepts` on contributions; unmatched ones left out and reported | XIII |
| native | none | restarts on reload | IX |
| Durable tasks and documents | Durable's `version` | Durable's `migrate` | XIV |
| link protocol | protocol version | refused; hosts update together | XVII |
| UI components, Chord and app APIs | none yet | exposed as they are | |

# Errors and States {.appendix #errors}

`ChordError` has a stable `code` and a finer `reason`; on the wire it is `{ code, reason?, message, details? }`
(specified in `layer-1.md`, not built).

| Code | Meaning |
| --- | --- |
| `invalid` | input, arguments or placement rejected (`invalid/input`, `invalid/args`, `invalid/placement`) |
| `contract_mismatch` | the consumer's version and fingerprint are neither current nor accepted |
| `forbidden` | the caller may not do this |
| `gone` | the object or hold ended |
| `not_ready` | not activated in time |
| `released` | the reference was released |
| `too_large` | a part exceeded its size limit |
| `unavailable` | could not be reached before the deadline (`unavailable/locked` and others) |
| `aborted` | cancelled by a signal |

| Type | Values |
| --- | --- |
| `FailureCause` | `{ kind: "transient"; error }` (retried with backoff) or `{ kind: "broken"; error }` (retried only by a trigger) |
| reference state | `loading`, `live`, `failed` (cause, `retryAt`), `released` |
| job outcome | `{ kind: "done"; result }` or `{ kind: "failed"; error: "threw" \| "aborted" \| "lost" }` |
| job phase | `running`, `finishing`, `blocked` |
| rollout status of a provider | `updating` (calls park), rejected (fail at once), same revision (`contract_mismatch`) |
| host install report | `installed`, `installed_failed`, `rejected` |

# Rejected Designs {.appendix #rejected}

From `design.md` §31, grouped. Each was considered and is not coming back without a new reason.

| Area | Rejected |
| --- | --- |
| reload | drain-based handover; object restart for state changes; a factory trial; a migrate dry run; a consumer contract check during staging; reload votes; per-plugin rollback within a host; keeping natives across reloads by name; `restart_required`; host values and a development freeze |
| state | version fences without transactions; volatile documents; per-group lines; optimistic transactions; `tx.get`; a JSONL document storage; validating state and documents on commits or reads; copying values on same-host calls; op-rewriting projections and a view algebra; Durable's Session as the object store |
| objects and references | resources replaced in place (`replace`, `deps`, stale handles); revoking proxies on `.value`; consumer-side linger; detached references counting toward presence; an `optional` flag on references; `opaque` members; callbacks as method arguments; generic call or request ids; a stream type in Chord |
| registries | registries created at runtime; entries resolved through mutable indirection; generic registry keys with a `conflict` flag; numeric middleware priorities; registry composition as a staging check |
| principals and placement | principal field patterns and re-stamping for revocation; `storeKey`; placement as data naming an input field; host-name strings in app code; "magic" input-field matching for delete |
| wire | an outbox for transient delivery errors; cross-relay reset coordination; count limits that refuse calls or holds; contracts taken from the running app |
| process and tooling | a topology layer above the host API; loader variants A and B; Chord ending the process on a storage failure; `defaultProjectTrust: "always"`; ceremony (`native/` directories, `defineNative`, lints); weakening type checking |

# Glossary {.appendix #glossary}

**Adapted binding:** a consumer bound at an older accepted contract version, served through the provider's mappings.
**Base code:** the app's own code, imported statically; a change restarts the hosts. **Client:** a tab or TUI host,
not addressable. **Contract:** an object type's declaration (name, input, placement, members, version).
**Contribution:** a value a plugin adds to a registry. **`ctx`:** what every call receives. **Derive:** a value
computed from readables. **Document:** a named JSON value an object owns. **Facet:** a plugin's code for one kind of
host. **Factory:** the synchronous function that declares an object. **Fingerprint:** a hash of a contract's or
schema's normal form. **Flow:** input into running work, kept as state by its owner. **Host:** one participant of the
app, with an identity and an incarnation. **Incarnation:** the id a host gets on every start. **Input:** an object's
key among objects of its type; with the type and the caller's principal key it identifies the object. **Job:** owned work that outlives its call. **Link:** an ordered connection between
two hosts. **Local type:** an object type reachable only on its own host, without principals. **Native:** an OS-level
value opened with `self.open`. **Park:** a call waiting for a reference to become live again. **Placement:** the
function from input to host address. **Plugin:** a directory with a `package.json`, reloadable. **Principal:** who
calls, stamped by the link. **Principal key:** the string that identifies a principal in object identities. **Pure
object:** an object without natives; swapped in place on reload. **Readable:** a value plus its ordered changes.
**Reference:** what `get` returns. **Registry:** an owner's extension point. **Relay:** a host forwarding messages
between two links, rewriting only headers. **Reload:** swapping a plugin's code in running hosts. **Restart:** ending a
process. **Revision:** the complete code set the hosts should run. **Revocation:** ending live access for principals
matched by `revokedBy`. **Routine:** standing behaviour of an object. **Server:** the addressable root host. **Shared
store:** a local object that holds data once behind per-principal views. **Tag:** a typed label on documents, used to
retire them together. **Transaction:** an atomic set of document writes on the object's line. **Variant:** the set of
members a principal gets. **View:** a per-principal remote object in front of a shared store. **Worker:** a host the
server starts for one session.

# Sources {.appendix #sources}

| Source | Used for | Weight |
| --- | --- | --- |
| `packages/chord/docs/next/decisions.md` | every decision, review rounds 2 and 3 | wins where newer |
| `packages/chord/docs/next/design.md` | the target design, all chapters | authoritative otherwise |
| `packages/chord/src/next/contracts/` and its `README.md` | chapter XVI | built code |
| `packages/chord/docs/next/layer-1.md` | errors, inputs, argument checks | draft spec |
| `apps/p2/docs/p3-reviews/v2-review3-summary.md` | open Q11 to Q15, cuts C3 to C17 | current |
| `apps/p2/docs/p3-reviews/v2-cost-model.md` | measurements, per-hop costs | current except its last section |
| `apps/p2/docs/p3-functions/` | chapters XVIII to XX | current |
| `apps/p2/docs/p3-handoff.md` | status and order of work | §3 partly stale |
| `packages/durable/README.md` | the harness, submit, tasks, subagents | current |
| `chord-next-walkthrough.md`, `kernel.md`, `step-*.md`, `apps/p2/docs/questions.md` | background only | lag the decisions (see What's Next) |
| DeepSeek Harness at `687f282` (its Cordis tutorial, architecture, persistence, core and HMR docs), the Cordis paper (arXiv 2608.25512) | "Other Ways to Do It" | external, built systems |
