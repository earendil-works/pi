---
title: Slice 7b: reloading plugins in a running Chord app
cover: Slice 7b / Reload
kicker: A design brief · Chord v2 · slice 7b · 2026-10-29
subtitle: What a plugin is, how it is built and loaded, how a mini p2 is assembled from Chord, and what happens when a plugin's code changes on one host or across many
stats:
  - 4 | steps of a reload on one host
  - 3 | fates of a live object
  - 26 | carry-over items from slices 3a to 7a
  - 11 ms | to rebuild one facet after an edit
  - 6 | decisions open
note: |
  A brief before the slice 7b spec, written by the redesign session from `design.md` §21, the dependency model
  (`dependencies/model.md`, decided and built for 7a in pi `339847eb1`), the carry-over in `slices.md` and the code at
  `339847eb1`. Marks: **Decided** points cite the decision; **Open** points are the owner's, with a recommendation.
colophon: Slice 7b brief · 2026-10-29 · Chord v2
---

# Before we begin {.preface}

Mario edits the notes plugin while a session is open: a new method, a renamed field in a document, a second state
member. He presses Reload. The server, the session's worker and two browser tabs run the old notes code; within a
second they should all run the new one, with the notes, the open views and the running export job intact, and without
restarting a single process.

Chord v2 can do everything around that today: objects, references across hosts, the store, jobs, registries, and since
7a a dependency model in which a missing provider is a wait, not an error. What it cannot do yet is change code. `load`
runs once per host (`host.ts`: "load runs once per host"). Slice 7b adds the reload, on one host and across hosts.

## Eight things to know

:::findings
1. **A reload is a transaction per host.** Load the bundles, stage the new declarations, commit atomically, then let
   each object follow; any code error before the commit leaves the host entirely on its old code.
2. **A live object has three fates.** Pure objects swap in place; objects with natives drain and restart; objects of a
   removed type end, and their holders wait.
3. **Old calls finish on old code.** A pure swap keeps the running calls' old handles valid until they settle; only new
   calls see the new code.
4. **Versions are the provider's business.** A provider accepts older consumers through `accepts`; a consumer that does
   not fit waits (7a), it is not ended.
5. **7a already decided most of the hard part.** Removal, dropped versions and installs are waits woken by a
   publication; a reload's commit is such a publication.
6. **A plugin is a directory with a `package.json` and one file per surface.** Each facet is bundled alone; host
   packages are passed in, never copied; a whole plugin set builds in a few hundred milliseconds.
7. **Chord should ship the app kit** (proposed): loader, HTTP, workers, web, TUI and dev reload as optional
   components, so a mini p2 is a page of code.
8. **Six points are open:** the reload API, the rollout across hosts, a `writable` across a swap, the install
   watchdog, where the loader lives, and the app kit.
:::

## Words used throughout

A **reload** changes the code of one or more plugins on one host. A **facet** is a plugin's code for one host kind; a
**bundle** is the built JavaScript of a facet. **Staging** runs the new facets and factories against a recording
`self` without activating anything. The **commit** switches the host to the new code at once and is a **publication**
in 7a's sense. A **pure** object has no natives (`self.open`), in its old or its new code. A **rollout** is a reload
of the same code set on every host, server first.

# A Plugin, File by File {#plugin lede="What a plugin looks like on disk, and what each file is for."}

A plugin is a directory. Its name is its `package.json` name; its code is one file per host kind it runs on, a
**facet**; everything else is ordinary TypeScript the facets import. This is p2's layout today (`apps/p2/plugins/*`),
plus the `package.json` that loader D needs (p2's `plugin-loading.md` §8; p2's built-in plugins have none yet and are
named by their directory).

```text
plugins/notes/
  package.json        name = the plugin's name; peerDependencies = host packages; dependencies = bundled npm deps
  contract.ts         the plugin's object types and registries (shared by its facets and by other plugins)
  server.ts           facet for the server     (default export: defineFacet(...))
  worker.ts           facet for session workers
  web.tsx             facet for browser tabs
  tui.ts              facet for the TUI
  store.ts            plain modules the facets import
  NoteList.tsx
  notes.css
  assets/
    template.md       files the plugin ships (read at runtime, or offered for download)
    icon.svg
  skills/notes/SKILL.md   optional resources (p2 §4.4)
```

