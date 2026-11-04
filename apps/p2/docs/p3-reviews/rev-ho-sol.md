# rev-ho-sol — Adversarial target-design, reload and Chord v2 reviewer

## Scope, provenance and status

This is the recoverable record of my findings, review points, open questions and recommendations in this conversation about the target design, reload design, Chord v2 and its p3 successor. It is not the functionality map. It records historical proposals as historical proposals, not as recommendations to restore an obsolete design.

The conversation was compacted. Exact earlier wording survives for the two-phase-jobs response and Questions review in scratch files; those are included verbatim below. Earlier points known only from the retained conversation summary are reconstructed and explicitly labelled. The adversarial plugin report and its essential migration sketches also survive and are included verbatim. I cannot recover missing pre-compaction wording or infer owner acceptance from my own recommendation.

Statuses:

- **Owner decided:** explicitly identified as an owner decision in the retained conversation, or an established rule of the reviewed target.
- **Open:** recommendation or question with no subsequent owner decision known to me.
- **Partly decided:** the architectural rule is decided, but the concrete migration or correctness issue remains open.
- **Superseded:** an earlier recommendation or expectation was replaced by a later owner decision. It must not be treated as current advice.
- **Historical/unverified:** a candidate or old reproduction whose outcome/current applicability is not established by the surviving record.

The last full adversarial review used `pi-private origin/private` at `6559589bd66bc909cfc1d694426799a3c4cd95f6`. Earlier referenced review points used `320ee90511eaf74624092c164ee13b5650868f9f` and older snapshots, including `f04acc2d`. File/line citations in copied reports refer to those snapshots, not necessarily the present worktree. The target design was not implemented/executed by the plugin review: this was source inspection and migration sketching.

Only this review file is being written for the collection request. No commit is requested or made.

## Owner decisions known from this conversation

1. **Owner decided — transactional documents.** Objects are behavior; documents own JSON data. Within a transaction the only permitted await is `tx.draft`. Do not call other objects, models, processes, network operations or a nested transaction there. Fetch external input beforehand and decide writes inside the transaction.
2. **Owner decided — generation-bound document handles.** Old code accessing migrated data throws rather than receiving a new shape through an old type. An old subscription ends with `stale`; partial transactions do not land. Do not weaken this rule to rescue an inadequately checkpointed application phase.
3. **Owner decided — non-draining ordinary reload.** Ordinary running calls/jobs keep their old code. Reload neither waits for nor signals them. They may fail on migrated documents or replaced natives. Cleanup of deliberately removed/replaced native facilities is domain-specific, not a return to generic distributed draining.
4. **Owner decided — declaration staging, no speculative execution.** Load/publish/after replaces speculative factory trials and migration dry runs. Facet setup runs once with declarations staged; native activation and lazy migrations can fail after publish. Check dependency cycles. Contract incompatibility is a bind-time failure with a useful error, not speculative invocation of live consumers.
5. **Owner decided — failed facet retains its previous version.** If setup throws, discard that attempt's staging and retain that facet's previous services, entries and facet object. Other successful facets can move forward. My earlier recommendation to withdraw all old declarations on such a failure is **superseded and withdrawn**.
6. **Owner decided — immutable registries and phase snapshots.** Registration tables are swapped atomically. Already-pinned Durable phases retain consistent old code; do not introduce late-bound registry lookup to silently switch implementations after an await.
7. **Owner decided — start barrier.** Open Durable without scheduling, supply typed host values, install required contributors/configuration, check cwd/model, then resume. A model or cwd check must not race configuration initialization. The remaining open issue is identifying required persisted policy contributors, not whether a barrier exists.
8. **Owner decided — jobs use intent/run/current-code finish.** The author writes `run` and `finish`; the runtime captures a result receipt independently of application document generations. Application finish writes and acknowledgement are atomic. Pure version adapters are required for older inputs/results/progress; unsupported receipts remain blocked and observable.
9. **Owner decided — abort is a request.** Actual native settlement determines the result. A success remains success even if the signal is aborted; partial output must be retained. An uncooperative run stays active until it settles. Finish is not run in an already-aborted caller/run context.
10. **Owner decided — external execution has an uncertainty boundary.** Arbitrary commands cannot be promised exactly-once execution. A persisted execution intent with no recorded outcome after a crash is lost/unknown; do not automatically rerun it. A keyed Durable submission/outbox can guarantee submission admission deduplication, not exactly-once network calls or arbitrary shell effects.
11. **Owner decided — no generic call/root IDs, no stringly typed replacement API.** Keep typed job definitions/contracts and existing domain request IDs. Do not grow Chord into another general phase-based workflow runtime; resumable/checkpointed work belongs in Durable.
12. **Owner decided — Questions is a p2 service.** Use a shared authoritative broker resource with authorized per-principal facades, not a new Chord or Durable primitive. Session send permission is not an approval grant. Scope strings and display names are not authority.
13. **Owner decided — native values are not revoked by a proxy.** Stale handles do not revoke a value already borrowed from a resource. Read `.value` at use; do not keep extracted natives/listeners across an await and then expect a handle fence to protect them. Handover and shutdown still need domain-specific handling. Listener behavior belongs in routines.
14. **Owner decided — dependent resources and derived sources need explicit rebinding.** Declare native dependencies. Providers/dependents are replaced in the specified order; a dependent closes only what it owns. A derive must name its resource handle rather than capture the old native source in its factory.
15. **Owner decided — standing work is grouped and serialized across replacement.** The retained conversation records the preferred name `self.run.on / .every / .loop / .custom`; the cited `6559589bd` files and my verbatim sketches still spell it `self.routines`. Naming drift is historical, not an additional semantic recommendation. New routine instances wait for the previous handler/cleanup, subject to the documented stuck-handler deadline.
16. **Owner decided — presence uses origin identity and linger.** Two tabs are two origin clients even when they share a principal. Linger keeps a worker alive but excludes a client from a live audience/viewer count. Auxiliary subscriptions do not count as extra people.
17. **Owner decided — explicit retirement and stable persistence identities.** Archive is not deletion. Session deletion retires tagged server documents and session storage/catalog data. Persisted drafts/jobs/metadata must use stable logical ownership, not an owner's access path or a worker generation as the persistent identity.
18. **Owner decided/as-reviewed — loader D and SDK direction.** Plugin reloads are per-facet in place; base/runtime bundle changes restart affected hosts. Host values and registries are versioned. UI components/APIs are not all independently versioned yet. Do not invent unsupported compatibility guarantees.

## Earlier review points reconstructed from compacted history

These are reconstructed, not represented as verbatim transcripts.

### Two-phase jobs and detached work

**Partly decided.** I agreed with `run` followed by current-code `finish(tx)` as the right default, replacing my broader delivery-callback proposal. The required intermediate boundary is a runtime-owned receipt: atomic admission → effect → outcome capture → finish+acknowledgement. Reload does not rerun effects or preempt an admitted finish transaction. Persistent jobs require stable owners and persistent receipts. The exact surviving response is reproduced below.

**Partly decided/open integration.** A Chord finish cannot call Durable `conversation.submit`, even if both use SQLite. A cross-store handoff needs a persistent outbox written in finish, drained outside transactions with a stable submission request ID, or authoritative execution/delivery entirely in Durable. Count pending deliveries as work during routine restart/backoff. Submission admission may queue a write rather than place it; observe `submission.wait()` and surface `unanswered` where placement matters. Do not label a completed command as executing solely because delivery is pending.

**Owner decided principle; example correction/open verification.** The earlier shell example submitted externally before returning its native outcome and inferred cancellation from `signal.aborted`. A failed submission could erase a successful command result. Return and capture actual settlement first, then use current finish/outbox delivery. The old shape was still visible in the cited target snippet; I did not recount this already-discussed problem as a new adversarial finding.

