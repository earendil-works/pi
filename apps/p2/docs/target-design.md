# Chord and p2: target design (superseded)

**Superseded by `packages/chord/docs/design.md` (target design v2).** Kept for its history and reasoning.

Replaces the previous target design (drain-based handover, fences, code versions) and the proposals
`object-state.md` and `reload-fence.md`. Decided with the owner; `changes.md` keeps the per-entry history and the parked
work. Marks: **B** built today, **T** target.

**Superseded in part:** `redesign-decisions.md` records later decisions (p3 next to p2, natives only in objects, the
facet as a pure object, rollback per host, restart of native objects on reload). Where they conflict, it wins; target
design v2 will merge both.

Goal: fewer concepts for plugin authors, no distributed reload machinery, in-place reload of every plugin change on
every host (server, workers, browsers, TUI) without restarting it, remote objects with principals, plugins that keep
working across p2 versions.

---

## 1. Principles

1. **Objects are behaviour; documents hold their data.** Writes are transactional (Durable's semantics).
2. **A reload swaps code; it does not wait for running work.** Running calls and jobs finish with their old code, as
   Durable phases do. Old code that touches data it no longer understands throws; nothing partial lands.
3. **A version says when shapes or meaning change.** Same version: old and new code may share data and natives. A
   raised version migrates documents or replaces natives.
4. **Interfaces between independently versioned parties have versions and adapters** (object types, registries, host
   values): the owner adapts older consumers; anything else fails at load with a clear error.
5. **A reference you hold is usable**, local or remote: live and hydrated. Consumers see errors only as they would on a
   disconnect.

## 2. Concepts

| Concept | What it is |
| --- | --- |
| facet | a plugin's code for one host kind; its setup is an anonymous host-lifetime object |
| object type | a contract: name, input (the address), members, version, host |
| object | one instance per (type, input, principal key) |
| principal | who calls; stamped by links, typed by the app |
| reference | what `get` returns; keeps its object alive |
| document | a named JSON value an object owns, written in transactions |
| derived value | computed from documents or other readables |
| resource | a named native value (socket, process, database handle) |
| routine | standing behaviour (`self.routines.on/every/loop/custom`), restarted on reload |
| job | owned background work started by a method, running until it is done |
| registry | an owner's extension point: a versioned table of contributions |
| host value | a native value the host provides to facets |
| `ctx` | per call: cancellation, principal, call-scoped references |

## 3. Object types (B)

```ts
export const Notes = remote("notes", {
  version: 1,
  host: hostFamily("session:", "session"),
  input: Type.Object({ session: Type.String() }),
  variants: {
    reader: { state: { notes: NotesSchema } },
    editor: { state: { notes: NotesSchema }, methods: { add: method(AddArgs) } },
  },
});
```

- `local` (same host, not validated) or `remote` (over links, variants per principal, validated).
- `host` declares where the type lives (`hostNamed`, `hostFamily`). A placement change is a breaking change.
- Same version binds if the provider covers the caller (additive changes need no bump). A breaking change bumps
  `version`; `accepts: { [old]: adapter }` keeps older consumers working; otherwise `contract_mismatch`.
- References are a union discriminated by `variant`; other variants' members need narrowing.
- Members are data and methods; `opaque` members go away (T: host values instead).

## 4. Principals (B)

`createHost<P>()`; every principal has a `kind`; the app supplies its own principal (`self`) and the parent's
(`connect`). p2: `owner` (`access: "local" | "relay" | "device"`), `guest`, `worker`, `server`, `host`.

## 5. Facets and objects

```ts
export default defineFacet((host, self) => {
  const db = self.resource("db", { version: 1, open: () => openIndex(host.value(PluginData)) });
  self.register(Routes, "GET /notes/export", (req, res, access, ctx) => exportNotes(db.value, res));
  host.serve(NoteStore, ({ session }, _principal, self) => ({ /* … */ }));
});
```

- The facet's setup is the factory of an anonymous host-lifetime object (T). It declares documents, resources,
  routines, jobs and registrations and serves the plugin's types. Factories only declare and run again on every reload.
- Served objects go live after the facet object and may share its resources through the closure. A resource built from
  another resource lists it in `deps`, so it is reopened after a replacement.
- The facet object never `self.get`s a type its own facet serves, nor a remote type (cycles are refused at load).
- `api.serve` and registrations are valid only while the setup runs.
- `host.serve(Type, factory, { lifetime?, linger? })`: `"referenced"` (default) or `"host"` (local, no required input,
  checked by the type system, B).
- Between plugins: object types, registries and host values only. No natives across plugins.

## 6. References (B)

| Where | API | Released |
| --- | --- | --- |
| factory | `self.get(Type, input)` | with the object |
| a call | `await ctx.get(Type, input, { state? })` | when the call ends |
| outside | `await host.get(Type, input, { signal?, state? })` or `host.hold(...)` | `release()` |

- An awaited reference is live and every state member of its variant is hydrated; `state: false` for method-only use.
- A link drop keeps the values (`loading`), re-holds by itself, and calls wait meanwhile.
- An object that fails (section 12) ends its references with an error carrying the cause; consumers re-hold with
  exponential backoff (T: web gets the TUI's backoff instead of a fixed 500 ms).

## 7. Documents (T)

```ts
const Settings = defineState("settings", {
  schema: SettingsSchema,
  version: 1,
  initial: () => ({ theme: "dark" }),
  persist: true,                                    // default: in memory
});
const Draft = defineState("draft", {
  schema: DraftSchema,
  version: 2,
  migrate: (old, from) => ({ body: old.text }),     // pure
  initial: () => ({ body: "" }),
  keyed: true,                                      // many per object
  persist: true,
  checkpointWhen: (value, ops, info) => info.deltasSinceBase > 50,
});

host.serve(DraftStore, ({ session }, _p, self) => {
  const settings = self.state(Settings);           // handle: THE settings document
  const drafts = self.state(Draft);                // handle: all Draft documents of this object
  return {
    settings,                                      // a singleton handle is a readable, exposable
    get: ({ conversation }) => drafts.get(conversation),             // async; missing → undefined
    save: ({ conversation, body }, ctx) =>
      self.tx(ctx, async (tx) => {
        const d = await tx.draft(drafts, conversation, { tags: [SessionTag(session)] });
        d.body = body;
        return d.body.length;
      }),
    drop: ({ conversation }, ctx) => self.tx(ctx, async (tx) => tx.retire(drafts, conversation)),
  };
});
```

- **Ownership:** a document belongs to exactly one object identity (type, input, principal key), across all its
  instances. Other objects see it only through exposed members. Documents are JSON; references to other objects are
  stored as data.
- **Handles:** `self.state(Def)` in the factory returns the one handle used for everything. Singleton (`keyed` absent):
  loaded at activation, kept in memory while the object lives, `handle.value` is synchronous and the handle is an
  exposable readable. Keyed (`keyed: true`): documents addressed by a short key local to the object, loaded on demand;
  `await handle.get(key)` reads one (creates nothing), `for await (const key of handle.keys())` lists keys page by page
  from storage (not a snapshot). There is no live key list: a collection shown live is a singleton document (an array
  or map); large collections are methods with pages.
- **Writes:** only `await tx.draft(handle, key?)` inside `self.tx`, which creates the document with `initial()` if it
  is absent; `tx.retire(handle, key?)` removes it. `keyed` makes the key mandatory at type level. Drafts record ops
  (assignment, `push`, `Object.assign`); the same document returns the same draft within one transaction. A
  transaction may also just read several documents consistently and return a value.
- **Transactions:** wait for the object's line (per object, never across objects); run the callback; an error or an
  abort before the storage write discards everything; prepare every draft, write persisted documents in one storage
  batch (serialized per host), adopt, notify local subscribers once and send one batch on the wire; drafts then
  throw. **Durable's rule:** inside the callback only `await tx.draft(...)`; no other objects, no models, processes or
  network, no second `self.tx`, no reads past `tx` (otherwise a hang, not an error). Data from other objects is fetched
  before the transaction. A decision that leads to a write is made inside the transaction.
- **Versions:** a shape or meaning change raises `version` with a pure `migrate`. A document migrates on access by
  the new definition (in memory too, as Durable's `valueVersion`), and the migrated base is persisted with the next
  commit. Old code whose definition is older than the document throws on access. Without `migrate` the access is
  refused and the data kept. A changed meaning without a bump cannot be detected. Handles belong to their code
  generation: a subscription made through an old handle (a job of the old code watching the document) ends with
  `stale` when the document migrates, instead of delivering the new shape.
- **Tags:** typed tokens (`defineTag<T>(name)`), set explicitly on create (`tx.draft(handle, key, { tags: [...] })`),
  not derived. `store.retireByTag(tag, value)` retires every document with that tag. p2 defines `SessionTag`; plugins
  set it on documents that go away with a session.
- **Lifetime:** in-memory documents live as long as their object identity and are never evicted; long-lived objects
  that create many keyed in-memory documents retire them themselves. Persisted documents stay on storage until
  retired or deleted with their session.
- **`persist` only on stable identities:** objects with `lifetime: "host"` or types that declare `storeKey(input)`.
  Principal keys contain the worker generation and the owner's access path, and clone and fork copy session ids, so
  other identities are not stable.
- **Session delete** (new; archive retires nothing): `serverStore.retireByTag(SessionTag, id)`, then the worker's
  session database and document storage, then the catalog entry.

## 8. Kinds of state (T)

| Kind | For | API |
| --- | --- | --- |
| document | data the object owns | `self.state`, `self.tx` |
| derived | computed values | `self.derive(sources, fn)`, recomputed and diffed |
| source readable | external data (Durable, files, logs) | value plus changes, atomic; via `derive` |
| paged method | large or queryable collections | a method returning pages (Chat's history) |
| plugin database | full-text search, large blobs | a resource at `host.value(PluginData)` |

**Persistence split:** app state lives in Chord/p2 documents; only what is tied to the transcript (entries,
conversation documents that fork and rewind with it) belongs in Durable's storage.

## 9. Store and storage (T)

- **Chord owns the store:** lines per object, storage commits serialized per host, migrate on access, `checkpointWhen`,
  retire, tags, publications, and the storage invariants (create before change, no change after retire, ids from
  `mintId`, `deltasSinceBase`, the current incarnation per address). **Eviction as in Durable**, for keyed persisted
  documents only: one not read or written for the retention period (default 10 minutes) and not watched leaves memory
  and is reloaded on the next access (LRU, one unreferenced timer). A storage error ends the store (Durable's rule);
  the host reports it and restarts. Code is copied from Durable's transaction where useful.
- **`DocumentStorage` is an interface in Chord:**

  ```ts
  interface DocumentStorage {
    commit(writes: readonly DocumentWrite[]): Promise<Seq>;          // create/change/retire, atomic
    find(address: DocumentAddress): Promise<DocumentRecord | undefined>;
    load(id: string): Promise<StoredDocument | undefined>;           // version, value, deltasSinceBase
    scan(query: { owner: string; definition: string }, limit: number, cursor?: string):
      Promise<{ keys: string[]; next?: string }>;
    byTag(tag: string, value: string, limit: number, cursor?: string):
      Promise<{ ids: string[]; next?: string }>;
    mintId(): Promise<string>;
  }
  ```

  An address is (object identity hash, definition name, key). Chord ships an in-memory implementation. p2 adapts
  Durable's `Storage` (SQLite): `kind = "<definition>.<objectHash>"`, `key` = the author's key, so `scan` maps to
  Durable's `scanDocuments`; tags need a small index of the adapter's own. Worker: storage per session; server: one
  shared storage. Chord gets no Durable dependency.
- **Conformance suite:** `@earendil-works/chord/testing` exports
  `registerDocumentStorageConformance(runner, name, withStorage)`: atomic commits, ordering and incarnations, base plus
  deltas, versions, scans, tags, `mintId`, reopen, failed commits change nothing. Chord runs it on its memory storage,
  p2 on its adapter.

## 10. Jobs (T)

Owned work started by a method that outlives the call (the chat `!cmd` shell, a login flow). Durable's effect
sandwich: **intent** (a transaction), **effect** (unrestricted), **outcome** (a transaction in the current code).

```ts
const ShellJob = defineJob("chat.shell", {
  version: 1,
  args: Type.Object({ command: Type.String() }),
  progress: Type.Object({ output: Type.String() }),
  result: ShellResultSchema,
  concurrency: 1,
});

const results = self.state(ShellResult);                      // keyed by job id
const shell = self.job(ShellJob, {
  run: async ({ command }, ctx) => {                         // 2. effect: may do anything
    const out = new OutputBuffer({ maxBytes: 50_000, maxLines: 2000, retain: "tail" });
    const r = await runProcess(command, ctx.signal, (chunk) => {
      out.push(chunk);
      ctx.progress({ output: out.snapshot() });
    });
    const data = { command, output: out.snapshot(), exit: r.code, cancelled: ctx.signal.aborted };
    await conversation.submit({ entry: shellEntry(data), requestId: `shell:${ctx.jobId}` });   // external, keyed
    return data;
  },
  finish: async (done, tx) => {                              // 3. outcome: current code, Durable's rule
    (await tx.draft(results, done.id)).outcome = done.ok ? done.result : { error: done.error };
  },
});

return {
  liveShell: shell.running,                                  // [{ id, version, args, progress }]
  runShell: ({ command, requestId }, ctx) => shell.start({ command }, ctx, { key: requestId }),   // 1. intent
  abortShell: ({ id }) => shell.abort(id),
};
```

- **Definition:** `defineJob(name, { version, args, progress, result, concurrency?, persist?, accepts? })`, typed
  schemas; `ctx.progress` and the outcome are typed by them.
- **1. Intent:** `tx.start(job, args, { key? })` inside a transaction (shorthand `job.start(args, ctx, { key? })`).
  The busy check (`concurrency`) and deduplication (`key`, e.g. the client's `requestId`: the same key returns the
  existing run) are atomic and in the same commit as other writes. `run` starts only after the commit; if the
  transaction fails, nothing starts. The run id is a UUIDv7 minted by Chord, globally unique.
- **2. Effect:** `run(args, ctx)` may do anything (processes, network, Durable submissions). External writes carry a
  deduplication key derived from `ctx.jobId`, so a repeated or interrupted attempt cannot apply them twice; systems
  without a key get at most one attempt. It returns the outcome and writes no document of its own. On reload it keeps
  its old code.
- **3. Outcome:** Chord records the outcome when `run` settles, in its own record (never `stale`), then calls the
  **current** code's `finish(outcome, tx)` under Durable's rule and acknowledges the run in the same commit. The
  outcome is `{ ok: true, result }` or `{ ok: false, error }` with `error` one of `threw`, `aborted` or `lost`. A
  `finish` that throws changes nothing; the outcome stays pending and `finish` is retried (backoff, and after the next
  reload). `finish` is optional.
- **Abort is a request:** `job.abort(id)` fires `ctx.signal`; the run decides what it returns (a result that already
  arrived stays a success; partial output is kept). A run that ignores the signal keeps its slot until it really ends.
  `finish` runs in Chord's own context, not the aborted one.
- **`running`** is a readable maintained by Chord (`{ id, version, args, progress, phase }`). `concurrency` counts
  only runs whose `run` is still active: the slot frees when the work is done. A run whose outcome is recorded but whose
  `finish` has not committed stays in `running` with `phase: "finishing"` (or `"blocked"`, with the reason) until
  `finish` commits, and its failures are reported. **`ctx.progress`** is in memory, throttled and sent as deltas.
- **Versions:** a run started under an older job version keeps its recorded version; `finish` and `running` see it
  through pure `accepts` adapters, and stored outcomes are never rewritten (Durable's terminal results). As for
  documents, a bump without an adapter does not refuse the reload: the old outcome is blocked when `finish` would read
  it (`phase: "blocked"`), kept and reported, and finished by a later reload that brings the adapter.
- **Persistence:** in memory by default (after a host crash the run and its outcome are gone with the process). With
  `persist: true` (stable identities only, §7) the record survives: a run that was live at a crash ends as `lost` at
  the next activation and `finish` records it. A crash after the effect but before the outcome is recorded leaves the
  outcome unknown; nothing is rerun automatically.
- **Keep-alive and relocation:** running and unsettled runs count as activity.
- **No write amplification**, as in Durable: a bounded output window (`OutputBuffer`), adaptive throttling (`Progress`),
  deltas only; both are in `@earendil-works/chord/output` (B: pi `4a5d37291`).
- **Shorthands** for single steps: `job.start(args, ctx, opts?)`, `handle.change(ctx, key?, fn)` (one document,
  loaded before the synchronous `fn`), `handle.retire(ctx, key?)`. Several of them atomically together: `self.tx`.
- **Not jobs:** request and response work that may die with its caller is a method call (an env test); input into
  running work is a call to the p2 Questions service (`questions.md`); work that must resume after a crash is a
  Durable task (tool calls, codemode).

## 11. Routines (T)

Standing behaviour of an object, grouped under `self.routines`:

```ts
self.routines.on(pending, async (current, ctx) => {            // react to a readable or an event source
  for (const worker of current.restarts) await restartIfNeeded(worker, ctx);
});
self.routines.every("cleanup", HOUR, (ctx) => dropOld(ctx));    // timer; its due time survives reloads
self.routines.loop("indexer", async (ctx) => {                 // long-running loop until the object ends
  while (!ctx.signal.aborted) await indexNext(ctx);
});
self.routines.custom("ticker", ({ signal, run }) => {          // anything else: set up, return the cleanup
  const timer = setInterval(() => run(tick), 1000);
  return () => clearInterval(timer);
});
```

- Started when the object goes live, stopped when it ends, and on every reload of its plugin stopped and restarted
  with the new code; the old routine's own cleanup undoes its setup. Each run gets its own `ctx`. Errors are caught
  and reported, never uncaught. Routines are named (`on` optionally, by its source), so Chord recognizes them across
  reloads.
- **Serialized per routine:** on reload the new instance starts only after the old instance's handler in flight has
  settled (only that routine waits; a deadline lets it start anyway and reports the stuck handler). Example: an old
  handler is mid-`restart(W1)`; without serialization the new routine sees W1 still pending and restarts it again.
- A routine reconciles from the current value, writes no "in progress" flags, and starts a job for long work.
  Subscribing to the object's own documents is gapless (same process, same tick).
- No bare timers or callbacks that touch state outside routines, jobs or calls.
- Distinct from jobs (single runs started by a method) and methods (called by others).

## 12. Resources (T)

```ts
const sandbox = self.resource("sandbox", {
  version: 1,
  deps: [env],
  open: async ({ signal }) => createSandbox(env.value, { signal }),
  close: (sb) => sb.dispose(),
});
const conn = self.resource("conn", {
  version: 2,
  open: async ({ signal }) => ({ socket: await connect(url, { signal }), queue: [] }),
  replace: (old: ConnV1) => ({ socket: old.socket, queue: old.buffer.map(parseMessage) }),   // hand over
  close: (c) => c.socket.close(),
});
self.routines.on(() => sandbox.value.crashes, (crash, ctx) => report(crash, ctx));
```

- A resource holds only a native value; behaviour goes into routines (by convention). What remains in p2: the search
  database, SSH connections, the terminal service, the radius socket, the codemode sandbox, the workspace watch.
- Same name and version on reload: kept (`open` does not run again; the new `close` is adopted). Keep logic out of
  the resource (plain code around a data container), so logic changes are code reloads and need no bump.
- **A raised version with `replace`** hands the old value over: `replace(old)` (synchronous) builds the new value
  from the old one, for example taking over a socket or converting a container's entries; the old `close` is not
  called; old code's handles throw `stale`. Asynchronous setup (a handshake) goes into a routine. If `replace` throws,
  the object becomes `failed` and the old value is closed. Handing over a native is fine when no old behaviour is
  attached to it (listeners belong in routines) and when the bump means "change the shape, keep the content".
- **A raised version without `replace`** replaces it in place: close the old one (resources built on it first), open
  the new one (providers first), restart the object's routines. Running calls and jobs are not signalled or waited
  for; one still using the old native gets its native error. Documents are untouched; the object does not restart.
- **Values taken out of a handle are not revoked** (decided: no proxy). After a replacement, old code that kept
  `const c = conn.value` (or anything inside it) across an `await` still holds the old object; with `replace` it may
  hold natives now owned by the new value. Rule (documented, with do and don't): read `.value` at use, keep nothing
  from it across an `await`, attach no listeners to natives outside routines. Handles themselves throw `stale` for old
  code.
- **Dependents** (`deps`): after a provider is replaced, its dependents are reopened (close, then open with the new
  provider value), unless a dependent has its own `replace` **and** its provider was handed over by `replace` (then the
  dependent's `replace(oldDependent)` runs after the provider's and sees the new provider value). A provider that was
  closed and reopened reopens all its dependents. Transitive: a handed-over or reopened dependent counts as changed for
  its own dependents. **Rule:** a dependent's `close` releases only what the dependent created, never its provider's
  native.
- **Order on reload, enforced by Chord:** replace or reopen resources (providers first), then dependent resources, then
  rebind derives whose source is a resource handle, then start routines. A derive must name the handle
  (`self.derive([pending], (p) => …)`); a value taken out of `.value` in the factory (`pending.value.readable`) stays
  bound to the old value after any replacement (documented footgun; the factory runs at publish, before the replacement).
- **Lifecycle failures** (`open` throws, at first activation or on replacement; `close` misses its deadline, reported
  as a possible leak) make the object `failed`; its references end with an error.
- **Retries:** a new `get` or a plugin reload activates again (factory, resources). Chord keeps a backoff per address
  (1 s doubling to 60 s): during it a `get` returns the stored error without running the factory; concurrent gets
  share one attempt; success resets it. Without a backoff, consumers re-holding cause retry storms; without retries,
  temporary failures never heal. **The backoff is cut short** (an attempt runs at once if anyone waits) by: a reload of
  the plugin; a dependency of the failed attempt changing (a referenced object going live, a provider resource
  reopened); an explicit `ref.retry()` (a UI Retry button); wake signals the factory declares,
  `self.retryOn(...readables)` (an escape hatch, for example the config the object connects with; declared before
  resources open, so a failed open still has them).

## 13. Registries (T)

```ts
export const Routes = defineRegistry<RouteV2>("p2.routes", {
  version: 2,
  accepts: { 1: (old: RouteV1): RouteV2 => (req, res, access, ctx) => old(req, res, ctx) },
  conflict: "error",
});
self.register(Routes, "GET /notes/export", exportNotes);   // in a facet
const route = host.registry(Routes).get(path);             // adapted to v2
```

- The owner declares a registry with `version`, `accepts` and `conflict` (`"error" | "last"`). Values are whatever the
  owner types: functions, objects, UI components, readables. The registry manages no lifecycle; anything needing
  cleanup is a resource and the entry refers to it.
- The facet registers; entries live while the plugin is loaded. An entry carries the version its plugin was built
  against; older ones are adapted when the table is built, newer ones refused at load.
- A table is an immutable value, swapped atomically on reload; `host.registry(R).table` is a readable. No late binding:
  whoever holds an old table (a pinned Durable phase) calls old, consistent code.
- Entries take the caller's `ctx`; work that outlives the call is a job of the facet.

## 14. Host values (T)

```ts
export const HarnessKey = hostValue<DurableHarness>("p2.harness", { version: 1 });
const harness = host.value(HarnessKey);
```

- Typed keys the host provides before any facet loads, on every host: worker (harness, environments, init, location,
  liveness, cwd followers), server (session hosts, resource options, server info, revocation), browser and TUI
  (navigation, theme, clipboard). They replace runtime objects with `opaque` members.
- `version` plus `accepts` are part of the mechanism; the harness starts with the plain Durable type and no adapter (a
  mismatched plugin is refused at load); a facade we own comes with the SDK. Values that change are readables.
- Whoever imports the token gets the value.
- **Start barrier** (host start and first plugin load): open Durable without scheduling, provide host values, load
  facets, check cwd and model, `resume()`. Plugin reloads need no barrier.

## 15. Reload (T)

A reload is explicit (`npm run reload -- <plugin>`, once the edits are done), not a save. It behaves like a restart
of the changed plugins, without restarting the host. On each host:

1. **Load:** load the new bundles. A syntax or import error refuses the reload for that host (`rejected`), nothing
   changes. Loading mutates nothing live. There is no factory trial, no `migrate` dry run and no check of new
   providers against live consumers (incompatible consumers fail at bind with `contract_mismatch` and a notice naming
   the plugin and type, as after a restart).
2. **Publish** (synchronous, one tick; measured and reported):
   - each changed facet's setup runs once and its declarations (serves, registrations, resources, documents,
     routines) are **staged**; a setup that throws discards its staging and **that facet keeps its previous version**
     (services, entries, facet object), reported as `rejected` for that plugin on this host with the reason. Mixed
     versions within a host are the same situation as during a rollout, protected by the same contracts;
   - staged declarations are installed together; registry tables are built once from them (a `conflict: "error"`
     clash refuses the declaration set of the facet that caused it) and swapped; an object's old entries stay until
     its new version is live, so Durable never sees a gap;
   - live objects of changed plugins re-run their factories (declare only); a factory that throws makes that object
     `failed` (backoff, §12); from now on new calls reach the new code, behind each object's readiness gate.
3. **After publish, per object, in enforced order:** resources whose version rose are replaced (`replace`) or reopened
   (providers first, then dependents, §12); derives over resource handles rebind; routines start (serialized per
   routine); then the readiness gate opens. **Exposed singleton documents** whose version rose migrate now (hydration
   and subscription count as access): a `migrate` that throws keeps the stored data and reports an error on that
   member (references stay live, other members and methods keep working); never v2 operations on v1 state. Keyed and
   unloaded documents migrate on their next access (Durable's rule: a throw refuses that access, data kept).

At start there is no previous version: the start barrier (§14) waits until every contributor is live or failed, then
resumes Durable; a failed optional facet stays unavailable, missing required configuration prevents `resume()`.

- **Running work** is not signalled or waited for: calls and jobs finish with their old code; their transactions land
  on documents whose version did not change and throw on migrated ones.
- **Removing a type:** its objects end (routines stopped, resources closed, references end with an error); in-memory
  documents go with them; persisted ones stay until retired.
- **Failures after publish** (a resource that cannot open, a migration that throws on a lazily loaded document) make
  that object `failed` with backoff; other objects are unaffected; data is kept.
- **The cluster:** the server installs, then asks each worker and client to install; each host reports `installed`,
  `installed_failed` (named failed objects) or `rejected` (with the plugins it kept on their previous version and why). A host that starts or
  reconnects installs the current revision; until it reports, nothing is routed to it. Browsers and TUI install
  locally.
- **Revisions:** a revision is `(server incarnation, sequence)`, issued by the server, and names the **complete
  desired code set** (every facet with its digest), not a batch. Every install reconciles everything missing; a host
  reports a revision only when it runs that complete set, otherwise `rejected` with the reason. A different
  incarnation is not comparable: the host reinstalls on reconnect before serving. (Project plugins: separate
  discussion, open.)
- **Installing on a host is never stop-the-world:** prepare runs while the old code serves; publish is one tick;
  "installed" means the code is published, not that every object is live (objects activate on demand, calls to an
  activating object wait, as at host start; reporting only after all objects are live could deadlock with an
  activation that needs another host).
- **Mismatches during a rollout.** A mismatch response carries the provider's revision and status (`installed`,
  `installing`, `rejected`). The binding compares with its own host's revision: the provider is ahead (this host's
  install is coming: the server pushes its revision to every connected host, and a reconnect installs) or behind and
  installing (the provider's install is coming) → `updating`, values stay readable, calls park as during a disconnect;
  the provider rejected the revision → fail at once with the reason, retryable on the next revision; same revision →
  `contract_mismatch`, final. A deadline ends any wait. A live binding whose hold the provider no longer covers after
  publish is told so and becomes `updating`; calls the provider answered with a mismatch were not executed; calls
  parked on a binding that is released (its code replaced) end with an error and are not resent. Order: server,
  workers, clients; a server that rejects (load error) stops the rollout, so everything stays on the previous revision.
- **A host that rejects** (a load error) stays entirely on its previous code; a facet whose setup throws stays on its
  previous version while the rest of the host moves on. Only the changed types of that plugin that cross hosts
  incompatibly fail (fast, with the reason), the rest keeps running. There is no cross-host transaction (votes were removed deliberately).

**Plugin loading and the dev loop** (detail in `plugin-loading.md`): plugins come from built-in, global, package and
project roots, are discovered by directory listing and loaded as loader-D bundles (one base bundle per host kind plus
one script per facet, host packages passed in, no module map). A change to runtime code (the base bundle) restarts the
affected hosts; a plugin change is a rollout of a new revision (above). Project facets are installed per worker,
outside base rollouts.

## 16. Wire (T)

Exposed documents are state members like cells: `snap` on hold, `ops` per commit (the draft's ops, no diff), `ops` from
diffs for `derive`, throttled `ops` for job progress, `reset` for a migration commit (adapted by `accepts` for older
consumers), `error` for failures. **Commits are atomic for consumers:** locally, subscribers are notified once after
every document of the commit is adopted; remotely, one `state` frame carries a `batch` of member updates per hold,
applied together before listeners run (the next protocol version; relays forward it unread).

## 17. Presence: `host.references(Type)` (T)

```ts
const viewers = self.derive([host.references(Chat)], (refs) => refs.length);
```

A readable of who holds references to objects of a type on this host (`input`, `principal`, `clients`). Client holds
carry an opaque origin id (B), so two tabs are two clients; a disconnect is departure. Replaces the presence, viewer and
login-abandon leases. **Linger bit:** a lingering reference (a closed tab, 2 min) keeps the worker alive but is not a
viewer. The client sets `lingering` on its hold when the view closes and clears it when the view returns (one hold
field, the next protocol version); `host.references` reports it, so presence filters it out and keep-alive counts it:

```ts
const viewers = self.derive([host.references(Chat)], (r) => r.filter((x) => !x.lingering).length);
```

## 17a. Questions (p2 service)

Input into running work (login prompts, tool approval, a question the model asks everyone) is a p2 service, not a
Chord or Durable feature: a shared store in a facet resource, per-principal `Questions` views (asker: `ask`, a long
call; viewer: `open` and `answer`), typed form questions, answer policies (first, quorum, all) over a live audience,
authorization per question. Tool approval is a Durable `beforeTool` hook calling it through `host.root`. Full design:
`questions.md`.

## 18. `ctx`

`ctx` carries `signal` (caller cancel, object ended), the host's `principal`, `get` (call-scoped references), and in a
job `jobId` and `progress`. Pass `ctx` or `ctx.signal` to everything you wait on. No code versions, no root ids.

## 19. Versions and adapters

| Surface | Version | On change |
| --- | --- | --- |
| object type | `version` | `accepts` adapter; coverage check (B) |
| registry | `version` | `accepts` adapter (T) |
| host value | `version` | `accepts` adapter; harness refused on mismatch for now (T) |
| document | `version` | pure `migrate`, migration commit (T) |
| resource | `version` | replaced in place (T) |
| Durable tasks and documents | `version` | Durable's `migrate` (B) |
| link protocol | `PROTOCOL_VERSION` | refused; hosts update together (B) |
| UI components, Chord/p2 API | none yet | exposed as they are; versioned with the SDK |

## 20. Consumers

Consumers handle a failed call as they handle a disconnect today (error shown or retried by the user). No request ids
beyond Chat's existing `requestId`. References re-hold by themselves.

## 21. p2 migration work

- **Documents:** about 45 cells. About 22 are mirrors that become derives over source readables or documents (chat
  view/window/model, chat-mode, artifacts, catalog, sharing links, search, models, prompt, envs configs, ports list,
  logs). The plugins' own SQLite tables (catalog, shares, subagents, devices, forwards) become persisted documents;
  search keeps a plugin database.
- **Data that should survive:** drafts (persisted, keyed `conversation:authorId`), chat's shell dedupe, subagents
  children, ports forwards. The status viewers map becomes `host.references`.
- **Writes to split into work plus a short transaction:** chat `runShell` (a job), env restarts (document plus routine),
  sharing archive.
- **Natives:** 16 `opaque` members become host values or methods; behaviour inside resources moves to routines (models,
  envs, radius, terminals, login, logs).
- **Carriers:** 47 `contribute` calls become facet registrations.
- **Retire policy (decided):** archive retires nothing. A session delete (new) removes the entire session (§7):
  documents tagged with `SessionTag`, the worker's session database and document storage, the catalog entry. Plugins
  with per-session persisted documents set `SessionTag`.
- Estimate: about 22 files and 600–900 lines for documents if mirrors stay derived, plus resources, host values and
  registrations.

## 22. Implementation order

1. **Chord store:** `DocumentStorage`, memory storage, conformance suite, `defineState`, `self.state`, `snapshot`,
   `tx`, keys, retire, lines per object, migration commits; `OutputBuffer`/`Progress` arrive from Durable.
2. **Chord jobs, routines, resources (replace in place, backoff), registries (versions, immutable tables), host values,
   facet object, wire batch,** `host.references`.
3. **p2:** the Durable storage adapter (conformance), host values and start barrier, then the plugin migration
   (section 21), the web consumer backoff.
4. **Rollout** coverage during install (once decided), entry 6.
5. **Loader D and the SDK** (`plugin-loading.md`).

The `chord-handover` branch (drain-based prototype) is not merged. Parts can be reused while building: the facet
object, immutable registry tables, revision and health in the rollout, its GC tests.

## 23. Deferred and rejected

- **Deferred:** the SDK, UI components as versioned contracts, the `files` tool, several people, Durable clock.
- **Rejected:**
  - the drain-based handover, version fences without transactions, object restart for state changes;
  - Durable's Session as the object store, volatile documents, per-group lines in Session;
  - generic call ids;
  - late-bound registry entries;
  - `restart_required`;
  - dynamic registries;
  - detached references counting toward presence;
  - contracts taken from the running p2.
