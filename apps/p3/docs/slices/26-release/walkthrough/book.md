---
title: p3 slice 26: the release build
cover: Slice 26 / Taken Apart
kicker: A walkthrough · p3 slice 26 · 2026-11-17
subtitle: The package, the command, the background server and the worker's memory, every file with its code, followed through real runs on slayer
stats:
  - 252 ms | plain `p3`, nothing running, to its owner link (release)
  - 18.5 MiB | an idle session worker, settled (was 30.3)
  - 167 | tests: 134 from source, 33 against the install
  - 101 | rules undone one at a time (mutation check)
note: |
  For the owner, who reviews slice 26 before it is committed. Self-contained: every piece of code that matters is
  printed here, from the uncommitted tree in `/home/badlogic/pi` (on top of `4afe78de1`; slice 1's redo is in the same
  tree, approved, also uncommitted). The brief is `apps/p3/docs/slices/26-release.md`; its "As built" is what this
  walkthrough follows. The traces are real runs of the installed release (`/tmp/p3-release`, built from this tree),
  Node 24.4.1 on slayer, with `HOME` pointed at a scratch directory. Code blocks are the files' text; imports are left
  out where they say nothing.
colophon: p3 slice 26 walkthrough · first edition · 2026-11-17 · apps/p3, packages/chord
---

# Every File {.preface .nodrop}

Slice 26 packages p3 as it would ship to npm: one package, `@earendil-works/p3`, with a command `p3`, the server's
base code bundled (no TypeScript at run time), the built-in plugins as source, and the API with its types for
third-party plugins. The command runs a Pi in the background under a supervisor, says whether it runs, stops it, and
keeps several Pis apart. A local command builds the package, packs it, installs it outside the repository and runs the
release tests there. On the way the session worker lost a third of its memory.

These are all the files the slice created or changed. Sizes are lines, as the files are now.

## The command and its processes (base code, created)

| File | Lines | What it is for |
| --- | --- | --- |
| `bin.ts` | 127 | the `p3` command: the command line, the foreground server (`p3 server`), the dispatch to the commands |
| `supervisor.ts` | 101 | the background server's supervisor: runs `p3 server` as its child, restarts it after a crash |
| `src/commands.ts` | 300 | `start` (plain `p3`), `status`, `stop`, `restart`, `list` |
| `src/ask.ts` | 163 | how a command talks to a running server: the identity proof, then the owner's request on the same connection |
| `src/pi.ts` | 46 | a Pi is its data directory: `--pi`, `--dir`, the default; the first port; the named Pis |
| `src/install.ts` | 56 | where p3's files are, in a checkout or in the built package; the worker's V8 flags; the version |
| `src/minimum-node.ts` | 18 | the oldest Node p3 runs on, checked before anything else |

`bin.ts` and `src/install.ts` existed in slice 1's second printing at 43 and 31 lines; everything they do beyond
starting one foreground server is this slice's.

## The kit (`src/kit/`)

| File | Lines | Created or changed |
| --- | --- | --- |
| `running.ts` | 186 | created: `server.json` and `supervisor.json`, the two locks, `holder` (who runs), `processStart` |
| `identity.ts` | 61 | created: `GET /_p3/identity`, the server proves who it is |
| `stop.ts` | 31 | created: `POST /_p3/stop`, the owner's stop over HTTP |
| `config.ts` | 39 | created: `pi.json`, the Pi's id and port |
| `start-server.ts` | 224 | changed (149 in slice 1): the record in two steps, the Pi's port, a busy port fails at once, the identity and stop facets, more core facets for tests |
| `owner.ts` | 137 | changed (112): `POST /_p3/owner/link`, a fresh owner link for a signed-in owner |
| `layout.ts` | 125 | changed (104): `pi.json`, `logs/server.log`, the workers' compile cache |
| `worker.ts` | 61 | changed (47): the compile cache flushed after the start; the memory test's `session` hook |
| `sign-ins.ts` | 308 | changed (300): the cookie is named after the Pi (`p3-<id>`) |
| `app.ts` | 116 | changed (108): the close removes `server.json` before it releases the lock |

## The build and the package

| File | Lines | What it is for |
| --- | --- | --- |
| `scripts/build-release.ts` | 212 | created: `npm run build`: one bundle per process, the launcher, the guards, `tsc` for the API |
| `scripts/release-local.ts` | 137 | created: `npm run release:p3:local`: build, pack four packages, install outside the repository, test |
| `tsconfig.build.json` | 13 | created: compiles the API modules with declarations and declaration maps |
| `package.json` | 59 | changed: renamed `@earendil-works/p3`; `bin`, `exports`, `files`, the five dependencies, two dev ones, the scripts |
| `tsconfig.json` | 12 | changed: `declaration: false` gone, `scripts/` included |
| `biome.json` | 24 | changed: `scripts/` linted |
| `README.md` | 44 | changed: the command, the package, how to build a release |
| `src/app.ts` | 36 | changed: the API's name and module map, `@earendil-works/p3/v1` |
| `plugins/sessions/package.json` | 5 | changed: the plugin is `@earendil-works/p3-sessions` |
| `server.ts`, `worker.ts` | 37, 9 | changed: `startP3` takes `onStop` and the Pi's port; the start script moved to `bin.ts` |
| root `package.json` | +1 | the script `release:p3:local` |
| `package-lock.json` | +21 −4 | the workspace's entry renamed, with esbuild, `ws`, its `bin`, pi-ai and Durable as dev dependencies |

Every import of `@p3/app` (base code, the plugin, tests, bench) became `@earendil-works/p3`. Those changes are one line
each and are not listed.

## Tests and the bench

| File | Lines | What it is for |
| --- | --- | --- |
| `test/commands.ts` | 939 | the command's 20 cases, written once, run from source and from the install |
| `test/commands.test.ts` | 58 | runs them from source; `stop` with no way to identify a process |
| `test/launched.ts`, `launched.test.ts` | 163, 78 | p3 launched as a process: from source, or from an install; SIGTERM and SIGINT with workers |
| `test/end-to-end.ts` | 52 | the end-to-end case, one function, run in process, launched from source and from the install |
| `test/gate.ts` | 55 | a preload that holds a launched server or supervisor still at one point of its start |
| `test/no-signals.ts`, `old-node.ts` | 6, 4 | preloads: a command without signals; a process that sees itself as an old Node |
| `test/kit/running.test.ts`, `identity`, `stop`, `config` | 238, 50, 33, 43 | the new kit files |
| `test/kit/start-server.test.ts`, `owner`, `sign-ins` | 172, 126, 320 | changed: busy port, the Pi's port, a failed start's record; the owner link route; the cookie's name |
| `test/pi.test.ts`, `minimum-node.test.ts` | 51, 21 | Pis and their names; the oldest Node |
| `test/build-release.test.ts` | 235 | the build into a temporary directory, and its four guards |
| `test/release-local.test.ts` | 68 | the output directory the release script may use |
| `test/release/release.test.ts` | 351 | against the install: contents, warnings, end to end, SIGTERM, every command case, a third-party plugin |
| `test/release/memory.test.ts`, `test/memory/*` | 294; 42, 155, 209, 12 | a session worker's memory with a real Durable harness and pi-ai against a local stub |
| `bench/slice-1.ts` | 419 | changed: a launched server in both paths, the commands' times, memory read settled |

## Chord (`packages/chord/`)

| Change | Files | Why p3 needs it |
| --- | --- | --- |
| export the types `Method`, `LiteralsSchema`, `HostKeyed` (decision F) | `src/contracts/index.ts` (+3), README (+4), CHANGELOG, `test/contracts/schema.test.ts` (+77) | a plugin that emits declarations for its contracts must be able to name them |
| the worker base minified, names kept | `src/node/workers/base.ts` (+4), README, CHANGELOG, `test/node/workers/base.test.ts` (+20) | every worker holds the base's source text |

The other Chord changes in the tree (`memberNames`, `links.opened(…, close)`) are slice 1's.

## Ten things to know

:::findings
1. **One package, `@earendil-works/p3`.** Its `package.json` in the workspace is the one that ships: `bin`, `exports`
   with `source`, `types` and `import`, `files`, exact dependencies.
2. **Three bundles, one per process.** `main.js` (the command and the server), `worker.js`, `supervisor.js`; Chord,
   the kit and `ws` inlined; only esbuild left to `node_modules`. A worker holds none of the server's code.
3. **Plain `p3` starts a supervisor, not a server.** The supervisor runs `p3 server` as its child, restarts it after a
   crash (1 s, doubling to 30 s) and ends with it when it stops.
4. **A file alone is never believed.** `server.json` counts only while its lock is held, and only of the process that
   wrote it; a running server must also prove itself over HTTP.
5. **The proof is an HMAC of the command's nonce, keyed by the owner token.** Another user's program on the port
   cannot answer it; the owner token is sent only over the connection the proof came over.
6. **`stop` asks first.** `POST /_p3/stop` as the owner; a signal only for a process that does not answer, or a
   supervisor between restarts, and only one whose record proves who it is. It waits for a server that starts.
7. **A Pi is its data directory.** Its own id, port, cookie name and locks; two Pis on one machine share nothing.
8. **Types for third-party plugins ship,** compiled by `tsc` against the workspace, naming Chord through the package;
   Chord exports three more types so a contract's declaration can be written down.
9. **An idle worker went from 30 to 18.5 MiB,** its peak under load from 77 to 45: a bundle of its own, SDKs bundled,
   three V8 flags, Chord's base minified, a warm compile cache. The budget is 55 MiB on every Node.
10. **Every rule has a test that fails without it:** 101 rules undone one at a time; three survivors, each shown to be
    equivalent.
:::

## Words used throughout

A **Pi** is one p3 installation's data: a **data directory** (`~/.pi/p3`, `~/.pi/p3/pis/<name>`, or any `--dir`) with
its store, its sign-ins and its config. The **server** is the process that serves a Pi; a **worker** is a session's
process, forked by the server. The **supervisor** is the background process that runs the server as its child. A
**record** is `server.json` or `supervisor.json`, what a process says about itself; a **lock** is Chord's
`processLock`, an abstract Unix socket held while the process lives. A record is **believed** only under the rules of
chapter IV. The **owner token** is the owner's device sign-in in the file `owner-token` (mode 0600); the **owner
link** is the one-time link that signs a browser in. The **release** is the installed package; the **source path** is
`node --conditions=source bin.ts` from the checkout. **USS** is a process's unique memory: what it alone holds.

# What Ships {#ships lede="One manifest for development and the release; an install that resolves nothing from the repository."}

## The manifest

