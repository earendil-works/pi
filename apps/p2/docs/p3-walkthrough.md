# p3 / Chord v2: the whole target design as a walkthrough

A reading aid for checking completeness, not a new source. Sources: `redesign-decisions.md` (wins on conflict),
`target-design.md`, `questions.md`, `plugin-loading.md`, `p3-functions/`, `changes.md`. Marks: **[D]** decided,
**[B]** built in today's Chord, **[S]** superseded by a later decision, **[O]** open, **[P]** proposed, not decided.
Section 17 lists conflicts between the documents found while writing this.

---

## 1. Plan

- **[D] p3 next to p2**, as `apps/p3`, own data directory. p2 keeps running unchanged. Plugins are ported one at a time.
- **[D] No migration** of p2 data: p3 starts empty (no `seed`, no catalog/shares/subagents import, no legacy parsing).
- **[D] Chord v2 lives inside p3** until stable, then moves to `packages/chord` (pi first, CI) and p2 is deleted.
- **[D] Durable boundary:** Durable keeps importing today's Chord (`delta`, `context`, `output`); p3 hands Durable only
  plain data and Durable's own types. Chord v2 takes `delta`/`output` over unchanged. `OutputBuffer`/`Progress` already
  moved to `@earendil-works/chord/output` [B].
- **[D] No backward compatibility** anywhere unless asked.
- **[D] Approach:** functionality first (`p3-functions/`: 22 domains), then objects per domain (owner, host,
  pure/native, relationships), then target design v2 written from the decision log, then reviewers judge it.

## 2. Concepts

| concept | what it is |
|---|---|
| facet | a plugin's code for one host kind; its setup is a **pure** host-lifetime object [D] |
| object type | contract: name, input (address), variants, version, host [B] |
| object | one instance per (type, input, principal key) |
| principal | who calls; stamped by links, typed by the app [B] |
| reference | what `get` returns; keeps the object alive; live and hydrated [B] |
| document | named JSON value an object owns, written in transactions |
| derive | value computed from documents/readables |
| native | a value opened with `self.open` in an object (socket, process, DB handle) [D] |
| routine | standing behaviour, `self.routines.*` |
| job | owned work started by a method, outlives the call |
| registry | an owner's extension point, versioned immutable table |
| host value | typed native the host provides before facets load |
| `ctx` | per call: signal, principal, call-scoped `get`; in jobs `jobId`, `progress` |

## 3. Object types and principals [B]

- `local` (same host, unvalidated) or `remote` (over links, variants per principal, TypeBox-validated).
- `host` declares placement (`hostNamed`, `hostFamily`); changing it is breaking. Callers don't pass `at`.
- Same version binds if the provider covers the caller; breaking change bumps `version`; `accepts: { [old]: adapter }`
  keeps old consumers, else `contract_mismatch`.
- References are a union discriminated by `variant`; strict narrowing with `inVariant` / `expectVariant` / `RefIn`
  (entry 8). Weakening type checking was rejected.
- Principals: `createHost<P>()`, every principal has a `kind`. p2: `owner` (`access: local | relay | device`),
  `guest`, `worker`, `server`, `host`. State `init` (2b). Origin ids per client (entry 8). Protocol 4.
- `host.serve(Type, factory, { lifetime: "referenced" | "host", linger? })`; `"host"` checked by types [B].

## 4. Factories, natives, the facet [D]

- **Factory principle:** a factory is synchronous and only declares (references, documents, natives, derives,
  routines, jobs, registrations). Chord activates. Handles it gets are valid for the object's whole life.
- **Natives only in objects:** `self.open(async ({ signal }) => value, close)`. Chord opens during activation (object
  goes live after all opens), closes in reverse order when the object ends. The value never changes during the
  object's life.
  - Gone [S]: `self.resource`, resource `version`, `replace`, `deps`, reopen, stale handles, "read `.value` at use"
    (target-design §12).
- **No natives across plugins:** others reach a native only through the owning object's methods and state.
- **The facet is a pure object:** documents, references, routines, registrations; no `self.open`. Served objects may
  read/write the facet's documents; one transaction may span own docs + facet docs (lock order: own line, then
  facet). The facet may not reach into served objects' documents.
