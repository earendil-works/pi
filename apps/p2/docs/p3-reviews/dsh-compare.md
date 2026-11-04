# dsh-compare — DeepSeek Harness comparison research subagent

## Status and scope

This archives the findings, review points, open questions and recommendations produced earlier in this conversation. It is not a new owner-approved design. The report below is preserved verbatim where possible; supplementary observations from the research commentary follow it. Evidence paths refer to `/home/badlogic/research/deepseek-harness` at `d743267388641bc76f17c45ce8b4c231aed1d32c` unless otherwise stated. Chord comparisons refer to `origin/private:apps/p2/docs/target-design.md`, `plugin-loading.md` and `questions.md` as consulted during the research.

**Owner-decided requirements known from the supplied target design:** in-place plugin reload on every host without restarting it; remote objects with principals; plugins working across p2 versions; running calls and jobs finish with old code rather than being drained by reload; same-version resources kept; resource replacement/handover rather than an object restart; immutable pinned registry tables; no cross-host transaction; base/runtime code changes restart affected hosts. The target explicitly rejects drain-based handover, object restart for state changes, late-bound registry entries and `restart_required`. The owner's assessment supplied in the task was that objects plus references have no issues or footguns, whereas the other concepts—especially natives—do.

**Still open / recommendations only:** every proposal below to remove `self.resource`, move natives into base supervisors, restart native-owning objects, make host installation all-or-nothing, or change Questions semantics. No owner acceptance of those proposals occurred in this conversation. Some intentionally conflict with the recorded target and would require a new owner decision. No later p3 decisions are known to this subagent.

## Original report

**DeepSeek Harness (DSH) vs Chord: natives, reload, state**

Read-only research; I made no edits. DSH checkout HEAD is `d743267` (2026-10-09). DSH's `native/` directory holds native addons (Landlock, flock) and is unrelated to "natives" in our sense.

### 1. Natives and their lifecycle

DSH runs on Cordis, a plugin framework. In Cordis everything a plugin does is an *effect* inside a *fiber* (one running plugin instance). When the fiber is disposed, its effects are undone in reverse order and awaited until they have actually stopped (docs/cordis-primer.md:13, docs/defensive-patterns.md:19).

Natives follow one pattern throughout DSH, though it is a convention and nothing enforces it:

- **A few long-lived services own the natives:** processes in `ctx.subprocess`, PTYs in `ctx.terminals`, background work in `ctx.jobs`, plus LSP and MCP connections and session persistence. Ordinary plugins such as tools hold opaque branded ids and call methods. "The service owns process coordinates and lifetime; consumers own what a process means" (packages/subprocess/subprocess/README.md:98).
- **A native's lifetime belongs to its owner, not to the code that created it.** Spawning takes the exact owning `Agent`. The service then attaches its cleanup to that agent's scope: `owner.ctx.effect(...)` in packages/terminal/terminal/src/index.ts:322-332 and packages/jobs/jobs-local/src/index.ts:610-627. "Registrations outlive producer and controller fibers" (packages/jobs/jobs/README.md:73).
- **Access is fenced by the owner.** Another agent gets `FOREIGN_SESSION` (packages/terminal/terminal/README.md:52-56).
- **Reconnecting lives inside the owner.** The MCP client has a connection supervisor that keeps numbered client generations, retries with backoff and rebuilds its registrations; consumers only see tools come and go (packages/mcp/mcp-client/README.md:93, :118, :129).
- **Execution world:** the filesystem and subprocess services are swapped together for remote providers. Handles expose no path or pid (.agents/notes/implemented/architecture/2026-09-11-subprocess-control-pipe.md:21).

**The generalization we lack:** natives are never values in plugin code. They live in owner services, are reached by id, and each one is bound to an owner identity. A native's lifetime is the shorter of the owning service's fiber and the owner's scope. A consumer reload keeps natives, because the owner's code did not change (subprocess README:113). A reload of the owning service kills them.

