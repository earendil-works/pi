# Harness V3 hardening handoff

## Goal

Harden the implementation in `harness-v3.zip` without reverting its core design. Return a new standalone zip for review. Do not integrate it into the pi repository yet; the accepted implementation will later be incorporated under `packages/agent/src/harness/pico3/`.

Baseline archive:

- `~/Downloads/harness-v3.zip`
- SHA-256: `1c69c5c5d923fe1c80200cc5e49ddb3868158e1b6a844efa3e2f03eb24ff5be7`
- Current runtime suite: 67 passing tests
- Current kernel + kinds: approximately 3,448 lines, excluding storage backends

The current code is a good executable design spike. Preserve its legible fixed-core, document/view, and phase-map architecture. Correctness takes precedence over preserving the exact line count.

## Companion documents and supersessions

This copy in `packages/agent/docs/pico/v3/` is canonical. Two companion
documents in the same folder were written after this handoff and take
precedence where they overlap:

- `view-and-events.md`: the watch protocol, the single view document, ops by
  path, named events, the commit-by-commit mapping, watchers and late joiners.
- `plugins.md`: the harness registration surface, the four durable primitives
  (entry, checkpoint, slot, namespace), tool/hook/custom-kind/entry/namespace
  extension points with examples, unregister/re-register/reload, and the Chord
  facet layer.

Specifically superseded in this document:

| here | replaced by |
|---|---|
| Accepted direction #3 (separate `rewindable`/`sticky` view fields with separate op lists) | one flat view document with `config`, `inbox`, `turn`, `compaction`, `tasks`, `plugins` and one op list (`view-and-events.md` §2–§4); the storage split stays |
| Accepted direction #2 "live task slots ... in the view" and §13 last paragraph (`TaskRef<K>` slot typing) | slots remain, but the view publishes kind-described `tasks[id].status` via `describe()`, never raw task records (`view-and-events.md` §2.2, §6.6; `plugins.md` §4.3) |
| §9 Watch protocol: envelope shape, `Seq` ordering and `applyDelta` | `Envelope { revision, ops, events }` with a contiguous per-watch `revision` (storage `Seq` is not exposed), folded with `applyImmutable`; the active-transcript definition and capture rules in §9 here remain normative (`view-and-events.md` §3, §5, §9) |
| §9 bounded capacity / overflow-close | the raw watch invokes its listener synchronously in order; only the pre-`start` buffer is bounded (overflow closes the watch); asynchronous consumers own their queue (`view-and-events.md` §3; `plugins.md` §6.1 for the Chord bridge) |
| §13 plugin state visibility | a namespace is in the view only through its declared `view` projection; memos and slot working state are never in the view (`plugins.md` §1.5, §2, §4.5) |
| §15 `beforeTool` throw = block; hooks by name | hooks are registered with their namespace token (`h.hooks(ns, kind, handlers)`); `BeforeToolApi.waiting(ctx)` is asynchronous; memo keys are `(task, namespace, name)` (`plugins.md` §4.2) |
| §16 / view §6.2 generation failure closures | every generation failure resolves the group `unanswered/failed`, runs the final boundary and starts a successor for queued triggers (`view-and-events.md` §6.2) |
| §4.4 entries / §1 `pi.*` | `pi.*` entry names reject for non-core callers except the allow-listed `pi.notice` (`plugins.md` §4.4) |
| §13 plugin state (`plugins[pluginId]` slices, extra document shard) | `h.namespace(ns, defaults)` tokens, `tx.plugins(ns)`, `tx.emit(ns, …)`, lazy seeding; extra shards stay deferred (`plugins.md` §2, §3, §4.5) |
| §15 tool API (candidate) | `ToolApi` with `memo` (slot memoOnce), `waiting`/`memo` on `BeforeToolApi`, `waitingOn` on the tool slot (`plugins.md` §4.1–§4.2; `view-and-events.md` §2, §6.3) |
| §1 "install fixed built-ins internally" / registration at open | registration capabilities callable while open, before-`resume()` rule, `quiescent()/hold()` for idle reload and `suspend()/reopen` otherwise; no handler-withdrawal machinery in v1 (`plugins.md` §3, §5) |
| §16 `pi.plugin` handlers map | folded into custom task kinds; `pi.plugin` may stay as a convenience kind but is not the plugin mechanism |