**Owner decided separation.** Questions.ask and cancellable environment tests can be ordinary long calls when caller-scoped lifetime is appropriate. Shell execution is not browser-owned: it needs detached counted ownership, progress, abort and outcome recording. Login ownership is not identical to one tab's RPC. Do not make every pending interaction a job.

### Questions broker and authorization

**Owner decided architecture; open implementation checks.** Principal-keyed Chord objects cannot each hold a separate broker Map. Worker askers and owner viewers must meet at shared authoritative backing. Keep descriptors/resolvers there; expose a readable or update a document through current code. An old ask continuation must not remove a row through a handle whose document migrated.

**Open correctness checks.** Install a waiter before publishing. Serialize create/answer/cancel so only one settlement wins. Cancellation during publication must not orphan a row. Validate against the stored question; reject duplicate/late answers; use fresh IDs after restart. Never await a human while holding a transaction/broker lock. Resource replacement/close must reject all waiters. An ephemeral list disappears with waiters; persisted open lists must be reconciled before exposure. Accepted input is not a durable-continuation guarantee.

**Owner decided authorization principle; concrete checks remain required.** Scope addresses cannot authorize actions. Restrict askers to permitted scopes and independently authorize viewing and answering. Use the authenticated initiating owner identity for login, not the display/author name. Never persist, echo or log secret answers. A guest's send grant permits tool actions but does not imply filesystem isolation or authority to approve other work.

**Open/partly decided — approval identity.** My earlier six-finding review required approval memos to bind the final tool arguments, execution context and policy, rather than store a bare boolean by task. The later design addresses ordering approval after argument-rewriting hooks. I do not know that policy/context invalidation semantics were decided. Define what exactly an approval authorizes, including safe execution retries.

**Established implementation trace.** Durable runs `beforeTool` in the call phase, then checkpoints execute. A crash while waiting for approval asks again; a crash after that checkpoint retries safe execution without rerunning the hook, while unsafe execution reports interruption. Therefore “it asks again after a crash” is not universally true.

**Open/unknown later disposition — quorum, timeout and result types.** I previously reported inconsistent timeout/result typing and contradictory quorum settlement, including vacuous `every([])` authorization. Specify empty-audience, membership/departure, timeout and settlement behavior explicitly and make the return type express every possible result. Do not let an empty audience accidentally authorize work. The compacted record does not retain the original exact wording or a subsequent owner decision on these details.

**Owner decided mechanism; migration check open — Questions source replacement.** A view attached to a replaced broker readable must preserve emitter identity or rebind to the new source. Naming the resource handle in the derive is the decided mechanism. Capturing a native readable in the factory leaves the view on the old emitter.

### Login migration

**Open preservation requirements, not requests to add new functionality.** Preserve text/secret/select/manual-code prompts and help text, per-prompt cancellation, distinct prompt keys and accumulated/redacted progress notices. A callback-server success must withdraw the competing manual-code prompt without cancelling the whole login. Auth URLs, device codes and status notices are not all question forms.

**Established existing lifetime; recommendation remains preservation.** A login belongs to the authenticated initiating owner, survives one tab leaving when another relevant hold of that owner remains, and ends after that owner's last Providers hold disappears. Questions replaces prompt plumbing, not ownership of the full flow. Use a flow-owned controller/resource/job or explicitly choose a different caller-scoped product behavior; do not change lifetime accidentally.

### Restart-like reload review

**Owner decided/superseded older machinery.** Avoid speculative factory trials and migration dry runs: callbacks can open natives, mutate external systems or repeat initialization, and a dry run cannot establish rollback safety. Stage declarations; publish once; perform required resource activation afterward with explicit failed-object reporting. Check cycles and publish coherent registry tables.

**Owner decided.** Provide the Durable harness/native host values before plugins need them but do not schedule work until required configuration and cwd contributors are ready. This breaks the previous startup cycle without lazy scheduling racing ahead.

**Owner decided.** Exposed migrated-document failures must propagate with a cause, rather than silently returning an old shape under a new interface or converting a substantive failure into harmless-looking undefined state.

**Superseded.** An earlier recommendation was to withdraw all old entries after failed facet setup. The owner subsequently chose to retain that facet's previous version. Only its staging is discarded; unrelated successful facets can move forward. The adversarial review used the owner's later policy.

### Native handover and Durable consistency

**Owner decided rule; domain work remains open.** A `replace`/stale-handle fence cannot revoke already-borrowed values, callbacks or native work. Handover is safe only when the old behavior has been detached or is explicitly settled. Do not re-report that limitation as though the decided no-proxy policy promised revocation.

**Open migration checks.** Keep schema and implementation snapshots consistent through Durable phases; pin native request/provider behavior where necessary rather than changing it halfway through an auth wait. Distinguish intentionally live credentials/configuration from incompatible implementation/shape replacement. Codemode specifically needs abort-and-settle before a sandbox is closed while the harness survives; a worker restart instead preserves replay behavior.

## Historical drain-prototype reproduction points

Status for this whole section: **historical/unverified**, with explicit supersessions below. The surviving role-named scratch file `/tmp/rev-ho-sol/review.test.ts` contains seven reproduction tests. Its old API names (`effect`, drain deadlines, `installed_pending`, exclusive handover) do not define the current target. No retained output establishes each test's execution result, so these are not claimed as current confirmed defects.

1. A second reload must not start replacement standing behavior before the first generation's asynchronous cleanup settles. **Still relevant principle, now covered by decided per-routine serialization/deadline behavior.**
2. Raw queued run closures admitted before publication were expected to retain resource ownership. **Superseded ownership model:** current ordinary work may continue under old code, but replaced natives can fail and stale document handles throw. Do not restore generic old-resource pinning from this test.
3. An activation blocked in old native open must not indefinitely prevent publishing newer code. **Relevant non-draining goal; open implementation verification.**
4. Retrying a partially failed activation must not rerun an added cell initializer that already succeeded. **Historical cell-API question; current document create/migrate-on-access and storage invariants supersede that exact initializer test.**
5. A surviving consumer reloaded in the same batch must not escape provider-removal safety if its new code still holds the provider. **Relevant removal check:** changed consumers are not automatically exempt, and new holds during prepare must be checked.
6. Registry handlers were expected to delay an exclusive handover until they completed. **Superseded:** the current target does not drain ordinary handlers; they may observe native errors after replacement. Preserve the domain-specific cleanup distinction rather than this generic wait expectation.
7. A newly added host-lifetime object with a failing native open was expected to be prepared before publication. **Superseded by owner decision:** no speculative trials; after-publish activation/resource failure is allowed and reported. Required initial readiness is handled by the start barrier.

The original test source is preserved at the end of this file for its concrete traces, not as a proposed current conformance suite.

## Status of the final adversarial review

The verbatim report below has six main findings. **All six concrete fixes remain open in the surviving conversation; none is known to have been accepted or implemented by the owner.** Their underlying context includes decided mechanisms:

| Point | Status known here |
| --- | --- |
| Persisted subagent policy/cwd capability cannot disappear on first-load failure | **Open design/integration fix.** Initial barrier and retained old facets are already decided, but do not solve fresh-start optional-contributor failure. |
| Codemode call tracker must depend on sandbox | **Open concrete migration fix.** Dependency ordering and domain abort/settle policy are decided. |
| Scope-exit preflight must include Chord jobs and pending deliveries | **Open integration fix.** Durable exit checks and job activity accounting are decided; the provenance/admission bridge is not known implemented. |
| Durable watch must be reopened per restarted routine or genuinely adapted | **Open concrete migration fix.** Restarting/serializing routines is decided. |
| Models provider callbacks must be recomposed on code-only reload | **Open concrete migration fix.** Keeping native data while moving behavior into routines is decided; installed SDK closures require extra handling. |
| Web send completion must not clear newer shared composer state | **Open concrete migration fix.** Continuing old admitted calls and retaining host UI state are decided. |

Additional review/migration points in the report and sketches:

- **Open application migration:** checkpoint Reporter settlement before touching the plugin's migratable registry. A current registry migration may deliberately fault an old deliver phase before handover, leaving the parent unnotified even though the answer survives. Install the new phase layout without simultaneously breaking the registry schema for already-running v1 reporters. This does not justify changing stale protection.
- **Owner decided mixed-facet behavior; implementation check:** retaining a failed models facet while codemode moves on is valid. Compatible contracts continue; incompatible dependents fail clearly. A rejected install report is still a report for reconnect routing; do not require impossible whole-set success before routing compatible services. My investigated mixed-revision “whole host gate” concern was not promoted as a new confirmed contradiction.
- **Open adapter detail:** the server's worker-generation check cannot be weakened from synchronous validation+write into “sample generation, await, write.” The sketch's proposed `withCurrentWorker` holds the per-session lifecycle gate through the short metadata transaction, or an equivalent transactional authority must be used. Same-process plugin generations are not the worker principal generation.
- **Open data migration detail:** persist per-session child rows with SessionTag; retain only a volatile aggregate for live UI. Bootstrap must not overwrite a concurrent fresh report, create rows merely by reading deleted/missing sessions, or make the UI cache authoritative for relocation. Await authoritative ChildStore.get(session) for that decision. Prune the aggregate when catalog session IDs change.
- **Open consumer migration:** removing ModelConfig.resources requires replacing login's direct native access with typed owner methods and updating sessions/login consumers. Do not remove the member without preserving their operations. No native values should cross plugin boundaries.
- **Owner decided boundary; open helper implementation:** a facet factory cannot self.get its own served types or a remote type. Obtain the subagents reporting reference through the routine's ctx.get, rather than recreating the removed carrier's remote factory hold on the facet.
- **Open lifetime integration:** pending outbox delivery must remain activity while its routine is stopped, restarting or backing off. The illustrative liveness.call around a drain invocation alone is insufficient.
- **Open configuration migration:** initial load must complete before first resume, not merely start in an asynchronous routine. Later invalid files retain last-good validated data and expose bounded errors. Code-only callback recomposition must still use last-valid parsed config if the current file is invalid.
- **Owner decided native-error boundary:** do not wait for every old stream on ordinary reload. Compatible recomposition replaces the pointer for new invocations and lets in-flight operations retain their own old SDK generation. Resource close preserves native write/lock cleanup, not a generic drain of all running calls.
- **Open source error handling:** a fresh per-routine watch/source adapter must surface unexpected termination rather than freeze a last snapshot invisibly. Keep snapshot/ops coherence and explicit source rebinding.
- **Open verification, not another finding:** active presence must count distinct client origins, not object count or auxiliary subscriptions; per-hold linger is excluded from Questions audiences but included in keep-alive.
- **Open performance verification:** preserve structural sharing, bounded windowing, paged history, bounded output and throttled deltas. Do not clone or transactionally rewrite the full transcript on each token.

Correction to the verbatim sketches: their prose says “64-entry remote window.” That numeric statement was my mistake. In the reviewed `plugins/chat/window.ts`, WINDOW_ENTRIES is **100**, WINDOW_BYTES is **512 KiB**, WINDOW_MIN is **20**, and WINDOW_SLACK is **1.5**, with a tool-result boundary adjustment. The recommendation was to preserve the existing bounded, structurally shared behavior, not replace those limits. The original wording is retained below because this file is an archival review record.

## Unpromoted investigation questions

Status: **historical/unverified candidates**, not additional confirmed findings or owner decisions.

- Can delayed subagent reports race within one worker generation across a facet reload? Check cancellation of outgoing reports, server-side serialization, authoritative generation fencing and aggregate bootstrap ordering. The migration sketch gives a required gate, not proof that today's synchronous implementation already has that race.
- Can read-only/relocation checks disappear in a mixed retained-facet installation? Normal failed setup retains the old entries, so that specific disappearance is not a generic reload bug. Fresh-start failure has no previous facet and is the concrete finding.
- Do pinned extension closures reach mutable Models/configuration in a way that switches implementations after an await? The concrete findings concern callbacks left installed and invocation-time binding; intentionally live configuration is not automatically a snapshot violation.
- Does a kept one-shot Durable watch tolerate stop/start? Source inspection confirmed it does not; this candidate became the watch finding.
- Do SDK/native callbacks retain plugin generations after resource behavior is moved to routines? The provider callback/fingerprint trace became the Models finding; native close/borrowed values are separately governed by the already-decided rule.
- Are in-place UI construction/render exceptions isolated from the host and other slots? Existing slot/TUI factory consumers lack obvious per-entry boundaries. This was considered but not promoted into the final findings; no new owner decision was established, and deferred UI API versioning is not itself proof of an exception-isolation policy.
- Can child metadata or root session configuration be left stale if native configure succeeds and an old continuation then fails? Recommend reconciling authoritative Durable configuration to the registry/sidebar/catalog from current code rather than relying only on that continuation. This is a migration/reconciliation point, not evidence that stale protection should be removed.

## Verbatim earlier response: two-phase jobs

Status annotation: the owner-decided two-phase/receipt/abort boundaries above supersede any stale API spelling in this historical response. Outbox integration, placement reporting and migration details remain recommendations unless separately marked decided.

I agree. **`run` → current-code `finish(tx)` is the right default.** It replaces my broader delivery callback. The necessary refinement is a runtime-owned result receipt between those phases.

## Contract

```ts
interface JobHandlers<I, R, P> {
  run(input: I, ctx: JobContext<P>): Promise<R>;
  finish(done: JobReceipt<I, R>, tx: Tx): void | Promise<void>;
}
```

A typed `defineJob` token supplies versioned input/result/progress schemas; `self.job(token, handlers)` binds the current implementation. A receipt contains ID, input, and either returned value, serialized error, cancellation, or unknown outcome.

Internally:

```text
atomic admission → run → persist outcome → finish transaction + acknowledgement
```

Two author-written phases, but three durable boundaries: admission, outcome capture, finish acknowledgement.

- `run` returns data; it does not record completion through application handles.
- Chord captures its outcome independently of caller cancellation and application document generations.
- `finish` is selected from current code when its transaction starts. It may only await `tx.draft`; no network, processes, other objects or nested transactions.
- Application writes and the job acknowledgement commit in the **same storage batch**. A failed finish leaves both unchanged; retry finish, never run.
- Reload does not signal or wait for run. An already-admitted finish follows normal transaction semantics; reload does not preempt it.

Persistent jobs require stable owners and persistent receipts. Keeping jobs only in memory cannot provide restart guarantees.

## Shell: where local atomicity stops

```ts
const shell = self.job(ShellJob, {
  persist: true,
  concurrency: 1,
  run: (input, ctx) => collectShell(input, ctx),
  finish: async (done, tx) => {
    const q = await tx.draft(transcriptOutbox);
    q.items.push({
      id: done.id,
      conversation: done.input.conversation,
      write: shellWrite(done),
    });
  },
});
```

`ShellJob` is a typed definition. Input freezes conversation, command, execution configuration and server-stamped author. `collectShell` uses `OutputBuffer` and publishes through `ctx.progress`, backed by `Progress`: bounded output, throttled/coalesced deltas, no progress document writes. Its return includes the final retained output and execution status, including partial output on cancellation.

**Calling `conversation.submit` inside finish is invalid.** Even when both stores use SQLite, a Chord transaction is not a Harness transaction.

Instead, finish atomically records a **persistent outbox item and acknowledges the job**. A p2-owned drainer, outside transactions:

1. Calls Durable `submit` with a stable request ID derived from the job ID and the frozen write payload.
2. After durable admission, removes the outbox item in a Chord transaction.

Crash after admission but before removal → retry the same request ID → Durable returns the existing submission. This provides exactly-once submission admission, not exactly-once network calls. For visible transcript placement, track `submission.wait()` and surface `unanswered`; admission may only have queued the write. Queued writes survive conversation abort.