### 2. What DSH constrains that we allow

- **No native survives a code change of its owner.** There is no `replace`, no resource version and no handover.
- **Dependents always restart.** A fiber's activation epoch is the list of its providers' fiber uids (vendor/cordis/src/fiber.ts:611-622). A provider reload changes that list, so every consumer is torn down and set up again (fiber.ts:625-640). Their own note calls it "correct, if heavy" (2026-07-23-client-plugin-loading-model.md:95).
- **No in-memory state survives a reload.** The fiber is fresh, and so is React state (same note, :97). State that must last goes into the session event log or the storage domains.
- **No mixed versions.** A reload batch is all-or-nothing: if activation fails, the old modules and plugins are restored (packages/boot/hmr/src/index.ts:678-720).
- **One Node host process,** plus browser clients that call `@Remote` methods. Ids are resolved to host objects (`agentId` → `Agent`) by lookups (docs/api-gateway.md:11). There are no remote objects and no principals beyond the owner fence.
- **`restart-required` exists:** package version changes and bootstrap modules need a restart (packages/boot/plugin-manager/README.md:52, :140).

What this buys them: none of our replace ordering, `deps` handover, stale handles, "read `.value` at use", derive rebinding or rollout coverage. Those cases simply never happen.

### 3. Code changes and reload

DSH does reload in place (Cordis HMR on the host, a `client-hmr` plugin in the browser). It does not swap code under live state. A reload means:

1. Dispose the plugin's fibers and wait for them to settle (hmr/src/index.ts:686-687).
2. Plug in the new module with the same config, which cascades to every dependent.
3. On failure, roll back.

The costs are accepted openly:

- Reloading the agent-loop provider "stops and drains every live handle it made" (packages/core/agent/README.md:117). Sessions are later resumed from the log, with interrupted turns closed.
- Reloading the persistence backend makes writes "fail loudly until the sessions restart" (2026-08-27-handle-based-session-persistence.md:35).
- Reloading the terminal service closes every terminal (terminal README:81).
- Running job and tool closures keep their old code until they settle. This is the same as our jobs.

### 4. State, persistence, background work, prompts

- **State:**
  - The append-only session log is the only durable truth; projections are derived from it (docs/architecture.md:118-126).
  - Non-session data lives in versioned storage domains (packages/storage/README.md:12).
  - Format changes are adjacent migrations that never overwrite a committed generation.
- **Background work:**
  - Jobs are in-process and "die with the harness process" (jobs README:55). The README admits the contract cannot go cross-process (:126).
  - Schedules are durable records. After downtime only the latest due occurrence is delivered (docs/subsystems/schedule.md:146).
- **Automatic work does not resume by itself.** Goal "activation" is kept out of replay, so resume or fork needs a human action first (docs/glossary.md:27).
- **Questions and approvals:**
  - While the tool call is open, the call itself is the question. After the call returned or the process died, the question is "continued" and an answer comes in as a new message (packages/interaction/user-questions/README.md:35).
  - No pending promise needs to survive anything.
  - Approval fails closed: `unavailable` counts as a denial (docs/subsystems/approval.md:20).

### Comparison

| Topic | Chord target | DSH |
|---|---|---|
| Native holder | resource in any object | owner service only |
| Plugin holds | `.value` (the native) | id plus methods |
| Native owner | the object that opened it | explicit `Agent` scope |
| Code change | keep / replace / reopen | restart |
| Dependents | `deps` graph | restart (epoch) |
| Old code | kept natives, stale handles | only in-flight closures |
| Mixed versions | per facet | none (rollback) |
| Reconnect | routine | inside the supervisor |
| Pending question | resource store | open call, else a message |
| Hosts | many, rollout | one process |
| Gives up | nothing (complex) | kills live state on provider reload |

### 5. Which ideas remove which of our problems

