# plugins

The plugins component (slices 7c and 12, design §21 "Loading plugins and the reload loop" and "The plugin model"):
plugin directories and single-file plugins found, each facet built into a script by esbuild (its imports checked against
the app's versioned API) and evaluated on Node, loaded and reloaded per plugin, watched, rolled out, installed from git
or npm, and tested alone. A Chord app modifies itself (the owner or an agent edits a plugin while it runs), so this is
core machinery, no dev mode. Node-only (`fs`, esbuild, `vm`); the kernel stays portable and takes facets however they
were made. esbuild is an optional peer dependency of `@earendil-works/chord`, imported only here. Exported as
`@earendil-works/chord/plugins`; the plugin runtime alone (no esbuild, no watcher: what a worker evaluates with) as
`@earendil-works/chord/plugins/runtime`.

## For apps (`index.ts`)

```ts
const plugins = createPlugins({
  roots: [{ path: "./plugins", required: true }, join(dataDir, "plugins")], base: ["./src"], onError,
  api: { name: "@acme/app", versions: ["v3", "v2"] },                                   // newest first
  kinds: { server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server", "@acme/app/v2"] },
           worker: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/worker", "@acme/app/v2"] },
           web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web", "@acme/app/v2", "react"] } },
}, ctx);
await plugins.load(server, { kind: "server", core: [{ name: "@acme/core", facet: coreServerFacet }], modules }, ctx);
plugins.state                                         // { dirty, install, set, base }, a JSON watchable
const built = await plugins.build(plugins.state.value.dirty, ctx);
await plugins.rollout([plugins.step("server", server), workers.step("workers")], built, ctx);   // the app's order
```

- **A plugin** is a directory with a `package.json`: its `name` (npm style) is the plugin's name, `dependencies` are
  bundled, `peerDependencies` are host packages, `"chord": { "external": [...] }` keeps named packages external in
  Node builds (loaded from the plugin's `node_modules`, native addons included; they stay in Node's module cache until
  a restart). A package's `"chord": { "plugins": ["./notes", "plugins/*", "!plugins/draft"] }` lists the plugin
  folders it provides (paths, globs and `!` exclusions, as pi's `pi.extensions`; `.` the package itself); without it
  the package is one plugin when its top has facet files, else its subfolders with a `package.json` (decision
  "`chord.plugins` is a package's manifest of plugins"); a listed folder inside another listed one is a problem. One file per facet kind the app names (`server.ts`, `worker.ts`,
  `web.tsx`, `tui.ts`; `.ts`, `.tsx`, `.js` or `.mjs`), its default export a facet; a plugin with no facet file holds
  contracts others import. A **single-file plugin** is a file `<name>.<kind>.<ext>` at a root's top: the files of one
  `<name>` are one plugin (`layout: "file"`, `dir` the root), importing host packages only.
- `discoverPlugins(roots, { kinds }, ctx)`: `roots` are paths or `{ path, required }`. Lists each root, reads only
  `package.json` files, follows symlinks to real paths; each directory at its top is a package (its manifest's
  folders, or by convention; a directory without a `package.json` holding plugin subfolders is a checkout of several),
  their plugins within the root; single-file plugins grouped by name. The first root wins a duplicate name, a
  directory plugin a single-file one of its root. `{ plugins, problems }`: a directory without a valid `package.json`
  or name, an invalid manifest, two files of one kind, an invalid single-file name, a later duplicate, or a required
  root that does not exist is a problem (with its `root` and `required`), not a plugin. Each `Plugin` records its
  `root` and whether that root is `required`.
- `buildFacet(plugin, kind, { hostPackages, platform, api?, kinds?, plugins?, publicPath? }, ctx)`: one esbuild build
  from cold. Inlined: the plugin's own files, files of other directory plugins of its root imported by relative path
  (`../notes/contract.ts`: copies, listed in `copied`; they may import only host packages and files of their own
  plugin: contracts and side-effect-free modules; decision "Contracts come from where the plugin's code came from"),
  packages of its `dependencies` resolved through their `exports` (`@bob/notes` → its `contract.ts`). A relative path
  leaving the root or into a directory that is no plugin, and a package outside its `dependencies`, are build errors
  naming the file; a package file must lie, by its real path, in the plugin's own `node_modules` (a `file:` link out,
  a package's relative import or link leaving it: refused), and a facet file linked elsewhere must be its plugin's and
  of its kind. With `api` (slice 12 §1): an API import at a version the app does not list, a module the kind's
  `hostPackages` lack, two versions in one facet, and Chord itself (`@earendil-works/chord`, but `/next/plugins`) are
  refused. With `kinds`: a plugin file named `<name>.<kind>.<ext>` (compared without case), or a facet file
  `<kind>.<ext>` at a plugin's top, is of that kind, and reaching it from a facet of another kind (directly, through
  other files, copied files, or a package that is plugin code: a `chord` field in its `package.json` or one above
  it; an ordinary library names files as it likes) is refused naming the chain. A plugin's root may lie under a
  `node_modules` (an app installed from npm with its plugins): only the path below a plugin's directory counts. A copied file imports host packages and its own plugin's files only, no builtins. A single-file plugin
  imports host packages only. External: host packages, `@earendil-works/chord/plugins`, `chord.external`
  packages and Node builtins (Node builds; a browser build refuses both). Browser builds collect CSS into one stylesheet (`css`; a `*.module.css` file scoped to its
  plugin and file: its classes renamed `chord_<hash>_<file>_<class>`, its import esbuild's mapping, `composes` and
  escaped names included, `css-modules.ts`; a stylesheet's `url()` is an asset, an `@import`ed file plain CSS) and
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
  work), `@earendil-works/chord/plugins` with `pluginFile` bound to the plugin's directory, `chord.external`
  packages and Node builtins from the plugin's directory; anything else throws naming the facet. A computed
  `require` is refused what the build refuses: another API version than the script's (the first one required pins it
  when the build saw none), Chord under an app's API, anything but host packages in a single-file plugin. No module
  map, no cache: an old facet's closures are collected once nothing holds them.
