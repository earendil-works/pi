# Testing

How a package is tested: the three tiers, what every package tests and how, the commands, UI tests, and what is
different on Android. Paths are relative to `apps/p3/` unless they start with `packages/` or `apps/p2/`.

Tests are fast, extensive, isolated and deterministic (`../decisions.md`, "Tests are isolated and deterministic"):
each case gets its own topology, sessions and stores; nothing a case leaves behind is visible to the next; a scripted
model answers only what the case scripted; a test waits for an effect it caused. A failure under load is a bug until
its root cause is known.

## Node

p3 needs **Node 26.3.1 or newer**, also for its tests (`../decisions.md`, "Node 26 or newer everywhere";
`src/minimum-node.ts` refuses an older one with one line). 26.3.1 is the newest Node Termux offers on Android.

On slayer the default `node` is 24.4.1. Put Node 26 first:

```sh
export PATH=/home/badlogic/node-v26.11.1-linux-x64/bin:$PATH
```

## The commands

| Command | Where | What |
| --- | --- | --- |
| `npm run check` | `apps/p3` | Biome and `tsc --noEmit` over p3 (the root check skips `apps/`). Clean before every report: no errors, warnings or infos |
| `npm test` | `apps/p3` | every `test/*.test.ts`, `test/kit/*.test.ts` and `plugins/**/*.test.ts`, from source (`--conditions=source`), dot reporter, `--test-force-exit`. About 134 tests in 12 s today |
| `node --conditions=source --disable-warning=ExperimentalWarning --test <file>` | `apps/p3` | one test file |
| `npm run release:p3:local -- --out <dir>` | the repository root | builds Chord, pi-schema, pi-telemetry and p3, packs them, installs p3 outside the repository, then runs `test/release/*.test.ts` against the install (`P3_RELEASE`). `--bench` runs the bench too; `--skip-test` skips the tests. About 91 s, the memory test's 80 s among them |
| `npm run check` | the repository root | the root check, when you touched anything under `packages/` (you should not: `process.md`) |

- Run `npm test` in `apps/p3`, not at the root: the root `AGENTS.md` forbids `npm test` at the root unless asked.
- Run `release:p3:local` when you touched base code (`src/`, `scripts/`, `package.json`) or anything the release
  ships differently from source.

## The three tiers

### 1. Plugin: one facet alone (`testPlugin`)

The plugin built as production builds it, loaded on an in-memory host with a `:memory:` store. Milliseconds. Model:
`plugins/sessions/sessions.test.ts`.

```ts
import { type TestedPlugin, testPlugin } from "@earendil-works/chord/plugins";
import { type P3Principal, Server } from "@earendil-works/p3/v1";
import { API } from "../../src/app.ts";

t = await testPlugin<P3Principal>(fileURLToPath(new URL("./", import.meta.url)), {
	kind: "server",
	api: { name: API.name, versions: API.versions },
	modules: API.modules,                     // the real API modules
	principal: { kind: "server" },            // the host's principal
	address: Server(),                        // the host's address
	stubs: [],                                // facets serving the contracts your plugin uses: see t.unserved()
}, context);
await t.root(async (ctx) => { const sessions = await ctx.get(Sessions, {}); … }, context, { principal: OWNER });
assert.deepEqual(t.unserved(), []);          // every contract the plugin asked for was served
```

- Tests may import Chord; plugin code may not.
- Stub every contract `t.unserved()` lists with a small facet serving fake data.
- `t.contributions(Registry)` lists what the plugin contributed to a registry nobody serves.
- Full API: `packages/chord/docs/plugin-authoring.md`, "Testing a plugin alone"; source
  `packages/chord/src/node/plugins/testing.ts`.

### 2. Topology: server and workers in one process (`test/topology.ts`)

p3's server and its session workers as hosts in one process, linked in memory, each with its own store (SQLite
`:memory:`, a temporary file where a restart is tested), the plugins imported as modules (no build). A worker starts
on the first hold of its session the route admits, as the kit starts one. **Most coverage lives here.** Model:
`test/sessions.test.ts`.

| `Topology` member | What |
| --- | --- |
| `topology(context, store?)` | starts one; `{ kind: "file", path }` for a restartable store |
| `client(principal)` | a client host connected as the owner or a person |
| `workers` | the workers started so far, by address key |
| `errors` | what failed in the background, in order |
| `count(name)` | the total of a server metric so far (`chord.query.runs`, `chord.query.probes`), from an `InMemoryTelemetryContext` |
| `reloadSessions()`, `reloadWorker(session)` | reloads the sessions plugin on the server or on one worker, with a new facet object of the same setup |
| `restart()` | closes everything, opens a new server on the same store file |

Every host waits at most 5 s for an object, so a mistake fails in seconds. After each case, assert that nothing
failed in the background but the refusals the case asked for (`test/sessions.test.ts`, its `afterEach`).