Everything else here (authority explanation, proxy lifetime, prospective busy,
display-only assistants, read semantics, phase-map contract, session line,
waiters, storage atomicity, terminal retention, strict types, context/sections,
tool/process behaviour, known defects, test matrix, deliverable) stands.

## Accepted direction

These are decisions, not open questions:

1. **Fixed core.** `pi.generation`, `pi.tool`, `pi.post_tools`, `pi.collapse`, and the Harness methods built on them are fixed and unreplaceable. `pi.job` and `pi.plugin` are built-ins too, though they use ordinary-task authority. Plugins cannot register any `pi.*` task kind or replace a built-in.
2. **Document state.** Keep Chord-delta-backed session, conversation-rewindable, and conversation-sticky documents. Keep the core rendering fields (`inbox`, `turn`, live task slots, core config) represented in the authoritative conversation view.
3. **Rendering-oriented view.** Keep `rewindable` and `sticky` as separate top-level `ConversationView` fields with separate Chord op lists. Keep commit deltas easy to fold and render. A renderer should not reconstruct turns by correlating unrelated channels.
4. **Phase-map tasks.** Keep `initial` plus an exhaustive phase map. Do not restore a separate handwritten `execute`/`recover` pair.
5. **One implementation, few capability views.** One internal `TxImpl` is desirable. Expose narrow host/ordinary/core transaction types or façades over it rather than a large hierarchy. Runtime checks remain authoritative.
6. **Extensibility.** Preserve custom entries, custom phase tasks, tools, core hooks, system sections, typed config, jobs, owned conversations/subagents, plugin state, and compatibility with separate Chord RPC/presentation services.
7. **Single process.** Do not add cross-process locking. Document that a storage path has one owning process/session at a time. Reject a second Session over the same Storage object in-process; behavior from two processes opening the same JSONL path is unsupported.
8. **Commit-granular document history.** A fork at an entry sees the final rewindable document state of the atomic commit containing that entry. Document this explicitly. Do not reintroduce per-write `Seq` or rewindable-before-entry ordering unless a concrete failure demonstrates it is needed.
9. **Separate stable IDs and commit sequence.** Object IDs remain stable identity. `Seq` orders atomic commits and watch envelopes.
10. **No terminal pruning.** Terminal task records and outcomes remain durably readable. Terminal checkpoints may be dropped once no downstream contract relies on them; `ToolInput.offered` already removes the generation-checkpoint dependency.

## What `boundary()` and `resolveInputs()` mean

These are core authority and must not be exposed to ordinary tasks.

### `boundary(conversationId, at, headBoundary)`

`boundary()` implements inbox placement at a safe turn boundary. `headBoundary` is the current retained transcript boundary, supplied by core code so `boundary()` performs no storage scan after same-batch appends. It:

1. reads the ordered sticky inbox;
2. finds a queued self-head write (reset/handoff) and marks older steer/follow-up inputs stale;
3. selects every passive write, steer inputs according to `steeringMode`, and at a final boundary follow-ups according to `followUpMode`;
4. places selected entries strictly in global input-ID order;
5. updates their durable `Input` records;
6. removes selected/stale items from the inbox;
7. returns trigger input IDs and whether a self-head ended the old input group.

An ordinary task calling it could drain input in the middle of an assistant/tool exchange, stale requests, place a reset at an invalid point, or consume triggers without creating the required successor generation. Only fixed core turn code may call it.

### `resolveInputs(ids, resolution)`

`resolveInputs()` controls the durable lifecycle observed by `InputHandle`: done/unanswered, answer ID, reason, and detail. Generation, post-tools, failure, termination, and abort paths call it only when the corresponding transcript/task transition commits.

An ordinary task calling it could claim another input was answered by a fake entry, abort unrelated requests, or wake waiters before the transcript contains the asserted result. Keep `setInput`, `resolveInputs`, and direct input-table writes core-internal.

## Proxy lifetime requirement

`Proxy.revocable(target, handler)` returns `{ proxy, revoke }`. After `revoke()`, every operation through that proxy throws `TypeError`.

