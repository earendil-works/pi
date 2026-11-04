# Chord v2 review round 2 (design): decisions for the owner

Sources: `v2-review2-fable.md` (F), `v2-review2-astra.md` (A), gaps from the walkthrough update (W). Every item is a
question for the owner with a **proposal**; nothing here is decided.

## A. Wire, relays, untrusted input

| # | Sev. | Problem | Proposal |
| --- | --- | --- | --- |
| R1 | blocker | "Relays forward opaquely" cannot work: the server receives structured clone over IPC and must send binary on WebSockets, and one worker commit carries batches for several destination links; forwarding one body to all leaks another client's state (F1, A1) | The origin encodes each hold's batch as its own byte segment (compression decided at the origin); the packet header lists hold id → segment; the relay routes each segment only to the link that holds it, concatenating per destination without parsing; each destination assembles its own atomic commit frame |
| R2 | major | Compressed client frames can expand enormously before anything checks them, and the relay carries them on to IPC, which has no limit (A3) | Bound compressed size, decoded size and framing metadata separately; enforce the expansion limit while decoding; keep the limits across relays |
| R3 | major | Contract-description cache per (link, fingerprint) can be poisoned: the worker's parent link carries many principals; a guest sends a wrong description under a real fingerprint and later owner bindings use it (A2); every first hold costs a round trip (F13) | Recompute the fingerprint from the description before caching; a mismatch fails only that binding; the consumer sends the description with the first hold of a fingerprint per link, the provider still asks on a cache miss |
| R4 | minor | "No frame is walked" is too broad: untrusted links still need a grammar check of the frame structure and a kind allow-list (a client must not send `state`, `view`, `result`) (F15) | A structural frame check with opaque leaves (no value walk) and a kind allow-list per link kind; bytes by `instanceof Uint8Array` (Node `Buffer` is a subclass) |
| R5 | minor | Relay spans need the trace carrier, but relays do not decode bodies (F16) | The carrier lives in the packet header next to the route, size-capped on accepted links |

## B. Validation and trust

| # | Sev. | Problem | Proposal |
| --- | --- | --- | --- |
| R6 | blocker | During a rollout an old guest tab calls `add(argsV1)`; the provider only owns the V2 schema, the V1 schema exists only in the peer's description (which must not be executed), so the adapter receives unvalidated guest input (F2, A7) | `accepts[v]` carries the provider's own copy of the old member schemas; order: strip and validate against the provider's old schema, adapt, then (in dev) validate the result against the current schema; both compiled once |
| R7 | major | "Not validated for host principals" also skips stripping and input normalization: a worker can mass-assign extra fields a guest cannot; an unnormalized input from a worker makes a second object identity (F7, W4) | Always normalize inputs and strip arguments to the provider schema (cheap: arguments are small); skip only the schema check for host principals |
| R8 | major | `migrate` output and `initial()` are never checked; a buggy `migrate` writes corrupt data under the new fingerprint, permanently (F11) | Validate `migrate` output and `initial()` always (once per document per bump, off the hot path) |
| R9 | minor | Immutability by convention fails silently: `sessions[id].archived = true` on a received value mutates the authority without ops; replicas diverge for good (F18) | In production freeze only the root of each committed revision and published value (`Object.freeze(root)`, O(1)); deep freeze stays dev-only |
| R10 | major | Revocation race: a guest-started Durable task waits for approval; the grant is revoked; the approval resolves before the reconciling routine runs; the next effect runs as the host (A9) | Keep reconciliation for cleanup, and check the current grant when an answer is accepted and when a new effect is dispatched on the guest's behalf |
| R11 | major | A job of a revoked guest's view keeps its object alive (D4) and may keep calling out; a job's `ctx.principal` is undefined (F10) | Jobs run as the host principal with attribution as data; revocation and native restart abort the object's jobs, and the object ends when they settle or at `closeTimeout` (reported as a leak) |

## C. Transactions and documents

