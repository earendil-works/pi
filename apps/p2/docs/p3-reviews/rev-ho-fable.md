# rev-ho-fable — adversarial prototype and target-design reviewer

This file records the findings, review points, open questions, and recommendations I produced during the Chord v2 / p3 design reviews. It intentionally includes superseded designs and prototype-specific findings so the reasoning is not lost.

Status labels:

- **[DECIDED / SUPERSEDED]**: the owner subsequently chose a different design or explicitly addressed the point.
- **[ADDRESSED]**: a later prototype/design revision addressed the specific issue, though the prototype was not merged.
- **[OPEN]**: no later decision in this conversation clearly resolved it.
- **[KEEP]**: implementation property or test coverage worth preserving.

---

## 1. Drain/handover prototype, first adversarial review

Branch reviewed: `chord-handover`, initial local handover model.

### 1.1 Re-entry after one closure member drained — blocker

**[ADDRESSED in the prototype; drain design later SUPERSEDED]**

`object.ts:1667` admitted any root with work in *any* handover-group member. Members handed over concurrently, so A's steps (migrate, close exclusive, open) could run while B still drained. B's old call could then call A and be admitted to A's old implementation mid-steps.

Concrete trace: A and B both bumped. A drained instantly and began `close conn1`. B's old call did `ctx.get(A).write`; A v1 ran after its resource was revoked, `conn.value` threw `stale`, and `count.change` wrote `{n:99}` to the old cell. The staged `{m:1}` was then installed and the write silently disappeared.

Recommendation: drain the whole closure before any member's steps, or stop admitting re-entry to a member once its drain finishes. The prototype adopted a closure-wide quiet point and re-entry only until then.

### 1.2 A second effect swap during pending asynchronous cleanup — major

**[ADDRESSED; serialized routines retained in current target]**

A second `swap()` could find no active run and start immediately while the first asynchronous cleanup still ran. The first completion then bailed because its swap generation was stale, leaving `stalled` permanently true. New and old setup effects could overlap.

Trace: v1 setup had a stubborn asynchronous cleanup; reload v2 reported pending; reload v3 started v3 while v1 cleanup remained; after v1 settled, `stalled` remained true.

Recommendation: keep a per-slot `#stopping` promise, chain subsequent swaps on it, and clear stalled state when that cleanup settles regardless of later swaps. This became the current rule that routines are serialized per routine on reload.

### 1.3 Derivations installed from prepare-time values — major

**[ADDRESSED; trials later SUPERSEDED]**

The prototype precomputed derivations during prepare and installed that value at publication. Old code could write source cells while prepare waited on another object.

Trace: x v2 derived `n*2+1000`; while y's `init` blocked prepare, x v1 changed `n` from 1 to 5. Publication installed 1002 instead of 1010 and it stayed stale until another write.

Recommendation: recompute synchronously at publication before mutation, or attach without the prepare-time value.

### 1.4 New effect handler received old-shaped buffered state — major

**[ADDRESSED; state is now transactional documents]**

State-source events buffered across a handover were delivered to the new handler before the migrated reset.

Trace: observations were `v1:{n:1}`, then `v2:{n:13}`, then `v2:{m:13}`. New code acted on v1 data.

Recommendation: queued values from readable state are not events; drop them on swap and resubscribe for the current snapshot. Only real event sources buffer data.

### 1.5 An operation started by old code after publication got a new stamp — major

**[ADDRESSED; operations replaced by jobs]**

A pre-publication call could call `job.start` after publication. The operation was stamped with the current publication even though it ran old code, so old resources closed before the operation settled.

Trace: old call started v1 operation after compatible v2 publish; old `conn1` closed while the operation ran; it later failed `stale` instead of returning 1.

Recommendation: stamp detached work with the publication of the declaration/code generation that created it, not the wall-clock publication at `start`.

### 1.6 Failed handover could not revert to last-live code — major

**[ADDRESSED; drain transitions later SUPERSEDED]**

A migration staged v2, a later exclusive open failed, then reloading v1 was rejected as version lowering from staged v2 even though the last-live v1 value remained intact.

Recommendation: plans start from the last-live version; reverting to that version discards staged transition state.

### 1.7 Peer-held references blocked breaking rollout — major

**[ADDRESSED; current rollout uses revision/status mismatch handling]**

Connection-owned v1 references were treated as local live consumers. A server provider could not bump to v2 while any worker held v1, so the rollout never began even though that worker was meant to install v2 in the same rollout.

Recommendation: peer holds do not refuse local publication. End/reacquire them with a retryable `contract_pending`/revision state. Current design instead fails/waits at bind by revision.

### 1.8 Removal accepted while changed code still declared the removed dependency — minor