Revoking only the root document proxy is insufficient because a nested proxy can escape first:

```ts
let escaped: object;
await c.commit((tx) => {
  escaped = tx.rewindable(c.id).plugins;
}, ctx);
// Revoking only the root does not necessarily revoke `escaped`.
```

Implement a transaction-scoped **revocable membrane** over the cached Chord tracker:

- every object/array returned from a document proxy is wrapped lazily;
- all wrappers share one active/revoked state;
- preserve object identity inside the transaction with a `WeakMap`;
- mutations forward to the underlying Chord proxy so its tracker still records ops;
- at transaction finish, callback failure, validation failure, or storage failure, revoke every wrapper;
- retained root or nested handles throw after the callback;
- no raw nested Chord proxy may escape through `get`, iteration, descriptors, or array access.

If a correct membrane is too invasive, add tracker-level revocation to Chord so every nested proxy checks one tracker lifetime flag. Do not rely only on documentation or TypeScript to prevent escape.

Tests must retain both a root and nested object/array, mutate them after commit/failure, assert a throw, and prove no later unrelated commit persists the attempted mutation.

## Required hardening

### 1. Fixed registry and token identity

- Install fixed built-ins internally.
- Reject duplicate task-kind names.
- Reject plugin task names beginning with `pi.`.
- A user-supplied `{ core: true }` must confer no authority.
- Use current registered token identity for typed task creation and hook registration; a stale/redeclared token rejects.
- Make hook and registry unsubscribe functions idempotent. A second call must not splice/delete an unrelated newer registration.
- Reject or define replacement semantics for duplicate tool, entry, and section names. Unregister must only remove the exact object it registered.

Tests: attempts to replace `pi.generation`, forge core authority, use a stale token, and unsubscribe twice.

### 2. Capability surfaces and scope enforcement

Keep one `TxImpl`, but expose at most these author-facing capability views:

- **HostTx:** reads; plugin/application document state; passive `write`; create ordinary tasks and conversations. No direct core task creation, entry append, boundary, or input resolution.
- **TaskTx:** reads in the task's conversation/owned subtree; own checkpoint; own typed slot/plugin state; passive write in its own conversation; create ordinary tasks and owned conversations. No admission/boundary/input authority.
- **CoreTx:** internal full authority for fixed turn machinery.
- Abort mode must have its own runtime checks even if its public type is an `Omit`/narrow view.

Runtime authorization must cover every method, not only `appendEntry` and `createTask`:

- `send`, `boundary`, `setInput`, `resolveInputs`, raw core document fields, core task creation, and core entry append are internal;
- ordinary tasks cannot mutate `sticky.inbox`, `sticky.turn`, or another task's slot even via a cast;
- a task may access only its conversation and conversations it owns;
- parent selection for an owned conversation must stay in that subtree;
- host APIs invoke fixed core capabilities through internal tokens, not user-controlled strings.

Add `kind` and an unforgeable invocation token to the internal task invoker. Every runtime commit checks that the token is still the active invocation, the task is live, and an ordinary run invocation is not marked. A captured runtime cannot write after the method returned, after terminalization, or after a durable mark.

Tests must include malicious casts so runtime checks, not only TypeScript, are exercised.

### 3. Prospective task/turn state

Fix `busy()` and boundary decisions to use the prospective state of the current atomic commit.

Concrete failing trace today:

```text
generation terminal closure
→ tx.write(notice)
→ busy() sees the same generation as live
→ notice is queued
→ generation terminalizes
→ no boundary remains to place it
```

When executing a terminal closure, the current task counts as gone. A same-batch terminal `task.patch` also counts as gone; a same-batch created live turn task counts as present. An idle terminal-closure write appends immediately.

Regression tests:

- overflow with nothing collapsible appends its notice and leaves no inbox item;
- an idle job notification appends immediately;
- a same-batch successor generation keeps the conversation busy;
- no input/write becomes stranded when the last turn task terminalizes.

### 4. Display-only assistant entries

Provider-error and aborted partial assistant messages are presentation history only:

- they never enter model context;
- they never create tool work;
- later requests do not include them.

