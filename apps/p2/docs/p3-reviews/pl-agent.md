# pl-agent — models, prompt, code mode, agent, logs, developer tools, PowerShell, web and TUI design review

Status labels in this document:

- **DECIDED**: explicitly decided by the owner in `redesign-decisions.md` or its porting guidelines.
- **RESOLVED / SUPERSEDED**: the later p3/Chord v2 design removes the reviewed mechanism or adopts the recommendation.
- **OPEN**: explicitly listed as open in `redesign-decisions.md`, or still not answered by the decisions known to this reviewer.
- **RECOMMENDATION**: proposed by this review, not known to be accepted.

This records the design findings and recommendations from two rounds: the review of `target-design.md` at `6559589bd`, then the ownership/native-object review after `redesign-decisions.md` at `5abe3f6d6`. It intentionally excludes the later functionality map.

## Round 1: adversarial review of the original target design

The reviewed plugins were models, prompt, codemode, coding-tools, agent, web-shell, logs, dev-tools and powershell, including their interactions with login, sessions, chat, subagents, environments, Durable, web and TUI runtime services.

### Summary verdict and cost

**SUPERSEDED estimate, still useful as scope evidence.** The initial estimate was about 16 files and 650–850 changed lines. models was the largest part (about 300 lines: `resources.ts` restructured, methods replacing the opaque member, derives). Then prompt (about 150), logs (about 80), codemode (about 50), powershell (about 40), dev-tools (about 30), and agent, coding-tools, web-shell and the TUI/web registrations (about 10–20 each). Login and sessions added about 100 lines for removing models' opaque native, and subagents about 40 lines for removing the shared document write.

The original verdict was:

> **The design can express these plugins, with conditions.** Findings 1, 4 and 6 are API gaps (logic refresh of kept natives, overlap policy, rebinding derives over native change sources, whole-value replacement); without them, reloads of models, prompt and logs succeed without changing behaviour. Findings 2, 3, 5 and 7 are lifecycle and cross-plugin cases that need small additions: a close reason, deferred client releases, rebuilding dependent facets on reload, and handing over the credential locks.

The later p3 design deliberately replaces rather than migrates p2, and replaces resources with fixed-lifetime native objects, so the implementation estimate and several mechanisms are superseded. The concrete traces remain relevant where noted below.

### 1. Kept resources silently keep old plugin logic

**Status: RESOLVED by the decision that native objects restart on plugin reload; the underlying restart cost moved to later findings.**

> A kept resource keeps running the code that opened it, so a reload reports `installed` and changes nothing.

Concrete traces:

- models: `Resources` (`models/resources.ts:41`) wires its watcher to its own class method `load` (`resources.ts:67-79`). `load` calls `applyModelConfig`, which builds providers and patches `models.getAuth` with closures from that code (`provider-config.ts:673-691`). `FileCredentials` and `FileModelsStore` are plugin classes too.
- Trace: fix a bug in `provider-config.ts`, then reload models. The resource keeps its version, so it is kept. The next `models.json` change runs the old `load` with the old `applyModelConfig`. The fix only lands after a restart or a version bump.
- prompt: the same problem exists through closures in `prompt/worker.ts:84-106`, `environment.ts:89-97` and `context-files.ts:64`. A fix to skill discovery never applies; even a session move reuses the old closure (`worker.ts:154-158`).
- logs: the `setInterval(collect)` closure in `logs/server.ts:21-67` keeps running the first version of `collect`.
- Each such resource pins its first code generation, working against loader D's generation-GC goal.
- The old rule “keep logic out of the resource” could not actually be met by models: pi-ai's `MutableModels` is a native whose content is plugin closures.

Original recommendation:

> Add a resource mode `version: "code"`: every reload of the plugin runs the new code's `replace(old)`, which keeps the natives (file locks, watcher) and rebuilds the logic parts. Add a static check that warns when a resource's `open` returns an instance of a class defined in the plugin.

That recommendation is superseded. The owner instead decided that natives are fixed for one object lifetime and native objects restart on reload. This guarantees new code but makes expensive or disruptive restart behavior explicit.

### 2. Replacing or restarting the code-mode sandbox can hang Durable work

**Status: OPEN. `redesign-decisions.md` explicitly lists close-with-reason as raised and not yet discussed. The new design makes the trigger more common: every reload of the native-owning plugin restarts it.**

> Replacing the codemode sandbox hangs running scripts instead of failing them.

