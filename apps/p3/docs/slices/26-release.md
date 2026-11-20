# Slice 26: the release build

**Goal.** p3 packaged as it would ship to npm: one package with a `p3` command, the server's base code bundled (no
TypeScript loaded at run time), the built-in plugins as source. A local command builds it, packs it and installs it
outside the repository; the end-to-end test and the bench run against that install, and the brief reports the release
and today's source path side by side.

State: all three parts built (2026-11-16), with the fixes of review rounds 1, 2 and 3; the next review round
follows. Not committed. It comes after slice 1 and before slice 25. The first part (the release build) was built on the
recommendations of "Decisions"; the **second part** (owner's scope additions: the API named `@earendil-works/p3/v1`,
the release shipping types for third-party plugins) and the **third part** (owner: the commands, the background server
as supervisor, `server.json`, several Pis on one machine) are specified below and followed it. **"As built" is the
current statement of what the slice is**; the first part's plan is folded into it, and the second and third parts'
specifications stay as the owner's request, with "As built" saying where the build differs.

## Precedents

**p2** has no release build: it runs from the checkout (`npm start` is `node --import ./src/source.ts
src/hosts/server.ts`, a resolver that maps workspace packages to their sources), and the phone deploys from git. Its
features in this area and what p3 does with each:

| p2 | p3, this slice |
| --- | --- |
| started from the checkout with a source resolver | kept for development (`node --conditions=source server.ts`); the release is a second way to run the same code |
| `npm run owner-link` prints a new owner link | plain `p3` asks the running server for a fresh one (third part) |
| `scripts/dev.mjs`, `reload.mjs` (watch, reload) | slice 2 (Apply) |
| the terminal client's bundle, built by the server and fetched by a launcher | slice 16 |
| data migrations (`migrate-*.ts`) | none: p3 starts empty |

**coding-agent** is the model for packaging (read for this brief: `packages/coding-agent/package.json`,
`scripts/build-coding-agent-bundle.mjs`, `scripts/package-files.mjs`, `scripts/local-release.mjs` with
`package-artifacts.mjs`, `local-package-install.mjs` and `npm-command.mjs`, `.pi/skills/release.md`,
`scripts/generate-coding-agent-install-lock.mjs`). What p3 takes from it, and what not:

| coding-agent | p3 |
| --- | --- |
| `bin: { pi: "dist/bundle/cli.js" }`: a launcher of five lines that calls `enableCompileCache()`, then loads the bundle | the same: `dist/p3.js` enables Node's compile cache, then imports `dist/main.js` |
| `tsc` to `dist/`, then esbuild bundles the compiled files (`splitting`, `minifySyntax`, `minifyWhitespace`, no source maps, `tsconfigRaw: {}` so no monorepo path alias applies) | esbuild bundles the TypeScript sources directly with the condition `source` (workspace packages resolve to their `src/`); no `tsc` step, because p3 emits nothing (`npm run check` type-checks) |
| a list of allowed external packages, checked against the bundle's metafile; anything else left external fails the build | the same check; allowed: `esbuild`, and `ws`'s two optional accelerators |
| `files: ["dist", …]` in the package's own `package.json` | the same: the workspace's `package.json` is the shipped one (second part) |
| `release:local -- --out <dir>`: build, `npm pack --ignore-scripts`, install each tarball into an isolated directory with `npm install --ignore-scripts --omit=dev`, smoke test | `release:p3:local -- --out <dir>`: the same steps for p3 and the three workspace packages it depends on, then the release test against the install |
| the Bun binary, the `install-lock/` (a pinned lockfile for installers), publishing from CI | not now (Carried) |

## Numbers (the first part)

`bench/slice-1.ts` against a launched server, on slayer (Linux x64, Node 24.4.1), 2026-11-16, three runs each
(`node … bench/slice-1.ts` for the source path, `… --release /tmp/p3-release/install` for the release). Launch
numbers are medians of five launches per run.

| | Source (`node --conditions=source bin.ts`) | Release (the installed `p3`) |
| --- | --- | --- |
| process launch to listening, cold (an empty compile cache) | 480–483 ms | 125–137 ms |
| process launch to listening, warm | 154–157 ms | 100–127 ms |
| server `RssAnon` (the server process alone, 11 workers running) | 76.0–77.8 MiB | 39.8–43.9 MiB |
| worker start, cold (the first after a start) | 212–256 ms | 152–217 ms |
| worker start, warm (median of 10) | 90–92 ms | 79–81 ms |
| an idle worker's `RssAnon` / USS (median of 10) | 34.4–34.7 / 35.1–35.5 MiB | 27.3–27.4 / 27.9–28.2 MiB |
| ten idle workers at once, PSS | 379–384 MiB (38 each) | 304–310 MiB (31 each) |
| the list at 1,000 sessions: open, `more` | 0.73, 0.59 ms | 0.67, 0.51 ms |
| the list at 10,000 | 0.65, 0.47 ms | 0.63, 0.46 ms |
| the list at 100,000 | 0.63, 0.45 ms | 0.62, 0.45 ms |

- **Launch:** cold, the release is 3.6 times faster (no type stripping, four files instead of several hundred
  modules). Warm, the gap is small: Node's compile cache already serves the source path's stripped modules.