`apps/p3/package.json` is the shipped manifest (the second part's decision: before it, the build generated one). A
checkout resolves `source`; an install resolves `types` and `import`.

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
	"files": ["dist", "plugins", "!plugins/**/*.test.ts", "src/api", "src/kit/contribute.ts", "src/kit/forward.ts",
	          "src/kit/info.ts", "src/principals.ts", "README.md"],
	"scripts": {
		"build": "node --disable-warning=ExperimentalWarning scripts/build-release.ts",
		"test": "node --conditions=source … --test … \"test/*.test.ts\" \"test/kit/*.test.ts\" \"plugins/**/*.test.ts\"",
		"test:release": "node --conditions=source … --test --test-concurrency=1 … \"test/release/*.test.ts\""
	},
	"engines": { "node": ">=24.4.0" },
	"dependencies": {
		"@earendil-works/chord": "1.5.2", "@earendil-works/pi-schema": "1.5.2", "@earendil-works/pi-telemetry": "1.5.2",
		"esbuild": "0.28.2", "ws": "8.21.0"
	},
	"devDependencies": { "@earendil-works/pi-ai": "1.5.2", "@earendil-works/pi-durable": "1.5.2" }
}
```

Why each dependency is there, although the server's bundle inlines most of it:

| Dependency | The server loads it? | Why it is installed |
| --- | --- | --- |
| esbuild | yes | Chord's plugins component bundles every plugin facet at start, and the worker base after the listen |
| Chord, pi-schema, pi-telemetry | no (inlined) | the declarations a third-party plugin's `tsc` reads, and the compiled API for code outside the server |
| `ws` | no (inlined) | the compiled `@earendil-works/p3/v1/server` re-exports Chord's `Http`, whose module loads `ws` (review round 2, owner: pinned to Chord's 8.21.0) |
| pi-ai, Durable (dev) | no | the memory test's real harness |

## The install

What `npm run release:p3:local -- --out /tmp/p3-release` leaves in `install/node_modules/@earendil-works/p3/`, this
tree's build:

```text
dist/p3.js                      472 B    the launcher (#!/usr/bin/env node)
dist/minimum-node.js            442 B    the oldest-Node check, no imports
dist/main.js                995 KiB      the command and the server: kit, Chord, pi-schema, pi-telemetry, ws inlined
dist/worker.js              792 KiB      a session worker's entry, none of the server's code
dist/supervisor.js            9 KiB      the supervisor
dist/api/v1/{index,server,worker}.{js,d.ts,d.ts.map}     the API, compiled by tsc
dist/kit/{contribute,forward,info}.*, dist/principals.*  what the API imports
src/api/v1/*.ts, src/kit/{contribute,forward,info}.ts, src/principals.ts      the API's source, for "go to definition"
plugins/sessions/{contract,contract.server,server,worker}.ts, package.json     the built-in plugin, as source
package.json, README.md
```

The tarball is 486 kB, `dist/` 1.9 MB installed. Beside it: Chord 15 MB (its package ships sources and declarations
whole), pi-schema 1.2 MB, pi-telemetry 0.3 MB, esbuild 11 MB (its binary for the platform). The server loads none of
Chord's installed files: its Chord is the one in `main.js`.

## The build

`scripts/build-release.ts`, the entry point. Real output of `npm run build` in `apps/p3` (0.48 s):

```text
> node --disable-warning=ExperimentalWarning scripts/build-release.ts
Built /home/badlogic/pi/apps/p3/dist: 26 files, 1797 KiB of bundles
```

```ts
export async function buildRelease(dist: string = join(P3, "dist")): Promise<Built> {
	const manifest = JSON.parse(await readFile(join(P3, "package.json"), "utf8")) as Manifest;
	checkVersions(manifest, await workspaceVersions(Object.keys(manifest.dependencies)));
	await rm(dist, { recursive: true, force: true });
	await mkdir(dist, { recursive: true });
	const options = bundleOptions(dist);
	// One build per process, no chunk shared between them: a chunk the worker shared with the server would bring it esbuild's JS API,
	// `ws`, HTTP and the server side of Chord's workers (about 1.5 MiB per worker, and its start).
	const bundle = async (name: string, entry: string) =>
		(await build({ ...options, entryPoints: { [name]: join(P3, entry) } })).metafile;
	const [main, worker, supervisor, minimum] = await Promise.all([
		bundle("main", "bin.ts"),
		bundle("worker", "worker.ts"),
		bundle("supervisor", "supervisor.ts"),
		// No banner: the launcher loads it on any Node, before anything else, and it imports nothing.
		build({ ...options, banner: {}, entryPoints: { "minimum-node": join(P3, "src", "minimum-node.ts") } }).then(
			(built) => built.metafile,
		),
	]);
	for (const metafile of [main, worker, supervisor, minimum]) checkExternals(metafile);
	const outputs = { ...main.outputs, ...worker.outputs, ...supervisor.outputs, ...minimum.outputs };
	checkPlacement({ outputs }, "src/install.ts", "main.js");
	checkLean(worker, "worker.js");
	checkLean(supervisor, "supervisor.js");
	await writeFile(join(dist, "p3.js"), LAUNCHER);
	await chmod(join(dist, "p3.js"), 0o755);
	const tsc = join(REPOSITORY, "node_modules", "typescript", "bin", "tsc");
	execFileSync(process.execPath, [tsc, "-p", join(P3, "tsconfig.build.json"), "--outDir", dist], { stdio: "inherit" });
	// … the files listed and counted
}
```

Four esbuild builds run at once: one per process, and the oldest-Node check alone. Before the worker-only entry (owner,
after review round 3) the three processes were one build with a shared chunk; the worker then imported esbuild's JS
API, `ws` and Node's HTTP with it. Chapter XI measures what that cost.

The options every process's bundle gets:

```ts
export function bundleOptions(dist: string) {
	return {
		absWorkingDir: P3, outdir: dist, bundle: true,
		// Within one process's build only: what an entry imports lazily (`import()`) stays a chunk of its own, loaded
		// when it is asked for, not at the process's start.
		splitting: true,
		chunkNames: "chunks/[name]-[hash]",
		format: "esm", platform: "node", target: "node24",
		// Workspace packages resolve to their sources, as in development.
		conditions: ["source"],
		// No path alias of the monorepo applies: imports resolve as an installed package's would.
		tsconfigRaw: { compilerOptions: {} },
		external: [...EXTERNAL, ...OPTIONAL],            // ["esbuild"], ["bufferutil", "utf-8-validate"]
		// `ws` is CommonJS: its `require` of Node's builtins needs one in an ES module.
		banner: {
			js: 'import { createRequire as __p3CreateRequire } from "node:module"; const require = __p3CreateRequire(import.meta.url);',
		},
		minifySyntax: true, minifyWhitespace: true, legalComments: "none",
		sourcemap: false, metafile: true, logLevel: "warning",
	} as const satisfies BuildOptions;
}
```

- **`conditions: ["source"]`:** esbuild bundles the TypeScript sources directly (Chord's `exports` have a `source`
  condition pointing at `src/`). No `tsc` step for the bundles: p3 emits nothing else, and `npm run check`
  type-checks.
- **Minified, names kept:** `minifySyntax` and `minifyWhitespace`, never `minifyIdentifiers`: Chord and the kit read
  `name` of functions and classes (decision D). No source maps.
- **`splitting`:** a lazy `import()` stays a chunk loaded only when asked for. This tree's bundles have none, but a
  worker that imports pi-ai gets each provider's SDK as a chunk of its own (the memory test's worker does).
- **The banner:** without it `ws` fails at its first `require("events")`. A mutation removing it is caught by every
  release test that starts the command.

### The guards

Four checks fail the build, each with its test in `test/build-release.test.ts` ("the build's guards"):

```ts
/** Fails when the bundle left an import to `node_modules` that is not allowed: it would be missing in an install. */
export function checkExternals(metafile: Pick<Metafile, "inputs">): void {
	const imports = Object.values(metafile.inputs).flatMap((input) => input.imports);
	const allowed = (path: string) => isBuiltin(path) || EXTERNAL.includes(path) || OPTIONAL.includes(path);
	const left = imports.filter(({ external, path }) => external === true && !allowed(path));
	if (left.length > 0) {
		const names = [...new Set(left.map(({ path }) => path))].sort().join(", ");
		throw new Error(`build-release: the bundle left unexpected external imports: ${names}`);
	}
}
```

```ts
/**
 * Fails unless the module `input` is in the output `output` of `dist/` and in no other: `src/install.ts` finds p3's
 * files relative to its own file, so it must stay in `dist/main.js`, not move to a chunk or another bundle.
 */
export function checkPlacement(metafile: Pick<Metafile, "outputs">, input: string, output: string): void {
	const found = Object.entries(metafile.outputs).filter(([, { inputs }]) => Object.hasOwn(inputs, input));
	if (found.length !== 1 || !found[0]![0].endsWith(`/${output}`)) {
		const where = found.map(([path]) => path).join(", ") || "no output";
		throw new Error(`build-release: ${input} must be bundled into ${output}, found in ${where}`);
	}
}
```

```ts
/** What a worker's or the supervisor's bundle must not import: the server's packages, and Node's HTTP. */
const SERVER_IMPORTS = ["esbuild", "http", "https", "node:http", "node:https"];

/** The modules of the server's that a worker's or the supervisor's bundle must not hold. */
const SERVER_INPUTS = [
	/\/node_modules\/(ws|esbuild)\//,
	/\/chord\/src\/node\/(http\/http|http\/upgrades|workers\/workers|workers\/base|plugins\/build)\.ts$/,
];

export function checkLean(metafile: Pick<Metafile, "outputs">, output: string): void {
	if (!Object.keys(metafile.outputs).some((path) => path.endsWith(`/${output}`))) {
		throw new Error(`build-release: no output ${output}`);
	}
	const server = Object.values(metafile.outputs).flatMap((found) => [
		...found.imports.filter(({ path }) => SERVER_IMPORTS.includes(path)).map(({ path }) => path),
		...Object.keys(found.inputs).filter((input) => SERVER_INPUTS.some((pattern) => pattern.test(input))),
	]);
	if (server.length > 0) {
		throw new Error(`build-release: ${output} holds the server's ${[...new Set(server)].sort().join(", ")}`);
	}
}
```

```ts
/**
 * Fails unless each dependency is pinned to the version the workspace has (`versions`): the bundle inlines the
 * workspace's Chord, the package's types come from the dependency, and the two must be one version.
 */
export function checkVersions(manifest: Manifest, versions: Readonly<Record<string, string>>): void {
	for (const [name, pinned] of Object.entries(manifest.dependencies)) {
		if (versions[name] !== pinned) {
			throw new Error(`build-release: ${name} is pinned to ${pinned}, the workspace has ${versions[name]}`);
		}
	}
}
```

`checkLean` looks at every output of the worker's build, lazy chunks included: a lazy chunk that pulled in `ws` would
still be loaded by a worker that asks for it.

## The launcher

`dist/p3.js`, the file `bin` names, written by the build as text:

```js
#!/usr/bin/env node
await import("./minimum-node.js");
const { enableCompileCache } = await import("node:module");
enableCompileCache();
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
	const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
	if ((typeof warning === "string" ? type : warning?.name) === "ExperimentalWarning") return;
	return emitWarning.call(this, warning, ...rest);
};
await import("./main.js");
```

Three things, in an order that matters:

1. **No static import.** ES modules are linked before any of them runs. A static `import "./main.js"` on Node 22.12
   fails linking on `node:sqlite` (no such builtin there) before the version check could print anything; on Node 20,
   on `enableCompileCache`. So everything is `import()`, and the check runs first (Opus, review round 5).
2. **The compile cache.** `enableCompileCache()` before `main.js` loads: V8's compiled code of the bundle is written to
   Node's cache directory and read on the next start. That is most of the warm launch's gain.
3. **Experimental warnings dropped where they are emitted,** every other warning untouched. Round 1's first version
   replaced Node's warning printer and so broke `--no-warnings`, `--redirect-warnings` and other listeners; the release
   test preloads a listener and emits an ordinary warning, a deprecation and two experimental ones, plain, with
   `--no-warnings` and with `--redirect-warnings`.

`dist/minimum-node.js` is `src/minimum-node.ts` bundled alone, a dozen statements:

```ts
/** The oldest Node p3 runs on: `engines.node` in its `package.json`. */
export const MINIMUM_NODE = "24.4.0";

/** Whether Node `version` (`process.versions.node`, as `24.4.1`) is older than `MINIMUM_NODE`. */
export function tooOld(version: string): boolean {
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	const [minMajor = 0, minMinor = 0, minPatch = 0] = MINIMUM_NODE.split(".").map(Number);
	return major !== minMajor ? major < minMajor : minor !== minMinor ? minor < minMinor : patch < minPatch;
}

if (tooOld(process.versions.node)) {
	console.error(`p3: needs Node ${MINIMUM_NODE} or newer; this is Node ${process.versions.node}`);
	process.exit(1);
}
```

From a checkout, `bin.ts` imports it as its first line. Run against the installed release with a preload that makes
the process see itself as Node 22.12.0 (`test/old-node.ts`):

```text
$ P3_TEST_NODE=22.12.0 NODE_OPTIONS=--import=…/test/old-node.ts p3 status
p3: needs Node 24.4.0 or newer; this is Node 22.12.0
exit 1
```

The real check was run with Node 20.19.5, 22.12.0, 22.21.1 and 24.0.0: each prints that line for `--version` and
`status`. Versions are compared by number: a mutation comparing them as text (`"24.10.0" < "24.4.0"`) is caught by
"compares versions by number, not as text".

## The API's compile

`tsconfig.build.json`:

```json
{
	"extends": "../../tsconfig.base.json",
	"compilerOptions": {
		"outDir": "./dist", "rootDir": "./src",
		"module": "NodeNext", "moduleResolution": "NodeNext",
		"customConditions": ["source"],
		"sourceMap": false, "inlineSources": false
	},
	"include": ["src/api/v1/*.ts"]
}
```

The base gives `declaration` and `declarationMap`. `tsc` follows the three API modules into what they import
(`src/kit/{forward,contribute,info}.ts`, `src/principals.ts`) and writes JavaScript, `.d.ts` and `.d.ts.map` for each.
It compiles against the workspace's sources, yet the declarations name Chord through the package, as an install
resolves it. Part of `dist/api/v1/index.d.ts`:

```ts
export * from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
export { contribute } from "../../kit/contribute.ts";
export { forward } from "../../kit/forward.ts";
```

A build test checks that no emitted declaration names a path into `node_modules` or `packages/chord`. **Two instances
of one version:** the server passes plugins its own API modules (Chord inlined in `main.js`); the compiled ones are for
type checks and for code that runs outside the server (a plugin's own tests). `checkVersions` keeps them one version.

## The local release

`scripts/release-local.ts`, run from the repository root as `npm run release:p3:local -- --out /tmp/p3-release
[--force] [--skip-test] [--bench]`:

```ts
const out = await prepareOutput(values.out, values.force);
for (const directory of DEPENDENCIES) execFileSync("npm", ["run", "build"], { cwd: directory, stdio: "inherit" });
const built = await buildRelease();
const tarballs = join(out, "tarballs");
await mkdir(tarballs);
const p3 = pack(P3, tarballs);
const dependencies = DEPENDENCIES.map((directory) => pack(directory, tarballs));
// An isolated consumer: a private package whose one dependency is p3's tarball. Its dependencies of the workspace
// come from their tarballs too, not from the registry.
const install = join(out, "install");
await mkdir(install);
const consumer = {
	private: true,
	type: "module",
	dependencies: { [p3.name]: `file:${p3.tarball}` },
	overrides: Object.fromEntries(dependencies.map(({ name, tarball }) => [name, `file:${tarball}`])),
};
await writeFile(join(install, "package.json"), `${JSON.stringify(consumer, null, "\t")}\n`);
npm(["install", "--omit=dev", "--no-audit", "--no-fund"], install);
await symlink(join("install", "node_modules", ".bin", "p3"), join(out, "p3"));
if (!values["skip-test"]) run(["npm", "run", "test:release"], install);
```

`npm` always runs with `--ignore-scripts` (the `npm` helper adds it): no lifecycle script of any package runs, as the
repository's install rules ask. The overrides are needed because npm's 1.5.2 of Chord predates what p3 uses (named
queries, admission, `memberNames`): until the next lockstep version is published, the install takes the workspace's
Chord as a tarball (Carried).

### What `--force` may remove

The first version removed the whole output directory with `--force`, as coding-agent's script does; the reviewers
(Sol, Astra) found paths where that was the repository or its parent. `prepareOutput`:

```ts
export async function prepareOutput(out: string, force: boolean): Promise<string> {
	const path = await realOf(resolve(out));
	const repository = await realpath(REPOSITORY);
	if (within(repository, path) || within(path, repository)) {
		throw new Error(`release-local: ${path} must be outside the repository, and not above it`);
	}
	await mkdir(path, { recursive: true });
	const present = await readdir(path);
	if (present.length > 0) {
		if (!present.includes(MARKER)) {
			throw new Error(`release-local: ${path} holds something else than a release of this script; not touched`);
		}
		if (!force) throw new Error(`release-local: ${path} holds a release (pass --force to replace it)`);
		for (const name of MADE) await rm(join(path, name), { recursive: true, force: true });
	}
	await writeFile(join(path, MARKER), "A local release of p3, made by apps/p3/scripts/release-local.ts.\n");
	return path;
}

/** Whether `path` is `directory` or lies in it, by path segments. */
function within(path: string, directory: string): boolean {
	const from = relative(directory, path);
	return from === "" || !(from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from));
}
```

| `--out` | Result |
| --- | --- |
| `/`, `/home`, the repository, `apps/p3` | refused: above or the repository itself |
| `~/pi/..p3-release` | allowed: a sibling named `..p3-release`, not inside (`startsWith("..")` would have said inside) |
| a link to the repository's parent | refused: the existing part is resolved through links (`realOf`) |
| a directory with your files and no `.p3-release` | never touched, also with `--force` |
| a previous release | refused without `--force`; with it only `.p3-release`, `tarballs/`, `install/`, `p3` go |

`test/release-local.test.ts`, four tests with the reviewers' paths; seven mutations of this function are caught.

# Where p3's Files Are {#install lede="One module knows both layouts; nothing else builds a path into p3."}

`src/install.ts` is asked for the plugins root, the entries of the three kinds of process with their Node flags, the
worker's V8 flags and the version. In a checkout its file is `src/install.ts`; in the release it is inside
`dist/main.js`. Both lie directly under p3's root, which is why `checkPlacement` keeps it in `main.js`.

```ts
/** Whether this is a source checkout: its files are TypeScript. */
const SOURCE = import.meta.filename.endsWith(".ts");

