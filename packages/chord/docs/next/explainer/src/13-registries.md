
# Extension Points {#registries lede="The facet, registries and the HTTP component: how plugins add behaviour to each other without callbacks, and how the owner stays in charge."}

The notes plugin wants a download route, `GET /s/:session/notes.txt`. A logs plugin wants to time every request.
Several plugins add model providers, tools for the agent, commands for the TUI. Someone must combine these
contributions, decide conflicts, and replace one plugin's part as a whole when it reloads. Between plugins exactly two
things pass: object types and **registries**.

## The facet, completed

The facet has appeared since chapter II as the place that serves types. It is also itself a **pure object** with the
host's lifetime:

```ts
// notes/server.ts
export default defineFacet((host, self) => {
  const prefs = self.state(NotesPrefs);                                  // plugin-wide documents
  self.contribute(Http, { routes: { "GET /s/:session/notes.txt": exportNotes } });
  host.serve(NoteCountStore, …, { lifetime: "host" });
  host.serve(NoteCounts, …);
});
```

- It may hold documents, references, routines and contributions; **no natives** (those need an object with its own
  lifetime).
- Its identity is the plugin's name, so its persisted documents survive restarts and reloads.
- Served objects go live after the facet and may read and write its documents (chapter V).
- `host.serve` and `self.contribute` are valid only while the setup runs. The facet never `self.get`s a type it
  serves.

## Registries

A registry is an extension point owned by someone (a Chord component, the app, a plugin). Each contributor
contributes **at most one value** per registry; the table is an immutable, ordered list of `(contributor, value)`;
the registry's `compose` turns it into the value consumers use.

```ts
// owned by the HTTP component
export const Http = defineRegistry<HttpContribution, Router>("chord.http", {
  version: 2,
  accepts: { 1: (old: HttpContributionV1): HttpContribution => upgrade(old) },
  compose: (table, { report }) => buildRouter(table, report),   // pure; always delivers a value
});

self.contribute(Http, { routes: { … }, wraps: [ … ] });          // a contributor
const router = host.registry(Http).value;                        // a consumer: live
```

**`compose` runs at runtime, whenever the table changes:** after a reload's commit, when a contributor goes live or
ends, when a contribution changes. It is not a staging check: contributions can be dynamic (known only once a native
is open), so no check before a reload could be complete. `compose` always delivers a value with its fallback built in
(e.g. the first by plugin name wins) and reports conflicts through `report`, which become owner notices and telemetry
events. Readers get a plain value and never handle conflicts. Only if `compose` throws is the registry in an error
state, and readers get an error when they use it. Work that started earlier keeps the value it read.

**Rules:**

- **Who contributes** (R21): only facets and `lifetime: "host"` objects; only their `self` has `contribute` (a type
  error elsewhere). Every object may read registries.
- **A contribution is in the table exactly while its contributor is live:** a facet's while its plugin is loaded; an
  object's from `live` until it ends, fails or restarts.
- **Order** is sorted by plugin name: deterministic on every host and across reloads, and deliberately meaningless.
  Meaningful order comes from the owner's composition (HTTP phases, below). Helpers: `keyed(table, entriesOf)`,
  `ordered(table, itemsOf, orderOf?)`.
- **One authoritative declaration** (Q8): only the defining plugin's facet declares the registry to the host
  (`compose`, version, `accepts`). Other plugins' tokens only identify it by name and types. A reload of the defining
  plugin replaces the declaration atomically and the table recomposes. If the defining plugin is not loaded, the
  registry has no value (readers get an error like a failed reference) and contributions wait in the table.
- **Versions** (Q8): a contribution carries the registry version its plugin was built against; older ones are adapted
  by the defining facet's pure `accepts`. One without a matching version or adapter is left out and reported naming
  plugin, registry and versions; its plugin keeps working. Contributions are in-process values (often functions) and
  are not schema-checked.
- **Use sites guard contributions.** A contribution is untrusted code (third-party plugins are a goal). Every use site
  catches throws and rejections when calling an entry, reports naming the contributor, and continues with the others.
- **The owner decides** conflicts, order and selection. Registries add behaviour; they never replace an owner's checks.

## Natives through registries

Registries are the only way a native reaches another plugin. An entry lives exactly as long as its contributor;
consumers look up at each use (or follow the composed value) and keep nothing from an entry beyond a use. The models
plugin's host-lifetime object contributes its runtime; the harness looks it up at every request. After a models reload
the next request gets the new runtime, while a running stream finishes on the old one.

A handler that stores `const r = entry()` in a module variable and uses it for days has a bug: after the contributor
restarts it holds a closed native.