The drainer must count as pending work for keep-alive and relocation. After handoff, Durable owns the work. UI can retain the outbox preview until placement; it must not call an executing command “running” merely because delivery is pending. A reusable p2 drainer keeps plugin authors at run plus finish.

## Env test: the shape works directly

```ts
const tests = self.job(EnvTest, {
  persist: true,
  concurrency: 1,
  run: (input, ctx) => testSsh(input.config, ctx.signal),
  finish: async (done, tx) => {
    const d = await tx.draft(results, done.id);
    d.revision = done.input.revision;
    d.outcome = done.outcome;
  },
});
```

Capture configuration once; display results only for the matching revision. Resource cleanup belongs inside run and must not overwrite its actual outcome.

## Failure traces and required rules

**Migration:** V1 run starts → result document migrates → V1 returns success → Chord captures the receipt → current finish uses current handles → result and acknowledgement commit together. No false interruption.

**Schema changes:** current finish cannot safely receive old input/result types by assertion. Require pure version adapters; keep original receipts unchanged. Progress views need the same version fence. Missing adapters or finish bugs leave an observable blocked finish, not a replacement outcome.

**Abort:** request cancellation and signal run; wait for its actual settlement. A returned success remains success even if cancellation was requested. Do not infer cancellation merely from `signal.aborted`. Finish uses a runtime-owned transaction context, not the cancelled run/caller context. An uncooperative run remains live.

**Object end:** request cancellation, but runtime outcome capture survives object shutdown. If current code is unavailable, retain the pending finish until reactivation/reinstallation. Explicit session deletion is a separate disposal policy.

**Crash:** persisted outcome → replay finish safely. Started execution without an outcome receipt → record **outcome unknown**, never automatically rerun an arbitrary command. Recovering its actual output/exit requires a durable execution supervisor. Two phases cannot remove that uncertainty.

Admission must atomically deduplicate request IDs and enforce concurrency; no separate running check. Executing and unacknowledged finishing jobs count toward liveness/relocation; expose their distinct states.

## Boundary

Drop §10’s `cleanup` synthesizing interruption and run-written completion documents. Keep two-phase jobs for one-shot work. Use Durable tasks for checkpointed/resumable work, codemode ownership/cancellation, and preferably shell execution when its authoritative result is the Durable transcript—avoiding the cross-store outbox. Do not add general task phases to Chord.

## Verbatim earlier response: Questions and ownership

Status annotation: Questions as a shared p2 service and transaction/stale rules are owner-decided. Concrete broker races, approval binding and login-preservation checks are recommendations; later resolution is unknown unless stated above.

**I agree with Questions as a p2 service, not a new Chord/Durable primitive.** I also agree with the caller-lifetime distinction, but login’s current lifetime needs qualification.

## 1. Questions

Sound with these rules:

- **Shared backing:** Chord objects are keyed by principal as well as input. Worker-asker and owner-viewer instances otherwise get different Maps. Put the broker in a shared facet resource; expose authorized facades over it.
- **Migration:** keeping resolvers is insufficient. Trace: ask captures `openV1` → document migrates → answer resolves → old ask’s `finally` removes its row through `openV1` → stale error/ghost question. Keep descriptors and resolvers authoritative in the resource; expose a readable, or project into a document through a current-code effect. No retained callbacks that write through old handles. Resource replacement/close must reject every waiter.
- **Races:** install the waiter before publishing; serialize create/answer/cancel with one winning settlement. Cancel during publication must not leave an orphan row. Validate against the stored question, reject late/duplicate answers, and use fresh IDs after restart. Never await the answer while holding a transaction or broker lock. With a resource-authoritative projection, a briefly stale visible row is harmless: answering it returns “no longer active.”
- **Authorization:** scope strings are addresses, not authority. Trusted askers may publish only into permitted scopes; a worker cannot choose another session. Check both viewing and answering separately. Session send access does not automatically authorize approvals. Login scope must use the initiating authenticated owner identity, not the shared display/author name. Never persist, echo or log secret answers.
- **Crash:** an ephemeral open list disappears with its waiters. A persisted list must be cleared/reconciled before exposure; otherwise it advertises unanswerable questions. An accepted answer is not a durable continuation guarantee.

**Important correction to tool recovery:** current `ToolTask` invokes `beforeTool` in `call`, then checkpoints `execute`. Crash while awaiting approval → hook asks again. Crash after that checkpoint → safe execution retries **without hooks**; unsafe execution reports interruption. “It simply asks again after a crash” is not universally true. Also, later `beforeTool` hooks can rewrite arguments: approval must cover the actual final arguments, not an earlier version. Define whether approval authorizes execution retries.

Real login prompts fit with an adapter: text, secret, select, and `manual_code` with its help text. Preserve per-prompt cancellation: callback-server success must withdraw a competing pasted-code prompt without cancelling the login. Keep auth URLs, device codes, progress notices, remote device-code preference and redaction; these are not all questions.

## 2. Do we need jobs?

Long calls require cancellation propagation and cooperative native operations; cancellation does not undo completed external writes.

- **Questions.ask:** yes, a long call is sufficient. Its lifetime belongs to the asking flow/task, not whichever viewer happens to be connected. Closing a viewer alone must not cancel a tool’s question.
- **Shell:** not a browser-owned long call. Tab disconnect would cancel it or lose its reply. It needs detached, counted execution, progress/abort, and current-code outcome recording plus reliable transcript handoff. A resource can implement that, but it recreates the useful parts of jobs.
- **Env test:** a long call is enough if caller cancellation and explicit retry are acceptable, returning the result directly. Shared retained results guaranteed across reload need a job’s finish or an equivalent resource/current-code projection.
- **Login flow:** a long call can suffice for deliberately caller-scoped login. Today it survives one tab leaving while another hold of the initiating owner remains; it ends when that owner’s last Providers hold disappears. Preserve that with a flow-owned resource/controller or job, not one tab’s RPC lifetime. Questions replaces prompt plumbing, not flow ownership.

**Keep jobs for detached run/finish work; do not turn every pending interaction into a job.**

## Verbatim final adversarial report

Status annotation: the six concrete findings are open as of this conversation. The report distinguishes them from decided architectural rules and other exercised traces. Scratch paths are provenance, not dependencies required to understand the copied text.

# Adversarial review findings

Baseline: pi-private origin/private 6559589bd66bc909cfc1d694426799a3c4cd95f6. Repository untouched. Source inspection, not execution of the unimplemented target. Four plugins: chat (6 files/3300 lines), codemode (3/155), subagents (6/1012), models (14/2381): 29 files, 6848 lines. Full essential facet sketches: /tmp/p2-adversarial-plugin-sketches.md (337 lines).

## 1. P1 — Persisted subagent policies cannot be optional merely because their facet failed

Target-design.md:446-447 allows failed optional facets past the initial barrier. Actual writes enumerate whatever ReadOnlyConversations entries exist (plugins/chat/worker.ts:529-534); the one-shot guard exists only in plugins/subagents/worker.ts:55-62. On a fresh worker, subagents setup fails, there is no previous facet to retain, but the session DB still contains one-shot conversations. Chat.send/edit/configure now have no denying entry. This is a write-policy bypass, not a claim that plugins provide filesystem isolation.

Same-environment cwd relocation is also affected: runtime/worker.ts:488-498 treats missing SessionCwdFollowers as no followers, and :518-525 moves only the root plus returned followers. Persisted ordinary children remain at their old cwd. Server sidebar metadata does not repair that operation.

Fix: once corresponding persisted state exists, make its write/cwd policy an authoritative required capability before resume and relocation, or move the durable policy invariant into the host. Missing policy must fail closed. A UI notice about an absent extension is insufficient. Keeping old facets solves normal reload failure, not fresh-start failure.

## 2. P1 — Codemode's tracker must depend on its sandbox