/** p3's root: `apps/p3` of a checkout, or the installed package. */
const ROOT = join(import.meta.dirname, "..");

/** The built-in plugins root: plugins are source in both layouts (the server builds them when it starts). */
export const PLUGINS = join(ROOT, "plugins");

/** The flags a source checkout's processes need: workspace sources resolve, and no experimental warning prints. */
const SOURCE_FLAGS = ["--conditions=source", "--disable-warning=ExperimentalWarning"];

export const WORKER_V8_FLAGS: readonly string[] = ["--liftoff-only", "--optimize-for-size", "--max-semi-space-size=4"];

export const WORKER: WorkerOptions = SOURCE
	? { entry: join(ROOT, "worker.ts"), execArgv: [...SOURCE_FLAGS, ...WORKER_V8_FLAGS] }
	: {
			entry: join(import.meta.dirname, "worker.js"),
			execArgv: ["--disable-warning=ExperimentalWarning", ...WORKER_V8_FLAGS],
		};

/** Node's arguments that run the `p3` command of this install (the release's launcher filters the warnings). */
export const COMMAND: readonly string[] = SOURCE
	? [...SOURCE_FLAGS, join(ROOT, "bin.ts")]
	: [join(import.meta.dirname, "p3.js")];

/** Node's arguments that run the background server's supervisor (`supervisor.ts`). */
export const SUPERVISOR: readonly string[] = SOURCE
	? [...SOURCE_FLAGS, join(ROOT, "supervisor.ts")]
	: [join(import.meta.dirname, "supervisor.js")];

/** p3's version: its `package.json`'s. */
export function version(): string {
	return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}
```

| | Checkout | Release |
| --- | --- | --- |
| this module | `apps/p3/src/install.ts` | `…/p3/dist/main.js` |
| `ROOT` | `apps/p3` | `node_modules/@earendil-works/p3` |
| the worker | `node --conditions=source … worker.ts` | `node … dist/worker.js` |
| the command a supervisor runs | `node --conditions=source … bin.ts` | `node dist/p3.js` |
| `version()` | `apps/p3/package.json` | the installed `package.json` |

Undone either way, the layout is caught: "the source layout read as built" fails the end-to-end case from source,
"the built layout read as source" every launched case of the release test.

The worker's entry is `dist/worker.js`, but no worker loads that file directly: Chord's workers component bundles it
again at start into the worker base (`cache/worker/`, written after the listen), which every fork runs. Chapter XI says
what that costs and why it stays for now.

# The Command Line {#bin lede="One file reads the command line, refuses what does not fit, and either serves or dispatches."}

`bin.ts`, the whole file but the usage text. The real usage:

```text
Usage: p3 [command] [--pi <name> | --dir <path>] [--port <n>]

A Pi is its data directory: ~/.pi/p3 (the default Pi), ~/.pi/p3/pis/<name> (--pi) or any directory (--dir).

Commands:
  (none)     Start the Pi's server in the background unless it runs; print its port and an owner link (also: start)
  server     Run the Pi's server in the foreground
  status     Say whether the Pi's server runs: its port, pid, data directory, version and start time
  stop       Stop the Pi's server; returns once it is gone
  restart    Stop, then start in the background
  list       The Pis on this machine and their state

Options:
  --pi <name>   A named Pi (lower case letters, digits, - and _)
  --dir <path>  A Pi in any directory
  --port <n>    The port for this start, on 127.0.0.1 (0: a free one). Without it a Pi listens on its own port:
                8789 for the default Pi, else a free one taken at its first start and kept
  --version     Print p3's version
  --help        Print this help
```

```ts
// First: a Node too old for p3 ends here, before any other module runs.
import "./src/minimum-node.ts";

const { values, positionals } = commandLine();
if (values.help === true) console.log(USAGE);
else if (values.version === true) console.log(version());
else await run(positionals, values);

async function run([command = "start", ...rest]: readonly string[], flags: Flags): Promise<void> {
	const starts = command === "start" || command === "server" || command === "restart";
	if (rest.length > 0 || (flags.pi !== undefined && flags.dir !== undefined)) usage();
	if (flags.pi !== undefined && !isPiName(flags.pi)) usage();
	// Digits only: a blank is no port (`Number("")` is 0, a free one).
	if (flags.port !== undefined && !(starts && /^\d{1,5}$/.test(flags.port) && Number(flags.port) <= 65535)) usage();
	if (command === "list" && (flags.pi !== undefined || flags.dir !== undefined)) usage();
	const dataDir = dataDirOf(flags);
	const port = flags.port === undefined ? undefined : Number(flags.port);
	try {
		if (command === "server") await serve(dataDir, port);
		else if (command === "start") process.exitCode = await start(dataDir, port, context);
		else if (command === "restart") process.exitCode = await restart(dataDir, port, context);
		else if (command === "status") process.exitCode = await status(dataDir, context);
		else if (command === "stop") process.exitCode = await stop(dataDir, context);
		else if (command === "list") process.exitCode = await list(defaultDataDir(), context);
		else usage();
	} catch (error) {
		const busy = error instanceof ListenFailed && error.code === "EADDRINUSE";
		const message = error instanceof Error ? error.message.replace(/^startServer: /, "") : String(error);
		console.error(
			busy ? `p3: port ${error.address.port} is in use; pass --port <n> or stop what uses it` : `p3: ${message}`,
		);
		process.exit(1);
	}
}
```

Exit codes: 0; 1 for a failure (`status`: not running; `stop` of nothing is 0); 2 for a command line p3 does not
understand. `--port ""`, ` `, `x`, `-1`, `1.5` and a missing value are 2 (before round 1 `--port ""` was a free port).
`--pi Bad` and `--pi a --dir b` are 2.

## The foreground server

```ts
/**
 * Runs the server on `dataDir` in the foreground until a signal or the owner's stop over HTTP closes it. A signal
 * during the start closes it once the start is done (the record may say `running` before the start returns): a start
 * cut off would skip the close.
 */
async function serve(dataDir: string, port: number | undefined): Promise<void> {
	const started = Promise.withResolvers<App>();
	const stop = (): void => void started.promise.then(close);
	for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
	const app = await startP3(context, { dataDir, onStop: stop, ...(port === undefined ? {} : { port }) });
	// A supervisor hears that the server listens; its log gets no owner link (`p3` prints a fresh one).
	const supervised = process.send !== undefined;
	console.log(`p3 on ${app.dataDir}, port ${app.port()}${supervised ? "" : `. Open ${app.ownerLink()}`}`);
	process.send?.("listening");
	started.resolve(app);
}

/** Closes `app` and exits: 0, or 1 when the close failed. */
function close(app: App): void {
	app.close(context).then(
		() => process.exit(0),
		(error: unknown) => {
			console.error("p3: the close failed:", error);
			process.exit(1);
		},
	);
}
```

- **The handlers go in before the start.** Found in round 2: `stop` signalled a server whose record already said
  `running` before `bin.ts` had installed its handlers; Node's default action killed it without its close and
  `server.json` stayed behind. Now a signal during the start waits for the start (`started.promise`), then closes.
- **`onStop`** is the same `stop`: the owner's `POST /_p3/stop` ends the server exactly as `SIGTERM` does.
- **`process.send`** exists only when a supervisor forked this process with an IPC channel. The supervisor hears
  `"listening"` (chapter VIII), and its log never holds an owner link: plain `p3` asks the server for a fresh one.

`server.ts` is the rest of the foreground start:

```ts
export function startP3(
	context: Context,
	options: { readonly onStop: () => void; readonly dataDir?: string; readonly root?: string; readonly port?: number },
): Promise<App> {
	const host = "127.0.0.1";
	return startServer(
		{
			...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
			root: options.root ?? PLUGINS,
			listen:
				options.port === undefined ? { host, firstPort: firstPort(options.dataDir) } : { host, port: options.port },
			version: version(),
			worker: WORKER,
			onStop: options.onStop,
			onError: (error) => console.error("p3:", error),
		},
		context,
	);
}
```

## Which Pi

`src/pi.ts`:

```ts
/** The default Pi's port (p2 keeps 8788). Every other Pi takes a free one at its first start. */
export const DEFAULT_PORT = 8789;

export function isPiName(name: string): boolean {
	return /^[a-z0-9][a-z0-9_-]{0,31}$/.test(name);
}

export function dataDirOf(choice: PiChoice): string {
	if (choice.dir !== undefined) return resolve(choice.dir);
	return choice.pi === undefined ? defaultDataDir() : join(pisRoot(), choice.pi);
}

/** The port the Pi on `dataDir` (the default one when `undefined`) takes at its first start; 0 is a free one. */
export function firstPort(dataDir: string | undefined): number {
	return dataDir === undefined || resolve(dataDir) === defaultDataDir() ? DEFAULT_PORT : 0;
}
```

A name is a directory name as it is: no `/`, no `..`, no capital (two names differing in case would share a directory
on macOS). `namedPis()` lists the directories under `~/.pi/p3/pis/` that can name one.

# Who Runs {#running lede="A record says who a process is; a lock says it still lives; a start time says it is still the same process."}

The question every command asks first: does a server run on this data directory, and which process is it? A file
cannot answer it alone. A crashed server leaves `server.json` behind; its pid may belong to another process by now; its
port may be someone else's.

## The two records

`src/kit/running.ts`. Each of the two processes of a Pi (the server and its supervisor) holds a lock and writes a
record:

```ts
export type ProcessId = { readonly pid: number; readonly start?: string };

export type ServerState =
	| { readonly state: "starting"; readonly run: string }
	| {
			readonly state: "running";
			readonly run: string;
			/** The Pi's id (`pi.json`). */
			readonly pi: string;
			readonly port: number;
			readonly version: string;
			/** When it listened, in ms since the epoch. */
			readonly startedAt: number;
	  };

export type SupervisorState = { readonly state: "starting" | "running" };
```

Real records of this walkthrough's first run (chapter V):

```text
{"pid":2012381,"start":"96471968","state":"starting"}                                                  supervisor.json
{"pid":2012392,"start":"96471971","state":"starting","run":"089edf69f04d5c8b3d4f372855a02a2b"}           server.json
{"pid":2012392,"start":"96471971","state":"running","run":"089edf69…","pi":"af475c34a374804c",
 "port":8789,"version":"0.0.1","startedAt":1794915760822}                                               server.json
{"pid":2012381,"start":"96471968","state":"running"}                                                   supervisor.json
```

`start` is the process's start time in clock ticks since boot, field 22 of `/proc/<pid>/stat`; `run` a random id the
server made for this start.

## The locks

```ts
export async function takeLock(
	dataDir: string,
	role: Role,
	wait: number,
	context: Context,
): Promise<ProcessLock | undefined> {
	const waited = AbortSignal.timeout(wait);
	try {
		return await processLock(`p3-${role}:${dataDir}`, withAbortSignal(waited, context));
	} catch (error) {
		if (waited.aborted) return undefined;
		throw error;
	}
}
```

Chord's `processLock` binds an abstract Unix socket named after a SHA-256 of the name: the kernel frees it the moment
the process dies, however it dies. `dataDir` is always a real path (`openDataDir` resolves it), so two names of one
directory through a link are one lock, and two data directories are two locks: no Chord change was needed for several
Pis.

## `holder`: the one function that says who runs

```ts
export type Holder<R extends Role> =
	| { readonly kind: "free" }
	| { readonly kind: "unnamed" }
	| { readonly kind: "named"; readonly record: RecordOf<R> }
	| (R extends "server" ? Claimed : never);

export type Claimed = { readonly kind: "claimed"; readonly record: Running };

/** How long `holder` waits behind a lock's holder before it calls the lock held (a free lock is taken at once). */
const HELD_MS = 20;

export async function holder<R extends Role>(dataDir: string, role: R, context: Context): Promise<Holder<R>> {
	const lock = await takeLock(dataDir, role, HELD_MS, context);
	if (lock !== undefined) {
		// Nobody holds it: whatever record is there is stale. Removed under the lock, so never a starting holder's.
		await removeRecord(dataDir, role);
		await lock.release();
		return { kind: "free" };
	}
	// No file: the holder has not written it yet, or just left. A record of another process: a crashed holder's, which
	// the new one has not replaced yet (its pid may be another process's by now).
	const text = await ifExists(readFile(recordFile(dataDir, role), "utf8"));
	const record = text === undefined ? undefined : (JSON.parse(text) as RecordOf<R>);
	// A trust boundary: a file. Its pid goes into a command line (PowerShell's), its port into a request.
	if (record === undefined || !Number.isSafeInteger(record.pid) || record.pid <= 0) return { kind: "unnamed" };
	if (role === "server" && record.state === "running") {
		// TypeScript does not narrow `R` by `role`: a claimed holder is a server's, as the check above says.
		return { kind: "claimed", record: record as Running } as Holder<R>;
	}
	if (record.start === undefined || (await processStart(record.pid)) !== record.start) return { kind: "unnamed" };
	return { kind: "named", record };
}
```

The four answers, and what a command does with each:

| `holder` says | Situation | A command |
| --- | --- | --- |
| `free` | nobody holds the lock (a record left behind is removed now) | nothing runs: `status` says "not running", `stop` is done |
| `unnamed` | the lock is held, but the record is missing, an earlier process's, or of unknown start | something starts: wait; never signal it, never read its record |
| `named` | the lock is held and the record's pid is still the process that wrote it | believe it (a starting server, a supervisor) |
| `claimed` (server only) | the lock is held and the record says `running` | ask the server to prove it (chapter VI); then `named` or `unnamed` |

Why a running server is not checked by its start time: a start time proves the pid, but the commands then talk to the
record's **port**, and a port another program holds would pass a pid check. Only the listening server can answer for
the port (round 3, owner's decision).

## The start time

```ts
export async function processStart(pid: number): Promise<string | undefined> {
	if (process.platform === "linux" || process.platform === "android") {
		const stat = await ifExists(readFile(`/proc/${pid}/stat`, "utf8"));
		// The fields after the command's name, which is in parentheses and may hold anything: the start is field 22.
		return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
	}
	// Both answer for one fixed time zone and format, whoever asks: the text must be the same for every command.
	const [command, args] =
		process.platform === "win32"
			? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
				`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`]]
			: ["ps", ["-o", "lstart=", "-p", String(pid)]];
	try {
		const env = { ...process.env, TZ: "UTC", LC_ALL: "C" };
		const { stdout } = await run(command, args, { env, timeout: START_MS, windowsHide: true });
		return stdout.trim() || undefined;
	} catch {
		// No such process (both exit 1), no `ps` or PowerShell, or one that hung: unknown either way.
		return undefined;
	}
}
```

- **`lastIndexOf(")")`:** a process's name may hold spaces and parentheses; a test names one `a (b) c`.
- **`TZ=UTC`, `LC_ALL=C`:** `ps -o lstart` follows the caller's time zone; a command in another zone did not know its
  own server (Astra, round 3; a test asks from three zones).
- **An unknown start names nobody.** Round 3's blocking finding (Astra): two unknown starts compared equal, so on a
  machine without `ps` `stop` signalled whatever process a crashed record's pid now was. Now `undefined` never matches.

## The other new file: `pi.json`

`src/kit/config.ts`. The Pi's id becomes part of a cookie's name, so the file is checked when read:

```ts
export async function openConfig(path: string): Promise<PiConfig> {
	const existing = await readConfig(path);
	if (existing !== undefined) return existing;
	const config = { id: randomBytes(8).toString("hex") };
	await writeConfig(path, config);
	return config;
}