- Between plugins only: object types, registries, host values.
- Rejected: ceremony (`native/` dirs, `defineNative`, lints).

## 5. Ownership [D]

- Every thing has exactly one owning object, the smallest it belongs to. The owner holds the data, enforces rules in
  its methods, offers operations. Nobody reaches past it.
- Ownership nests: session owns its conversations and location; a conversation owns its content and rules (read-only,
  follows session cwd), set in the creating commit (Durable `createConversation` with `init`).
- Methods return data; objects are handed out as addresses (`ctx.get(Type, address)`).
- Registries add behaviour (tools, routes, renderers, commands, send routers, input gates); never guard owned data.
- Core owners always exist; plugin owners may be missing (→ optional references [O]).
- Avoid a core god object.
- **Porting guideline:** what core enforces on data lives in a format core owns, written by the plugin at creation.
  Example: one-shot / cwd-following children marked in a core per-conversation policy document; `ReadOnlyConversations`
  and `SessionCwdFollowers` go away.

## 6. References

- [B] `self.get` (factory, released with the object), `await ctx.get` (call), `host.get`/`host.hold` (outside).
- [B] Awaited reference is live and hydrated; `state: false` for method-only use.
- [B] Link drop: values stay (`loading`), re-hold automatically, calls wait.
- [D] Failed object ends its references with the cause; consumers re-hold with backoff (web gets the TUI's backoff
  instead of fixed 500 ms).
- [D] **Backoff per address** (1 s doubling to 60 s): a `get` during backoff returns the stored error; concurrent gets
  share one attempt. Cut short by: plugin reload, a dependency of the failed attempt changing, `ref.retry()`,
  `self.retryOn(...readables)`.
