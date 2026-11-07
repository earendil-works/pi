---
title: p3: the reload loop
cover: The Reload / Loop
kicker: An explainer · p3 · 2026-11-06
subtitle: What is bundled into what, what only a restart changes, and what happens, step by step, when someone edits a file of a running p3
stats:
  - 4 | bundles built once at start (server code is loaded, not bundled)
  - 1 | script per plugin and host kind, rebuilt on Apply
  - 0 | dev modes: the phone runs the same loop
  - 3 | rough edges fixed in step 0a, 1 accepted
note: |
  Written for the owner from the Chord code on branch `p3` (`packages/chord/src/node/plugins/`, `node/surfaces/`,
  `node/workers/`, `node/app/`, `src/web/`) and design §21. The p3 file names are step 0's. The last chapter lists what
  the step-0 reviewers found rough, and what step 0a did about each.
colophon: p3 reload loop · first edition · 2026-11-06 · sources: Chord design §21, §23; the plugins, surfaces, workers and app kit code
---

# Before we begin {.preface}

An agent on slayer edits `apps/p3/plugins/hello/server.ts` while Mario uses p3 on his phone. Nothing happens yet: the
file is saved, a bar in Mario's page says "1 plugin changed". He taps **Apply**. A tenth of a second later the server
runs the new code for that one plugin; his page did not reload, his scroll and half-typed text are where they were.
Had the agent edited `apps/p3/src/api/v1/index.ts` instead, the bar would say "restart needed", and only a restart of
the p3 process would bring that change in, reloading every page.

This is the loop for development and production alike: p3 has no dev mode. The phone, slayer and a test run the same
code paths. What decides whether an edit is a quiet plugin reload or a restart is only which file it touches.

## Seven things to know

:::findings
1. **Three kinds of code.** Base code (the start script, the API, the entries, Chord, React) is loaded or bundled once
   at start. Plugin code is built per plugin and replaced while running. Data (stores, files) is never code and
   survives both.
2. **Four bundles are made at start and never again:** the worker base (every session worker is forked from it), the
   page's base bundle, the terminal's base bundle, and Node's own module graph of the server. Changing what went into
   them needs a restart.
3. **A plugin is one script per kind of host.** `server.ts`, `worker.ts`, `web.tsx`, `tui.ts`: each built by esbuild into
   one script with the plugin's own files, copied contract files of sibling plugins and its npm packages inlined; the
   API, Chord and React stay outside and are passed in.