export async function readConfig(path: string): Promise<PiConfig | undefined> {
	const text = await ifExists(readFile(path, "utf8"));
	if (text === undefined) return undefined;
	// A trust boundary: a file people edit. The id becomes part of a cookie's name.
	const { id, port } = JSON.parse(text) as { readonly id?: unknown; readonly port?: unknown };
	if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw new Error(`${path}: "id" must be 16 hex digits`);
	if (port === undefined) return { id };
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`${path}: "port" must be a port number`);
	}
	return { id, port };
}
```

The layout gained three paths (`src/kit/layout.ts`): `config: pi.json`, `compileCache: cache/node`, `log:
logs/server.log`. Every file is written with `writeSecret` (mode 0600, written to a temporary file and renamed: the
`.WLbb3mtM4mqA.tmp` lines in the traces below).

# From Nothing to an Owner Link {#trace lede="Plain p3 on a machine where no Pi ever ran: three processes, 247 ms, through every file of the slice."}

The run: `HOME` an empty directory, the installed release, `NODE_DEBUG=p3` for the kit's two timing lines. A second
process polled the data directory every 2 ms and printed each change; times are milliseconds after the command
started.

```text
$ p3
p3 on /tmp/s26w/home/.pi/p3, port 8789. Open http://127.0.0.1:8789/_p3/owner#qn4J8bloUzmkg2-UkmEgLTuWITcjSMGCkM7O98iS57I
                                                                               (the command took 247 ms)
   86 ms  .WLbb3mtM4mqA.tmp: 54 bytes
   90 ms  logs/
   90 ms  supervisor.json: {"pid":2012381,"start":"96471968","state":"starting"}
  141 ms  cache/  server/  workers/
  141 ms  server.json: {"pid":2012392,"start":"96471971","state":"starting","run":"089edf69f04d5c8b3d4f372855a02a2b"}
  143 ms  pi.json: { "id": "af475c34a374804c" }
  197 ms  owner-token: 61 bytes
  197 ms  pi.json: { "id": "af475c34a374804c", "port": 8789 }
  200 ms  server.json: {"pid":2012392,…,"state":"running","run":"089edf69…","pi":"af475c34a374804c","port":8789,…}
  200 ms  supervisor.json: {"pid":2012381,"start":"96471968","state":"running"}

logs/server.log:
P3 2012392: server plugins built and loaded in 43 ms
p3 on /tmp/s26w/home/.pi/p3, port 8789
P3 2012392: worker base built in 111 ms
```

:::sequence animate | Plain `p3` with nothing running. Three processes; the command never talks to the supervisor, only to the server, and only once the server proved itself.
actor cmd "p3" "the command" blue
actor sup "supervisor" "detached"
actor srv "p3 server" "the supervisor's child" accent
actor dir "data directory" "locks, records" muted
cmd -> dir: holder(server), holder(supervisor): both free
cmd -> sup: spawn, detached (SUPERVISOR + COMMAND server --dir …)
sup -> dir: lock p3-supervisor, supervisor.json starting (90 ms)
sup -> srv: spawn p3 server, IPC channel
srv => dir: lock p3-server, server.json starting, run id (141 ms)
srv -> srv: layout, pi.json, cookie, store, plugins (43 ms)
srv -> dir: owner-token, listen 8789, pi.json port, server.json running (200 ms)
srv --> sup: "listening" over IPC
sup -> dir: supervisor.json running
cmd -> dir: holder(server): claimed
cmd => srv: GET /_p3/identity?nonce=… (no token)
srv --> cmd: run, pid, proof = HMAC(owner token, nonce)
cmd => srv: same connection: POST /_p3/owner/link, Bearer owner token
srv --> cmd: { link } (247 ms)
:::

:::steps | Every stop, with its code
+++ 1. `bin.ts`: plain `p3` is `start`
`run([command = "start", ...rest], flags)`: no positional is `start`; no `--pi`, no `--dir`, so `dataDirOf` gives
`~/.pi/p3`; no `--port`, so `port` is `undefined`. Then `start(dataDir, undefined, context)` from `src/commands.ts`.

+++ 2. `commands.ts`: who runs now
```ts
export async function start(path: string, port: number | undefined, context: Context): Promise<number> {
	const dataDir = await openDataDir(path);
	const deadline = Date.now() + START_MS;                        // 30 s
	const now = await running(dataDir, deadline, context);
	const idle = now.server.kind === "free" && now.supervisor.kind === "free";
	const logged = (await ifExists(stat(layoutOf(dataDir).log)))?.size ?? 0;
	const ours = idle ? startSupervisor(dataDir, port) : NOT_OURS;
	const server = listening(now.server) ?? (await serverOf(dataDir, ours, logged, deadline, context));
	if (server === undefined) return 1;
	// The link's own question is bounded too (`ask.ts`), also when the start used all of its time.
	const link = await ownerLink(dataDir, server, Math.max(deadline, Date.now() + LINK_MS));
	console.log(`p3 on ${dataDir}, port ${server.port}. Open ${link}`);
	return 0;
}
```
`openDataDir` makes `~/.pi/p3` (mode 0700) and resolves its real path; it refuses the home directory, a file system's
root and another user's directory. `running` asks `holder` for both roles. Both locks are free here, so `idle`: the
command starts a supervisor. Only where nobody holds the directory (round 3): a server or supervisor that starts
already holds a lock, and its server is the one to wait for.

```ts
async function running(dataDir: string, deadline: number, context: Context): Promise<Running> {
	const server = await holder(dataDir, "server", context);
	const named = async (record: RunningRecord): Promise<ServerHolder> =>
		(await proven(dataDir, record, deadline)) ? { kind: "named", record } : { kind: "unnamed" };
	return {
		server: server.kind === "claimed" ? await named(server.record) : server,
		supervisor: await holder(dataDir, "supervisor", context),
	};
}
```

+++ 3. `commands.ts`: the supervisor, detached
```ts
function startSupervisor(dataDir: string, port: number | undefined): Ours {
	const command = [...COMMAND, "server", "--dir", dataDir, ...(port === undefined ? [] : ["--port", String(port)])];
	// Detached and, on Windows, without a console window of its own.
	const options = { detached: true, stdio: "ignore", windowsHide: true } as const;
	const spawned = spawn(process.execPath, [...SUPERVISOR, dataDir, ...command], options);
	// … `exited()` and `end()` for the command's own child (below)
	spawned.unref();
}
```
In the release this spawns `node …/dist/supervisor.js /tmp/s26w/home/.pi/p3 …/dist/p3.js server --dir
/tmp/s26w/home/.pi/p3`. Detached: the supervisor outlives the command. `COMMAND` and `SUPERVISOR` come from
`src/install.ts`, so the release runs its own bundles and a checkout its TypeScript.

+++ 4. `supervisor.ts`: its lock, its record, its log (90 ms)
```ts
const [dataDir, ...command] = process.argv.slice(2);
const lock = await takeLock(dataDir, "supervisor", LOCK_MS, context);   // 1 s
if (lock === undefined) process.exit(1);
await writeRecord(dataDir, "supervisor", { state: "starting" });
const { log } = layoutOf(dataDir);
await mkdir(dirname(log), { recursive: true, mode: 0o700 });
// The server prints into the log itself; the supervisor adds what it does.
const out = openSync(log, "a", 0o600);
```
The trace's `.WLbb3mtM4mqA.tmp` (86 ms) is `writeSecret` writing `supervisor.json` before it renames it into place;
`logs/` appears at 90 ms. Then `run()` spawns the server with `stdio: ["ignore", out, out, "ipc"]`: its output goes into
the log, and it gets an IPC channel (chapter VIII has the loop).

+++ 5. `start-server.ts`: the server's lock, and at once its record (141 ms)
`p3 server --dir …` is `bin.ts`'s `serve`, which calls `startP3`, which calls `startServer`. Its first step:
```ts
async function openServer(path: string, context: Context) {
	const dataDir = await openDataDir(path);
	const lock = await takeLock(dataDir, "server", SERVER_LOCK_MS, context);   // 1 s
	if (lock === undefined) throw new Error(`startServer: another server runs on ${dataDir}`);
	try {
		// Before anything else: whoever asks who runs learns at once that this process starts, and stops trusting the
		// record a crashed server left.
		const run = randomBytes(16).toString("hex");
		await writeRecord(dataDir, "server", { state: "starting", run });
		const layout = await createLayout(dataDir);
		const config = await openConfig(layout.config);
		const cookie = signInCookieOf(config.id, await secretFile(layout.cookieSecret));
		await privateStore(layout.serverStore);
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(layout.serverStore)), context);
		return { layout, config, cookie, store, lock, run };
	} catch (error) {
		await removeRecord(dataDir, "server");
		await lock.release();
		throw error;
	}
}
```
In the trace: `server.json` `starting` and the layout's directories at 141 ms, `pi.json` with a fresh id at 143. The
record comes first so that a command asking meanwhile sees `starting`, not "not running" (round 2: `stop` answered
"not running" exit 0 while a server held the lock, and that server went on to run). A failed start right after the
lock leaves no record (tested: "leaves no record and frees the lock when the start fails right after it took the
lock").

+++ 6. `start-server.ts`: the kit's facets, the plugins (43 ms)
```ts
const core = [
	{ name: "chord.http", facet: http.facet },
	{ name: "p3.info", facet: appInfoFacet({ dataDir: layout.dataDir, name: NAME, version: API.versions[0]! }) },
	{ name: "p3.sign-ins", facet: signIns.facet },
	{ name: "p3.owner", facet: ownerFacet(link) },
	{ name: "p3.stop", facet: stopFacet(options.onStop) },
	{ name: "p3.identity", facet: identityFacet({ run, pid: process.pid, pi: config.id }, () => ownerToken) },
	...(options.facets ?? []),
];
const app = new RunningApp({ host, http, workers, store, plugins, lock }, layout);
try {
	const loading = performance.now();
	await plugins.load(host, { kind: "server", core, modules: API.modules }, context);
	debug("server plugins built and loaded in %d ms", Math.round(performance.now() - loading));
```
`plugins.load` bundles the sessions plugin's `server.ts` with esbuild (the 43 ms of `server plugins built and loaded
in 43 ms`) and loads the core facets with it. `p3.stop` and `p3.identity` are this slice's; `p3.owner` gained the
owner link route.

+++ 7. `start-server.ts`: owner token, listen, port, record `running` (197–200 ms)
```ts
	ownerToken = await ownerTokenFile(layout.ownerToken, host, context);
	const listening = await Promise.race([http.listening(context), unheard.promise]);
	starting = false;
	if (!("port" in options.listen) && config.port === undefined) {
		await writeConfig(layout.config, { ...config, port: listening.port });
	}
	link.listening(listening);
	app.started(link.renew(), listening);
	// Last: a command that reads `running` asks for an owner link at once.
	const { version } = options;
	const running = { state: "running", run, pi: config.id, port: listening.port, version, startedAt: Date.now() } as const;
	await writeRecord(layout.dataDir, "server", running);
} catch (error) {
	await app.close(context);
	throw error;
}
```
The order is the rule: `owner-token` (197), the listen, the port into `pi.json` (197, because this start named no port
and the Pi had none), the owner link made, and only then `server.json` says `running` (200). Round 2 (Sol): the record
used to come before the owner link was ready, and plain `p3` got a 500. `unheard` is the busy-port race (chapter
VIII).

Right after, off the start's path, the worker base builds (`worker base built in 111 ms`); a worker start waits for it.

+++ 8. `bin.ts` and `supervisor.ts`: "listening"
The server prints `p3 on /tmp/s26w/home/.pi/p3, port 8789` into the log (no owner link: it is supervised) and sends
`"listening"` over its IPC channel. The supervisor's `once("message")` writes `supervisor.json` `running` (200 ms):
from now on a supervisor without a server means a crash.

+++ 9. `commands.ts`: the command waits for `running`
```ts
async function serverOf(dataDir, ours, logged, deadline, context) {
	for (; Date.now() < deadline; await sleep(25)) {
		// Read before the look at the locks: a supervisor gone by then has no server still to come.
		const gone = ours.exited();
		const { server, supervisor } = await running(dataDir, deadline, context);
		const record = listening(server);
		if (record !== undefined) {
			if (supervisor.kind !== "named" || supervisor.record.pid !== ours.pid) await ours.end();
			return record;
		}
		if (gone && server.kind === "free" && supervisor.kind === "free") break;
	}
	const printed = (await ifExists(readFile(layoutOf(dataDir).log)))?.subarray(logged).toString().trimEnd() ?? "";
	failed(`the server on ${dataDir} did not start:\n${printed}`);
	return undefined;
}
```
Every 25 ms: `holder(server)` says `unnamed` while there is no record, `named` with `starting`, then `claimed`; the
claimed record goes to `proven` (chapter VI); proven, it is `listening`. If the supervisor that runs is not the one this
command started (two `p3` at once), the command ends its own, which lost the directory (round 3). If its supervisor
exits and nobody holds a lock, the start failed: the command prints what the log got since it began (`logged`), which
is how the busy-port message reaches plain `p3`.

+++ 10. `ask.ts` and `owner.ts`: the link (247 ms)
```ts
async function ownerLink(dataDir: string, record: RunningRecord, deadline: number): Promise<string> {
	const answer = await ask(dataDir, record, { method: "POST", path: OWNER_LINK_PATH }, deadline);
	const { port } = record;
	if (answer === undefined) throw new Error(`the server on port ${port} did not answer`);
	if (answer.status !== 200) throw new Error(`the server on port ${port} gave no owner link (${answer.status})`);
	return (JSON.parse(answer.body) as { readonly link: string }).link;
}
```
`ask` opens one connection, has the server prove itself again on it, then posts with the owner token as a bearer on
that same connection. The server's route:
```ts
[`POST ${OWNER_LINK_PATH}`]: {
	handler: async (_request, ctx) =>
		ctx.principal?.kind === "owner"
			? { kind: "json", value: { link: link.renew() } }
			: { kind: "error", status: 403 },
},
```
`renew` makes a new one-time token and drops the previous one, as a start does. The command prints the link and
exits 0, 247 ms after it began.
:::

## The second `p3`

```text
$ time p3
p3 on /tmp/s26w/home/.pi/p3, port 8789. Open http://127.0.0.1:8789/_p3/owner#PSpQCkx8gI1xKx3JWsIAyzaGsNTTIPVjVQ-gRovcy0w
real	0m0.127s
"pid":2012392                          (the same server)
```

`holder(server)` is `claimed` at once, the proof passes, `listening` gives the record, no supervisor is started, and
the link is fresh: the first one no longer signs in. The test ("plain p3 starts the server in the background once,
and prints a fresh owner link each time") starts two `p3` at once, then a third, and checks that the first two links
are refused (403), the third signs in once, and the log holds no `Open `.

## `status` and `list` on that Pi

```text
$ p3 status
running
  pi              af475c34a374804c
  data directory  /tmp/s26w/home/.pi/p3
  port            8789
  pid             2012392
  version         0.0.1
  started         2026-11-17T11:42:40.822Z
  supervisor      2012381