| # | Sev. | Problem | Proposal |
| --- | --- | --- | --- |
| R12 | major | With only `tx.draft`, a transaction cannot return read data: draft proxies throw after the commit, so `return (await tx.draft(doc)).items` fails for same-host and remote callers alike; the first proof needs it (F3, A10) | (a) `tx.read(handle, key?)` returning the committed immutable revision (or the current draft revision materialized), plus the rule "never return a draft subtree"; or (b) reads only outside transactions (`handle.value`, `handle.get`), transactions only write and return primitives |
| R13 | major | Inside a transaction "absent" and "equals `initial()`" look the same; "remove if present" or "create with tags if missing" cannot be written (F4) | `tx.draft` also tells whether the document existed (`{ draft, exists }`), or `tx.exists(handle, key?)` (metadata, O(1)) |
| R14 | major | Without a default checkpoint the cost only moves to load time: a status document written every second accumulates 86,000 deltas a day, replayed on the next start and on every reload of an evicted keyed document (F8) | A store-level default (e.g. a new base after 64 deltas or when deltas exceed twice the base), overridable per definition; Durable leaves it to each document |
| R15 | major | Old calls vs. migration: an old call awaits something, a reload migrates its document, the call resumes with its "still valid" old handle; §9 says it throws, §21 says old calls keep working (A6) | Keep §9 (old code reading a migrated document throws, Durable's rule) and narrow §21: old handles stay valid until their calls settle, except for documents whose version rose |

## D. Lifecycle, reload, the first proof

| # | Sev. | Problem | Proposal |
| --- | --- | --- | --- |
| R16 | major | Code mode reload: the restart closes the old object first; its `close` drains running scripts for minutes; until then there is no new sandbox and no tool entry, so a call released from an approval finds neither; how the old entry finds "the current sandbox" is undefined (F5, A5) | On a native restart Chord opens the new attempt first and lets the old `close` drain in the background (bounded by `closeTimeout`); the sandbox is a registry contribution swapped atomically when the new attempt goes live; readers that must wait use a cancellable "wait until present" with the park deadline |
| R17 | major | The harness start barrier is circular (the barrier waits for host-lifetime objects including the harness, the harness waits for the barrier) or premature; if the models plugin is missing or broken the harness never goes live, holds fail after 60 s without a reason, the worker stops idle (F6, A4) | The harness goes live while paused and publishes `{ kind: "waiting", missing: [...] }`; a routine on the registries resumes scheduling once the required contributions are present |
| R18 | major | Dependency recovery: A fails `broken` because B is broken and keeps no references, so nothing wakes A when B recovers; after `live`, what a dependency's failure does to the dependent is unwritten (A8, F17) | A dependent of a broken dependency is not itself broken: it waits on the dependency (a retained recovery subscription) and recovers with it; after `live`, a declared reference leaving `live` makes the dependent `loading` (calls park) and fails it `transient` after `readyTimeout` |
| R19 | major | Flow control: a 500 KB snapshot does not fit a 256 KB window; after an overflow the re-hold snapshot overflows again (re-hold storm) (F9) | Snapshots are always admitted (consuming credits); overflow is decided on queued deltas only; after an overflow re-hold only once credits cover the last snapshot's size, with a minimum interval |
| R20 | major | Pub/sub fence: the server object cannot learn the reporting worker's incarnation (principals carry none) (F12) | The worker sends `host.incarnation` as data, and the host exposes its children's current incarnations (address → incarnation) |
| R21 | minor | Which objects may contribute to registries: a referenced object's contribution flickers with its viewers; per-principal objects would add one entry per guest (F14) | Contributions only from facets and `lifetime: "host"` objects (type-checked), or document the flicker |
| R22 | minor | A host-lifetime object without input (e.g. `NoteInbox`) can no longer `self.get` a session-scoped object in its factory, because start data is read only after activation (W2) | Document the pattern: such objects `ctx.get` session-scoped objects in routines; or allow `self.get` with an input computed after activation |
| R23 | minor | `constant(init)` is used in §18 but not defined (W1) | A small readable helper `constant(value)`, or members that accept a plain value as constant state |

## E. Costs and documentation

| # | Sev. | Problem | Proposal |
| --- | --- | --- | --- |
| R24 | minor | Structural sharing is not O(change) for wide containers: changing one item of a large flat array copies that array; `mapShared` still maps and compares every element (A11) | Document the container-width cost; benchmark long arrays (allocations, element visits); partitioned documents or bounded windows where needed |
| R25 | minor | §31 still rejects "dynamic registries" and "late-bound registry entries", while contributions now change at runtime and code mode looks up at execute time (A12) | Narrow the wording: rejected are registries created at runtime and entries resolved through mutable indirection, not contributions changing with their contributors |
| R26 | minor | Drift: no description-request frame in the frame list; the log's benchmark still names JSONL; §9 "values read in a transaction are shared"; keep-alive counters have no API name (F19) | Fix the text |
