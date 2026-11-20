# Testing a package

Tests are fast, isolated and deterministic: every case gets its own server, sessions and stores; a test waits for
an effect it caused; nothing fails in the background but what the case asked for. A failure under load is a bug until
its cause is known.

## Setup and commands

p3 needs Node 26.3.1 or newer, tests included. On slayer the default `node` is 24:
`export PATH=/home/badlogic/node-v26.11.1-linux-x64/bin:$PATH`.

| Command (in `apps/p3`) | What |
| --- | --- |
| `npm run check` | Biome and TypeScript over p3 (the root check skips `apps/`); clean before every report |
| `npm test` | every `test/*.test.ts` and `plugins/**/*.test.ts`, from source |
| `node --conditions=source --disable-warning=ExperimentalWarning --test <file>` | one test file |
| `npm run release:p3:local -- --out /tmp/p3-release --force` (from the repository root) | builds and installs the release outside the repository and runs `test/release/*.test.ts` against it; `--bench` runs `bench/skeleton.ts` against it. The memory test is still on the old base (`old/test/release/`) |

Run the release command when your package changes what the release ships (its files, its dependencies) or what a
worker loads.

## The three tiers

**1. Plugin** (milliseconds): one facet built as production builds it, on an in-memory host. Model:
`plugins/sessions/sessions.test.ts`.

```ts
const t = await testPlugin<P3Principal>(fileURLToPath(new URL("./", import.meta.url)), {
	kind: "server", api: { name: API.name, versions: API.versions }, modules: API.modules,
	principal: { kind: "server" }, address: Server(),
	stubs: [],                                 // small facets serving the contracts t.unserved() lists
}, context);
await t.root(async (ctx) => { /* ctx.get(...), calls, asserts */ }, context, { principal: { kind: "owner" } });
assert.deepEqual(t.unserved(), []);
```

**2. End to end** (most coverage here): p3's real server in the test's process on a temporary data directory, its
session workers as real processes, its plugins built from two roots as a Pi's are: the built-in one and the tests'
own (`test/plugins/`: the probe, a third-party plugin a test drives a worker with); a test may write plugins of its own
into `<data directory>/plugins` and apply them. `test/support.ts` gives `testServer()` with `client()` (signed in as
the owner over WebSocket), `workers()` (the runner's state), `restart()` and `close()`, and `eventually` and `alive`
for effects in other processes. Model: `test/skeleton.test.ts`.

**3. The command** (a few cases): `p3` launched as processes of its own on a temporary home. Model:
`test/command.test.ts`.

**4. The release** (`test/release/release.test.ts`, run by `npm run release:p3:local` against the install it makes
outside the repository): what the package holds, the command, a worker forked from the release's own bundle, and a
third-party plugin written against the installed API alone (type-checked, loaded from the Pi's user root, called by a
client of the compiled API). Run the bench against the install with `--release` (or the script's `--bench`).

## What every package tests

1. **Each case of the plan,** in its tier, named after the rule it pins.
2. **Effects the test caused:** `until(member, done, ctx)` (`test/until.ts`) for changes made elsewhere; after a call
   on the same reference the value is already there. No sleeps for synchronization.
3. **Access:** every object refuses the principals it does not serve (`forbidden`); a person sees only what their
   admission allows.
4. **Reload:** every facet you touch, reloaded while used (a list open, a worker held): nothing lost, no error. Model:
   `test/skeleton.test.ts`, "an apply ships a changed worker plugin to a running worker".
5. **Query plans:** for every named query, `EXPLAIN QUERY PLAN` of the SQL Chord runs (first page and after a
   bookmark) searches the named index with no temporary B-tree. Model: `test/plans.test.ts`.
6. **Counted work:** Chord counts its work as metrics (`chord.query.runs`, `chord.query.probes`, `chord.link.*`);
   assert them per common action through the in-memory telemetry adapter. Model: the sessions plugin's
   "runs only the reads that show a renamed session" (`plugins/sessions/sessions.test.ts`).
7. **GC:** every cache is a `WeakMap`; drop its owner, collect, assert the entry is gone:

   ```ts
   setFlagsFromString("--expose-gc");
   const gc = runInNewContext("gc") as () => void;
   const ref = (() => new WeakRef(makeOwner()))();
   for (let i = 0; i < 10 && ref.deref() !== undefined; i++) { await new Promise((r) => setImmediate(r)); gc(); }
   assert.equal(ref.deref(), undefined);
   ```

8. **Reviewers' reproductions** become regression tests.
9. **Mutation check** before reporting: undo each rule and fix one at a time in a copy under `/tmp`; a test must fail
   for each. The copy needs its own package links: copy `apps/p3` to `/tmp/x/apps/p3` and make
   `/tmp/x/node_modules/@earendil-works/` a directory of links, `p3` to the copy and every other entry to the
   repository's (linking the whole scope makes p3 resolve to the checkout, and mutations do nothing).
10. **Serial and loaded:** the suite passes with `--test-concurrency=1` and with four `npm test` at once.
11. **No leaks:** a failed case closes its sockets and processes (`t.after`, `finally`); one leak hangs the runner.

## UI tests

p3 has no page or terminal client yet. When they come:

- **Automated:** headless Chromium driven over the DevTools protocol, as p2 does (`apps/p2/test/p2/browser.ts`). Every
  case at a phone viewport (390×844, touch emulated) and a desktop one (1280×900). On slayer:
  `CHROMIUM_BIN=/home/badlogic/.local/bin/chromium-docker`. Browser tests run only when asked, never in `npm test`.
- **By hand, at sign-off:** people with the devices check Safari on iOS, Firefox on Android and Chrome on Android, and
  note on the Linear issue what they used and found.

## Android (the phone)

p3 runs on Android under Termux (Node 26.3.1). Known differences:

- no hard links (write a temporary file and rename it);
- no `/proc/<pid>/task/<pid>/children` (scan `/proc/*/stat` for the parent; `childrenOf` in `bench/skeleton.ts`);
- at most 32 child processes per app: Android kills processes beyond that, the test runner included;
- everything is about ten times slower to start than on slayer.

A package that touches processes, files or the network runs its tests on the phone before sign-off.