exit 0

$ p3 list
(default)  running  8789  /tmp/s26w/home/.pi/p3
```

What `status` says while no server listens, from the code:

```ts
function notListening(server: ServerHolder, supervisor: Holder<"supervisor">): string {
	if (server.kind === "named") return `starting (pid ${server.record.pid})`;
	if (server.kind === "unnamed") return "starting";
	if (supervisor.kind === "unnamed") return "starting";
	if (supervisor.kind === "free") return "not running";
	const { pid, state } = supervisor.record;
	return state === "starting" ? `starting (supervisor ${pid})` : `restarting after a crash (supervisor ${pid})`;
}
```

The data directory afterwards, every entry 0700 or 0600:

```text
drwx------  cache/{node,worker}   logs/server.log   server/{cookie-secret,store.sqlite*}   workers/
-rw-------  owner-token   pi.json   server.json   supervisor.json
```

# The Identity Proof {#identity lede="A record names a port; only the server on it can prove it is that record's, and the owner token goes nowhere else."}

## The attack

A server crashed and left `server.json` naming port 8789. The Pi starts again: the new server holds the lock but has
not written its record yet. Meanwhile another user on the machine has a program listening on 8789. A command that
believed the record would ask that program for an owner link, with the owner token as the bearer: the other user now
has the owner's sign-in. `stop` would send it the owner's stop, or signal the pid the record names.

The run id alone does not help: the real server tells anyone its run id, so the program can learn it and echo it.

## The route

`src/kit/identity.ts`:

```ts
/** A nonce as the route takes it: 16 random bytes in hex. */
const NONCE = /^[0-9a-f]{32}$/;

export function identityFacet(
	server: { readonly run: string; readonly pid: number; readonly pi: string },
	ownerToken: () => string,
): Facet<P3Principal> {
	return defineFacet<P3Principal>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`GET ${IDENTITY_PATH}`]: {
					public: true,
					handler: async (request) => {
						// A trust boundary: anyone may ask.
						const nonce = request.query.get("nonce");
						if (nonce === null || !NONCE.test(nonce)) return { kind: "error", status: 400 };
						return { kind: "json", value: { ...server, proof: proofOf(ownerToken(), nonce) } };
					},
				},
			},
		}),
	);
}

/** The proof for `nonce`: HMAC-SHA256 keyed by `token`, in hex. */
export function proofOf(token: string, nonce: string): string {
	return createHmac("sha256", token).update(nonce).digest("hex");
}

/** Whether `proof` (what a server answered) is the proof for `nonce` under `token`, compared in constant time. */
export function proves(proof: unknown, token: string, nonce: string): boolean {
	const expected = Buffer.from(proofOf(token, nonce), "hex");
	return (
		typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof) && timingSafeEqual(Buffer.from(proof, "hex"), expected)
	);
}
```

The route is public: it tells nothing secret. The proof is possession of the owner token without sending it (owner's
choice B, after round 3). Against the running server of chapter V, with `curl` and `openssl`:

```text
$ curl "http://127.0.0.1:8789/_p3/identity?nonce=2b2a8611b3445f78e234694b43ba0813"
{"run":"089edf69f04d5c8b3d4f372855a02a2b","pid":2012392,"pi":"af475c34a374804c",
 "proof":"471bc87f1b7c5a26ce5c653de7aac3e3b8904b031fe604951010af983e36ecac"}
$ echo -n 2b2a8611b3445f78e234694b43ba0813 | openssl dgst -sha256 -hmac "$(cat owner-token)"
471bc87f1b7c5a26ce5c653de7aac3e3b8904b031fe604951010af983e36ecac
$ curl …/_p3/identity?nonce=xyz          → 400
$ curl -X POST …/_p3/stop                → 401 (no sign-in)
$ curl -X POST …/_p3/owner/link          → 401
```

## The check

`src/ask.ts`:

```ts
async function provesItself(connection: Connection, dataDir: string, record: Running, deadline: number): Promise<boolean> {
	const nonce = randomBytes(16).toString("hex");
	const asking = { method: "GET", path: `${IDENTITY_PATH}?nonce=${nonce}` } as const;
	const answer = await connection.send(asking, {}, Math.min(IDENTITY_MS, deadline - Date.now()));   // 2 s
	if (answer?.status !== 200) return false;
	// A trust boundary: whatever listens on the port answered.
	const said = parsed(answer.body) as Partial<Identity> | undefined;
	// No token file: no server of this directory ever ran to answer for it.
	const token = (await ifExists(readFile(layoutOf(dataDir).ownerToken, "utf8")))?.trim();
	return (
		token !== undefined && said?.run === record.run && said.pid === record.pid && proves(said.proof, token, nonce)
	);
}
```

Three things must match: the record's run id (so a new server of this Pi under an old record, or another Pi's server
on the port, is not taken for it), the record's pid (which `stop` would signal), and the proof for a nonce this
command just made (so a replayed answer fails).

## The attack, run

A script held the server's lock of a Pi `victim` (as a starting server would), wrote a `running` record naming a port,
and listened on that port with four programs in turn, each answering the identity question its own way. Each line is
what the installed `p3 status --pi victim` printed, and every request the program received:

```text
echoes the run id, no proof                  status: starting   got: GET /_p3/identity?nonce=a83af2af… authorization=-
a made-up proof                              status: starting   got: GET /_p3/identity?nonce=7c134412… authorization=-
a proof replayed from another nonce          status: starting   got: GET /_p3/identity?nonce=25c6c309… authorization=-
the right proof (only the token's holder)    status: running    got: GET /_p3/identity?nonce=e569582a… authorization=-
```

`starting` means `unnamed`: the lock is held and nobody is believed. No program ever saw an `authorization` header:
`status` sends none, and plain `p3` and `stop` would send the token only to the last. The case "a running record is
the server's only once it proves itself: another program, a replayed proof, another run" runs this with five programs
and two real servers (also a program with the right proof but another pid, a new server of another Pi on the port, and this Pi's own server under
a record naming an earlier run), then runs `stop` meanwhile and checks that nothing was signalled or stopped.

What it does not cover: the owner's own processes can read the owner token file anyway (the data directory is 0700);
the proof is against other users.

## The token goes only over the proven connection

Round 4 (Sol, Opus): the command proved the server on one connection and sent the token on a new one. A server that
closes frees its port before its record and its lock go; a program waiting for the port would accept the second
connection and get the token. Now `ask` keeps one TCP connection for both:

```ts
export async function ask(dataDir: string, record: Running, request: Asking, deadline: number): Promise<Answer | undefined> {
	const connection = new Connection(record.port);
	try {
		if (!(await provesItself(connection, dataDir, record, deadline))) return undefined;
		const token = (await readFile(layoutOf(dataDir).ownerToken, "utf8")).trim();
		const headers = { authorization: `Bearer ${token}` };
		return await connection.send(request, headers, Math.min(ANSWER_MS, deadline - Date.now()));   // 10 s
	} finally {
		connection.close();
	}
}
```

```ts
class Connection {
	readonly #socket: Socket;
	readonly #port: number;
	#closed = false;

	constructor(port: number) {
		this.#port = port;
		this.#socket = connect(port, "127.0.0.1");
		this.#socket.on("error", () => {});
		this.#socket.once("close", () => {
			this.#closed = true;
		});
	}

	send(request: Asking, headers: Readonly<Record<string, string>>, ms: number): Promise<Answer | undefined> {
		if (this.#closed || ms <= 0) return Promise.resolve(undefined);
		const answered = Promise.withResolvers<Answer | undefined>();
		const end = (answer: Answer | undefined): void => {
			clearTimeout(timer);
			this.#socket.off("close", lost);
			answered.resolve(answer);
		};
		const lost = (): void => end(undefined);
		// A deadline for all of it, not an inactivity timeout: a byte a second must not keep the command waiting.
		const timer = setTimeout(() => {
			this.close();
			end(undefined);
		}, ms);
		this.#socket.once("close", lost);
		// `host` and `port` name the server in the `Host` header (its check refuses another), the socket is ours.
		const options = { ...request, host: "127.0.0.1", port: this.#port, headers: { ...headers, connection: "keep-alive" } };
		const asked = httpRequest({ ...options, createConnection: () => this.#socket }, (response) => {
			const chunks: Buffer[] = [];
			let bytes = 0;
			response.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > ANSWER_BYTES) {          // 64 KiB
					this.close();
					end(undefined);
				} else chunks.push(chunk);
			});
			response.on("end", () => end({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
			response.on("error", lost);
		});
		asked.on("error", lost);
		asked.end();
		return answered.promise;
	}
}
```

- **Once closed, never reopened.** A request on a closed `Connection` answers `undefined` at once; nothing is sent
  anywhere else. A TCP connection that is established cannot be taken over by another process.
- **A deadline for the whole request** (connect, headers, body), not Node's inactivity `timeout`: a program dripping
  one byte every 150 ms held `status` and `stop` as long as it liked (round 4). An `AbortSignal` did not end a request
  on a socket the server had closed; the timer does.
- **64 KiB at most:** an identity is a few hundred bytes.
- **Each command passes its own deadline:** `stop` its 30 s, `status` and `list` 5 s per directory, plain `p3` 30 s
  and 12 s more for the link.

Tests: "the owner token goes only over the connection the proof came over: a server that closes takes it nowhere" (a
server that answers the proof, closes, and gives its port to another program after the first or the second proof:
plain `p3` fails within 8 s and the program saw no token), and "a question has a deadline and a size: a program that
drips or floods holds no command" (`status` back within 10 s; the flood cut off with less than 8 MiB written).
Binding run, pid and port into the HMAC was considered and not needed (Opus): while the server listens nobody else
holds the address the command dials.

# Stop {#stop lede="Ask first, signal only what is proven, wait for what starts, return once the directory is free."}

## The owner's stop over HTTP

`src/kit/stop.ts` (round 3, owner's decision):

```ts
export function stopFacet(stop: () => void): Facet<P3Principal> {
	return defineFacet<P3Principal>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`POST ${STOP_PATH}`]: {
					handler: async (_request, ctx) => {
						if (ctx.principal?.kind !== "owner") return { kind: "error", status: 403 };
						// After the answer: the close drains running requests, this one written by then.
						setImmediate(stop);
						return { kind: "json", value: "stopping" };
					},
				},
			},
		}),
	);
}
```

`stop` is `bin.ts`'s close, the same as on `SIGTERM`. Not public, so 401 without a sign-in; 403 for anyone signed in
who is not the owner. Why HTTP first: a command needs no signal, so it stops a server whose process it cannot identify
(no `ps`) or may not signal, and on Windows, where a signal is `TerminateProcess` and skips the close.

## The command

```ts
export async function stop(path: string, context: Context): Promise<number> {
	const dataDir = await ifExists(realpath(path));
	if (dataDir === undefined) {
		console.log("not running");
		return 0;
	}
	const signalled = new Set<number>();
	const asked: Asked = { answered: new Set(), unanswered: new Set(), ending: new Set() };
	let found = false;
	for (const deadline = Date.now() + STOP_MS; ; await sleep(25)) {          // 30 s
		const { server, supervisor } = await running(dataDir, deadline, context);
		if (server.kind === "free" && supervisor.kind === "free") {
			console.log(found ? "stopped" : "not running");
			return 0;
		}
		found = true;
		// Each server that listens is asked first (also one a supervisor started meanwhile); one that answered closes,
		// and its supervisor ends with it.
		const record = listening(server);
		if (record !== undefined && !asked.answered.has(record.pid) && !asked.unanswered.has(record.pid)) {
			const answer = await ask(dataDir, record, { method: "POST", path: STOP_PATH }, deadline);
			if (answer === undefined) asked.unanswered.add(record.pid);
			else if (answer.status !== 200) {
				return failed(`the server on port ${record.port} refused to stop (${answer.status})`);
			} else {
				asked.answered.add(record.pid);
				if (supervisor.kind === "named") asked.ending.add(supervisor.record.pid);
			}
		}
		const target = stopTarget(server, supervisor, asked);
		if (target !== undefined && !signalled.has(target.pid)) {
			signalled.add(target.pid);
			signal(target.pid);
		}
		if (Date.now() > deadline) return failed(`${dataDir} did not stop within ${STOP_MS / 1000} s`);
	}
}
```

The loop's end is the promise: both locks free, so a `p3 server` started right after `stop` finds the directory its
own and does not wait. Whom it signals:

```ts
function stopTarget(server: ServerHolder, supervisor: Holder<"supervisor">, asked: Asked): ProcessId | undefined {
	if (server.kind === "unnamed" || (server.kind === "named" && server.record.state === "starting")) return undefined;
	const silent = listening(server);
	if (silent !== undefined && !asked.unanswered.has(silent.pid)) return undefined;
	if (supervisor.kind === "named") {
		const { record } = supervisor;
		return record.state === "running" && !asked.ending.has(record.pid) ? record : undefined;
	}
	return supervisor.kind === "free" ? silent : undefined;
}
```

| What runs | `stop` |
| --- | --- |
| a server that starts (`unnamed`, or `named` with `starting`) | waits; never signals it (a start cut off by a signal would skip its close) |
| a server that listens and answered the stop | waits for both locks; its supervisor ends with it, so neither is signalled |
| a server that listens and did not answer within 10 s | signals its supervisor (`running`), or, in the foreground, the server |
| a supervisor between a crash and the restart (no server) | signals the supervisor, which then starts no server |
| a supervisor whose first server is still starting | waits |
| something `unnamed` | waits, never signals |

## Stopping a running Pi

```text
$ time p3 stop
stopped
real	0m0.154s
exit 0
server gone, supervisor gone
$ ls ~/.pi/p3
cache  logs  owner-token  pi.json  server  workers         (no server.json, no supervisor.json)
$ p3 stop
not running
exit 0
$ p3 status
not running
  data directory  /tmp/s26w/home/.pi/p3