- **Natives only in owner services; plugins hold ids.** Removes "old code inside kept natives" and "natives shared across plugins": sharing is a served type, which is already our rule. It also removes the reviewers' worry about plugin class instances holding behaviour: those are code, rebuilt on reload, not natives.
- **Explicit owner at spawn** (`spawn(spec, { owner })`). Removes "natives born in requests": a request-born native belongs to the calling object identity or to a job, never to a code generation. It also gives keep-alive a single source: the host counts live natives per owner (DSH: `hasOwnerActivity`, terminal README:85; the jobs registry reporting session activity, jobs README:83).
- **Supervisor with generations.** Removes "reconnecting natives" from plugin code; consumers read a status readable.
- **Restart instead of replace.** Removes "replace and dependents" entirely. In our world the cascade already exists: a reference ends with an error and is re-held (§6). Dependents become references, the one part the owner calls footgun-free, instead of `deps`.
- **All-or-nothing per host with rollback.** Removes "mixed versions within a host".
- **Owner services in runtime code.** If the generic supervisors (process, PTY, socket or connection, SQLite) live in the base bundle as host values, a plugin reload never touches a native, and a change to a supervisor is a host restart, as base changes already are.
- **Question = open call; after loss = input.** Removes the Questions store as a kept resource with `replace: old => old`.
- **Registry readiness:** Cordis keeps consumers pending until their injected services exist, and does a startup-only audit (2026-09-09-consumer-owned-startup-strictness.md:19). This roughly matches our start barrier; no new idea here. Their registry entries are reversible effects that go away and come back on reload, so there is a gap, which we deliberately avoided.
- **Durable phases across reloads:** DSH freezes each request and kills live agents on a core reload. Our immutable pinned registry tables are already better here; keep them.

**Ideas that don't fit p2:**

- **Cordis's in-process cascade** cannot cross hosts or principals. Our reference error plus re-hold is the remote form of the same thing.
- **Killing live agents on reload** conflicts with "live reload on every host". The fix is to keep natives out of plugins, not to accept the kill.
- **Owner fencing by `Agent` object identity** does not cross the wire. We need object identity plus principal.
- **Single process with no rollout and `restart-required`** contradicts our goals. That is exactly where their simplicity comes from.

### Proposal: a constrained model for natives

1. **Remove `self.resource` from plugin code.** A native exists only inside a supervisor: host values from the base bundle (process, PTY, socket or connection with reconnect, SQLite or plugin database, sandbox, watch). Plugins get handles: opaque ids plus methods plus a status readable.
2. **Every native has an owner** passed at creation: an object identity or a job id. It closes when the owner ends. Keep-alive and presence count natives per owner.
3. **A plugin reload never touches natives.** It reruns factories and restarts routines. Behaviour that used to sit inside resources (terminal logic, search, radius) is plain code around a handle id, so code changes need no version bump.
4. **A plugin that truly needs its own native** (rare) serves it as an object type. A code change restarts that object, and consumers re-hold through references. No `replace`, `deps`, resource versions, ordering rules or stale handles.
5. **Per-host install is all-or-nothing** with rollback; drop "facet keeps its previous version".
6. **Pending waits (Questions, logins) belong to the asking call.** A plugin reload or crash fails the call retryably, and a re-ask with the same `key` reattaches. The questions themselves are documents; resolvers are never kept.

This deletes most of §12 and part of §15, and reduces the native problem to objects plus references. The cost is a small set of supervisors in the runtime, which has to be designed well because changing it needs a restart. Any plugin native that does not fit a supervisor is restarted on reload, as DSH does.

## Additional observations and questions from the research commentary

These record material produced before the final report, including qualifications that the report compressed too aggressively. They are research observations or open design questions, not owner decisions.

### Lifecycle effects and dependency cascades