**[ADDRESSED in prototype; removal semantics remain an OPEN consistency point below]**

Removal checks skipped changed types and ran before their trial factories. A changed holder could install with a now-gone `self.get(B)` reference.

Recommendation: check prospective declarations after factories run, or refuse lookup of a type removed from the prospective service table.

### 1.9 Handover wait deadline ignored drain deadline — minor

**[ADDRESSED; drain design SUPERSEDED]**

Waiting calls used `readyTimeout` only, although a reload could specify a longer drain plus grace. Calls timed out while the handover was still within its own deadline.

Recommendation: fence wait budget must cover drain, step, activation, and grace budgets.

### 1.10 Reconnecting children received redundant full reloads — minor

**[ADDRESSED; current target uses complete-set revisions]**

Every reconnect reinstalled named child modules, restarting effects even when the child already ran them. A connection open before hello could also receive both rollout install and hello install.

Recommendation: carry an artifact revision in hello/install and skip equal revisions.

### 1.11 First-round positive observations

- Publication counter ownership and `releaseAfterOwners` were coherent for ordinary old calls and effect work.
- `linkedSignal` detached listeners correctly, avoiding generation leaks.
- Whole-suite generation GC test was meaningful: it tracked closure sentinels with `FinalizationRegistry`.
- Re-entry across links preserved root ids correctly in the prototype.
- Retry progress avoided double migration/open/close in covered paths once staged-state logic was corrected.

---

## 2. Drain/handover prototype, second review and facet object

The first-round tests were rerun after fixes. Findings 1–7 were confirmed fixed; removal was correctly refused; wait budgets and revision skipping were fixed.

### 2.1 Facet-object activation failure was silent and produced an orphan repair — major

**[Prototype-specific; OPEN as a startup/error-handling test requirement]**

The facet hold was constructed before `object.start()`, so `RefImpl.ready` captured the initial resolved readiness. `install()` resolved while the facet object was still activating; a failed resource open was reported nowhere. Failure forgot the object from `host.objects` but retained it in `facetObjects`. A fixed reload could make that orphan `live` outside the host tables: registrations stayed absent and `host.close()` did not close its resource.

Recommendation: start before creating readiness-dependent holds, and either retain failed host/facet objects as failed live identities or drop and recreate them consistently. Add startup-failure/retry/close tests.

### 2.2 Failed host-lifetime object was never pinned again — major

**[Prototype-specific; OPEN as retry semantics]**

A gone bootstrap ref remained in `hostObjects`, causing reload preparation and repinning logic to treat it as present. Later external `get` could create a transient object, but its host registration disappeared when released.

Recommendation: a gone bootstrap ref is absent; reload must reacquire and pin it.

### 2.3 Prepare deadlocked against an old-code activation — major

**[DECIDED: factory trials removed]**

Old activation waited for `whenReloadDecided`; the trial's new factory held that same object and waited for its readiness. Reload timed out.

Trace: Y v1 activation blocked in old open; X v2 trial declared `self.get(Y)`; Y waited for reload decision, reload waited for Y ready.

Recommendation at the time: do not await changed old activations in trial hydration, or let them restart at publish. Final design removed factory trials entirely.

### 2.4 Old served-object call creating a sibling during facet handover deadlocked — major

**[DECIDED: drain/closure handover rejected]**

A draining old call did `ctx.get` for a new sibling served by the same facet. Sibling activation waited for the facet's handover fence; the fence waited for the old call. It ended only at the drain deadline.

Recommendation at the time: activate under old service and join the closure, or reject immediately rather than deadline-stall. Transactional reload removes this closure mechanism.

### 2.5 Registry entry called without ctx deadlocked the closure — major

**[DECIDED: no late-bound registries; immutable tables]**

A contributor called a registry helper with a synchronous signature and no `ctx`. The wrapper created a fresh root with a never-aborting signal, then waited on its own contributor's fence. Production default wait approached 72 seconds.

Recommendation at the time: no-ctx calls either use old code during drain or fail at the drain deadline. Current design uses immutable old registry tables rather than late-bound wrappers.

### 2.6 A synchronous late-bound entry became a Promise only during reload — major

**[DECIDED: no late binding]**

`defineRegistry<() => string>` returned a plain string normally, but while admission waited it returned an async IIFE/Promise. Runtime behavior violated its type only during reload.

Recommendation: entries must be consistently async, or synchronously fail while unavailable. Current immutable-table design removes the wrapper.

### 2.7 Stalled served object blocked every future reload of its facet with no cancel API — major

**[DECIDED: no drain/stalled model]**

