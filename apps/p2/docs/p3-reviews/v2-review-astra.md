# Chord v2 review — Astra

Reviewed committed `private` HEAD `e5864dd826b145fc78d2165ed78a580dfa0fe9d5`. Concurrent native/retry implementation changes were excluded: inspection and execution used a `git archive` snapshot under `/tmp/chord-astra-head`. The decision log takes precedence over the design.

**Verdict: not ready as p3's runtime.** There are reproducible authority, failure-propagation, cancellation and compatibility defects in the committed kernel. The remaining registry/reload/job design also needs a small adversarial prototype before porting real plugins. This is not a recommendation to discard the design or to restore Chord v1's distributed reload transaction.

## Evidence and scope

- Committed Chord next suite: **412 tests passed in 53 files**. Command: `node /home/badlogic/pi-private/node_modules/vitest/dist/cli.js --run test`, from the snapshot's `packages/chord`, using Node 24.4.1.
- Committed playground: **19 tests passed**, including its shared SQLite cases and five playground cases. Command: `node --conditions=source --test test/playground.test.ts test/document-storage.test.ts`. A playground-local package symlink resolved Chord to the snapshot, not the concurrently edited workspace.
- Separate bounded probes reproduced findings 1–10 below. Probe files are `/tmp/chord-astra-head/astra-probe.ts`, `astra-probe2.ts`, `astra-bindings.ts`, and `astra-performance.ts`; their essential setups/results are recorded below so the findings do not depend on those temporary files surviving.
- Read the v2 design, decision log, walkthrough, implementation notes, kernel/storage/transport code and relevant tests; compared the old Chord specification and guide, p3 functionality map, p2 runtime and representative chat/workspace/sharing/terminals/subagents/codemode integrations, plus Durable's harness, registry and phase-snapshot integration. This is not a full audit of Durable or every p2 plugin.
- No real sessions, production endpoints or credentials were used. No implementation files were edited. Natives, routines, jobs, registries and reload are not implemented in the reviewed snapshot; findings about those explicitly identify design gaps, not failures of the concurrent implementation.

## Findings

### 1. Blocker — remote methods receive host authority, not the bound caller

**Location:** `packages/chord/src/object.ts:535–547`; `connection.ts:1001–1031`; design §5, `ctx.principal` row.

`LocalBinding.call()` constructs a remote method's `RemoteCallScope` with `this.host.principal`. The authenticated/bound object's principal is not used. Incoming dispatch also starts an ordinary host root, so simply copying the ingress scope's principal would not fix every path.

**Reproduction:** server principal `{kind:"server"}`, accepted client principal `{kind:"guest"}`, remote factory records its principal, method returns `ctx.principal`. Result: `factory = guest`, **`method = server`**. This also affects `ctx.get`: it acquires subsequent views under host authority. A method that permits an operation when `ctx.principal.kind === "server"` grants it to a guest. Existing playground authorization captures the factory principal, so its passing guest tests do not exercise this boundary.

**Fix:** use the remote object's authenticated, bound principal for remote method contexts and their `ctx.get`; retain host authority only for principal-free local calls and declared internal references. Test guest → remote method → `ctx.get` on the same host, over a direct link and through a relay, including owner-only denial and attribution. This is a required security correction, not an optional API refinement.

### 2. Blocker — consumer-supplied schemas can synchronously stall the host before admission

**Location:** `packages/chord/src/host.ts:274–306,342–348`; `contract.ts:73–75,232–261`; `values.ts:197–209,546–686`.

An incoming hold reconstructs an executable validation description from peer data. `acquire()` normalizes and validates using that consumer schema before even checking whether the provider type exists. Frame size limits do not bound schema evaluation cost.

**Reproduction:** an authenticated raw client holds a nonexistent remote type with input schema `Type.String({pattern:"^(a+)+$"})` and input `"a".repeat(23) + "!"`. A 24-character input blocked the event loop for approximately **297 ms**. Slightly longer inputs grow exponentially. No valid provider or successful route activation is needed at the targeted host.

**Fix:** do not execute arbitrary peer validation programs as admission logic. Resolve an authorized provider first, normalize using provider-owned schemas, and validate consumer descriptions against a deliberately bounded schema grammar/complexity budget. Compatibility checking also needs safe handling of patterns/references. Add raw-wire adversarial schema tests, not just malformed-frame tests. Authentication alone is insufficient: a read-only guest is still an untrusted peer.