- Cordis is the framework associated with Koishi. Its shared context holds services; services are supplied by plugins. Plugins contribute services, events and reversible registrations. There is no need to import concrete implementations to find services.
- Reloading a plugin means disposing all its fibers and waiting for quiescence, then re-plugging with the same config—essentially a kill-and-restart where natives die. Required `inject` dependencies make consumers pending until providers exist. When a provider disappears or changes fiber uid, its dependents unload and reactivate.
- The epoch is just the concatenation of injected services' provider fiber uids, so when a provider reloads with a new uid, every consumer's epoch shifts and triggers a full unload-and-reload cascade through dependents—no handover or versioning needed, just a clean restart.
- Tools register themselves into `ctx.tools` as registry effects. Reloading a tool plugin removes and re-adds its registration without necessarily restarting the agent loop, since the loop injects the registry, not every individual contributing plugin. Reloading a foundational service such as sessions is a different matter.
- This distinction is important for registry readiness: dependency readiness is not the same thing as an immutable, gapless contribution table. Cordis restart semantics do not solve the pinned Durable phase problem.
- Open investigation question raised during research: does a tool plugin reload cancel an in-flight tool call, or does that call continue on its captured definition while the registry changes? The report inferred continuation for old closures; no universal tool-specific cancellation guarantee was established by the inspected README snippets.

### Ownership and code lifetime are different

- The subprocess service keeps process lifetime across consumer reloads, with natives owned by a stable service while consumers hold handles. Reloading the consumer is different from reloading that service.
- The job registry attaches its cleanup effect to the owner's (agent's) context rather than the producer's fiber—effects attach to whichever scope owns the domain, not the scope where the code runs. That's a useful generalization: lifetime belongs to the owner's scope, while the code itself belongs to the producer.
- A running job keeps executing old code from before a producer reload, since its lifetime is tied to the owning agent session or service rather than to the code fiber itself. `jobs-local` explicitly documents this and attaches cleanup via `owner.ctx.effect` (src/index.ts:610-627).
- On terminal backend reload, existing sessions keep running old backend code since they don't do versioned replacement—only a full service reload kills all sessions. That aligns with part of our own approach. `registerBackend` removes only the backend contribution; published records retain a `TerminalBackendSession` object (packages/terminal/terminal/src/index.ts:125-140, :185-197). The terminal-bash README also says the owner policy fence outlives a provider reload that retains existing sessions (:111).
- The terminal service tracks unpublished spawns as reservations, owns an abort signal for them, and waits for their rollback before disposal completes. Partial startup cleanup failures remain owner activity, rather than allowing the owner to look idle while resources may be leaking (terminal README:81-87).
- Jobs teardown cancels work and awaits settlement. A throwing cancel force-fails the record and reports a possible orphan. A cancel that returns without actually settling can stall teardown (packages/jobs/jobs-local/src/index.ts:634-687). Quiescence is a cooperative contract, not an absolute guarantee that arbitrary plugin code can be stopped.
- Job preflight requires a controller serving the owner before starting background work, so the runtime does not launch work the agent cannot later collect or stop (packages/jobs/jobs/README.md:41-43).
- The job registry reports running/stopping jobs as session activity, and session archive requests stop them. This is explicit domain activity accounting rather than generic reference reachability.

### Processes, sandboxing, IPC and connections