`codemode/calls.ts:17-23` records the reason: when the sandbox ends a run on its own, Durable stores no outcome, and the call waits forever.

Original trace under the resource design:

1. Bump the `sandbox` resource version (`codemode/worker.ts:22`).
2. Resource replacement closes the old sandbox.
3. `calls` depends on harness and worker, not on the sandbox (`worker.ts:27-34`), so `RunningCalls.cancel` does not run.
4. The tool call never settles, the conversation remains busy, and the worker never goes idle.

The p3 trace is now:

1. Reload the plugin while a code-mode script is running.
2. The native object is restarted and closes `CodemodeSandbox`.
3. Durable sees that the sandbox abort was not initiated through the invocation's own controller; its current behavior stores nothing so a future worker can replay it.
4. The current invocation can remain waiting forever unless close explicitly settles or aborts the Durable task.

Related problem:

- On a worker stop, code mode must **not** abort and commit a terminal outcome, because the next worker should replay the interrupted script.
- On a plugin reload/removal, the running call should be deliberately aborted and settled.
- Today this distinction is inferred through `worker.liveness.stopping` (`codemode/worker.ts:31-33`).

Original recommendations:

- Under the resource design, make `calls` depend on `sandbox`, so calls close and settle before the sandbox closes.
- Pass `close(value, { reason: "replace" | "remove" | "stop" })`.
- Replace the raw `setTimeout` poll in `reported` (`calls.ts:67`) with a Durable watch.

Current recommendation:

- Chord v2 native close needs a reason, at least `reload`, `end` and `stop`.
- The code-mode native owner must abort the Durable tasks it serves on reload/end, but not on worker stop.
- Define how a native owner accounts for and settles non-Chord work, because “running work in native objects is aborted” currently describes Chord work, not Durable task invocations hidden behind a plugin extension.

### 3. Client renderer reloads create false departures

**Status: OPEN. `redesign-decisions.md` explicitly lists “UI renderer reload vs. leaving” and presence behavior as open.**

> A web or TUI facet reload releases every reference below it, and the design reads a release as someone leaving.

Concrete traces:

- web-shell registers the root component (`web-shell/web.tsx:46`). Giving `App` a new component identity remounts the whole tree. Every `useObject` cleanup calls `ref.release()` (`runtime/web.tsx:177-181`).
- Login: `ProviderLogin`'s viewing cleanup runs `abandon` (`login/server.ts:134-141`), so reloading the shell can kill an OAuth login in progress.
- Questions: with `all` and a live audience, a reloading owner appears to leave. If everyone else has answered, the question can resolve with that owner in `missing` even though the owner did not intentionally depart.
- Presence: viewer counts briefly fall and rise.
- TUI: when a slot factory changes, the runtime disposes its surface (`runtime/tui.ts:473-479`). `ModelState` releases and re-holds `Chat` (`models/tui.ts:73`).
- TUI notices: `NoticeWatch` resets `seen` and `first` (`logs/tui.ts:164-165`), so old notices are summarized again after reload.

Recommendation:

> While a client install runs, defer releases until after the next render commit, and let a re-hold of the same `(type, input)` take over the old remote hold. Neither `host.references` nor the linger bit should see this as a departure.

This also needs a decision for full web reloads/TUI worker swaps, where the old and new clients are different runtime instances but represent one logical viewer origin.

### 4. `routines.on` needs explicit overlap semantics

**Status: OPEN. `redesign-decisions.md` explicitly lists `routines overlap: "latest"` as open.**

> `routines.on` does not say what happens when a new value arrives while a handler runs; PowerShell and prompt need the old run aborted.

Concrete traces:

- PowerShell probes an unreachable remote in a loop until its own “moved” signal aborts (`powershell/worker.ts:32-37,44-53`).
- Prompt closes the old watcher after a location move (`prompt/worker.ts:154-160`).
- A session is on unreachable remote A, then moves to a local Windows machine. If `on` queues handlers, the new handler waits behind A's endless retry, so PowerShell remains stale and is not offered.
- On reload, serialized routine restart can wait behind the same handler until its deadline.
- If prompt-watch logic moves into a restarted routine, its “first load done” marker cannot live in that routine. Otherwise every prompt-plugin reload makes subsequent input wait for another remote scan, up to the existing 60-second load timeout.

Recommendation:

> `self.routines.on(source, fn, { overlap: "latest" | "queue" })`. `latest` aborts the running handler's `ctx.signal` when a new value arrives. Durable “first load done” markers belong in state that survives routine restart.

### 5. Agent copies and writes another plugin's Durable document

**Status: RESOLVED / DECIDED in the p3 porting guideline. Core-enforced conversation policy is written at child creation; plugins do not share private documents.**

> agent copies another plugin's Durable document and writes to it.

Concrete trace:

- `agent/tool.ts:17` imports `Subagents` and `resolveChoice` from `subagents/tools.ts`, a loader-D cross-plugin copied module.
- It writes `registry.oneShots` into the subagents-owned document (`agent/tool.ts:82-90`).
- If subagents bumps `Subagents` to version 2 and only subagents reloads, agent's bundle still has the version-1 copy; `tools.agent` throws on the newer document.
- Reverse case: agent reloads with a version-2 copy while the subagents worker facet rejects and remains at version 1. agent writes a v2 document; subagents' old code then throws on its own document, including `subagentCwdFollowers`, which relocation/start calls (`runtime/worker.ts:476-526`). The relocation fails and can leave recovery to a worker restart.

Original recommendations:

- Expose a host-local recorder owned by subagents, or add a Durable commit hook, so agent no longer imports/writes the document.
- Rebuild every facet whose bundle metadata includes a changed cross-plugin file, even when only one plugin is named.
- More generally, forbid copied cross-plugin modules from defining Durable documents or tasks unless all consumers form one reload unit.

Owner decision:

- Core owns per-conversation policy (`readOnly`, `followsSessionCwd`, and equivalent creation metadata).
- Agent/subagents write that core format in the creating commit.
- Chat and relocation enforce it directly.
- `ReadOnlyConversations` and `SessionCwdFollowers` policy registries go away.

The one-shot listing metadata still needs one owner; it should not return to a plugin-shared private document.

### 6. Old derives over changing natives and whole-root document writes

**Status: native-source half RESOLVED by fixed-lifetime natives and native-object restart. Whole-root replacement remains UNKNOWN/OPEN unless Chord v2's document API has since specified `set`.**

Original finding:

> Derives over a changing native do not work as specified, and documents cannot replace their root value.

Concrete traces:

- models' `summary` and `snapshot` follow changes inside `Resources` (`models/server.ts:31-39`, `config.ts:51-59`). A derive over the resource handle only recomputes when the handle rebinds, not when the native changes internally.
- Taking a readable out of `.value` was the old resource footgun; `questions.md` nevertheless illustrated `self.derive([pending.value.readable], …)`. After replacement, that derive could stay attached to old data silently.
- PowerShell's `windows` and dev-tools' `offered` replace scalar roots. The document draft design described property assignment, `push` and `Object.assign`, but not replacement of a boolean root.
- `Object.assign` is also not enough for replacement semantics because it does not delete keys absent from the next object.

Original recommendations:

- Derive sources shaped as `(handle, value => value.changes)`, rebound as part of replacement.
- Add `handle.set(ctx, value)` and `tx.set(handle, value)` for whole-value replacement.

The new native design removes replacement/rebinding of a native during one object lifetime. Native owners still need explicit source readables for internal changes. The scalar/root-document write question remains.

### 7. Models exposes opaque natives across plugin boundaries

**Status: DECIDED. No natives across plugins; consumers use owner methods/state. Restart behavior during login remains OPEN as a consequence.**

Original finding:

> Natives cross from models to login and sessions; the design forbids that, and the replacement methods fail mid-login when models reloads.

Concrete traces:

- login constructs `Logins` with `ModelConfig.resources` (`login/server.ts:62`) and calls `models.login`, `refreshModels`, `modelStore.delete`, `reload` and `publish` (`login/logins.ts:41,130-146,199-206`).
- sessions reaches through the same opaque resource to validate a model (`sessions/server.ts:223`).
- `HarnessConfig` similarly returns a native `Models` object to core Harness, chat, agent and subagents.
- Under the old replacement design, an OAuth flow waiting for the browser could lose its credential write when models' old `Resources.close()` closed `FileCredentials` and its lock (`resources.ts:287-295`).

Original recommendation:

- Replace the opaque member with methods: `hasModel`, `setDefault`, `setEnabledModels`, login/logout/refresh and related operations.
- Use callbacks only for local methods such as provider prompts/notices.
- Hand locked files over during replacement, and resolve the current credential store at write time.
- Clarify whether host-owned registries such as `HarnessConfig` are an allowed native bridge; otherwise move model runtime into core.

