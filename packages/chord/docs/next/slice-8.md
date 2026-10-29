# Slice 8: registries and `host.root` (spec)

Status: **built** (2026-10-28; build review and two fix rounds by the same four reviewers,
`/tmp/s8-build-review-*.md`, `/tmp/s8-build-rereview-*.md`). Before: ready to build (2026-10-27; D1-D3, the registry failures and S1-S3 decided by the owner; two spec reviews,
`/tmp/s8-review{,2}-{astra,fable,opus,sol}.md`, found no remaining blocker; S3 refined after the second: with no value
after `load`, a reader fails at once, as `self.get` of a type not served here)

8 builds the extension point between plugins (registries), in-process values that change (`self.writable`), wake
signals for failed objects (`retryOn`), and the call scope for code outside objects (`host.root`). The harness object
is p3's base code; Chord shows it only in an example.

## What an app can do after this slice

```ts
// the defining plugin (e.g. http): the token, exported for other plugins
export const Http = defineRegistry<HttpContribution, Router>("chord.http", { version: 2 });   // shared: identity only
export default defineFacet((host, self) => {
  host.serve(Http, {                                              // the one provider (Q8), as for object types
    compose: (table, { report }) => buildRouter(table, report),   // pure; always a value; conflicts reported
    accepts: { 1: { contribution: (old: HttpContributionV1) => upgrade(old), value: (router) => routerV1(router) } },
  });
  host.serve(HttpServer, (_, self) => {
    const router = self.registry(Http);                           // a NativeWatchable of the composed value
    self.on(router, ({ value }, ctx) => …);
    return { … };
  });
});

// any plugin: a facet or a host-lifetime object contributes one value per registry
export default defineFacet((host, self) => {
  self.contribute(Http, { routes: { "GET /notes/export": exportNotes } });
});
host.serve(McpStore, (_, self) => {                               // local, empty params (R21)
  const ext = self.writable(mcpExtension([]));                    // an in-process value that changes
  self.contribute(HarnessExtensions, ext);
  self.on(mcp.tools, ({ value: tools }) => ext.set(mcpExtension(tools)));
  self.retryOn(self.registry(HarnessModels));                     // a model contribution wakes a failed attempt
  return {};
});

// code outside objects (a Durable tool, a CLI): a call scope
await host.root(async (ctx) => (await ctx.get(Notes, { session })).add(note, ctx), context);
```

## 1. Registries