One signal-ignoring call left every closure member updating forever. A repair reload was refused `handover_running`; host API had no way to force-dispose host-principal objects despite the design calling stalled work cancellable.

Recommendation at the time: explicit `host.cancel(address)`/force disposal, or repair reload may force-dispose stalled referenced members. Current no-drain design eliminates this state.

### 2.8 Facet setup could not hold a type from a later facet in the same load — minor

**[OPEN: still a requirement in plugin-loading]**

`host.load` claimed load order independence, but facet setup was synchronously run in each `install`; `self.get` of a type served by a later facet failed `unknown_type`.

Recommendation: two-pass load—register every facet's services first, then activate facet objects/eager objects.

### 2.9 New bump `init` saw unmigrated sibling state — major

**[DECIDED: cells/init model replaced by transactional documents]**

A v2 `init` ran before staged migrated values were installed. It read another v2-declared cell and received its v1 shape.

Trace: `settings` migrated `{n:7}`→`{m:7}`; `cache` v2 init read `settings.value.m`, but observed `{n:7}` and silently stored `undefined`.

Recommendation: run init against a staged prospective view or disallow such dependency. Transactional documents now migrate on access and old definitions throw.

### 2.10 Other second-round observations

- Facet generation GC held across repeated parallel and exclusive reloads: only the current sentinel survived.
- Served objects joining during facet handover eventually activated on new code; releasing a member during handover disposed it after install.
- A finite exclusive open exceeding the step deadline was closed and made the object failed, while retry reopened it unbounded at prepare and succeeded. This contradicted “past deadline = stalled” and showed inconsistent first-attempt/retry semantics.

---

## 3. State-design reviews before transactional documents

### 3.1 Every cell has init; optional migrate review

**[SUPERSEDED by transactional documents]**

1. **Memory-only reset was too easy.** Once every bump had `init`, forgetting `migrate` silently reset drafts/UI state. Recommendation: require explicit `migrate` or `reset: true`.
2. **Mirror stale after resource replacement without cell bump.** `db` v1→v2 could change rows while mirror cell kept old value because init only ran on a cell bump. Recommendation: cell deps on resources, rerunning init after dependency replacement.
3. **Mirror catch-up gap.** Init read source at T1; effect subscribed at T2. External changes between them were lost. Recommendation: subscribe before catch-up or return `{value,since}` cursor.
4. **Init-only siblings had no ordering.** One init could read a sibling still uninitialized; parallel init retried forever. Recommendation: declaration-order init or explicit deps.
5. **Paged clients lacked cache invalidation.** Live window could change shape/revision while cached older pages remained old or stale after edits. Recommendation: window carries `historyRevision`; cache keys include revision and contract fingerprint.
6. **Retry/revert side effects.** Init could write into a source, later handover fail, and revert to old code that did not know the write occurred. “Idempotent” must mean stable-id upsert, and docs must state init writes are not rolled back.

### 3.2 `init({previous, from})` review

**[SUPERSEDED]**

The API itself was sensible for idempotent migration into a source. However:

- Bumped init reran on retry while added-cell init was staged/reused, creating inconsistent semantics.
- Init could call another closure member and deadlock until the step deadline; guidance needed to forbid calls into closure siblings/dependents.
- Most importantly, init ran as new code over unmigrated sibling cells (finding 2.9).

---

## 4. “Reload without drain / version fences” proposal review

**[DECIDED / SUPERSEDED by transactional document store]**

Verdict then: simpler and right direction, but broken if applied to mutable cells and raw natives without retaining bounded ownership waits and serialized effect swaps.

### 4.1 Exclusive close under non-cooperative work produced native errors, not `stale` — major

The fence guarded `resource.value`, but p2 code dereferenced once and held the native. Closing sqlite/PTY/socket under work caused driver errors or partial work, not typed stale.

Trace: Catalog `db.create` does native work, reload closes db, subsequent native statement throws `database connection is not open`/`EBADF`.

Recommendation then: retain a bounded ownership wait before closing exclusive resources. Current target explicitly accepts native errors on resource replacement, so this tradeoff remains deliberate.

### 4.2 Async cleanup old/new effects overlapped — major

Old indexing/reconciliation loop could still run while new effect starts, producing duplicate writes.

Recommendation: retain serialized per-effect swap. **[DECIDED and present as serialized routines.]**

### 4.3 Fence missed values that escaped handles — major

Paths:

- native copied out before replacement;
- old subscription received v2 reset;
- detached old derived returned frozen v1 forever.

Recommendation: fence subscriptions/derivations as handles; copied natives require ownership/grace or accepted native errors. **[Partially DECIDED: document subscriptions through old handles end stale; raw native replacement remains restart-like.]**

### 4.4 Migrate at publish could make publish non-atomic — major

