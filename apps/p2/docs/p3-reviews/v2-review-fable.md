# Chord v2 review (fable)

Reviewed at `e5864dd82` (branch `private`), kernel through step 6 part 1 (derives). Uncommitted natives work was
ignored. Sources: `packages/chord/docs/{design,kernel,step-*}.md`, `packages/chord/docs/decisions.md`,
`apps/p2/docs/chord-next-walkthrough.md`, `packages/chord/src/**`, `packages/chord/test/**`,
`apps/chord-playground/**`, with today's Chord, p2 plugins, Durable and `p3-functions/` for context. The 412 kernel
tests pass at HEAD. Probes were run from a clean worktree (`/tmp/chord-head/packages/chord/test/probe/*.test.ts`,
throwaway); their output is quoted where it matters. File:line references are to HEAD.

Severity: **blocker** (must be settled before p3 plugins are written on it), **major** (will bite a real plugin or
leak/stall in production), **minor** (hardening, drift, perf).

---

## A. Findings

### 1. blocker: every remote method runs with the host's principal; `ctx.principal` and `ctx.get` escalate to host authority

Design §5 table: "`ctx.principal` in methods: the caller". §8: "`principal` (remote only)". §23: "`ctx.principal` is
the request's principal, so `ctx.get(Notes, …)` gives that principal's view". Walkthrough concept 12 says the same.
`MethodImplementation` types `ctx` as `Ctx<P>`, so authors will read `ctx.principal` believing it is the caller.