exit 1
```

## Stopping a server that is starting

The gate preload (`test/gate.ts`) holds a launched server still at a point of its start. Here: `p3 server --pi held`,
held at its plugins (its record says `starting`), then `status`, `list` and `stop` against it, then the gate opened.
Real run, times from the server's launch:

```text
  108 ms  server 2012884 held at its plugins
          server.json: {"pid":2012884,"start":"96476761","state":"starting","run":"ec274282e3fff31432bb95066409a781"}
          p3 status --pi held   →  starting (pid 2012884)
          p3 list               →  held  starting  -  /tmp/s26w/home/.pi/p3/pis/held
          p3 stop --pi held     …  started, waiting
 1772 ms  stop still waiting; server alive
 1778 ms  gate opened
          (server finishes its start, record says running; stop proves it, posts /_p3/stop, the server closes)
 1934 ms  stop returned: "stopped", exit 0
          server 2012884 gone; only pi.json left
```

`stop` polled `holder` every 25 ms for 1.7 s and did nothing but wait: `named` with `starting` is never signalled.
Once the record said `running` it asked over HTTP, the server answered `"stopping"` and closed, and `stop` returned
156 ms after the gate opened, when both locks were free. The case "a server that holds the lock is starting: status
says so, stop and plain p3 wait for it to run" does this at the lock (before the record) and at the plugins.

Before round 2 the same run printed "not running" at once, exit 0, and the server went on to run. Before round 3 a
crashed server's record naming a pid the system had given to an unrelated process was believed, and `stop` sent that
process `SIGTERM`; "a record of an earlier server naming another process now: that process is never signalled"
reproduces it with a live unrelated process.

`p3 stop` with signals taken away (`test/no-signals.ts` makes `process.kill` throw) still stops a foreground server
and a supervised one: "stop asks the server over HTTP: it needs no signal, in the foreground and in the background".

# The Supervisor {#supervisor lede="Restart after a crash, end with a clean stop, give up on a start that never listened."}

## The loop

`supervisor.ts`, after its lock and record (chapter V, step 4):

```ts
/** The wait before a crashed server starts again: 1 s, doubled for each crash in a row, at most 30 s. */
const FIRST_DELAY_MS = 1000;
const LONGEST_DELAY_MS = 30_000;

/** A server that ran this long was no crash in a row: the next wait is the first one again. */
const SETTLED_MS = 60_000;

let stopping = false;
let child: ChildProcess | undefined;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopping = true;
		child?.kill("SIGTERM");
		wake?.();
	});
}

let delay = FIRST_DELAY_MS;
let code = 0;
for (;;) {
	const started = Date.now();
	const ended = await run();
	code = ended.code;
	if (stopping || ended.code === 0 || !ended.listened) break;
	if (Date.now() - started >= SETTLED_MS) delay = FIRST_DELAY_MS;
	say(`the server exited with ${ended.code}; starting it again in ${delay} ms`);
	await new Promise<void>((resolve) => {
		wake = resolve;
		setTimeout(resolve, delay);
	});
	if (stopping) {
		code = 0;
		break;
	}
	delay = Math.min(delay * 2, LONGEST_DELAY_MS);
}
await removeRecord(dataDir, "supervisor");
await lock.release();
process.exit(code);

async function run(): Promise<{ readonly code: number; readonly listened: boolean }> {
	const running = spawn(process.execPath, command, { stdio: ["ignore", out, out, "ipc"], windowsHide: true });
	child = running;
	let recorded: Promise<void> | undefined;
	running.once("message", () => {
		recorded = writeRecord(dataDir, "supervisor", { state: "running" });
	});
	const code = await new Promise<number>((resolve) => {
		running.once("error", (error) => {
			say(`the server did not start: ${error.message}`);
			resolve(1);
		});
		running.once("exit", (exit) => {
			child = undefined;
			resolve(exit ?? 1);
		});
	});
	// Done before the record is removed at the exit, never after it.
	await recorded;
	return { code, listened: recorded !== undefined };
}
```

The three ways a child ends:

| The child | The supervisor |
| --- | --- |
| exits 0 (a stop: HTTP or `SIGTERM`) | ends, exit 0 |
| exits otherwise after it listened (a signal, an uncaught error) | a crash: waits 1 s (2, 4, … 30 s in a row; 1 s again after a minute of running), starts it again |
| exits before it listened (a busy port, another server on the directory) | ends with that exit code: retrying every 30 s would never help |
| the supervisor gets `SIGTERM` while waiting to restart | `wake()` cuts the wait short, `stopping` holds it from starting another, exit 0 |

## A crash, traced

The default Pi running, then `SIGKILL` to its server. Times from the watcher's start:

```text
   22 ms  server.json: {"pid":2012725,…,"state":"running","run":"450e96338e3fa49f51b4c205cdebda8b",…,"port":8789,…}
          supervisor.json: {"pid":2012714,…,"state":"running"}
   31 ms  kill -9 2012725
  234 ms  p3 status  →  restarting after a crash (supervisor 2012714)
  296 ms  server.json: (gone)
 1107 ms  server.json: {"pid":2012792,"start":"96475270","state":"starting","run":"9f5f397edcb4f00c644a6529d33ae33b"}
 1147 ms  server.json: {"pid":2012792,…,"state":"running","run":"9f5f397e…",…,"port":8789,…}

$ p3 status
running
  pid             2012792
  supervisor      2012714

logs/server.log:
p3 on /tmp/s26w/home/.pi/p3, port 8789
2026-11-17T11:43:12.708Z supervisor: the server exited with 1; starting it again in 1000 ms
p3 on /tmp/s26w/home/.pi/p3, port 8789
```

- At 234 ms the server's lock is free (the kernel let go of the dead process's socket), so `holder(server)` is `free`;
  the supervisor's record says `running`, so `status` knows this is a crash, not a first start.
- At 296 ms `server.json` is gone: `status`'s `holder` removed it, under the free lock. A stale record is never left
  for the next reader.
- At 1107 ms, a second after the crash, the new server holds the lock and says `starting` with a new run id; 40 ms
  later it listens on the same port (the Pi's own, from `pi.json`). Its start is warm: Node's compile cache.

"a crashed server is started again by its supervisor; stop ends both" checks the same with the supervisor frozen
(`SIGSTOP`) so the gap lasts as long as the test looks, and then a `stop` between a crash and the restart: the frozen
supervisor must find a `SIGTERM` pending and start no server. Not tested: the backoff beyond its first wait (a test
would have to wait a minute).

## A start that never listened

The supervisor learns that its child listened over IPC. A start that fails before that (here, a busy port) is not a
crash:

```text
$ p3 server --pi busy --port 41234           (something else holds 41234)
p3: port 41234 is in use; pass --port <n> or stop what uses it
exit 1                                        (0.13 s)
$ p3 --pi busy --port 41234
p3: the server on /tmp/s26w/home/.pi/p3/pis/busy did not start:
p3: port 41234 is in use; pass --port <n> or stop what uses it
exit 1
```

Chord's HTTP component retries a failed listen for as long as it takes, so `startServer` races the listen against the
listener's first activation failure during the start:

```ts
const unheard = Promise.withResolvers<never>();
unheard.promise.catch(() => {});
let starting = true;
const host = createHost<P3Principal>({
	address: Server(),
	principal: PRINCIPALS.server,
	store,
	onError: (error) => {
		if (starting && error.kind === "activation_failed" && error.object === HttpListener.name) {
			unheard.reject(new ListenFailed(listen, error.failure.error.cause));
		} else onError({ kind: "host", error });
	},
});
// …
const listening = await Promise.race([http.listening(context), unheard.promise]);
```

The start rejects with `ListenFailed` (the system's code, `EADDRINUSE`), the `catch` closes everything (no
`server.json`, the lock free), `bin.ts` prints the one line. In the background the server exits 1 before listening, so
the supervisor ends with 1, and plain `p3` finds both locks free with its supervisor gone and prints what the log got
since it began. "a busy port fails the start at once, in the foreground and in the background": within a second, no
record, the lock free.

## Two `p3` at once

Both find the directory idle and start a supervisor. One wins the supervisor's lock; the other waits a second for it
(`LOCK_MS`) and exits 1. Found by this slice's runs: when the winner was stopped right after, the loser took the lock
and started the Pi again, and `stop` waited 30 s. Now the command that started a supervisor which did not win ends it
in `serverOf` (`await ours.end()`):

```ts
end: async () => {
	// Our own child: its pid is its, no record needed to know. It stops a server it started meanwhile. Waited
	// for with the child counted again: the command would end on an empty event loop otherwise.
	if (!exited) {
		spawned.ref();
		spawned.kill("SIGTERM");
	}
	await exit.promise;
},
```

Its first version waited with the child `unref`'d and the command ended on an empty event loop (exit 13). "two plain
p3 at once leave one supervisor: a stop right after leaves nothing that starts again".

# Several Pis {#pis lede="A Pi is its data directory: its own id, port, cookie and locks."}

```text
$ p3 --pi a
p3 on /tmp/s26w/home/.pi/p3/pis/a, port 40499. Open http://127.0.0.1:40499/_p3/owner#2qutG8lZ…
$ p3 --pi b
p3 on /tmp/s26w/home/.pi/p3/pis/b, port 43475. Open http://127.0.0.1:43475/_p3/owner#ytoFEYXa…
$ p3 list
(default)  stopped  8789   /tmp/s26w/home/.pi/p3
a          running  40499  /tmp/s26w/home/.pi/p3/pis/a
b          running  43475  /tmp/s26w/home/.pi/p3/pis/b
busy       stopped  -      /tmp/s26w/home/.pi/p3/pis/busy
held       stopped  -      /tmp/s26w/home/.pi/p3/pis/held
$ cat ~/.pi/p3/pis/a/pi.json
{ "id": "31af24d5a1441a73", "port": 40499 }
$ p3 stop --pi a && p3 list
stopped
(default)  stopped  8789   …
a          stopped  40499  …
b          running  43475  …
```

| Per Pi | How |
| --- | --- |
| its port | the default Pi 8789; any other a free one at its first start, kept in `pi.json`; `--port` for one start only, not kept |
| its locks | `p3-server:<real path>`, `p3-supervisor:<real path>`, `p3-worker:<real path>:<address>`: Chord hashes the whole name |
| its sign-in cookie | `p3-<id>`: a browser shares cookies between the ports of one host, so one name would let the second Pi's sign-in replace the first's |
| everything else | the store, the cookie secret, the owner token, workers' directories, worker base and compile cache: in the data directory already |

The cookie's name, in `src/kit/sign-ins.ts`:

```ts
/**
 * The sign-in cookie of one Pi: its name, which holds the Pi's id (a browser shares cookies between the ports of one
 * host, so two Pis on a machine need two names), and the secret that signs it.
 */
export type SignInCookie = { readonly name: string; readonly secret: string };

/** The sign-in cookie of the Pi `id`, signed with `secret`. */
export function signInCookieOf(id: string, secret: string): SignInCookie {
	return { name: `p3-${id}`, secret };
}
```

"two Pis run side by side: their own ports, sessions and sign-in cookies; stopping one leaves the other": a session
made in one is not in the other; one cookie jar signed in to both (two cookies of different names on `127.0.0.1`) is
the owner at both; `stop` of one leaves the other serving with its workers. Undone, "one name for every Pi" fails it
from source and from the release.

# Types for Third-Party Plugins {#types lede="A plugin author's tsc resolves the release's declarations; Chord had to export three types for that."}

## The error that hid behind `declaration: false`

p3's `tsconfig.json` used to set `declaration: false`. With declarations on, six exported contracts failed:

```text
plugins/sessions/contract.ts(61,14): error TS2883: The inferred type of 'Sessions' cannot be named without a
reference to 'Method' from '../../../../node_modules/@earendil-works/chord/src/contracts/schema.ts'.
```

A contract's type is inferred and holds the types `method(...)` and `oneOf(...)` return. Chord declared them and did
not export them from its entry point, so no import a consumer could write names them. A third-party plugin that emits
declarations would hit the same error in an install. The fix is in Chord (decision F, owner: yes),
`packages/chord/src/contracts/index.ts`:

```ts
export type {
	// …
	HostKeyed,
	// …
} from "./contract.ts";
export {
	// …
	type LiteralsSchema,
	lit,
	type Method,
	// …
} from "./schema.ts";
```

`HostKeyed` (a keyed member with a host kind) was found by Chord's own new test, which writes a contract with every
member kind into a temporary directory, emits its declaration with `tsc` and checks that it names `Method<` and no
path into `node_modules`: "are all exported, so a contract's emitted declaration names them through Chord's entry
point" (`test/contracts/schema.test.ts`). `declaration: false` is gone from p3's `tsconfig.json`, so `npm run check`
now fails for any exported contract whose type cannot be named.

## The acceptance test

`test/release/release.test.ts` writes a plugin into a directory under `/tmp`, whose `node_modules` is the install's,
and type-checks it with `strict`, `NodeNext`, `declaration` on and `types: []`:

```ts
// contract.ts
import { method, obj, oneOf, remote, Server, str } from "@earendil-works/p3/v1";

