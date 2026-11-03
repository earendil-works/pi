# Plugin loading

Status: **design, not implemented** (revision 4), except for the built-in parts of 4.1 and 4.2 (listing, runtime
resolution), which are. Revision 4 aligns the document with `target-design.md`: a plugin reload swaps code on each host
without waiting for running work (documents migrate, resources are replaced in place, section 15 there), and the
cluster is a rollout of revisions, not a transaction. Loader model D (section 14) stays: one base bundle plus one script
per facet, evaluated without a module map, so old generations are reclaimed by the GC. p2 is experimental; nothing here
is a stable public API.

**Chord v2 only.** This document predates p2's move to Chord v2; Chord v1 has since been deleted. Where it says
"today" about `nodeLoader` and per-surface loading, it describes p2 on Chord v1. p2 now builds and loads its server
and worker facets with Chord's plugins component (`createPlugins`, `src/hosts/plugins.ts`; Chord's
`docs/plugin-authoring.md`), plugins import p2's API (`@p2/app/v1` and its per-kind modules) instead of Chord
directly, and the web and TUI bundles load their facets with `host.load`. Global, package and project plugins
(sections 3 to 13) remain a design.

Today p2 loads one plugin root, `apps/p2/plugins/`, differently per surface: server and worker facets through
Chord's `nodeLoader` (dynamic `import()`, a new module copy per reload that is never evicted), TUI facets through a
server-built esbuild bundle, web facets from a hard-coded list in `src/hosts/web/main.tsx` served by Vite. An
uncommitted prototype (`src/hosts/worker-bundle.ts`) measures worker bundle variants (14.1). This document designs
one mechanism for built-in plugins, the owner's own plugins, plugins installed from npm or git, and plugins that come
with a session's working directory, on every surface.

## 1. Goals and non-goals

Goals:

- **One pipeline** for built-in, global, package and project plugins; built-ins are not special.
- **Every surface from the same plugin set:** server, session worker, web, TUI.
- **Global packages from npm and git**, like pi's packages (`packages/coding-agent/docs/packages.md`).
- **Project plugins** from a session's working directory, local or remote, without leaking into other sessions.
- **Nothing from a project runs before the owner approves it, and only the approved bytes run.**
- **No leaks across scope changes:** a web page, TUI worker or session worker that loaded a plugin set is thrown
  away as a whole, never partially unloaded.
- **In-place reload everywhere, without leaks:** a changed facet reloads through Chord (documents and resources stay,
  running calls finish with their old code) and its old generation is reclaimed by the GC once nothing references it
  (14). A full reload (host restart, page load, TUI worker swap) remains for base changes, scope switches and stuck
  generations.
- **Publishable later:** p2 as an npm package loads external plugins the same way.

Non-goals (v1):

- Isolation between plugins in one process, or of web code from the page (that needs iframes; 11).
- Project packages (npm dependencies of project plugins); project plugins import only host packages and plugins.
- Project web or TUI facets for guests (base scope only; opt-in per share later).
- Native addons in packages.

## 2. Terms

- **Plugin:** a directory with facets (`server`, `worker`, `web`, `tui` modules) and the modules they import, and/or
  resource directories (`skills/`, `prompts/`, `themes/`). Its name is the directory name, `[a-z0-9-]+`.
- **Facet:** the part of a plugin that runs on one surface.
- **Root:** a directory whose subdirectories are plugins.
- **Package:** an npm or git source, or a local directory, providing one or more plugins.
- **Scope:** the plugin set one surface instance loads. **Base scope:** built-in, global and global-package plugins.
  **Project scope:** the base scope plus the approved project plugins of one directory.
- **Scope key:** `(env id, canonical session cwd)`. **Revision:** the digest of an immutable project snapshot (6.2).
- **Host packages:** packages the running p2 supplies to every plugin as single instances: p2's API
  (`@p2/app/v1`, re-exporting the part of Chord v2 plugins use, with per-kind modules), `@earendil-works/pi-ai`, `pi-codemode`, `pi-durable`, `pi-env`, `pi-tui`, `pi-schema` (all `@earendil-works/`),
  `react`, `react-dom` (with subpaths such as `react/jsx-runtime`, `react-dom/client`), and p2 itself
  (`@earendil-works/p2/runtime/*`, `@earendil-works/p2/plugins/*`).
- **Data directory:** `P2_DATA_DIR` (default `~/.pi/p2`), written `<data>` below.

## 3. Sources

| Source | Where | Declared by | Facets | Gate |
| --- | --- | --- | --- | --- |
| Built-in | the app's `plugins/` | the app | all | none |
| Global | `<data>/plugins/<name>/` | files present | all | the owner put them there |
| Global package | `<data>/packages/…` (8) | `packages` in `<data>/settings.json` | all | the owner installed it |
| Project | `<cwd>/.pi/p2/plugins/<name>/` | files present | worker, web, tui | project trust (6) |

- **Server facets never come from a project.** The server serves every session. A project plugin with a `server`
  module is refused as a whole (owner notice); loading its other facets would leave it half-working.
- **Disabling:** `plugins.disabled` in `<data>/settings.json` lists names not to load, built-ins included. A plugin
  that holds a disabled plugin's contracts fails at activation with a notice naming it and the type (4.2).
  `<cwd>/.pi/p2/settings.json` (part of the project snapshot) may only disable **project** plugins; any other key is
  ignored with a notice.
- **Project skills and prompts:** `<cwd>/.pi/skills` and `<cwd>/.pi/prompts`, which p2 loads today without asking
  (`plugins/prompt/context-files.ts`), move under the same directory trust decision (pi parity). **Behavior
  change:** they no longer load in untrusted directories. `AGENTS.md` files stay ungated, as in pi.

## 4. Discovery, dependencies, names

### 4.1 Discovery: a directory listing (implemented for built-ins)

Discovery lists directories; it never parses, imports or runs plugin code (owner decision: p2 does not parse plugin
source at all).

- A plugin is a directory under a root with facet files: `server`, `worker`, `web`, `tui` with `.ts`/`.tsx` (and,
  for packages, `.js`/`.mjs`). `readdir` plus an existence check per facet kind is all the loader knows
  (`listPlugins`, `src/hosts/plugins.ts`). Its name is the directory name; a facet module's plugin is the directory
  it lives in (`pluginOfModule`).