Code: `object.ts:536-547` (`LocalBinding.call`) builds the handler's scope with `this.host.principal!` for both
local and remote; `connection.ts:1001` (`#call`) runs incoming calls under `host.root()` with no principal, so the
link-stamped principal (`served.request.principal`) never reaches the method. `step-3.md:35` ("Object methods retain
execution-as-host semantics") and `test/host-smoke.test.ts:45` / `requests.test.ts:104` lock the opposite of
the design in.

Probe (`principal.test.ts`): guest `{kind:"user",id:"guest-1"}` holds `Notes {S1}` through server → worker and calls
`ctxPrincipal()`; the handler sees `{"factory":{"kind":"user","id":"guest-1"},"ctx":{"kind":"worker","id":"S1"}}`. A
method that does `const audit = await ctx.get(Audit, { session })` gets the *worker's* variant of `Audit`
(`{"kind":"worker"}` returned by `audit.who()`). Same host: `host.root(fn, { principal: user })` →
`ctx.get(T).who(ctx)` → `{kind:"server"}`.

Why it is a blocker and not a doc nit: the "shared core, per-principal views" pattern only stays safe as long as a
view never delegates to another *remote* view. The first p3 case that does (Chat's `send` writing through
`Workspace`, an HTTP route doing `ctx.get(Notes, …)`, a tool approval hook) silently acts as the worker/server. And
there is no plugin-reachable way to act as the caller: `FacetApi.root` has no `principal` option (`facet.ts:13`),
`ctx.get` has none, only app code holding the `createHost` result can call `host.get(T, i, { principal })`.

Fix (pick one, then align design, walkthrough, step-3 and tests):
(a) `ctx.principal` = the link-stamped caller (data only), `ctx.get` keeps acting as the host (explicit in the
    docs), plus `ctx.as(principal)`/`root(fn, { principal })` on `FacetApi` for the HTTP and hook cases; or
(b) keep execution-as-host everywhere, remove `principal` from `Ctx`, make §5/§8/§23 say so, and give HTTP routes
    `req.principal` plus a principal-scoped `root`.
Either way: thread `request.principal` from `connection.ts:#call` into `LocalBinding.call` and add a test that a
relayed guest call observes the guest.

### 2. major: references do not re-hold after a routed link drop; passive viewers stay `loading` forever

Design §1 goal 5 "References re-hold by themselves", §3 "after a drop the consumer re-holds every hold over the new
link", §3 route "Chord calls `resolve` ... again after a drop", walkthrough concept 8 model answer ("the values stay
readable with `loading`; ... when the new incarnation is up, the reference re-holds").

Code: when a routed child link closes, `connection.ts:1135` marks relayed holds `detached` and sends `status loading`;
`remote.ts:134` (`detached`) puts the binding in `idle` and `loading`. Nothing schedules a new `resolve`: only a new
hold, a call (`#call` on `detached` → `#open`) or an explicit `retry` frame reaches `connectionFor`. Consumer-side
`reconnect()` exists only for the client's own parent link (`host.ts:connect`).

Probe (`recovery.test.ts`): client holds `Counter {S1}` (state only); worker host closed; after 500 ms the viewer is
still `loading` and `resolves === 1`. A pre-existing `server.get(Counter {S1})` (the shape of every "published
projection" or server facet dependency into a worker) is likewise `loading` with `resolves === 1`. A fresh
`server.hold` afterwards triggers `resolve` and revives everyone (the playground kill test only passes because the
owner clicks `add`).

Impact for p3: a tab showing a conversation whose worker crashed, a session list projection, the subagents parent
holding a child's conversation, the ports plugin watching a catalog: all stall until a user action. Fix: on
`connectionClosed` for a routed target, schedule a re-resolve with the per-address backoff while any served
`detached` request or idle binding with refs exists for that address (the trigger model the docs already describe);
or make the design say honestly that views do not recover without a call and give the UI a `ref.retry()` button.

### 3. major: no drain deadline anywhere: a handler that ignores `ctx.signal` hangs object end, `revoke` and `host.close()`

Design §3 timeouts: "call drain: waiting for an ending object's own call handlers (callers are rejected at once), =
`closeTimeout`". Code: `object.ts:385` (`end`) and `object.ts:300` (`fail`) await `Promise.allSettled([...calls])`
with no bound; `host.ts:#finishClose` awaits every `object.end()`; `host.revoke` awaits them too.

Probe (`revoke.test.ts`): guest calls `hang()` (never resolves, ignores the signal); `server.revoke` resolves (the
server owns no matching object) but `cluster.close()` never completes (vitest timeout); the worker's own `revoke`
promise dangles. The playground's worker `stop()` would never disconnect; only the server's 2 s SIGKILL saves it.
p3 handlers (SSH exec, model streams, PTY reads) routinely take seconds to honor a signal. Fix: bounded drain with
the host default, then report and proceed; `revoke` must not await drains at all.

### 4. major: a facet failure is permanent and poisons every object it serves

`facet.ts:83` (`fail`) sets `failed`, aborts the controller and ends the self; nothing ever calls `activate()` again
(only from `declaring`). `host.ts:#failFacet` fails served objects, which then retry with backoff forever:
`object.ts:#activate` awaits `service.activation()` = `facet.ready`, a permanently rejected gate.

Probe (`facet.test.ts`): worker facet does `self.get(Catalog)` (server type); the parent link is not up within
`readyTimeout` → `load()` rejects `ready_timeout`; afterwards `worker.hold(Core, {})` reports
`failed: facet:probe.catalog was not ready after 200 ms` indefinitely. In p3 a worker that starts while the server is
busy (or the relay is reconnecting) loses its whole plugin until the process restarts. Design §6 gives objects
transient backoff; facets need the same (or a facet must not fail on dependency timeouts at all: keep it `loading`,
objects park).

### 5. major: full-schema validation of large state on every change, at the provider per binding and at every consumer

`object.ts:472,478`: every event of every exposed state member is validated against the consumer contract schema
(whole value), and `remote.ts:prepare` validates the whole applied value again at every consumer.

Probe (`validate.test.ts`, `perf.test.ts`): `assertValid` on a 500 KB chat-shaped value: 8.2 ms (vs 1.1 ms
`cloneTrusted`, 0.5 ms `JSON.stringify`, 0.06 ms for the tracker change). One-character append with 0 remote viewers:
7.9 ms; 1 viewer: 23 ms; 3 viewers: 54 ms (in-process viewers, so consumer-side validation is included; a real
worker still pays the 8 ms per change plus the diff work per derive). A streaming turn at 20 deltas/s on a 500 KB
view spends ~160 ms/s of the worker's loop on validation of its own authoritative state. Today's Chord validates at
the consumer only (`src/connection.ts:1318`); v2 added the provider side. Fix: validate once per publication at the
provider (per object, not per binding; members shared by several contracts), validate ops by path or skip
consumer-side validation for same-origin trusted hops, and cache `isValue` for immutable values (`WeakSet`).

### 6. major: reload semantics for native objects make terminals and the harness un-reloadable in practice

Design §21: native objects of a reloaded plugin restart ("running work ends `aborted`, natives close"); remedy: "split
that native into its own plugin". But §13/§14 put the behaviour around a native (routines) in its owner. For
terminals (`p3-functions` #11) the owner of a PTY is also the byte pump; any change to the pump kills every shell. For
the harness (§24) a change in the plugin that opens Durable aborts every running agent task. The "split" remedy
yields a plugin per native with routines that may never change, which is the p2 complexity the design wanted gone.
Also undefined: §21 "pure objects swapped in place ... running calls finish on old code" vs the kernel's handle model:
`self.end()` deactivates document handles (`self.ts:131`, `owner.ts:112`, `HANDLES.active=false`), so an in-flight
`tx.draft(oldHandle)` throws `gone` the moment the new factory's self replaces the old one. Decide: either natives may
be retained across a reload when the new factory declares the same native (opt-in, e.g. keyed `self.open` with
`keep`), or state that terminals/harness are "restart only" plugins; and define what happens to running transactions
on swap (keep old handles valid until their calls settle).

### 7. major: IPC links have no flow control at all

`link.ts:133` `IpcLink.transmit` returns `undefined` → `Connection.send` counts size 0 → `#full` is never true
(step-3 "native unsized IPC never waits for byte credits"). Node's `child.send` buffers unboundedly when the pipe is
full. A worker publishing large state (chat view deltas, logs, status) to a server whose loop is busy grows the
worker's heap without bound and the server's inbox likewise; no reset plan ever triggers. Design §3 "flow control per
link (carried over)" is not true for the only server↔worker transport. Fix: size IPC frames (cheap: reuse
`frameSize`, or count messages) and apply the same window.

### 8. major: `accepts` adapters are not the pure functions the design describes; authors must hand-build Readables

Design §5/§27: `accepts: { [old]: adapter }` maps provider implementation to the old view. Code:
`object.ts:443` `implementationMembers(this.contract, view, false)` requires every state member of the adapted view
to be an object with `subscribe` and `events`; `test/adapted-state.test.ts:17` defines its own `mapped()` helper
to satisfy that; Chord ships none. The first real version bump in p3 will fail with `invalid/implementation: doc must
be a readable`, or worse, authors will return `{ value }` objects that pass nowhere. Fix: adapters map *values* per
member (`{ state: { doc: (v2) => v1 }, methods: { … } }`), Chord derives; keep per-binding diffing internal.

### 9. major: revocation ends views but not the work a revoked guest started in trusted cores

Design §4 and §13: revocation ends objects whose principal matches; "Chord aborts only the object's own calls and
jobs". Calls chain (the view's call scope aborts when the view ends, `object.ts:536-547`), so a guest's *call* into a
local core stops. Jobs, flows (`LoginFlow` as a keyed document, Questions), lingering core state keyed by guest id,
and provider-side `linger` objects do not: the core has no principal and no hook. For sharing (`p3-functions` #12)
"revoke live access" must also end a removed guest's running shell job, pending question, and queued sends. The
design needs either a `host.onRevoke(r)`/registry hook for cores or a rule that cores key guest-initiated work by a
revocation label and reconcile from `host.references`.

### 10. major: relayed holds that fail permanently retry forever and hide the cause

`connection.ts:537` (`#open` catch) treats every failure, including `forbidden` from `route.authorize`, as transient
with a 1–60 s backoff for as long as the client keeps the hold (and the failed reference "stays alive" by design §7).
Calls on a `failed` served entry reject with `gone: unknown or failed hold` (`connection.ts:1027`), not with the
cause (§7: "reject at once with the cause"). Each denied hold on the server costs a timer and an `authorize` call per
retry per client. Fix: map `forbidden`/`invalid/placement`/`contract_mismatch` to the design's `broken` (no automatic
retry) and return the cause on calls.

### 11. major: a worker start is killed when its first requester leaves

`host.ts:720`: when the last pending requester of a resolving route goes away, the resolver signal aborts; the
playground kills the child (`server.ts:77`). In p3 a worker takes seconds (Durable open, environment probe); opening a
session and navigating away within that window kills it mid-start, and the next visit starts another. Repeat on a
flaky phone and the session never comes up; a kill during Durable's open is also where storage corruption happens.
Combined with 12: nothing keeps a half-started worker alive. Fix: let a started worker finish and register as
`live`; abort only resolvers that have not produced a link.

### 12. major: consumer-side linger cannot do what §19 says; keep-alive inputs do not exist yet

§19: "`ref.release({ linger: true })`: its hold stays, marked lingering (a closed tab, 2 minutes); it keeps the worker
alive". A closed tab closes its socket; `remote.ts:136/179` and `connection.ts:#closed` discard every lingering lease
on link drop (documented in step-3). So only the *provider-side* `ServeOptions.linger` can keep anything alive after
a tab closes, and it is invisible to presence. The decision log admits "a link drop is still a departure" but the
design text and walkthrough still sell the closed-tab case. Meanwhile `host.references`, activity counters and any
idle computation (decision #1) are absent, so the playground cannot even stop a worker. State the truth in §19 and
decide #1 before p3's server exists.

### 13. minor: backoff maps leak per failing address

`host.ts:354` and `forgetBinding`: `#backoffs` entries are deleted only when no failure is recorded. Every
per-principal remote object or remote binding that ever failed leaves an `AddressBackoff` forever (guest tabs
hitting a throwing factory, denied addresses). Bound it (expire after the cap delay) or store the failure on the
object table entry.

### 14. minor: unbounded per-link resources for an authenticated client

`connection.ts:987` `maxCalls` defaults to `Infinity`; hold ids are unbounded; first views bypass the window
(`connection.ts:579,939`); `call`/`result` frames never wait for credits. One guest tab can hold thousands of
addresses (each activating an object and a `ParkedCalls`) or queue megabytes of first snapshots. Defaults for
`maxCalls`, max holds per link and total unacked bytes for non-state frames are cheap.

### 15. minor: deeply nested frames crash IPC peers

`values.ts:104` `isValue` is recursive; a 200k-deep array makes `isFrame` throw `RangeError` (probe `deep.mjs`). On
WebSocket links the `#message` chain catches it and closes the link; on IPC the exception escapes the `message`
listener and kills the process. IPC peers are trusted today, but a bug producing deep JSON would take the server down
with a worker. Make `isValue` iterative or depth-limited; validate before `deliver`'s `bye` check.

### 16. minor: keyed reads take the exclusive line

`owner.ts:132` (`read`) acquires the owner line `exclusive` for `handle.get(key)` and `keys()`. Chat history paging
(the design's "paged method" for large collections) then serializes every reader behind every writer of the same
object. Reads should take `shared`; only transactions need exclusive.

### 17. minor: a server storage failure leaves a zombie process

`host.ts:189` `storageFailed` → `host.close()`. The playground worker's `onError` stops the process; the server has
no handler: the WebSocket listener stays up, the next `host.accept` throws `gone` inside the `connection` handler,
which is an uncaught exception. Design §10: "the host reports it and restarts" names no owner for the restart. Either
Chord exits with a distinct code or the app must be told to supervise.

### 18. minor: documentation drift that will mislead plugin authors

- Walkthrough "Open points at a glance" still lists `close` with a reason and diffs for adapted bindings as open;
  both are decided (log) and the latter implemented. Concept 14's Open block contradicts design §13.
- `RefState.failed` is `{ cause: FailureCause; retryAt: number | undefined }` in design §7, `{ cause: ChordError;
  retryAt: number }` in walkthrough concept 8 and code.
- `step-3.md:35` and `kernel.md` describe execution-as-host; design §5/§23 say caller (finding 1).
- §19 closed-tab linger (finding 12).
- Design §3 timeouts table promises per-`get`/per-type overrides (`readyTimeout`, park deadline); `GetOptions` and
  `ServeOptions` have none; one `readyTimeout` serves activation waits, parked calls and derive hydration.
- `principalKey` must be the same function on every host (the provider keys objects, the consumer keys bindings and
  `revoke` matches by it); the design says this for `revokedBy` only.

### 19. minor: state frames are encoded up to three times on WebSocket links

`connection.ts:#writeState` calls `link.check(frame)` (`frameSize` = full `plan` + `JSON.stringify`), then `send`
(`encodePortable` = plan + stringify again), and queued frames are sized again for `waiting.bytes`. `plan` also
allocates a path array per node. For a 1 MiB snapshot that is three serializations per send.

### 20. minor: remote dependency cycles spin forever

`host.ts:acquireOwned` detects cycles only among local bindings. A worker object holding a server object that holds
the worker object waits `readyTimeout` on both sides, fails transient, retries, and repeats every 1–60 s with the
message "dependency cycle?". Detect at least the two-hop case by carrying the activation chain in the hold frame, or
mark the second timeout `broken`.

### 21. minor: transaction/document footguns to document or fence

- `tx.get`/`handle.initial()` return the live readable value (same object as `handle.value`); outside dev mode a
  caller mutating it corrupts the authority (`owner.ts:get`).
- `keys()` for in-memory keyed docs scans every entry on the host (`store.ts:memoryKeys`).
- A read-only transaction on a document with a newer definition writes a base to storage (`owner.ts:finish`,
  `base = storedVersion !== version`); fine, but a read in a hot path after a version bump turns into a write storm
  until every document is touched once. Mention it in §9.

---

## B. Does the design hold together?

| Area | Verdict |
| --- | --- |
| Hosts and routing | Sound shape; `connectionFor` always goes to the parent when one exists, so workers reach siblings only via the server (fine). Recovery after a child drop is pull-only (finding 2) and start/abort is caller-coupled (finding 11). |
| Principals and revocation | Stamping and forwarding are correct (clients cannot forward; only the parent is trusted; `revoke` frames only from the parent). Execution principal contradicts the design (finding 1); revocation does not reach work in cores (finding 9); `principalKey` consistency is unstated. |
| References, failure, backoff | Transient/broken split is not in HEAD; everything retries. Shared per-address backoff is right. Failed facets never retry (finding 4). Dependency timeouts mark the dependent failed instead of parking (design says park then transient; code: `awaitReady` 60 s then `fail`), which is consistent with the log but makes a slow server fail every worker object once. |
| Documents and transactions | The strongest part. Lines per owner, facet line second, prepare-before-storage, adopt-after-commit, one batch per link, migrate on access, tags, eviction: coherent and well tested (conformance suite, fences, versions, retention). Gaps: exclusive reads (16), undefined behaviour of in-flight transactions on reload (6), the "hang, not error" rule for `tx` misuse. |
| Natives and close reasons | Not in HEAD. The design is clear except the reload consequence (finding 6). `closeTimeout` must also bound call drains (finding 3). |
| Registries with compose in staging | Reasonable; `compose` in staging is the one place a plugin conflict can roll a host back, good. Undefined: what consumers see between commit and the first `compose` on host start (an empty table?), and how a `lifetime:"host"` object waits for a required contribution without a Chord API (§24 "wait for the required contributions"). |
| Reload with per-host rollback | Staging with a recording `self` is plausible; the kernel's `SelfImpl` per attempt supports it. Undefined: in-flight transactions and `ctx.get` references of running calls when the self is swapped (6); routines serialized per name need a routine identity that survives a rename. |
| Rollout | Not in HEAD; the mismatch table is fine. Open #12(a) matters: a client ahead of the server after a page reload parks every call for 60 s instead of reloading. |
| Presence | Finding 12. |
| Jobs | Sandwich is right. Jobs can exist only in stable identities if they persist; a guest's job must therefore live in a core with attribution as data, and revocation cannot find it (finding 9). "Jobs as objects" (#9) would fix both the flow-address question and revocation (an object has a principal) and should be decided before login/shell are ported. |

## C. What will break when the real p3 plugins are built

- **Chat with Durable:** harness restarts on any reload of its plugin (6); conversation view validation cost per delta
  and per viewer (5); tool approval needs a principal-scoped `root` that plugins cannot reach (1); a crashed worker's
  open chat views stall (2).
- **Workspace:** file tree as state is fine; large listings as paged methods serialize behind writes (16); "workspace
  not for guest read" is decided in the view's factory, correct, but any workspace method that delegates to another
  remote owner escalates (1).
- **Terminals:** channels are not in the kernel yet; the PTY owner cannot be reloaded without killing shells (6);
  IPC backpressure for terminal state (7).
- **Sharing:** revocation of links/objects works; guest-started jobs and flows survive (9); grant revision bumps
  create new objects and orphan nothing (good, persist is refused for remote identities). Guest per-user persisted
  state (name, read marks, drafts) needs a server core keyed by grant id with the view passing the id as data.
- **Subagents:** worker→worker through the server as the worker principal is fine; a parent's hold into a child's
  worker never recovers after the child restarts (2); `authorize(workerA, sessionB)` needs the catalog's parent/child
  relation, which is app policy, fine.
- **Session list / status "without starting a worker":** every hold of a worker-placed type resolves (starts) the
  worker; there is no read-without-start primitive; decision #19 (published projections) must come before the
  sessions plugin, and finding 2 applies to the server-side copies.

## D. What could be cut or simplified

- Coordinated reset collection across relays (`connection.ts` `#collectReset`, `#resyncs`, `#resetRequests`,
  shared-response matching, ~300 lines of the riskiest state in the kernel). A relay that overflows can drop the
  hold's feeds and re-hold with `again: true`; the provider already answers with a fresh `view`. Per hold, no
  cross-link coordination.
- Per-binding diffing for adapted bindings (`object.ts:install` adapter branch, `diff.ts` byte fallback): replace by
  value adapters that Chord wraps as derives (finding 8).
- JSONL storage ("dev only, grows forever") and `MemoryDocumentStorage.prepareCommit/snapshot` (built for a removed
  Durable adapter).
- Consumer-side linger cache (`#lingering`, cap 4, `presence` frames): provider-side `linger` plus `host.references`
  cover presence and keep-alive; the client-side variant cannot survive the case it was designed for (12).
- `accepts` on host values (versioned start data is a schema bump in the app's start message).
- Dev-mode freezing of local arguments/results: it catches nothing for bytes, and `tx.get` already hands out live
  authority values unfrozen outside dev.
- The Questions service as a second input pattern; keep flows (state + `answer`) only until a case needs quorum.

## E. Under-tested

- No test asserts the caller's principal inside a method (tests assert the host's).
- Recovery after a routed drop is tested only through a call that re-resolves; no test for a state-only viewer or a
  pre-existing server-side hold.
- No test for `host.close()`/`revoke` with a handler that ignores its signal (finding 3).
- No test for facet recovery after a failed activation (there is none to test).
- No IPC backpressure test; no test that a 16 MiB state over IPC does not grow memory.
- No multi-viewer cost test; no benchmark for state validation per change.
- `accepts` adapters across a relay and across a worker restart.
- Revocation while a target is `resolving`, and revocation of a principal whose relay hold is `pending`.
