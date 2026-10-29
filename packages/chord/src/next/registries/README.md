# registries

Registries (design §17, slice 8): an extension point between plugins. The defining plugin shares a token and serves
it with `compose`; facets and host-lifetime objects contribute; readers follow the composed value.

## For apps (`index.ts`)

```ts
import { defineRegistry, keyedEntries } from "./index.ts";

// Shared by every plugin, as a contract: identity and types only.
export const Http = defineRegistry<HttpContribution, Router>("chord.http", { version: 2 });

defineFacet((host, self) => {
	host.serve(Http, {                                                      // the defining plugin: the one provider
		compose: (table, { report }) => routerOf(keyedEntries(table, (c) => c.routes, report)),
		accepts: { 1: { contribution: (old: HttpV1) => upgrade(old), value: (router) => routerV1(router) } },
	});
	self.contribute(Http, { routes: { "GET /notes": exportNotes } });       // while this plugin is loaded
});
host.serve(Mcp, (_, self) => {                                            // local, empty params: may contribute (R21)
	const ext = self.writable(mcpExtension([]));
	self.contribute(Extensions, ext);                                       // from live until it fails, ends or restarts
	self.retryOn(self.registry(Models));                                    // a new model wakes it while failed (rare changes)
	return {};
});
host.serve(Server, (_, self) => {
	const router = self.registry(Http);                                     // a dependency; `.value` at use
	return { request: async (req, ctx) => router.value.route(req, ctx) };
});
```

- `defineRegistry<C, V>(name, { version })`: a token. `name` follows the type names' rule (`[a-z0-9@/._~-]`),
  `version` is the version this plugin is built against. `C` is what contributors give, `V` what readers get.
- `host.serve(R, { compose, accepts? })` in the defining plugin's facet (`host/`). `compose(table, { report })` is pure
  and synchronous and always returns a value (a fallback built in); `report({ message, plugins })` reports a conflict
  it resolved, as `registry_conflict`, once per episode (a conflict reported by the last good composition is not
  reported again). It runs at the end of `load`'s setups (every served registry once, an empty table too), then lazily:
  a change of the table marks it, and it composes when read or, while someone watches, observes or waits for it, in
  the batch that changed the table (after the commit's adoptions); an unchanged table (every entry the same) composes
  nothing. A `compose` that throws is the owner's bug: `registry_failed` once per episode, watches get one `failed`
  call, `.value` keeps the last good composition while every contribution it was built from is still in the table
  (before any, or once one of them left, it throws the error: a contributor that failed or ended may have closed the
  native its entry held; decision 5, slice 7a); the next good composition is a value call, also when its value is the
  same.
- The table (`RegistryTable<C>`): one `RegistryEntry { plugin, type?, version, value }` per live contributor, sorted by
  plugin name, then type (a facet's entry first): never load order. A contribution of an older version is adapted with
  `accepts[version].contribution` once per contribution value; a newer one, or an older one without an adapter, is left
  out and reported `contribution_refused` once. A Chord watchable contribution (a writable, a derive, a document, a
  reference member, another registry's value) is followed: its change marks the table; one that fails or ends (a
  registry whose `compose` threw too, though its readers keep its last good value), or whose adapter throws, is left
  out and reported `contribution_failed` once per episode, and is back when it heals. Anything else is a plain value,
  whatever methods it has (`undefined` included).
- Readers: `self.registry(R)` (a declared dependency, `host/`) and `await host.registry(R, ctx)` give a
  `RegistryValue<V>`: a native watchable (`.value`, `watch`) with `observe(observer, ctx)`, a synchronous observer of
  its compositions (Durable's shape, for `registryReader`). A reader whose token is older than the provider's gets the
  composition mapped back with `accepts[version].value`, once per composition, only while read or followed; a mapping
  that throws fails that version only (`registry_failed`, its last good mapping kept while every contribution the
  composition it was mapped from was built from is still in the table: decision 5 holds for every version). A reader without a mapping, or
  newer than the provider, gets `contract_mismatch`. The mapping is kept only while a reader or follower is there.
  Without a provider a registry has no value (`unavailable/undeclared`); its contributions wait in the table. A
  reader's attempt without a usable value parks `failed { waiting }` (`host/`), woken when the value turns usable; a
  `host.registry` waits the same way up to its `readyTimeout`.
- `keyedEntries(table, entriesOf, report)`: a map of every entry's keyed items, the first by plugin name keeping a key,
  a duplicate reported through `compose`'s `report`; `orderedEntries(table, itemsOf, orderOf?)`: every entry's items in
  table order, or by `orderOf`. Both keep each item's `plugin` (and `type`): a contribution is another plugin's code, so
  a use site catches its throws and rejections, reports the plugin, and goes on.
- Registries carry natives: an entry lives exactly as long as its contributor, and a last good composition no longer
  than the contributions it was built from; use sites look up at each use and keep nothing.

## For Chord's layers (`internal.ts`)

- `RegistryRecord`: one per registry and host (`ChordHost.registryRecord(name)`, made by its first use): the provider
  (`serve`), the contributions in table order (`add`, `remove`, inside a batch), the last table and composition
  (`start()`: composed now when dirty; a read while composing is a cycle, `invalid/cycle`), the episode reports, the
  direct edges between registries whose values are contributions in its table (counted, kept while those
  contributions are in it; `assertNoCycle` refuses a cycle at `contribute`, through those edges and the
  contributing attempt's own earlier declarations), and its values by reader version
  (`value(version)`); `close()` at the host's close.
- `RegistryContribution` (`contribution.ts`): one contributor's contribution, a `Dependent` of its source;
  `entry(version, provider)` is its table entry (the same object while its value is), or `undefined` when left out.
- `RegistryValueSource`: a `FollowedSource` per reader version; `read()` registers a reader (an attempt that declared
  it, until its references are released: an older version's mapping is kept meanwhile); `wait(waiter)` registers a
  `RegistryWaiter` (a parked attempt, a waiting `host.registry`), told with `dependencyMoved()` (inside the batch: it
  only records) at every change of whether the value is usable or of its failure while it is not (errors compared by
  value: a version mismatch is made per read), and with `closed(error)` when the host closes (`released/closed`: the
  wait ends); waiters count as followers, so a change composes for them. At the host's close it keeps its last start
  and lets the record (and the host) go. `RegistryRecord.composedFrom` and `inTable` give a mapping the provenance
  decision 5 checks.