Prefer omitting `model` and storing the display message in strict-JSON `data`, or add an equally explicit non-context projection facet. Do not make `deriveContext` infer this from an arbitrary error string.

Tests: abort/error, send another input, inspect the next provider request, and assert no aborted/error assistant message appears.

### 5. Read semantics

Tracked document reads have read-your-writes inside one transaction. Keep that advantage.

Apply one rule to every read: if buffered writes can change its answer, the transaction must either provide a complete explicit overlay or reject it. Do not silently return committed pre-transaction state.

Maintain complete tx-local overlays for direct object reads:

- `entry(id)` sees same-batch entry creation;
- `task(id)` sees same-batch task creation and every later patch;
- `conversation(id)` sees same-batch conversation creation;
- `input(id)` and request-key lookup see every same-batch input creation/replacement.

These direct reads remain valid after writes. This is required because terminal closures append their result entry and then resolve existing inputs. `putInput` must update both the ID and request-key overlays, not only `writes`/`effects`.

Scan-shaped reads have no general overlay. Reject a scan only after a buffered write that can affect that scan's domain:

- after an entry append: `newestEntry`, `scanEntries`, and `context` reject;
- after a task create/patch: task scans reject;
- analogous future table scans follow the same rule.

Use a named `ReadAfterWrite` error and poison the transaction even if the callback catches it. Refactor the known offenders:

- threshold-collapse selection reads context before appending the assistant and carries the result into the terminal closure;
- `boundary(conversationId, at, headBoundary)` never scans storage: the caller reads the newest head before its first append, or passes the materialized ID of a same-batch self-head entry it just appended;
- while placing queued writes in ID order, `boundary()` updates its local head boundary after each selected head write, so later explicit-head validation sees earlier same-batch heads;
- `send()` performs request-key lookup before writing;
- generation/post-tools compute context-dependent decisions before appending; post-tools passes a same-batch handoff ID as `headBoundary` when it just appended that self-head.

Document reads remain exempt because the tracked proxy supplies an actual overlay.

### 6. Phase-map contract

Keep the phase-map model, but encode phase role rather than relying on comments:

- a normal phase can be reached by a returned `next` transition;
- an in-flight/recovery phase is written immediately before an external effect and is entered by the scheduler only after reopen;
- the scheduler rejects a normal transition into an in-flight-only phase.

A transition builder may atomically return:

- a next checkpoint;
- a typed completion;
- `"retry"` when its snapshot became stale.

Add an explicit `Carry` facility if it removes repeated unchecked destructuring across phase checkpoints. A kind method or terminal closure that returns an invalid shape is a task-contract fault; do not invent an untyped `{ reason: "threw" }` outside the kind's declared failure type.

Retain and expand the existing recovery tests for generation, tool, collapse, job, post-tools, marked tasks, and ordinary custom tasks.

### 7. Session line, failure, and cancellation

- Every storage interaction, waiter registration, watch capture, registry mutation, reservation, and commit enters one FIFO Session line.
- **No `AsyncLocalStorage` / `node:async_hooks`, anywhere.** Nested-line detection uses Chord contexts only: the Session derives a line context for every callback it runs (`withContextValue(LINE_KEY, marker, ctx)` with a private `createContextKey`), passes it to transaction builders (`commit((tx, ctx) => …)`; task builders receive `(tx, current, ctx)`), and `commit`/`read`/`onLine` reject `NestedLineOperation` when the supplied `ctx` carries `LINE_KEY`. Inside a builder, authors use the builder's `ctx` for everything; calling the Session from inside a builder with an outer ctx is a documented, undetectable self-wait, not something the kernel prevents.
- Check caller cancellation before queuing and again before invoking a transaction callback.
- Once persistence starts, call `Storage.commit` exactly once with `withoutAbortSignal(ctx)`.
- A storage commit rejection faults the Session, closes storage with a non-cancellable context, and makes already-queued/later operations reject `Faulted`.
- Callback or validation failure before `Storage.commit` discards the transaction but does not fault the Session.
- Listener, hook-reporting, watch, and scheduler callback failures never turn a successfully persisted commit into a caller-visible commit failure.
- Do not swallow document/tool-stream persistence failures. The current `flushing.then(...).catch(() => {})` pattern must go.
- Enforce one owning Session per Storage object in-process. Successful close/fault cleanup releases it; failed close keeps ownership.