- Managed subprocess lifetime is stronger than direct child exit: `done` reports the direct command outcome, while `waitForExit()` waits for the provider's managed range to be quiescent. Providers use systemd scopes or Windows Jobs where available and document weaker fallbacks. Consumers own deadlines, termination ladders and cause classification (subprocess README:68-76, :98, :109-113, :151).
- Processes, persistent shells, language servers and external subagent backends share `ctx.subprocess`; shell/tool semantics stay outside that service (packages/subprocess/README.md:12, :35).
- The subprocess control-pipe pattern optionally returns a raw `Duplex` at `handle.control`. The child opens fd 7. Consumers own bounded framing, validation, backpressure and endpoint closure. The provider separately tracks endpoints after managed-range exit and closes leftovers during disposal (.agents/notes/implemented/architecture/2026-09-11-subprocess-control-pipe.md:13-21).
- That control pipe grants no host capability: the child remains untrusted and normal tool dispatch/approval still applies. Model code runtimes such as PTC use out-of-process execution, but this does not mean every plugin native lives behind IPC or in a dedicated supervisor process.
- Filesystem and subprocess providers can be replaced together to move the execution world remotely without changing Bash, PTY or LSP consumers. This is a capability-service abstraction, not Chord-style arbitrary remote objects.
- MCP reconnection is local policy inside a concrete connection supervisor: initial discovery is awaited; lost connections use exponential backoff and an attempt budget; last-known tools remain listed during an outage but calls fail; budget exhaustion removes the tools. Tool generations are refreshed after reconnection. After HTTP is connected, SDK transport recovery handles request failures rather than respawning every connection (mcp-client README:89-93, :127-129, :210).
- This suggested a supervised connection object exposing status rather than raw socket access, not a general runtime ability to preserve arbitrary native values through new code.

### Host/client and extension model

- The normal architecture is a Node host plus browser clients, not a p2-style independently reloaded server/session-worker/browser/TUI cluster. Desktop adds an Electron carrier and a private host process; Node IPC carries boot injections, readiness, fatal errors and shutdown, while Web owns RPC and streams (docs/architecture.md:49-53).
- Browser RPC uses generated `@Remote` or `@RemoteScope` methods, declared wire identities, runtime lookups and generated codecs. Complex host objects do not directly cross the wire. Stream remotes use a multiplexed WebSocket or in-process carrier; client-to-host uplink items are validated (docs/api-gateway.md:9-15, :56-60).
- Browser plugins use a separate lazy module system plus Cordis lifecycle. Host bundle changes are observed and sent through SSE. Reload gives a fresh fiber and component state. Bootstrap replacement is refused and requires a page reload; static assembly libraries and shell changes require a rebuilt page. Self-reload closes/reopens SSE and a full snapshot repairs missed graph changes (2026-07-23-client-plugin-loading-model.md:79-97).
- HMR is configuration-only by default in the base bundle (`root: []`). Source-module watching is optional. Headless, SDK and ACP disable HMR by default; without it changes apply on restart (packages/boot/hmr/README.md:27-34). Thus not every DSH profile promises live source reload.
- Installed package replacements require a process restart; source module HMR uses Node loader internals, with explicit limitations for framework dependencies, TSX loaders, ordinary application-created Workers and package-cache refresh (hmr README:92-101).
- Dynamic extensions are process-local definitions with immutable package versions. Host halves run in a `node:vm` realm; browser halves have a separate runner and approval path. Stop disposes effects but retains definitions; undefine removes them. Definitions disappear on restart and page reload requires an explicit run for the client half (packages/extensions/cordis-host-runner/README.md:12, :54-58, :76).
- That VM isolates globals but is explicitly not a security boundary; exposed services reach the live runtime and should be treated like bash access (same README:62). Persistent plugin installation is handled through Plugin Manager instead of a model tool creating transient definitions.
- DSH capability seams separate Service Definition, Service Provider and Consumer roles. The API is pre-stable and all consumers are updated together; this is not p2's requirement that independently built plugins keep working across application versions (AGENTS.md, “Pre-stable APIs”; docs/architecture.md:130-134).

### State, persistence and user interaction qualifications

