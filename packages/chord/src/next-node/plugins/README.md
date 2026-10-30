# plugins

The plugins component (slice 7c, design §21 "Loading plugins and the reload loop"): plugin directories found, each
facet built into a script by esbuild and evaluated on Node, loaded and reloaded per plugin, watched and rolled out. A
Chord app modifies itself (the owner or an agent edits a plugin while it runs), so this is core machinery, no dev mode.
Node-only (`fs`, esbuild, `vm`); the kernel in `src/next` stays portable and takes facets however they were made.
esbuild is an optional peer dependency of `@earendil-works/chord`, imported only here. Exported as
`@earendil-works/chord/next/plugins` once v2 has its entry point.

## For apps (`index.ts`)

```ts
const plugins = createPlugins({ roots: ["./plugins", join(dataDir, "plugins")], kinds: ["server", "worker", "web", "tui"],
  browserKinds: ["web"], hostPackages: HOST, base: ["./src"], onError }, ctx);
await plugins.load(server, { kind: "server", core: [{ name: "@app/core", facet: coreServerFacet }] }, ctx);
plugins.state                                         // { dirty, install, set, base }, a JSON watchable
const built = await plugins.build(plugins.state.value.dirty, ctx);
await plugins.rollout([plugins.step("server", server), ...workerSteps], built, ctx);   // the app's order
```

- **A plugin** is a directory with a `package.json`: its `name` (npm style) is the plugin's name, `dependencies` are
  bundled, `peerDependencies` are host packages, `"chord": { "external": [...] }` keeps named packages external in
  Node builds (loaded from the plugin's `node_modules`, native addons included; they stay in Node's module cache until
  a restart). One file per facet kind the app names (`server.ts`, `worker.ts`, `web.tsx`, `tui.ts`; `.ts`, `.tsx`,
  `.js` or `.mjs`), its default export a facet; a plugin with no facet file holds contracts others import.
- `discoverPlugins(roots, { kinds }, ctx)`: lists each root one level deep, reads only `package.json`, follows
  symlinks to real paths; the first root wins a duplicate name. `{ plugins, problems }`: a directory without a valid
  `package.json` or name, with two files of one kind, or a later duplicate is a problem, not a plugin.