## Contributions that change

Some contributions are known only at runtime: MCP tools appear when a server connects. A contribution is either fixed
for its contributor's life (dynamic parts behind handles read at use) or a **readable**, which Chord subscribes to;
on every change Chord replaces that entry and runs `compose` again. For in-process values, `self.writable(initial)` is
a host-local readable of any value (no JSON, no wire, compared by identity) with `set`:

```ts
const ext = self.writable(mcpExtension([]));                   // a Durable Extension, no tools yet
self.contribute(HarnessExtensions, ext);
self.routines.on(mcp.tools, (tools) => ext.set(mcpExtension(tools)));
```

There is no remove call. An entry leaves when its contributor ends, or after a reload whose new code no longer
contributes. A live contributor with nothing to offer sets its readable to the registry's empty value (an extension
without tools, empty routes); the table keeps exactly one entry per live contributor.

## Optional dependencies

Registries also replace optional references (chapter VI). Radius forwards connections to ports the ports plugin
manages, but ports is optional. So radius owns `radius.forwards` and ports contributes its forwards; without ports the
table is empty and radius works.

## The HTTP component

HTTP is an optional Chord component (`@earendil-works/chord/next/http`) built on a registry. A route gets a plain
request summary (method, path params, query, principal, provenance such as local or relayed, selected headers, parsed
and capped JSON bodies, uploads in chunks) and a `ctx` whose `principal` is the request's, so `ctx.get(Notes, …)` gives
exactly the view that person may see. The route returns a description; the component does the HTTP work once (ranges
with 206 and 416, HEAD, download headers with a safe filename, `nosniff`, CSP and its nonce, caching, streaming, abort
on disconnect):

```ts
type HttpResponse =
  | { kind: "json"; value: JsonValue } | { kind: "page"; title: string; body: string }
  | { kind: "bytes"; name: string; mime: string; size: number; read(offset: number, length: number): Promise<Uint8Array> }
  | { kind: "redirect"; to: string } | { kind: "error"; status: number };

// notes/server.ts
self.contribute(Http, {
  routes: {
    "GET /s/:session/notes.txt": async (req, ctx) => {
      const notes = await ctx.get(Notes, { session: req.params.session });   // the requester's view
      const text = new TextEncoder().encode(render(notes.notes.value));
      return { kind: "bytes", name: "notes.txt", mime: "text/plain", size: text.byteLength,
               read: async (offset, length) => text.subarray(offset, offset + length) };
    },
  },
});
```

Routes compose with `keyed`: two contributors with one pattern is a reported conflict, and the first by plugin name
wins. **Wraps** are middleware in phases the owner defines (`observe`, `headers`, `transform`, outermost first),
within a phase in contributor order. No numeric priorities: plugins have no single registration order, so Fastify's
lifecycle phases and encapsulation are the model, not Express.

```ts
// logs/server.ts
self.contribute(Http, {
  wraps: [{
    name: "access-log", phase: "observe", scope: "all",          // default scope "own": only own routes
    wrap: async (req, next, ctx) => {
      const t = Date.now();
      const res = await next(req);
      log(req, res, Date.now() - t);
      return res;
    },
  }],
});
```

`route` narrows a wrap to one route; a `route` that does not exist is a reported conflict. Wraps may add a security
boundary on top of an owner's checks, never instead of them. A request uses the router as it was when it started.
Request resolvers (who sent a request: cookie, loopback, relay) are hooks over the summary.

## Channels and big bytes

**Channels** are WebSocket byte channels (`send`, `onData`, `close`) for terminals, separate from object links and
with their own acknowledged windows, so a large state message never holds up keystrokes.

**Big transfers are chunked by the owner,** not by Chord: bytes are a schema type (`bytes()`), carried natively
(never base64), and a 50 MB upload is a protocol of plain calls:

```ts
beginUpload({ name, size }, ctx)               → { upload }
append({ upload, offset, bytes }, ctx)         // about 1 MiB per chunk; the awaited call is the backpressure
finishUpload({ upload }, ctx)                  → { id }
read({ id, offset, length }, ctx)              → bytes
```

After a link drop the `append` in flight fails like any call; the writer asks the owner for the stored offset and
resumes. Unfinished uploads expire through the owner's routine. Chord has no stream type: it would need its own rules
for drops, cancellation, relays and restarts, which this offset protocol already survives.

:::note | Built so far
Registries are layer L9. The HTTP component, channels and the chunked-transfer helper are deferred until after the
kernel and a first real proof (the harness, one tool with an approval pause, a code mode reload); until then the
playground serves its pages with plain app code. Their design stays the target.
:::