plugins/codemode/worker.ts:22-33 declares sandbox and calls resources, but calls depends only on harness/worker, not sandbox. Under target-design.md:354-367, bumping only sandbox's native version closes/reopens it without closing calls. Durable explicitly treats that external sandbox abort as undecided and waits for its own call cancellation (packages/durable/src/codemode/codemode.ts:476-485). The tracker never runs abortTask; the script stays running indefinitely.

Fix: calls.deps must include sandbox, or use a composite native whose close aborts/settles calls before closing the VM. Retain worker-stop versus plugin-removal semantics. This is a concrete missing dependency in the migration, not a request to revoke borrowed natives or introduce generic draining.

## 3. P1 — Scope-exit protection omits the new Chord jobs and their deliveries

plugin-loading.md:420-424 records Durable extensions/tasks/tools/entries and refuses or aborts live Durable tasks before removing their definitions. Target-design.md:288 makes Chord jobs activity, but that does not give them exit provenance. Chat's shell is detached work today (plugins/chat/worker.ts:343-350), and becomes a Chord job.

Trace: remove a batch containing chat and its factory dependents while a user shell is active. There need be zero Durable tasks and no outside factory holder. The documented preflight passes, the conversation type ends (target-design.md:451-452), and the current finish/delivery code disappears. The native command is cancelled or finishes against an ended owner; its receipt/outbox cannot be delivered by the absent plugin. This violates the scope-exit's explicit 'Stop first or abort while definitions remain' policy.

Fix: include Chord running/unsettled jobs and registered pending delivery work in the existing exit check, with admissions fenced through publish. Refuse or explicitly abort-and-settle before withdrawal. Normal compatible reload still neither drains nor cancels running work.

## 4. P2 — Chat's kept Durable watch cannot be restarted with its routine

plugins/chat/worker.ts:158-168 keeps a WatchHandle resource. runtime/durable.ts:107-120 explicitly relies on keeping its subscription across reload; unsubscribe permanently stops it. Target-design.md:315-320 now stops/restarts routines even when a native's version is unchanged.

Trace: routine cleanup calls watch.stop(); resource is retained; the replacement routine calls start() on that same watch. packages/durable/src/session/observation.ts:193-203 throws 'already started'/'stopped'. Transcript/model updates stop after the first compatible reload.

Fix: open a fresh Durable watch per routine instance, maintaining a stable host/base source bridge and last snapshot; alternatively add a genuine reusable watch adapter. Do not put the plugin's callback permanently inside a kept resource. Preserve exact ops/window structural sharing; do not turn the full transcript into a rewritten document.

## 5. P2 — Moving only Models' watcher leaves old provider code installed

plugins/models/resources.ts:80-85 keeps a plugin-defined proxy; :142-148 skips unchanged fingerprints; :189-208 builds and saves an SDK model generation only when files change. provider-config.ts:263-299,330-362 installs plugin closures in provider auth/stream methods and models.getAuth.

Trace: move watching to a restarted routine but retain the native SDK Models value and fingerprints. Reload an auth/header/stream composition fix without changing models.json. The new routine skips composition, so subsequent requests still execute G1 provider callbacks and keep G1 reachable. Registry replacement and restarting subscriptions do not replace functions stored inside the SDK object. This differs from the already-decided borrowed-native issue: it occurs on a compatible native reload with no borrowed old handle.

Fix: retain validated config as data, construct a fresh facade in each setup and force SDK callback composition once per code generation even when fingerprints match. Atomically replace the current SDK generation for new invocations; already-running requests may retain their own old generation. Keep the existing invocation-time binding that prevents auth waits from switching provider implementations.

## 6. P2 — Old web send continuations can erase a new facet's draft

plugins/web-shell/web.tsx:34-38 keeps ComposerState above the replaced main slot. src/web/composer-state.tsx:39-49 owns app-scoped setters. plugins/chat/web.tsx:591-606 unconditionally clears draft/files/reply after awaiting send.

Trace: send A is already admitted; replace chat.web's main component in place; the unchanged web-shell keeps ComposerState; type B in the replacement component; the allowed old A continuation completes and clears B through the shared provider. Unmounting the old component does not invalidate provider-owned setters. Even a cancelled old continuation can overwrite the new component's error/pending UI.

Fix: acknowledgements compare the captured conversation/request/draft revision, remove only that attempt's attachments, and release only its pending operation. Suppress obsolete error updates. Existing TUI code already guards draft and attachment clearing this way (plugins/chat/tui.ts:633-641). Preserve request IDs; do not retry an admitted send merely because its component was replaced.

## Other exercised traces, not additional findings

- Reporter deliver waits for a child, then accesses the plugin registry in the same old phase (subagents/tools.ts:136-153). After a registry migration that stale access intentionally faults; scheduler.ts:1360 processes failure before handover at :1366. Parent notification is lost, although the child's answer remains in its transcript. The migration needs a separate settlement checkpoint before versioned registry edits. This is an application phase-layout change, not a reason to undo stale protection. Introduce that layout while the registry schema remains compatible with already-running v1 reporters.
- Mixed facet versions are intentional. Example: models.worker setup fails and keeps G1, codemode.worker publishes G2. Compatible WorkerModels contracts continue; a G2-only contract fails that dependent clearly. Do not roll back unrelated facets. A rejected install report is still an install-attempt report for the reconnect routing gate; do not wait for an impossible complete-revision success.
- Shell admission must atomically combine deduplication and concurrency. Store outcome before transcript delivery; crash between Durable submission and outbox acknowledgement retries the same requestId. Crash before a receipt is deliberately lost/unknown and never blindly reruns an arbitrary command. A finishing/blocked job and pending deliveries remain activity. Already-discussed shell example problems are not counted again as findings.
- Two tabs with the same principal are two origin clients; auxiliary subscriptions are not extra viewers; a lingering hold keeps the worker alive but is excluded from Questions' live audience. Use origin IDs and the per-hold linger information rather than refs.length.
- Performance: retain whole-view source pointer/ops locally, bounded structurally-shared window remotely, paged history and bounded/throttled shell output. No token-by-token Chord JSON snapshot/clone. Models' initial file load must finish before resume; subsequent watching is routine work.

## Cost and verdict

Planning estimate, not measured patch size:

| Plugin | Existing files changed | Lines materially touched |
| --- | ---: | ---: |
| chat | 5 | 550-850 |
| codemode | 3 | 100-180 |
| subagents | 6 | 300-450 |
| models | 8-10 | 600-900 |
| Selected plugins total | 22-24 | 1550-2380 |

Allow another 6-10 p2 adapter/consumer files and 400-800 lines for host values, watch/source bridging, admission/exit checks, login's replacement for ModelConfig.resources, sessions' authoritative ChildStore reads, and consumer backoff. This excludes implementing Chord store/jobs/routines/wire, Loader D/SDK and their tests. The target's 600-900-line estimate is expressly documents-only; it is not a complete four-plugin migration estimate.

Verdict: the core design holds. The missing persisted-policy and Chord-exit integration need explicit fixes; the rest needs nontrivial plugin migration, not another generic reload protocol. Do not present the migration as renaming cells/carriers and moving timers.

## Verbatim essential migration sketches and recommendations

Status annotation: proposed, uncompiled migration sketches, not implemented APIs or a functionality map. Helper names and new p2 adapter/registry names are proposals. The owner-decided mechanisms and the window-limit correction are recorded above.

# Essential migration sketches

Baseline: pi-private origin/private 6559589bd66bc909cfc1d694426799a3c4cd95f6.
Read-only review; these are sketches, not compilable patches. Names such as `bindReadableResource`, `watchConversation`, `loadAndCompose`, and `withCurrentWorker` below are proposed p2-local adapters, not additional Chord APIs. Existing parsing, rendering and validation helpers are retained. The cited revision spells standing work `self.routines`; a rename to `self.run` is mechanical.

## Chat