### 3. Major — a live consumer remains healthy after its declared dependency fails

**Location:** `packages/chord/src/object.ts:294–300,333–345`; `self.ts:94–103`; `packages/chord/docs/step-6.md`, “Whole-object failures”.

Declared references are awaited during activation, but their later lifecycle is not supervised by the owner. Failing the dependency detaches its feeds and marks its references failed; it does not close the dependent object's gate. A derived view can continue exposing its last successful value and accepting unrelated methods.

**Reproduction:** local `Core` exposes a derive which throws after an input changes; local `View` declares `self.get(Core,{})`, derives a value from it, and offers `ping() => 42`. After the failure: **Core failed; View live; `ping()` returns 42; View still exposes the old value 0**.

**Fix:** supervise declared dependencies throughout an attempt, not just activation. Define failure/loading transitions, close dependent admission immediately, and reconnect/recompute before reopening it. Preserve stale values only with a visible non-live state. Test post-live dependency failure, retry and link loss, including dependencies not used by any derive. The implementation note currently promises behavior this trace contradicts.

### 4. Major — ending an object neither promptly rejects its callers nor bounds teardown

**Location:** `packages/chord/src/object.ts:337–338,367–397,569–580`; design §3 timeout table and §6 lifecycle.

The method's child scope correctly includes object/attempt cancellation, but the returned promise races the invocation against **only the caller's** signal. `end()` then waits without a deadline for every underlying invocation. Failure cleanup does the same. An uncooperative handler therefore keeps its caller, cleanup and subsequent activation blocked.

**Reproduction:** a remote method awaits an externally controlled promise and ignores its context. Start it and call `host.close()`. The method remains pending after a 50 ms observation; shutdown also cannot complete until the latch is manually released. The source has no eventual drain deadline, so this is not merely a slow test.

**Fix:** race the caller-facing result against the linked child signal; separately track and drain the actual handler with the decided per-type bound. After the deadline, report retained work and finish teardown without permitting late authority writes. Test object failure, explicit shutdown and revocation with a handler that never settles, and late handler settlement after cleanup. Native cleanup must not be layered on top of this unbounded wait.

### 5. Major — `host.root` scopes are not owned or cancelled by the host

**Location:** `packages/chord/src/host.ts:365–381,430–480`.

A root links only the supplied caller signal. The host records neither its scope nor its completion. Consequently host shutdown can return while external ingress work is still running with a non-aborted context.

**Reproduction:** run `host.root(async ctx => { capture(ctx.signal); await latch; })` on an otherwise empty host. After `await host.close()`, **the captured signal is not aborted** and the callback is still waiting. This matters for future HTTP routes and Durable hooks that start work through `root`; not all such work holds an object method invocation.

**Fix:** give root scopes a host-lifetime cancellation source and track them for bounded cleanup. Keep cancellation of the caller-facing wait distinct from joining arbitrary user code. Add a root-only shutdown test and an ingress callback that observes cancellation while using an external service.

### 6. Major — one incompatible consumer can fail an otherwise valid shared provider object

**Location:** `packages/chord/src/contract.ts:268–290`; `object.ts:440–445,505–507,589–593`.

Coverage allows a consumer to mention a subset of provider variants. Installation then validates the selected provider variant against that consumer. If it is absent, the installation error calls `object.fail()`, poisoning every binding to the object instead of refusing just that consumer.

**Reproduction:** provider contract has variants `a` and `b`, factory returns `b`; obtain a valid full-contract reference. Bind a same-name/version/input consumer containing only `a`. The new get fails with `invalid/implementation: unknown variant b`, and **the already-valid full reference becomes failed too**.

**Fix:** decide variant compatibility before installing a binding and distinguish provider-invariant failure from consumer/adapter binding failure. Reject an unsupported consumer with a binding-local mismatch; do not restart a correct provider. Test a stale or deliberately restricted consumer alongside a valid consumer of the same principal/object, including over the wire.

### 7. Major — member dispatch uses the first variant's signature instead of the active variant

**Location:** `packages/chord/src/reference.ts:260–275`.

The proxy selects the first matching member across all variant descriptions and caches a closure containing that descriptor. Contracts permit variants with different method arities, and even different member kinds. TypeScript narrowing therefore promises calls that the runtime misinterprets.

