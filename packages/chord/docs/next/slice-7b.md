# Slice 7b: reload in the kernel (spec)

Status: **ready to build** (owner, 2026-10-29: the brief `slice-7b/` and its six points decided as recommended, decision
"Slice 7b's open points, as recommended"). 7b builds `host.reload` and everything an object, a reference, a job and a
registry does across it, on one host. Facets are passed in imported (tests import them statically); the bundler and
the dev loop are slice 7c, the rollout across hosts is the app's.

Read in full before writing code: this spec, the brief `slice-7b/book.md` (chapters "One Host Reloads" to "Across
Hosts"), `dependencies/model.md` (decided; built for 7a, its 7b parts are listed in its status line), `design.md` (§5,
§6, §9, §14, §15, §17, §21, §22, §27), `decisions.md` (the 2026-10-29 entries; R15, R16, Q10, "The seal fence", "Job runs
belong to the object", "A native restart drains first", "Slice 8 D1"), `slices.md` (slice 7b's carry-over: every entry
is in this spec or named as out of scope in §12).

## 1. The API

```ts
interface Host<P> {
  load(facets: readonly PluginFacet<P>[], context: Context): Promise<void>;                 // once, first
  reload(facets: readonly PluginFacet<P>[], context: Context): Promise<ReloadReport>;      // after load, any number
}
type PluginFacet<P> = { readonly name: string; readonly facet: Facet<P> };

type ReloadReport = {
  readonly plugins: { readonly added: readonly string[]; readonly changed: readonly string[]; readonly removed: readonly string[] };
  readonly objects: readonly ReloadedObject[];                  // every live, activating, parked or failed object of a reloaded plugin
};
type ReloadedObject = { readonly object: string } & (
  | { readonly kind: "swapped" }                                // pure, in place
  | { readonly kind: "restarted" }                              // natives: drained, closed (`reload`), activated again
  | { readonly kind: "ended" }                                  // its type is gone
  | { readonly kind: "parked"; readonly cause: FailureCause }   // the new code waits for a dependency (decision 4)
  | { readonly kind: "retried" }                                // it was failed or parked; a new attempt runs on the new code
);
```

- `facets` is the host's **complete new plugin set**: a plugin in it and not loaded is added; one in it and loaded is
  changed (always treated as changed: Chord compares no code); one loaded and not in it is removed. The core facet is a
  plugin like the others; base code passes it every time.
- `reload` resolves once the commit happened and every object has taken its fate (§4): swaps done, restarts and retries
  started (it does not wait for them to go live; their outcome is in their `ref.state`). It rejects with the code error
  when load or staging fails, and nothing has changed. Reloads are serialized per host (a second call waits for the
  first). Before `load` resolved: throws; after `host.close`: rejects `released/closed`. `context` bounds the reload
  (decision 4: no install watchdog); its abort before the commit rejects `aborted` and changes nothing; after the commit
  it only ends the wait.

## 2. Staging (all or nothing)

1. **Setups.** Every facet's setup runs into a **staged** table, beside the live one: served types (with their factory,
   options and `bindProvider(contract, options.accepts)`, which runs `checkAccepts`), served registries (provider
   with `compose` and `accepts`), facet contributions. The checks of `load` apply (plugin names, a type or registry
   served twice, a remote type on a host without principal or address).
2. **Factories.** For every object of a changed or removed plugin's types that exists now (live, activating, parked,
   failed), and whose type is still served: the new factory runs against a **recording `self`**, with the object's
   params (and principal), and declares only: what it opens (`self.open`), the documents and tables it declares with
   their versions, its jobs with their versions, its contributions, its requests. Nothing is activated, bound or
   opened; handles from a recording `self` are inert. This gives each object's fate (§4) before the commit.
3. **Any throw** (a setup, a factory, `checkAccepts`, a declaration error) rejects `reload` with that error, names the
   plugin (and object), and the host stays entirely on its old code: the staged table is dropped.
4. **While staging,** the host is **installing** (model §1): a hold that arrives for a type or version that the running
   code does not serve waits `installing` (`loading`) instead of `not_served`/`version`, and is re-evaluated when the
   reload ends, by its commit or its rejection.

## 3. The commit (one batch)

In one `batch.commit`, synchronous:

- The served types table becomes the staged one: added and changed types replace their entries (factory, provider,
  `linger`); removed types are dropped.