Owner decisions now known:

- No natives across plugins.
- Local methods may take callbacks.
- Methods return data, and objects cross boundaries only by address.
- Durable keeps its own types; p3 hands Durable plain data/Durable types, never Chord v2 objects.

Open consequence:

- If the native owner includes a provider login flow, reloading that plugin aborts it. The design says expensive natives should be split into another plugin, but the correct ownership/split for models, credentials and provider login still needs to be chosen.

### 8. Logs duplicate work and scale poorly

**Status: OPEN.**

Original finding:

> Smaller issues in logs: duplicate lines after a reload, and per-line cost.

Concrete traces:

- If detached-log collector dedupe state (`seen`, `fingerprints`) lives in restarted behavior (`logs/server.ts:27-28`), reload can reappend every line from `terminals.logs.json` and `dev.logs.json`.
- `Logs.lines` copies and diffs up to 1,000 lines for every appended line, per open view (`runtime/logs.ts:177`, `logs/server.ts:96-99`). A burst with several open views amplifies copying and diff cost.

Recommendations:

- Keep detached snapshot dedupe state with the owning process-log store rather than with the restarted collector behavior.
- Prefer a store-backed readable that publishes append and front-trim operations instead of copying/diffing the full 1,000-line array for every line.
- Longer term, push detached process logs over IPC rather than polling snapshot files, while retaining an exit snapshot if startup/fatal errors require it.

### Additional round-1 review points

#### Immutable Durable registry snapshots are the correct phase boundary

**Status: consistent with the design; no change requested.**

Durable pins one immutable extension snapshot per phase. Registry table swaps are therefore safe for old/new code interleaving as long as extension values do not reach mutable/restarted natives behind the snapshot. The latter exception is exactly the code-mode and models-native problem above.

#### Mixed facet versions made shared modules and local identities dangerous

**Status: RESOLVED by all-or-nothing rollback per host.**

The original design let a facet whose setup threw keep its prior version while other facets on the same host committed. That made copied Durable definitions and shared host behavior particularly dangerous. The owner later decided that any load or staging error rolls back the whole host; a host is entirely at revision R or R−1.

Cross-host mixed revisions still exist during rollout and remain protected by versioned contracts and mismatch rules.

#### TUI `instanceof` checks are not themselves a reload failure when slots are recreated

**Status: resolved by the current TUI slot behavior; loader-D cross-plugin identity rules still apply generally.**

The review considered `surface instanceof ModelState`, `PromptSurface` and `NoticeWatch`. The TUI runtime disposes and recreates a surface whenever its factory identity changes, so same-facet checks remain aligned after a successful table swap. This is not the same as importing a class from another plugin, which loader D correctly forbids.

#### Web-shell reload remount cost is larger than presence alone

**Status: OPEN as part of UI renderer reload.**

Replacing the root component also:

- remounts the app-scoped `ComposerState` and `NewSessionState`;
- churns every object hold below the root;
- can lose transient UI state not in browser/session/server storage;
- can reset scroll and sheet-local state;
- reruns global effects such as navigation listeners.

Recommendation: keep the root shell identity stable and reload contribution tables below it, or explicitly snapshot/transfer all app-scoped state and remote holds.

#### Prompt restart can turn a code reload into an expensive remote rescan

**Status: OPEN as native split/ownership design.**

Prompt watches may scan AGENTS.md, skills and templates over SSH, with a 60-second load timeout. If that watcher is in a native object, every reload of its owning plugin restarts the scan. Recommendation: keep the last valid prompt data and first-load completion in durable/facet documents, and isolate the expensive watcher into a narrowly changing owner/plugin if needed.

#### Coding-tools section performed late registry lookup

**Status: addressed conceptually by ownership principle; concrete replacement still to design.**

`coding-tools/worker.ts:24` reads `HarnessEnvironments` at section-render time to obtain an SSH host. This treats an extension registry as a data service and lets a pinned Durable phase consult the current registry. Recommendation: the session/location owner should expose display location/SSH-host data; registries remain behavior extension points only.

#### Models' stable proxy does not make captured model operations reload-safe

**Status: still relevant to native ownership.**