- **Selection** is exactly the named plugins (default: all), loaded in stable alphabetical order. Nothing is added
  for imports: a fixture or `plugins.disabled` that leaves out a provider makes its consumers fail loudly at
  activation (4.2).
- **The server selects; workers scan nothing.** The server passes the selected plugins (name and worker facet
  module) in each worker's init. The TUI bundle ships the TUI facet of every selected plugin.
- **Type ownership is recorded at runtime,** per host, from the `serve` calls of the facets that host actually
  loaded (`PluginRuntime`). No process imports another kind's facets: a worker never imports server facets just
  to learn names. Diagnostics name the consumer plugin and the missing type (`plugin login needs p2.model-config;
  no loaded plugin serves p2.model-config on server`), not an unloaded provider, which nobody parsed.
- **Dev mode:** a save belongs to the plugin whose directory contains it. It marks that plugin dirty when it is a
  backend facet file, a plugin set change (directory or backend facet added/removed), or a file some live server,
  worker or TUI bundle actually loaded (the facet bundles' esbuild metafiles under D, 14.2); other saves (web-only
  code) stay on Vite HMR until the web moves to D. Files outside plugin directories are runtime code, tracked by the
  content of the modules each process loaded ("Server code changed").
- **Dev loop:** a change to runtime code (the base bundle: Chord, Durable, other packages, `apps/p2/src/**`) restarts
  the affected hosts (server, workers, page reload, TUI worker swap); a plugin change reloads that plugin in place on
  every host that runs one of its facets (`npm run reload -- <plugin>`, rollout in 7.5).

### 4.2 Dependencies: runtime resolution

A plugin refers to another plugin's modules in one of two ways:

- **Relative imports** within its own root (`../chat/contract.ts`), as built-ins do.
- **`p2:plugins/<name>/<path>`** across roots: a virtual specifier resolved **per scope** to wherever plugin `<name>`
  lives in that scope (built-in, global, package or snapshot), by the facet bundler's resolver (14.2).
  `@earendil-works/p2/plugins/<name>/…` stays the name for built-in contracts (it resolves to the host's files).

Under D each facet is its own bundle, so another plugin's file is **copied into the importing facet** (14.4, B2).
Cross-plugin imports are therefore limited to contracts and side-effect-free modules (`contract.ts`, `protocol.ts`, an
allowlist), and never used for identity (`instanceof`, module state, React contexts); a check enforces it (14.5).

Imports are not dependencies. What a plugin needs is resolved by Chord at runtime, by contract name:

- **Load order does not matter.** `host.load` installs every facet of a load before it activates any eager object
  (Chord guide, "Startup readiness"), so an eager consumer may hold a type a later facet serves. Workers load with
  `{ awaitEager: false }` and then await `host.ready()` once the server admitted their link (Chord request #11).
  (Today facet modules of one load share one copy of each other's files because Chord's `nodeLoader` registers every
  facet directory before importing; D drops that, see above.)
- **A missing provider fails at activation,** with Chord's `unavailable/unknown_type`, which p2 extends by the
  consumer plugin's name before the hold activates (local types) or when the remote error comes back.
- **Removal safety is a runtime check.** A reload that removes a plugin first asks the server and every running
  worker which plugins outside the batch still hold one of the removed plugin's types (live factory holds,
  recorded per host). Any holder refuses the reload before any host prepares, naming them (`Cannot remove p2
  plugin dev-added: plugin dev-dependent still holds test.dev-added (server)`). While the reload prepares, a new
  hold on those types, including the new code of a plugin reloaded in the same batch, refuses it as well.

Project plugins may depend on base plugins and on project plugins of the same snapshot; base plugins never depend on
project plugins. Anything a project plugin imports must be its own file, a scope plugin or a host package; any other
specifier is a load error for that plugin.

### 4.3 Names

Chord binds services and registries **by name**: two contracts named `todo.store` in one host throw `already served`;
two Durable extensions defining one task name throw at registry construction (`durable/src/harness/registry.ts`),
and extensions are looked up by name.
Built-ins use `p2.` names. Rules for external plugins, checked at load (a violation refuses that plugin with a
notice):

| Name | Required form |
| --- | --- |
| Chord contracts, registries | `<plugin>.<name>` |
| Durable extensions, task kinds | `<plugin>.<name>` |
| Agent tools | `<plugin>_<name>` (provider APIs allow only `[a-zA-Z0-9_-]{1,64}`; see A.1) |
| Transcript entry kinds | `<plugin>.<name>` |

- **Name clashes are detected at load,** not by reading source: two facets serving one contract name make Chord's
  `serve` throw `already served` while the host installs them, and two Durable extensions or task kinds with one name
  throw at registry construction. The loader reports the refusing plugin by name.
- **Plugin name clashes** within a scope refuse the later source (order: built-in, global, package, project); project
  plugins may not reuse base names. Package clashes surface at install; directory clashes at listing; a global install
  that shadows an existing project plugin notifies in both places. To replace a built-in, disable it and use another
  name.
- **Each plugin loads on its own:** the loader installs plugins one by one (per-plugin wrapper, as
  `PluginRuntime.guard` today); an import error, `setup` throw or name violation becomes a notice naming the plugin.
  Plugins that hold its contracts fail at activation with the missing-provider diagnostic (4.2). A broken plugin
  never kills a worker or blanks a page.

### 4.4 Resources

Like a pi package, a plugin may carry `skills/<name>/SKILL.md`, `prompts/*.md` and `themes/*.json` (or list them under
`"p2": { "skills": […], "prompts": […], "themes": […] }` in `package.json`). They follow the facet scope rules:
base resources in every scope, project plugin resources only in their approved scope. Clashes follow existing
precedence (global before project) and are reported. A resource-only plugin needs no code.

- Project plugin resources are read from the snapshot; a skill's referenced files are in the project directory in the
  session's environment, as today.
- Skills of base plugins on remote sessions refer to host files: see 13.2, open question 1.
- Themes reach the TUI picker as data through the scope's TUI bundle.

## 5. Scopes

### 5.1 Per surface

| Surface | Loads | How a change applies |
| --- | --- | --- |
| Server | base scope (server facets) | in place, first host of the rollout (7.5) |
| Session worker | its session's scope (worker facets) | in place; base changes in the rollout, project changes for that worker only (7.4) |
| Web page | the scope of the session it shows; base without a session; base for guests | changed facets in place (D, 14.2); full page load for base code, a scope switch or a stuck generation |
| TUI worker | the same, chosen by the launcher; base for guests | changed facets in place (D); worker swap for base code, a scope switch or a stuck generation |

A page or TUI worker holds **exactly one scope**: moving between sessions of different scopes is a full page load or
a worker swap. (During a TUI swap the candidate worker is prepared while the old one still runs; they are never both
active.) Between sessions of one scope, navigation stays in-app. A base rollout changes only base facets in a worker;
project facets are installed only by their own per-worker install (7.4). If a base reload removes something a project
plugin depends on, that plugin's consumers fail like any consumer and the scope is marked dirty.

### 5.2 Scope identity and selection

- The session catalog stores each session's **scope key** and **revision** (approved snapshot digest, or none). The
  server can therefore pick a bundle for a session whose worker is not running.
- **Web:** the server renders `index.html` with a fixed, nonce'd bootstrap script. It takes the session from the URL
  (`/s/<id>`) or the tab's sessionStorage route stack, asks `/__p2_web/scope?session=<id>` (authorized per principal:
  owners any session, guests their own and always get the base scope), and loads the returned JS and CSS. Selection is
  per tab, never a cookie.