The topology loads only the sessions plugin today (`SESSIONS`, `WORKER_PLUGINS` in `test/topology.ts`). A package
that needs its plugin there extends it. **Open:** who owns shared test code (`test/topology.ts`, `test/until.ts`,
`test/launched.ts`); until decided, a change there goes to Mario, and the PROPOSED shape is a topology that takes the
plugins to load (server and worker facets) as an argument.

### 3. End to end: the real app

A few cases through the real app: `startP3` in process (`test/app.test.ts`), launched from source
(`test/launched.test.ts`) and launched from the installed release (`test/release/release.test.ts`), each running the
same case function (`test/end-to-end.ts`).

| Helper | File | What |
| --- | --- | --- |
| `ownerClient(server, ctx)` | `test/client.ts` | a client over WebSocket, signed in with the owner token file |
| `launch(command, dataDir)` | `test/launched.ts` | a server launched as a process (`SOURCE`, or `releaseOf(install)`), driven from outside |
| `run`, `eventually`, `workersOf`, `childrenOf`, `supervisorsOf` | `test/launched.ts` | a command run to its end; a polled check; the processes of a launched Pi |
| `cli(command, t)`, `CASES` | `test/commands.ts` | the `p3` command's cases on Pis under a home directory of the test's own |
| the gate | `test/gate.ts` | a preload holding a launched server at one point of its start |
| the kit's test server | `test/kit/support.ts` | a kit server on a temporary data directory with a temporary plugins root |

Long cases (a browser) run only when asked, or nightly; never in the default run.

## What to test, and how

1. **Each case of the brief is a test,** in the tier the brief names. The test's name says the rule it pins.
2. **Wait for an effect the test caused** (`test/until.ts`): `until(member, done, ctx)` resolves with the first value
   for which `done` holds. Never wait for a pattern that may already be there. After a call on the same reference the
   value is there already: a call's answer follows its state (design §3). No sleeps as synchronization.
3. **A reload test for every facet you touch,** while it is used: the server's with a list open, the worker's with
   the owner holding the worker's object. Nothing lost, no error, the same objects bound. Model:
   `test/sessions.test.ts`, "keeps its pages across a reload of the sessions plugin" and "a reload of the worker's
   facet".
4. **A plan test for every named query** (`test/plans.test.ts`): record the SQL Chord runs for the first page and
   the page after a bookmark, run `EXPLAIN QUERY PLAN` on each, and assert it searches the named index with no
   `TEMP B-TREE` (no sort).
5. **A GC test for every cache** (a `WeakMap` keyed by its owner): drop the owner, collect, and assert the entry is
   gone. p3 has no helper yet. The pattern (`packages/chord/test/support.ts`, `expectCollected`;
   `packages/chord/test/delta-op-text-retention.test.ts` for `node:test` style):

   ```ts
   import { setFlagsFromString } from "node:v8";
   import { runInNewContext } from "node:vm";
   setFlagsFromString("--expose-gc");
   const gc = runInNewContext("gc") as () => void;
   const ref = (() => new WeakRef(makeOwner()))();
   for (let round = 0; round < 10 && ref.deref() !== undefined; round++) {
   	await new Promise((resolve) => setImmediate(resolve));
   	gc();
   }
   assert.equal(ref.deref(), undefined);
   ```