/** A greeting the server has for its owner, plain or loud. */
export const Hello = remote("hello.greeting", {
	version: 1,
	params: { tone: oneOf("plain", "loud") },
	hostAddress: () => Server(),
	variants: { owner: { state: { text: str() }, methods: { greet: method(obj({ name: str() }), str()) } } },
});
```

```ts
// server.ts
import { constant, defineFacet, forbidden } from "@earendil-works/p3/v1";
import { Hello } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(Hello, ({ tone }, principal) => {
		if (principal.kind !== "owner") throw forbidden("hello: the owner's");
		const said = (text: string): string => (tone === "loud" ? text.toUpperCase() : text);
		return {
			variant: "owner",
			members: { text: constant(said("hello")), greet: async ({ name }) => said("hello, " + name) },
		};
	});
});
```

| Test | What it checks |
| --- | --- |
| "type-checks under `strict`, and its contract's declaration names every type through the release" | `tsc` passes; the emitted `contract.d.ts` names `Method` and `LiteralsSchema` through the package, and no `any` |
| "fails the type check for a member of the wrong type, and for a method answering another type" | `text: constant(1)`: `server.ts(5,…): error TS2769: No overload matches this call.` (at `host.serve`: `serve` is overloaded, so TypeScript reports the call, not the member) |
| "imports the three API modules at run time, as a plugin's own tests outside the server do" | `dist/api/v1/*.js` load from outside the repository with their exports |
| "loads from the installed server's plugins root and serves its object to a client" | the plugin copied into a copy of the install's `plugins/`; the launched release serves `Hello`; a client on the compiled API reads `"HELLO"` and calls `greet` |

"Go to definition" has a target: `dist/api/v1/index.d.ts.map` names `src/api/v1/index.ts`, which ships.

# Session Worker Memory {#memory lede="An idle worker from 30 to 18.5 MiB, its peak under load from 77 to 45: five levers, each with what it does."}

## The levers

| Lever | Where | What it does |
| --- | --- | --- |
| **a bundle per process**, with lazy chunks | `scripts/build-release.ts` | the worker's bundle holds none of the server's code: no esbuild JS API, `ws`, Node's HTTP, Chord's HTTP component, the server side of its workers or plugin builds (`checkLean`); a lazy `import()` stays a chunk loaded only when asked for |
| **provider SDKs bundled** by the release build | `checkExternals` | nothing but esbuild and `ws`'s accelerators is left to `node_modules`, so a worker that imports pi-ai gets each API's SDK inside its bundle, in a lazy chunk per API, instead of loading them from `node_modules` file by file |
| **Chord's worker base minified** (names kept) | `packages/chord/src/node/workers/base.ts` | every worker holds the base's source text; V8 keeps a text with any non-ASCII character (a comment's `§`) as UTF-16, twice its size. About 0.4 MiB per bare worker, more with bundled SDKs |
| **a warm compile cache** | `src/kit/worker.ts`: `flushCompileCache()` after the start | Node writes its compile cache only at exit; flushed once a worker is up, every later worker starts from it |
| **three V8 flags** | `WORKER_V8_FLAGS` in `src/install.ts` | `--liftoff-only`: WebAssembly (undici's HTTP parser) is never compiled a second time, optimized; that compile's freed memory stayed with the process, 8 to 10 MiB with several streams. `--optimize-for-size`: a smaller heap and young generation in a burst, for a few percent of CPU. `--max-semi-space-size=4`: a young generation of at most 4 MiB a semi-space |

Chord's change:

```ts
		// Function and class names as the source has them (`name` stays what unbundled code sees).
		keepNames: true,
		// Minified but for the names: every worker holds the base's source text, and V8 keeps a text with any non-ASCII
		// character (a comment's `§`) as UTF-16, twice its size.
		minifyWhitespace: true,
		minifySyntax: true,
```

Its test, "is minified but for the names: no comments, no indentation, `name` as the source has it", bundles a
function and a class under a comment with a `§` and checks that the names survive and the comment, the tab and the
`§` do not.

The kit's change, `src/kit/worker.ts`:

```ts
			const core = [{ name: "p3.worker-info", facet: workerInfoFacet(address) }];
			await plugins.load(host, { kind: WORKER_FACET, core }, context);
			// Node writes its compile cache only at exit otherwise: the next workers start from this one's, warm.
			flushCompileCache();
			options.session?.({ store, host }, context);
```

`options.session` is the memory test's hook: what runs on the worker's store and host once it is up. It is a test and
interim hook; slice 3's harness becomes an object in the worker's core facet and replaces it (Carried).

## The worker-only entry, measured alone

From the release, three runs of each alternately, both from the same commit (the shared-chunk build restored in a
copy). "Settled" is after 40 s, when V8's memory reducer has run.

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

The cost: Chord is now in the package twice (`main.js` 1.0 MB, `worker.js` 0.8 MB). For 100 idle workers about
0.5 GiB less.

## The memory test

`test/release/memory.test.ts`, run by `release:p3:local`. A server and a worker entry built with the release's own
options and checks, the installed release's plugins, and in each of 4 workers at once a real Durable `Harness` on the
worker's store with the coding tools, a `NodeExecutionEnv`, a prompt section, a subagent tool, and pi-ai's real
Anthropic and OpenAI providers against a local HTTPS stub (a certificate made by OpenSSL, trusted through
`NODE_EXTRA_CA_CERTS`), with telemetry sent to the server every second. The schedule: idle; one streamed answer (8 KB
over 15 s); a burst of 20 turns with read and bash tool calls, five of them on OpenAI; five subagent conversations
streaming at once; idle after each. USS every 250 ms from `/proc/<pid>/smaps_rollup`:

```ts
async function uss(pid: number): Promise<number | undefined> {
	const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => undefined);
	if (rollup === undefined) return undefined;
	const kb = (field: string) => Number(new RegExp(`^${field}:\\s+(\\d+)`, "m").exec(rollup)?.[1] ?? 0);
	return (kb("Private_Clean") + kb("Private_Dirty")) / 1024;
}
```

An idle phase ends once the worker settled, not after a fixed 40 s:

```ts
export function settled(samples: Samples, since: number, now: number): boolean {
	if (now - since >= SETTLE_MAX_MS) return true;                 // 40 s
	if (now - since < SETTLE_MIN_MS) return false;                 // 12 s
	const recent = samples.filter((sample) => sample.t >= now - STABLE_MS).map((sample) => sample.uss);   // 4 s
	return recent.length >= STABLE_MS / 250 - 1 && Math.max(...recent) - Math.min(...recent) < STABLE_MIB; // 0.25
}
```

The worker waits for the test's `SIGUSR2` (no timer of its own). Every phase settled at 12.0–13.5 s, its readings
within 0.2 MiB of the 40 s pauses; a run takes 80 s instead of 190. The test fails when any sample exceeds the budget,
naming the phase, the peak and the settled values:

```ts
const BUDGET_MIB = 55;

export function withinBudget(readings: Readings, budget: number, who: string): void {
	assert.ok(readings.peak <= budget, `${who}: USS above ${budget} MiB: ${line(readings)}`);
}
```

## Before and after the levers

The memory test from the release on slayer, USS in MiB, median [min–max]. Before: the same test with none of the
levers, 3 runs × 4 workers. After: 10 runs × 4 workers.

| Reading | Before (n=12) | With the levers (n=40) |
| --- | --- | --- |
| idle, settled | 30.3 [29.5–35.7] | 18.5 [18.0–25.4] |
| after the first response | 55.8 [53.7–61.5] | 30.0 [28.9–34.5] |
| burst peak | 77.3 [74.9–82.0] | 41.6 [41.0–43.8] |
| after the burst | 55.6 [53.7–61.4] | 34.9 [34.4–37.1] |
| 5 subagents, peak | 67.6 [66.7–73.2] | 44.7 [43.4–47.6] |
| after the subagents | 67.6 [66.7–73.2] | 44.5 [41.5–47.6] |
| highest of a run | 77.3 [74.9–82.0], in the burst | 44.7 [43.4–47.6], after the subagents |

The idle maximum (25.4) is each run's first worker, whose compile cache is cold; the others start from its cache.

## The budget

55 MiB, one for every Node p3 supports (owner). At that budget, five more runs on each Node:

| Reading | Node 24.4.1 (n=20) | Node 26.11.1 (n=20) |
| --- | --- | --- |
| idle, settled | 18.4 [17.9–25.6] | 20.6 [20.3–27.1] |
| after the first response | 30.0 [28.8–34.5] | 29.5 [29.0–34.0] |
| burst peak | 42.0 [41.2–43.5] | 42.7 [42.1–44.5] |
| after the burst | 35.1 [34.5–37.1] | 42.3 [38.4–44.5] |
| 5 subagents, peak | 44.7 [43.5–46.8] | 47.8 [45.6–50.0] |
| highest of a run | 44.7 [43.5–46.8] | 47.8 [45.6–50.0] |

- **Not 45:** 15 of 40 Node 24 workers went above it. After the five parallel streams glibc keeps about 10 MiB it
  freed (`malloc_info`: 10 to 11 MiB kept free, against 4 to 6 after the burst), while the session's data is about 4
  MiB of the heap. Measured 40 s after that phase: V8's heap 27.4 MiB committed (code, closures, contexts and shapes
  13.0, the bundles' source text 2.4, data 4.1), malloc live 6.6, kept free 10.8. A forced `gc()` moves the USS by
  0.2; only `malloc_trim` returns 3 to 4 MiB. `GLIBC_TUNABLES=glibc.malloc.mmap_threshold=16384` would bring the
  phase to 33.6–36.1, and was not taken: glibc only.
- **Not 50:** Node 26's workers settle about 7 MiB above Node 24's after the burst; 50 failed one Node 26 run in five
  (Opus).
- **Node 24 still catches a lost lever** at 55: without `--liftoff-only` the median was 55.4, without the three flags
  65.9 (Opus).

The flags are in `node --v8-options` on Node 24.4.1 and 26.11.1; the release tests pass on both.

# What Breaks If a Line Goes {#mutations lede="101 rules undone one at a time in a copy; the test that fails says the rule is real."}

The check ran in a copy of `apps/p3` and `packages/chord` under `/tmp` (`/tmp/s26m-mutate.py` on slayer), each rule
undone alone, the tests run, 18 runs through a rebuilt, repacked and reinstalled release. 80 rules over the three
review rounds, then 21 more after round 4 and the memory work. A selection; the first column is the line or rule, the
second what happens without it, the third the test that fails.

## The build and the package

| The rule | Without it | The test that fails |
| --- | --- | --- |
| `within(…)` by path segments, both ways, through real paths (`release-local.ts`) | `--force` empties the repository or its parent | "is refused when it is a root, the repository, above it or inside it, also through a link, forced or not" |
| the `.p3-release` marker | a directory of yours is emptied | "is not touched when it holds anything but a release of this script, forced or not" |
| `for (const name of MADE)` | `--force` removes everything there | "replaces a previous release only with --force, and removes only what the script made there" |
| `checkExternals` | an import left to a package the install lacks | "refuse an import left to node_modules that the package does not ship, naming it" |
| `checkPlacement` | `install.ts` in a chunk: every path off by a directory | "refuse `src/install.ts` anywhere but in `main.js` alone" |
| `checkVersions` | the bundle's Chord and the types' Chord differ | "refuse a dependency pinned to another version than the workspace's" |
| `checkLean` (imports, inputs) | a worker loads the server's code | "refuse a worker's or the supervisor's bundle that imports or holds the server's code" |
| one build per process | the shared chunk is back | "holds one bundle per process, …"; "gives a worker and the supervisor bundles that import and hold none of the server's code" |
| `splitting: true` | lazy imports inlined into the entry | "keep what an entry imports lazily in a chunk of its own, out of the entry" |
| the `require` banner | `ws` fails at its first `require` | every release test that runs the command |
| `enableCompileCache()` in the launcher | every start compiles the bundle again | "writes an executable launcher that enables the compile cache before it loads the bundle" |
| the warning filter's type check | all warnings, or none, dropped | "drops only experimental warnings: every other warning goes Node's way, …" |
| no static import in `p3.js`; `tooOld` | an old Node fails deep in a module | "an older Node than p3 supports is refused with one line"; "compares versions by number, not as text" |
| `"private": true`, `types`, `src/api` in `files`, `!plugins/**/*.test.ts`, `ws` | a wrong manifest | the release's "ships the bundles, …", "is outside the repository and resolves nothing from it", "imports the three API modules at run time" |
| Chord's `Method`, `LiteralsSchema`, `HostKeyed` exports | TS2883 for a contract's declaration | `npm run check`, Chord's declaration test, the third-party plugin's `tsc` |
| `declarationMap` in the build | "go to definition" has no target | "holds one bundle per process, the launcher, and the API modules compiled with their declarations" |
| `SOURCE` in `install.ts` (both ways) | the wrong entries and flags | the end-to-end case from source; every launched release case |
| `version()` from the installed `package.json` | `--version` lies | "answers --version and --help through the installed command, without a warning" |

## Who runs

| The rule | Without it | The test that fails |
| --- | --- | --- |
| `holder` believes a record only under a held lock | a crashed server's record is believed | "plain p3 starts the server …", "stop returns …", "a crashed server …" (all hang) |
| a stale record removed under the free lock | `server.json` left behind | "does not believe a record whose lock is free, although its process exists, and removes it" |
| the start time compared | a reused pid is signalled | "a record of an earlier server naming another process now: that process is never signalled" (source and release) |
| an unknown start names nobody | two unknowns match, a stranger is signalled | "names nobody whose start is unknown"; "stop, where no process can be identified" |
| `lastIndexOf(")")`, field 22 | the start read wrongly, nobody matches | "reads the start on Linux after the command's name, whatever that name holds" |
| `TZ=UTC`, `LC_ALL=C` for `ps` | a command in another zone does not know its server | "asks `ps` … in one time zone: two callers in two zones see one start" |
| PowerShell in UTC, round-trip format | the same on Windows | "asks PowerShell on Windows, …" |
| `starting` written at the lock | `stop` says "not running" while a server starts | "a server that holds the lock is starting: …" |
| `running` written last | plain `p3` gets a 500 for its link | the end-to-end case (source and release) |
| no record after a failed start | a record without a holder | "leaves no record and frees the lock when the start fails right after it took the lock" |
| `server.json` removed at close | a record left after every stop | "status says whether a server runs …; a stopped server leaves no record" |
| a running record `claimed`, never `named` by its start | a port's stranger believed | "a running record is the server's only once it proves itself …" |

## The identity, the connection, the deadlines

| The rule | Without it | The test that fails |
| --- | --- | --- |
| `proves(said.proof, token, nonce)` | any program on the port is believed | "a running record is the server's only once it proves itself …" (source and release) |
| `said.pid === record.pid` | `stop` signals a pid the proof did not cover | the same case |
| `said.run === record.run` | an earlier run's record is believed | the same case ("this Pi's own server under a record naming an earlier run") |
| the question carries no token | the token goes to whoever listens | the same case, and the reused-pid case |
| a fresh run id per start | an old record matches a new server | "comes with a fresh run id at each start" |
| `NONCE.test(nonce)` | the route signs anything | "answers anyone its run id, pid and Pi, with the proof for the nonce asked; a nonce that is none gets 400" |
| the token on the proven connection | the token goes to the port's next holder | "the owner token goes only over the connection the proof came over …" (source and release) |
| a deadline for the whole request | a dripping program holds `status` for ever | "a question has a deadline and a size: …" (source and release) |
| the 64 KiB cap | a flood is read whole | the same case |

## Stop, start, the supervisor, Pis

| The rule | Without it | The test that fails |
| --- | --- | --- |
| `stop` asks over HTTP first | a stop needs a signal | "stop asks the server over HTTP: it needs no signal, in the foreground and in the background" (source and release) |
| no signal to a server that answered, nor its supervisor | a signal on top of a clean stop | the same case |
| a supervisor between restarts is signalled | `stop` waits 30 s and fails | "a crashed server is started again by its supervisor; stop ends both" |
| the stop route is the owner's | anyone stops the Pi | "is refused without a sign-in and to anyone but the owner, and runs nothing then" |
| `bin.ts` gives `onStop` its close | the HTTP stop does nothing | "stop returns once the data directory is free; …" |
| the signal handlers before the start | a signal during the start skips the close | "a signal during the start closes the server once it started" |
| a supervisor only where nobody holds the directory | a second supervisor beside a running or starting one | "status says whether a server runs …"; "a server that holds the lock is starting: …" |
| `await ours.end()` for a losing supervisor | it starts the Pi again after a stop | "two plain p3 at once leave one supervisor: …" |
| the supervisor restarts after a crash | a crash ends the Pi | "a crashed server is started again by its supervisor; …" |
| `ended.code === 0` ends the supervisor | a clean stop is restarted | "stop returns …", "a crashed server …" |
| `!ended.listened` ends it | a busy port is retried every 30 s | "a busy port fails the start at once, in the foreground and in the background" |
| `supervisor.json` says `running` after the listen | a supervisor's crash looks like a first start | "a crashed server is started again …" |
| no owner link in a supervised log | the link sits in a file | "plain p3 starts the server in the background once, …" |
| the `unheard` race | a busy port waits for ever | "fails the start at once when the port is in use, with everything closed" |
| digits only for `--port` | `--port ""` is a free port | "a command line p3 does not understand is refused with the usage" |
| `p3-<id>` for the cookie | two Pis' sign-ins replace each other | "two Pis run side by side: …" (source and release); "holds the Pi's id: two Pis on one host keep two cookies" |
| the Pi's port kept; one start's `--port` not kept | a Pi's address moves | "listens on the Pi's own port: the first start's, kept in its config; a port named for one start is not kept" |
| `isPiName` | a path as a Pi's name | "is named by lower case letters, digits, - and _, at most 32, and never by a path" |

## Memory

| The rule | Without it | The test that fails |
| --- | --- | --- |
| each of the three V8 flags | more memory per worker | "closes on SIGTERM: its workers are gone …" (the launched tests read the worker's command line and name the flags themselves) |
| `flushCompileCache()` | every worker starts cold | the launched SIGTERM and SIGINT cases |
| Chord's base minified | larger worker text | Chord's "is minified but for the names: …" |
| the budget and its check | the memory test never fails | "fails a worker above the budget with its phase, its peak and its settled values" |
| the settle rule's earliest end and stability | idle phases end early | "calls a worker settled once its USS held still for 4 s, 12 s into the phase at the earliest, 40 s at the latest" |

The V8 flags first survived: the tests read `WORKER_V8_FLAGS` to know which flags to look for, and a mutation that
shortens the list shortened the expectation too. The tests now name the flags themselves.

## The three survivors

All three are equivalent: the code without the rule behaves the same.

- **`stop` signalling a supervisor while its server starts.** The server closes on a signal that came during its start,
  once started: the same end as waiting. The wait stays, as the owner asked.
- **The stop route calling the stop before it answers.** Chord's close drains the running request, so the answer still
  goes out. The answer-first order stays.
- **`stop`'s questions not clipped to its own 30 s.** Each question has its own bound (2 s, 10 s), so `stop` overruns
  by at most one question.

What the check found besides: a failed case kept the test runner alive for ever (now `--test-force-exit`, bounded
waits, `t.after` kills what a case launched); a test that wrongly passed outside a checkout named `pi`; the
supervisor's fast-exit guard, which no test could tell from none once the command ends a losing supervisor (removed);
`stop` between a crash and the restart was the same with no signal at all (the case now freezes the supervisor and
looks for the pending signal). Untested: the supervisor's backoff beyond its first wait.

# The Tests {#tests lede="134 from source in about 12 s; 33 against the install in about 91 s."}

| Where | Runs | What |
| --- | --- | --- |
| `npm test` in `apps/p3` | 134 tests, about 12 s; in a row and four suites at once | the command's 20 cases and `stop` without identities; the launched server; the build and its guards into a temporary directory; the output directory; Pis, who runs, the config, the owner's stop, the identity, the oldest Node; slice 1's tests |
| `npm run test:release` (by `release:p3:local`, decision E) | 33 tests, about 91 s, the memory test's 80 s among them | the install's contents and files; the three API modules imported at run time; `--version` and `--help`; the warnings; the end-to-end case outside the repository; `SIGTERM` with a worker and its V8 flags; every command case again; the third-party plugin; the memory test |
| Node 26.11.1 | 30 of the 33 | all but the memory test |
| Chord | 3,879 tests | its whole suite, with the two new tests |

## How the command's cases are driven

The cases are written once (`test/commands.ts`) against a `Cli`: a home directory of the test's own and a function
that runs `p3`. `commands.test.ts` gives it the source command, `release.test.ts` the installed one:

```ts
/** The command that starts p3 from this checkout: Node with the flags that run its TypeScript, and `bin.ts`. */
export const SOURCE: readonly string[] = [
	process.execPath, "--conditions=source", "--disable-warning=ExperimentalWarning",
	fileURLToPath(new URL("../bin.ts", import.meta.url)),
];