```json
{
  "name": "@pi/notes",
  "version": "1.4.0",
  "type": "module",
  "peerDependencies": {
    "@earendil-works/chord": "^2",
    "@earendil-works/pi-durable": "^1",
    "react": "^19"
  },
  "dependencies": {
    "marked": "16.4.1"
  }
}
```

- **`name`** identifies the plugin everywhere: its facets, its registry contributions, diagnostics, reloads.
- **`peerDependencies`** are **host packages**: the running app supplies them, one instance per process (one Chord,
  one React; `instanceof ChordError` and React hooks only work that way). The bundler never copies them.
- **`dependencies`** are the plugin's own npm packages (`marked`): installed into the plugin's `node_modules` with
  `--ignore-scripts` and bundled into every facet that imports them. **Decided** (owner, 2026-10-29): bundled by
  default; on Node a plugin may keep named packages external by an explicit list, `"chord": { "external":
  ["better-sqlite3"] }`. Server and worker facets then load them from the plugin's `node_modules` with `createRequire`,
  as pi 1.0 loads extension dependencies, native addons included; they stay in Node's module cache until the process
  ends, so a new version takes effect after a restart. A browser or TUI facet that imports one fails to build.
- **No `tsconfig.json` is needed.** The bundler strips types and does not type-check; JSX is compiled with the
  automatic React runtime, a fixed setting of the loader. A plugin may keep a `tsconfig.json` for its editor and for
  `tsc --noEmit` (the SDK ships one to extend); the loader ignores it.

A facet only declares (chapter III of the model): it serves object types, serves or contributes to registries, and
returns nothing.

```ts
// plugins/notes/contract.ts
import { defineRegistry, local, remote, str, obj, arr, method } from "@earendil-works/chord/next";
import { Session } from "@app/core";                        // the app's host kinds, a host package
export const NoteStore = local("notes.store", { version: 1, params: {}, members: { /* … */ } });
export const Notes = remote("notes", {
  version: 2,
  params: { session: str() },
  hostAddress: ({ session }) => Session({ id: session }),
  variants: { editor: { state: { list: arr(obj({ id: str(), text: str() })) }, methods: { add: method(obj({ text: str() })) } } },
});

// plugins/notes/worker.ts
import { defineFacet } from "@app/core";                    // bound to the app's principal type
import { NoteStore, Notes } from "./contract.ts";
import { serveStore } from "./store.ts";
export default defineFacet((host) => {
  host.serve(NoteStore, serveStore);
  host.serve(Notes, ({ session }, principal, self) => { /* … */ });
});

// plugins/notes/web.tsx
import { defineFacet } from "@app/core";
import { NoteList } from "./NoteList.tsx";                  // a React component, bundled
import "./notes.css";                                       // bundled into the facet's stylesheet
export default defineFacet((host, self) => {
  self.contribute(Panels, { notes: NoteList });             // the app's UI registry
});
```

# Building and Loading {#loading lede="How the bundler knows what to pull in, and how the code gets into a running process."}

Each facet is built on its own, as one script. The bundler starts at the facet file and follows its imports:

| An import of | Becomes |
| --- | --- |
| the plugin's own files (`./store.ts`, `./NoteList.tsx`) | inlined into the facet's script |
| another plugin's contract (`../sessions/contract.ts`, or `@pi/sessions/contract` for an installed package) | inlined too: a copy, so a plugin carries the contract version it was built against (`accepts` needs that); only contracts and side-effect-free modules may be imported across plugins |
| an npm package in `dependencies` (`marked`) | inlined, resolved from the plugin's own `node_modules` |
| an npm package listed in `chord.external` (Node facets only) | external: `require`d from the plugin's own `node_modules` at evaluation |
| a host package (`@earendil-works/chord/next`, `react`, `@app/core`, …) | **external**: a parameter of the script, the host's instance at load time |
| a Node builtin (`node:fs`) | external, through the `require` the loader passes (server and worker facets only; a web facet that imports one fails to build) |
| CSS (`import "./notes.css"`) | collected into one stylesheet per web facet |
| an asset by URL (`import iconUrl from "./assets/icon.svg?url"`) | a content-hashed file served by the app; the import is its URL |

The built script is a function of its host packages. That is the whole trick of loader D: there is no module map, no
second copy of Chord, and an old version is garbage-collected once nothing holds its closures.

```js
// what the bundler emits for plugins/notes/worker.ts (simplified)
(function (require, __files) {
  const { defineFacet } = require("@app/core");             // the host's instance
  const { local, remote, str } = require("@earendil-works/chord/next");
  const { marked } = /* marked's code, inlined */;
  /* contract.ts, store.ts, inlined */
  return defineFacet((host) => { /* … */ });
})
```