- **Registries** (slice 8 §6): a changed or added plugin's provider replaces the old one (`RegistryRecord.serve` refuses
  a second serve today: it becomes `replace` for a reload); a removed plugin's provider goes (its readers become
  unbound `not_served`); the reloaded plugins' facet contributions replace theirs, by plugin; object contributions stay
  with their objects (they follow the objects' fates); every changed table recomposes once, lazily, as today. The record
  keeps the provider, facet contributions by plugin and object contributions by object apart.
- **The publication** (model §4): after the batch, the unbound requests waiting for the names the reload serves (types,
  registries, versions) are re-evaluated (`UnboundIndex.wake(names)`, per name: the carry-over "Publications wake per
  name"), refused holds for those names re-run their start, and `installing` holds are re-evaluated against the new
  code.
- `host.references(Type)` of a removed type is dropped (carry-over from 4b).

## 4. Fates

Each object of a changed or removed plugin's types takes one fate, decided in staging (design §21, decisions above):

| The object | Fate |
| --- | --- |
| its type is removed | **ended**: as an object end today (natives close with reason `end`, callers of running calls rejected `released`, handlers drained); its requests are released; its holders' requests become unbound `not_served` (§6) |
| failed or parked | **retried**: its attempt is replaced by one of the new factory (a parked attempt in one handover: the new requests bind before the old ones are released; the mechanism 7a removed comes back here, carry-over) |
| live, old and new code open no natives, and no table of the new factory is at a newer version | **swapped** in place (§5) |
| live, otherwise | **restarted**: new calls park (the gate closes, holders see `loading`), running calls drain (bounded by `closeTimeout`; a call outliving the drain is cut off by the seal fence), the attempt is sealed, natives close (reason `reload`), the new factory's attempt activates (documents stay; eager table migrations run as at activation) |
| any of the above whose new factory declares a dependency that is not there | **parked** on it (decision 4): the gate stays closed, holders see `loading` or `failed { waiting }`; no overlap of old and new code |

- A restarted object gets a new instance id (an old activation chain must not match it, carry-over from 4b); a swapped
  object keeps it; a retried one gets one as any new attempt.
- Objects of plugins not in the reload are untouched; their requests to changed types follow §6.
- Host-lifetime objects of an added plugin start after the commit as at `load` (no barrier: `reload` does not wait for
  first outcomes).

## 5. The pure swap

A pure swap is not a replacement (decision "The seal fence"): the old attempt is not sealed while its calls run.

- **Gate.** For the swap itself the gate closes; new calls park (bounded) until the new attempt is live.
- **New attempt.** The new factory's attempt is made with the same object: same documents and line (they are the
  object's), same job records. Its requests are made and bound before the old attempt's are released: a request equal
  to an old one (same type, params, principal, version) binds to the same target with no gap. It parks if a new
  dependency is not live (§4, parked). It runs its own steps (no natives by definition: derives, member checks), its
  members re-bind by name (`#rebind` exists: one frame from the last value per member; a member the new variant lacks
  fails `invalid/member`), its contributions replace the old attempt's in the registries in one batch, its routines
  start after the handover (below), its jobs take over the job records (§8).
- **Old calls.** Running calls finish on the old attempt with its handles valid (their transactions commit) until they
  settle, except R15: an old call touching a document whose version rose throws once (the document intact, the call
  not resent); the same for a table whose version rose (old table handles' version fence, carry-over from 6a: old code
  never issues SQL for a dropped column). Once the old attempt's calls settled, it is sealed and its references are
  released.
- **Routines** hand over per object: the old attempt's routines are aborted; the new ones start once the old routine
  calls finished, bounded by `closeTimeout` (a stuck one is reported and the new ones start anyway); calls never wait for
  it; each old routine invocation is fenced on its own (carry-over from 6a).
- **Derives** have no names: exposed derives are matched by member name through the member sources; internal ones are
  rebuilt.
- **In-memory documents** migrate through their definition's `migrate` when the new code declares a higher version
  (6a built the slot version check; carry-over).
- **`self.writable`** starts at its new initial value (decision 2).
- **`retryOn`** sources are re-declared by the new factory.

## 6. References across a reload

**Provider side** (holds this host serves, and bindings on this host):

| The reload | A hold or binding |
| --- | --- |
| the object is swapped, its version still accepted | kept; re-subscribed through the version's mappings; one `[["r", value]]` per member whose value changed |
| the object is restarted, version still accepted | kept; `loading`, then a fresh `bound` (a `bound` on a bound hold, which 4a's consumer applies as a re-binding) |
| the new code no longer accepts the hold's version | unbound `version` (`failed { waiting }`); the object and its other holds stay |
| the type is removed | unbound `not_served` (`failed { waiting }`) |

- **Over a link,** a `failed` on a bound hold unbinds it (model §5): the consumer applies it as `#startOver` plus
  `failed`; the provider detaches the hold's sources, drops its unsent pending ops and a queued `bound`, keeps the ack
  slots of `bound`/`state` messages already sent until their `ack` or the link's loss, and rejects the calls in flight on
  it once. `Hold.moved` and `ProviderSide.unbind` handle bound and binding holds (carry-over from 3a/6a). A served hold
  whose object leaves `live` while its `bound` waits for a slot goes back to pending.
- **On the same host,** a `Binding` whose target ended by removal becomes unbound and accepts a second `bind` (model
  §5): member sources re-bind by name, keyed pins re-pin, parked calls flush or reject, presence lists it again.
- **The consumer's own reload:** the new factory makes new requests (§5's handover). A reference made by outside code
  (`host.hold`) keeps the token its caller passed; Chord reloads no caller code.
- **A remote object that leaves `live`** (`RemoteObject.failed` ignores a failure while live today): handled by the
  unbinding above.

## 7. Versions in use (`accepts`)

- `host.serve(Type, factory, { accepts, linger })`: today every provider is bound with an empty table
  (`bindProvider(contract, {})`); 7b passes `options.accepts`, checked by `checkAccepts` at the setup (a declaration
  error rejects the reload or the load).
- **Binding an older consumer:** a hold whose version is accepted binds through the mappings of that version (Q10):
  state members through `(current) => old`, served like a derive of the provider's member per binding (adapted bindings
  get diffs: the last adapted value per binding, `diffRevisions`, never a whole value per commit); method calls through
  `checkArgs`: `{ kind: "method", args, result? }` runs the handler and maps the result back with `result`; `{ kind:
  "call", args, call }` runs the provider's replacement (L1 built the check; 7b invokes it). Removed state members with
  `"refuse"` and removed methods with `"refuse"` fail the binding or the call `contract_mismatch`.
- **Keyed members** are mapped per key (carry-over from 6a), only on `local` contracts.

## 8. Jobs across a reload

- **Job records** keep the definition of the version their runs were started with; the new attempt's `self.job(Def,
  impl)` at another version no longer throws (`ChordObject.jobRecords` today): the records take the new definition, and
  each run keeps its own version.
- A run started on an older version and still running finishes on its old code across a pure swap (its invocation keeps
  the old implementation); `finish` runs on the new code with the outcome's args and result mapped forwards through
  `accepts[old]` (once per run); `running` shows its args mapped.
- No adapter for a run's version, or a run of a newer version (a rollback): the run is `blocked { version }` until a
  reload brings matching code; blocked runs (also `finish_failed` ones) are retried on every reload.
- A native restart aborts running runs (`aborted { reason: "reload" }`); `finish` runs on the new code.
- A job the new code no longer declares: its runs are `blocked { version }` (kept, not invoked) until a reload declares
  it again or they are aborted; a persisted run of another version or fingerprint stays blocked with its record as
  stored and is resolved by the reload that brings its version.
- A `finish` in flight across a reload completes on the code it started with; the next one runs on the new code.
- A job's fingerprint covers args, result and state: a schema change without a version bump is refused at declaration
  (as documents).
- An older run's state document migrates through its own `migrate` only once its run settled or moved to the new code
  (the old code keeps writing the version it knows).

## 9. Errors, cycles, presence

- A broken object of a reloaded plugin is retried (as `ref.retry()`), whatever broke it.
- Cycles: the walk and chains as today, checked again for the new attempts; `parked_long` unchanged.
- Presence: holds kept across a swap stay listed; a restart lists them again when they re-bind.

## 10. Telemetry and reports

`onError` gets what fails after the commit as today (`activation_failed`, `close_failed`, `routine_failed`, …). No new
`HostError` kind; the report returned by `reload` is the summary.

## 11. Tests, examples, cost

- One `describe` per mechanism: the API (serialized, before load, after close, abort before and after the commit);
  staging (each kind of throw leaves the host unchanged; recorded declarations decide the fate); the commit (types,
  registries, per-name wakes, `installing` holds); each fate (swap, restart, end, retry, parked, a new dependency
  missing); the swap (old calls on old handles, R15 for documents and tables, the handover of references without a gap,
  member re-binding, routines handed over and fenced, derives, in-memory migrate, a writable back to initial);
  references (each provider-side row over a memory link and through a relay, the window full while unbinding, a
  removed-then-re-served type with a live local dependent and with a remote one); `accepts` (state mapped per binding as
  diffs, old args mapped, a result mapped back, a replacement `call`, `"refuse"`, keyed members per key); jobs (each
  rule of §8, in memory and persisted); registries (provider replaced, contributions by plugin replaced, a reader of an
  older version); a three-host scenario (server, worker, tab) reloaded in the app's order, as an example's test.
- Examples: `33-reload.ts` (a pure swap, a restart and a removal, with old calls and holders shown) and `34-versions.ts`
  (a contract and a job at v2 with `accepts`, an old tab and an old run carried across).
- Benchmarks: the hot paths against HEAD (calls, commits through a watched derive, activation, links) within the bar;
  plus a reload benchmark (one plugin of 20 reloaded on a host with 1,000 live objects, swap and restart) reported in
  `benchmarks.md`.
- GC tests: an old attempt and its closures collected after its calls settled; a removed type's objects, providers
  and registry entries collected; an old facet's code collected after a reload (the precondition for loader D).

## 12. Out of scope

Slice 7c: the bundler and loader (`chord/next/loader`), the dev loop (`chord/next/dev`), plugin discovery and npm
dependencies. The app: the rollout across hosts (decision 3: it calls `host.reload` per host in order). Slices 10 and
11: the app kit. `rebuild` of tables (key or column-type changes): only if a case needs it (carry-over stays).