Prepare dry-run might pass, old code changes value, real migrate throws during synchronous publish, leaving partial host mutation.

Recommendation: compute all live migration results before mutation or move migration onto serialized document line after publish. **[DECIDED: transactional docs migrate on access/line after publish, data kept.]**

### 4.5 `stale` thrown in timers/native callbacks could become uncaught — major

Trace: chat shell's sampled output timer called old cell write after bump and threw from timer callback.

Recommendation: behavior belongs only in calls/jobs/routines; errors caught/reported; old document handles stale. **[DECIDED: no bare timers/callbacks touching state; jobs/routines catch errors.]**

### 4.6 Partial writes became routine on every schema-bumping reload — major

Trace: Catalog native `create` succeeds then mirror cell write stales; UI retries and creates duplicate. Login provider completes then state write stales; user repeats OAuth. Chat Durable submit succeeds then cell write stales; UI retries duplicate unless requestId.

Recommendation then: short bounded grace for ordinary calls or transactional state. **[DECIDED: transactional documents make document writes atomic; external effects require request-id dedupe/jobs.]**

### 4.7 Durable reservations/pinned registry phases needed protection — minor

Pinned Durable extension phase could call old entry whose resource was replaced and receive stale/native error. Recommendation: retain immutable table snapshots and map restart-like failures to task retry, not transcript tool result. **[Immutable tables DECIDED; retry mapping still OPEN.]**

### 4.8 Init/mirror rules were not fully expressible — minor

SQLite mirrors had no atomic external readable and could not all become derives. Cross-object reads pushed into resource open, retaining activation cycles.

Recommendation: keep explicit source readable contract and document-backed/plugin-database cases. **[Current kinds-of-state design addresses this structurally.]**

---

## 5. Full transactional-document target design review

Verdict: the core is much simpler and closer to Durable's proven model, but several specification gaps needed resolution before building.

### 5.1 New code window before migration/resource reopen — major

**[Partially ADDRESSED in later §15 wording; verify implementation.]**

At publish all new calls reached new code; migrations and resource replacement happened after publish. Without a readiness gate, new code could read v1 document shape or missing native.

Trace: Draft v1 `text`→v2 `body`; call immediately after publish reads `.body` before migration; derive computes against old shape. Codemode sandbox closes and takes seconds to reopen; new tool call hits not-ready.

Recommendation: in-memory docs use Durable's `valueVersion` and migrate on read; migration commit persists the base. Objects whose resources are replacing stay behind a readiness gate. Open parallel replacements before publication where coexistence is safe.

### 5.2 Async transaction callbacks retain deadlock class — major