```ts
// the loader (proposed @earendil-works/chord/next/loader), Node side
import { buildFacet, evaluateFacet } from "@earendil-works/chord/next/loader";

const HOST_PACKAGES = {                                     // the app's base bundle exports these
  "@earendil-works/chord/next": chordNext, "@earendil-works/pi-durable": durable,
  "@app/core": core, react, "react/jsx-runtime": jsxRuntime,
};
const script = await buildFacet({ plugin: "/data/plugins/notes", facet: "worker.ts", hostPackages: Object.keys(HOST_PACKAGES), platform: "node" });
const facet = evaluateFacet(script, { hostPackages: HOST_PACKAGES, require: createRequire(import.meta.url), dir: "/data/plugins/notes" });
await host.reload([{ name: "@pi/notes", facet }], ctx);    // or host.load the first time
```

- `buildFacet` is esbuild with: the facet as entry, the host packages and `node:*` external, `format: "cjs"` wrapped
  as the function above, minified, an `onResolve` that refuses anything outside the plugin, its `node_modules`, a
  contract of another plugin or a host package. It returns the script, its content hash and esbuild's metafile (the
  dev loop knows which files a facet used).
- `evaluateFacet` runs the script with `vm.Script` and a stable filename per (facet, hash) on Node, or as a classic
  `<script>` in the browser (the page fetches the script and its stylesheet by hash, which caches forever).
- **Imports a plugin cannot use:** dynamic `import()` (resolved at build, or not at all), top-level `await` (a facet is a
  synchronous declaration), `require` of anything but builtins.

:::review | Open 5: where the loader lives
(a) Chord ships `chord/next/loader` (discovery, `buildFacet`, `evaluateFacet`, `pluginFile`), an app chooses its host
packages; (b) Chord knows only `host.reload(facets)` and the app bundles and evaluates. Recommended: (a); the kernel
stays free of it, and Durable Objects (no `eval`) compose statically as before.
:::

# Assets and Files {#assets lede="Files a plugin ships: bundled into the browser, read at runtime, or offered for download."}

A plugin has files that are not code. They fall into three cases.

**1. Imported by a web facet.** CSS, images, wasm. The bundler emits them as content-hashed files next to the facet's
script, and the import evaluates to their URL. The app serves the bundle's files under one path; p2 does exactly this
today for the terminal's wasm (`plugins/terminals/Terminal.tsx`: `import ghosttyWasm from
"../../vendor/ghostty/ghostty-vt.wasm?url"`, served under `/__p2_web/`).

```tsx
import iconUrl from "./assets/icon.svg?url";
export const NoteIcon = () => <img src={iconUrl} alt="" />;
```

**2. Read at runtime by a server or worker facet.** A template, a wasm module for a native, a script a native runs. A
bundled script has no meaningful `import.meta.url` (today's `plugins/terminals/main.ts` reads its wasm with
`new URL("../../vendor/…", import.meta.url)`). The loader passes the plugin's directory, and a helper resolves a path
inside it, refusing `..` out of it:

```ts
// plugins/notes/worker.ts
import { pluginFile } from "@earendil-works/chord/next/loader";   // reads the directory the loader passed
const template = await readFile(pluginFile("assets/template.md"), "utf8");
```

**3. Offered for download over HTTP.** A plugin contributes a route to the app's HTTP registry; the handler opens the
file through the same helper and streams it, with the plugin's own authorization:

```ts
// plugins/notes/server.ts
export default defineFacet((host, self) => {
  self.contribute(Http, {
    routes: {
      "GET /notes/template.md": async (request, ctx) => {
        if (ctx.principal.kind !== "owner") return { kind: "error", status: 403 };
        const path = pluginFile("assets/template.md");
        const { size } = await stat(path);
        return { kind: "bytes", name: "template.md", mime: "text/markdown", size, read: (offset, length) => readRange(path, offset, length) };
      },
    },
  });
});
```

So yes: a plugin can offer its files for download, because the loader tells it where it lives. Each facet sees only its
own plugin's directory; nothing gives it another plugin's files.

# HTTP {#http lede="What Chord provides, what p2 has, and what p3 needs."}

**Chord v2 has no HTTP server today.** Design §23 designs one (`@earendil-works/chord/next/http`) and defers it until
"the kernel fixes and a first real proof" are done. p2's HTTP is its own, about 30 lines of helpers plus the server host:

```ts
// apps/p2/src/runtime/server.ts (p2 today, Chord v1)
export const Routes = defineRegistry<RouteHandler>("p2.routes", { conflict: "error" });        // "METHOD /path" → handler
export const Upgrades = defineRegistry<UpgradeHandler>("p2.upgrades", { conflict: "error" });   // WebSocket upgrades
export const RequestResolvers = defineRegistry<RequestResolver>("p2.request-resolvers", { conflict: "error" });
type RouteHandler = (request: IncomingMessage, response: ServerResponse, access: RequestAccess, ctx: Ctx) => void | Promise<void>;
```

Plugins contribute handlers that write to Node's `ServerResponse` themselves; the files plugin implements ranges,
download headers and previews by hand (`plugins/files/server.ts`).

The designed component (§23) replaces raw responses with descriptions, so every plugin gets ranges (206/416), `HEAD`,
safe download headers, streaming and abort on disconnect from one place:

```ts
export const Http = defineRegistry<HttpContribution, Router>("chord.http", { version: 1 });
type HttpContribution = { routes?: Record<string, Route>; wraps?: Wrap[] };
type Route = (req: HttpRequest, ctx: Ctx) => Promise<HttpResponse>;   // ctx.principal: the request's principal
type HttpResponse =
  | { kind: "json"; value: JsonValue } | { kind: "page"; title: string; body: string }
  | { kind: "bytes"; name: string; mime: string; size: number; read(offset: number, length: number): Promise<Uint8Array> }
  | { kind: "redirect"; to: string } | { kind: "error"; status: number };