- `buildFacet(plugin, kind, { hostPackages, platform, plugins?, publicPath? }, ctx)`: one esbuild build from cold.
  Inlined: the plugin's own files, files of other discovered plugins (copies, listed in `copied`; they may import only
  host packages and files of their own plugin: contracts and side-effect-free modules), packages of its
  `dependencies`. External: host packages, `@earendil-works/chord/next/plugins`, `chord.external` packages and Node
  builtins (Node builds; a browser build refuses both). Browser builds collect CSS into one stylesheet (`css`) and
  assets (`import url from "./icon.svg?url"`, `.wasm`) into content-hashed files (`assets`) under `publicPath`.
  Refused, with the file and line: `import.meta`, `__dirname`, `__filename` (each use, found through the script's
  source map), a literal dynamic `import("x")` and top-level `await` (pointing to `pluginFile`; a computed `import(x)`
  cannot be seen at build: it runs through the facet's `require`, which names the facet when it does not answer), a
  relative path out of the plugin (base code is a host package), a package outside its `dependencies`. The result is plain data: `{ kind: "script", source, digest, inputs, copied, css?, assets }` (a
  wrapped CommonJS script, minified, with an inline source map of positions only, relative to the plugin, so the
  digest is the same on every checkout; `inputs` hashed as esbuild read them) or `{ kind: "failed", errors }`, never a throw.
- `evaluateFacet(built, { hostPackages, plugin })`: `vm.Script` in this context under a stable filename per (plugin,
  kind, digest), the default export checked to be a facet. Its `require` answers the host packages (a CommonJS
  package's exports as they are, an ESM namespace wrapped once with `__esModule` so default and named imports both
  work), `@earendil-works/chord/next/plugins` with `pluginFile` bound to the plugin's directory, `chord.external`
  packages and Node builtins from the plugin's directory; anything else throws naming the facet. No module map, no
  cache: an old facet's closures are collected once nothing holds them.
- `pluginFile(path)` (inside a facet script): the absolute path of a file of its own plugin; `..` out of it refused.
- `mapStack(error)`: the error's stack with plugin scripts' positions mapped through their source maps
  (`notes/worker.ts:12:3`), for the app's reporters; nothing global. A script's map is kept while any evaluation of it
  lives (its facet, on any host, or the error its evaluation threw).
- `installDependencies(plugin, ctx, { npmCommand? })`: `npm install --omit=dev --legacy-peer-deps --ignore-scripts
  --no-audit --no-fund` in the plugin's real directory.
- `createPlugins(options, ctx)`: turns V8's compilation cache off (once per process) and starts the watcher.
  - `load(host, { kind, core }, ctx)`: discovers (once), builds and evaluates the `kind` facet of every plugin and
    calls `host.load([...core, ...facets])`; a plugin whose build or evaluation fails is left out, reported in the
    report's `failed` beside the host's own.
  - `build(names, ctx)`: discovers again when the plugin set or a plugin's `package.json` changed, builds every facet
    of `names` and of plugins discovered since: `{ facets, plugins, removed }`, plain data (`plugins`: the built
    plugins as discovered, by name; a clone reloads the same).
  - `reload(host, built, ctx)`, one after another per host: the complete set for the host's kind (the plugins it
    loaded and those `built` brings): core facets and unchanged plugins (same digest) as the same objects, new scripts
    evaluated, the plugins `built` removed or rebuilt without a facet of the host's kind left out (its own
    discovery's, never a later one's); a plugin whose build or evaluation failed is
    passed as its loaded facet (an added one left out) and named to `host.reload`'s `failed` option, so the host's
    closure rule sees it and its report lists it. What the host committed becomes the loaded set, also when the
    reload rejects `aborted` after its commit (`details.committed`).
  - `step(name, host)`: an in-process rollout step; `rollout(steps, built, ctx)` runs steps in order and stops at one
    that rejects (`stopped`); failed plugins do not stop it. It clears the dirty marks of the built plugins applied on
    every step and unchanged since the build; a plugin failed on any step stays dirty. Given a copy of a build (not the
    object `build` returned), it clears no marks.
  - `installDependencies(name, ctx)` (the install mark clears, the plugin turns dirty), `close()` (the watcher stops).
- **The watcher** (`fs.watch` on every directory of the roots, the base code and plugin directories linked from
  outside the roots, never on `node_modules` or `.git`; a directory appearing later under a watched one gets its watch,
  a root missing at `createPlugins` is not watched: the app builds on demand) marks, never applies: a changed file
  dirties every plugin whose facets read it (a copied contract every user) and the plugin whose directory holds it; a
  `package.json` sets `install` (and the next build reads the plugin's metadata again; a plugin the next discovery no
  longer has loses its install mark); a directory under a root or a facet file at a plugin's top sets `set`; a file of
  base code sets `base` (the app restarts its hosts). Each mark records the generation of its latest change
  (generations only increase): a change during a build keeps the mark, however late an older rollout ends. A watcher
  that cannot watch reports `watch_failed` once; the app builds on demand.

## Examples

Each a folder in `test/next/examples/` with its hosts in `main.ts` and real plugin directories in `plugins/`:
`35-plugins` (load, edit, mark, build, roll out), `36-plugin-failures` (per plugin failures at startup and reload, the
closure rule, an abort after the commit), `37-plugin-imports` (what a facet may import, installs, the refusals),
`38-watch-and-rollout` (every mark, added, removed and dropped facets, stopped rollouts) and `39-browser-build` (a
browser build: stylesheet, assets by URL, plain data).

## Inside the directory

`discover.ts` (discovery), `build.ts` (one build, its import rules and input capture), `evaluate.ts` (evaluation, the
`require` a script gets, `pluginFile`), `stack.ts` (the source maps of evaluated scripts while their facets live,
`mapStack`), `install.ts`, `watcher.ts` (the watcher and its marks, a JSON watchable), `plugins.ts` (the component:
per-host loaded facets, `build`, `load`, `reload`, `step`, `rollout`).