4. **Saving marks, Apply applies.** A watcher marks the plugins whose files changed; nothing is built or loaded until
   someone applies (a button, an agent's tool, a test). An agent half way through an edit never breaks the app.
5. **Apply builds, then rolls out in order:** the server, every running worker, then every open page and terminal. On
   each, only the changed plugin's objects restart and only its components remount.
6. **A failed build changes nothing.** The plugin keeps its old code everywhere and stays marked; the error is shown.
7. **A restart is the only way base code changes.** It stops the server and every worker; pages reconnect, see a new
   base bundle and reload. Stores keep everything.
:::

## Words used throughout

**Base code**: what a restart changes. **Plugin**: a directory in `apps/p3/plugins/` (or the user's
`~/.p3/plugins/`) with a `package.json` and one file per kind of host. **Script**: one built facet, plain data (code,
digest, inputs). **Mark**: the watcher's note that a plugin changed (`dirty`), that plugins appeared or vanished
(`set`), that a `package.json` changed (`install`), or that base code changed (`base`). **Apply**: build the marked
plugins and roll them out. **Rollout step**: one kind of host receiving the new set (the server, a worker kind, the
pages). **Restart**: the p3 process stops and starts again.

# What Bundles What {#bundles lede="Every piece of code in a running p3, where it is built and when it can change."}

:::flow wide | What runs where, and what made it. Accent: rebuilt on Apply; muted: built once at start.
row "Built once at start (base code)" muted
box node "server process" "Node loads start.ts, the kit, Chord, the API" muted
box wbase "worker base" "esbuild: worker.ts + what it imports" muted
box pbase "page base bundle" "esbuild: src/web/main.tsx, API, Chord, React" muted
box tbase "terminal base bundle" "esbuild: the TUI entry" muted
row "Built per plugin, on Apply" accent
box ssrv "hello: server script" "server.ts + copied contracts" accent
box swrk "x: worker script" "worker.ts + copied contracts" accent
box sweb "hello: web script" "web.tsx + CSS + assets" accent
row "Never code" blue
box stores "stores" "server/store.sqlite, workers/*/store.sqlite" blue
box files "files" "server/files, workers/*/files" blue
arrow node -> ssrv "vm.Script"
arrow wbase -> swrk "vm.Script, in each worker"
arrow pbase -> sweb "<script src>, in each page"
note "Plugin scripts are evaluated inside the base code of their host; they reach Chord, the API and React through it."
:::

| Code | Built | By | Runs in | Changes by |
| --- | --- | --- | --- | --- |
| `start.ts`, the kit, Chord, `src/api/v1/*`, `src/principals.ts` | not bundled: Node loads them at start | Node | the server process | restart |
| `worker.ts` and everything it imports (API, Chord, pi-ai, pi-durable) | once, when the server starts | esbuild (the workers component) | every session worker | restart (a worker forked later still gets the start's snapshot) |
| `src/web/main.tsx` and what it imports (API web module, Chord, React) | once, at start, content-hashed | esbuild (the web surface) | every page | restart, then each page reloads |
| the terminal entry | once, at start | esbuild (the terminal surface) | every terminal client's sandbox | restart, then the terminal restarts its sandbox |
| a plugin's `server.ts` | at start, then on each Apply that includes it | esbuild (the plugins component) | the server | Apply |
| a plugin's `worker.ts` | same | same; workers never build | every running worker, and every worker started later | Apply |
| a plugin's `web.tsx`, its CSS and assets | same | same | every open page, and every page opened later | Apply |
| a plugin's npm `dependencies` | inlined into its scripts | esbuild | wherever the script runs | Apply (after an install) |
| a plugin's `chord.external` packages, native addons | not bundled: Node's module cache | Node | server and workers | restart |
| stores and files | never: data | | server and workers | never by code changes |

**Why base code is built only once.** The server, its workers and its pages must agree on the vocabulary: the API's
registry tokens and contracts, Chord's wire protocol, the React instance plugins share. If a worker forked after an
edit loaded the edited API from disk, it would talk to a server running the old one. So the kit bundles the worker
entry once when the server starts (decision "Workers start from the base code the server booted with") and builds the
page's base bundle once; the watcher only flags (`base`) that they changed.

**Why plugins are scripts.** A plugin built into one self-contained script (its own files and its npm packages
inlined, the shared modules passed in) can be evaluated again at any time without touching anything else: the server
evaluates the new `server.ts` script with `vm.Script` beside the old one, and the old one is collected once nothing
holds its objects. A page loads the new `web.tsx` script with a `<script src>` (the page's security policy allows no
`eval`).

# Never Reloaded {#never lede="What only a restart changes, and what that costs."}

Everything in the muted row of the figure. Concretely, for p3:

- `apps/p3/start.ts`, `apps/p3/worker.ts`, everything under `apps/p3/src/` (the API, the principal type, the web
  entry);
- Chord itself, React, pi-ai, pi-durable, pi-schema: every package base code imports;
- packages a plugin keeps external (`"chord": { "external": [...] }`), which Node caches until the process ends.

A restart costs: every worker stops (a Durable run in a worker is recovered when the worker starts again, from its last
commit); every page and terminal drops its connection, reconnects (the page's loop retries from 250 ms up to 5 s) and,
because the base bundle's hash changed, reloads the whole page: scroll, half-typed text and page state are lost.
Stores and files are untouched.

That is the price p2 paid for most changes. In p3 base code is about 200 lines of vocabulary and entries; behaviour
never lives there (decision "Reloads first"), so restarts come with a Chord or package upgrade or an API change, not
with a feature.

# Reloaded, and How {#how lede="Apply, host by host: the server, the workers, the pages."}

Apply is one call, `app.applyChanges(ctx)`: it builds the marked plugins and rolls the result out in a fixed order. One
apply runs at a time; a second waits for the first (otherwise an older build could land after a newer one).

**1. Build.** One esbuild call per facet file of each marked plugin, from source, on the server (workers and pages
never build). The build checks every import: a plugin may import its own files, the app's API at one version, host
packages of its kind, and sibling plugins' contract files by relative path (copied in); anything else is a build error
naming the file and line. A plugin whose build fails is left as it is everywhere: old code, still marked, the error
reported. A plugin builds in tens of milliseconds (twenty plugins at start take about a quarter of a second).

**2. The server** (`host.reload` with the complete new set). Staging runs the new facet's setup against a recording
host (declarations only); if that throws, the plugin keeps its old code. Then one commit swaps the set, and every live
object of the changed plugin **restarts**: calls already running finish on the old code, and so does everything those
calls cause (up to `reloadDrainTimeout`, 5 s); calls arriving meanwhile wait and run on the new code; then the old
object seals, its natives close, and the new factory runs with the same documents and tables. Objects of other plugins
are untouched. A reference held by a page stays `live` with its last values while the old code drains, shows
`loading` for the moment between, then gets the new object's values in one frame.

**3. The workers.** The new set is sent over IPC to every running worker of every kind, which evaluates the new scripts
(it never builds) and reloads its host the same way. A worker that is not running gets the current set when it starts.

**4. The pages and terminals.** The web surface publishes the new set (script names, digests, URLs) as the state of a
small object every page holds; the publication does not wait for pages. Each page gets one frame, fetches only the
changed scripts (`<script src>`), and reloads its own host in place: the changed plugin's contributions are replaced,
registries recompose, React re-renders. Components of the changed plugin are new functions, so they remount: their
`useState` starts over, `usePageState` keeps what it holds (a draft), the scroll of the page is untouched. Other plugins'
components keep their state. A page that was offline catches up from the snapshot when it reconnects.

**5. The marks clear** for every plugin that was applied on every host. A plugin that failed anywhere stays marked.

:::sequence animate | Apply after an edit of `plugins/hello/server.ts` and `web.tsx`: the order of a rollout.
actor watch "watcher" "fs.watch" muted
actor plug "plugins" "build, rollout" accent
actor server "server host" "Hello, Counter"
actor worker "workers" "each running one" muted
actor page "page" "Mario's phone" blue
watch -> plug: file changed: mark @p3/hello dirty
plug --> page: marks (the bar: 1 plugin changed)
page -> plug: Apply
plug => plug: build hello: server.ts, web.tsx
plug => server: host.reload: stage, commit, restart Hello and Counter
server --> page: Hello stays live, then the new values
plug => worker: ship the set (hello has no worker facet: nothing restarts)
plug => page: publish the web set
page -> page: fetch hello's web script, reload in place, HelloPart remounts
plug --> page: marks clear
:::

# The Loop: I Edit File X {#loop lede="What happens, exactly, for each kind of file."}

| Edit | Marks | Apply does | Mario sees |
| --- | --- | --- | --- |
| `plugins/hello/server.ts` | `dirty: [@p3/hello]` | builds hello's facets; restarts hello's objects on the server; ships to workers; publishes the web set (hello's web script unchanged: pages fetch nothing) | the counter `live` throughout, a blink of `loading`, the new code's value |
| `plugins/hello/web.tsx` | `dirty: [@p3/hello]` | builds; the server and workers get an unchanged server script (same digest: nothing restarts); pages fetch hello's new web script | hello's part remounts in place and shows its loading state for one round trip; nothing else moves |
| `plugins/hello/hello.module.css` | `dirty: [@p3/hello]` | the web script and its stylesheet are rebuilt; pages swap hello's stylesheet | hello restyles in place |
| `plugins/shell/contract.web.ts` (a token others import) | `dirty: [shell, hello, reload]`: every plugin that copied it | rebuilds all three; each page reloads the three in place | the page redraws in place |
| a new directory `plugins/notes/` | `set` | discovers again, builds notes, loads it everywhere | its parts appear |
| deleting `plugins/notes/` | `set` | notes' objects end, its contributions leave, its references elsewhere wait | its parts disappear |
| `plugins/hello/package.json` (a new dependency) | `install` | today: nothing installs; the dependency must be installed first (`npm install --ignore-scripts` in the plugin, or the kit's `installDependencies`), then the plugin is marked and builds | (a gap: see the last chapter) |
| half an edit: an agent saved a file that does not compile | `dirty` | the build fails: hello keeps its old code on every host, stays marked, the error is shown | nothing changes |
| `src/api/v1/index.ts`, `start.ts`, `worker.ts`, `src/web/main.tsx` | `base` | nothing: Apply cannot change base code | "restart needed" |
| Chord, React, pi-ai, pi-durable source (this monorepo) | `base` (they went into a base bundle) | nothing | "restart needed" |

**After a restart**, for the last two rows: the server starts, builds the worker base and the page's base bundle from the
files as they are now (a new hash), builds every plugin once, loads them. Pages reconnect, ask for the base hash, see
it changed and reload. Workers start on their first reference with the new worker base. If a base file does not build,
the server does not start, and p3 is down until it is fixed: base code edits are the risky ones, which is one more
reason to keep it small.

**Who presses Apply.** In step 0 the reload test calls `app.applyChanges` itself; step 0c gives the page a bar with an
Apply button (decision 1 of the step-0 spec: a kit object for the marks and the apply); later an agent gets the same as
a tool. Nothing applies on save: a save is often half an edit.

# What Step 0a Changed {.epilogue lede="The four rough edges the step-0 reviewers found, and what became of each."}

1. **A reloaded UI part shows its loading state.** After a page or terminal plugin's reload its components remount and
   make new references, which have no values for one round trip. Sharing references between components to avoid that
   was proposed, reviewed four times and rejected by the owner (decision "A reloaded UI part shows its loading
   state"): a short loading state of the reloaded part is fine; the rest of the page, and every server or worker
   reload, stay live.
2. **Stylesheets** (fixed): a page fetches a plugin's new stylesheet inactive before it reloads the plugin, switches it
   on only if the plugin's new code was adopted, and retires the old one after a drawn frame. Failed stylesheets are
   retried by the next update, also those that failed at the page's first load. Limitation: UI contributed by an object
   that restarts can show unstyled until its successor is live (accepted, owner: UI is contributed from facets).
3. **Base bundles** (fixed): the page's and the terminal's base resolve packages with the server's conditions: an app
   installed from npm gets `dist/` everywhere, a server started with `--conditions=source` gets source everywhere.
4. **"Restart needed"** (fixed): each running base records a SHA-256 hash of the bytes it read per file (the worker, page and terminal bundles,
   and a best-effort scan of the server's start script); the mark is true exactly while a recorded file differs, and
   clears after a revert. Edits before the watcher started are found when it starts; ancestor directories are watched
   by identity.

And one gap for later: a plugin's new npm dependency is not installed by Apply (the `install` mark is shown, the app
must install); p3 handles it when the first plugin needs a dependency.