```

- Routes compose by `keyedEntries`: a duplicate pattern is a reported conflict, the first by plugin name wins.
- Wraps (middleware) run in phases the owner defines (`observe`, `headers`, `transform`), by default only around their
  own plugin's routes.
- Request resolvers (who sent a request: cookie, loopback, relay) are hooks; WebSocket byte channels for terminals are
  a separate component.

# Performance {#perf lede="Measured on slayer, Node 24, esbuild from the repo, p2's plugins as they are."}

Built with the loader D settings above (each facet alone, host packages and `apps/p2/src` external, minified), on
p2's real plugins:

| Measurement | Result |
| --- | --- |
| all 25 worker facets, one script each, cold | 237 ms, 294 KB in total, largest `models/worker.ts` 35 KB |
| all 20 server facets, cold | 167 ms, 236 KB |
| all 17 web facets, cold | 144 ms, 912 KB, of which 688 KB is the terminal's wasm |
| one facet rebuilt after an edit (esbuild context, warm) | 11 ms |
| compile and evaluate all 25 worker scripts (`vm.Script`) | 23 ms |
| worker spawn to ready, p2 today (TypeScript through the source resolver, `nodeLoader`) | 549 ms (p2's measurement, `plugin-loading.md` §14.1) |
| the same with one bundle per worker plugin set | 218 ms |
| base bundle plus one script per plugin through ESM (model B) | 254 ms; D is expected near it |

The plugins are small; the time goes into the host packages and the runtime (85% of a worker's load time, p2 §14.1),
which the base bundle loads once per process. A reload of one plugin costs one rebuild (about 11 ms warm) and one
evaluation (about 1 ms per facet), then Chord's reload. The memory caveat is V8's compilation cache: every distinct
compiled script stays cached, so scripts get a stable name per (facet, hash) and hosts that reload in place run with
the cache off (+0.1 MiB instead of +5.6 MiB per 100 reloads, p2's measurement).

# A Mini p2 from Chord {#kit lede="The owner: building a small p2 with a web and a TUI surface and plugins should be trivial from Chord; optional components should come out of the box."}

p2 has about 10,700 lines of host code in `apps/p2/src/hosts` and its runtime: the server's HTTP and WebSocket
entry, the worker supervisor, plugin discovery, the web and TUI bundles, the web shell, the TUI sandbox and launcher,
the reload control. Almost none of it is p2-specific. The proposal: Chord ships it as optional components, each a
subpath an app imports only if it wants it, none of them in Chord's kernel.

## What it would look like

```ts
// server.ts: a whole app with plugins, a web and a TUI surface
import { createHost } from "@earendil-works/chord/next";
import { discoverPlugins, pluginLoader } from "@earendil-works/chord/next/loader";
import { httpServer } from "@earendil-works/chord/next/http";
import { workerRoute } from "@earendil-works/chord/next/workers";
import { webSurface } from "@earendil-works/chord/next/web";
import { tuiSurface } from "@earendil-works/chord/next/tui";
import { devReload } from "@earendil-works/chord/next/dev";
import { Server, Session, core } from "./core.ts";              // the app's base code: host kinds, principals, core facet

