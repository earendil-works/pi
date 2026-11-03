# Chord v2 design review, round 3 (fable)

Read fresh from `origin/private` at `1fbadcf1e`:
`packages/chord/docs/design.md`, `packages/chord/docs/decisions.md`,
`apps/p2/docs/p3-reviews/v2-review2-summary.md`.
"§n" = design section. "R n" = round-2 decision. Quotes are verbatim.

## A. Verdict per area

| Area | Verdict | One line |
| --- | --- | --- |
| hosts and links | up | small API; IPC flow control text is stale (B6) |
| principals and revocation | up | R10/R11 close the holes; relayed `ctx.incarnation` undefined (B9) |
| object types and compatibility | down | `local`/`remote` split and the whole `accepts` path are the biggest removable surface (C1, C2) |
| objects and lifecycle | up | R18 is right; `broken` for opens plus `retryOn` is a second trigger system to cut (C6) |
| references | up | `state: false` has no wire support any more (B5); cut it (C8) |
| ctx | up | `ctx.trace` duplicates `traceIn` (C11); incarnation on relays undefined |
| documents and store | up | Durable port; R12/R13 patterns work; examples violate R14 (B4) |
| derives | up | `previous` is dead weight next to `mapShared` (C9) |
| natives | up | R16's 30 s timer contradicts §13 "scripts finish or hit their deadline" (D4) |
| routines | down | four forms plus handover for what is two (C4) |
| jobs | down | job versions, `accepts`, `blocked`, `persist` duplicate documents (C3) |
| facets | merge | a facet is a host-lifetime object that may not open natives; drop the restriction and `lifetime: "host"` collapses into it (C5) |
| registries incl. `self.writable` | up | registry `accepts` removable (C2); `writable`/`constant` are one thing (C10); non-JSON writables as state members undefined (B10) |
| start data | up | — |
| reload and rollout | up | with "install before routed" the adapted-binding path never runs in p3 (C2) |
| wire | up (R1) | "unknown id closes the link" is a race, not a violation (D1); per-message size limit kills whole commits (D3) |
| telemetry | up | log's Telemetry section still says `TelemetryContext` member (B8) |
| cost model | up | — |

Overall: up, after D1 and D2 are fixed and the C list is decided.
The design is coherent enough to build; it is not yet minimal.

## B. Contradictions

B1. Validation of trusted callers. §5 table: "arguments: validated once at the provider when the
caller is not a host principal". §5 bullet (R7): "Method arguments are always stripped to the
provider's schema and validated with it, whoever the caller is". §3 Values: "Values are
validated only where they enter from an untrusted caller (section 5)". §27: "v1 arguments are
validated against the provider's v1 schema (untrusted callers, as in section 5)". R7 wins; the
table, §3 and §27 are stale.

B2. Harness and the start barrier. §21: "wait until every facet and `lifetime: "host"` object
other than the harness is live or failed … the Durable harness starts after the barrier, it is
not part of it; R17". §24: "a `Harness` object with `lifetime: "host"` (… its activation is the
start barrier)". §24 is stale.

B3. Harness registry. §24 example passes `registry` once to `Durable.open`. §17: "Chord
subscribes to readable contributions … on every change Chord replaces that entry … and runs
`compose` again"; R25: "readers may look up the current value at use". The example must pass
`() => host.registry(HarnessExtensions).value`, like `models`.

B4. Required checkpoints vs. examples. §10: "`checkpointWhen` (required on every definition, no
default, R14)". §9 `Settings` and §15 `ShellResult` definitions have none.

B5. Method-only references vs. the wire. §7: "`state: false` binds for methods only". §22 kinds:
"`hold`, `release`, `call`, `cancel` … `bound` (1 part: snapshot)". No `sub`/`unsub` exist any
more, and `bound` always carries a snapshot. Either `hold` carries a `state` flag and
upgrading is a re-hold, or `state: false` goes (C8).

B6. IPC flow control. §3: "a window of frame counts on IPC (Node serializes internally; nothing is
stringified to count)". §22 (R1): "IPC: structured clone of `{ header, parts }` … Flow control
counts the parts' sizes from the header". Parts are bytes on IPC now; the count window is stale
and unbounded in bytes.

B7. Barrier promise vs. retrying facets. §21: "Then the registries hold everything that will be
there". §6: "Facets follow the same rules: a transient activation failure retries with backoff".
A facet in backoff counts as "failed" for the barrier and contributes later. R17's "model
unavailable, wait" covers it; the sentence is false.