- **Memory:** the server needs half (it no longer keeps every module's source and the type stripper), a worker a
  fifth less (7 MiB each; 100 idle workers: about 2.8 GiB instead of 3.5).
- **The list** is the same code and does not move.
- The server's memory was measured with the bench's client in the same process until now (105–114 MiB in slice 1's
  brief); here the server is a process of its own.

**The package:** the tarball is 265 kB (11 files); installed it is 1.1 MB (`dist/` 981 KiB: one shared chunk of
943 KiB, `main.js` 60 KiB, `worker.js` 1 KiB). esbuild adds 11 MB (its binary for the platform).

### What a start builds (for the decision on a build cache)

Nothing built is kept between starts (Chord's decision "A"), so every start builds the server's plugins before it
listens and the worker base right after. Measured with `NODE_DEBUG=p3`, which makes the kit print both (medians of
the warm launches above):

| Every start | Source | Release |
| --- | --- | --- |
| the server's plugins built and loaded (one plugin, `sessions`; before the listen) | 27 ms | 32–34 ms |
| the worker base built (after the listen; the first worker start waits for it) | 134–138 ms | 114–121 ms |
| the first worker start beyond a warm one (the worker facets built, the base written, its code compiled) | 120–165 ms | 70–140 ms |

- The server's plugin build is a quarter of a warm launch today, with one plugin of 300 lines. It is one esbuild
  call per facet (the first also starts esbuild's service), so it grows with the number of plugins. Not measured
  with more plugins: with the 60 or so p3 will have, a start would spend most of its time there, more so on the
  phone. That is where a cache on disk would pay.
- The worker base costs the same in both paths, although the release's entry is already a bundle: Chord bundles
  whatever the entry imports again (the 943 KiB chunk), with names kept and source maps. A release could hand Chord
  a ready base and skip that; it is a Chord change (Carried).
- A cache would be keyed by the content of what a build read (Chord's plugins component already hashes those files
  for its `dirty` mark, the worker base records its inputs' hashes). Not built: the owner decides.

## Read first, in full

`names.md`, `decisions.md`, `workflow.md`, `chord-practices.md`; the root `AGENTS.md` ("Dependency and Install
Security", "Releasing"); slice 1's brief and walkthrough; coding-agent's files listed under "Precedents";
`packages/chord/src/node/workers/README.md` ("The worker base") and `base.ts`; `packages/chord/src/node/plugins/README.md`
and `build.ts` (host packages, what a plugin may import); `packages/chord/package.json` (`exports`, the `source`
condition); Node's `module.enableCompileCache`.

## Decisions

**Built on these recommendations (owner's answer pending, 2026-11-16):**

- **A.** The package is `@earendil-works/p3`, its command `p3`, its version `apps/p3/package.json`'s (0.0.1),
  `"private": true` until publishing is decided.
- **B.** (Superseded by the second part's section 1: the shipped manifest is the workspace package's own.) The
  shipped `package.json` is generated into the package directory by the build. The workspace package stays
  `@p3/app`, private; no `package.json` of a package and no lockfile changed (the root `package.json` gained the
  script `release:p3:local`). esbuild is pinned to the version the repository runs (0.28.2).
- **C.** `ws` is inlined into the bundle. (Its second half, "esbuild is the only package installed beside p3", is
  superseded: the second part installs Chord, pi-schema and pi-telemetry for the types, and review round 2 made `ws`
  a dependency, at Chord's version 8.21.0, owner's decision, for the compiled `/v1/server` outside the server.)
- **D.** Minified (`minifySyntax`, `minifyWhitespace`, names kept), no source maps.
- **E.** The release test is not in `npm test`; `release:p3:local` runs it (`npm run test:release` with `P3_RELEASE`).

Not open, following the task: plugins ship as source; worker bases are bundled at start; esbuild is a run-time
dependency; no lifecycle scripts run at install (`--ignore-scripts`; esbuild works without its postinstall check).

## Second part: the API's name, and types for third-party plugins (owner, 2026-11-16; built)

### 1. The API is `@earendil-works/p3/v1`

No shorthand: plugins import `@earendil-works/p3/v1`, `/v1/server`, `/v1/worker`. The workspace package
`apps/p3/package.json` is renamed from `@p3/app` to `@earendil-works/p3`; every import (base code, the sessions
plugin, tests, the bench, the test plugins written as text), the module map `API` in `src/app.ts`, and the docs
change with it.

**The shipped manifest is the workspace package's own** (decided here; it replaces decision B's generated one). The
reason for a generated manifest was a second name and an untouched lockfile; both are gone. One `package.json` then
says the same in development and in the release, as Chord's and coding-agent's do:

```json
{
	"name": "@earendil-works/p3",
	"version": "0.0.1",
	"private": true,
	"type": "module",
	"bin": { "p3": "dist/p3.js" },
	"exports": {
		"./v1": { "source": "./src/api/v1/index.ts", "types": "./dist/api/v1/index.d.ts", "import": "./dist/api/v1/index.js" },
		"./v1/server": { "source": "./src/api/v1/server.ts", "types": "./dist/api/v1/server.d.ts", "import": "./dist/api/v1/server.js" },
		"./v1/worker": { "source": "./src/api/v1/worker.ts", "types": "./dist/api/v1/worker.d.ts", "import": "./dist/api/v1/worker.js" }
	},
	"files": ["dist", "plugins", "!plugins/**/*.test.ts", "src/api", "src/kit/forward.ts", "src/kit/contribute.ts", "src/kit/info.ts", "src/principals.ts", "README.md"],
	"engines": { "node": ">=24.4.0" },
	"dependencies": {
		"@earendil-works/chord": "1.5.2", "@earendil-works/pi-schema": "1.5.2", "@earendil-works/pi-telemetry": "1.5.2",
		"esbuild": "0.28.2"
	}
}
```

- `source` is what the checkout resolves (`--conditions=source`, as today); `types` and `import` are what an install
  resolves.
- The build writes into `apps/p3/dist/` (ignored by git) and `npm pack` runs in `apps/p3`; the staging directory and
  the generated manifest go.
- **The lockfile changes:** the workspace's entry is renamed and gains esbuild as a dependency (0.28.2, the version
  the lockfile has). Refreshed with `npm install --package-lock-only --ignore-scripts`; the diff goes to the owner,
  who allows it at commit time (`PI_ALLOW_LOCKFILE_CHANGE=1`).

### 2. The release ships types

What a third-party plugin's `tsc` resolves in an install:

```text
node_modules/@earendil-works/p3/
  dist/api/v1/index.js, .d.ts, .d.ts.map      the API modules, compiled by tsc: their imports of Chord stay imports
  dist/api/v1/server.*, worker.*              (`from "@earendil-works/chord"`), resolved from the dependency
  dist/kit/forward.*, contribute.*, info.*    what the API modules import of the kit
  dist/principals.*
  src/api/v1/*.ts, src/kit/{forward,contribute,info}.ts, src/principals.ts
                                              the API's source: the declaration maps point here, so "go to
                                              definition" lands in real code
  dist/main.js, worker.js, chunks/, p3.js     the server, bundled with Chord inlined, as in the first part
node_modules/@earendil-works/chord/           1.5.2, with its own .d.ts: the types the API's declarations import
node_modules/@earendil-works/pi-schema/, pi-telemetry/
```

- **The API is compiled by `tsc -p tsconfig.build.json`** (as coding-agent's and Chord's builds: `declaration`,
  `declarationMap`, `rootDir: src`, `outDir: dist`), over the three API modules and what they import. It compiles
  against the dependencies' built declarations (`packages/chord/dist`, without the condition `source`), so the
  emitted declarations name Chord's types as an install does: `import("@earendil-works/chord").Contract<…>`.
  Checked: this emits today's API without an error.
- **Two instances, one version.** The server process passes plugins its own API modules, the ones in its bundle
  (Chord inlined, for the start time). The compiled modules in `dist/api/` are for type-checking and for code that
  runs outside the server (a plugin's own tests). Both are built from the same commit; a test compares the bundle's
  Chord version with the dependency's.
- **The local release packs four packages:** p3 and, from the workspace, Chord, pi-schema and pi-telemetry (built
  with their `npm run build`), and installs p3's tarball with the other three as overrides, as `release:local`
  wires its consumers. npm's 1.5.2 of Chord predates what p3 uses (named queries, admission, `memberNames`), so the
  real dependency exists only once the next lockstep version is published; that is a publishing matter (Carried).

### 3. TS2883, and its cause

p3's `tsconfig.json` sets `declaration: false`, because with declarations on, six exported contracts fail:

```text
plugins/sessions/contract.ts(61,14): error TS2883: The inferred type of 'Sessions' cannot be named without a
reference to 'Method' from '../../../../node_modules/@earendil-works/chord/src/contracts/schema.ts'.
```

The cause is not the workspace symlink. Chord declares the types `Method` (what `method(...)` returns) and
`LiteralsSchema` (what `oneOf(...)` returns) in `src/contracts/schema.ts` and exports neither from its entry point.
A contract's type is inferred and contains them, so TypeScript cannot write that type down by any import a consumer
could use. A third-party plugin that emits declarations would hit the same error in an install (not yet tried
there; the acceptance test turns declarations on to see it); today's API modules pass only because none of them
declares a method.

**The fix is in Chord: export the two types** from `src/contracts/index.ts` (types only; its test: a contract with a
method, a `oneOf` param and every other member kind emits its declaration; README, CHANGELOG). Then `declaration:
false` goes from p3's `tsconfig.json` and `npm run check` checks that every exported contract can be named.
**This is a Chord change: decision F below.** No type is weakened, and no contract gets a hand-written annotation.

### 4. The acceptance test (in the release test, run by `release:p3:local`)

A plugin written by the test into a directory under `/tmp`, with a `package.json` and a `node_modules` that holds
only an `npm install --ignore-scripts` of the local tarballs:

```text
/tmp/…/hello/
  package.json          { "name": "@someone/hello", "private": true, "type": "module" }
  tsconfig.json         strict, module and moduleResolution NodeNext, declaration (so TS2883 would show), noEmit,
                        skipLibCheck, types: []
  contract.ts           export const Hello = remote("hello.greeting", { … hostAddress: () => Server(),
                        variants: { anyone: { state: { text: str() }, methods: { greet: method(str(), str()) } } } })
  server.ts             export default defineFacet((host) => host.serve(Hello, …))
```

1. `tsc --noEmit -p .` passes (the repository's TypeScript runs it; the project resolves only its own
   `node_modules`).
2. The same plugin with one member of the wrong type (`text: constant(1)` for a `str()` member) fails `tsc`, with
   the error at that member.
3. "Go to definition" has a target: the declaration map of `dist/api/v1/index.d.ts` names
   `src/api/v1/index.ts`, and that file is in the install.
4. The plugin copied into the installed server's plugin root (`node_modules/@earendil-works/p3/plugins/hello/`)
   loads: the launched release serves `Hello` to a client, which reads `text` and calls `greet`.

Node's own types are not p3's to ship: a plugin that uses Node APIs depends on `@types/node` itself, as with any
package; the test's plugin uses none (`types: []`).

### 5. Decisions of the second part

- **F (owner, 2026-11-16: yes), a Chord change:** Chord exports the types `Method` and `LiteralsSchema` (section 3),
  with its test, README line and CHANGELOG entry; p3's `tsconfig.json` turns declarations on.
- **G (owner, 2026-11-16: yes):** the built-in plugin's package is `@earendil-works/p3-sessions`.
- **The lockfile change** is allowed (owner, 2026-11-16); the diff is shown before the commit.
- Decided here, as asked: the shipped manifest is the workspace package's own (section 1).

## Third part: commands, the background server, several Pis (owner, 2026-11-16; built)

The basics of running a Pi, so that we can iterate on the rest.

### 1. Commands

```text
p3 [--pi <name> | --dir <path>]            start the Pi's server in the background unless it runs; print its port and
                                           a fresh owner link (the terminal client replaces this in slice 27)
p3 server  [--pi … | --dir …] [--port <n>] run the server in the foreground (what `bin.ts` does today)
p3 status  [--pi … | --dir …]              running or not; its port, pid, data directory, version, start time
p3 stop    [--pi … | --dir …]              stop it cleanly; returns once the data directory's lock is free
p3 restart [--pi … | --dir …]              stop, then start in the background
p3 list                                    the default Pi and the named ones, each with its state
p3 --version, p3 --help
```

- Exit codes: 0; 1 for a failure (`status`: not running; `stop`: nothing to stop is 0); 2 for a wrong command line.
- **A busy port fails the start at once** (review round 1, Astra): `p3: port 8789 is in use; pass --port <n> or stop
  what uses it`, exit 1, nothing left behind (the lock released, no `server.json`). **A blank or non-numeric
  `--port` is a usage error** (today `--port ""` reads as 0, a free port).
- **A fresh owner link from a running server:** the owner link is single use and lives in the server's memory, so
  plain `p3` asks the server for a new one: `POST /_p3/owner/link`, signed in with the owner token file, answers a
  new token (the previous link is dropped, as at a start). This is p2's `npm run owner-link`.

### 2. The background server is the supervisor

`overview.md` plans `supervisor.ts`: the `p3` command that restarts the server on request or after a crash. Plain
`p3` (and `restart`) starts it detached: `src/supervisor.ts` runs `p3 server` as its child, appends the child's output
to `<dataDir>/logs/server.log`, and

- restarts the child after a crash (an exit that is not 0: a signal, an uncaught error), after 1 s, doubling to 30 s,
  reset once a child ran for a minute;
- exits when the child exits 0 (a stop).

`stop` sends `SIGTERM` to the server (the pid in `server.json`), which closes as today and exits 0, so its supervisor
ends too; a foreground `p3 server` stops the same way. A restart "on request" from the page (the restart mark) is
slice 2's: it will be an exit code the supervisor restarts on.

### 3. `server.json`

Written into the data directory by the kit after the listen, removed at a clean exit:

```json
{ "pi": "7f3a…", "pid": 41234, "port": 8789, "version": "0.0.1", "startedAt": 1794900000000 }
```

A crashed server leaves it behind, so nobody trusts the file alone. `status` (and everything that asks "does it
run": plain `p3`, `stop`, `list`) believes it only while **the data directory's lock is held** (the command tries to
take `p3-server:<dataDir>` for a moment: if it gets the lock, no server runs; it releases it and deletes the stale
file) **and the process exists** (`kill(pid, 0)`).

### 4. Several Pis on one machine

- **A Pi is its data directory.** `p3` uses `~/.pi/p3`; `--pi <name>` (lower case letters, digits, `-`, `_`, at most
  32) uses `~/.pi/p3/pis/<name>`; `--dir <path>` uses any directory. `p3 list` shows the default Pi and every
  directory under `pis/`.
- **Each Pi has a config,** `pi.json` in its data directory, made at its first start: `{ "id": "<random>", "port": n
  }`. The default Pi's port is 8789; any other Pi takes a free port at its first start and keeps it. `--port` is for
  that start only.
- **The sign-in cookie is named after the Pi** (`p3-<id>`): a browser shares cookies between the ports of one host,
  so with one name the second Pi's sign-in would replace the first's.
- **Locks cannot collide across data directories, checked:** p3's lock names contain the data directory's real path
  (`p3-server:<dataDir>`, `p3-worker:<dataDir>:<address>`), and Chord's `processLock` hashes the whole name (SHA-256,
  128 bits of it) into the abstract socket's name (`packages/chord/src/node/workers/lock.ts`). Two data directories
  are two names. **No Chord change.**
- Everything else is per data directory already: the store, the cookie secret, the owner token file, the workers'
  directories, the worker base and the compile cache.

### 5. Files

```text
apps/p3/
  bin.ts                     the command line: which command, which Pi, the flags; dispatch
  src/pi.ts                  a Pi: its data directory from --pi or --dir, its config (id, port), the named Pis
  src/commands.ts            status, stop, restart, the background start, list, the fresh owner link
  src/supervisor.ts          the background server: runs `p3 server` as a child, restarts it after a crash
  src/kit/running.ts         server.json: written after the listen, removed at exit; whether a server runs (the
                             file, the lock, the process)
  src/kit/owner.ts           + POST /_p3/owner/link (the owner's: a fresh link)
  src/kit/sign-ins.ts        the cookie's name comes from the Pi's id
  src/kit/start-server.ts    reads the Pi's config, writes server.json; a busy port is a clear error
  src/kit/layout.ts          + pi.json, server.json, logs/
```

### 6. Tests (all against launched commands; in `npm test` from source, a subset again in the release test)

1. `status` of a Pi that never ran: not running, exit 1. `server` in the foreground: `status` shows its port, pid,
   data directory, version and start time; after `SIGTERM`, `server.json` is gone and `status` says not running.
2. Plain `p3` starts the server in the background and prints its port and an owner link that signs in once; a
   second `p3` starts nothing (the same pid) and prints another link that works, while the first no longer does.
3. `stop` returns only when the lock is free (a `server` started right after it does not wait); `stop` of a stopped
   Pi is 0; `restart` gives a new pid on the same port, the sessions kept.
4. **A crash:** `SIGKILL` of the server under a supervisor: `status` meanwhile says not running and removes the stale
   file (no lock holder); the supervisor starts a new server (a new pid, the same port, the sessions kept). `stop`
   then ends the server and the supervisor.
5. **A stale `server.json`** whose pid exists but is another process (the file copied from a running Pi): not
   trusted, because the lock is free.
6. **A busy port:** exit 1 with the message, within a second, no `server.json`, the lock free. `--port ""` and
   `--port x`: exit 2.
7. **Two Pis side by side** (`--pi a`, `--pi b`, `HOME` pointed at a temporary directory): different ports and ids;
   a session created in one is not in the other; a browser's cookie jar signed in to both (two cookies of different
   names on `127.0.0.1`) is the owner at both; `stop` of one leaves the other serving, its workers running; `list`
   shows both states. A named Pi keeps its port across restarts.
8. `--pi` with a name that is none, and `--pi` with `--dir`: exit 2.

Mutation check for the rules of this part (the lock check of `status`, the cookie's name, the supervisor's restart
and its exit on a clean stop, the kept port).

## As built

The process entries (`bin.ts`, `server.ts`, `worker.ts`, `supervisor.ts`) live in `src/bootstrap/` (decision "Base
entries live in `src/bootstrap/`", 2026-11-18); `apps/p3/`'s root holds no `.ts` file. The names below without a
directory are theirs; the release's files (`dist/main.js`, `worker.js`, `supervisor.js`, `p3.js`) keep their names.

### What ships

```text
@earendil-works/p3/                     apps/p3/package.json, as it is in the workspace (private until publishing)
  package.json                          bin { p3: dist/p3.js }; exports ./v1, ./v1/server, ./v1/worker (source, types,
                                        import); dependencies: Chord, pi-schema, pi-telemetry, esbuild, ws (exact)
  dist/p3.js                            the launcher: the compile cache, the experimental-warning filter, main.js
  dist/main.js                          the command (src/bootstrap/bin.ts) and the server: kit, Chord, pi-schema, pi-telemetry, ws inlined
  dist/worker.js                        a session worker's entry: a bundle of its own, none of the server's code
  dist/supervisor.js                    the background server's supervisor: a bundle of its own
  dist/api/v1/*.{js,d.ts,d.ts.map}      the API compiled by tsc, importing Chord from the dependency
  dist/kit/{forward,contribute,info}.*, dist/principals.*      what the API imports of the kit
  src/api/v1/*.ts, src/kit/{forward,contribute,info}.ts, src/principals.ts      the API's source (declaration maps)
  plugins/sessions/                     the built-in plugin as source, its tests left out
  README.md
```

How p3 runs from it:

- **The server** loads `dist/main.js`: JavaScript only, compiled once and then read from Node's compile cache. Its Chord is the one in the bundle; the installed Chord is for the types and for code that runs
  outside the server (a plugin's own tests import the compiled API).
- **Plugins** are built at start by Chord's plugins component, as from source: esbuild bundles each facet;
  `@earendil-works/p3/v1` and its per-kind modules are host packages (left out of the plugin's bundle, the process
  passes its own instances). That is why esbuild is a run-time dependency.
- **The worker base** is built at start by Chord's workers component from `dist/worker.js` (it bundles the entry
  again, see "What a start builds"); workers get `--disable-warning=ExperimentalWarning`,
  no `--conditions=source`.
- **Base code asks `src/install.ts`** for p3's own files (the plugins root, the entries of the worker, the command and
  the supervisor with their Node flags, the version from the installed `package.json`); in both layouts its own
  directory lies under p3's root, and the build checks that it stays in `dist/main.js`.

### How it is built and tested

- **`scripts/build-release.ts`** (`npm run build` in `apps/p3`): checks that every dependency is pinned to the
  workspace's version; one esbuild build per process (`src/bootstrap/bin.ts`, `worker.ts`, `supervisor.ts`, in
  parallel, no shared chunk), with the condition `source`, minified with names kept, no source maps; the externals check (Node
  builtins, esbuild, `ws`'s two optional accelerators), the placement check of `src/install.ts` (in `main.js` and
  nowhere else) and the lean check of the worker's and the supervisor's bundles (`checkLean`: no import of esbuild or
  Node's HTTP, no `ws`, none of Chord's HTTP component, the server side of its workers or its plugin builds); the
  launcher; then `tsc -p tsconfig.build.json` for the API. `scripts/` is TypeScript, run by Node, so `npm run check` covers it.
- **`scripts/release-local.ts`** (`npm run release:p3:local -- --out <dir> [--force] [--skip-test] [--bench]` from the
  repository root): the output directory checked (below), Chord, pi-schema and pi-telemetry built, p3 built, the four
  packed with `--ignore-scripts`, p3's tarball installed into a private consumer with the three as `overrides`, a link
  `<out>/p3`, then `npm run test:release` with `P3_RELEASE`, and with `--bench` the bench.
- **Tests** in three places: `npm test` (the build and its guards on a temporary directory, the output directory,
  the launched server from source, the command's cases from source, the kit's records, config and Pis, besides slice
  1's); the release test (`test/release/release.test.ts`, decision E: the install's contents and files, `--version`
  and `--help`, the warnings, the end-to-end case outside the repository, `SIGTERM` with a worker, every command case
  again, and the third-party plugin); the end-to-end case is one function (`test/end-to-end.ts`) run in process,
  launched from source and launched from the install. Launched processes are driven by `test/launched.ts`; a preload,
  `test/gate.ts`, holds a launched server at a point of its start for the cases of what commands do meanwhile.
- **Start timings** are printed with `NODE_DEBUG=p3` (Node's `util.debuglog`), for the bench, until slice 2's
  startup spans replace them. The bench (`bench/slice-1.ts`, `--release <install>` for the release) launches the
  server as a process in both paths and runs the commands on a named Pi; the in-process breakdown of the list runs only
  from source.

### Review round 1's findings, fixed

The first part needed no Chord change: the plugins component builds plugins from a root under `node_modules`, the
workers component takes `dist/worker.js` as its entry.

- **`--force` (Sol, Astra: blocking; Fable).** `prepareOutput` in `release-local.ts` refuses, before it removes
  anything, the repository, every directory above it (a file system's root among them) and every directory inside it,
  by path segments (not `startsWith("..")`: `pi/..p3-release` is inside) and by real paths (the part of `--out` that
  exists is resolved through links, so a link to the repository's parent is refused too). It writes a marker file,
  `.p3-release`, into its output; a directory that is not empty and has no marker is never touched, and `--force`
  removes only what a run makes there (`.p3-release`, `tarballs/`, `install/`, `p3`); without `--force` a previous
  release is refused. This is stricter than `scripts/package-artifacts.mjs` (which removes the whole directory with
  `--force` and allows `.artifacts/` inside the repository): p3's release must be outside the repository, and nothing
  the script did not make is removed. `test/release-local.test.ts`, 4 tests, with the reviewers' paths.
- **The launcher's warning filter (Sol, Astra).** It no longer replaces Node's printer: it wraps
  `process.emitWarning` and drops only warnings of type `ExperimentalWarning`; every other one goes Node's way (the
  listeners others added stay, `--no-warnings`, `--redirect-warnings` and the warning codes work). The release test
  preloads a listener and emits an ordinary warning, a deprecation and two experimental ones after the launcher ran,
  plain, with `--no-warnings` and with `--redirect-warnings`.
- **A busy port (Astra).** Chord's HTTP component tries a failed listen again, for as long as it takes. `startServer`
  races the listen against the listener's first activation failure during the start, which rejects the start with
  `ListenFailed` (the system's code), everything closed (the lock released, no `server.json`). `p3 server` prints
  `p3: port 8789 is in use; pass --port <n> or stop what uses it` and exits 1, within a second; plain `p3` prints the
  same, read from the log, because the supervisor ends with a server that never listened. `--port` takes digits only,
  at most 65535: a blank, ` `, `x`, `-1`, `1.5` and a missing value are usage errors (exit 2).
- **Every wait is bounded (Opus S1, Fable S3).** `launch` rejects after 20 s without an owner link (the process
  killed), `run` kills a command after 60 s, every case has a timeout, `eventually` has a bound; the commands bound
  theirs (`stop` 30 s, a background start 30 s, the owner link request 10 s). Opus's two hanging mutations (`--version`
  starting a server, the source layout read as built) now fail. The test scripts pass `--test-force-exit`, and a case
  that fails half way kills the servers it launched (`t.after`) and closes the socket it holds: before that, one failed
  case kept the runner alive for ever (found by this mutation check).
- **The build's guards are tested (Opus S2):** `checkExternals` and `checkPlacement` with small metafiles (a
  forbidden external named; `src/install.ts` in a chunk, in two outputs, in none, in a file that only ends the same),
  and `checkVersions` (below).
- **The release's `SIGTERM` case starts a worker (Opus S3, Fable)** and checks that the server and the worker are
  gone, then starts again at once.
- **The version (Fable S2)** is read from the installed `package.json` (`src/install.ts`), and the release test
  compares `p3 --version` with the installed manifest.
- **Nits:** a failed start prints one line and exits 1 (no stack); a failed close exits 1; the help text takes the
  default port from `DEFAULT_PORT`; two positional arguments are a usage error (tested).

### Review round 2's findings, fixed

- **The server's record is written in two steps (Sol, Astra).** The moment the server holds the data directory's
  lock, before anything else, `server.json` says `{ state: "starting", pid, start }`; once it listens and its owner
  link knows the address, `{ state: "running", pid, start, pi, port, version, startedAt }`. Before, the record came only
  after the listen and before the owner link was ready: plain `p3` could read it and get a 500 for the link (Sol). A
  failed start removes the record with the lock. The supervisor's record (`starting`, then `running` once its server
  listened) is also written right after its lock.
- **A record names the process that wrote it (Astra).** Each record holds its writer's pid and the start time of that
  process (`processStart`: field 22 of `/proc/<pid>/stat` on Linux and Android, `ps -o lstart=` elsewhere), and
  `holder` believes it only while the role's lock is held and the pid's process has that start time. What `holder`
  answers is a tagged value: `free` (nobody holds the lock; a record left is removed), `unnamed` (the lock is held and
  its holder has not said who it is: no record yet, or a crashed server's record whose pid is another process now) or
  `named` with the record. Before, a crashed server's record naming a pid the system had given to an unrelated process
  was believed while a new server started, and `stop` sent that process `SIGTERM`.
- **`stop` waits for a start (Sol, Astra).** It polls (25 ms, at most 30 s) until both locks are free, and signals
  only a process that runs: the supervisor once its record says its server ran, else a server whose record says
  `running`; never a server that starts (a start cut off by a signal ends without its close), nor its supervisor
  meanwhile. Before, a held lock without a record read as "not running", exit 0, and the server went on to run.
- **Plain `p3` waits for `running`**, also from a server in the foreground that starts (it stops waiting only when its
  own supervisor left and nobody holds either lock). `status` says `starting` while a server holds the lock and
  `starting (pid …)` once its record names it; `list` says `starting`.
- **`ws` is a dependency (Sol; owner's decision: pinned to Chord's version, 8.21.0).** The compiled
  `@earendil-works/p3/v1/server` re-exports `Http` from `@earendil-works/chord/http`, whose module loads Chord's HTTP
  component and `ws`, an optional peer of Chord's: the package that imports it supplies it, as p2 does. The bundle
  keeps its own inlined copy (decision C). The lockfile gains that one line (refreshed with npm 11.20, the version
  that wrote it: npm 11.4.2 would also drop the `libc` fields of 30 entries). The release test imports the three API
  modules at run time from outside the repository and checks their exports.
- **A signal during the start closes the server once it started** (found by the new cases: `stop` signalled a server
  whose record said `running` before `bin.ts` had installed its handlers, and Node's default action ended it without
  its close, `server.json` left behind). `p3 server` installs its `SIGINT` and `SIGTERM` handlers before the start.
- **The reviewers' reproductions are tests**, in every command case run from source and from the release: a server
  held at its lock and at its plugins (`status`, `list`, `stop` and plain `p3` while it starts), a crashed server's
  record naming a live unrelated process (never signalled), and a server held right after its record says `running`
  (the link plain `p3` prints signs in), a supervisor restarting its server after a crash (`stop` waits for that
  server), a signal during the start. The preload `test/gate.ts` holds the launched server there. Sol's two scripts
  pass against the new release as they are; Astra's `start-races.test.mts` now fails on purpose: it asserts the old
  behaviour on the way (`status` showing the stale pid, `stop` back within a second while the server starts). Two assertions
  that a process was gone right after `stop` returned now wait for it: `stop` promises free locks, and a process
  exits right after it released its lock.

### Review round 3's findings, fixed

- **Plain `p3` starts a supervisor only where nobody holds the directory** (Sol: two cases still expected the extra
  supervisor of round 2). A server or a supervisor that starts, or restarts after a crash, holds a lock already; its
  server is the one to wait for, and a supervisor of the command's own would only boot to find the directory taken.
  The two cases now check that the command still waits two seconds later and that no supervisor process is there.
  Chosen because it takes a process and a lock race out of the common path, and the cases need no wait on another
  process's lifetime (the old waits failed under load, below).
- **An unknown identity is never a match** (Astra, blocking). A record without `start`, or a process whose start
  cannot be learnt, is `unnamed`: nothing is read from it and nothing is signalled. A writer that cannot learn its
  own start writes its record without one (it still says what the holder does). Before, two unknowns compared equal
  and `stop` signalled a process whose pid a crashed server's record named.
- **`ps` is asked in one time zone and language** (`TZ=UTC`, `LC_ALL=C`; Astra): `lstart` follows the caller's time
  zone, so a command in another one did not know its own server. On Linux and Android the start is
  `/proc/<pid>/stat`'s, as before; on Windows (no `ps`) identity stays unknown, and the commands find no running server
  there (their records name nobody).
- **`p3 stop` asks the server over HTTP first** (owner's decision): `POST /_p3/stop` (`src/kit/stop.ts`), the owner's
  only (401 without a sign-in, 403 for anyone else), answered `"stopping"`, then the server closes as on `SIGTERM`
  (`startServer`'s `onStop`, which `bin.ts` gives its close) and exits 0, and its supervisor ends with it. `stop` asks
  each server that listens, once; a server that does not answer within 10 s is signalled, as is a supervisor while no
  server listens (between restarts), and only when its record proves who it is; a supervisor whose server answered is
  not signalled. While a server or a supervisor starts, `stop` waits as before. A refusal is an error (exit 1).
- **The command ends a supervisor of its own that lost the directory** (found by these runs: two `p3` at once, then
  `stop`; the loser waited a second for its lock, took it once the winner had stopped, and started the Pi again, so
  `stop` waited 30 s and failed). The command that started a supervisor which did not win (another supervisor's
  server, or a foreground server, is the one that listens) ends it (`SIGTERM` to its own child, no record needed)
  before it returns. Its first version waited for that child's exit with the child `unref`'d, and the command ended
  on an empty event loop (exit 13): the wait now counts the child again. A second guard, the supervisor leaving at
  once when another supervisor's record names the lock's holder, was built and removed again: with the command's end
  no test could tell it from none.
- **The tests no longer need port 8789 free** (found under load: the default Pi's case started on the default Pi's
  own port, so it failed whenever another run, or a real Pi, had it). It starts with `--port 0`.
- **Under load.** Before these fixes, 4 suites at once, three times: 11 of 12 runs failed (the waits on the extra
  supervisor's lifetime, port 8789). After them: 12 of 12 pass, and 10 serial runs pass.
- **Regression tests:** the stop route (`test/kit/stop.test.ts`); unknown identities, both ways, a command name with
  spaces and parentheses, and two callers in three time zones (`running.test.ts`); Astra's in-process `stop` with no
  `ps` and a reused pid (`commands.test.ts`); `p3 stop` with the command's signals taken away (`test/no-signals.ts`),
  for a server in the foreground and one under a supervisor held before it lets its lock go (waited for, not
  signalled); two `p3` at once with the first one's supervisor held before its lock (the first command ends it), then
  `stop`; `stop` between a crash and the restart with the supervisor held still, which must find a `SIGTERM` pending
  and start no server again; the cases where plain `p3` waits check, every 25 ms for two seconds, that no supervisor
  runs. The gate (`test/gate.ts`) holds a supervisor too: before its lock, and before it lets its lock go. Astra's
  two scripts pass as they are.

### After review round 3: the server proves who it is; Windows (owner's decisions)

- **A run id and a proof.** A server makes a random run id at each start (16 bytes, hex) and writes it into its
  record from the `starting` step on. `GET /_p3/identity?nonce=<32 hex digits>` (`src/kit/identity.ts`) answers
  anyone `{ run, pid, pi, proof }`, `proof` being HMAC-SHA256 of the nonce keyed by the owner token (owner's choice
  B: proof of possession). A command believes a `running` record only once the server on the record's port answers
  that record's run id and pid and the proof for a fresh nonce of the command's own; the question carries no token,
  and the owner token goes (owner link, stop) only to a server proven so. `holder` calls such a record `claimed`; the
  commands' `running` asks (2 s at most) and makes it `named` or `unnamed`, in `status`, plain `p3`, `stop` and
  `list` alike. What it protects against: another OS user, whose program holds the port a crashed server's record
  names and echoes its run id (anyone can learn it from the real server); without the token it cannot answer the
  proof. The owner's own processes can read the token file anyway.
- **Start times only for what does not listen** (a starting server, a supervisor). On Windows they come from
  PowerShell (`(Get-Process -Id N).StartTime.ToUniversalTime().ToString('o')`), an unknown one names nobody; a
  record's pid must be a positive integer (it goes into PowerShell's command line, and a signal).
- **Windows, in slice 26:** the supervisor and the server are spawned with `windowsHide` (no console window for a
  detached process). `stop` needs no signal for a server that listens (HTTP). On Windows a signal is
  `TerminateProcess`: the fallbacks (a supervisor between restarts, a server that does not answer, a command ending
  its losing supervisor) end the process at once, without its close.
- **Not run on Windows** (no machine here); the Windows branches were run on Linux by selecting them: PowerShell's
  branch with a `powershell.exe` of the test's own on the `PATH` (its arguments checked, its answer, its failure, its
  absence). Carried below.
- **Tests:** the identity route (`test/kit/identity.test.ts`: the answer and its proof, 400 for a nonce that is none, a
  fresh run id at each start, proofs replayed from another nonce or made with another token refused); a command case
  with programs of the test's own on the recorded port: one that echoes the run id without a proof, with a wrong
  proof, with a proof replayed for another nonce, one with the token but another pid (all refused, none ever got a
  token), one with the right proof (believed, the control), a new server of another Pi on the port, and this Pi's own
  server under a record naming an earlier run (both refused), and `stop` meanwhile, which signals and stops nothing
  it did not prove; `holder` for a running record and for pids that are none; PowerShell's branch.

### The second part, against its specification

- **The rename.** `apps/p3/package.json` is `@earendil-works/p3` and is the shipped manifest, as section 1 shows it
  (`bin`, `exports` with `source`, `types` and `import`, `files`, the four dependencies pinned); the sessions plugin is
  `@earendil-works/p3-sessions`. Every import, the module map `API` in `src/app.ts` and the docs changed with it
  (slice 1's walkthrough is left as it was, the record of slice 1). The staging directory and the generated manifest
  are gone: the build writes `apps/p3/dist/` (ignored by git) and `npm pack` runs in `apps/p3`.
- **The lockfile:** the workspace's entry renamed, with esbuild 0.28.2 as its dependency and its `bin`; the link
  `node_modules/@earendil-works/p3` instead of `node_modules/@p3/app`. Nothing else.
- **The API's compile.** `tsc -p tsconfig.build.json` (declarations and declaration maps from `tsconfig.base.json`,
  no source maps) over `src/api/v1/*.ts`, which brings in `src/kit/{forward,contribute,info}.ts` and
  `src/principals.ts`. It compiles against the workspace's sources (`customConditions: ["source"]`), not against
  `packages/chord/dist` as section 2 planned: the emitted declarations name Chord through the package all the same
  (`import("@earendil-works/chord").Contract<…>`), and the build needs no Chord build first. The build test checks
  that no declaration names a path into `node_modules` or `packages/chord`.
- **One version, checked (`checkVersions`):** the build fails unless every dependency in p3's `package.json` is pinned
  to the version the workspace has, because the bundle inlines the workspace's Chord while a plugin's types come from
  the dependency. The release test checks that the install has those versions, each a real directory in the install.
- **The local release** builds Chord, pi-schema and pi-telemetry with their `npm run build`, packs the four packages
  and installs p3's tarball into a private consumer, the three as `overrides` pointing at their tarballs.
- **Chord (decision F)** exports `Method`, `LiteralsSchema`, and also `HostKeyed` (a keyed member with a host kind:
  found by Chord's test, which emits the declaration of contracts with every member kind and checks that it names no
  path into `node_modules`). README and CHANGELOG say so. p3's `tsconfig.json` no longer sets `declaration: false`
  (the base's `true` applies), so `npm run check` fails with TS2883 for any exported contract whose type cannot be
  named.
- **The acceptance test** is as section 4 plans, with two differences. The plugin's `node_modules` is a link to the
  install's (the install is the plugin author's `npm install`). A member of the wrong type fails `tsc` with TS2769 at
  the `host.serve(...)` call, not at the member: `serve` is overloaded, so TypeScript reports the factory that fits no
  overload at the call (a method answering the wrong type is checked the same way). The emitted declaration of the
  plugin's contract names `Method` and `LiteralsSchema` through the release, and no `any`. The plugin, copied into the
  plugins root of a copy of the install, is served by the launched release to a client that runs on the compiled API
  modules (`dist/api/v1/index.js`), outside the server.

### The third part, against its specification

- **`supervisor.ts` is beside `bin.ts`, `server.ts` and `worker.ts`** (decision "Base entries are named after what they
  are"; at p3's root then, in `src/bootstrap/` since 2026-11-18), not in `src/` as planned; the build bundles it as
  `dist/supervisor.js`.
- **The supervisor has a lock and a record of its own** (`p3-supervisor:<dataDir>`, `supervisor.json`), as the server
  has (`p3-server:<dataDir>`, `server.json`): `stop` finds the supervisor also while no server runs (between a crash
  and the restart), two `p3` at once start one supervisor (the second cannot take the lock and exits, and its command
  waits for the first one's server), and `status` tells a supervisor's state while no server listens: `starting` (its
  first server has not listened yet) or, once it had, `restarting after a crash`. A record is believed only while its
  lock is held and its pid is still the process that wrote it (`src/kit/running.ts`, `holder`; review round 2); a
  record nobody holds the lock for is removed. `server.json` has the state `starting` before `running` (section 3
  planned one record, written after the listen).
- **The supervisor ends with a server that never listened** (the child tells it over its IPC channel): a busy port or
  another server on the directory is a failed start, not a crash to retry every 30 s. It exits with that exit code.
- **Plain `p3`** asks the server's record first; with none it starts a supervisor and waits for whichever server
  listens on the directory (its own supervisor's, or that of one already starting or restarting it). The supervised
  server prints no owner link into the log; the command asks the server for a fresh one.
- **`pi.json`** is `src/kit/config.ts`: `{ id, port }`, the id 16 hex digits (it becomes the cookie's name `p3-<id>`;
  the file is checked when read, a trust boundary). The Pi's port is written at its first start unless that start
  named one (`--port` is for one start only).
- **`p3 start`** is accepted as plain `p3`; `p3 list` shows the default Pi once it started (it has its config) and the
  named Pis.
- **Two races found by this slice's runs, fixed:** a second `p3` during the first one's start called the directory
  "restarting after a crash" and failed (a supervisor without a server was read as a crash; now its record's state
  says which); the busy-port case expected the next free port to differ from the closed one, which the system may
  give again (now it checks the Pi's config).
- **The tests run in the release too:** all sixteen command cases, not a subset.

### Tests and checks

- `npm test` (from `apps/p3`): 134 tests in about 12 s (the command's eighteen cases, `stop` without identities, the
  launched server, the build, the output directory, the Pi, who runs, the config, the owner's stop, the identity, the
  oldest Node, besides slice 1's): runs in a row and runs with four suites at once pass. The release tests
  (`release:p3:local`): 33 in about 91 s, the memory test's 80 s among them (the install's contents and files, the
  three API modules imported at run time, `--version` and `--help`, the warnings, the end-to-end case, `SIGTERM` with
  a worker and its V8 flags, every command case again, the third-party plugin's three, and the memory test); 30 of
  them (all but the memory test) also pass on Node 26.11.1. `npm run check` in `apps/p3` and at the root pass;
  Chord's whole suite passes (3,879 tests).
- **Mutation check** (`chord-practices.md`; a copy of `apps/p3` and `packages/chord` under `/tmp` with its own package
  links, every other package linked to the repository's; `/tmp/s26m-{setup,mutate}.py`): 80 rules undone one at a
  time, 89 runs, 18 of them through a rebuilt, repacked and reinstalled release, 5 through `tsc` or Chord's test; the
  whole list run on review round 3's code. 78 are caught by a failing test:
  - the output directory (7), the launcher (4), the `ws` banner, the busy port (2), a blank `--port`, `--version`
    starting a Pi, the layout read wrongly (both ways), `SIGTERM` (source and release), a signal during the start, the
    version, the build's three guards;
  - Chord's three exports, the declaration maps, the manifest (the API's source, `types`, `private`, plugin tests,
    `ws`), the API's name and its per-kind modules;
  - who runs (a record without its lock, a stale record kept, the start not compared (source and release), two
    unknown starts taken for a match, the start read from the wrong field, `ps` in the caller's time zone), the
    record's two steps (`running` before the owner link is ready, no `starting` at the lock, a record left by a
    failed start), `server.json` at close, the cookie's name, the config's id, the ports (kept, one start's kept,
    the default), Pi names, `--pi` with `--dir`;
  - the supervisor (no restart, a restart after a clean stop, retrying a start that never listened, running beside
    another, never saying its server runs, the owner link in its log);
  - plain `p3` (a supervisor beside a running server or a starting holder, its losing supervisor not ended, giving
    up on another supervisor's start or a starting foreground server, a starting server taken for a running one),
    `status` (a starting supervisor called crashed, a starting server called not running), `list` (its names, a
    starting Pi called stopped), the owner link route;
  - the owner's stop (served to anyone, not served, doing nothing in `bin.ts`) and `stop` (no HTTP ask, source and
    release; returning once the server answered; "not running" while a lock is held; signalling a server that
    answered, or the supervisor of one; no signal to a supervisor at all).
  - Two survive, and are equivalent: `stop` signalling a supervisor while its server starts (the server closes on a
    signal that came during its start, once started: the same end as waiting), and the stop route calling the stop
    before it answers (Chord's close drains the running request, so the answer still goes out). The waits and the
    answer-first order stay as the owner asked.
  - Review round 1's check found: a failed case kept the test runner alive for ever; two survivors that became tests;
    a test that wrongly passed outside a checkout named `pi`. Round 2's: three new rules no test caught at first (a
    command started and released at once never saw the held server; a failed start right after the lock; a
    supervisor restarting its server) and the signal during the start. Round 3's: the supervisor's fast exit, which
    no test could tell from none beside the command's end (removed), and that `stop` between a crash and the restart
    was the same with no signal at all (the case now holds the supervisor still and looks for the pending signal).
  - Untested: the supervisor's backoff beyond its first wait (1 s, doubling to 30 s, reset after a minute): a test
    would have to wait for it.
  - After review round 4 and the memory work: 21 more rules, 24 runs, every one caught but one equivalent (round 4's
    `stop` questions not clipped to its own deadline). The splitting rule (lazy imports inlined, a lazy chunk not
    checked); the worker's three V8 flags one by one (caught once the tests named the flags themselves instead of
    reading `WORKER_V8_FLAGS`, which a mutation shortens too), the compile cache not written after the start, Chord's
    base not minified, an old Node let through, versions compared as text, the memory test's limit never failing or
    set above 50, the settling without its earliest end or without asking for stability.
  - Not a mutation: `declaration: false` back in p3's `tsconfig.json` changes no outcome by itself; it only hides
    TS2883 when Chord misses an export, which the three Chord mutations show is caught with declarations on.

**Numbers after all three parts** (one run each, 2026-11-16, on slayer with a load average of about 10 on 32 cores;
the first part's table above holds three runs):

| | Source | Release |
| --- | --- | --- |
| process launch to listening, cold / warm | 485 / 156 ms | 128 / 111 ms |
| server plugins built at start; worker base after the listen | 27; 125 ms | 33; 88 ms |
| server `RssAnon`, alone | 74.5 MiB | 40.3 MiB |
| worker start, cold / warm | 235 / 92 ms | 146 / 82 ms |
| an idle worker's USS; ten idle workers' PSS | 35.0; 375 MiB | 28.1; 305 MiB |
| the list at 100,000: open, `more` | 0.62, 0.44 ms | 0.61, 0.44 ms |
| `p3`: a background start, to its owner link (median of 20) | 398 ms | 252 ms |
| `p3` again: the running server's fresh link | 161 ms | 90 ms |
| `p3 status` | 170 ms | 109 ms |
| `p3 stop`, until the directory is free | 197 ms | 133 ms |
| the supervisor's USS | 23.2 MiB | 16.3 MiB |

- The first part's numbers hold. A command's time is mostly Node's start and p3's code: `status` from the release is
  about 110 ms, of which the answer itself (two lock probes, a file) is a few milliseconds.
- **The install grew with the types:** p3's tarball is 279 kB (1.2 MB installed, `dist/` 1.1 MB with the compiled API),
  and Chord, pi-schema and pi-telemetry are now installed beside it for the declarations a plugin's `tsc` reads:
  15 MB, 1.2 MB and 0.3 MB (Chord's package ships its sources and declarations whole). The server loads none of them
  (its Chord is in the bundle). Shipping types without that cost would mean bundling the declarations into p3's
  package: not done, for the owner to decide if it matters.

### Review round 4's findings, fixed (Opus, Sol)

- **The owner token goes only over the connection the proof came over** (Sol P1, Opus 2). The command proved the
  server on one connection, then sent the owner token (the owner link, the stop) on a new one; a server that closes
  frees its port before its record and its lock go, and another user's program waiting for the port would get the
  token. Now `src/ask.ts` holds the commands' client: `ask` opens one TCP connection, has the server prove itself
  on it, then sends the owner's request on that same connection, kept alive (HTTP/1.1). If the connection closed
  meanwhile the request fails, and nothing is sent anywhere else. A connection established to the server cannot be
  taken over by another process. (The first version sent no `Host` header of `127.0.0.1:<port>`, and the server's
  check refused every request: the cases caught it.)
- **Every question has a deadline and a size** (Sol P2, Opus 3). `timeout` on Node's request was an inactivity timeout
  and the body had no bound, so a program that drips a byte a second held `status` and `stop` as long as it liked.
  Each request now has a timer for all of it (connecting, the headers, the body; the connection is destroyed when it
  fires) and an answer of at most 64 KiB. Each command passes its own deadline into its questions: `stop`'s 30 s
  hold across its identity checks, `status` and `list` take at most 5 s for each directory, plain `p3` its 30 s, the
  owner link 12 s more at most. A timer rather than an `AbortSignal`: a request on a socket the server had closed
  neither failed nor aborted in a probe, and only the timer ended it.
- **Not needed** (Opus): binding run, pid and port into the HMAC. While the server listens nobody else can hold the
  address the command dials, and once it no longer listens it cannot be asked for a proof.
- **Regression tests,** from source and from the release: a server that answers the proof, closes the connection,
  and gives its port to another program after the first or the second proof (plain `p3` fails, the program never
  sees a token); a program that drips a byte every 150 ms (`status` back within 10 s, `stop` returns once the lock
  goes) and one that pours an endless body (cut off after 64 KiB, less than 8 MiB written).
- **Mutation check:** 6 rules, 8 runs (2 through a rebuilt release): the token on a new connection after the proof,
  the owner's request without a proof first, no deadline for the whole answer, no cap, a closed connection used
  again (caught once the swap case also asks that the command fail within 8 s) are caught; one survives and is
  equivalent: `stop`'s questions not bounded by its own deadline, since each question has its own (2 s, 10 s), so
  `stop` overruns its 30 s by at most one question's.

### The worker-only entry (owner's decision, after review round 3)

The worker and the supervisor were bundled with the server in one esbuild call, so they imported the chunk they
shared with it: esbuild's JS API, `ws`, Node's HTTP and the server side of Chord's workers. Now each process has a
bundle of its own (`scripts/build-release.ts`; `checkLean` refuses a worker's or the supervisor's bundle that imports
or holds the server's code, the placement check still keeps `src/install.ts` in `main.js` alone). Measured on slayer,
2026-11-16, from the release, three runs of each alternately, both built from the same commit (the shared-chunk build
restored in a copy for the comparison); "settled" is after 40 s (V8's memory reducer has run by then):

| | One build, shared chunk | A bundle per process |
| --- | --- | --- |
| an idle worker's USS, settled (median of 10) | 23.7–24.1 MiB | 18.7–18.9 MiB |
| an idle worker's USS, after 1 s | 27.9–28.3 MiB | 22.6 MiB |
| worker start, warm (median of 10) | 82–83 ms | 69–71 ms |
| worker start, cold | 141–154 ms | 136–145 ms |
| the worker base (what a worker loads) | 1,106 KiB | 1,020 KiB |
| the supervisor's USS, settled | 16.5–20.2 MiB | 10.8–10.9 MiB |
| the server's USS, settled | 33.5–34.2 MiB | 34.2–34.8 MiB |
| process launch to listening, warm | 105–107 ms | 101–109 ms |
| the package: tarball; `dist/` installed | 280 kB; 1.1 MB | 486 kB; 1.9 MB |

- **−5 MiB per idle worker** (mem-audit measured −1.5 MiB with glibc's `mmap_threshold` tunable, which p3 does not set,
  and 23.1 → 18.7 without it: these runs agree with the second), **a warm start 12 ms faster**, the supervisor at
  11 MiB instead of 17–20. For 100 idle workers about 0.5 GiB less.
- The cost: the server's code is no longer shared with the worker's on disk, so the package carries Chord twice
  (`main.js` 1.0 MB, `worker.js` 0.8 MB). The server's own memory and launch do not move.
- The bench now reads memory settled too (`bench/slice-1.ts`: the workers and the server at 40 s, the supervisor at
  40 s), and the worker base's size.

### Session worker memory (owner's decisions, after review round 4)

**The levers,** built in p3's release and kit:
- **The worker-only entry with splitting** (above): each process's own build; what an entry imports lazily stays a
  chunk of its own (`bundleOptions`), loaded when asked for. `checkLean` checks the worker's lazy chunks too.
- **The provider SDKs bundled by p3's release build**, not loaded from `node_modules`: the build leaves nothing but
  esbuild and `ws`'s accelerators external (`checkExternals`), so a worker that imports pi-ai gets its SDKs inside
  its bundle, in lazy chunks per API.
- **Chord's worker base minified** (`packages/chord/src/node/workers/base.ts`: whitespace and syntax, names kept),
  with its test, a README line and a CHANGELOG line.
- **A warm compile cache:** `flushCompileCache()` once after a worker started (`src/kit/worker.ts`); Node writes it only
  at exit otherwise, and every later worker starts from it.
- **The worker's V8 flags** (`WORKER_V8_FLAGS` in `src/install.ts`, both layouts): `--liftoff-only`,
  `--optimize-for-size`, `--max-semi-space-size=4`, and since 2026-11-18 `--gc-memory-reducer-start-delay-ms=8000`
  (owner, from mem-audit's Node 26 measurements): Node 26's V8 starts its memory reducer 30 s after work, Node 24's
  after 8 s, so on Node 26 the garbage of a burst stayed in old space past the test's settled readings. 8000 is Node
  24's own default: the flag changes nothing there, and one list serves every Node (no choice by version; mem-audit
  thought the flag missing in Node 24, but `node --v8-options` of 24.4.1 lists it, and a worker starts with it).
  Background recompilation stays on.
- **`--managed-zone-memory`** (owner, 2026-11-18, after v8-flag-check: an ordinary V8 flag staged for shipping, v8
  commit 277d16f12e01, bug issues.chromium.org/409953791, a Chrome field trial for over a year, off by default even on
  V8's main branch): V8 pools its compilers' zone memory itself instead of taking it from malloc, so glibc keeps less
  freed memory, most after the five subagents. Node 24's V8 does not know it; while p3 still ran on Node 24 it was
  added from Node 26 on by Node's major version (`workerV8Flags`). Not taken:
  `--managed-zone-memory-for-isolate-independent-memory`, `--future`.
- **Node 26.3.1 or newer, everywhere** (decision "Node 26 or newer everywhere", 2026-11-18): from a checkout, in the
  tests and in a release. The five flags are one constant list; the Node 24 branch and its tests are gone. 26.3.1, the
  newest Node Termux offers on the owner's phone (Android is a target), is the oldest p3 accepts: checked on slayer with
  nodejs.org's 26.3.1 build (V8 14.6.202.34, as every Node 26 release): each of the five flags is in its
  `--v8-options` and a Node starts with them, `node:sqlite` opens and queries a database, and `--permission` without
  `--allow-net` refuses a TCP connection (`ERR_ACCESS_DENIED`; `--allow-net` came with Node 25.0.0), and `npm test`
  passes on it. Chord's terminal sandbox (slice 27) asks for 26.5.1 (`requireSandboxNode`): that release fixed
  permission-model CVEs (CVE-2026-58043 "avoid granting radix split nodes", High; two Low), which slice 27 has to weigh.
  `test/install.test.ts` checks that the Node that runs the tests lists and accepts every flag; the launched and release
  tests check the worker's command line flag by flag. `src/minimum-node.ts` refuses an older Node with one line and exit
  1 (`p3: needs Node 26.3.1 or newer; this is Node …`); its version is `package.json`'s `engines`. (Before 2026-11-18:
  Node 24.4.0, each flag checked on 24.4.1 and 26.11.1, the release tests run on both; the memory test's numbers for
  each Node are below.) In the release the
  launcher `p3.js` runs it first and has no static import (Opus, round 5: ES modules are linked before any of them
  runs, so a builtin an old Node lacks failed the graph first: `node:sqlite` on Node 22.12, `enableCompileCache` on
  20): it loads `minimum-node.js`, a bundle of no imports, then Node's compile cache and the rest with `import()`.
  Checked with Node 20.19.5, 22.12.0, 22.21.1 and 24.0.0, and on 2026-11-18 against 26.3.1 with 20.19.5, 22.12.0,
  24.0.0 and 24.4.1: each gets the one line, for `--version` and `status`; a build
  test asserts that `p3.js` has no static import. From a checkout `bin.ts` imports it first (an old Node there is a
  developer's). A worker never starts alone, so it has no check of its own.
- **Two hooks** the memory test uses (owner: fine): `startWorker({ session })`, what runs on the worker's store and
  host once it is up, a test and interim hook (slice 3's harness becomes an object in the worker's core facet, design
  §24, and replaces it: Carried); `startServer({ facets })`, more core facets (the
  test passes Chord's telemetry ingest, which the kit will run later; a plugin cannot carry it, Chord refuses a plugin
  that imports Chord under an app's API).

**The memory test** (`test/release/memory.test.ts`, run by `release:p3:local`; `test/memory/`): a server and a worker
entry built with the release's own options and checks; the installed release's plugins; in each of 4 workers at once
a real Durable `Harness` on the worker's store with the coding tools (Photon images), a `NodeExecutionEnv`, a prompt
section, a subagent tool and pi-ai's real Anthropic and OpenAI providers against a local HTTPS stub (a certificate
made by OpenSSL for the test, trusted through `NODE_EXTRA_CA_CERTS`; Anthropic Messages and OpenAI Responses SSE),
with telemetry recorded and sent to the server every second. The schedule: idle; one streamed answer (8 KB over
15 s); a burst of 20 turns with read and bash tool calls, five of them on OpenAI; five subagent conversations
streaming at once; idle after each phase. USS every 250 ms from `/proc/<pid>/smaps_rollup` (skipped, saying so,
where there is none). It fails when a worker's USS ever exceeds **55 MiB**, naming the phase, the peak and the
settled values. pi-ai and Durable are p3's dev dependencies (the lockfile gains that entry).

- **The budget is 55 MiB, one for every Node** (owner). Not 50: Node 26's workers settle about 7 MiB above Node
  24's (after the burst 42.5 against 35.0, Opus's round 5), and 50 failed one run in five there. Not 45 (owner,
  after measuring what the worker holds): after the five parallel streams,
  glibc keeps about 10 MiB it freed (`malloc_info`: 10 to 11 MiB kept free, against 4 to 6 after the burst); the
  session's data is about 4 MiB of the heap. Measured, 40 s after the phase: V8's heap 27.4 MiB committed (24.5 used;
  by kind: code, closures, contexts and shapes 13.0, our bundles' source text 2.4, data 4.1: Durable's conversations,
  the transcripts, pi-ai's state); malloc live 6.6, kept free 10.8. It does not fall after Durable's 10-minute
  retention (46.4 → 44.2 over 11 minutes, from a major GC at 200 to 300 s; glibc's 11 MiB stay); a forced `gc()`
  changes the USS by −0.2, only `malloc_trim` returns 3 to 4 MiB. Telemetry off: 42.2 after the phase (its sender
  every second keeps the young generation from shrinking, +2 MiB); the subagents before the burst move the peak (the
  burst after them reaches 47.4) but not the level. `GLIBC_TUNABLES=glibc.malloc.mmap_threshold=16384` would bring the
  phase to 33.6–36.1 (peak 38.4), and was not taken: it works with glibc only.
- **An idle phase ends once the worker settled,** not after a fixed 40 s: the worker waits for the test's `SIGUSR2`
  (no timer of its own), and the test sends it once 12 s passed and the USS moved less than 0.25 MiB over the last
  4 s (at most 40 s). Every phase settled at 12.0–13.5 s, and the readings are those of the 40 s pauses within
  0.2 MiB (n=40 each); a run takes 80 s instead of 190 s. The peak check is unchanged; shorter pauses could only make
  it stricter (less time to recover between phases).

**Numbers,** the memory test from the release on slayer, USS in MiB, median [min–max]. Before: the same test with
none of the levers (one build sharing a chunk with the server, the SDKs from `node_modules`, no V8 flags, Chord's base
unminified, no compile cache flush), 3 runs × 4 workers. After: 10 runs × 4 workers:

| reading | before the levers (n=12) | with the levers (n=40) |
| --- | --- | --- |
| idle, settled | 30.3 [29.5–35.7] | 18.5 [18.0–25.4] |
| after the first response | 55.8 [53.7–61.5] | 30.0 [28.9–34.5] |
| burst peak | 77.3 [74.9–82.0] | 41.6 [41.0–43.8] |
| after the burst | 55.6 [53.7–61.4] | 34.9 [34.4–37.1] |
| 5 subagents, peak | 67.6 [66.7–73.2] | 44.7 [43.4–47.6] |
| after the subagents | 67.6 [66.7–73.2] | 44.5 [41.5–47.6] |
| highest of a run | 77.3 [74.9–82.0], in the burst | 44.7 [43.4–47.6], after the subagents |

- **At the budget of 55 MiB,** the memory test five more times on each Node (after review round 5, the launcher and
  the test's working directories changed), 5 runs × 4 workers each:

  | reading | Node 24.4.1 (n=20) | Node 26.11.1 (n=20) |
  | --- | --- | --- |
  | idle, settled | 18.4 [17.9–25.6] | 20.6 [20.3–27.1] |
  | after the first response | 30.0 [28.8–34.5] | 29.5 [29.0–34.0] |
  | burst peak | 42.0 [41.2–43.5] | 42.7 [42.1–44.5] |
  | after the burst | 35.1 [34.5–37.1] | 42.3 [38.4–44.5] |
  | 5 subagents, peak | 44.7 [43.5–46.8] | 47.8 [45.6–50.0] |
  | after the subagents | 44.6 [41.2–46.8] | 47.2 [43.7–50.0] |
  | highest of a run | 44.7 [43.5–46.8] | 47.8 [45.6–50.0] |

  All 10 runs pass: the margin is 8.2 MiB at the worst Node 24 worker and 5.0 at the worst Node 26 one. At 50, one
  Node 26 run in five failed (Opus); at 45, 15 of 40 Node 24 workers went above it. Node 24 still catches a lost lever
  (Opus: without `--liftoff-only` 55.4 at the median, without the three flags 65.9).
- The idle maximum (25.4) is each run's first worker, whose compile cache is cold; the others start from its cache.
- **With `--gc-memory-reducer-start-delay-ms=8000`** (2026-11-18): the memory test 5 times on each Node, alternating
  Node 26 and Node 24, serially on an otherwise idle slayer (the release built and its 33 tests passed on Node 24, and
  again run by Node 26.11.1), 5 runs × 4 workers each. "Node 26, before" is the same test the night before, also
  serial, without the flag:

  | reading | Node 24.4.1 (n=20) | Node 26.11.1, before (n=20) | Node 26.11.1, with the flag (n=20) |
  | --- | --- | --- | --- |
  | idle, settled | 18.5 [18.1–25.4] | 20.7 [20.3–26.9] | 19.0 [18.5–25.6] |
  | after the first response | 30.1 [28.9–34.6] | 29.7 [28.7–33.6] | 30.7 [30.1–35.1] |
  | burst peak | 41.8 [40.9–43.3] | 43.1 [42.3–45.1] | 43.3 [42.8–45.3] |
  | after the burst | 35.0 [34.5–36.7] | 42.8 [37.7–45.1] | **37.2 [36.6–39.0]** |
  | 5 subagents, peak | 44.8 [43.9–46.1] | 47.2 [46.3–50.5] | 49.5 [47.1–50.9] |
  | after the subagents | 44.8 [41.3–46.1] | 46.8 [43.5–49.8] | 49.1 [42.9–50.9] |
  | highest of a run | 44.8 [43.9–46.1] | 47.2 [46.3–50.5] | 49.5 [47.1–50.9] |

  On Node 26 the flag does what mem-audit measured: after the burst 37.2 instead of 42.8, idle 19.0 instead of 20.7.
  The subagents' peak and what follows it rise by about 2 MiB (mem-audit too: 50.7 with the flag against 48.9); likely
  because the reducer now shrinks the heap in the idle phase before the subagents and V8 grows it again when five
  conversations stream at once (not checked). The worst Node 26 worker is 50.9 MiB, 4.1 below the budget (4.5 before). Node 24's
  readings are those of before, as expected from a flag that sets its own default. All 10 runs pass.
- **With `--managed-zone-memory` on Node 26** (2026-11-18): 5 rounds, serially, each round the memory test as built
  (with the flag) and a copy without it (the same commit, only the flag taken out) at the same time on an otherwise
  idle slayer, all on Node 26.11.1, both with the reducer's delay; 5 runs × 4 workers each. The memory test now also
  reads each worker's CPU time (`/proc/<pid>/stat`, user and system) from the last sample before a phase to the first
  after it:

  | reading | without (n=20) | with `--managed-zone-memory` (n=20) |
  | --- | --- | --- |
  | idle, settled | 18.9 [18.5–25.4] | 17.9 [17.7–20.1] |
  | after the first response | 30.8 [30.2–35.7] | 28.6 [27.7–30.0] |
  | burst peak | 43.4 [42.9–44.6] | 41.4 [40.8–42.9] |
  | after the burst | 37.2 [36.8–44.1] | 33.8 [33.1–34.5] |
  | 5 subagents, peak | 49.1 [48.3–51.1] | 46.7 [44.8–47.9] |
  | after the subagents | 48.7 [43.7–51.1] | 42.6 [37.4–44.8] |
  | highest of a run | 49.1 [48.3–51.1] | **46.7 [44.8–47.9]** |
  | CPU of the streamed answer | 0.91 s [0.86–0.96] | 0.89 s [0.82–0.95] |
  | CPU of the burst of 20 turns | 0.33 s [0.30–0.39] | 0.34 s [0.29–0.38] |
  | CPU of the five subagents | 2.17 s [2.05–2.36] | 2.21 s [2.03–2.42] |

  Lower in every reading, by 1 to 6 MiB; the worst Node 26 worker is 47.9 MiB, 7.1 below the budget and close to Node
  24's worst (46.1 in the release's own run on Node 24 that night, n=4). No CPU cost the runs can see: every
  phase's median within 2%, the ranges overlapping. The release tests' own memory run on Node 26 agrees (n=4: after
  the burst 33.6, after the subagents 42.1, highest 46.9).

## Carried (not in this slice)

Packaging: its own package, later; decision "Packaging is its own work, later"; the measurements are in
`/home/badlogic/chord-notes/research/p3-sea-2026-11-18/`.

Publishing the lockstep version of Chord, pi-schema and pi-telemetry that p3's types need (npm's 1.5.2 predates
them), and p3's own version joining the lockstep; a build cache on disk (decided against for now, decision "No build cache"), or a ready worker base in the release (the
numbers are under "What a start builds"; a Chord change); a Bun or single-file binary; publishing from CI (trusted publishing, the `private` flag, lockstep versions, a
CHANGELOG for p3); an install lock for installers (`packages/coding-agent/install-lock/`'s counterpart); the
terminal client behind plain `p3` (slice 27); a restart requested from the page (slice 2); starting a Pi at boot
(a service unit); the web and terminal base bundles in the package (slice 16); slice 3 replaces `startWorker({
session })`, the memory test's hook, with the harness as an object in the worker's core facet (design §24), and the
memory test's session with it; whether `--managed-zone-memory` can go once V8 turns it on by default (it is behind `--future` there). **Windows, not run natively:** the
whole suite on Windows (its tests read `/proc`, the gate matches `/server.json`, the fake `ps` and PowerShell need a
POSIX shell); Chord's `processLock` on named pipes; PowerShell's real output; `release:p3:local` there (it links
`<out>/p3` with a symbolic link and runs `npm` without its `.cmd`); the data directory's privacy (modes 0700 and 0600
do nothing there: the owner token, and so the identity proof, rest on the profile directory's ACL, to be checked or
set); a supervisor a command ends on Windows is terminated at once, and a child server it had started stays.