`Resources.models` is a proxy that binds a method lookup to the current immutable model generation (`models/resources.ts:80-86`). That correctly prevents one stream from switching provider implementation halfway through a call. It does not solve reload of the native owner, credential-file closure, or the fact that provider implementations contain plugin code. The p3 model runtime needs explicit generation pinning and shutdown semantics.

#### Model and prompt native containers can pin code even without unbounded leaks

**Status: RESOLVED mechanically by restart, but the distinction remains useful.**

A kept class/native instance can pin its creation generation. This is often one permanently pinned old generation rather than unbounded growth, but its stale behavior is still wrong. Generation-GC tests must check both bounded reachability and behavior actually changing after reload.

#### Registry values can become a loophole for “no natives across plugins”

**Status: DECIDED in principle; enforcement remains a recommendation.**

`HarnessConfig` showed that a registry entry can return `Models`, effectively moving a native across plugin boundaries while formally using a registry. Recommendation: static/API guardrails must enforce that registries add behavior and do not carry another plugin's native. Core-owned integration with Durable should not be disguised as a plugin registry.

#### Raw timers in facets/native behavior need conversion or an explicit exception

**Status: routines remain the decided mechanism; concrete call-scoped polling remains open.**

Examples were logs' `setInterval`, PowerShell's retry sleep and code-mode's 25 ms `setTimeout` polling. Standing behavior belongs in routines. Polling internal to one call may need a call-scoped timer helper or watch rather than a standing routine.

## Round 1 architecture recommendations (superseded sketches, retained for design intent)

These were the intended ownership boundaries behind the original rewrite sketches. APIs such as `self.resource` are superseded, but the behavioral recommendations remain where they agree with p3 ownership:

- models should expose data and operations (`hasModel`, defaults, enabled scope, login/logout/refresh) rather than an opaque `Resources` instance;
- prompt should keep loaded prompt data and failure state separately from the file watcher, and input gating should survive watcher/routine restart;
- code mode should settle its running Durable calls before a reload-driven sandbox close;
- coding-tools should read session-owned location metadata instead of using an environment registry as a query API;
- one-shot agent should not write subagents' private document;
- logs should own dedupe state outside restarted collection behavior;
- dev-tools and PowerShell should derive availability from session location through latest-wins reactions;
- web/TUI contributions should be registrations, but app/root state and holds must survive contribution reload.

## Round 2: p3 ownership and native-object review

The owner had already decided at this point:

- **DECIDED:** p3 is a new, isolated app beside p2, with its own data directory and no legacy data migration.
- **DECIDED:** Chord v2 initially lives inside p3.
- **DECIDED:** natives exist only inside objects, opened during activation, fixed for the object's lifetime and closed at object end.
- **DECIDED:** facets are pure objects with no natives.
- **DECIDED:** load/staging failure rolls back the entire host.
- **DECIDED:** pure objects swap in place; native objects of reloaded plugins restart and their running work is aborted.
- **DECIDED:** each thing has one smallest owner; nobody reaches through it; registries add behavior and never guard owned data.

The object list below was a **RECOMMENDATION**, not an owner decision. It was derived from the reviewed plugin interactions before the subsequent functionality-map exercise.

### Recommended core ownership boundaries

| Recommended type/address | Host | Kind | What it owns / why |
| --- | --- | --- | --- |
| `settings {}` | server | native file watch/lock | `settings.json`; validates schema, keeps last valid state, serializes writes |
| `credentials {}` | server | native locked file | `auth.json`; fail-closed parsing, metadata, token refresh/modification, no secret state exposure |
| `model-catalog {}` | server | native pi-ai model catalog/file watch | `models.json`, `models-store.json`, provider metadata, defaults/scope resolution, login/logout/refresh operations |
| `models {}` | server | pure per-owner view | owner-visible catalog/default/scope/errors derived from the catalog owner |
| `log-store {}` | server | native stdout capture/collector | bounded source buffers, notices and secret redactor |
| `logs {source}`, `log-notices {}` | server | pure owner views | query/filter state and dismiss operations over the log owner |
| `session {session}` | worker | native Durable Harness/SQLite/environments | session storage, location, set of conversations, relocation/admission/task lifecycle |
| `model-runtime {}` | worker/core | native `MutableModels` | synchronous model access required by Durable; request-generation pinning |
| `conversation {session, conversation}` | worker | pure owner over Durable data | entries, agent configuration and core policy (`readOnly`, `followsSessionCwd`, origin/creation metadata) |
| `chat {session, conversation}` | worker | pure per-principal view | authorized view/send/configure facade over the conversation owner |

