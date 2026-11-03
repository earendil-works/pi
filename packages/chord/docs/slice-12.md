# Slice 12: the plugin model (spec)

Status: **approved** (owner, 2026-11-01: the plugin model's decisions, then "go ahead, just do all the things"; this
spec written by the redesign session from them, no separate spec review). Builds on 7c's plugins component
(`src/node/plugins/`) and slice 10's kinds and `createPluginRuntime`.

Read in full before writing code: this spec; `decisions.md` entries of 2026-11-01 "Contracts come from where the
plugin's code came from", "Plugins import only the app's versioned API", "The plugin model, points 3, 4, 5 and 8,
imports and builds", "Single-file plugins", "Testing a plugin alone"; `design.md` §21 (all of it, "The plugin model"
included) and §16-§17; `slices.md` (carry-over "Slice 12"); `slice-7c.md`, `slice-10.md` §3 "Plugins in workers";
`src/node/plugins/README.md` and its sources; the primer `docs/plugin-primer/book.md`.

## 1. The app's API (`createPlugins` option `api`)

```ts
const plugins = createPlugins({
	roots: [{ path: "./plugins", required: true }, { path: join(dataDir, "plugins") }],
	api: { name: "@acme/app", versions: ["v3", "v2"] },          // newest first
	kinds: {
		server: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/server", "@acme/app/v2"] },
		worker: { platform: "node", hostPackages: ["@acme/app/v3", "@acme/app/v3/worker", "@acme/app/v2"] },
		web: { platform: "browser", hostPackages: ["@acme/app/v3", "@acme/app/v3/web", "@acme/app/v2", "react", "react/jsx-runtime"] },
	},
	onError,
}, ctx);
```

- `api` names the app's API package and the versions it provides. A plugin import of `<name>/<version>[/<kind>]`:
  a version not listed is a build error naming the listed ones ("@acme/app/v1 is not available: this app provides v3,
  v2"); a listed one that the kind's `hostPackages` lacks (`@acme/app/v3/web` from a worker facet) is a build error
  naming the kind. One facet's imports of the API all use one version (a mix is a build error naming both).
- Chord itself (`@earendil-works/chord` and its subpaths other than `/plugins`, which stays as in 7c for
  `pluginFile`) is not importable by plugins: a build error pointing to the app's API. Apps that do not set `api` keep
  7c's behaviour (host packages as listed), so Chord's own tests and examples keep importing Chord directly where they
  model base code.
- `roots` entries may be strings (as today) or `{ path, required? }`. A plugin of a required root whose build,
  evaluation or setup fails at `plugins.load` makes `load` reject (`PluginError` naming it), after the host's own load
  settled; failures in other roots are reported as today. At a reload, a required plugin failing keeps its old code as
  any plugin (reported).

## 2. Imports between plugins (replaces slice 10's by-name lookup)

- **Relative paths within a root:** an import from one plugin into another plugin's directory under the same root
  (`../notes/contract.ts`) is inlined (listed in `copied`), the copied file under 7c's rule (only host packages and
  files of its own plugin). A relative path leaving the root (base code, another root) is a build error naming the file
  and pointing to the API or a dependency. A git checkout of several plugins cloned into a root is "within a root".
- **Package names across repositories:** an import of a package in the plugin's `dependencies` resolves as npm does
  through that package's `exports` (`@bob/notes` → its `contract.ts`, `@bob/notes/web` → `contract.web.tsx`), inlined
  at the installed version. A dependency may be an npm version or a git URL with a ref (`github:bob/notes#<commit>`,
  `git+https://...#<tag>`); `installDependencies` installs it with npm as today. A plugin inside a multi-plugin
  repository is reached through a dependency on the whole repository, by path into it (`@bob/plugins/notes/contract.ts`)
  or its `exports` (decision "`chord.plugins` is a package's manifest of plugins").
- **`chord.plugins`** in a package's `package.json` lists the plugin folders it provides (globs, exclusions); used by
  discovery of a root's packages and by `installPlugin`; without it, conventional discovery.
- The by-name lookup (`build.ts` `#byName`), its error texts and the six `tsconfig.json` path aliases go; fixtures and
  examples 35-38 import relatively again.

## 3. Per-kind files and the import check

- A file whose name has a kind segment before its extension (`contract.web.tsx`, `ui.tui.ts`, any `*.<kind>.<ext>` with
  `<kind>` one of `kinds`) is a file of that kind: importing it (directly or through other files) from a facet of
  another kind is a build error naming the chain. Facet files keep their names (`web.tsx`); contract files are
  `contract.ts` (shared) and `contract.<kind>.ts(x)`.
