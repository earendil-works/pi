# Testing a package

Tests are fast, isolated and deterministic: every case gets its own server, sessions and stores; a test waits for
an effect it caused; nothing fails in the background but what the case asked for. A failure under load is a bug until
its cause is known.

## Setup and commands

p3 needs Node 26.3.1 or newer, tests included. On slayer the default `node` is 24:
`export PATH=/home/badlogic/node-v26.11.1-linux-x64/bin:$PATH`. This device's terminals run in pi-env's daemon, which a
checkout builds with Rust (`cargo`, https://rustup.rs): `npm run build:daemon`; `npm test` runs it first, a single test
file run by hand needs it built once (and again after a change of `packages/env/daemon`).

| Command (in `apps/p3`) | What |
| --- | --- |
| `npm run check` | Biome and TypeScript over p3 (the root check skips `apps/`); clean before every report |
| `npm run build:daemon` | builds pi-env's daemon from `packages/env/daemon` (`cargo build --release --locked`, about 1 s when nothing changed): this device's terminals in a checkout |
| `npm test` | builds the daemon (`pretest`), then every `test/*.test.ts` and `plugins/*/test/*.test.ts`, from source |
| `node --conditions=source --disable-warning=ExperimentalWarning --test <file>` | one test file |
| `npm run release:p3:local -- --out /tmp/p3-release --force` (from the repository root) | builds and installs the release outside the repository and runs `test/release/*.test.ts` against it; `--bench` runs `bench/skeleton.ts` against it. The memory test is not ported yet: the old base's is in git at `753bc0bb2` (`apps/p3/old/test/release/`), ported with the harness core (ERNDL-855) |

Run the release command when your package changes what the release ships (its files, its dependencies) or what a
worker loads.

## The tiers

A plugin's own tests live in its `test/` folder (`plugins/<name>/test/<file>.test.ts`): no build reads that folder and
no release ships it. Both of its tiers are there: the plugin tier (`testPlugin`, one file per source file) and its end
to end cases (`testServer`: HTTP, `/chord` links, workers, an apply, a restart; the sign-in plugin's and the runner's).
They import the API only, as a third party's do, both helpers from `@earendil-works/p3/v1/testing`, never p3's
`src/`; one exception, `WORKER` (`src/install.ts`) where the runner's own tests fork a real worker. `test/` holds the
tests of the base and of the whole (the topology, the command, the release, the query plans).

**1. Plugin** (milliseconds): one facet built as production builds it, on an in-memory host with its kind's
principal, address and API modules, beside the base's facet as the real host has it: on the server `ServerRuntime`
(a server that does not listen, starts no session worker and applies nothing) and the base's registries
(`WorkerRunners`, `WorkerRunnerWraps`, `LinkOpened`, `ServerCommands`, composed as the server composes them), on a worker `WorkerRuntime`
and `WorkerBusy`. Each test gets a temporary directory of its own (the runtime's `dataDir` or `dir`), removed at its
close. Chord's HTTP component is not there: its registries (`Http`, `Authenticators`) are collected for the test
(`t.contributions`). The installed release runs a third-party plugin's own test this way. Model:
`plugins/sessions/test/session.test.ts`.

```ts
import { testPlugin } from "@earendil-works/p3/v1/testing";
const t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), {
	kind: "server",                            // or { kind: "worker", session: "s1" }
	stubs: [],                                 // small facets serving the contracts t.unserved() lists
}, context);
try {
	// The owner is a person: the one the people plugin's `persons.owner` reads (made at the first start).
	const person = { kind: "person", id: "p1", name: "Ann" } as const;
	await t.root(async (ctx) => { /* ctx.get(...), calls, asserts */ }, context, { principal: person });
	assert.deepEqual(t.unserved(), []);
} finally {
	await t.close(context);                    // also removes the test's directory
}
```

**2. Topology** (fast, most cases of a plugin): the server and session workers as hosts in one process, linked in
memory, each with its own SQLite store, the plugins imported as modules; the base's own pieces are the real ones
(the base facets and the route's admission exported by `src/server.ts` and `src/worker.ts`), and the server loads every built-in plugin. `test/topology.ts` gives
`topology(context, idleMs?)` with `client(principal)` (any principal), `reload(plugin, session?)` (a plugin's objects
restart, as after an edit, on the server or on a worker), `count(metric)` (the server's counted work), `workers`,
`errors`, `closed`. Model: `test/topology.test.ts` (reloads while in use, access, counted work). Where it stops: workers
are hosts, not processes (no fork, no IPC, no exit), the route does not ask the runner, and a reload renews a facet
object instead of building edited source: the runner's processes, an apply and edited scripts are tier 3.

**3. End to end** (`testServer` of `/v1/testing`): p3's real server in the test's process on a temporary data
directory, its session workers as real processes forked from the install's worker entry, its plugins built as a Pi's
are: the built-in ones, the plugins under test (`plugins`: their directories, from a root of their own) and the data
directory's user root (`userRoot`), where a test writes plugins of its own and applies them. It gives `client(ctx)`
(signed in as the owner over WebSocket, as a page is), `cookie(ctx)` (a browser's sign-in cookie), `host` (the
server's host: `root`, the base's registries), `plugins` (the watcher's marks), `workers(ctx)` (the state of the runner the base uses, its wraps included),
`apply(ctx)`, `restart(ctx)`, `stop(ctx)` (the data directory kept) and `close(ctx)`; workers idle 300 ms by default
(`idleMs`). `ownerClient` and `ownerCookie` sign in to any running p3 server (a launched one too). The tests' own
`test/support.ts` adds the probe (`PROBE`: a plugin under test that drives a session's worker, and whose server route
`GET /_probe/principal` answers who a request signed in as), `workerReports(client, session, context)` (what a
session's worker reported, through the probe: `t.errors` has the server's only), `constantPlugin(name, value)` (a single-file worker
plugin serving one value), `alive`, and for launched processes `launch` (a foreground `p3 server`) and `childrenOf`.
Models: `test/skeleton.test.ts`, `plugins/sign-in/test/sign-ins.test.ts`.

```ts
import { testServer } from "@earendil-works/p3/v1/testing";
const t = await testServer({ plugins: [fileURLToPath(new URL("../", import.meta.url))] }, context);
try {
	const client = await t.client(context);
	const session = await newSession(client, "one", context);           // `test/support.ts`: `Workspace.make` in Pi
	const held = await client.get(MyWorkerContract, { session }, context);      // the session's worker starts
} finally {
	await t.close(context);
}
```

After an apply that reloads the runner plugin, the next runner is contributed after the apply returned (its
predecessor closes first): wait for it with `until` on the `WorkerRunners` registry before the next hold, never on
the apply's answer (`chord-practices.md`, Reload).

**4. The command** (a few cases): `p3` launched as processes of its own on a temporary home, including what a crash
leaves behind (sockets of killed processes, a supervisor's restart) and a server that does not stop. The command's
channel is a Unix socket: these cases, like p3's guarantee, are POSIX only (Windows: ERNDL-1059). Model:
`test/command.test.ts`.

**5. The release** (`test/release/release.test.ts`, run by `npm run release:p3:local` against the install it makes
outside the repository): what the package holds, the command, a worker forked from the release's own bundle, and a
third-party plugin written against the installed API alone (type-checked; its own tests run on the installed
`/v1/testing`, the plugin tier and end to end, the installed server forking its workers from the release's bundle;
loaded from the Pi's user root, called by a client of the compiled API). Run the bench against the install with
`--release` (or the script's `--bench`).

## What every package tests

1. **Each case of the plan,** in its tier, named after the rule it pins.
2. **Effects the test caused:** `until(member, done, ctx)` (`@earendil-works/p3/v1`, the one the base and the
   plugins use) for changes made elsewhere; after a call on the same reference the value is already there;
   `eventually(probe, done)` (`test/until.ts`) only for what no watchable shows (a process's exit, a file). No sleeps
   for synchronization. `test/until.ts` imports nothing of p3: a built-in plugin's own tests use it too.
3. **Access:** every object refuses the principals it does not serve (`forbidden`); a person sees only what their
   admission allows.
4. **Reload:** every facet you touch, reloaded while used (a list open, a worker held): nothing lost, no error. Model:
   `test/topology.test.ts`, "reloads while in use".
5. **Query plans:** for every named query, `EXPLAIN QUERY PLAN` of the SQL Chord runs (first page and after a
   bookmark) searches the named index with no temporary B-tree. Model: `test/plans.test.ts`.
6. **Counted work:** Chord counts its work as metrics (`chord.query.runs`, `chord.query.probes`, `chord.link.*`);
   assert them per common action through the in-memory telemetry adapter (the topology's `count`). Models
   (`test/topology.test.ts`): "a rename runs only the reads that show the renamed session", the same for a worker's
   report, and what a hold of a session's worker costs.
7. **GC:** every cache is a `WeakMap`, and nothing holds what it was keyed by; drop its owner, collect, assert the
   entry is gone (`collected` of `test/until.ts`):

   ```ts
   const ref = (() => new WeakRef(makeOwner()))();
   assert.ok(await collected([ref]));
   ```

8. **Reviewers' reproductions** become regression tests.
9. **Mutation check** before reporting: undo each rule and fix one at a time in a copy under `/tmp`; a test must fail
   for each. The copy needs its own package links: copy `apps/p3` to `/tmp/x/apps/p3` and make
   `/tmp/x/node_modules/@earendil-works/` a directory of links, `p3` to the copy and every other entry to the
   repository's (linking the whole scope makes p3 resolve to the checkout, and mutations do nothing).
10. **Serial and loaded:** the suite passes with `--test-concurrency=1` and with four `npm test` at once.
11. **No leaks:** a failed case closes its sockets and processes (`t.after`, `finally`); one leak hangs the runner.

## UI tests

The page (the base's `src/web/` and the plugins' web facets) is tested in a real browser; the terminal client does
not exist yet.

- **Automated:** headless Chromium driven over the DevTools protocol by `plugins/chrome/test/browser.ts` (open a URL,
  size the viewport, wait for an expression, click and type with real input events, take screenshots, keep the page's
  console). The model is `plugins/chrome/test/page.test.ts`: `testServer` with a copy of the built-in plugins the test
  edits and the tests' faux login (`test/plugins/faux-login/`), the owner's cookie set in the browser, then the page as
  a person uses it: the bar and the navigator, the Settings view and its who may, things and sessions made through the
  picker, a scripted answer, the phone's screens, a reload of a plugin while the page is open (the page keeps its
  state and unsent work, it does not load again), views a test writes into the user root, invited people and what they
  may not do. Every case looks at the phone's
  viewport (390x844, touch emulated) and the desktop's (1280x900), light and dark (`colorScheme`). Wait for what the
  page shows (`wait`), never sleep; before a screenshot of a dialog or a popup, `settled` waits until its animations
  ended and checks it is on top. The last case asserts that the server reported nothing and the page logged no error.
  Screenshots go to `/tmp/p3-base/shots/` (`P3_SHOTS` names another directory) for a person to look at.
- **Run only when asked,** never in a plain `npm test`: `P3_BROWSER_TESTS=1` and `CHROMIUM_BIN` (on slayer
  `CHROMIUM_BIN=/home/badlogic/.local/bin/chromium-docker`, the Playwright image's Chromium), else the suite is
  skipped:

  ```sh
  P3_BROWSER_TESTS=1 CHROMIUM_BIN=/home/badlogic/.local/bin/chromium-docker \
    node --conditions=source --disable-warning=ExperimentalWarning --test plugins/chrome/test/page.test.ts
  ```

- **Without a browser:** what the server serves the page (Elanor's fonts and tokens, the page's links) is a plain
  `testServer` test (`plugins/chrome/test/assets.test.ts`), part of `npm test`.
- **By hand, at sign-off:** people with the devices check Safari on iOS, Firefox on Android and Chrome on Android, and
  note on the Linear issue what they used and found.

## Android (the phone)

p3 runs on Android under Termux (Node 26.3.1). Known differences:

- no hard links (write a temporary file and rename it);
- no `/proc/<pid>/task/<pid>/children` (scan `/proc/*/stat` for the parent; `childrenOf` in `test/support.ts`);
- at most 32 child processes per app (Android 12 and later, the "phantom process" limit): Android kills processes
  beyond that, the test runner and session workers included. A Pi with many working sessions needs it lifted: on
  Android 14 and later, Developer options, "Disable child process restrictions"; on Android 12 and 13, from a computer,
  `adb shell device_config set_sync_disabled_for_tests persistent` and
  `adb shell device_config put activity_manager max_phantom_processes 2147483647`;
- everything is about ten times slower to start than on slayer.

A package that touches processes, files or the network runs its tests on the phone before sign-off.