6. **Cost guards through the in-memory telemetry adapter:** Chord counts its own work as metrics (`chord.query.runs`,
   `chord.query.probes`, `chord.query.skips`, `chord.data.*`, `chord.link.*`; design §29 "Built", §30 "Cost
   guards"). Assert the counts per action. Model (`test/sessions.test.ts`, "runs only the reads that show a renamed
   session"): a rename runs exactly 3 reads and 0 probes, and the other session's reads do not run.
7. **Access:** every object refuses the principals it does not serve (`forbidden`), and a person's object shows only
   what their admission allows.
8. **Every reproduction a reviewer writes becomes a regression test** in the repository.
9. **Mutation check before reporting:** undo each fix and each rule, one at a time, in a copy under `/tmp`; a test
   must fail for each. A rule no test catches is untested. The copy needs its own package links: copy `apps/p3` to
   `/tmp/x/apps/p3` and make `/tmp/x/node_modules/@earendil-works/` a directory of links, `p3` to the copy and every
   other entry to the repository's (linking the whole scope resolves p3 back to the checkout, and the mutation takes
   no effect). A mutation keeps its imports used (an unused import trips the build's externals check). Report the
   rules, the runs, what was caught and what survived and why (`../slices/26-release.md`, "Tests and checks", is the
   model).
10. **Subtle rules** (skip rules, tiling): a randomized test compares the optimized result with a fresh run, across
    several owners and group commits, checked after every frame.
11. **Loaded and serial runs:** the suite passes run serially (`--test-concurrency=1`) and with four suites at once
    (four `npm test` in parallel). Report the suite's time.
12. **No leaks:** a failed case leaves no socket or process open (`finally`, `t.after`, `--test-force-exit`). One
    leak hangs the whole runner. Launched supervisors are detached: a runner kills them by command line.

Not yet possible: scripting a model. The faux provider (`packages/ai/src/providers/faux.ts`) arrives in p3 with the
harness (slice 3, PROPOSED); until then nothing in p3 runs a model in `npm test` (the memory test uses a local HTTPS
stub, `test/memory/stub.ts`).

## UI tests

p3 has no web page or terminal client yet (slices 16 and 27): no UI test exists in p3. These are the rules for when
they come, from p2 and Chord.

**Chrome-based, headless.** UI tests drive headless Chromium over the DevTools protocol (CDP), as p2 and Chord do:

- p2: `apps/p2/test/p2/browser.ts` (`Browser.start`, `metrics(width, height)`, `open`, `wait`, `click`, `evaluate`,
  `call(cdpMethod)`; `.pi/skills/p2-ui.md`, "Tests").
- Chord: `packages/chord/test/node/web/browser.ts`, adapted from p2's: `CHROMIUM_BIN`, else `chromium-docker` on the
  `PATH`; without either the browser tests are skipped.
- p3: PROPOSED `test/browser.ts`, adapted from Chord's.
- On slayer: `CHROMIUM_BIN=/home/badlogic/.local/bin/chromium-docker`, a wrapper running the Chromium of the Playwright
  image `mcr.microsoft.com/playwright:v1.55.0-noble` with host networking. Run browser tests in a scratch clone, not in
  the shared checkout's live data.

**Desktop and mobile viewports.** Every UI case runs at both:

- phone: 390×844 (`Emulation.setDeviceMetricsOverride` with `mobile: true`; p2 sets it below 700 px wide);
- desktop: 1280×900 (p2 also uses 1400×860).
- Touch: `Emulation.setTouchEmulationEnabled` and `Input.dispatchTouchEvent`. CDP has limits: no real long press, no
  OS text selection, no soft keyboard; test those paths through their handlers (timers, `pointerdown`).
- Screenshots: `Page.captureScreenshot` at 390×844, for the sign-off video or demo.

**Safari and iOS (the board: Chrome-based and Safari/iOS; Firefox dropped).** What exists today:

- No Safari on Linux. No p3, p2 or Chord test runs WebKit.
- p2's tests only fake `window.webkit` for the macOS app's native theme bridge (`apps/p2/test/p2/theme.test.ts`); that
  is no WebKit engine.
- The Playwright image on slayer ships a WebKit build (`/ms-playwright/webkit-2203`), but WebKit does not speak CDP:
  driving it needs Playwright's client library, which is not a dependency of the repository.

**Open:** how Safari/iOS is tested. Options: WebKit through Playwright on Linux (a new dependency, a second driver
beside CDP); a Mac runner with real Safari (and the iOS simulator); manual checks on devices at sign-off. Until Mario
decides, UI packages check Safari on an iPhone by hand before sign-off and say so in the demo.

## Android (the phone)

p3 runs on Android (Termux). What was found so far:

- **No hard links.** Android's app sandbox refuses them (`EACCES`). p3's secret files are written with a temporary
  file and one rename, never a link (`src/kit/secrets.ts`; test: `test/kit/secrets.test.ts`, "writes, creates and
  replaces where the system refuses hard links").
- **No `/proc/<pid>/task/<pid>/children`** (the kernel lacks `CONFIG_PROC_CHILDREN`). Tests find a process's children
  by scanning every `/proc/<pid>/stat` for its parent (`childrenOf` in `test/launched.ts`; test:
  `test/launched.test.ts`, "a process's children").
- **`/proc/<pid>/smaps_rollup` and `/proc/<pid>/stat` exist,** so USS and CPU are measured as on Linux. The memory
  test skips, saying so, where there is no `/proc` (macOS, Windows).
- **At most 32 child processes** per app, and Android's phantom process killer kills processes beyond it (also the
  process the tests run under). p2 turns its Chromium tests off on Android for this (`apps/p2/test/p2/browser.ts`,
  `browserTests`). Expect the same for p3's.
- **Node 26.3.1** is what Termux offers; it is p3's minimum. The terminal sandbox (slice 27) wants 26.5.1 for a
  permission-model fix and accepts 26.3.1 with that hole (`../decisions.md`).

Run your package's tests on the phone before sign-off when it touches processes, files or the network.

## Checklist

1. One test per case of the brief, in its tier; most in the topology tier.
2. Waits for effects the test caused; no sleeps as synchronization; nothing failed in the background.
3. A reload test for every facet touched, while used.
4. A plan test for every named query.
5. A GC test for every cache.
6. Cost guards on the counted work of the package's common actions.
7. Reviewers' reproductions are tests.
8. Mutation check done and reported.
9. `npm run check` clean; `npm test` passes serially and with four at once; the suite's time reported.
10. Base code touched: `release:p3:local` passes.
11. UI: phone and desktop viewports in Chromium; Safari on a device by hand (until decided).
12. Processes, files or network touched: run on the phone.