**Reproduction:** variant `a` declares `run: method(undefined, Type.String())`; variant `b` declares `run: method(Type.String(), Type.String())`; factory returns `b`. `run("hello")` treats `"hello"` as a context and fails with **`invalid/foreign_ctx: ctx must come from Chord`**.

**Fix:** dispatch from the active shape/variant, including for a previously extracted method function. If variant-dependent kinds/arities are intentionally forbidden instead, enforce and document that at contract definition and reflect it in types; do not silently accept them. Test both variant orders, method/state collisions, loading-to-live admission and extracted functions.

### 8. Major — released contract bindings and failed-address records have unbounded retention

**Location:** `packages/chord/src/object.ts:218–224,416–423,427–437`; `host.ts:159,284–287,320–323,351–355,757–760`.

A local object's binding map never removes a zero-hold binding; detaching even retains member snapshots. A remote peer can create arbitrarily many compatible descriptions by changing an annotation such as `title`, then release each hold. A legitimate reference keeping the object alive keeps all those dead bindings alive too. Separately, failed-address backoffs are deliberately not removed on object/binding disposal, with no TTL or capacity.

**Reproduction:** keep one valid reference, acquire/release 100 same-name compatible consumer contracts differing only in the input schema's `title`. Inspection of the object's binding map after all releases reports **101 bindings**. Their subscriptions are detached, but their tokens and snapshots are retained.

**Fix:** evict zero-hold bindings after any explicit linger and keep only bounded retry metadata. Give failed-address backoffs a TTL/cap that still prevents immediate retry storms. Add repeated hold/release tests with unique descriptions and failed addresses, measuring internal retained counts rather than only active holds. Admission quotas are also needed for live holds; a frame-size cap is not a cardinality cap.

### 9. Major — SQLite delta commits replay the entire existing tail on every write

**Location:** `packages/chord/src/storage/sqlite/storage.ts:61–84,143–179`; `state.ts:33,42`; `documents/owner.ts:632–651`.

For each changed document, `commit()` materializes its base and all deltas to construct a temporary `MemoryDocumentStorage` validator. With no `checkpointWhen`—a supported default—N tiny changes perform quadratic cumulative replay, despite the host already possessing validated materialized authority. Even a new checkpoint write first pays for the old tail.

**Reproduction:** one SQLite document `{n:0}`, then three consecutive batches of 250 tiny delta commits. Batch times were approximately **113 ms, 217 ms, 346 ms**. The increasing work follows directly from the unbounded tail scan, not from document size growth.

**Fix:** bound physical delta tails by default and separate batch/lifecycle validation from full history replay. At minimum perform bounded backend checkpoints without requiring every plugin author to predict this failure mode. Avoid solving it with a permanent unbounded mirror of all documents. Add a long-lived hot-document benchmark and query/replay-count assertions, including no-op and checkpoint writes.

### 10. Major — byte validation enumerates one JavaScript property per byte

**Location:** `packages/chord/src/values.ts:108–111,403–409`; design §§22–23, raw byte transport and approximately 1 MiB chunks.

`isBytes()` implements the “no extra properties” check with `Reflect.ownKeys(value).length === value.length`. For a typed array this allocates a list containing every index key. Validation repeats at multiple frame and value boundaries, so native byte transport still performs expensive per-byte string-key work on the event loop.

**Reproduction:** three `isValue(new Uint8Array(1024 * 1024))` checks averaged approximately **102 ms per check** on this host. That is only one validation seam, before packet encoding or relay/provider checks. The clone benchmark motivating zero-copy bytes does not measure this cost.

**Fix:** treat bytes as opaque leaves with constant-time recognition and define/ignore nontransported attached properties, rather than enumerating indexed elements. Keep dev-only mutation diagnostics separate from the production path. Benchmark end-to-end 1 MiB chunks through WebSocket → relay → IPC, including validation counts, latency and allocation pressure.

### 11. Major — the playground does not enforce one writer or exit-before-replacement

**Location:** `apps/chord-playground/server.ts:43–55,61–95`; `worker.ts:28`; p3 functionality map, “one worker per store”.

The server has no data-directory process lock. Route resolution forks immediately and overwrites `workers[id]`; abort sends SIGTERM but does not make the next resolution await the previous process's exit. The worker opens the session SQLite file without an incarnation/process lock. SQLite serializes individual transactions, not the two hosts' independently cached document authority.