- [D] Consumers handle errors as on a disconnect. No call/request-id framework (Chat's `requestId` stays).

## 7. Documents and transactions [D]

- `defineState(name, { schema, version, initial, migrate?, keyed?, persist?, checkpointWhen? })`.
- `self.state(Def)` → one handle. Singleton: loaded at activation, `handle.value` sync, exposable readable. Keyed:
  `await handle.get(key)`, `for await (key of handle.keys())` (paged from storage). No live key list; live collections
  are singleton docs; large ones are paged methods.
- Writes only via `await tx.draft(handle, key?, { tags? })` in `self.tx(ctx, async tx => …)`; `tx.retire`.
- **Durable's rule:** inside a tx only `await tx.*`; no other objects, models, processes, network, nested tx. Fetch
  before; decide inside.
- Commit: per-object line; storage batch serialized per host; adopt; notify once; one wire batch.
- Shorthands: `handle.change(ctx, key?, fn)`, `handle.retire(ctx, key?)`.
- Versions: pure `migrate`, on access; old code on newer doc throws; no `migrate` → access refused, data kept.
- Tags: typed (`defineTag<T>`), set explicitly on create; `store.retireByTag`. p2 `SessionTag`.
- Lifetime: in-memory docs live with their object identity; persisted until retired / session delete.
- `persist` only on stable identities (`lifetime: "host"` or `storeKey(input)`).
- Rejected: optimistic transactions; Durable's Session as object store; volatile documents.

## 8. Store and storage [D]

- Chord owns the store: lines, serialized commits, migrate on access, `checkpointWhen`, retire, tags, invariants.
- Eviction as in Durable for keyed persisted docs (10 min unused and unwatched; LRU, one timer).
- Storage error ends the store; host reports and restarts.
- `DocumentStorage` interface (`commit`, `find`, `load`, `scan`, `byTag`, `mintId`); memory implementation in Chord;
  p2/p3 adapts Durable's SQLite `Storage` (`kind = <definition>.<objectHash>`); tag index in the adapter.
- Conformance suite in `@earendil-works/chord/testing`.
- Persistence split: app state in Chord documents; only transcript-bound data in Durable.
- Kinds of state: document, derive, source readable, paged method, plugin database (as a native).

## 9. Derives [D]

- `self.derive(name, sources, (values, previous) => …)`; `previous` kept across factory re-runs by name.

## 10. Jobs [D]

- `defineJob(name, { version, args, progress, result, concurrency?, persist?, accepts? })`.
- Sandwich: **intent** `tx.start(job, args, { key? })` (busy check and dedupe atomic, run starts after commit) →
  **run** `run(args, ctx)` (anything; external writes keyed by `ctx.jobId`; keeps old code on reload) → **finish**
  `finish(outcome, tx)` in current code, ack in the same commit; retried with backoff if it throws.
- Outcome `{ ok, result } | { ok: false, error: threw | aborted | lost }`.
- `job.start(args, ctx, opts)` returns a run with `outcome(ctx)`; caller's abort ends only its wait.
- Abort is a request (`job.abort(id)` fires the signal).
- `running` readable `{ id, version, args, progress, phase }`; `concurrency` counts active runs; `phase: finishing |
  blocked`.
- Versions via `accepts`; stored outcomes never rewritten; missing adapter → `blocked`, not a refused reload.
- `persist: true` (stable identities): a live run at crash ends `lost`.
- Running jobs count for keep-alive and the relocation fence.
- Not jobs: request/response (method), input into running work (Questions), crash-resumable work (Durable task).
- [O] jobs as objects with an "until done" lifetime.

## 11. Routines [D]

- `self.routines.on(readable|event, fn)`, `every(name, interval, fn)` (due time survives reloads), `loop(name, fn)`,
  `custom(name, setup)`.
- Start when the object goes live, stop when it ends, restart on reload of its plugin; serialized per routine (new
  instance waits for the old handler in flight, with a deadline).
- Reconcile from current value; no "in progress" flags; long work → job.
- No bare timers/callbacks outside routines, jobs or calls.
- [O] `overlap: "latest"`.

## 12. Registries and host values [D]

- `defineRegistry<V>(name, { version, accepts, conflict: "error" | "last" })`; facet registers; entry carries its
  build version; tables are immutable values swapped atomically; no late binding; no lifecycle in entries.
- `hostValue<T>(name, { version })`, provided before any facet on every host (worker: harness, environments, init,
  location, liveness, cwd followers; server: session hosts, server info, revocation; web/TUI: navigation, theme,
  clipboard). Replace `opaque` members.
- **Start barrier:** open Durable without scheduling → host values → load facets → check cwd/model → `resume()`.
- Rejected: late-bound entries, dynamic registries.

## 13. Reload [D]

- Explicit (`npm run reload -- <plugin>`), never on save. Behaves like a restart of the changed plugins.
- **Per host:** load (bundle; error rejects) → **staging** (facet setup and every live object's new factory with a
  recording `self`; nothing activated; a throw rejects) → **commit** (atomic) → after.
- **Rollback all-or-nothing per host:** any load/staging error leaves the host entirely on previous code. Status per
  host suffices.
- **Pure objects** swapped in place: new methods and derives; documents, references, jobs stay; routines restart
  serialized; new references go live; gate opens. Running calls finish on old code.
- **Native objects of the reloaded plugins restart:** running work aborted (`aborted`), natives close, factory runs,
  natives reopen. No per-module digest; split expensive natives into their own plugin. Open fails → that object
  `failed` with backoff; rest of host on new code.
- **Remote consumers** see a normal brief object restart: `loading`, values readable, calls park, re-hold; calls on the
  old instance end with an error.
- Errors: code errors (load, setup, factories) → rollback; activation errors (opens, new references, migrations) →
  per object; a method bug → that call.
- No factory trial, no migrate dry run, no consumer contract check during prepare.
- Removing a type: its objects end; in-memory docs go; persisted docs stay.
- Rejected: drain-based handover, version fences, `restart_required`, reload votes / cross-host transactions,
  revoking proxies on `.value`.

## 14. Rollout [D]

- Revision = (server incarnation, sequence) over the complete desired code set (every facet + digest).
- Server installs, then each worker, then clients; each reports `installed` / `installed_failed` / `rejected`. A
  starting or reconnecting host installs the current revision before anything is routed to it. Installed = code
  published (objects activate on demand).
- Mismatch responses carry the provider's revision and status: provider ahead or installing → `updating` (values
  readable, calls park); provider rejected → fail fast; same revision → `contract_mismatch` final. Deadline on waits.