Keep transcript state in Durable. Do not copy the full ConversationView into a Chord document on each token. Preserve the existing 64-entry remote window, paged history, structural sharing, OutputBuffer and Progress throttling. The shared local conversation object, not each principal-specific remote facade, owns the shell job and persistent outbox. Give that object's type a stable storeKey. All authors still come from the stamped principal, never message text.

```ts
// contract.ts: object identity includes session + conversation, not author/access/generation.
const ShellJob = defineJob("p2.chat.shell", {
  version: 1, args: ShellArgs, progress: ShellProgress, result: ShellResult,
  concurrency: 1, persist: true,
});
const PendingShells = defineState("shell-deliveries", {
  version: 1, schema: PendingShellsSchema, initial: () => ({ items: {} }), persist: true,
});

// worker.ts: shared local Conversation facade, storeKey declared on its type.
host.serve(Conversation, ({ session, conversation }, _principal, self) => {
  const harness = host.value(HarnessKey);
  const environments = host.value(EnvironmentsKey);
  const liveness = host.value(LivenessKey);
  const pending = self.state(PendingShells);

  // Native container/cache only. Its source adapter rebinds if the resource changes.
  const bridge = self.resource("view", {
    version: 1, open: () => makeAtomicViewBridge(null), close: (b) => b.close(),
  });
  self.routines.loop("watch", async (ctx) => {
    // A new Durable WatchHandle for each routine instance, never start an old handle twice.
    const current = await harness.conversation(conversation, durableContext(ctx));
    if (!current) throw new Error("Unknown conversation");
    const watch = await current.watch(durableContext(ctx));
    try {
      bridge.value.publish(watch.value);
      watch.start(async (view, ops) => bridge.value.publish(view, ops));
      await waitUntilCancelledOrWatchEnds(watch, ctx);
    } finally {
      await watch.stop();
    }
  });
  const wholeView = bindReadableResource(bridge);
  const window = self.derive([wholeView], windowViewWithRetainedParts);

  const shells = self.job(ShellJob, {
    run: async (args, ctx) => {
      // Existing bounded output/attachment implementation; return actual native settlement.
      // No transcript submission and no synthetic "cancelled = signal.aborted" here.
      return executeShell(environments, args, ctx);
    },
    finish: async (done, tx) => {
      const q = await tx.draft(pending);
      q.items[done.id] = shellDelivery(done); // JSON result/error, original author, stable requestId.
    },
  });

  self.routines.on(pending, async (queue, ctx) => {
    // Count pending deliveries as work until acknowledgement, not just while this handler runs.
    await liveness.call(async () => {
      for (const [id, delivery] of Object.entries(queue.items)) {
        const current = await harness.conversation(conversation, durableContext(ctx));
        if (!current) throw new Error("Unknown conversation");
        await current.submit(delivery.input, durableContext(ctx)); // requestId = shell:<job UUID>.
        await self.tx(ctx, async (tx) => {
          delete (await tx.draft(pending)).items[id];
        });
      }
    });
  });

  // Reconcile authoritative Durable agent configuration to sidebar/session metadata.
  // Do not leave that update solely after a native configure await in a caller's old generation.
  self.routines.on(agentConfigurationOf(wholeView), reconcileConversationMetadata);
  return {
    view: wholeView, window, liveShell: shells.running,
    runShell: (args, ctx) => shells.start(args, ctx, { key: `${args.author.id}:${args.requestId}` }),
    abortShell: ({ shellId }) => shells.abort(shellId),
    ...existingConversationMethods(harness, conversation),
  };
}, { linger: 30_000 });

host.serve(Chat, (input, principal, self) => {
  authorizeSessionRead(input, principal);
  const conversation = self.get(Conversation, input);
  if (!canSend(principal, input.session)) return viewer(conversation);
  return participant(conversation, {
    // Check authoritative persistent one-shot/write policy; absence of a registry is not permission.
    beforeWrite: (ctx) => requireWritableConversation(input, ctx),
    author: authorOf(principal),
    gates: (ctx) => host.registry(InputGates).table(ctx),
  });
});

// web.tsx: same components, history retention and restored-draft claims.
export default defineFacet((_host, self) => self.register(Slots, "main", Main));
async function send() {
  const attempt = composer.beginAttempt({ conversation: identity, text: draft, files, replyTo });
  try {
    await chat.send(await uploadAndExpand(attempt));
    composer.acknowledge(attempt); // compare identity + requestId + current draft/files; never clear newer edits.
  } catch (error) {
    composer.failIfCurrent(attempt, error);
  } finally {
    composer.endIfCurrent(attempt);
  }
}

// tui.ts / tui-commands.ts: register the existing surface/commands directly in the facet.
export default defineFacet((_host, self) => {
  self.register(TuiSlots, ChatSurfaceKey, (runtime) => new ChatSurface(runtime));
  for (const [name, command] of Object.entries(CHAT_COMMANDS)) self.register(TuiCommands, name, command);
});
```

No server facet. Drafts stay persisted by conversation + author, claim before acknowledgement, and are not keyed by the current viewer's principal access path. Retain Stop/withdraw/dequeue/edit/restore/compact/history semantics. Count active origin clients, not internal view subscriptions, for presence. A lingering client keeps its worker alive without being an audience member. Pending shell deliveries also need liveness while their routine is restarting/backing off: the implementation should register a count over the queue, rather than rely solely on the illustrative `liveness.call` above.

## Codemode

No server, web or TUI facet. Retain existing generic tool-card rendering. This remains a Durable extension, not a Chord job: scripts replay their journal after worker crashes.

```ts
export default defineFacet((host, self) => {
  const harness = host.value(HarnessKey);
  const liveness = host.value(LivenessKey);
  const settings = self.get(WorkerModels, {});
  const sandbox = self.resource("sandbox", {
    version: 1,
    open: () => new CodemodeSandbox({ memoryLimitBytes: CODEMODE_MEMORY_LIMIT_BYTES }),
    close: (value) => value.close(),
  });
  const calls = self.resource("calls", {
    version: 1,
    deps: [sandbox], // essential: cancel/settle calls before replacing their sandbox.
    open: () => new Map<TaskId, ToolExecutionApi>(),
    close: async (active) => {
      if (liveness.stopping) return; // worker shutdown: Durable replays in the next worker.
      await Promise.all([...active.values()].map(async (api) => {
        api.output(`${REMOVED_MESSAGE}\n`);
        await waitForRemovalOutputOrDeadline(harness, api, 2000);
        await harness.abortTask(api.taskId, BACKGROUND_CONTEXT);
        await harness.waitForTask(api.taskId, BACKGROUND_CONTEXT);
      }));
    },
  });
  const extension = createCodemodeExtension({ get sandbox() { return sandbox.value; } });
  const enabled = self.derive([settings.settings], (s) => s.codemode !== false);
  self.register(ExtensionSwitches, extension.name, enabled);
  self.register(Extensions, extension.name, {
    ...extension,
    tools: extension.tools.map((tool) => ({
      ...tool,
      execute: async (args, api, context) => {
        calls.value.set(api.taskId, api);
        try { return await tool.execute(args, api, context); }
        finally { calls.value.delete(api.taskId); }
      },
    })),
  });
});
```

The tracker is a data container; its behavior is fresh code. A compatible reload keeps the VM and calls. For a close-and-reopen replacement the calls dependent closes first, settles through Durable, then the sandbox closes. Do not treat a sandbox's spontaneous end as a completed Durable call. Preserve the removal output even if the output polling fails; production code retains the existing try/catch before mandatory abort. Removal policy should refuse while live tasks exist unless the owner chooses abort; this cleanup is also needed for a native version bump that does not remove the plugin.

## Subagents

The registry, anchors, reporter tasks, one-shot ownership, reported-answer IDs and inherited configuration remain transcript state in Durable. Only server sidebar metadata moves to Chord documents.