B8. Telemetry types. Log, "Telemetry": "Chord's `Context` gets `telemetry: TelemetryContext` as a
fixed member … `withTelemetry(telemetry, context)`". §29: "`Context.telemetry` is always a
`TelemetrySpan` … `withTelemetry(span, context)`". The log entry is not marked superseded.

B9. Incarnation on relayed calls. §25 (R20): "a call arriving over a link carries the calling
host's incarnation from the link handshake". For client → server → worker the worker's handshake
is with the server. Which incarnation the worker sees is undefined; relays must stamp the
origin's (they already stamp the principal, §22).

B10. `self.writable` as a state member. §17: "a host-local readable of any value (no JSON, no
diff, no wire, compared by identity)". §5: members are "state and methods (JSON plus bytes)".
Nothing says a writable holding a function is refused as an exposed member; it would reach the
encoder.

B11. Singleton existence. §9 (R13): "existence is read outside the transaction (`handle.value` /
`handle.get` give `undefined` for an absent one)". §9: "A singleton that does not exist yet reads
`initial()` through its handle". Singleton existence cannot be read at all.

B12. Log entries superseded but unmarked (the log says they are "marked inline"): "Derives and
natives step": "a `broken` dependency fails it at once. No retained references while failed"
(superseded by R18); "Registries and HTTP": "a conflict it reports during staging rolls the host
back" and "compose … throwing on a conflict … in staging" (superseded by D1); "Reload": "No
per-module digest: if a native is expensive to restart, the author splits it into its own plugin"
(superseded by D5/R16 patterns); "Object kinds": "validate and copy arguments and results also on
the same host" (superseded by the state path).

B13. §6 wording: "On a reload the factory runs again for pure objects (new methods and derives,
same documents and natives)". Pure objects have no natives.

## C. Primitives to remove or merge

C1. Merge `local` into `remote` (one `object` kind).
What: two contract kinds, two factory signatures, `LocalCtx` vs `Ctx`, `LocalServe`, the
"clients serve only local" rule, two identity rules.
Why it can go: after R7 (everyone validated) and the state path (no copies) a same-host call on
a `remote` type and a `local` call run the same code path. What `local` still encodes is two
flags: not addressable from other hosts, and no principal in the identity.
Replacement: `define(name, { host, principals: false | true, … })`. `principals: false` means
identity (type, input), factory `(input, self)`, `ctx.principal` absent. A client serves only
`principals: false` types placed on itself. Variants only with `principals: true`.
What breaks: nothing in p3; the shared-store pattern is the same with one keyword fewer.
Lines: one contract family, one ref type family, one ctx type.

C2. Remove `accepts` on object types, adapted bindings, registry `accepts`.
What: §27 provider-owned old schemas plus value mappings, §22 "adapted bindings get diffs" (a
derive and a cached value per binding), §5 "a version is one it accepts", registry `accepts`.
Why it can go: §21: "A host that starts or reconnects installs the current revision before
anything is routed to it"; rollout order server → workers → clients; a behind consumer's calls
park as `updating`. So in p3 no consumer ever binds with an old version except a plugin that was
not updated, which §21 already treats as `contract_mismatch` "final" with a notice. Registries are
host-local and a host is "completely at revision R or R−1": contributor and owner are never on
different registry versions in one revision.
Replacement: strict fingerprints only (R6 without the `accepts` half): bind iff version and
fingerprint equal; otherwise `updating` during a rollout, else `contract_mismatch`.
What breaks: a third-party plugin built against an older core contract fails to bind instead of
being adapted. Acceptable: it fails loudly, as documents without `migrate` do.
Lines: the largest single cut (old-schema fingerprints, mapping wrappers, per-binding derives and
diffs, their tests).

C3. Shrink jobs to a helper over documents and routines.
What: `defineJob` with `version`, `accepts`, `blocked`, `persist`, `running`, `outcome`,
`concurrency`, `key`, `abort`, `finish`.
Why: the job record is a keyed document (intent in the owner's transaction: `tx.start` is
`tx.draft(records, id)` plus a dedupe key in a singleton); versions and `accepts` on outcomes are
what document `version` and `migrate` already do (a stored outcome is data in the owner's
document); `persist` is the record document's `persist`; `blocked` is a document state.
Replacement: keep `self.job(def, { run, finish, concurrency })` as a thin runner: it watches the
records document, runs `run` for pending records, commits `finish` with the outcome; `running`
is a derive over the records document plus in-memory progress. Keep "a running job counts as a
reference" (one counter).
What breaks: nothing visible; `defineJob` loses `version`/`accepts`/`persist`.
Lines: the job version/adapter/blocked machinery and its wire of `running`.