- Session events are durable facts; agent and capability events are live extension points. Model-visible input must be reconstructable from the session log (docs/architecture.md:67-75, :118-126).
- A hard process loss before an assistant stream settles leaves no durable attempt stream. The log is the source of settled history, not a record of every transient byte (architecture.md:120).
- Session persistence acquires explicit write handles. Reloading a backend does not silently re-adopt old handles; old writers fail loudly until sessions restart. This consciously deletes HMR adoption/reseeding machinery (2026-08-27-handle-based-session-persistence.md:9, :27, :35).
- Historical session migration selects the highest committed generation, refuses future versions, migrates through adjacent steps and publishes a verified successor for a write open, preserving source generations. SQLite schema versions are monotonic (architecture.md:122; DSH AGENTS.md).
- Non-session application state is not forced into the session log: storage-json/storage-sqlite plus schema-validated storage-domain records are separate. This broadly matches the proposed split between Chord app documents and Durable transcript-related state.
- Durable scheduling does not make jobs durable. The shipped jobs contract holds callbacks and exact live `Agent` identities, so cross-process or restartable work needs a redesigned seam.
- The general observation “automatic work does not resume by itself” was specifically supported for goal activation; it must not be read as applying to schedules, which intentionally deliver overdue reminders.
- Questions can be reconstructed from tool call/result/session events. While a call is live the answer resolves that call. After timeout/process loss it becomes continued work and a later answer is steered as a new input; it does not fabricate a result for a finished tool call. A disconnected client can reconnect and answer a still-open request (user-questions README:27-40).
- Timed questions separate foreground waiting from question lifetime. A client may claim the wait and own its countdown; if no client claims it, an unattended timer releases the foreground request at the original deadline without aborting the turn. Unfinished draft input remains browser-local (same README:27, :40, :57).
- A human question with an agent authenticates exact live identity and only admits a runtime root, not a child. Agentless local requests may use unscoped listeners and fail without a provider (same README:33).
- Approvals have fresh request ids, a closed allow-once/rejected/cancelled/unavailable outcome and a log-only audit pair. Missing, throwing or nonconforming answerers are unavailable, not permission (docs/subsystems/approval.md:5-20).

## Open design questions and recommendation details

These were raised or implied explicitly while forming the proposal; none was settled by the owner in this conversation.

1. **How narrow can native ownership be?** Dedicated native-owner objects are one option; base-runtime generic supervisors are the stronger restriction. The latter lets plugin code reload while the actual process/socket/PTY remains owned by unchanged code. The former kills/reopens the native when its provider reloads.
2. **What counts as data versus behaviour?** A plugin class instance holding methods/listeners is code, not a passive native container. Rebuild it on reload and retain its state in documents. Saying “behaviour belongs in routines by convention” does not enforce this distinction.
3. **What is the minimum supervisor set?** Proposed primitives were process, PTY, socket/connection with reconnection, SQLite/plugin database, sandbox and filesystem watch. A small rarely changing kernel avoids moving every plugin into the base bundle, but the available primitives and their interfaces still need design.
4. **What must a native survive?** Tool/consumer reload, owning-object release, native-owner code change, worker idle stop, server restart and network reconnect are different events. DSH distinguishes some of these through service ownership but does not supply our general live handover or cross-host rollout guarantee.
5. **How should unsupported custom natives behave?** Proposed escape hatch: a plugin serves a native-owning object and that object restarts on code change; consumers get an error and re-hold. This gives up continuity for that native and conflicts with parts of the current resource target. Owner decision required.
6. **Can references replace resource `deps`?** Restarting a provider and re-holding through normal object references would remove resource topological replacement, handover and dependent reopening. This must not be confused with an already implemented transparent restart cascade across remote hosts.
7. **How much all-or-nothing publication is possible?** The proposal was to refuse the whole host install when a facet setup fails, rather than preserve an old facet inside a newer host revision. Async native activation, migrations and effects make stronger rollback difficult. DSH restores modules/plugin implementations, not external world state. The recommendation needs a precise boundary rather than claiming a transaction over native effects.
8. **How are Durable phases pinned?** Keep immutable registry tables and allow old calls to retain their old definitions. DSH's fresh-fiber cascade and deletion/re-registration gap do not meet p2's pinned-phase and readiness requirements. Moving natives behind stable methods removes raw-resource captures, but does not by itself settle which version an old phase should call.
9. **How should Questions survive reload?** One possibility was document-backed questions plus call-scoped resolvers: an interrupted ask fails retryably, and re-asking with a stable key reattaches. DSH's actual post-loss model instead sends a new user message. These are alternatives, not the same semantics, and neither has owner approval here. Logins, approvals and quorum/all-audience questions need their own answer-loss policy.
10. **Who computes keep-alive?** Proposed answer: the host counts references, jobs and supervised natives by owner so plugin authors do not maintain independent liveness flags. A native is activity, but not necessarily a viewer; counting every native as presence would conflate those concepts. The target already distinguishes lingering keep-alive from actual presence.
11. **How does ownership cross hosts/principals?** Exact `Agent` object identity is trusted same-process identity, not a portable principal or capability. p2 needs runtime-stamped object/job ownership and authority checks on methods reached across links. An opaque id alone does not authorize access.
12. **Which simplifications are unacceptable?** Killing agents on reload, package replacement requiring application restart, resetting component state, single-host assumptions, updating every API consumer in lockstep and in-process job callbacks are all parts of DSH's smaller problem. They cannot be adopted wholesale while keeping p2's stated requirements.