```ts
const ChildRows = defineState("children-by-session", {
  version: 1, keyed: true, persist: true,
  schema: ChildRowSchema, initial: () => ({ generation: 0, children: [] }),
});
const ChildrenIndex = defineState("children-index", {
  version: 1, schema: ChildrenSchema, initial: () => ({}), // volatile live aggregate.
});

// server.ts: stable host-lifetime local ChildStore.
host.serve(ChildStore, (_input, _principal, self) => {
  const hosts = host.value(SessionHostsKey);
  const catalog = self.get(Catalog, {});
  const rows = self.state(ChildRows);
  const children = self.state(ChildrenIndex);
  const ids = self.derive([catalog.sessions], (list) => list.map((s) => s.id).sort());
  self.routines.on(ids, async (liveIds, ctx) => {
    const recovered = new Map(await Promise.all(liveIds.map(async (id) => [id, await rows.get(id)])));
    await self.tx(ctx, async (tx) => {
      const index = await tx.draft(children);
      for (const id of Object.keys(index)) if (!liveIds.includes(id)) delete index[id];
      // A concurrent report already wrote the index: do not overwrite it with an older bootstrap read.
      for (const id of liveIds) if (!(id in index) && recovered.get(id))
        index[id] = recovered.get(id).children;
    });
  });
  return {
    children, // UI cache, never authority for relocation or writes.
    get: ({ session }) => rows.get(session), // await this when deciding relocation.
    report: (report, ctx) => withCurrentWorker(hosts, report, ctx, () => self.tx(ctx, async (tx) => {
      // Adapter holds the per-session worker lifecycle gate through this short transaction;
      // merely sampling hosts.workers before an await would weaken today's generation fence.
      const row = await tx.draft(rows, report.session, { tags: [SessionTag(report.session)] });
      row.generation = report.generation;
      row.children = report.children;
      (await tx.draft(children))[report.session] = report.children;
    })),
  };
}, { lifetime: "host" });
// The existing remote Subagents facade still stamps session/generation from its worker principal;
// owner sees all children, guest only its session. Never accept a caller-supplied worker identity.

// worker.ts: declarations on the facet object, no contribute carrier.
export default defineFacet((host, self) => {
  const harness = host.value(HarnessKey);
  // Facet factories cannot self.get remote types; obtain this ref in the routine context.
  const config = host.registry(HarnessConfig);
  self.register(Extensions, "subagent-tools", createSubagentExtension({
    models: modelsForCurrentRequest(config),
  }));
  self.register(ReadOnlyConversations, "one-shot-agents", readOnlyFromDurableRegistry(harness));
  self.register(RelocationChecks, "own-cwd", ownCwdCheckFromDurableRegistry);
  // Cwd followers move to the typed host-side registry/capability, not an opaque native export.
  self.register(SessionCwdFollowerProviders, "subagents", subagentCwdFollowers);
  self.routines.loop("report", async (ctx) => {
    const feed = await ctx.get(Subagents, {});
    await reportChildrenFromFreshCommitSubscription(harness, feed, ctx);
  });
  host.serve(SubagentControl, participantArchiveFacade(harness));
});

// tools.ts: retain Durable tasks. Split the effect/settlement from versioned registry edits.
const Reporter = defineTask({
  name: "p2.subagent-reporter", version: 2, migrate: migrateReporterV1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, context) => {
      const settled = await submitAndWaitWithExistingRequestId(task, runtime, context);
      const result = await readImmutableAnswer(settled, runtime, context);
      // No access to the plugin's migratable registry in this commit.
      await runtime.commit(() => ({ status: "running", checkpoint: { phase: "record", ...result } }), context);
    },
    record: (task, runtime, context) => runtime.commit(async (tx) => {
      const registry = await tx.doc(SubagentsDoc, runtime.conversationId);
      return deduplicateAnswerAndCheckpointReport(registry, task.state.checkpoint);
    }, context),
    report: submitToParentWithStableReporterRequestIdAndFinish,
  },
  abort: terminalAborted,
});

// web.tsx:
export default defineFacet((_host, self) =>
  self.register(ToolRenderers, "subagent", SubagentRenderer));
// tui.ts:
export default defineFacet((_host, self) => {
  self.register(TuiToolRenderers, "subagent", subagentRenderers);
  self.register(TuiSessionSources, "subagents", sessionSource);
  for (const [name, command] of Object.entries(AGENT_COMMANDS)) self.register(TuiCommands, name, command);
});
```

`SessionCwdFollowerProviders` is a proposed typed p2 registry replacing the existing opaque SessionCwdFollowers member; it must be present and checked before resume and relocation. Existing persisted one-shot/managed-cwd state makes the corresponding policy contributor required, even if this facet failed at first load. Metadata is never the authority for write permission. Archive still stops work before editing the Durable registry, refuses one-shot agents and keeps archived own-cwd agents relevant to relocation. The Reporter phase split is migration work: the deliberate stale-document failure otherwise terminally faults an old deliver phase after its child already answered. It does not justify changing the stale rule. Deploy this phase split without simultaneously changing the registry schema for already-running v1 reporters; they cannot be retroactively repaired.

## Models

There is no models web facet in this revision; chat imports the shared ModelPicker web UI. Keep that UI and its owner-only model access. The existing models TUI service and commands remain, using a typed surface key instead of a cross-generation instanceof test.

```ts
// Native pod contains file handles, validated JSON, immutable current SDK model generation,
// counters and a host/base-defined observable. No Resources instance, plugin Proxy trap,
// ReloadObserver callback or plugin-defined class instance is retained across code reloads.
function declareModelResources(host, self) {
  const pod = self.resource("files", {
    version: 1,
    open: ({ signal }) => openInitializedNativeModelPod(host.value(ModelResourceOptionsKey), signal),
    close: (p) => closeFilesAfterTrackedWrites(p),
  });
  self.routines.loop("config", async (ctx) => {
    // Force fresh composition once for EVERY code generation, even when fingerprints match.
    await loadAndCompose(pod, ctx, { forceCodeRefresh: true });
    const observer = watchModelFiles(host.value(ModelResourceOptionsKey));
    try {
      while (!ctx.signal.aborted) {
        await observer.next(ctx.signal);
        await loadAndCompose(pod, ctx, { forceCodeRefresh: false });
      }
    } finally { await observer.close(); }
  });
  return pod;
}

// server.ts:
export default defineFacet((host, self) => {
  const pod = declareModelResources(host, self);
  const config = bindReadableResource(pod); // one atomic snapshot; source rebinding is explicit.
  host.serve(ModelConfig, (_input, _principal, object) => ({
    summary: object.derive([config], summarize),
    snapshot: object.derive([config], publicResourceSnapshot),
    setDefault: (choice, ctx) => saveValidatedDefault(pod, choice, ctx),
    setEnabledModels: ({ patterns }, ctx) => saveEnabledPatterns(pod, patterns, ctx),
    // Login must use methods on this owner; no Resources native exported to login.
    ...modelAuthenticationMethods(pod),
  }));
  host.serve(Models, (_input, principal, object) => {
    requireOwner(principal);
    const local = object.get(ModelConfig, {});
    return existingOwnerModelsFacade(object, local);
  });
});

// worker.ts:
export default defineFacet((host, self) => {
  const pod = declareModelResources(host, self);
  const config = bindReadableResource(pod);
  // A new proxy/facade in each setup; invocation lookup binds an immutable SDK generation.
  // Never switch getAuth/stream implementations halfway through a waiting request.
  const models = currentModelsFacade(pod);
  self.register(HarnessConfig, "default", {
    models: () => models,
    settings: () => toHarnessSettings(pod.value.validatedSettings),
  });
  host.serve(WorkerModels, (_input, _principal, object) => ({
    settings: object.derive([config], (value) => value.settings),
  }), { lifetime: "host" });
});

// tui.ts:
export default defineFacet((_host, self) => {
  self.register(TuiSlots, ModelStateKey, (runtime) => new ModelState(runtime));
  for (const [name, command] of Object.entries(MODEL_COMMANDS)) self.register(TuiCommands, name, command);
});
const stateOf = (ctx) => ctx.surface(ModelStateKey); // typed SDK token, not instanceof.
```