- **Token and provider (D1, owner, 2026-10-27):** the token `defineRegistry<C, V>(name, { version })` is shared, as a
  contract: its name (as types, `[a-z0-9@/._~-]`), the contribution type `C`, the composed value type `V`, and the
  version the bundling plugin was built against. The defining plugin's facet provides it with `host.serve(R, {
  compose, accepts? })`, as it serves object types (adapters with the provider, never in the shared token, as
  `checkAccepts` for contracts); a second serve on a host is refused; a reload replaces it (slice 7).

- **Contributors** (R21): facets (by plugin name) and host-lifetime objects (`local`, empty params: by plugin name and
  type), at most one value per registry each; `self.contribute(R, value | Watchable | NativeWatchable)` in a facet setup
  or such an object's factory (a type error elsewhere; a declaration error at runtime). A facet's contribution is in the
  table while its plugin is loaded; an object's from `live` until it ends, fails or restarts.
- **The table:** an immutable list of `{ contributor, plugin, value }`, sorted by plugin name, then type (never load
  order); a contribution carries its token's version: an older one is adapted once with the declaration's `accepts`
  when the table is built, an older one without an adapter or a newer one is left out and reported (`HostError`
  `contribution_refused { registry, plugin, version }`).
- **Contributions:** a plain value, or a Chord watchable (a `writable`, a derive, a document member; another
  registry's value too, a cycle of registries reading each other refused when the second one serves or contributes), followed as a dependent of the table (its change recomposes), recognised by Chord's own mark; anything
  else is a plain value, whatever methods it has (a harness, a conversation handle or a runtime is contributed as a plain
  value, not followed; build review 2026-10-27, replacing "a foreign watchable is refused"). The table's entry is `{ plugin, type?, version, value }` (`type` for
  an object contributor; served types carry their plugin's name).
- **`compose(table, { report })`:** pure, lazy as a derive: the registry's value is marked when its table changes (a
  contributor goes live or ends, a watchable contribution changes) and composed when read or, while watched, in the
  owner's flush (W4: never by another owner's adoption itself; the flush after a commit step is where it runs). The first
  composition happens at the serve: the facets' setups of one `load` serve and contribute, then every served registry
  composes once in one batch at the end of the setups (an empty table composes too), so a served registry always has
  a value before any object activates. `report(conflict)` goes to `onError` as `registry_conflict { registry, message,
  plugins }`, once per conflict episode.
- **Failures (owner, 2026-10-27):** contributions never fail the registry. A contribution that is a watchable and fails
  is left out of the table and reported (`contribution_failed { registry, plugin, error }`), the table recomposes without
  it, and it is back once it heals. A `compose` that throws (the owner's bug) is reported (`registry_failed { registry,
  error }`), the composed value's watches get a `failed` call, and `.value` keeps the last good composition (an extension
  point stays available; derives keep their own rule, `.value` throwing while failed); the next good composition
  replaces it. Before any good composition `.value` throws the error.
- **Without a provider** (the defining plugin is not loaded): the registry has no value; contributions wait in the
  table; its serve composes it.
- **Reading is a dependency (S3, owner, 2026-10-27: "isn't self.registry meant to wait like self.get?"):**
  `self.registry(R)` in a factory declares the registry as a dependency of the attempt, as `self.get`: activation waits
  until it has a value; once `load`'s setups ran, a registry with no value cannot get one before a reload (a provider
  comes only with a plugin), so a reader then fails at once `transient` with `unavailable/undeclared` as the
  dependency's cause (as `self.get` of a type not served here fails at once, and the start barrier waits for no
  contribution) and is retried the moment the registry gets its first value (R18); a first `compose` that throws fails
  its readers the same way. It returns a `RegistryValue<V>` (a native source: a derive source, an `on` source, a `retryOn` source; never a
  state member); methods and routines read `.value` at use. Once the object is live, a later failure of the registry
  (a throwing `compose`) changes nothing for it: `.value` keeps the last good composition. Code outside objects:
  `await host.registry(R, ctx)` waits the same way.
- **Older readers (S2, owner, 2026-10-27):** a reader whose bundled token has an older version than the provider's gets
  the composed value mapped back with `accepts[old].value` (computed once per composition and version, while such a
  reader exists); without that mapping, or for a reader newer than the provider, its dependency fails
  `contract_mismatch` (reported). `accepts: { [old]: { contribution?: (old) => current, value?: (current) => old } }`.
  Adapters are the provider's code, guarded as `compose`: a `contribution` adapter that throws leaves that contribution
  out (reported `contribution_failed`); a `value` adapter that throws fails only that version's value, by the rules of a
  throwing `compose` (its readers keep the last good mapped value; before any, a reader of that version waiting at
  activation fails `transient`, retried when a mapped value arrives); current readers are never affected.
- **Helpers:** `keyed(table, entriesOf, report)` (a map, a duplicate key reported through `report`, the first by plugin
  name wins) and
  `ordered(table, itemsOf, orderOf?)`.
- **Use sites guard contributions** (Q8): Chord's helpers keep each entry's plugin name; the guide shows catching a
  contribution's throws and rejections, reporting the plugin, and continuing.
- **Registries carry natives** (design §17): a contribution may be any in-process value; an entry lives exactly as long
  as its contributor.

## 2. `self.writable(initial)` and native sources

A `NativeWatchable<T>` with `set(value)` (identity compared: `set` of the same value notifies nobody; a new value is a
new frame), owned by the attempt (dropped with it; `set` after the attempt's seal throws `released`); never a state
member; usable as a contribution, a derive source and an `on` source. `set` inside a batch marks it there; outside, it
opens its own batch. `writable`, `RegistryValue` and `ref.state` (a `NativeWatchable` since slice 3b, until now not derivable: design audit,
2026-10-27) are native sources: one base (`NativeSource`) the batch marks and derives depend on; `self.derive` takes JSON and native sources (its type and the source resolver widen), while the
member check still refuses a native as a state member.

## 3. `self.retryOn(...sources)`

In any object's factory, anywhere: Chord follows each source with watches owned by the object (under its context,
replaced by each attempt's declaration, stopped at the object's end; GC-tested), installed right after the factory
returns, before natives open, so a failed open still has them; a `value` call of a source while the object is failed
(`transient` or `broken`) retries it as `ref.retry()` does (backoff skipped, an attempt now, holders told `loading`);
a call while it activates is remembered and retries it at once if that attempt fails (decision S1); ignored while live. Sources
are those that live independently of the attempt: a `RegistryValue`, `constant`; anything else (a reference's member,
a `writable` of the same attempt) is refused at runtime (declaration policy; TypeScript cannot tell them apart).

**Which calls retry (D2, owner, 2026-10-27):** only `value` calls: a new value of a source wakes a failed object; a
`failed` call (a throwing `compose`) does nothing, its next good composition retries.

## 4. `host.root(fn, context, options?)`

**Signature and guarantees (D3, owner, 2026-10-27; design §26 #25):** `host.root<T>(fn: (ctx: Ctx) => Promise<T>,
context: Context, options?: { principal?: P }): Promise<T>`. `fn` gets a call context like a handler's: the host's
principal (or `options.principal`, a trusted same-host caller's choice, as base code acting for an authenticated
user), this host's incarnation, `context`'s telemetry and abort signal linked until `fn` settles
(`withLinkedAbortSignal`), and `ctx.get`. When `fn` settles or `context` aborts, the call context is sealed:
`ctx.abortSignal` aborted, `ctx.get` rejects `released`, every reference it took released (their calls reject
`released`, their watches end), so an uncooperative `fn` fails at its next use of Chord, as a handler after its caller
cancelled; work outside Chord runs on until then. `ctx.get` before `load` resolved parks like any reference;
`host.close` seals every open root scope (the host keeps them), so an `fn` waiting in `sleep(ms, ctx)` ends; `host.root`
after `host.close` rejects `released`. No span of its own until slice 9.

- `chord(fn, context)` is p3's helper over `host.root` (design §24); Chord ships none.

## 5. Durable on registries (examples, p3's pattern)

- Durable's `HarnessOptions.registry` takes a `RegistryReader` (`snapshot()`, `subscribe(listener)`, the listener
  called synchronously after every publication). A `RegistryValue` offers a synchronous observer of its compositions
  (`observe(observer, ctx)`, as Durable's `observeXXX`: `advance` inside the flush that composed, record only; an
  attached observer counts as watching, so the lazy compose runs for it); Durable's
  `registryReader(value)` (in its `src`) reads `.value` in `snapshot()` and forwards `observe` to `subscribe`. The
  harness object declares the extensions registry with `self.registry(...)`, so it activates (and opens Durable) only
  once the registry has a value. p3's `compose` builds Durable's snapshot without throwing (a duplicate task name is
  reported and the later extension left out).
- **Durable's views from other objects** (carry-over from 6b): the object that opens Durable contributes its harness to
  a registry (`HarnessRegistry`, p3's); another object declares it in its factory and follows a view through its value:

  ```ts
  const harness = self.registry(HarnessRegistry);          // a dependency: activation waits for it
  self.retryOn(harness);                                   // the new harness's contribution wakes the failed follower
  const view = self.follow((observer, ctx) => harness.value.observeConversation(id, observer, ctx));
  ```

  When that harness closes, Durable ends the observer `failed` (S1, a Durable change in this slice: a Session close
  ends observers `failed`, `ended` only when the observed owner ended), so the follower fails `transient` and its retry
  follows the new harness.
- Examples: Chord's `29-registries.ts` (a router registry with two contributing plugins, a conflict reported, a
  `writable` contribution, a missing provider healing) and `30-host-root.ts`; Durable's `test/examples/37-harness-
  registry.ts` (a Durable harness on the store, its extensions from a registry, its views followed by a second object)
  and the `registryReader` tests in Durable's tree. Durable's `subscribe` listeners then run inside Chord's flush:
  they only wake Durable's scheduler (no Chord call; a reentrant one would throw `invalid/reentrant`), which the
  `registryReader` test pins.

## 6. Carry-over

From `slices.md` "Slice 8": `host.root` (D3); `retryOn` (section 3); registries recomposing in the owner's flush (W4);
`host.activity` on the facet's host: not built (nothing needs it; dropped from the carry-over); Durable's views from
other objects (section 5). Left to slice 7: registries on reload (a reload replaces a contribution and a provider
atomically; staging composes nothing, decision D1 of "Review round 1"); `accepts` of contracts and jobs; a `writable`
across a pure swap; older registry readers across a reload of the provider.

**New names** (design §3, §5, the pinned reason list): the reason `unavailable/undeclared`; `HostError` kinds
`registry_conflict`, `registry_failed`, `contribution_failed`, `contribution_refused`, each reported once per episode.

## 7. Tests and cost

- One `describe` per mechanism: tokens and providers (two serves refused, a missing one healing), contributors
  (R21's type and runtime refusals, facet and object lifetimes, one value each), the table (order by plugin, versions
  adapted, refused versions reported), `compose` (in the flush, after a commit that changed a watchable contribution,
  conflicts reported, a throw as a failure call and its heal), reading (`self.registry` in derives and `on`, `.value` at
  use), `writable` (identity, batching, as a contribution), `retryOn` (a failed object retried by a contribution, value
  calls only, sources installed before natives), `host.root` (principal, release at settle, abort, before load, after
  close), `registryReader` with a Durable harness; GC for every table, writable and root scope.
- Cost guards: one compose per flush per changed table; no compose for an unchanged table; a `writable.set` of the same
  value costs one comparison.