- **Session lists carry the scope revision**, so in-app navigation to a session of another scope becomes
  `location.assign` (web) or a swap request to the launcher (TUI) instead of an in-app route.
- **TUI:** the manifest takes `?session=<id>` (`/__p2_tui?session=…`, same authorization). The launcher owns the
  scope: it fetches the manifest for its current target session and swaps when the hash differs. It caches bundles by
  hash (bounded), so switching back is not another download of up to 8 MiB.
- **TUI snapshots** carry drafts, pending send IDs and anchors for every visited identity (`src/tui/snapshot.ts`).
  The launcher keeps them **partitioned per scope key**: a swap A→B stores A's snapshot, hands B only the snapshot
  last saved for B (if any) with the destination session set explicitly, and never replays A's pending sends into B.
  A same-scope revision swap passes the snapshot through, as today.
- **Offline environment:** the worker loads the catalog revision from the local snapshot if present; if not, it loads
  the base scope and shows "Project plugins of <dir> unavailable: environment offline". It never substitutes a local
  directory and never treats unreadable files as "no plugins".
- **Subagents** with their own cwd use the session's scope; their directory neither confers trust nor loads plugins.

### 5.3 Push: `ClientBundle`

Today nothing tells a page or TUI that its bundle is stale: `/version` is a boot ID plus file mtimes, checked only on
`visibilitychange` (`src/hosts/web/main.tsx`); the TUI polls one global manifest. New: a Chord object
`ClientBundle({ session? })` (readable by owners, and by guests for their session) publishes
`{ scopeKey, revision, web, tui }` hashes. A page or TUI holds it for the session it shows; on a hash mismatch the web
reloads (route stack in sessionStorage, drafts in the server's `DraftStore`) and the TUI swaps. Applies to rebuilds,
trust changes, relocations and Reloads started on another device.

### 5.4 Where project facets may contribute

Chrome (sidebar, top bar, global sheets, owner notices, footer slots outside the session) is shared by all scopes.
Project web and TUI facets contribute only to session-bound slots: entry and tool renderers, markdown transformers,
the session's composer, sheets and panels, session-bound TUI commands. Registries record the contributing plugin
(new, through the per-plugin wrapper) and refuse project contributions to chrome slots. This is **UX consistency,
not isolation**: project web code can do anything same-origin code can (11).

## 6. Project trust and snapshots

### 6.1 Trust decisions

- `<data>/trust.json` (p2's own, separate from pi's `~/.pi/agent/trust.json`) stores decisions per canonical
  directory `(env, path)`; the closest saved decision of the directory or a parent applies, as in pi.
- `defaultProjectTrust`: `"ask"` (default) or `"never"`. There is no `"always"` (A.2).
- Modes per trusted directory:
  - **Directory (default):** the owner's Reload (6.3) is the approval of each new revision.
  - **Pin to content:** each new revision needs the full trust review again (file list and diffs against the
    approved revision); a generic "Reload all" never includes it.
- Approved revisions are stored per scope key; every session with that key uses the latest approved one.
- **Guests never see trust prompts and cannot grant or apply.** Changes are never activated automatically: no
  watcher, worker restart, new session or agent tool loads an unapproved revision.

### 6.2 Snapshots

A snapshot is an immutable, content-addressed copy of a project's plugin inputs on the p2 host:
`<data>/project-snapshots/<digest>/` with `plugins/**` and `settings.json` from `<cwd>/.pi/p2/`.

- **Capture:** the session worker reads the files through its environment (local or remote, as it reads
  `AGENTS.md`), bounded (initial limits: 500 files, 8 MiB total, 1 MiB per file; regular files only, symlinks
  refused), and hands them to the server as data. The server lists them (4.1), writes the directory to a
  temporary name, makes it read-only and renames it to its digest (sha256 over sorted paths and contents).
- **Approved bytes = executed bytes:** the approval names a digest; workers load worker facets from that directory
  and the server builds web and TUI bundles from it. Nothing reads the project directory again for execution.
- **Retention:** snapshots referenced by a catalog session or a trust record are kept; others are collected after
  a grace period.

### 6.3 Change flow

1. The worker watches `<cwd>/.pi/p2/` through its environment (`runtime/observe.ts`, including directory creation
   and rescans after overflow or reconnect). A change only **marks the scope dirty**; the worker captures a candidate
   snapshot.
2. The owner sees "Project plugins changed: Reload" with a **change summary**: files added/removed/changed, facets
   added/removed per plugin, plugins disabled by project settings. First-time trust shows the same summary in the
   trust notice (directory, plugins, facets, "runs on this device", see 11).
3. **Reload** (owner, interactive web or TUI) approves exactly the candidate's digest: the server builds its web and
   TUI bundles (a failed build refuses the apply with a notice; the old revision keeps running), then records the
   revision in `trust.json` and the catalog.
4. Each affected session's worker installs the new revision of its project facets **in place** (7.4): running calls
   and jobs finish with their old code, new work runs on the new one. Leaving plugins are handled first (10).
5. `ClientBundle` publishes the new hashes; pages and TUIs reload the changed facets in place (a full reload or swap
   for a scope switch).

Revocation and relocation use steps 4–5 with the base scope or the new scope key. A live session never drops to the
base scope mid-turn. Edits arriving during an apply leave the scope dirty again.

## 7. Loading

### 7.1 Facets of every surface: loader model D (revised)

Revision 2 loaded server and worker facets with native `import()` plus Node resolve/load hooks and rejected backend
bundles because a bundle would carry its own copy of Chord. **Superseded by loader model D (14.2):** every facet is one
esbuild bundle whose host packages are **external and passed in as parameters**, so there is exactly one Chord (9.1)
without a module map. Server, worker and TUI worker evaluate it with `vm.Script.runInThisContext`, the web as a
classic `<script>`. What revision 2 asked of the hooks moves into the bundler's resolver:

- **resolve:** host-package specifiers and `apps/p2/src/**` stay external (supplied by the host's base bundle,
  whatever copy a plugin's own `node_modules` holds); `p2:plugins/…` maps per scope (4.2); project snapshot imports are
  confined to the snapshot, the scope's plugins and host packages.
- **load:** esbuild strips TypeScript (also inside `node_modules`, and `.tsx`).
- **`import.meta.url`:** a script has none; the bundler injects each file's real path (as
  `src/hosts/worker-bundle.ts` `sourceRewrites` already does), or the loader passes the facet path (14.4, B4).
- **Node builtins:** a script has no `require`; the loader passes one (14.4, B7).

Interim: until D, worker facets may load as variant C (base bundle plus native TypeScript facets through
`nodeLoader`, 14.1); server facets stay on `nodeLoader`, which leaks a module copy per reload.

### 7.2 Global plugins

`<data>/plugins/<name>/` are TypeScript, bundled per facet like built-ins (7.1). A global plugin with npm
dependencies has its own `package.json` and `node_modules` (installed by the owner with `npm install
--ignore-scripts`); those dependencies are bundled into each of its facets (one copy per facet), host packages still
come from the host.

### 7.3 Project worker facets

The worker's init list (fixed at spawn by the server) is the base worker facets plus the facet bundles the server
built from the session's approved snapshot (D, 14.2). They load in the same load, inside the start barrier
(`target-design.md` §14), so the harness resumes only after all of them are installed, and loading needs no
environment access (the snapshot is local). A remote environment still provides tools, files and watching at
runtime.

### 7.4 Project facets reload in place

A project revision is installed **for that worker only**: the server builds the snapshot's facet scripts and sends that
worker an install of its scope's revision, outside any base rollout. One broken project blocks neither base reloads
nor other sessions. The install follows the per-host reload of `target-design.md` §15 (load, publish, after); running calls and jobs finish with their old code. A restart when idle is not
used: sessions with background work (subagent reporters, code mode scripts) are never idle.

### 7.5 Rollout of a plugin reload

```
owner: npm run reload -- drafts            (explicit, once the edits are done; never on save)
server: builds the facet scripts of drafts for every surface (a failed build refuses the reload)
server: installs: load → publish → after → report
server → every running worker, then every web page and TUI: "install revision R"
each host: load → publish → after → reports installed | installed_failed | rejected
a host that starts or reconnects installs the current revision before anything is routed to it
```

The per-host steps, revisions and mismatch rules are in `target-design.md` §15: a revision is (server incarnation,
sequence) naming the complete code set; a facet whose setup throws keeps its previous version and is reported as
rejected for that plugin; mismatch responses carry the provider's revision and status, so bindings wait for an install
that is coming and fail fast for one that was rejected. Each host installs on its own; there are no votes, gates or
code versions. Order: server, workers, clients.

## 8. Global packages

| Aspect | Rule |
| --- | --- |
| Sources | `npm:@scope/name@1.2.3`, `git:https://host/repo@ref` (https only), local paths |
| Declaration | `packages` in `<data>/settings.json`; object form narrows plugins: `{ "source": "…", "plugins": ["todo", "!legacy"] }` |
| Layout in package | `plugins/<name>/…` by convention, or `"p2": { "plugins": ["./src/foo"] }` |
| Install location | `<data>/packages/{npm,git}/<id>/<revision>/`, one directory and one kept lockfile per package; local paths load in place |
| Install command | `npm install --ignore-scripts --legacy-peer-deps --no-audit --no-fund` (no lifecycle scripts; no automatic host peer installs) |
| Git | shallow clone of the ref, commit recorded; no `prepare` build: TypeScript sources are bundled per facet (7.1) |
| Updates | staged into a new revision directory, then the active revision is switched atomically; a failed install leaves the old one; old revisions stay until no process uses them |
| Dependencies | runtime deps in `dependencies` (bundled into each facet); host packages in `peerDependencies` (external; the host supplies them) |
| Native addons | refused (`binding.gyp`, `.node` files) with a notice; on Termux most would not build anyway; `npm` and `git` must be installed (`pkg install`) |
| Identity | npm package name, git URL without ref, local absolute path; one package loads once |
| UI / CLI | a Plugins sheet (owner) lists, enables, disables, updates; a future CLI `p2 install|remove|list|update` (no such command exists yet) |

No facet bundle, of any surface, contains a host package (9.2).

## 9. Host packages and identity

### 9.1 Why one instance

Chord binds services, registries and contracts **by name** (and contract versions by fingerprint when binding), not
by object identity. One instance per process still matters for:

- declaration and member brands (module-local symbols in `chord/src/declare.ts`, `contract.ts`);
- `Ctx`/`Handle` classes and resource facades (`instanceof CtxImpl`, WeakMaps in `record.ts`);
- `isChordError` (`instanceof ChordError`);
- React (hooks, `HostContext` in `runtime/web.tsx`);
- p2 runtime module state (`runtime/logs.ts`, `runtime/linger.ts` and others), React contexts in `src/web/*`
  (`composer-state.tsx`), `TuiRuntime`/`TuiScope`;
- pi-tui classes that plugins test with `instanceof` (`Text`, `Container`: `plugins/artifacts/tui.ts:29`,
  `plugins/send-file/tui.ts:37`, `plugins/subagents/tui.ts:23`).

So everything under `apps/p2/src/**` is host code too (14.4, B3), although plugins import it by relative path.

### 9.2 Mapping

Under D (14.2) the base bundle contains every host package and `apps/p2/src/**` once. Each facet bundle marks them
external (an esbuild `onResolve` plugin: bare host specifiers, `@earendil-works/p2/*`, and relative paths that leave
the plugin into `apps/p2/src/`) and receives them as parameters when it is evaluated. A check fails the build if a
facet bundle contains a host package or a `src/**` file (14.5).

### 9.2a Contracts are never host packages

Adapters (`accepts`) keep a plugin built against an older contract version working: Chord binds by the description and
version the **caller** brings (the type token passed to `get`), and a provider at version N serves a caller at M < N
through `accepts[M]`. That only works if the plugin carries its own contract version. If its contract imports
resolved to the running p2's modules, every plugin would carry the current version, the adapter would never apply, and
a plugin compiled against v1 types would break at runtime.

- p2 publishes its contracts as a versioned package (e.g. `@earendil-works/p2-contracts`). A contract's `version` is its
  major version: additive changes need no bump (Chord's coverage check admits them); a breaking change bumps it and
  adds an `accepts` adapter for the previous version for as long as it is supported.
- A plugin depends on that package (`"@earendil-works/p2-contracts": "^1"`) and builds against it.
- The loader never maps contract modules to the host's instance, unlike host packages (9.1, 9.2). Contracts are plain
  data (14.3), so copies are harmless. Under D each facet bundle inlines the contract modules it imports, resolved
  **from the plugin's own `node_modules`**, never from p2's tree; the bundle check (14.5) must allow them and fail on
  host packages only.
- Gaps, open in `changes.md` ("API stability"): registries (routes, Durable extensions and tools, slots, TUI commands)
  have no versions or adapters, and native APIs handed to plugins (`opaque` members, host resources such as the Durable
  harness) cannot be adapted at all.

### 9.3 Publishing

When p2 becomes an npm package (`@earendil-works/p2`, compiled JavaScript with an `exports` map for `./runtime/*`,
`./plugins/*` contracts and the CLI), built-ins live in `dist/plugins/`. Plugin authors list p2 as a
`devDependency` and `peerDependency`; the loader checks the peer range (meaningless in repo mode, where the package
is `p2@0.0.1`, so skipped there). Needed work: an installation-relative resolver (the source resolver reads the
checkout's `tsconfig.json`), compiled worker and CLI entry points, and plugins that spawn source files
(`plugins/terminals/detached.ts` starts `src/source.ts`). `apps/` is private today; publishing needs an owner decision
(13.2).

## 10. Leaving a scope: Durable traces

A plugin leaves a session on relocation, disable, removal from disk, trust revocation, a build or load failure, or an
offline environment without a cached snapshot. Today Durable silently skips missing selected extensions
(`durable/src/harness/agent.ts`); pending tasks whose definition is missing stay blocked, and only aborted ones become
`orphaned` (`durable/src/harness/scheduler.ts`). New work:

- **Provenance map:** the per-plugin wrapper records plugin → extensions, task kinds, tools and entry kinds; persisted
  in the session store so a later worker without the plugin can name it.
- **Owner-initiated exits** (Reload, disable, revoke, relocate): before the change applies, live tasks of the leaving
  plugins refuse the change ("Stop … first") or, if the owner chooses, are aborted while their definitions are still
  loaded. Relocation keeps its existing stricter rule (no live tasks or submissions at all).
- **Involuntary exits** (offline, failed load): blocked tasks show "waiting for plugin foo" with an Abort action.

| Trace | Handling |
| --- | --- |
| Extensions selected in a conversation | kept by name; the session shows "Plugin foo is not available here" (new) |
| Entries of the plugin's kinds | generic fallback renderer: kind and data, collapsed (new) |
| Finished tool calls | generic tool card (new) |
| Documents | left alone, inert until the plugin returns |
| Tasks | as above; never resumed by another plugin's definition (13.2, open question 3) |

The same fallbacks render project entries for guests, who always get the base scope.

## 11. Security

| Code | Runs where | Rights |
| --- | --- | --- |
| Built-in, global, package: server and worker facets | the p2 host | the owner's OS account (like pi extensions) |
| Project worker facets | the p2 host, **also for remote sessions** (the phone, next to `auth.json`) | the owner's OS account |
| Web facets (base, or project for the owner) | the viewer's browser, main thread, same origin | **all of the viewer's rights**: for the owner every owner API, including a host shell through terminals |
| TUI facets | the viewer's machine, permission-dropped worker | only the launcher's grants |

- Trusting a project means granting its code the owner's OS account on the p2 host and owner rights in the browser.
  The trust notice says so: "runs on this device with your account".
- CSP (`script-src 'self'`, `connect-src 'self'`) does not restrict same-origin code: it can open its own `/chord`
  socket as the owner and use origin storage shared by tabs of other scopes. HttpOnly only hides the cookie value.
- Scopes keep contributions from mixing; slot restrictions are UX. Neither isolates hostile code.
- Trust is not filesystem isolation. A guest with send access can make the agent write plugin files; that never
  activates code (6.1). On a local session the agent already has a host shell (and could edit `trust.json`); the gate
  prevents automatic activation, not a hostile agent with shell access.
- Guests get only base-scope assets; project bundles are owner-only. Source maps are served to owners only.

## 12. Migration

### 12.1 Order

The Chord and p2 rebuild of `target-design.md` (§22: document store, jobs, routines, resources replaced in place,
registries, host values, rollout with revisions) comes first; plugin loading builds on it.

1. **The rebuild** (`target-design.md` §22), including the per-host install with revisions (7.5) and the per-worker
   install (7.4).
2. **Blockers B1–B8** (14.4): typed TUI surfaces instead of `instanceof` across plugins; cross-plugin imports limited
   to contracts and pure modules; `ws` and `yaml` as host packages; `require` for builtins; web CSS, wasm and
   `import.meta.hot`.
3. **D for server and worker** (14.2): stable script filename per (facet, digest); V8's compilation cache off on hosts
   that reload in place; the dev leak detector, GC tests and static checks (14.5).
4. **D for web and TUI** (12.2, step 4).
5. **Plugin SDK** (`target-design.md` §23, deferred): built-in plugins import only from the SDK, like third-party ones,
   semver per major with a compatibility layer for the previous major. Measured on `private` (`5da70d0f3`): 109
   plugin files import 73 `src/**` modules (most used: `runtime/chord.ts` 72, `runtime/contribute.ts` 47, which goes
   away with facet registrations, `runtime/principals.ts` 27). Recount with
   `grep -rhoE 'from "(\.\./)+src/[^"]+"' plugins | sort | uniq -c | sort -rn` in `apps/p2`.

The worker-bundle prototype that measured the loader variants is on branch `p2-worker-bundle-prototype` (not for
merge); what to reuse: 14.6.

### 12.2 Pipeline steps

Each step lands with its tests; later steps assume earlier ones.

| # | Step | Acceptance (tests) |
| --- | --- | --- |
| 1 | **Roots and discovery:** multi-root `listPlugins`, module→plugin map, `plugins.disabled`, name rules, per-plugin loading. Under Vite, the hard-coded web list becomes a generated virtual module of the selected plugins, so disabling works on every surface. | a disabled plugin whose module top level records a side effect is never imported (server, worker, web, TUI); a plugin whose `setup` throws yields a notice and the others load; two plugins with one name, or a contract name without prefix, are refused with a notice; load order stays irrelevant |
| 2 | **Host mapping and global plugins:** D bundles for server and worker facets (12.1, step 5), `p2:plugins/…`, `<data>/plugins`. External web facets are listed as "waiting for the web bundle" until step 4; TUI works now (esbuild). | a global plugin with its own `node_modules/@earendil-works/chord/old` gets the host instance (`isChordError` and `Ctx` checks pass across); its own npm dependency is bundled and runs; `import.meta.url` is its real file (injected); a global plugin named like a built-in is refused; reloading it 6× leaves no more generations alive than 3× |
| 3 | **Global packages:** install/remove/update/list, staged atomic installs, lockfiles, resources (skills, prompts, themes). | npm and https-git installs load; a package with a host peer gets no physical host copy at runtime; an interrupted update keeps the old revision working; a native addon is refused; an http git source is refused; a skill from a package appears in `/skill:` |
| 4 | **D web bundles with push** (a base bundle plus one classic script and one CSS file per facet; the TUI likewise), then remove Vite (list below). | two owner tabs reload via `ClientBundle` after a web edit and Reload, without `visibilitychange`; a guest can fetch the base bundle's assets but no `/src/…` path; the terminal's wasm loads; the page has a CSP nonce and works with the existing CSP; bundles are cached immutable and manifests `no-store`; a failed web build keeps the old bundle and no backend change commits |
| 5 | **Project scopes and trust:** snapshots, `trust.json`, catalog scope, bootstrap and `/__p2_web/scope`, TUI `?session=`, launcher partitioning, per-worker install (7.4), provenance and fallbacks, skills/prompts gate, slot restriction. | see below |
| 6 | **Publishing:** `dist/`, `exports`, installation-relative resolver, CLI. | a packed tarball installed into an empty directory serves a session with a global plugin and a package |

Step 5 acceptance:

- **Two tabs in different scopes:** tab 1 on session A (project scope), tab 2 on session B (base); each loads its own
  bundle; navigating tab 2 to A is a full load; a Reload of A reloads tab 1 only.
- **Guests:** a guest of A gets the base bundle, sees project entries through the fallback renderer, cannot fetch A's
  bundle or its TUI manifest, never sees trust prompts.
- **Offline remote:** with the environment down, a worker restart of A loads the cached approved snapshot; with the
  snapshot deleted it loads base and shows the notice; no local directory is read instead.
- **Busy session:** Reload during a turn installs the new revision in place (7.4); a phase that pinned the old tool
  table keeps calling the old, consistent code; a call that started on the old revision finishes on it.
- **Failed build:** a candidate with a syntax error in a web facet is refused at Reload; the old revision keeps
  running everywhere; a worker facet that throws at load yields a notice and the other project plugins load.
- **Name clash:** a project plugin named like a global plugin, or a project tool without prefix, is refused with a
  notice; the session works.
- **Trust change:** an agent (or guest-prompted) write to `.pi/p2/plugins` only marks dirty; approving loads exactly
  the summarized digest (a file changed after capture is not executed); revocation applies the base scope like a new
  revision (7.4), refusing while tasks of the leaving plugin are live; pin mode requires the review for a one-byte
  change; project `.pi/skills` do not load in an untrusted directory.
- **TUI:** A→B swap does not replay A's pending send into B; B→A restores A's draft.
- **Relocation:** moving a session between two project directories switches pages and TUIs via `ClientBundle`.

**Removing Vite (step 4)** requires, besides the bundle itself:

- `ghostty-vt.wasm?url` in `plugins/terminals/Terminal.tsx:4`: esbuild `file` loader plus an asset manifest.
- Plugin CSS (`plugins/chat-mode/web.tsx:10`, `plugins/logs/web.tsx:16`, `plugins/terminals/Terminal.tsx:23`): one
  CSS file per facet bundle, linked as `<link data-facet=…>`; an in-place reload adds the new link and removes the
  old one once the new one has loaded. Without that, rules of every generation accumulate (14.4, B8).
- `import.meta.hot` in `src/hosts/web/main.tsx` and the `/version` check: replaced by `ClientBundle`.
- HTML: the server renders `index.html` with the nonce on the inline theme script and the bootstrap (Vite's
  `html.cspNonce` does it today); `public/` icons and `manifest.webmanifest` served statically.
- `envPrefix: "P2_PUBLIC_"`: no current uses in web code; drop it (or esbuild `define` if one appears).
- The non-owner `/@vite/client` stub, `GUEST_EXTRAS` and the module-graph allowlist: replaced by per-principal
  bundle authorization.
- Caching: the server sets `Cache-Control: no-store` on every response (`src/hosts/server.ts`); bundles and assets
  need `private, max-age=31536000, immutable`; HTML, bootstrap, manifests and `/__p2_web/scope` stay `no-store`.
- JSX (`@vitejs/plugin-react` → esbuild `jsx: automatic`), tsconfig paths (esbuild reads them), CSS order.
- Dev loop: today web edits are HMR-only and not marked dirty (p2-notes, Dev mode); the watcher must mark web facets
  and `src/web`, `src/hosts/web`, `src/runtime/web.tsx` dirty, and Reload rebuilds and pushes. The dev tests for
  "HMR-only web edits" change accordingly.

**Bundle builds and cache:** measured on slayer by the reviewers: web ≈ 0.1 s, ≈ 1 MiB minified JS + 54 KiB CSS
(+ 0.67 MiB wasm); TUI ≈ 0.2 s, ≈ 1 MiB. Not measured on the phone (expect seconds; measure in step 4). Builds are
single-flight per input key (host build, base revision, snapshot digest, disabled set, esbuild version), at most one
or two at a time, failures cached per key until inputs change. Disk cache under `<data>/bundles/` with an LRU budget
that never evicts bundles referenced by a catalog session. The TUI's 8 MiB cap stays; the web bundle gets a cap too.
D removes `nodeLoader`'s module copy per reload.

## 13. Decisions and open questions

### 13.1 Decided

| Question | Decision |
| --- | --- |
| Project plugin directory | `<cwd>/.pi/p2/plugins` (pi ignores `.pi/p2`; mirrors `<data>/plugins`) |
| Project packages | not in v1 |
| Trust granularity | per directory, changes only by explicit Reload with summary; optional pin to content (6) |
| Project web facets for guests | no in v1; base bundle with fallback renderers; TUI likewise (5.1) |
| Vite | dropped after the D web bundles and `ClientBundle` push exist (12.2, step 4) |
| Loader | model D on every surface: base bundle plus one script per facet, host packages as parameters, in-place reload through Chord (7.1, 14.2); A (restart when idle) and B rejected (14.1) |
| Plugin reload | per-host install of a revision, rollout server → workers → clients, mismatches against a host behind wait (7.5) |
| Project worker reload | in place, a per-worker install outside base rollouts (7.4) |
| Timers | no raw `setTimeout`/`setInterval` in facets: routines (`every`, `loop`) and jobs (`target-design.md` §§10–11) |
| Identity across plugins | no `instanceof` on another plugin's classes; typed surfaces resolved by name (14.3) |
| Resource values | native values only; behaviour in routines (`target-design.md` §12) |
| Dev loop | runtime changes restart the affected hosts; plugin changes reload in place (4.1) |
| Scope selection | catalog scope, bootstrap script, TUI `?session=`, launcher-owned snapshots (5.2) |
| Names | prefixes, checked at load; per-plugin loading (4.3) |
| Project `.pi/skills`, `.pi/prompts` | gated by project trust (behavior change; 3) |
| Global plugin dependencies | own `package.json`/`node_modules`; cycles keep current order rules; `.js` allowed for packages |

### 13.2 Open

1. **Skills of base plugins on remote sessions.** Their files are on the host. Recommended: upload bounded,
   content-addressed copies (`~/.pi/p2/plugin-skills/<plugin>/<hash>/` on the remote, like the daemon deployment)
   and offer the skill only after the upload succeeded. Until then: local sessions only, listed as unavailable on
   remote sessions (not hidden).
2. **Publishing:** whether and when `apps/p2` leaves the private tree, and which modules `exports` makes public.
3. **Plugin identity across projects:** project A and project B may both have a plugin `foo` with different code.
   A session relocated from A to B (when idle) would render A's `foo.*` entries and resolve stored `foo.*` task kinds
   with B's code. Options: include a per-project plugin identity in provenance and treat a mismatch as "not available
   here", or accept it as the owner's choice.
4. **Guest opt-in per share** for project web facets: disclosure and consent design.
5. **Project root:** the session cwd only (as pi), or the nearest ancestor with `.pi/p2` (sessions in subdirectories
   of a repository would then share its plugins).
6. **Browser compile cache** (14.2): whether Blink/V8 keeps every classic script it compiled, as Node does; measure
   before web D, else bound in-place web reloads (a full reload after N generations).

## 14. Loader model D


### 14.1 Loader variants (measured)

Measured with the worker-bundle prototype (`src/hosts/worker-bundle.ts`, `P2_WORKER_BUNDLE`), Node 26, worker spawn
to ready. Packages, runtime and hosts are ~85% of the load time (1,251 modules), plugin files ~14% (73 modules): the
win is bundling the base, not the plugins.

| Variant | Spawn → ready | Verdict |
| --- | --- | --- |
| Today: TypeScript through the source resolver, facets through `nodeLoader` | 549 ms | leaks a module copy per server reload |
| A: one bundle per worker plugin set, facet changes by restart when idle | 218 ms | **rejected**: sessions with long background tasks (subagent reporters, code mode scripts) are never idle, and a restart loses Chord's in-place reload (worker state, documents, running jobs) |
| B: base bundle plus one ESM bundle per plugin through `nodeLoader` | 254 ms | rejected: copies cross-plugin files (31 copies of 14 files), renames facets, breaks the agent/codemode direct-reload tests |
| C: base bundle plus native TypeScript facets through `nodeLoader` | 317 ms | passes all worker tests; **interim** fallback (still one module copy per reload) |
| **D** (14.2) | not measured (expected near B) | **target** |

### 14.2 Model D

- **Base bundle:** host packages (Chord, pi-durable, pi-ai, pi-env, pi-codemode, pi-tui, pi-schema, React, and `ws`,
  `yaml`, 14.4 B7), p2's runtime and hosts (`apps/p2/src/**`). One per surface; it changes only with p2 itself.
- **One script per facet:** an esbuild bundle of the facet and its plugin's files, wrapped as a function of its host
  packages: `(require, …) => facet`. Host packages and `src/**` are external and passed in (9.2); the facet's file
  paths are injected for `import.meta.url` (B4). Server, worker and TUI worker evaluate it with
  `vm.Script.runInThisContext`; the web loads it as a classic `<script>` (plus one CSS file, B8).
- **No module map.** A generation is the set of closures of one evaluation. Once nothing references them, the GC
  reclaims its code and module state; there is nothing to evict.
- **Reload stays Chord's:** a changed facet's new script is evaluated and installed on its host (7.5): documents and
  resources stay, behaviour is replaced, running calls and jobs finish with their old code.
- **Script identity:** each script is compiled with a **stable filename per (facet, content digest)**, and hosts that
  reload in place run with V8's compilation cache off (`--no-compilation-cache`, or `v8.setFlagsFromString` at
  startup), else every distinct script stays in memory (14.3, C6).
- **Full reload** (process restart, page load, TUI worker swap) remains for base changes, scope switches and stuck
  generations (one the leak detector reports alive after N reloads, 14.5).

D only reclaims a generation if nothing keeps it. The rebuild removes most of what kept generations alive (resources
hold natives only, behaviour lives in routines that restart, registry tables are plain values, no carrier objects); the
leaks still open are tracked in `changes.md` ("Tracked, not scheduled").

**V8 compilation cache** (measured): every distinct (source, filename) compiled by `vm.Script`, `compileFunction`, eval
or `new Function` stays cached and is not released under memory pressure (100 compiles of a 72 KB bundle with distinct
filenames: +5.6 MiB; 1,500 unique compiles at `--max-old-space-size=60`: out of memory). Hence the stable filename per
(facet, digest) and `--no-compilation-cache` (or `v8.setFlagsFromString`) on hosts that reload in place (+0.1 MiB).
Browsers are measured before web D (13.2, question 6).

### 14.3 No `instanceof` across plugins

It exists only because the TUI's `ctx.surface("chat")` is untyped (`plugins/chat-mode/tui.ts`, `plugins/send-file/tui.ts`,
importing `ChatSurface` from `../chat/tui.ts`). Under D it is always false. Fix: `ctx.surface` takes a typed key
(`defineSurface<ChatApi>("chat")`) resolved by name, like contracts; chat-mode's reply policy becomes a registry entry or
document chat reads; send-file reads its tool calls from the `Chat` view. `instanceof` on base classes (pi-tui `Text`,
`Container`) is fine.

### 14.4 Blockers for D

- **B1 `instanceof` across bundles** (14.3).
- **B2 Cross-plugin files are copied** into each importing facet, with their module state: `envs/DirectoryPicker.tsx`,
  `subagents/tools.ts`, `files/downloads.ts`, `envs/remote-env.ts` and `config.ts`, `conversations/origin.ts`,
  `workspace/protocol.ts`, `chat/tui.ts`. Rule: contracts and side-effect-free modules only (4.2).
- **B3 `apps/p2/src/**` is single-instance host code** (9.1): `HostContext`, `src/web` contexts, `TuiRuntime`, pi-tui
  classes. The bundler externalizes relative paths into `src/` (9.2).
- **B4 `import.meta.url`:** `plugins/dev-tools/worker.ts`, `plugins/prompt/worker.ts`, `plugins/terminals/detached.ts`.
  Inject per file.
- **B5 Dynamic `import()`:** none in plugin code; the base keeps resolving pi-ai's lazy API loaders and pi-codemode's
  worker-thread entries.
- **B6 Top-level await:** none in facets; `plugins/terminals/main.ts` and `plugins/radius/login.ts` are process entries.
- **B7 CommonJS and builtins:** `ws` and `yaml` become host packages; Node builtins come through a `require` the loader
  passes.
- **B8 Web:** `?url` wasm (`plugins/terminals/Terminal.tsx`), plugin CSS (12.2 "Removing Vite"), `import.meta.hot` in
  `src/hosts/web/main.tsx`.

### 14.5 Guardrails

- **Generation-GC tests:** Chord unit tests (documents, registrations, kept resource, routines, jobs) asserting old
  generations are collected; a p2 test that loads every server and worker facet with fakes through the D loader,
  reloads 3× and 6×, and asserts the alive set does not grow between 3 and 6; the TUI inside its worker runtime; the web
  through CDP heap snapshots.
- **Dev leak detector:** the loader registers each generation's sentinel in a `FinalizationRegistry`; more than two
  generations of a facet alive posts a Logs notice naming the facet; a `/__p2_dev` action writes a heap snapshot.
- **Static checks:** cross-plugin imports only of contracts and allowlisted pure modules; no `instanceof` on another
  plugin's classes; no `import.meta`, `import()`, top-level await or `require` in facet import graphs (esbuild
  metafile); no module-level side effects in facets; no raw timers in facets; no handlers inside resource `open`.