- `pluginFile(path)` (inside a facet script): the absolute path of a file of its own plugin; `..` out of it refused, and
  every path of a single-file plugin (it has no directory of its own).
- `mapStack(error)`: the error's stack with plugin scripts' positions mapped through their source maps
  (`notes/worker.ts:12:3`), for the app's reporters; nothing global. A script's map is kept while any evaluation of it
  lives (its facet, on any host, or the error its evaluation threw).
- `installDependencies(plugin, ctx, { npmCommand? })`: `npm install --omit=dev --legacy-peer-deps --ignore-scripts
  --no-audit --no-fund` in the plugin's real directory (npm's git dependencies with a ref included). A plugin inside a
  multi-plugin repository is a dependency on the whole repository, imported by path into it
  (`@bob/plugins/notes/contract.ts`) or through its `exports`.
- `installPlugin(source, root, ctx, { npmCommand?, kinds?, roots? })`: `{ git, ref }` shallow-clones the ref (branch,
  tag or commit) into `<root>/<repository>`, `{ npm, version }` extracts the packed package into `<root>/<name>`; the
  package's plugins are its manifest's folders, else by convention; then the dependencies of each new plugin. Returns
  their names. It claims the directory first (`mkdir`, no `recursive`), stages the package in a hidden directory of
  the root, checks it as discovery does and renames it into place; refused: a ref, URL, name or version starting with
  `-` (git and npm get positional arguments after `--`), an invalid npm name, an existing directory (no updating in
  place), a package with a discovery problem or no plugin, a plugin name another of `roots` has. On failure only what
  it created is removed; staging directories older than an hour (a crashed install's) are removed at the next one.
- `testPlugin(dir, { kind, modules, api?, kinds?, platform?, stubs?, principal?, address? }, ctx)` (`testing.ts`): the
  plugin (a directory, or a single-file plugin's file; in a checkout of several, its root is the checkout's parent)
  built as production builds it (`kinds` by default `kind` and every kind its root's file names name, test and
  declaration files aside; `api` required
  when `modules` hold versioned API modules) and evaluated with `modules`, loaded on a new host with a `:memory:` store
  beside `stubs`; every registry with contributions and no provider after the load is served by a collecting facet,
  again until no new one appears (`t.contributions(R)`: its entries). `t.unserved()` lists the names requests wait for unbound that nobody serves,
  `t.root(fn, ctx, { principal })` runs as any principal, `t.errors` holds what the host reported, `t.close(ctx)`.
- `createPluginRuntime()` (`runtime.ts`, slice 10 D11): loads and reloads hosts with shipped scripts, never builds.
  Per host it keeps each plugin's loaded facet; `load(host, { kind, core, scripts, modules }, ctx)` evaluates the
  complete set `scripts` (`PluginScript`: `{ plugin, built }`, plain data) with `modules` (the host packages, this
  process's instances, kept for the host's reloads) and calls `host.load([...core, ...facets])`; a plugin whose build
  or evaluation fails is left out, reported in the report's `failed` beside the host's own; when one of a required
  root is among them, `load` rejects with a `PluginError` (`required`, `failed`) after the host's load settled.
  `reload(host, scripts,
  ctx)`, one after another per host, passes the complete set: core facets and unchanged plugins (same digest) as the
  same objects, new scripts evaluated, loaded plugins not in `scripts` left out; a plugin whose build or evaluation
  failed is passed as its loaded facet (an added one left out) and named to `host.reload`'s `failed` option, so the
  host's closure rule sees it and its report lists it. What the host committed becomes the loaded set, also when the
  reload rejects `aborted` after its commit (`details.committed`). Turns V8's compilation cache off (once per process).
- `createPlugins(options, ctx)`: `kinds` defines each facet kind: its builds' `platform` (`node`, `browser`) and the
  host packages they keep external (by specifier; the modules are given where scripts are evaluated). It starts the
  watcher and uses a plugin runtime.
  - `scripts(kind, ctx)`: the kind's complete current set, every discovered plugin's facet of it built at first use,
    then updated only by what ships the kind (a rollout step of that kind, a direct `reload`): what a worker starts
    with. `build` never changes it.
  - `load(host, { kind, core, modules }, ctx)`: `kind`'s current set loaded with the runtime.
  - `build(names, ctx)`: discovers again when the plugin set or a plugin's `package.json` changed, or when a named
    plugin is unknown to discovery or a file discovery found for it is gone (the watcher's events can lag behind the
    files: a plugin deleted or written just before a build of it is removed or added all the same), builds every facet
    of `names` and of plugins discovered since: `{ facets, plugins, removed }`, plain data (`plugins`: the built
    plugins as discovered, by name; a clone reloads the same).
  - `reload(host, built, ctx)`: applies `built` to the current set of the host's kind (its removed plugins and those
    rebuilt without a facet of the kind leave it, its facets replace theirs; applied and read in one step, so two
    reloads started together each pass their own) and reloads the host with that complete set.
  - `step(name, host)`: an in-process rollout step, one host named `name`. A step's `reload(built, ctx)` returns
    `{ hosts: [{ host, report } | { host, stopped: true } | { host, error }] }` (D12). `rollout(steps, built, ctx)`
    applies `built` to the current set of each step's kinds right before that step, runs the steps in order and stops
    at one that rejects (`stopped`); failed plugins and hosts do not stop it. It clears the dirty marks of the built
    plugins applied on every host of every step and unchanged since the build: a plugin failed on any host, or of a
    step's kinds on a host listed with an error, or with a built kind no step shipped, stays dirty. Given a copy of a
    build (not the object `build` returned), it clears no marks.
  - `installDependencies(name, ctx)` (the install mark clears, the plugin turns dirty), `installPlugin(source, root,
    ctx)` (`root` one of the roots; marks `set`), `close()` (the watcher stops).