Move the initial model/config load into the host's required-start readiness, not merely a background loop that races resume(). Later failed files retain last-good validated config and publish bounded errors. Keep credentials private and file-backed, atomic file writes, in-flight-write tracking, fake mode, cached catalogs and no-network restoration. Force recompilation must also work with a currently invalid file by retaining last-valid parsed JSON as data. Preserve generation binding at invocation lookup. Do not retain plugin callbacks in a mutable SDK object just because the surrounding resource's data shape did not change.

Cross-plugin consumers outside the four also change: notably login/server.ts and sessions/server.ts consume ModelConfig, and login currently reaches straight into config.resources. Sessions must also await authoritative ChildStore.get(session), rather than use the bootstrapped UI children map for relocation checks. That native export cannot simply disappear without replacing those operations with the typed methods shown above.

## Verbatim historical reproduction source

Status annotation: obsolete drain-prototype test API; execution outcomes are not retained. Current applicability and superseded expectations are classified above. Do not adopt these assertions as current target requirements.

```ts
import assert from 'node:assert/strict';
import { Type } from 'typebox';
import { it } from 'vitest';
import { createHost, local, method, type Self, type Facet, type EffectApi, defineRegistry, type Ctx } from '/home/badlogic/chord-handover/packages/chord/src/old/index.ts';
const tick = () => new Promise<void>(r=>setImmediate(r));
const sleep = (ms:number) => new Promise<void>(r=>setTimeout(r,ms));
function latch(){let open=()=>{};const promise=new Promise<void>(r=>open=r);return {open,promise};}
const Probe = local('review.probe', {version:1,input:Type.Object({}),members:{call:method(Type.String(),Type.Unknown())}});
function gen(build:(self:Self)=>(arg:string)=>unknown):Facet{return {name:'p',setup(api){api.serve(Probe,(_i,_p,self)=>({call:build(self)}));}};}

it('a second reload must not start an effect before the first cleanup settled', async()=>{
 const done=latch();const started:number[]=[];const errors:unknown[]=[];
 const host=createHost({self:{kind:'host'},onError:e=>errors.push(e)});
 const version=(v:number)=>gen(self=>{self.effect('e',()=>{started.push(v);return v===1?()=>done.promise:()=>{};});return ()=>v;});
 try {
  await host.install(version(1));await host.get(Probe,{});
  const first=await host.reload([version(2)],{drainDeadline:5,stallGrace:5});
  assert.equal(first.status,'installed_pending');
  const second=await host.reload([version(3)],{drainDeadline:5,stallGrace:5});
  assert.deepEqual(started,[1], `second report ${second.status}, stalled=${host.status()[0]?.stalled}`);
 } finally {done.open();await tick();await host.close();}
});

it('queued raw run closures admitted before publication retain resource ownership',async()=>{
 const go=latch(); const closed:number[]=[];const seen:number[]=[];const errors:unknown[]=[];let emit:EffectApi['run']=()=>{};let queuedUse=()=>{};
 const host=createHost({self:{kind:'host'},onError:e=>errors.push(e)});
 const version=(v:number)=>gen(self=>{const conn=self.resource('conn',{version:v,open:()=>v,close:x=>{closed.push(x)}});
   self.effect('e',({run})=>{if(v===1){emit=run;queuedUse=()=>seen.push(conn.value);}});return ()=>conn.value;});
 try{
  await host.install(version(1));await host.get(Probe,{});
  emit(async()=>{await go.promise;seen.push(1);});
  emit(queuedUse);
  await tick();await host.reload([version(2)]);go.open();
  for(let i=0;i<8;i++)await tick();
  assert.deepEqual(seen,[1,1], String(errors));
 }finally{go.open();await host.close();}
});

it('an activation blocked in old open must not prevent publishing new code',async()=>{
 const go=latch();let published=false;const host=createHost({self:{kind:'host'},onError:()=>{}});
 const old=gen(self=>{self.resource('r',{version:1,open:async()=>{await go.promise;return 1;}});return ()=>1;});
 try{
  await host.install(old);const ref=host.hold(Probe,{});await tick();
  const reload=host.reload([gen(()=>()=>2)],{onPublished:()=>{published=true}});
  await sleep(30);const before=published;
  go.open();await reload;await ref.ready;
  assert.equal(before,true,'old activation blocks publication');
 }finally{go.open();await host.close();}
});

it('retry does not rerun an added cell init that already succeeded',async()=>{
 const host=createHost({self:{kind:'host'},onError:()=>{}});let addedInits=0;
 const version=(v:number,broken:boolean)=>gen(self=>{
  self.state('existing',Type.Number(), v===1?1:{init:()=>{if(broken)throw Error('broken');return 2;}},{version:v});
  if(v===2)self.state('added',Type.Number(),{init:()=>{addedInits++;return 3;}});
  return ()=>v;
 });
 try{
  await host.install(version(1,false));await host.get(Probe,{});
  assert.equal((await host.reload([version(2,true)])).status,'installed_failed');
  assert.equal(addedInits,1);
  assert.equal((await host.reload([version(2,false)])).status,'installed');
  assert.equal(addedInits,1);
 }finally{await host.close();}
});


it('a changed surviving consumer must still prohibit removal of its provider',async()=>{
 const Other=local('review.consumer',{version:1,input:Type.Object({}),members:{call:method(Type.String(),Type.Unknown())}});
 const host=createHost({self:{kind:'host'},onError:()=>{}});
 const consumer=():Facet=>({name:'c',setup(api){api.serve(Other,(_i,_p,self)=>{const ref=self.get(Probe,{});return {call:(arg,ctx)=>ref.call(arg,ctx)};});}});
 try{
  await host.install(gen(()=>()=>1));await host.install(consumer());const ref=await host.get(Other,{});
  await assert.rejects(host.reload([consumer()],{remove:['p']}));
  assert.equal(await ref.call('read'),1);
 }finally{await host.close();}
});

it('registry handlers own resources while they run and delay an exclusive handover',async()=>{
 const Routes=defineRegistry<(ctx:Ctx)=>Promise<number>>('review.routes');
 const go=latch();const closed:number[]=[];const host=createHost({self:{kind:'host'},onError:()=>{}});
 const version=(v:number):Facet=>({name:'p',setup(api){api.serve(Probe,(_i,_p,self)=>{
  const conn=self.resource('port',{version:v,mode:'exclusive',open:()=>v,close:x=>{closed.push(x)}});
  self.register(Routes,{route:async()=>{await go.promise;return conn.value;}});return {call:()=>v};
 },{lifetime:'host'});}});
 try{
  await host.install(version(1));const route=host.registry(Routes).get('route')!;
  const pending=host.root(ctx=>route(ctx));pending.catch(()=>{});await tick();
  const reload=host.reload([version(2)]);await tick();
  const closedDuringHandler=[...closed];go.open();await Promise.allSettled([pending,reload]);
  assert.deepEqual(closedDuringHandler,[], 'old registry handler is still using port 1');
  assert.equal(await pending,1);
 }finally{go.open();await host.close();}
});

it('a new host lifetime object with a failing open is prepared before publication',async()=>{
 const host=createHost({self:{kind:'host'},onError:()=>{}});let published=false;
 const added:Facet={name:'p',setup(api){api.serve(Probe,(_i,_p,self)=>{
  self.resource('broken',{version:1,open:()=>{throw Error('broken')}});return {call:()=>1};
 },{lifetime:'host'});}};
 try{
  await assert.rejects(host.reload([added],{onPublished:()=>{published=true}}));
  assert.equal(published,false);
 }finally{await host.close();}
});

```