**Failing scenario:** two accidental playground servers point at the same data directory, or a link disappears before its old worker has actually exited and another resolution starts. Both workers can materialize the same old document and commit valid but conflicting updates. An incarnation in the handshake detects a replacement; it does not fence the old storage writer. Current crash tests explicitly wait for SIGKILL/exit before making the next call, avoiding this case.

**Fix:** enforce an exclusive server/store lock and serialize replacement through confirmed exit, with bounded termination and a worker lock as the final guard. Keep process supervision in the app/adapter as decided; do not make Chord a process manager. Add duplicate-data-directory startup and link-loss-with-live-old-worker tests before using this playground supervisor as p3's template.

### 12. Major — staging-time registry composition has no defined answer for activation-dependent entries

**Location:** design §§13,16–17,21,24; decision log “Registries and HTTP” and “Durable harness inputs”. **Design gap; registry/reload implementation is not present.**

Factories/staging cannot read a new native handle's `.value`. Registry composition must run during staging for rollback, yet entries may carry natives and disappear when their owner fails. The design does not specify the distinction between candidate declarations and ready runtime entries, nor how recomposition failure after activation is handled.

**Failing scenario:** an environment/model runtime contributes a native-dependent value; staged composition needs its metadata to detect a duplicate or select a provider. It either reads an unopened handle and rejects a valid reload, or postpones validation until activation and discovers a conflict after the rollback point. If an opener then fails, including its candidate entry exposes a not-ready handle; excluding it changes the composed value after commit. A successful staging composition alone proves neither runtime availability nor a usable required provider.

**Fix:** make a narrow rule explicit: staging composes static descriptors and lazy entry functions only, without native/document reads; runtime availability is a separate state and required services gate their consumers. Specify atomic publication/removal and errors for post-commit activation failure. Prove startup and reload with a real Models/Environments/Harness graph, an opener failure and a composition conflict before general registry helpers proliferate.

### 13. Major — pinned Durable phases and sealing a reloaded sandbox conflict for delayed tool entry

**Location:** decision log “Code mode in p3 drains its sandbox in close”; design §§13,17,24; `packages/durable/src/harness/tool.ts:115–176,413`; `scheduler.ts:1320–1337`; `apps/p2/plugins/codemode/worker.ts:37–55`. **Design integration gap.**

Durable pins a tool/registry snapshot for a phase, including its `beforeTool` work. The proposed native reload seals the old sandbox, drains scripts already running, then closes it. A phase can hold the old entry without having started its script yet. “New scripts start on the new sandbox through the registry” is not true for that already-pinned entry.

**Failing scenario:** a code-mode invocation resolves its tool, waits in an approval hook, the code-mode plugin reloads and drains an empty old sandbox, then approval completes. The pinned old tool now tries to enter the sealed/closed sandbox. Waiting for currently running scripts alone cannot make this case safe.

**Fix:** choose explicit semantics: acquire an execution lease before the phase can wait; retain the old provider until relevant leases finish; or make the old tool entry resolve a compatible current sandbox when execution actually starts. If delayed old invocations should fail, document that weaker behavior and ensure Durable does not replay an unsafe side effect. Add this approval/reload race and the worker-stop/replay counterpart to the sandbox prototype. Do not generalize this into a global code-version lease system unless this concrete boundary needs it.

### 14. Minor — relocation needs an explicit native-owner pattern, not an assumed reopen

**Location:** design §§13,29; `apps/p2/src/runtime/worker.ts:55–65`; `apps/p2/plugins/workspace/worker.ts:123–158`; p3 functionality map domains 1,9,10. **Porting/documentation gap, not an impossibility in the API.**

A native handle never changes during an attempt; changing it requires restarting its owner. A session's stable identity remains the same while cwd/environment changes. A direct port which opens one watcher at `self.open` and assumes it follows the session will therefore keep watching the old location.

**Failing scenario:** `WorkspaceBackend {conversation}` opens a watch in cwd A; relocation commits cwd B without a code change or failure. The stable reference still names the same live owner and native. Late callbacks from A can continue publishing after the move.

**Fix:** document and test an owner-owned native manager whose stable value explicitly switches its internal watches with generation fencing; p2's workspace already contains such a pattern. Generation-keyed native owners are another option. Neither requires restoring arbitrary resource versions or adding a generic object-restart API. Prove relocation during open, a failed replacement and late callbacks from the old environment before using this as the prompt/workspace port template.