- The check runs in the existing esbuild `onResolve` path, on the resolved file, for relative imports, dependencies and
  copied files alike.
- Documented, not checked: a contract file mentions native things only through `import type` (TypeScript erases it;
  a runtime import of a package the kind lacks already fails as above).

## 4. Single-file plugins

- Discovery also lists files at a root's top named `<name>.<kind>.(ts|tsx|js|mjs)`; files of one `<name>` form one
  plugin named `<name>` (an unscoped valid npm name, else reported), one facet per file, `dir` the root, no
  `package.json` (no dependencies, no `chord.external`). A directory plugin of the same name in the same root is a
  reported duplicate (the directory wins).
- Its build allows imports of host packages only (the app's API); anything else is a build error saying to make it a
  directory. `pluginFile` refuses (it has no directory of its own).
- The watcher: such a file appearing or disappearing at a root's top sets `set`; a change marks the plugin dirty.

## 5. Installing plugins

`installPlugin(source, root, ctx)`: `source` is `{ git: url, ref }` (a shallow clone of the ref into
`<root>/<repository name>`; a repository whose top has a `package.json` is one plugin, otherwise its subdirectories
are plugins) or `{ npm: name, version }` (`npm pack` and extract into `<root>/<name>`), then `installDependencies` for
each new plugin; marks `set`. Returns the installed plugin names. Removal is deleting the directory (`set`). No
updating in place: install another ref (a new directory) or delete and install.

## 6. `testPlugin`

```ts
const t = await testPlugin("./plugins/stats", {
	kind: "worker",
	api: { name: "@acme/app", versions: ["v3"] },
	modules: { "@acme/app/v3": apiV3, "@acme/app/v3/worker": apiV3Worker },   // the real API modules
	stubs: [{ name: "@acme/notes", facet: notesStub }],                        // facets serving what it uses
	principal: { kind: "user", id: "u1" },                                      // the host's principal (optional)
}, ctx);
const stats = await t.host.get(Stats, { project: "p1" }, ctx);
t.contributions(Panels);   // what the plugin contributed to a registry nobody serves (the helper serves it)
t.unserved();              // contract names requests wait for unbound `not_served`
await t.close(ctx);
```

- Built with the same build as production (`buildFacet` with the kind's options), evaluated with `modules`, loaded on a
  host with `address`/`principal` as given, an in-memory store (`:memory:` SQLite); stubs loaded beside it.
- The helper serves, as a collecting registry, every registry the plugin contributes to that no stub or the plugin
  itself serves (`t.contributions(R)`: the current entries).
- `t.unserved()` lists the names of contracts whose requests wait unbound `not_served` on the host (the unbound
  index), so a test knows what to stub. `t.root(fn, ctx, { principal })` runs as another principal.
- Exported from `chord/plugins` (`testing.ts`); no test-only modes elsewhere.

## 7. Docs for authors and agents

- `docs/plugin-authoring.md`: a plugin's layout (directory and single-file), its facet and contract files per
  kind, what it may import and how each import resolves, versions, how the server builds it (esbuild, what the build
  handles, no build hooks), installing from git or npm, testing with `testPlugin`; written for agents (short, exact,
  with one complete example plugin).
- Update `src/node/plugins/README.md`, the guide `docs/guide-plugins-hosts/book.md` (chapters "Plugins Using
  Plugins" and "Base Code and Plugins"; rebuild `index.html`), design §21's slice-10 note.

## 8. Tests, examples

- One test file per source file; build tests for every refusal and allowance of §1-§4 (an unlisted version, a kind
  module from another kind, mixed versions, a Chord import, a relative path leaving the root, a per-kind file through
  a chain, a package from `dependencies` through `exports`, a git dependency with a ref (a local bare repository in a
  temp directory, no network), a subfolder dependency); discovery of single-file plugins; required roots at load;
  `installPlugin` from a local git repository and a local npm tarball; `testPlugin` (stubs, collected contributions,
  `unserved`, a principal).
- Examples: `49-plugin-api` (an app API with two versions and per-kind modules, a plugin per version, the refusals),
  `50-plugin-imports` (relative within a root, a git dependency pinned to a commit, per-kind contract files),
  `51-single-file-plugin`, `52-test-plugin` (a plugin tested with a stub). Examples 35-38 updated.
- No hot path changes; no benchmark beyond a cold build of the 20-plugin set (as 7c's) to show the checks cost nothing
  measurable.