- **The watcher** (`fs.watch` on every directory of the roots, the base code and plugin directories linked from
  outside the roots, never on `node_modules` or `.git`; a directory appearing later under a watched one gets its watch,
  a root missing at `createPlugins` is not watched: the app builds on demand) marks, never applies: a changed file
  dirties every plugin whose facets read it (a copied contract every user) and the plugin whose directory holds it (a
  discovery whose record of a plugin moved, a single file become a directory or a facet file added, dirties it and the
  next build rebuilds it; a plugin no longer discovered loses its builds and the files they read); a
  `package.json` sets `install` (and the next build reads the plugin's metadata again; a plugin the next discovery no
  longer has loses its install mark); a directory under a root, a facet file at a plugin's top, or a file at a root's
  top (a single-file plugin's appearing or disappearing) sets `set`; a single-file plugin's file dirties that plugin;
  `base` (the app restarts its hosts) is computed, not latched: true exactly while a file differs from what a running
  base artifact read (`base`, the server's own files and directories, hashed when the component is created; each
  `watchBase(inputs)`, a base bundle's record of the bytes it read), is gone, or is a source file new in a base
  directory; compared once when its watch starts (an edit since the build has no later event) and at each event, the
  reads of one path in order (the latest decides); a file two records read with different bytes stays marked, as does
one whose record holds a hash no bytes have (the kit's latched post-start-edit rule, `src/node/app/README.md`). Every
  ancestor of a base directory or of a recorded file's directory is watched alone too: an entry on that way created,
  removed, moved or replaced (an ancestor renamed, a directory made again) renews every base watch under it and
  compares its files. Each plugin mark records the generation of its latest
  change (generations only increase): a change during a build keeps the mark, however late an older rollout ends. A watcher
  that cannot watch reports `watch_failed` once; the app builds on demand.

## Examples

Each a folder in `test/examples/` with its hosts in `main.ts` and real plugin directories in `plugins/`:
`35-plugins` (load, edit, mark, build, roll out), `36-plugin-failures` (per plugin failures at startup and reload, the
closure rule, an abort after the commit), `37-plugin-imports` (what a facet may import, installs, the refusals),
`38-watch-and-rollout` (every mark, added, removed and dropped facets, stopped rollouts) and `39-browser-build` (a
browser build: stylesheet, assets by URL, plain data); with workers, `43-rollout` (a rollout over the server and its
running workers); the plugin model (slice 12): `49-plugin-api` (an app API with two versions and per-kind modules,
the refusals; its `app/` is the API examples 50-52 build against), `50-plugin-imports` (relative within a root, a git
dependency pinned to a commit, per-kind contract files, a required root), `51-single-file-plugin` and
`52-test-plugin`. Authoring plugins: `docs/plugin-authoring.md`.

## Inside the directory

`discover.ts` (discovery: directories, checkouts, single files), `build.ts` (one build, its import rules: the API,
per-kind files, roots, and input capture), `evaluate.ts` (evaluation, the `require` a script gets, `pluginFile`),
`stack.ts` (the source maps of evaluated scripts while their facets live, `mapStack`), `install.ts` (dependencies,
git folder packages, plugins from git and npm), `watcher.ts` (the watcher and its marks, a JSON watchable),
`base-inputs.ts` (what a base build read: each file's bytes hashed as esbuild's loader gets them),
`css-modules.ts` (CSS modules scoped per plugin and file), `runtime.ts` (evaluated scripts as complete sets for the
portable `LoadedFacets` of `src/surfaces`, required roots, no esbuild), `plugins.ts` (the
component: kinds, current sets, `build`, `load`, `reload`, `step`, `rollout`, installs), `testing.ts` (`testPlugin`).