- Server rejects → rollout stops.
- [O] check own host's status before waiting; serialize installs per host; digest of the code set (no reinstall after
  a server restart).

## 15. Wire, presence, Questions, ctx

- **Wire [D]:** documents are state members; `snap` on hold, `ops` per commit, diff ops for derives, throttled job
  progress, `reset` for migration, `error`. Commits atomic for consumers: one `state` frame with a `batch` per hold.
  [O] atomic per link, diffed ops for adapted bindings, size limit.
- **Presence [D]:** `host.references(Type)` readable (input, principal, clients); origin ids per client; **linger bit**
  (lingering keeps the worker alive, not a viewer). Replaces presence/viewer/login-abandon leases.
  [O] link drop counts as lingering; counts per origin.
- **Questions [D]:** p3 service for input into running work: shared store, per-principal asker/viewer views, typed
  questions (text, select, confirm), policies first/quorum/all over a live audience, `key` to reattach, deadline,
  authorization per question, secrets redacted. Used by login, tool approval, question tool.
- **ctx [D]:** `signal`, `principal`, `get`; in jobs `jobId`, `progress`. No code versions, no root ids.

## 16. Bytes and session files

- **[D] Bytes are a schema type** (`Uint8Array`): structured clone on IPC (`serialization: "advanced"`), binary frames
  on WebSockets. No base64 in JSON. Lives in Chord v2 inside p3 (not added to today's Chord).
- **[D] Large transfers chunked by the owner:** `begin` / `append({ upload, offset, bytes })` / `finish`,
  `read({ id, offset, length })`, ~1 MiB chunks; awaited `append` is backpressure; resume from stored offset after a
  link drop; unfinished uploads expire. Helper wraps the loop. No stream type in Chord.
- **[P] `SessionFiles {session}`** on the server: one owner of uploads (25 MiB, ≤20/message), sent-file snapshots
  (25 MiB), artifact versions (2 MiB, name + version); index readable without a worker; bytes under
  `<data>/sessions/<id>/files/`; copy on clone and fork, delete with the session. Not in it: workspace downloads
  (streamed), shell/codemode spill (in the env). `DownloadStore.save` (unused) goes.
  Pending sub-points: one preview limit (256 vs 512 KiB); fork's artifact list empty or copied; copying attachments
  into the remote env.

## 17. Session lifecycle [D]

- Archive retires nothing (stops the worker, ends guest access, closes forwards).
- Session delete (new) removes the whole session: tagged documents, the worker's database and document storage,
  files, catalog entry. [O] how: `SessionDeleted` registry vs. per-session objects + `SessionTag` + session directory;
  search index per session vs. global + hook.

## 18. Versions and adapters

| surface | on change |
|---|---|
| object type | `accepts` adapter, coverage check [B] |
| registry | `accepts` adapter |
| host value | `accepts`; harness refused on mismatch for now |
| document | pure `migrate` |
| job | `accepts` on outcomes and `running` |
| native | object restarts on reload (no version) |
| Durable tasks/docs | Durable `migrate` [B] |
| link protocol | refused; hosts update together [B] |
| UI components, API | exposed as they are; versioned with the SDK later |
| [O] file formats (`envs.json`, …) | unversioned today |

## 19. Plugin loading (`plugin-loading.md`, revision 4)

- Sources: built-in, global (`<data>/plugins`), global packages (npm/git, `--ignore-scripts`), project
  (`<cwd>/.pi/p2/plugins`, worker/web/tui only, never server).
- Discovery = directory listing, never parses code; server selects, workers scan nothing; dependencies resolved by
  contract name at runtime; missing provider fails at activation with the consumer's name.
- Names: `<plugin>.<name>` for contracts, registries, Durable extensions, entry kinds; tools `<plugin>_<name>`.
- Loader D: one base bundle per surface + one script per facet, host packages passed in, no module map (GC reclaims old
  generations); stable filename per (facet, digest), V8 compilation cache off. Vite removed after web D.
- Project trust: `trust.json` per directory, `ask`/`never`, pin-to-content mode; content-addressed snapshots; approved
  bytes = executed bytes; change → dirty → owner Reload. Project `.pi/skills`/`.pi/prompts` gated too.
- Scopes: a page/TUI worker holds one scope; `ClientBundle` pushes bundle hashes; TUI snapshots partitioned per scope.
- Leaving a scope: provenance map, fallback renderers, blocked tasks with Abort.
- Security table: trusting a project grants the owner's OS account and owner rights in the browser.
- Contracts are a versioned package, never host packages.
- [O] base skills on remote sessions; publishing; plugin identity across projects; guest opt-in; project root; browser
  compile cache. Project plugins as a whole: separate discussion.

## 20. Functionality map (`p3-functions/`)

22 domains; cross-cutting needs (one file store, per-session lifecycle, readers without workers, generation-fenced
reports, catch-up after commits, work outliving its caller, request-id idempotency, cancellation chains, keep-alive vs
presence, execution env following the session, single config writer, attribution, one permission matrix, revocation,
chunked bytes, one notice channel, UI state survival, TUI consent); ~25 duplicates; ~18 drop candidates.

## 21. Open (all)

- Optional references (a plugin owner may be missing; radius dies without ports today).
- Keep-alive computed by the worker itself.
- UI renderer reload vs. leaving (login aborted, TUI overlays close).
- File formats as versioned interfaces.
- Terminal host process as a revision artifact.
- Durable documents shared across plugins.
- Session delete mechanics (section 17).
- `close` with a reason (`reload` / `end` / `stop`).
- Call-scoped natives.
- Async activation guard for authority-carrying addresses.
- Invariants across several owners.
- Published projections with a generation fence.
- Connection pools; config files with a single writer.
- Rollout fixes (section 14); wire; presence; `overlap: "latest"`; project plugins; jobs as objects.
- Step 2 objects for every domain, starting with `SessionFiles`.

## 22. Tracked, not scheduled (`changes.md`)

- Leaks C3 (Chord kept listener), C5 (p2 guard listener per reload), C7 (harness keeps envs `close`); rerun GC tests.
- p2 hazards on interrupted calls (shell timer, dedupe in a closure, withdrawn text only in replies, web send while
  disconnected, missing request ids, dropped terminal keys, multi-step revocation/relocate/clone).
- Durable nested commits hang by convention only.
- #10959 (remote references accept a foreign ctx), owner fixes via subagent.

## 23. Rejected (all)

Drain-based handover; version fences without transactions; object restart for state changes; Durable Session as object
store; volatile documents; per-group lines; generic call/request ids; optimistic transactions; outbox for transient
delivery errors; revoking proxies on `.value`; late-bound registry entries; dynamic registries; `restart_required`;
detached references counting toward presence; contracts taken from the running p2; ceremony (`native/` dirs,
`defineNative`, lints); weakening type checking; "magic" input-field matching for delete; factory trial; migrate dry
run; consumer contract check during prepare; reload votes; `defaultProjectTrust: "always"`; loader variants A and B.

## 24. Conflicts found between the documents

1. `target-design.md` §15 and `plugin-loading.md` 7.5: "a facet whose setup throws keeps its previous version while the
   rest of the host moves on". The decision log replaced this with all-or-nothing rollback per host.
2. `questions.md` keeps its store in a facet `self.resource`. Facets may not open natives now, and `self.resource` is
   gone: the store must move into an object (e.g. a host-lifetime `QuestionStore` with `self.open`, or plain documents
   if in-memory is enough).
3. `target-design.md` §5 example (`self.resource` in the facet, `deps`) and §12 (resources replaced in place) are
   superseded by `self.open` in objects.
4. `target-design.md` §7 "handles belong to their code generation ... `stale`" assumed in-place resource replacement;
   with pure swap and native restart, whether old-generation handles still need `stale` is unclear.
5. `plugin-loading.md` 9.2a gap list mentions `opaque` members and unversioned registries; both are addressed by host
   values and versioned registries.