## Qualifications to the original report's broad claims

The original wording is preserved above for completeness, but it should not be treated as a proof of stronger guarantees than the inspected evidence supports:

- **“Natives are never values in plugin code” / “plugins hold ids” is a proposed generalization, not a universal DSH rule.** DSH passes live handles, backend session objects and job callbacks in process. The subprocess control channel explicitly returns a raw `Duplex`. Dedicated services are a useful ownership pattern, not a ban on all raw native access.
- **“No native survives a code change of its owner” depends on which owner is meant.** A backend plugin can unload while the stable terminal service retains sessions containing old backend behaviour. Job closures survive producer reload. The lifetime owner and implementation author are not necessarily the same plugin.
- **“No in-memory state survives a reload” only applies to the replaced fiber and rebuilt UI state.** Other services, retained sessions and running job closures can preserve memory and old code. This is precisely why lifetime ownership must be distinguished from code generation.
- **“No mixed versions” describes the intended host source-HMR replacement/rollback path, not a cluster-wide guarantee or an absence of old closures.** Browser reload is separate; failures can remain visible and retryable without rolling back unrelated browser plugins. Host rollback reactivates implementations but cannot undo arbitrary external effects or recreate killed PTYs.
- **“Effects unwind in reverse order” needs scope.** The fiber's documented effect API promises reverse order within an effect's collected disposers (vendor/cordis/src/fiber.ts:404 onward), but `_unload()` awaits cleared top-level disposers using `Promise.all` (:675-694). Ordered teardown requires bundling related work into one effect, as docs/cordis-primer.md:45 explicitly advises. Do not infer a universal dependency-safe sequential shutdown from the short report.
- **“One host” is the ordinary product composition, not an absence of child processes, remote execution or the desktop host/client split.** The useful contrast is absence of Chord-style many-host object rollout and principal-based binding, not absence of IPC.
- **“The session log is the only durable truth” is about session/model history.** Non-session application records and schedules are independently durable, as the report also notes.
- **“Gives up nothing” in the comparison table is shorthand for the target's broad ambitions, not a claim that Chord has no costs or constraints.** Chord already forbids native sharing across plugins, constrains transactions and restricts reload publication. The proposal is about further narrowing what plugin authors may retain.
- **“No pending promise needs to survive anything” means DSH does not promise resuming a lost JS continuation.** Live question services still hold pending waits and timers; durable projections preserve question facts, not promises.
- **“Killing live agents conflicts with live reload” is a continuity trade-off, not a logical impossibility.** It conflicts with the supplied stronger requirement that running work finish on its old code without reload draining it.
- Source references were gathered during a read-only research pass. The full target design was read; plugin-loading and Questions were consulted selectively. Not every DSH package or cited implementation was read in full. The archive records the research as produced rather than upgrading its coverage claims.