### 15. Major — jobs that outlive calls lack an explicit owner-lifetime rule

**Location:** design §§6,15,20, especially default referenced lifetime and “owned work ... outlives the call”. **Design gap; jobs are not implemented.**

A referenced object ends after its last reference, and ending aborts its jobs. `job.start()` returns a run independently of the starting call, but the design does not say whether an active/finishing job pins its object or whether the run handle holds a reference. Worker keep-alive is not object keep-alive.

**Failing scenario:** an HTTP/root call gets a referenced shell or login owner, starts a job and returns its id. The call-scoped reference is released at settlement. With no UI hold yet, the owner ends and aborts the just-started job. There is also a gap before the caller gets a separate `LoginFlow {id}`. A finishing job whose `finish` retries needs a policy after the last viewer leaves too.

**Fix:** specify whether active and unacknowledged job records pin their owner until settlement, with explicit cancellation/removal and bounded retention for blocked outcomes. Alternatively require these job owners to be host-lifetime and document the resulting address/state organization. Test start-and-immediately-release, disconnect, no viewers, failed finish, plugin removal and persisted crash recovery. Do not add jobs-as-objects merely to avoid deciding this ownership rule.

## Readiness decisions and scope to cut

- **Preserve the shared-core/per-principal-view split**, but fix finding 1 first. Principal identity must survive remote method dispatch; internal local ownership and explicit attribution remain separate concepts.
- **Preserve per-host rollback**, but only for load/declaration/composition failures. Do not quietly extend it to irreversible native opens or migration effects. Resolve finding 12 with a small staged-descriptor/ready-provider example rather than a new distributed transaction protocol.
- **Mixed revisions are not demonstrated.** The committed suite has no rollout implementation to validate. Before calling p3 ready, exercise server commit + worker rejection, a joining worker, a client behind the provider, and the consumer itself being behind/rejected. The decision log already acknowledges own-status checks, serialized installs and complete-code-set digests; those remain required, not optional polish.
- **Durable should remain the resumable workflow engine.** Chord jobs should stay a small owner-local intent/outcome mechanism. Do not duplicate Durable's scheduler, task graph or crash replay. Solve finding 15 before building generic flow/job addressing.
- **First real plugin proof should be Models/Environments → Harness → one tool**, with an approval pause and a code-mode reload. Notes plus a counter does not exercise registry snapshots, native restart, prompt readiness or delayed tool entry.
- **Presence and optional providers need explicit contracts before UI ports.** The decision log still leaves link-drop lingering, origin counts and optional references open. Test two tabs, one disconnect, reconnect and explicit navigation before deriving guest presence, worker idleness or login cancellation from them. Do not infer “user left” from a hot-reload unmount.
- **Keep p3 isolated and start empty as decided.** Do not port legacy catalog/cookie migrations, old attribution parsing or cross-plugin document reach-through. Core-owned creation-time conversation policy is the right place to preserve read-only/follows-cwd rules when a plugin is absent; its API needs a concrete data schema, not an opaque Durable callback.
- **Defer broad optional HTTP/channel abstractions, general middleware phases and a Durable Object execution profile** until the kernel findings and one native/registry/Durable proof are resolved. Native byte channels still need their own explicit connection cancellation and revocation path; a successful Chord `revoke` test alone does not prove an already-open terminal channel is closed.
- **Cut repeated work before adding caches:** remove per-byte key enumeration and full-history validation per delta. Bound existing binding/backoff retention before adding more lifecycle registries. These are simpler fixes than compensating with another batching or caching layer.

## Minimum additional regression matrix

The passing tests establish the implemented happy paths, not p3 readiness. Add, at minimum: authenticated remote method principal and nested acquisition; consumer-selected pathological schemas; post-live dependency failure/recovery; uncooperative teardown and root shutdown; incompatible consumer isolation; variant-dependent member dispatch; binding/backoff retention bounds; hot SQLite documents and end-to-end byte chunks; writer fencing on live-worker link loss. Then add registry/native activation failure, mixed-revision rollout, delayed Durable tool entry across sandbox reload, session relocation and job owner lifetime when those features land.

Documentation cleanup is secondary: `kernel.md`'s old shared-import list omits the subsequently approved `../sqlite` driver layer; the decision log explicitly permits it. That import is not an architectural violation. Conversely, step-6's claim that dependent views fail on a broken owner should not be treated as implemented until finding 3's trace passes.