Recommended rules and APIs:

- `settings`: expose validated state/errors and typed patches; plugins should not edit the file.
- `credentials`: expose non-secret metadata; worker-only credential resolution; serialized modify/delete.
- `model-catalog`: build/validate before publish; expose `has`, defaults, enabled scope, provider login/logout/refresh.
- `log-store`: enforce redaction, bounds and line-id dedupe; expose append/notice/dismiss/addSecret.
- `session`: enforce relocation fence/start barrier; expose location including `sshHost` and `os`, task abort, environment file/watch operations.
- `model-runtime`: expose model validation and choice resolution; keep its native inside core/Durable integration.
- `conversation`: enforce read-only/configure/send policy and model validity; expose `originOf(taskId)` instead of transcript parsing in unrelated plugins.

### Recommended feature ownership

| Area | Recommended owner/kind | Review recommendation |
| --- | --- | --- |
| models UI | pure facet/view | UI and command registrations separate from catalog/files native |
| prompt | worker native watcher plus facet documents | watcher writes loaded agents/skills/templates and first-load completion; keep last valid data across restart |
| code mode | worker native sandbox owner | owns sandbox and running call accounting; explicitly settles Durable work on reload close |
| coding tools | pure extension facet | section reads session-owned location data |
| one-shot agent | pure extension behavior | creates a child conversation with core policy/metadata in the creation commit |
| PowerShell | pure behavior plus boolean/document | derive from session-owned OS data; do not reach into environment connection native |
| dev control | server native dev channel plus worker extension | dev owner validates reload; worker tool delegates after conversation-origin authorization |
| logs UI | pure views | no native/log-store ownership in UI plugin |
| web shell | pure client facet | root identity/state still must survive renderer reload |

### Places where p2 reaches past an owner

Each row is a review finding and replacement recommendation.

| Today | Replacement recommendation | Status |
| --- | --- | --- |
| `ModelConfig.resources` opaque used by login and sessions | model-catalog methods/state | **DECIDED principle; concrete owner open** |
| `HarnessConfig` carries native `Models` into Harness, chat, subagents and agent | core model runtime integrated with Durable | **DECIDED no cross-plugin natives; concrete split open** |
| auth.json written by server and workers | one credentials owner, or a deliberately versioned core file interface | **OPEN: config files with one writer explicitly listed** |
| settings.json read directly by every worker; keys consumed by unrelated features | settings owner with typed operations or sections | **OPEN: single-writer config listed** |
| agent imports `subagents/tools.ts` and writes `Subagents` | core child policy/metadata at creation | **DECIDED** |
| code mode calls native Harness APIs and polls `LiveDoc` to cancel work | session-owned task-abort operation | **RECOMMENDATION; close semantics open** |
| PowerShell reads `environments.at().connection.info()` | session/location owner exposes OS | **DECIDED principle** |
| prompt imports env-specific implementation and reaches native environment | session/environment owner offers file read/list/watch operations | **RECOMMENDATION** |
| coding-tools reads `.host` from `HarnessEnvironments` registry as data | session/location owner exposes `sshHost` | **DECIDED principle** |
| dev-tools copies `conversations/origin.ts` and parses transcript/task chains | conversation owner exposes origin/attribution operation | **RECOMMENDATION** |
| global `processLogs.redactor` is used directly by models, login and radius | log/redaction owner method or host value | **RECOMMENDATION** |
| `ReadOnlyConversations`, `SessionCwdFollowers` policy registries | core conversation policy document | **DECIDED** |

### Natives recommended for isolation/splitting

The p3 design says an expensive native should be split into its own plugin because all native objects of a reloaded plugin restart. These were the concrete candidates:

| Native | Why restart hurts | Recommendation | Status |
| --- | --- | --- | --- |
| worker `MutableModels` | restarting during a stream can break auth/provider work and violates Durable's synchronous native needs | place in core/model-runtime rather than a frequently edited UI/config plugin | **OPEN concrete design** |
| server catalog and credentials/login | reloading models can abort a 10-minute OAuth flow after the user has acted | split stable native catalog/login ownership from pure models views/UI | **OPEN** |
| process log store | restart loses in-memory buffers, redactor knowledge and dedupe state | core/host native, independent of logs UI | **RECOMMENDATION** |
| code-mode sandbox | restart aborts long scripts | initially considered a separate stable plugin; final review judged a split alone insufficient because Durable needs the sandbox/run native interface | **OPEN; close semantics explicitly open** |
| prompt watcher | remote rescan can take up to 60 seconds | retain loaded data/first-load completion outside watcher; optionally isolate watcher if frequent code reload would restart it | **OPEN** |