### 8. Waiters

Register waiters atomically on the Session line:

```text
enter line
read current task/input/idle state
if terminal, return immediately
otherwise install waiter
leave line
```

Cancellation only removes/rejects that waiter; it does not cancel durable work. Handle an already-aborted context. Add deterministic tests where completion is forced between the old read and registration points.

### 9. Watch protocol

Keep the rendering-friendly `ConversationView` and Chord document ops, but implement the settled watch behavior:

- capture and subscription are one line operation;
- committed envelopes are delivered in commit order with a contiguous per-watch `revision` (storage `Seq` is not exposed);
- one commit produces one envelope folded into the view before the listener runs;
- listener execution is off-line, synchronous and in order;
- listener throw or decoder failure closes only that watch and reports through `onError`; it never rejects the already-persisted writer;
- envelopes before `start()` are buffered with a bounded capacity (default 256); overflow closes the watch; no other queue exists in the raw watch;
- no cursor, replay, acknowledgement, deduplication, or resnapshot protocol; the client opens a fresh watch;
- `stop`/unsubscribe is idempotent;
- no callbacks after close/stop.

Define the initial entry capture exactly:

- Let `H` be the newest fork-visible entry carrying a head.
- If `H` exists, the active transcript is the chronological union of `H` and every fork-visible entry whose ID is at least `H.head`, without duplicating `H`. `H` remains at its actual chronological position.
- If no head exists, the active transcript is the complete fork-visible transcript in chronological order.
- Capture walks `scanEntries` pages newest-first until it passes `H.head`, using the same fork-aware ancestry walk as `deriveContext`, then reverses the collected entries. There is no public capture limit parameter and no internal fixed cap.

The captured transcript must retain all of the following:

1. fork-inherited entries when `H.head` points into a parent conversation;
2. chronological order—a summary/head entry stays at its written position and is not moved to the front as context derivation does;
3. inner or older head entries that remain inside the active range; unlike model-context derivation, the view does not drop them;
4. display-only entries, including aborted/error assistants, `pi.usage`, and model-less plugin entries;
5. every entry's edits verbatim; the view is the transcript, not the edited/model-message projection;
6. every later committed entry for the lifetime of the watch—there is no live cutoff.

When a committed entry carries a new head, `applyEnvelope` truncates the existing active transcript using this same fork-aware boundary definition and then appends the new entry at its chronological position. It must not apply context derivation's special treatment of heads. A fresh capture and a client that folded every committed envelope must produce identical `entries`.

Add a regression with a child conversation whose newest head points to an entry in its parent and with an older head entry still inside that retained range. Assert that capture includes the inherited target, preserves both heads in chronological order, and equals the result of incremental folding.

The view keeps fixed core fields for rendering. Plugin RPC/presentation DTOs may filter or project it through normal Chord services.

### 10. Storage atomicity and JSONL recovery

No cross-process lock.

MemoryStorage:

- validate the complete batch before mutating, or stage into copies and publish only after every write succeeds;
- one failed batch changes no table, document, ID high-water, or commit sequence;
- stable IDs never reuse once committed; callback-minted but uncommitted IDs may be reused only after reopen.

JSONL multi-file publication:

1. Assign one commit `Seq`.
2. Append and optionally fsync all sidecar records for that `Seq`.
3. Always append one `main.jsonl` record/commit marker last, even if there are no main-table writes. The marker lists the sidecar refs expected for that commit.
4. The main marker is the publication point.
5. Replay uses stored `Seq` values, validates monotonicity/shape, and applies sidecar records only when the corresponding main marker confirms them.
6. Unconfirmed sidecar tails are ignored or truncated.
7. Physically truncate bytes after the last newline before opening for append; otherwise a later append extends a corrupt torn line.
8. Sticky sidecar rewrite/truncate runs on the Session line and cannot race appends. Use temp file + fsync + rename as appropriate, but no directory/cross-process locking is required.
9. Carry committed ID high-water in every record needed to prevent reuse after retired/unlinked sidecars.
10. A malformed complete record fails open; a stale retired task sidecar cannot resurrect state.