const plugins = await discoverPlugins(["./plugins", join(dataDir, "plugins")]);
const loader = pluginLoader({ hostPackages: core.hostPackages });

const server = createHost<P>({ address: Server(), principal: { kind: "server" }, onError });
server.route(Session, workerRoute({ entry: "./worker.ts", idleMs: 300_000, authorize: core.authorize }), ctx);
await server.load([core.serverFacet, ...(await loader.facets(plugins, "server"))], ctx);

const http = httpServer(server, { port: 4321, authenticate: core.authenticate });   // routes from the Http registry
http.surface(webSurface({ loader, plugins, shell: core.webShell }));                  // /: the page, its bundle, its socket
http.surface(tuiSurface({ loader, plugins }));                                        // the TUI launcher's bundle and socket
devReload({ server, loader, plugins, watch: true });                                 // a changed plugin reloads everywhere
```

```ts
// worker.ts
import { workerMain } from "@earendil-works/chord/next/workers";
await workerMain(async ({ address, init, parent }) => {
  const worker = createHost<P>({ address, principal: { kind: "worker", session: init.id }, onError });
  worker.connect(parent, { principal: { kind: "server" }, trusted: true }, ctx);
  await worker.load([core.workerFacet(init), ...(await loader.facets(init.plugins, "worker"))], ctx);
  return worker;
});
```

```tsx
// core.ts, the web shell: the app decides the layout; plugins fill registries
export const Panels = defineRegistry<Record<string, ComponentType>, Panel[]>("app.panels", { version: 1 });
export const webShell = ({ host }: ShellProps) => {
  const panels = useRegistry(host, Panels);                     // from chord/next/web: a hook over a registry value
  return <Tabs>{panels.map((p) => <p.component key={p.name} />)}</Tabs>;
};
```

And a plugin is what chapter I shows: a directory, a `package.json`, facets that serve types and contribute to the
app's registries (`Http`, `Panels`, a TUI command list).

## The components

| Subpath | What it does | Replaces in p2 |
| --- | --- | --- |
| `chord/next/loader` | `discoverPlugins` (directory listing, `package.json` names, no parsing), `buildFacet` (esbuild, host packages external), `evaluateFacet` (Node `vm`, browser `<script>`), `pluginFile`, npm/git install with `--ignore-scripts` | `src/hosts/plugins.ts`, `bundles.ts`, the source resolver, `nodeLoader` |
| `chord/next/http` | the Node HTTP server, the `Http` registry (routes, wraps, request resolvers, responses as descriptions: ranges, downloads, `HEAD`), WebSocket entry calling `host.accept` | `src/hosts/server.ts` (HTTP part), `runtime/http.ts`, `Routes`, `Upgrades`, `RequestResolvers` |
| `chord/next/workers` | `workerRoute` (fork a worker per address, IPC link, start message, idle stop from `host.activity`, crash restart with backoff), `workerMain` (the child's side) | `SessionHosts` in `runtime/server.ts`, `hosts/worker.ts` |
| `chord/next/web` | the page host (connect over a WebSocket with reconnect, load web facets from their scripts, React provider and hooks: `useObject` over `host.hold`, `useRegistry`, `useWatch`), serving the bundle by hash, reload on a new manifest | `hosts/web/*`, `runtime/web.tsx`, `src/web/reconnect.ts` |
| `chord/next/tui` | the TUI launcher and sandbox (pi-tui, the bundle download, a link over the launcher's socket), slots and commands as registries | `hosts/tui-*.ts`, `runtime/tui.ts` |
| `chord/next/dev` | the source watcher marking plugins dirty, the reload control (`reload(plugins)` on every host in order: server, workers, then a manifest bump for pages and the TUI) | `performReload` in `hosts/server.ts`, the dev protocol |

Each is ordinary code on top of Chord's public API: nothing in the kernel depends on it, a Durable Object deployment
uses none of it, and an app can replace any one (its own HTTP server, its own shell). React is a host package of the web
component, pi-tui of the TUI component; an app without them never imports them.

## What stays the app's

The principal type and authentication; the host kinds (`Server`, `Session`) and what a worker's start message holds;
the core facet and core objects (catalog, harness); the web shell's layout and the TUI's look; which registries plugins
contribute to beyond `Http`. That is roughly what p3's base code should be: a few hundred lines, not ten thousand.

:::review | Open 6: the app kit
(a) Chord ships these six components as optional subpaths of `@earendil-works/chord`, built in this order: `loader`
and `dev` with 7b (reload needs them), `http` and `workers` next (p3 needs them first), `web` and `tui` after (lifted
from p2's code, which works today). (b) Chord ships only `loader`; the rest is p3's base code. Recommended: (a), as the
owner asked; each component gets its own slice spec and review, after 7b and before slice 9 or alongside p3's base.
:::

# One Host Reloads {#host lede="Four steps, all or nothing up to the commit."}

Design §21 fixes the shape. **Decided.**

```text
1. load      the new bundles; an import or syntax error rejects
2. staging   facet setups and every live object's new factory run with a recording `self`
             (declarations only, nothing activated); any throw rejects
3. commit    the host switches to the new code atomically: a publication (7a)
4. after     each object follows its fate (chapter II)
```

Rollback is all or nothing per host, and only for code errors: an import error, a throwing setup or factory. A failed
`open`, a registry conflict or a failing `migrate` after the commit are runtime states of single objects, never a
reason to roll back. A host is at revision R or R−1, never in between.

Staging runs factories against a recording `self` because a factory only declares: it returns members and calls
`self.state`, `self.get`, `self.open` and so on, and the recording tells Chord what changed (a new dependency, a native
added or removed, a member gone) before anything happens.

:::sequence animate | A reload of the notes plugin on the worker. Nothing is visible to callers until the commit.
actor app "base code" "reload control"
actor host "worker W" ""
actor objs "notes objects" "live"
app -> host: reload([notes v2], ctx)
host -> host: load bundles
host -> host: staging: setups + new factories (recording self)
host => host: commit: types, registries, contributions swapped; publication
host => objs: each follows its fate
objs --> app: resolved: { reloaded, restarted, ended, failed }
:::

:::review | Open 1: the API
Today a host has `load(facets, ctx)`, once. Proposal: `host.reload(facets, ctx)` with the plugins' new facets (by
plugin name: added, changed; a plugin missing from the list is removed), resolving with a report of what each object
did, rejecting with the code error and nothing changed. `load` stays the first call. Alternative: one
`host.load` that may be called again. Recommended: the separate `reload`, because its result differs (a report, not a
barrier) and its rollback rule does not apply to the first load (a throwing first setup closes the host).
:::

# Three Fates {#fates lede="What happens to each live object at the commit."}

The commit compares each live object's old and new declarations. **Decided** (design §21, owner 2026-10-26, the
dependency model).

| The object | Fate | Calls | Documents, jobs |
| --- | --- | --- | --- |
| pure, old and new (no `self.open`) | **swapped in place**: new methods, derives and routines; references kept, new ones made | running calls finish on old handles; new calls see new code | stay |
| has natives, old or new | **restarted**: new calls park, running calls drain (`closeTimeout`), natives close (`reload`), the new factory runs, natives reopen | park during the restart | stay; running job runs end `aborted { reload }`, `finish` runs on new code |
| its type is gone | **ended**: natives close (`end`), callers rejected, handlers drain | rejected | in-memory gone; persisted stay until retired |
| a new dependency is missing (any of the above) | **parks** (decision 4): gate closed, `failed { waiting }` | reject | stay |

```ts
// notes v1                                     // notes v2: pure, swapped in place
host.serve(NoteStore, (_, self) => {           host.serve(NoteStore, (_, self) => {
  const notes = self.state(Notes);               const notes = self.state(Notes);      // same document, v2 migrates it
  return {                                       const count = self.derive([notes], ([n]) => n.list.length);
    notes,                                       return {
    add: (a, ctx) => self.tx(…, ctx),              notes, count,                       // a new exposed member
  };                                               add: (a, ctx) => self.tx(…, ctx),
});                                                rename: (a, ctx) => self.tx(…, ctx), // a new method
                                                 };
                                               });
```

Rules that come with the fates, all **decided**:

- **R15, old code and migrated documents:** an old call that touches a document whose version rose throws once; the
  document stays intact; the call is not resent.
- **Derives** have no names: exposed derives are matched by their member name, internal ones are rebuilt.
- **Routines** hand over per object: the old ones are aborted, the new ones start once the old calls finished, bounded
  by `closeTimeout`; calls do not wait for it.
- **Instance ids:** a restarted object gets a new instance id (an old activation chain must not match it); a swapped one
  keeps it.
- **Broken objects** of a reloaded plugin are retried, as `ref.retry()` does.
- **A parked object** of a reloaded plugin is replaced by the new factory's attempt in one handover: the new requests
  bind before the old ones are released (the mechanism 7a removed comes back here).
- **In-memory documents** migrate on reload through their definition's `migrate` (6a built the version check).

:::review | Open 2: a `writable` across a pure swap
A pure swap runs the new factory, so `self.writable(initial)` makes a new writable at its initial value. An object that
contributes MCP's tool list through a writable then contributes an empty list until its restarted routine sets it again:
the tools vanish for a moment. Options: (a) accept it (the routine refills it within one call); (b) keep a writable's
value across a swap when the new factory declares a writable at the same position (as members are matched by name).
Recommended: (a); writables have no names, and position matching would be the first positional rule in Chord.
:::

# Consumers Across a Reload {#consumers lede="Holds, versions and old calls; 7a decided that nothing is ended for a code change."}

A reference on another host points at an object whose code may change under it. **Decided** (design §21, §22 and the
dependency model):

| The provider's reload | The consumer's hold | It sees |
| --- | --- | --- |
| still accepts the hold's version, object swapped | kept; re-subscribed through the version's mappings | one `[["r", value]]` per changed member |
| still accepts it, object restarted | kept | `loading`, then a fresh `bound` |
| stops accepting the version | unbound `version` | `failed { waiting }`; it binds again if a later reload accepts it |
| removes the type | unbound `not_served` | `failed { waiting }`; it binds again when the type comes back |

A provider accepts older consumers through `accepts`, written once with the provider, never in the shared contract
(Q10):

```ts
export const NotesV2 = evolve(NotesV1, (e) => e.state("editor", "notes", arr(NoteV2)).args("add", NoteV2));

host.serve(NotesV2, factory, {
  accepts: {
    1: {
      state: { editor: { notes: (current) => current.map(toV1) } },   // what a v1 tab sees, as a diff per commit
      methods: { add: { args: (old) => toV2(old) } },                 // a v1 tab's call, mapped forward
    },
  },
});
```

- **Old-version calls:** `checkArgs` returns `{ kind: "method", args, result? }` or `{ kind: "call", args, call }`; Chord
  runs the handler or the provider's replacement and maps the result back (L1 built the check; 7b invokes it).
- **Adapted bindings get diffs:** Chord keeps the last adapted value per binding and sends `diffRevisions`, so an old
  tab never receives a whole state per commit.
- **On the wire** (7b's half of 7a's model): a `failed` on a bound hold unbinds it; the provider drops its unsent
  pending work and keeps the ack slots of messages already sent; a consumer whose own code moves to a new version
  releases its old hold and makes a new one.
- **A consumer reloaded itself** gets new requests from its new factory; the handover binds them before it releases the
  old.

Today `host.serve` binds every provider with an empty accepts table (`host.ts`: `bindProvider(contract, {})`); 7b passes
the provider's table. Small and **decided** in shape (Q10, `bindProvider`); the option's place is `host.serve(Type,
factory, { accepts, linger })`.

# Jobs Across a Reload {#jobs lede="Runs belong to the object; their versions are mapped forward."}

**Decided** (design §15, owner 2026-10-24 and 2026-10-26):

```ts
const ExportJob = defineJob("notes.export", {
  version: 2,
  args: obj({ format: oneOf("md", "html") }),
  result: obj({ path: str() }),
  accepts: { 1: { args: (old) => ({ format: "md" }), result: (old) => ({ path: old.file }) } },
});
```

- A run started on an older version finishes on its old code across a pure swap; `finish` and `running` see its args
  and result mapped forwards, once per run.
- Without an adapter, or for a run of a newer version (a rollback), the run is `blocked { version }` until a reload
  brings matching code; blocked runs are retried on every reload. Nothing is aborted or discarded for a version change.
- A native restart aborts running runs (`aborted { reload }`) and `finish` runs on the new code.
- A job the new code no longer declares: its runs are `blocked { version }` (the same family), kept until a reload
  declares it again or they are aborted.
- Persisted runs of another version or fingerprint stay blocked with their record as stored, resolved by the reload
  that brings their version.

# Registries Across a Reload {#registries lede="A provider and its contributions are swapped in one batch."}

**Decided** (slice 8 §6, design §17): the commit replaces a plugin's contributions and a registry's provider in one
batch; staging composes nothing (D1). The record keeps the provider, facet contributions by plugin and object
contributions by object apart, so a reload of one plugin replaces exactly its parts (today `RegistryRecord.serve`
refuses a second serve). Older readers across a reload of the provider follow its new `accepts[old].value`. A reader
waits (7a) when the new provider no longer serves its version. `retryOn` watches are re-declared by the new factory.

# Across Hosts {#rollout lede="The same reload on every host, in an order that cannot deadlock."}

**Decided** (design §21 and the dependency model): a revision is the complete code set; the server installs first,
then workers, then clients; installs are serialized per host; a host that starts or reconnects installs the current
revision first; a revision carries a code-set digest so an unchanged server restart reinstalls nothing; an install
never waits for activations (a reverse-order rollout would deadlock); each host knows only its own install: while it
installs, holds that do not fit its running code wait `installing`, re-evaluated when the install ends; a host whose
own install was rejected fails its own requests with the reason.

:::steps | The notes contract goes from v1 to v2; the server installs first
+++ Before
S, W and T run revision R. T's notes view holds W's `Notes` v1. All live.
+++ S installs R+1
S has no notes objects of its own; its install commits. T, still on R, holds nothing on S that changed.
+++ W installs R+1 with `accepts[1]`
W's `Notes` v2 swaps in place and still accepts v1: T's hold is re-subscribed through the mapping and gets one diff.
+++ W installs R+1 without `accepts[1]`
T's hold becomes unbound `version`: `failed { waiting }`, last notes readable, calls reject with "update the page".
+++ T reloads its page
T's new code holds v2 with a new hold id; it binds; the old hold is released.
:::

:::review | Open 3: who runs the rollout
Chord's part is per host: `host.reload`, the `installing` state, and what a hold sees. The rest is distribution:
building bundles, sending them to workers, telling tabs to reload, ordering, the digest. Options: (a) Chord ships a
rollout protocol over its links (an `install` message from the server down, `installed`/`rejected` up, the digest in
`hello`); (b) distribution is the app's (p3's base code calls `host.reload` on each host and orders them), as p2 does
today (`apps/p2/src/hosts/server.ts` `performReload`: prepare every host, commit, publish bundles). Recommended: (b) for
7b, with Chord's per-host guarantees; a protocol only if a second app needs the same code.
:::

:::review | Open 4: the install watchdog (design §26 #24)
An install that hangs (a bundle that never loads, a staging factory that awaits forever, which it may not) leaves its
holds `installing` forever. Options: (a) a watchdog: `host.reload` rejects after `installTimeout` (default 60 s) and the
host stays on its old code; (b) no Chord timer: the app's context bounds the reload. Recommended: (b): `reload` takes a
context like everything else, and the app passes its deadline; a host option would be the only timer left in reload.
:::

# Decisions {.epilogue lede="What is settled for the spec, and what the owner decides first."}

**Decided** (spec material): the four steps and rollback per host; the three fates and the parking of a swap with a
missing dependency; old calls on old handles (R15); derives matched by member name; the routine handover; new instance
ids on restart; broken objects retried on reload; the handover of a parked attempt; in-memory `migrate`; holds kept,
re-subscribed or freshly bound; unbound `version` and `not_served` instead of `gone`; old-version calls and adapted
bindings as diffs; `accepts` in `host.serve`; jobs' version mapping, `blocked { version }` and retries on reload, runs
aborted on a native restart; registries swapped in one batch; rollout order, serialized installs, the digest,
`installing`, installs never waiting for activations; loader D's design: one script per facet, host packages passed in,
contracts bundled, no module map, stable script names, plugins' npm dependencies installed with `--ignore-scripts`.

**Open** for the owner:

| # | Point | Recommended |
| --- | --- | --- |
| 1 | the API: `host.reload(facets, ctx)` returning a report, or `load` callable again | `host.reload` |
| 2 | a `writable` across a pure swap: back to its initial value, or kept by position | back to initial |
| 3 | who runs the rollout: a Chord protocol, or the app calling `host.reload` per host | the app |
| 4 | the install watchdog: a host option `installTimeout`, or the app's context | the app's context |
| 5 | where loader D lives: Chord (`chord/next/loader`), or the app | Chord |
| 6 | the app kit: Chord ships loader, HTTP, workers, web, TUI and dev reload as optional subpaths, or only the loader | Chord ships them, in that order |