**[Durable's rule decided; enforcement still OPEN.]**

Convention “only await tx.draft” is not mechanically enforced. Any awaited call into another object while holding line A can deadlock with B waiting on A.

Trace: A tx awaits B method; B tx awaits A read. Both lines wait forever.

Recommendation: transaction API/type/lint/runtime rejects promises other than branded `tx.draft`; ideally preload declared docs then run a synchronous callback. At minimum dev-mode detection and clear diagnostics are required.

### 5.3 Rollout revisions originally lacked a comparable identity — major

**[DECIDED: revision is `(server incarnation, sequence)` over complete code set; project revisions explicitly still open.]**

Earlier issues: project snapshot digests cannot be ordered; server restart reset counters; rejected host could be waited on forever.

Recommendation adopted for base rollout: incarnation+sequence, status in mismatch response, reconnect reinstalls under new incarnation. Project install ordering remains an open discussion in §15.

### 5.4 Plugin-loading and target contradicted on load order/removal — major

**[Load order and removal still OPEN until text/implementation converge.]**

- Load order: plugin-loading says all facets install before eager activation; facet setup-as-factory can synchronously `self.get` a later type. Recommendation: two-pass load.
- Removal: one text says declared holders refuse removal; another says references end. Recommendation: refuse removal for factory-declared holds; call/client holds end.

### 5.5 Jobs/effects interleaving with current code — major

**[Effect serialization DECIDED; jobs redesigned as sandwich.]**

- Old shell job could finish after Shell result document migrated; terminal write stale, outcome lost/interrupted.
- Old/new effect handlers could both restart same environment/index work.
- Effect could start duplicate job unless idempotency key/running checked.

Recommendations: Chord-owned job outcome, current-code finish; serialized routines; atomic keyed job start.

### 5.6 Presence/keep-alive link loss flapping — minor

**[OPEN]**

Disconnect is departure. Server↔worker link blip drops every relayed hold; `host.references(Chat)` becomes zero, idle-but-viewed worker can exit, presence/login abandonment reacts, then holds reappear.

Recommendation: bindings lost with a retryable link count as lingering during re-hold grace; explicit client release or grace expiry is departure.

### 5.7 Persisted docs keyed by transcript ids need retirement — minor

**[Addressed partly by `SessionTag`; implementation sweep remains.]**

Drafts, shell dedupe, subagent children keyed by conversation can accumulate when conversations disappear but session remains. Recommendation: tag every session-tied document and retire on session delete; if individual conversations can truly be deleted independently, provide a live-id sweep/tag.

### 5.8 Wire atomicity originally per hold, not per commit — minor

**[OPEN unless protocol design changed.]**

One state frame batching member updates per hold does not guarantee atomic observation across two bindings/holds touched by one commit; frames can interleave at relays.

Recommendation: one commit frame per link carrying every touched hold batch, applied before any listeners run.

---

## 6. Jobs design review and proposal

### 6.1 Core recommendation: effect sandwich

**[DECIDED and written into §10.]**

A job is detached work started atomically by a method:

1. **Intent:** `tx.start(job, args, {key})` creates/deduplicates/admission-checks on the object's line.
2. **Effect:** old-generation `run(args, ctx)` may do external work, streams Chord-owned progress, and returns a typed result.
3. **Outcome:** Chord records outcome in its own job record, then current code's `finish(outcome, tx)` writes current-schema documents and acknowledges atomically in the same commit.

This solves a run finishing after reload migrated the plugin document: old code never writes the document; finish uses current handles.

### 6.2 Proposed job semantics

- Typed `defineJob(name, {version,args,progress,result,concurrency,persist,accepts})`.
- Required dedupe key for user requests where duplication matters; Chord mints globally unique run id.
- Atomic concurrency and dedupe in intent transaction.
- `running` includes executing and pending-finish records so a stuck finish holds the busy slot.
- `ctx.progress` is typed, throttled, bounded with `OutputBuffer`/`Progress`, in-memory deltas.
- Abort is a request: signal run; run can return partial successful/cancelled result; signal-ignoring run retains its slot until it ends.
- Current-code finish retries with backoff; throw leaves outcome pending.
- Version adapters convert old args/results for current finish; terminal stored outcome is not rewritten.
- Persisted jobs only on stable identities. Live record found after crash becomes `lost`; effect is never rerun automatically.
- Running/unsettled jobs count for object lifetime, worker keep-alive, and relocation fence.
- Work that must resume belongs in Durable task; request-bound work can remain a method.

### 6.3 External systems cannot be atomic with Chord finish

**[DECIDED in design guidance; fundamental limitation.]**

`finish(outcome, tx)` follows Durable's rule and cannot call Durable submission/network/another object. There is no atomic transaction across Chord and Durable anyway.

Recommendation adopted: external write happens in `run`, keyed by `ctx.jobId`; `finish` only records Chord documents. For chat shell, Durable `requestId: shell:${jobId}` prevents duplication if submit committed but process died before Chord outcome record.

Systems without a dedupe key cannot be exactly-once. Chord can offer at-most-one attempt, not both no-loss and no-duplicates.

### 6.4 Concrete job classification

- **Chat `!cmd`: job.** Must outlive browser tab; needs detached execution, progress, abort, dedupe and current-code outcome. Today's code hand-rolls all of these with `host.root`, map, resource, AbortController and cell.
- **Env test: long method call.** Caller waits; short/retryable; no detached lifecycle needed.
- **Login OAuth: job + Questions.** Must outlive one tab and be visible/answerable elsewhere; progress carries auth URL/device notices; Questions handles prompts.
- **Codemode/tool/subagent work that must resume or belongs to transcript causal order: Durable task**, not Chord job.
- **Questions `ask`: long method call.** It should die with its server-side hook/flow caller.

### 6.5 Job abort/crash traces

- User abort signals run; run returns partial output if possible; finish records result.
- Object end aborts run. Persisted pending outcome finishes at next activation; in-memory record may be reported and lost.
- Host crash: persisted live records become `lost`; in-memory jobs vanish. Chord does not falsely claim the external effect did or did not occur.
- Reload: old run continues; current code finishes it.

### 6.6 Honest limitations/open questions for jobs

- Exactly-once external write requires external idempotency key.
- Non-stable object identities cannot retain job record over host crash.
- Signal-ignoring native may linger; current design retains slot until it truly ends rather than lying.
- Interactive input document migrations can stale an old subscription; Questions avoids using a plugin document.
- A blocked old outcome without an `accepts` adapter can hold concurrency forever. **Recommendation: prepare refuses a job version bump while live/pending old-version records lack coverage. [OPEN unless added.]**
- Abort example must preserve partial output: catch abort and return data, or include last progress in failed outcome. **[OPEN wording/example issue.]**
- Live/unsettled run must hold its object alive like a reference so finish has a line/resources. **[OPEN unless specified.]**

---

## 7. Questions service review

### 7.1 Core design assessment

**[DECIDED and documented.]**

The service is sound in its core:

- pending entries/resolvers live in a resource, not a document;
- `open` is a source-readable/derive over that store;
- register waiter + abort listener before publishing;
- one atomic settlement removes entry before resolving;
- late/second answer fails;
- answers validated against stored question;
- authorization checked separately for view and answer;
- rejection/link loss is not denial; asker retries with same key;
- Durable tool approval memo prevents re-asking after task replay;
- notices (auth URL/device code) use job progress, not Questions;
- per-prompt abort withdraws a question.

### 7.2 Initial issues and resulting recommendations

1. `open` must not be a document; otherwise old `ask` removal can stale after migration and leave ghost questions. **[DECIDED.]**
2. Resource replacement must reject pending askers unless `replace(old)=>old`; asker retries. **[DECIDED.]**
3. Link rejection must retry rather than map to deny. **[DECIDED.]**
4. Scope authorization lives in factory; guest send access does not grant approval. **[DECIDED.]**
5. Notice-only prompt/withdraw needed. **[DECIDED: notices via progress, prompt-specific abort.]**

### 7.3 Remaining Questions review points

- A single `Questions({scope})` contract cannot naturally have both server placement for owner scope and session-host placement for session scope under static type placement. Recommendation: separate `OwnerQuestions` and `SessionQuestions`, sharing schemas/store logic, or explicitly add branching placement support. **[OPEN.]**
- Login example using only `ctx.jobId` for every prompt in one flow risks reattaching to the previous prompt if prompts overlap or settlement races. Use `${jobId}:${promptId}`. **[OPEN.]**
- `self.derive([pending.value.readable], ...)` reads a resource value during factory/trial declaration. Better: resource handle is a source resolved at activation, or facet exposes a readable member. **[OPEN implementation/API detail.]**
- Approval hook must run after argument-rewriting hooks so approval covers final arguments. **[Documented decision; preserve in registry ordering.]**

---

## 8. Resources `replace` review

### 8.1 Handover hook assessment

**[DECIDED.]**

Synchronous `replace(old)` is a useful narrow mechanism for shape/container changes that preserve native identity, avoiding needless socket/process restart. Logic remains in routines; old handles stale; throwing replacement fails object and closes old value.

### 8.2 Dependent resources must be handled

**[OPEN unless §12 updated.]**

A dependent opened from the old provider value remains bound to it if provider uses `replace` but dependents are not reopened/replaced.

Trace: `watch` depends on `conn`; conn v2 replacement wraps/reuses socket, but watch retains listeners/container assumptions built from v1. Later close/restart can orphan it.

Recommendation: after provider `replace`, every dependent whose dependency incarnation/version changed is itself replaced/reopened in provider-first order, unless its own `replace` explicitly hands it over.

### 8.3 Accepted resource-replacement tradeoff

Current design explicitly treats raised resource version like restart for that native: calls/jobs are not waited for or signalled; work holding raw native gets native error. This is an owner decision. Preserve tests around terminal service, radius socket, sandbox and sqlite-like plugin DB replacement; errors must be caught by call/job/routine boundaries.

---

## 9. Routines namespace naming

### 9.1 `run` versus `routines`

Initial ranking proposed `self.run.on/every/loop/custom`, with `react` and `keep` alternatives. On follow-up, I ranked **`routines` above `run`** because collisions were substantial:

- job definition has `{run, finish}`;
- each job execution is a run;
- `custom` setup receives `run(fn)` helper;
- `self.run.custom(api => api.run(...))` gives “run” three meanings in one line.

`self.run.every` reads well alone, but docs would repeatedly disambiguate. `self.routines.on/every/loop/custom` is longer but names standing object-owned behavior clearly (Go routines / OTP-like processes) and leaves “run” to jobs.

**[DECIDED: latest target uses §11 Routines and `self.routines.*`.]**

---

## 10. Reload without factory trials / dry-run review

### 10.1 Overall position

**[DECIDED: reload = restart without restarting; explicit load → publish → after.]**

I mostly agreed with dropping the trial object universe. Trial atomicity for factory throws caused severe complexity: objects created during prepare, old activations waiting on prepare, cleanup/adoption ambiguities, and closure bugs. Restart-like failure is coherent.

### 10.2 Keep facet setup staging

A setup may serve types and register entries before throwing. Direct live mutation would leave a partial facet.

Recommendation adopted: setup runs into a staging sink; throw discards that facet staging and keeps previous facet services/entries/object. Successful facet staging installs atomically with others.

### 10.3 Registry conflict handling

Tables must be built from successful new staging plus previous entries of rejected facets. A `conflict:"error"` discovered at publish should reject the contributing declaration/facet deterministically, not leave half a table.

### 10.4 Publish duration

Synchronous re-run of every live declare-only factory is acceptable and preferable to half-published objects. Measure/report one-tick duration. Derive notifications occur after adoption. Large live-object counts need benchmark/watchdog but not asynchronous publication.

### 10.5 Start barrier distinction

First load is not reload: Durable opens without scheduling, host values provided, all facets/eager contributors live or failed, required configuration checked, then `resume()`. Reload needs no global barrier, but per-object readiness gates and routine serialization remain.

### 10.6 Migration error behavior

Exposed singleton migration failure should be per member rather than killing the whole reference/object: methods and other members stay usable; member reports error; data kept. Current transactional-doc design states migration refusal on access and member error; preserve this behavior.

---

## 11. Focused reload and rollout review of latest §15

### 11.1 Binding can wait for an install that already rejected — major

**[OPEN unless mismatch algorithm now consults local outcome.]**

Worker facet rejects R+1 and keeps v1; server provider is v2/R+1 installed. Worker v1 binding receives provider `{R+1, installed}`. Comparing only revision says “provider ahead, my install is coming,” so it waits to deadline, reholds and repeats. Its install already rejected.

Recommendation: binding consults its own host's outcome for provider revision. If this host/plugin rejected it, fail immediately with that reason. Provider response alone is insufficient.

### 11.2 After-order must cross objects — major

**[OPEN specification detail.]**

Resource deps cross object boundaries via references and facet closure. Terminals trace: `TerminalServiceObject.service` bumps; `Terminals.view` depends on service and its open calls service. If dependent after-step runs before provider gate opens, it uses closed/not-ready native.

Recommendation: object's after-step waits for readiness gates of referenced provider objects and facet object; provider-first DAG, with cycle diagnosis. This is activation dependency ordering, not drain ordering.

### 11.3 Failed re-run of an existing host object can remove required contributor — major

**[OPEN / owner decision needed.]**

Facet setup staging keeps old facet on setup throw, but a live host object's factory throw currently makes the object failed and removes entries. Example: models host object throws, `HarnessConfig.default` disappears; Durable resource waits in `whenRegistered` forever and worker never becomes usable.

Recommendation: symmetry with facet setup: if a live object's re-run factory throws, keep its previous version/entries and report rejection; only first activation has no fallback. At minimum required-key wait must reject visibly after barrier rather than hang.

### 11.4 Removal rules remain inconsistent — major

**[OPEN.]**

§15 says removed objects/references end. Plugin-loading says any surviving declared holder refuses removal before preparation. If removal proceeds while unchanged consumer holds removed type, its factory is not rerun; it remains live with gone ref indefinitely.

Recommendation: one rule in both docs. Preferred: refuse while factory-declared holds exist on any host; call-scoped/client refs end. Alternative: dependency-changed consumer objects must be rerun/failed as if their plugin changed.

### 11.5 “Registry table built once” versus old entries until live — minor

**[OPEN wording/algorithm.]**

Keeping an old contributor entry until its replacement gate opens implies another immutable table swap at that gate. It cannot literally be built once for the whole reload.

Recommendation: whole table swaps at publish and whenever a contributor transitions live/failed; each table immutable and snapshots remain valid.

### 11.6 Pinned Durable phase and raised resource version — minor

**[OPEN p2 glue.]**

A phase holds old immutable Extensions snapshot; resource used by old tool entry bumps/closes. Tool gets native/stale failure. That should be task retry/restart-like failure, not a transcript tool result the model reasons over.

Recommendation: p2 tool wrapper classifies Chord `stale`/restart-like unavailable/native-close errors as retryable task invocation failure where safe.

### 11.7 Worker spawn/install race — minor

**[OPEN implementation requirement.]**

Worker spawned mid-rollout may receive init list for R while install R+1 arrives before `host.load`/start barrier finishes.

Recommendation: install queue serializes behind initial load/start barrier; init carries revision; equal queued install becomes no-op; different incarnation forces reconcile before routing.

### 11.8 `rejected` status conflates whole-host old revision and partial facet keep — minor

**[OPEN naming/status.]**

A load error leaves entire host on previous revision. A setup throw keeps one facet previous while others publish. Both called `rejected`, but mismatch handling needs plugin/type granularity.

Recommendation: `installed_partial {kept:[plugin,reason]}` or equivalent per-plugin outcome. Treat kept plugin types as rejected and successful plugins as installed.

### 11.9 Several quick rollouts

Per-host install requests must serialize. Every revision names complete desired set, so R+2 reconciliation can subsume skipped R+1. Parked calls belong to binding/code generation: replacement/release ends them; do not resend automatically. Durable/user writes need their own request IDs.

### 11.10 Server restart/reconnect

Revision `(incarnation, sequence)` is the right decision. Different incarnation is incomparable and requires complete reconcile before serving. Server must persist/derive desired complete code set independently from transient rollout state; rejected outcomes from prior incarnation cannot be blindly waited on.

### 11.11 Late clients / clients that never install

Background web/TUI may install late; calls park only until bounded deadline. If client code generation is replaced, parked calls end and are not replayed. A client that cannot build/install surfaces update-required/error; provider must not retain work forever.

### 11.12 Start barrier required-key failure

`runtime/worker.ts` currently waits for registry keys such as `HarnessConfig.default`. Required contributor failure must reject barrier with named cause; optional facets may fail and remain unavailable. Never leave `whenRegistered` pending forever after all contributors have settled.

---

## 12. Plugin-loading consistency and loader/GC recommendations

### 12.1 Explicit reload, not save

**[DECIDED.]**

Plugin reload is explicit (`npm run reload -- plugin`) after edits. Runtime/base changes restart affected hosts. This reduces frequency of restart-like resource failure and makes partial side effects less surprising.

### 12.2 Complete desired code-set reconciliation

**[DECIDED for base rollout.]**

Every revision names all facet digests, not just a patch; each install reconciles missing/different pieces. This is necessary for skipped/reconnected hosts and rapid successive rollouts.

### 12.3 Loader generation reclamation

**[KEEP.]**

Model D (base bundle + one script per facet, host packages external/passed in) is compatible with old-generation calls/jobs and immutable registry tables if nothing retains the generation.

Preserve:

- generation sentinel GC tests after 3×/6× reload;
- dev leak detector and heap-snapshot action;
- no behavior in resources;
- immutable old registry tables;
- compile cache disabled/bounded for in-place VM scripts;
- browser compilation-cache measurement and full reload after bounded generations if necessary.

### 12.4 Cross-plugin identity/import guardrails

Preserve no `instanceof` across plugin bundles, typed surfaces by name, cross-plugin imports limited to contracts/pure allowlist, host packages single instance, and contracts bundled from plugin's own versioned dependency so adapters are meaningful.

### 12.5 Project plugin identity remains open

Two project scopes can both define plugin `foo` with different code. Relocating a session could interpret persisted `foo.*` records/tasks with the wrong implementation. Recommendation already present: provenance includes project/plugin identity (scope digest or stable package identity), and mismatch is “plugin not available,” not execution by same-name code.

---

## 13. Consolidated items to preserve from the abandoned drain prototype

**[KEEP; several already in target.]**

- Facet object and served-object dependency relation.
- Immutable registry table identity and snapshots.
- Per-effect/routine serialized swap.
- Publication/adoption notification queue so observers never see half commits.
- Publication/work ownership stamps where needed for deferred cleanup and generation GC.
- Revision separate from health/failure status.
- Generation-GC and repeated-reload leak tests.
- Activation retry sharing/backoff per address; explicit reload/dependency change clears it.
- Resource dependency ordering (including cross-object/facet deps).
- New activation never goes live under code already replaced.

Do **not** preserve: closure-wide drains, re-entry/root ids, staged cell copies, transition resume progress, handover deadlines/stalled states, or late-bound registry wrappers.

---

## 14. Current overall verdict

The transactional-document design is materially simpler and more sound than the drain/handover prototype: data is on serialized object lines, old definitions cannot touch migrated documents, running calls/jobs keep their code, registry tables are immutable, and reload does not invent a second trial object universe. The remaining high-risk items are specification/implementation boundaries rather than a need for another reload architecture:

1. binding must fail fast when the relevant install already rejected;
2. after/readiness dependency order must cross objects;
3. required contributor failure must not silently remove essential registry keys or hang the start barrier;
4. removal semantics must be identical in target-design and plugin-loading;
5. transaction await restrictions need mechanical enforcement;
6. project revision/identity and per-plugin partial-install status need a precise model;
7. jobs need coverage checks for old pending outcomes, partial-abort output semantics, and object-lifetime ownership;
8. Questions needs resolvable placement/types and prompt-specific keys;
9. wire commit batching across holds should be explicitly atomic if cross-binding consistency is promised;
10. link-loss presence should distinguish transient re-hold from true departure.

With those resolved, §15 is sound enough to build. None requires reintroducing drain-based handover.