Add fault-injection tests for a crash after each sidecar append and before/after the main marker. Graceful `Harness.close()` is not a storage crash test.

Durability modes and failure boundary:

- `fsync: false` covers callback failures, append failures, and process termination while the OS/filesystem remain alive. Complete published records recover; torn final lines are truncated; unconfirmed sidecar tails roll back.
- `fsync: false` does **not** promise that a returned commit survives power loss, kernel/VM-host failure, storage-cache loss, or a filesystem that loses or reorders completed writes.
- Worst case without fsync: acknowledged tail commits disappear. If sidecars survive without their marker, replay rolls them back. If a marker survives without a required sidecar, open fails rather than exposing a half-commit. If the lost commit was a pre-effect tool/job checkpoint or memo, recovery may attempt the external effect again; external idempotency is still required.
- `fsync: true` flushes each sidecar before flushing the main marker, strengthening file-data durability and ordering. It is not a complete database guarantee until parent-directory metadata for file creation, rename, and unlink is also synchronized, and it cannot strengthen a filesystem or device that provides weaker guarantees.

### 11. Terminal task retention

Remove `pruneTerminal` behavior that makes terminal tasks unreadable. `getTask`, `waitForTask`, task scans, dependencies, and typed outcomes must continue to work after arbitrary later activity and reopen.

Reduce retained size by:

- clearing terminal checkpoints when safe;
- storing compact complete terminal records or validated patches;
- unlinking live-only task sidecars after the terminal record is durably published.

Do not infer that every outcome is represented by an entry: job and plugin task results are not.

### 12. Strict durable types

Harden durable positions without rebuilding V2's entire address type system:

- `JsonValue` only; no durable `unknown`;
- `Stored<T> = JsonRepresentation<T>` for imported pi-ai values;
- stored entries/messages/tool calls/usage/deferred handles use `Stored<T>`;
- task input/checkpoint/result/failure/aborted values extend strict JSON;
- tool details, plugin inputs/results, document/plugin state, section payloads, and process state are validated/encoded before persistence;
- readonly durable snapshots at public boundaries;
- no `any`, no inline/dynamic imports, erasable TypeScript;
- use the repository's pinned `typebox` 1.x API after checking its installed types; do not use `@sinclair/typebox` 0.34;
- `ToolDeclaration.execute` receives `Static<P>` rather than `unknown` plus author casts;
- replace `never`-parameter registry erasure and unchecked casts with a small internal erased adapter whose validation boundary is explicit.

Make the standalone `tsconfig` portable: no `/home/claude` paths, exclude design-history sketches from production type checking, and include a real compile-test command. Remove unused `partial-json` if it remains unused.

### 13. Config, documents, and plugin state

Keep fixed core document fields and the flat typed `c.config` facade.

- Derive/seed defaults from registered kind definitions rather than duplicating them in `defaultRewindable`/`defaultSticky` and kind configs.
- Resetting a key is an explicit operation (`config.reset(keys)`; RPC `configReset`), never assigning `null`: storage deletes the override, the resolved view sets the declared default; only `model`, which has no default, is deleted from the view.
- Do not use `value ?? default`, because durable `null` is a legitimate value. Test property presence.
- Custom kind config defaults must be visible both through `c.config` and to the task itself before any explicit set.
- Reject config-key collisions at compile time where practical and always at installation.

For plugin state, first implement typed/namespaced slices inside the existing documents instead of recreating arbitrary value/list addresses:

```text
session.plugins[pluginId]
rewindable.plugins[pluginId]
sticky.plugins[pluginId]
```

At minimum, associate an owning namespace/type with a plugin or task-kind token so typos and cross-plugin writes are not silently accepted. If a plugin has large independent state, support a plugin-declared extra document shard using the same Chord fold semantics; do not add this complexity without a test demonstrating the cost/isolation need.

Associate a task slot type and initializer with its task-kind witness. `TaskRef<K>` should determine the slot type; remove caller-invented `slot<T>()` casts. Core turn/tool slots remain fixed and rendering-oriented.

### 14. Context, transcript, and sections