C4. Routines: four forms to two.
What: `on`, `every`, `loop`, `custom`, plus "due time survives reloads" for `every`.
Why: `custom` is `loop` with a cleanup; `every` is `loop` with `await sleep(ms, ctx.signal)`;
"due time survives reloads" needs a Chord-kept timer per routine name.
Replacement: `routines.on(name, readable, fn)` and `routines.loop(name, fn)`; `every(ms)` is a
one-line helper on top of `loop`; a due time that must survive is a document (the owner writes
`nextAt`). Serialization per name stays, for both.
What breaks: the `every` due-time guarantee across reloads (one document line replaces it).

C5. Merge `lifetime: "host"` objects into the facet.
What: the facet (pure, host lifetime, no natives, "cannot `self.get` a type it serves"), plus
`lifetime: "host"` objects (input-less, pinned, the only native owners that are always on, the
only contributors besides facets, R21), plus the "worker-wide native owners" and R22 patterns.
Why: both are "one host-lifetime object per plugin"; the only difference is that the facet may
not open natives. Drop that restriction: the facet opens the plugin's always-on natives (inbox
watcher, model runtime, sandbox, the harness in the core facet) and contributes. Reload: a facet
with natives restarts like a native object (its plugin's natives restart anyway).
Replacement: `defineFacet((host, self) => …)` where `self` is a full `Self` (`open`, `state`,
`routines`, `contribute`, `get` of other plugins' types). `lifetime` option removed; every
served object is referenced. Start data `SessionInfo` becomes an ordinary referenced object of
the core facet (cheap to hold; R22 goes away because a facet may `self.get` other facets'
types).
What breaks: a plugin with two independent always-on natives shares one failure domain (one
facet). If a real case needs two, split the plugin or accept it. The "facet never gets a type it
serves" rule stays.
Lines: pins, the host-lifetime branch in activation, `FacetSelf`, two documented patterns.

C6. Remove `broken()` for opens and `retryOn`.
What: `throw broken(error)` in an opener, `self.retryOn(...readables)` with its "sources must
live independently of the attempt" rule, watches installed before opens.
Why: they exist so an open with bad configuration is not retried every 60 s. A retry every 60 s
of an invalid SSH config costs one failed connect. Config changes then recover through the
backoff (≤ 60 s) with no second trigger system. `broken` stays for code errors (factory, derive,
hydration, `migrate`), which only a reload or `ref.retry()` fixes.
What breaks: nothing; a Retry button and reload still work.

C7. Remove provider-side `linger`.
What: `serve(…, { linger })`, the lingering state of an object, "lingering objects" in keep-alive.
Why: "keeps a just-closed conversation warm" is an app policy: a host-lifetime holder (the core
facet) keeps `host.hold(Conversation, …)` for N minutes after the last viewer left, in a routine
on `host.references`. One fewer lifecycle state and timer in the kernel.
What breaks: nothing; the same behaviour moves to ten lines of app code.

C8. Remove `state: false` (method-only references).
Why: B5; the snapshot is sent once per hold and the "shared store + view" pattern already keeps
big state out of the types that are mostly called. One hold kind, one `bound` shape.
What breaks: a consumer that only calls methods on a large-state object pays one snapshot.

C9. Remove `previous` from derives.
Why: §12's rule is structural sharing through `mapShared`; `previous` is a second, name-keyed
cache across reloads that a derive "must be correct without". Two caches for one job.
What breaks: incremental derives that used `previous`; `mapShared` covers them.

C10. Merge `constant`, `self.writable` and the in-process readable into one `cell(initial)`.
Why: `constant(v)` is a writable never set; both are "a readable of any in-process value,
identity-compared". One constructor; exposing a cell as a state member is allowed only when its
contract member has a schema (JSON), checked at implementation time (closes B10).

C11. Remove `ctx.trace`; use `traceIn(ctx, …)` from `chord/context` (one spelling).

C12. Remove call credits.
Why: §22 (R1) counts every message's parts in the byte window, calls included. A second credit
protocol for calls adds a frame kind and bookkeeping for nothing the byte window does not do.
What breaks: nothing; a flood of tiny calls still has header bytes.

C13. Collapse the timeout table (§3) to two host options.
`closeTimeout` (native close, call drain, routine handover, job abort drain) and `readyTimeout`
(activation, awaited `get`, parked calls, rollout install). Per-thing overrides only where a case
appears. The `finish` backoff is the object backoff.

C14. Remove `handle.change` and `handle.retire` shorthands.
Why: one way to write (`self.tx`); the shorthands are two more entry points to document and test.

C15. Remove `inVariant`/`expectVariant` helpers from the kernel (keep `RefIn`); they are one-line
checks on `ref.variant` that apps can own.

Keep as is: hosts/links/routes, principals and revocation, documents and store (incl. tags and
eviction), derives with `mapShared`, natives with close reasons, registries with runtime
`compose`, presence, R1 wire, telemetry.

## D. Blockers and majors

D1. major, §22 (R4) "an unknown hold or call id, is a protocol error that closes that link".
Trace: provider revokes a guest → sends `gone(h1)`; the tab's `call(h1)` (or `release(h1)`,
or `cancel(c7)` after `result(c7)`) is already in flight; provider receives an unknown id →
closes the link → every other hold of that tab drops and re-holds. Normal races become link
resets.
Proposal: `release`, `cancel` and `call` on an unknown id are answered, not punished: `call` →
`result` with `gone`; `release`/`cancel` → ignored. Only a malformed header closes the link.

D2. major, §16/§17/§24: a plugin tool has no way to get a `ctx`.
Trace: the subagents plugin contributes a Durable tool `spawn`; its `execute` must call the
server's catalog (`Catalog.create`). Durable calls `execute(args, toolCtx)`; `host.root` exists
on the host object only (§3), which plugins never hold; `FacetApi` is unspecified beyond
`serve`. The first proof's tool with an approval pause is the harness's own; the second tool is
blocked.
Proposal: the facet's `host` (FacetApi) gets `root(fn, { principal?, signal? })`, and the core
harness passes a Chord call scope to every tool execution (`toolCtx.chord: Ctx`, host principal,
abort linked to the task), so a tool writes `await ctx.get(Catalog, {})`.

D3. major, §22 (R2) "An oversized message fails only its own call or member with `too_large`".
Trace: one `state` message per commit per link carries parts for every hold the commit touched;
`maxPayload` (16 MiB) applies to the whole message. A chat window hold with a 20 MB snapshot or
delta in the same commit as five small holds fails all six; a `bound` snapshot above 16 MiB fails,
the consumer re-holds (R19 admits snapshots), fails again, forever.
Proposal: limits per part, enforced from the header before decoding (sizes are in the header);
an oversized part fails only its hold's member with `too_large`, the other parts apply; a hold
whose snapshot exceeds the limit is `failed` with `retryAt: undefined` (no automatic re-hold).

D4. major, §13 (R16) vs. §13 close reason: R16 "disposes of it when its scripts finish or after
the default `closeTimeout` (30 s, no override)". §13: "end it when its running scripts finish or
hit their deadline". §24: "running scripts finish or hit their deadline".
Trace: a code mode script with a 5-minute deadline is 40 s in; the plugin is reloaded (the first
proof's "code mode reload"); after 30 s the detached sandbox is disposed; the script's nested
Durable call fails; the agent turn fails.
Proposal: the detached sandbox is disposed when its scripts finish or hit their own deadline;
`closeTimeout` bounds only `close` itself (which returns at once). Say so in §13 and R16.

D5. major, §3 (B6): IPC flow control by frame count with unbounded part sizes.
Trace: a worker publishes 10 MiB snapshots (file index) to 20 relayed tabs behind a slow server
event loop: 20 parts per commit, window of N frames, memory grows by N × 10 MiB before
backpressure.
Proposal: one byte window for every link kind, counted from part sizes in the header (free on
IPC and memory now that parts are bytes or sized objects).

D6. major, §19/§3: keep-alive inputs have no API.
Trace: the worker supervisor report needs "any client hold on this host", active calls, running
jobs. §19 gives `host.references(Type)` per type; a plugin would have to enumerate every type it
knows, and foreign plugins' types are unknown to it.
Proposal: `host.activity`: a readable `{ holds: number, calls: number, jobs: number }` for the
whole host (clients only for `holds`), plus `host.references(Type)` for presence per type.