/** The command that starts the release installed in `install` (a directory with `node_modules/`). */
export function releaseOf(install: string): readonly string[] {
	return [process.execPath, join(install, "node_modules", "@earendil-works", "p3", "dist", "p3.js")];
}
```

The races are made deterministic by holding a process still, never by sleeping. `test/gate.ts` is a preload
(`node --import`) that patches `fs.promises` where the kit finds it:

```ts
fs.promises.rename = async (from, to) => {
	const record = String(to).endsWith("/server.json") ? stateOf(from) : undefined;
	if (at === "lock" && record === "starting") await hold();
	await rename(from, to);
	if (at === "running" && record === "running") await hold();
};
fs.promises.readFile = (async (path: fs.PathLike, ...rest: []) => {
	if (at === "plugins" && String(path).endsWith("/plugins/sessions/package.json")) await hold();
	return readFile(path, ...rest);
}) as typeof readFile;
fs.promises.rm = async (path, options) => {
	if (at === "supervisor-exit" && supervisor && String(path).endsWith("/supervisor.json")) await hold();
	return rm(path, options);
};
syncBuiltinESMExports();
```

`hold()` writes the pid into `<gate>/held` and waits until `<gate>/go-<pid>` exists. Five points: `lock` (before the
`starting` record is in place), `plugins`, `running` (the record says `running`, the start has not returned),
`supervisor` (before its lock), `supervisor-exit` (before it lets its lock go). The same preload works for the source
and the release: Node loads it, not p3. Chapter VII's held run used it against the install.

## The cases, by name

All twenty, each run from source and from the install:

1. status says whether a server runs and what it is; a stopped server leaves no record
2. plain p3 starts the server in the background once, and prints a fresh owner link each time
3. stop returns once the data directory is free; restart keeps the port and the sessions
4. a crashed server is started again by its supervisor; stop ends both
5. a record whose process exists is not believed while nobody holds the lock
6. a supervisor starting its server: status says so, and plain p3 waits for that server
7. a server that holds the lock is starting: status says so, stop and plain p3 wait for it to run
8. a record of an earlier server naming another process now: that process is never signalled
9. the record says running only once the owner link is ready: plain p3 gets one at once
10. a supervisor starting its server again after a crash: stop waits for that server to run
11. a signal during the start closes the server once it started
12. stop asks the server over HTTP: it needs no signal, in the foreground and in the background
13. two plain p3 at once leave one supervisor: a stop right after leaves nothing that starts again
14. a running record is the server's only once it proves itself: another program, a replayed proof, another run
15. the owner token goes only over the connection the proof came over: a server that closes takes it nowhere
16. a question has a deadline and a size: a program that drips or floods holds no command
17. an older Node than p3 supports is refused with one line, before anything runs
18. a busy port fails the start at once, in the foreground and in the background
19. two Pis run side by side: their own ports, sessions and sign-in cookies; stopping one leaves the other
20. a command line p3 does not understand is refused with the usage

Under load (four suites at once, three times) 11 of 12 runs failed before round 3's fixes (waits on an extra
supervisor's lifetime; the default Pi's case on port 8789, which another run or a real Pi may hold). After them 12 of
12 pass, and 10 serial runs pass. The default Pi's case now starts with `--port 0`.

# The Numbers {#numbers lede="Source and release side by side, on slayer, Node 24.4.1."}

`bench/slice-1.ts` against a launched server; `--release <install>` for the release. The first part's table, three
runs each, launch numbers medians of five:

| | Source | Release |
| --- | --- | --- |
| process launch to listening, cold (empty compile cache) | 480–483 ms | 125–137 ms |
| process launch to listening, warm | 154–157 ms | 100–127 ms |
| server `RssAnon` (alone, 11 workers running) | 76.0–77.8 MiB | 39.8–43.9 MiB |
| worker start, cold / warm | 212–256 / 90–92 ms | 152–217 / 79–81 ms |
| the list at 100,000 sessions: open, `more` | 0.63, 0.45 ms | 0.62, 0.45 ms |

- **Cold, the release is 3.6 times faster:** no type stripping, four files instead of several hundred modules. Warm
  the gap is small: the compile cache already serves the source path's stripped modules.
- **The server needs half:** it no longer keeps every module's source and the type stripper.
- **The list does not move:** the same code.

The commands, after all three parts (one run, load average about 10 on 32 cores):

| | Source | Release |
| --- | --- | --- |
| `p3`: a background start, to its owner link (median of 20) | 398 ms | 252 ms |
| `p3` again: the running server's fresh link | 161 ms | 90 ms |
| `p3 status` | 170 ms | 109 ms |
| `p3 stop`, until the directory is free | 197 ms | 133 ms |
| the supervisor's USS | 23.2 MiB | 16.3 MiB (10.8 settled, with the bundle of its own) |

`status` from the release is about 110 ms, of which the answer itself (two lock probes, a file, one HTTP question) is a
few milliseconds: the rest is Node's start and loading `main.js`.

## What every start builds

Nothing built is kept between starts (decision "No build cache"). Measured with `NODE_DEBUG=p3`:

| Every start | Source | Release |
| --- | --- | --- |
| the server's plugins built and loaded (before the listen) | 27 ms | 32–34 ms |
| the worker base built (after the listen; the first worker waits for it) | 134–138 ms | 114–121 ms |

The plugin build is one esbuild call per facet: with one plugin a quarter of a warm launch, and it grows with the
number of plugins; with the 60 or so p3 will have, a cache on disk would pay. The worker base costs the same in both
paths because Chord bundles the entry again even when it already is a bundle; a release could hand Chord a ready base
(a Chord change, Carried).

# Open Points {.epilogue lede="What the owner decided, what is carried, and what to look at in the review."}

## Decided by the owner during the slice

- The package name, `@earendil-works/p3`, private until publishing; the built-in plugin `@earendil-works/p3-sessions`.
- The workspace's `package.json` is the shipped one; the lockfile change is allowed (shown before the commit).
- Chord exports the types a contract's declaration needs (decision F).
- `ws` a dependency, pinned to Chord's 8.21.0.
- The commands, the background server as supervisor, `server.json`, several Pis.
- `p3 stop` asks over HTTP first; the server proves who it is by an HMAC of a nonce keyed by the owner token (choice B).
- The worker-only entry; the memory levers; the budget of 55 MiB on every Node.
- The test hooks `startWorker({ session })` and `startServer({ facets })`.

## Carried

- Publishing the lockstep version of Chord, pi-schema and pi-telemetry that p3's types need (npm's 1.5.2 predates
  them), and p3's own version joining it; publishing from CI, a CHANGELOG for p3; an install lock for installers.
- A build cache on disk (decided against for now), or a ready worker base in the release (a Chord change).
- A Bun or single-file binary; the terminal client behind plain `p3` (slice 27); a restart requested from the page
  (slice 2); starting a Pi at boot; the web and terminal bundles in the package (slice 16).
- Slice 3 replaces `startWorker({ session })` with the harness as an object in the worker's core facet.
- What Node 26 holds after a burst (about 7 MiB above Node 24).
- **Windows, not run natively:** the Windows branches (PowerShell's start time, `windowsHide`, HTTP stop) were run on
  Linux by selecting them; the suite reads `/proc` and needs a POSIX shell; Chord's `processLock` on named pipes;
  `release:p3:local` there; the data directory's privacy (0700 and 0600 do nothing there: the owner token, and so the
  identity proof, rest on the profile directory's ACL); a supervisor a command ends on Windows is terminated at once,
  and a child server it had started stays.

## Worth a look in the review

- **The package's size.** Chord is in it twice (`main.js`, `worker.js`), and Chord's installed package is 15 MB of
  sources and declarations for the types alone. Bundling the declarations into p3's package was not done.
- **The identity proof's scope:** other users on the machine. The owner's own processes read the token file anyway.
- **The supervisor's backoff** beyond its first wait has no test.

# How to Run It {.appendix}

```sh
export PATH=/home/badlogic/node-v24.4.1-linux-x64/bin:$PATH
cd /home/badlogic/pi

# from source
node --conditions=source --disable-warning=ExperimentalWarning apps/p3/bin.ts            # plain p3
node --conditions=source --disable-warning=ExperimentalWarning apps/p3/bin.ts server --dir /tmp/pi-a

# the release: build, pack, install outside the repository, run the release tests
npm run release:p3:local -- --out /tmp/p3-release --force      # [--skip-test] [--bench]
/tmp/p3-release/p3 --version
/tmp/p3-release/p3                 # start the default Pi in the background, print its owner link
/tmp/p3-release/p3 status
/tmp/p3-release/p3 list
/tmp/p3-release/p3 stop

# the tests
cd apps/p3 && npm test                                          # 134 tests, about 12 s
P3_RELEASE=/tmp/p3-release/install npm run test:release         # what release:p3:local runs
npm run build                                                   # dist/ only

# start timings
NODE_DEBUG=p3 /tmp/p3-release/p3 server --dir /tmp/pi-a
```

The traces in this walkthrough ran with `HOME=/tmp/s26w/home` so that no real Pi was touched.