- **Bundle check:** the build fails if a facet bundle contains a host package or a file under `apps/p2/src/`.

### 14.6 The worker-bundle prototype

Branch `p2-worker-bundle-prototype`, commit `e290c4fe1` (not for merge). It built variants A–C for session workers and
measured them. Reuse for D: the scan pass (`onResolve` plus `builder.resolve`, also the bundle check), the base-bundle
build with one entry per host module and shared chunks, `sourceRewrites` (`import.meta.url` injection, made AST-safe),
the bundle cache (content-addressed directories, staging and atomic rename, single-flight, prune), the server hand-off
(`SessionHosts.bundle()`, build before install, metafile inputs for dirty marking), its cache and stack-trace tests.
Drop: restart when idle, variants A and B, C's hook.

## Appendix A. Review notes

Every finding was checked against the code; the claims cited above were confirmed (Chord `not_coordinator` and
longest-prefix module lists; name-based binding; `discoverPluginTypes` importing every facet, since removed;
`/version` on `visibilitychange` only; the fixed TUI manifest and cross-identity snapshots; global `no-store`; Durable
silently skipping extensions and blocking tasks; ungated `.pi/skills`/`.pi/prompts`; `?url` wasm; `import.meta.url`
users).
Where this design deviates from a reviewer or the owner's brief:

1. **Tool names use `<plugin>_`, not `<plugin>.`.** Provider APIs (Anthropic, OpenAI) restrict tool names to
   `[a-zA-Z0-9_-]{1,64}`; a dot would break the tool on those providers. All other names use `<plugin>.`.
2. **No `defaultProjectTrust: "always"`** (pi has it): it would activate project code without the owner, contrary to
   6.1.
3. **In-place project reload protocols** (Fable B1/B2, Sol B2, Astra B3: server-coordinated per-session reloads,
   stable facet names, transactional base+project reloads): revision 2 found them unnecessary because project facets
   applied by restart. Revision 3 rejects restart at idle (14.1), so a server-coordinated per-worker reload is needed
   again (7.4, 13.2 question 6).
4. **Server-built project worker bundles** (Fable B3, Opus I2) and **bundling package backends** (old 9.2):
   revision 2 replaced them by Node hooks; revision 3 adopts them in the form of D, which keeps one host instance by
   passing host packages in and injects `import.meta.url` (7.1, 14.2).
5. **esbuild metafile instead of the TypeScript parser** (Opus I4): moot. Discovery no longer parses anything (owner
   decision); dependencies resolve at runtime (4.2).
6. **Project packages under `~/.pi/p2/project-packages`** (Fable B3, Opus I7, Astra/Sol §13.2): deferred with
   project packages (not in v1).
7. **Guests get approved project web facets** (Fable, Astra §13.4): overridden by the owner decision (base scope only).
8. **Directory trust with automatic in-place reload** (Fable B4): overridden; changes apply only by Reload.
9. **Opus M3** (refuse a project plugin with `server` as a whole) adopted; the old text refused only the facet.
10. **Opus I12** (`P2_PUBLIC_` prefix): kept in the removal list, but no web code uses `import.meta.env` today, so the
    work is deletion.
11. **Revision 3** (owner decisions after the worker-bundle prototype and a reload-leak audit, section 14): loader
    model D replaces Node hooks and restart at idle (7.1, 7.4); declared timers, typed surfaces and plain resource
    values (14.5); the leak fixes precede D (12.1).
