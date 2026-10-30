# Slice 7c: plugins (spec)

Status: **ready to build** (owner, 2026-10-30: decisions "Slice 7c's points" and "Per plugin at startup and reload";
spec reviews by Fable and Opus, `/tmp/s7c-spec-review-{fable,opus}.md`, folded in). 7c builds `chord/next/plugins`: the
code that turns plugin directories into facets, loads and reloads them per plugin, and watches them. A Chord app is
self-modifying (the owner or an agent edits a plugin while it runs), so this is core machinery, not a dev tool (no
dev/prod split). It also changes the kernel's `load` and `reload` to per-plugin failure (§4). HTTP and workers are slice
10, the web page host and the TUI slice 11: 7c builds scripts for every surface and evaluates them on Node; its build
results are plain data those slices ship.

Read in full before writing code: this spec; `decisions.md` (2026-10-29/30: "Slice 7b's open points, as recommended",
"A plugin's npm dependencies are bundled", "Per plugin at startup and reload", "Slice 7c's points"); `design.md` (§3
`load`/`reload`, §16, §18, §21 in full); the 7b brief `slice-7b/book.md` (chapters "A Plugin, File by File", "Building
and Loading", "Assets and Files", "Performance", "A Mini p2 from Chord"); the two spec reviews; p2's
`apps/p2/src/hosts/{bundles,plugins}.ts` and `apps/p2/docs/plugin-loading.md` §4.1, §7.1, §8, §9, §14; coding-agent's
`packages/coding-agent/src/core/package-manager.ts` (dependency installs). Code lives in
`packages/chord/src/next-node/plugins/` (Node-only: `fs`, esbuild, `vm`; the kernel in `src/next` stays portable),
exported as `./next/plugins` when v2 gets its entry point; until then tests import the source.

## 1. A plugin on disk

```text
plugins/notes/
  package.json        "name": the plugin's name (required, npm style); "dependencies": bundled; "peerDependencies":
                      host packages; "chord": { "external": ["better-sqlite3"] } (optional, Node facets only)
  server.ts  worker.ts  web.tsx  tui.ts      one file per facet kind the app names; default export: a facet
  contract.ts  store.ts  NoteList.tsx  notes.css  assets/…   plain files
  node_modules/       its own npm dependencies (`installDependencies`)
```

- The plugin's name is its `package.json` `name`, never the directory name. A directory without a `package.json`, or
  with an invalid name, is reported, not a plugin.
- Facet kinds are the app's (`["server", "worker", "web", "tui"]` in p3), each `.ts`, `.tsx`, `.js` or `.mjs`; two
  files of one kind are reported (not chosen by extension). A plugin with none of the kinds (contracts only) is a
  plugin with no facets: imported by others, never loaded.
- Discovery lists each root one level deep, reads only `package.json`, follows symlinks to their real paths, and keeps
  the first root's plugin of a duplicate name (the other reported).

## 2. Building

```ts
const plugins = await discoverPlugins(["./plugins", join(dataDir, "plugins")], { kinds: KINDS }, ctx);
const built = await buildFacet(plugins[0], "worker", { hostPackages: HOST_NAMES, platform: "node" }, ctx);
// { kind: "script", plugin, facet: "worker", source, digest, inputs: [{ file, hash }], copied: [file],
//   css?: { name, text }, assets: [{ name, bytes }] }   |   { kind: "failed", plugin, facet, errors }
```

One esbuild build per (plugin, kind), from cold (no kept contexts: about 10 ms per facet; p2 measured 237 ms for 25
worker facets). A failed build is a result, never a throw. The result is plain data (strings, bytes, arrays): the same
value a worker (slice 10) or a page (slice 11) evaluates where it runs.

| An import of | Becomes |
| --- | --- |
| the plugin's own files | inlined |
| a file of another discovered plugin (`../sessions/contract.ts`) | inlined (a copy), listed in `copied`; it may import only host packages and files of its own plugin, never packages (a build error otherwise): contracts and side-effect-free modules only (decision 4) |
| a package in the plugin's `dependencies` | inlined from its `node_modules` |
| a package in `chord.external` (Node builds) | external, `require`d at evaluation from the plugin's `node_modules`; a browser build fails |
| a host package (`options.hostPackages`, e.g. `@earendil-works/chord/next`, `react`, `react/jsx-runtime`, `@app/core`) | external, from the map at evaluation |
| `@earendil-works/chord/next/plugins` | external always (its `pluginFile` is per facet, §3) |
| a Node builtin (`node:fs`, `fs`) | external (Node builds); a browser build fails |
| CSS (browser builds) | one stylesheet per facet (`css`) |
| an asset (`import url from "./icon.svg?url"`, `.wasm`, browser builds) | a content-hashed file in `assets`; the import is its URL under the app's `options.publicPath` |
| `import.meta.url`, `__dirname`, `__filename`, a literal dynamic `import("x")`, top-level `await` | a build error pointing to `pluginFile` (§3); a computed `import(x)` cannot be seen at build and fails when it runs, through the facet's `require` naming the facet |
| anything else (a relative path into base code, a package not in `dependencies`) | a build error naming the file and the rule |

- Output: `format: "cjs"`, wrapped `(function (require, module, exports) { … })`; TypeScript stripped, JSX automatic
  (`react/jsx-runtime`); no type check; minified; an inline source map whose `sources` are relative to the plugin's
  directory (so the script and its `digest`, a hash of the source, are the same on every machine and checkout).
- `inputs` are captured where esbuild loads each file (an `onLoad` that hashes the exact bytes it hands esbuild, as p2's
  `captureBundleInputs`; the metafile has no hashes), absolute paths, for the watcher.

## 3. Evaluating (Node)

```ts
const facet = evaluateFacet(built, { hostPackages: HOST, plugin });   // returns the facet, or throws its error
```

- `vm.Script` under a stable filename per (plugin, kind, digest), path-like (`/chord-plugins/@pi/notes/worker.ts`
  plus the digest), run in this context; the default export, checked to be a facet (a declaration error otherwise).
- **The `require` it passes answers, in order:** the host-package map (each value is what Node's `require` would give:
  a CommonJS package's exports, an ESM package's namespace wrapped once with `__esModule: true`, so default and named
  imports both work); `@earendil-works/chord/next/plugins` → `{ pluginFile }` bound to this plugin's directory;
  `chord.external` packages and Node builtins through `createRequire(join(plugin.dir, "package.json"))`; anything else
  throws naming the facet.
- **`pluginFile(path)`** gives the absolute path of a file inside the plugin's directory; `..` out of it is refused.
- **No module map, no cache:** an old facet's closures are collected once nothing holds them. The component turns V8's
  compilation cache off when it is created (`v8.setFlagsFromString("--no-compilation-cache")`, once per process; an
  app may pass the flag itself).
- **Stack traces** (decision Q1 (b)): `mapStack(error)` returns the error's stack with plugin scripts' positions mapped
  through their source maps (a `module.SourceMap` per evaluated script, kept while the script is) to `notes/worker.ts:12`;
  the app's reporters call it. Nothing global (no `Error.prepareStackTrace`, no process-wide source-map switch).

## 4. Loading and reloading, per plugin (kernel change)

Decision "Per plugin at startup and reload" changes `host.load` and `host.reload` (slice 7b) and the component's
`load`/`reload` helpers:

- **`host.load(facets, ctx)`** resolves with `{ failed: [{ plugin, error }] }`: a plugin whose setup throws (or that is
  refused at declaration: invalid name, a type or registry served twice, a remote type on a host without principal or
  address, `checkAccepts`) is left out and reported; the others publish; its consumers wait `failed { waiting }`. `load`
  never closes the host for a plugin (base code decides whether its core failing is fatal). A plugin left out is
  loaded by the next reload after an edit rebuilt it (it is dirty).
- **`host.reload(facets, ctx)`**: staging per plugin. A plugin whose new code fails in staging (setup, a factory against
  the recording `self`, a declaration error, `checkAccepts`) keeps its loaded facet (as if passed unchanged), and
  staging runs again without its new code. **The closure rule:** a changed plugin whose recorded requests (staging
  records them, for its existing objects, with their contract versions) would not bind (the same check as a real
  bind, the provider's host address included) because the plugin they need was kept old, or because nobody serves the
  name while any plugin of this reload failed (a failed new setup may be what would have served it: owner, 2026-10-30,
  "keep"), is kept old too (repeat until stable). The report gains `failed: [{ plugin, error }]` (the same list as `load`'s; an added plugin that fails is left out); the commit applies the rest.
- **The component** builds and evaluates per plugin: a plugin whose build fails or whose evaluation throws is passed to
  the host as its loaded facet at a reload, with `reload(facets, context, { failed })` naming it (the host applies the
  closure rule to it and lists it in `failed`), left out at startup and reported with the host's report.
  `plugins.load(host, ctx)` and `plugins.reload(host, names, ctx)` keep, per host, the facet loaded for every plugin, so
  `reload` always passes the complete set (unchanged plugins as the same facet object, removed ones left out) and never
  restarts an unchanged plugin.

## 5. Watching and rollout

```ts
const plugins = createPlugins({ roots: ["./plugins"], kinds: KINDS, hostPackages: HOST, base: ["./src"] }, ctx);
plugins.state      // a JSON watchable: { dirty: ["@pi/notes"], install: ["@pi/notes"], set: false, base: false }
const next = await plugins.build(["@pi/notes"], ctx);                 // built results per (plugin, kind), plain data
await rollout([serverStep, ...workerSteps, ...clientSteps], next, ctx);   // the app's order (decision 3)
```

- **The watcher** (`fs.watch` recursive over roots and `base`) ignores `node_modules` and `.git`. A changed file marks
  dirty every plugin whose facets used it (`inputs`; a copied contract dirties every user) or whose directory contains
  it; a changed `package.json` marks `install`; a plugin directory added or removed sets `set` (discovery runs again
  at the next build); a file under `base` sets `base` (the app restarts its hosts; Chord restarts nothing). A change
  during a build keeps its mark. If the watcher cannot watch (the system's limit), it reports once and the app builds
  on demand. It marks, never applies.
- **`installDependencies(plugin, ctx)`**: `npm install --omit=dev --legacy-peer-deps --ignore-scripts --no-audit
  --no-fund` in the plugin's real directory, the command overridable (decision 3); it clears `install`.
- **`rollout(steps, built, ctx)`**: each step is `{ name, kinds, reload(built, ctx) }` and returns the host's report;
  steps run in order; a step's `reload` evaluates the facets of its kinds where its host runs (an in-process step through
  the component's per-host state, §4; a remote one, slice 10/11, gets the built data). It stops at a step that rejects
  (a host closed, an abort); kept plugins do not stop it. Marks clear for plugins applied on every step; a plugin kept
  on any host stays dirty.

## 6. Not in 7c

Installing plugins from npm or git (p2 §8), project plugins with trust and snapshots (design §26 #14), a base bundle per
surface, evaluating in a browser (slice 11), shipping built scripts to workers and pages (slices 10, 11), static checks
of cross-plugin imports beyond §2's rule.

## 7. Tests, examples, cost

- One test file per source file; fixture plugins under `test/next-node/fixtures/plugins/`. Discovery (names, duplicates,
  missing or invalid `package.json`, two files of a kind, contracts-only plugins, symlinks); build (every row of §2's
  table, failures as results, relative source maps and stable digests across two checkout paths, inputs hashed at
  load); evaluation (host packages as the host's instances: `instanceof ChordError` across a plugin; default and named
  imports of ESM and CommonJS host packages; `pluginFile` and its `..` refusal; an import-time throw; a non-facet
  export); `mapStack` naming plugin files and lines; per plugin at startup and reload (§4: a failing setup, factory,
  declaration, build, evaluation; the closure rule with a provider and consumer changed together; the report's `failed`
  and `failed`; `load` never closing the host); the watcher (dirty marks from inputs and directories, `install`, `set`,
  `base`, a change during a build, `node_modules` ignored); `rollout` (order, stopping at a rejecting step, marks).
- **GC:** 200 reloads of an evaluated plugin facet: old closures collected, heap flat after warm-up.
- **End to end:** a server and a worker (memory links) loading plugin directories, a plugin edited on disk, built and
  rolled out (server, then worker), a holder seeing one frame; a broken edit kept old on both hosts and reported.
- Examples (owner, 2026-10-30: full coverage, each a folder `NN-topic/` with the hosts in `main.ts` and real plugin
  directories under `plugins/`): `35-plugins` (load, edit, build, rollout), `36-plugin-failures` (per plugin at startup
  and reload, the closure rule, an abort after the commit), `37-plugin-imports` (copied contracts, dependencies,
  `chord.external`, host packages, `pluginFile`, the refusals), `38-watch-and-rollout` (the marks, plugins added and
  removed, a stopped rollout), `39-browser-build` (CSS, assets, the built result as plain data). Benchmark (`benchmarks.md`): cold build of a 20-plugin set, a rebuild of one facet,
  evaluation per facet, heap after 100 reloads.