Preserve the current centralized context derivation and full system-section design:

- head/range/edit chronology;
- newest edit wins;
- tool results reordered to call order;
- missing fork-truncated results synthesized;
- messages-only requests;
- managed `pi.system` baseline/delta chronology;
- preparation snapshot/retry loop;
- historical tool additions/removals;
- section seeds before first preparation.

Fix and test:

- transcript/head invariants before persistence;
- display-only assistant exclusion;
- complete active transcript capture;
- private conversation section-seed metadata (do not expose it in public `ConversationView`);
- `SystemEntry` typing permits metadata-only `model: []` deltas;
- ancestry/subtree hook reconstruction after reopen;
- registry changes are line-serialized and preparation revision checks remain correct.

### 15. Tool and process behavior

Keep `ToolInput.offered` and the persisted final validated call. Recovery from `started` requires persisted-safe, current-safe, and current-schema-valid evidence; `beforeTool` never reruns after `started`.

The V3 tool API is a candidate, now no longer an unspecified gap, but harden it:

- `beforeTool` runs before `started`; a throw blocks;
- kernel owns bounded streaming;
- fix tail retention so a single chunk larger than `maxBytes` is sliced during `push`, counted as dropped, and never retained whole;
- enforce both byte and line bounds for streaming and returned content;
- no swallowed flush errors;
- a tool cannot mutate call identity or protected turn fields through `progress`;
- the final tool-result message is bounded and strict JSON;
- use the stored final call consistently for invocation/recovery evidence;
- preserve fixed five-second job TERM-to-KILL grace, optional `ProcessHost`, and polling capped at one second.

### 16. Known implementation defects to cover

Also fix these concrete issues found during review:

- `Harness.waitForIdle` has the same check-then-register race as input waiters.
- Reopened owned-conversation ancestry is reconstructed incorrectly by looking for a conversation whose ID equals the owner task ID.
- Listener invocation can currently throw after persistence and reject the writer.
- Scheduler drain/abort errors can become unhandled rejections.
- Ordinary kind throws currently manufacture a failure outside the declared failure type.
- `createConversation` and document access omit subtree validation.
- Hook matching by name accepts stale tokens.
- `config.get` treats stored `null` as absent.
- custom kind defaults are returned by `c.config` but are not necessarily present for task document reads.
- `SystemEntry` witness requires one model message although metadata-only deltas use none.
- JSONL replay ignores recorded sequence values.
- sticky truncate currently runs outside the line.
- use `rt.now()` rather than ambient `Date.now()` in kind-controlled durable records where determinism/testing matters.

## Required test matrix

Retain all existing behavioral and recovery tests, then add focused regressions for every numbered hardening section. At minimum, the final report must show:

1. runtime tests for memory and JSONL;
2. strict TypeScript compile tests for public capability surfaces, kind/config/hook/task-ref/slot inference, and strict durable JSON;
3. fault-injected JSONL atomicity at every publication cut;
4. escaped root and nested proxy rejection;
5. stale invocation and post-mark commit rejection;
6. malicious ordinary-task attempts against every core-only operation;
7. waiter and idle-registration race tests;
8. ordered/gap-free watch capture, listener throw, overflow, stop, and reconnect tests;
9. display-only assistant and terminal-closure write regressions;
10. terminal task lookup after many retirements and reopen;
11. real TypeBox validation tests;
12. the existing generation/tool/post-tools/collapse/job/subagent crash matrix.

Tests must not use real providers, API keys, or paid endpoints. Fake models and process hosts only.

## Deliverable

Return a new zip containing:

- the hardened standalone implementation;
- portable `package.json` and `tsconfig.json` with pinned dependencies;
- all runtime and compile tests;
- updated README and usage guide describing the fixed-core/document/phase design and explicit single-process assumption;
- a concise `CHANGES.md` mapping every item in this handoff to code/tests;
- production LOC count excluding storage backends and tests;
- exact commands and results for install, typecheck, and tests;
- unresolved questions or deliberate deviations, with no silent omissions.

Do not modify `packages/agent/src/harness/pico` or the approved V2 files. The returned zip will receive another independent review before incorporation as `packages/agent/src/harness/pico3`.