### What the ownership principle could not directly express, or made worse

#### A. Durable requires native interfaces that are not data-returning methods

**Status: OPEN / architectural constraint.**

Durable calls model APIs such as `getModel` and streaming implementations synchronously through a `Models` object. Code mode calls `sandbox.start(code, { onCall, onIdle, … })`, receiving a run handle with delivery and result behavior. “Methods return data, never objects” cannot directly represent either native interface across an ownership boundary.

Recommendations considered:

- put model runtime in core beside the Durable Harness;
- keep code-mode extension and sandbox in the same native-owning object;
- do not disguise the native as a registry value;
- if a run must cross an object boundary, model it as an addressed run object rather than returning a native handle, but this is much heavier and was not recommended without broader need.

The owner has decided that p3 gives Durable plain data and Durable's own types, never Chord v2 objects. The exact core/native integration remains to be designed.

#### B. Native restart does not automatically abort Durable work

**Status: OPEN; same as round-1 finding 2.**

The owner decided native-object running work is aborted on reload, but Durable task execution is external work reached through an extension callback. Chord cannot infer which Durable tasks belong to the native. The native owner needs an explicit accounting/abort hook before close.

#### C. Close needs a reason

**Status: OPEN and explicitly listed in `redesign-decisions.md`.**

> `close` with a reason (`reload` / `end` / `stop`): codemode must abort its Durable calls on reload, not on stop.

This was the clearest unresolved API addition from this review.

#### D. A single server credentials owner changes failure and trust boundaries

**Status: OPEN; part of single-writer config design.**

If every worker asks the server for credentials:

- model work now depends on the server link;
- a server restart can park/fail token resolution during a running turn;
- refresh rotation takes a cross-process round trip;
- secrets cross the server-worker link.

Alternative considered: workers have a core-owned, read-only credential-file reader while writes/refresh ownership remains serialized on the server. That makes the file format a versioned interface and weakens strict single-object ownership. This trade-off needs an explicit decision.

#### E. One settings file conflicts with “smallest owner”

**Status: OPEN; config files with one writer explicitly listed.**

`settings.json` contains keys owned by models, Durable run behavior, code mode, owner identity and TUI/display behavior. Options:

1. one settings owner knows all keys (risk: core god object);
2. plugins register versioned setting sections/keys (registry now influences a file owner's schema, but should not guard unrelated data);
3. split files by owner (behavior change for owner-edited configuration);
4. treat the file format itself as a core versioned interface and let one core owner persist it.

No option was selected by this review.

#### F. UI remount still releases authority/presence references

**Status: OPEN; explicitly listed.**

Same concrete login/presence/questions trace as round 1. Ownership does not solve lifecycle interpretation.

#### G. Root/scalar document replacement was unspecified

**Status: UNKNOWN/OPEN.**

PowerShell availability and similar results are scalar values naturally replaced as a whole. If documents only expose mutable object drafts, the API needs root replacement (`tx.set`/`handle.set`) or these values must be wrapped in objects solely to mutate a property.

#### H. Call-scoped natives may be needed

**Status: OPEN and explicitly listed by the owner as raised by reviewers.**

Some natives exist for exactly one call rather than one object lifetime. The reviewed examples suggest provider login interactions, transient subprocess/run handles and some environment operations. Forcing each into a long-lived object or a data-returning method can distort ownership and cancellation. Chord v2 may need a call-scoped native mechanism, but this review did not settle its API.

#### I. Async activation guards for authority-bearing addresses

**Status: OPEN and explicitly listed by the owner as raised by reviewers.**

If an address itself carries authority or requires asynchronous validation, checking only after an object becomes live creates a window with the wrong lifecycle/presence semantics. The runtime may need an activation guard that completes before publication. No concrete API was selected here.

#### J. Invariants spanning owners

**Status: OPEN and explicitly listed by the owner as raised by reviewers.**

The ownership principle deliberately avoids cross-owner transactions, but some app rules span several owners' data. This review encountered examples around session/conversation creation metadata, credential/catalog coordination, and reload/worker state. The rule must identify which owner is actually smallest for the invariant, or define a coordinator/protocol; policy registries are not an acceptable guard.

#### K. Published projections for readers that must not start workers

**Status: OPEN and explicitly listed by the owner as raised by reviewers.**

Logs, session status, unread/child summaries and similar server-side views must be readable without activating a session worker. Copies need a generation fence so an older worker cannot overwrite newer server state. This review's logs and worker-failure traces are concrete examples.

#### L. Connection pooling

**Status: OPEN and explicitly listed by the owner as raised by reviewers.**

Environment consumers can independently open SSH/native connections. The ownership model needs a connection-pool owner or another way to avoid four parallel SSH connections while still preventing plugins from reaching through the environment owner.

### Earlier findings after the p3 redesign

This was the review's explicit resolution table, updated only with known owner status:

| Earlier finding | Result under p3 redesign |
| --- | --- |
| Kept resources keep running old logic | **RESOLVED:** native objects restart with new code. |
| Code-mode sandbox hang | **REMAINS, and can happen on every code-mode plugin reload:** needs task settlement and close reason. |
| Client remount releases references | **REMAINS / OPEN.** |
| Routines `overlap: "latest"` | **REMAINS / OPEN.** |
| Agent writes subagents' document | **RESOLVED / DECIDED** by core conversation policy at creation, provided one-shot listing metadata also gets one proper owner. |
| Derives over a native's replacement/change source | **RESOLVED mechanically** for native replacement because a native is fixed for the object lifetime; native-internal change still needs an explicit readable. Whole-root document replacement remained unspecified. |
| Natives across plugins (login/models) | **RESOLVED as a rule:** forbidden. Concrete ownership and login-restart cost remain open. |
| Logs dedupe and per-line cost | **REMAINS / OPEN.** |
| Mixed old/new facet versions after one setup rejects | **RESOLVED:** staging failure now rolls back the whole host. |
| Old module generations retained by resources | **RESOLVED by native restart**, subject to external Durable/registry closures not retaining them. |

## Final recommendations carried forward

These are the recommendations from both rounds that remain applicable to Chord v2/p3:

1. **Specify native close reasons.** At minimum distinguish reload, ordinary object end/removal and process/worker stop. Code mode is the concrete acceptance test.
2. **Define ownership of external work.** A native owner must be able to enumerate/abort/settle Durable tasks or other non-Chord work it started before close.
3. **Add `routines.on(..., { overlap: "latest" })`.** Relocation-sensitive prompt and OS detection are acceptance tests.
4. **Make renderer replacement invisible to presence and authority leases.** Transfer equivalent holds across web remount/TUI worker swap before releasing the old client.
5. **Keep core policy with the conversation.** `readOnly`, cwd-following and one-shot origin/metadata are written in the child-creation commit; never restore policy registries or cross-plugin private-document writes.
6. **Keep registries behavioral.** Do not use registry values as native/data-service loopholes (`HarnessConfig`, environment host lookup).
7. **Choose and document single-writer strategies for `auth.json`, `settings.json` and `models.json`.** Include server-restart, worker-offline, token-refresh and owner-hand-edit traces.
8. **Place synchronous model runtime beside Durable/core.** It cannot cleanly cross a plugin boundary under “methods return data”. Preserve per-request generation pinning.
9. **Define root document replacement.** Add a typed whole-value set operation unless every state schema is required to be a mutable object.
10. **Keep expensive watcher results outside the watcher native.** Prompt's last valid data and first-load completion must survive watcher restart; models/config similarly need explicit published state.
11. **Centralize log ownership and redaction.** Preserve dedupe state across UI/collector reload; publish append/trim operations rather than full-list diffs under load.
12. **Test behavior change, not only generation GC.** A reload test should prove fixed model/prompt/log logic executes afterward, old code is collectable, running native work gets the specified outcome, and failed staging leaves the complete host at the prior revision.
13. **Use bundle dependency metadata or ban copied behavioral definitions.** Even with host-atomic rollback, targeted reload must not leave copied Durable/task/document definitions stale in another plugin.
14. **Keep the root client shell stable where possible.** Reload contribution tables below it instead of remounting every screen, object hold and app-scoped editor state.
15. **Treat the ownership principle as an enforcement rule, not prose.** Static/runtime checks should catch opaque/native returns, cross-plugin private document definitions/writes, and registries used as data/policy guards.
