---
title: p3 slice 1, redone: base and sessions
cover: Slice 1 / Taken Apart
kicker: A walkthrough · p3 slice 1 (redo) · 2026-11-15
subtitle: Every file of the base and the sessions plugin, with its code, followed through three real paths, a request, a rename and a revoke
stats:
  - 1,587 | lines of base code and plugin
  - 65 | tests in about 2 s
  - 48 | rules a test pins (mutation check)
  - 35 MiB | what one more idle session worker costs
note: |
  For the owner, who reviews slice 1 before it is committed. Self-contained: every piece of code that matters is
  printed here, from the tree as the four reviewers approved it (uncommitted, on top of `e6242cc4e`). The brief is
  `apps/p3/docs/slices/01-base-and-sessions.md`; the practices it follows are `apps/p3/docs/chord-practices.md`.
  Code blocks are the files' text; imports are left out. Nothing here is proposed: all of it is built and tested.
colophon: p3 slice 1 walkthrough · second edition (the redo) · 2026-11-15 · apps/p3, packages/chord
---

# Every File {.preface .nodrop}

Slice 1 is a headless p3: a server, a worker process per session, an owner who signs in and creates, lists, renames,
archives and restores sessions. This is everything it consists of. Sizes are lines.

## Base code (a restart changes it)

| File | Lines | What it is for |
| --- | --- | --- |
| `apps/p3/server.ts` | 28 | `startP3`: gives the kit the data directory, the plugins root, the port and the worker's entry |
| `apps/p3/bin.ts` (slice 26) | 43 | the command: starts the server on `~/.pi/p3`, port 8789, prints the owner link, closes on a signal |
| `src/install.ts` (slice 26) | 31 | where p3's files are, in a checkout or in the built package: the plugins root, the worker's entry |
| `apps/p3/worker.ts` | 7 | a session worker's entry: one call of the kit's `startWorker` |
| `src/principals.ts` | 15 | who someone is: `owner`, `person`, `worker`, `server`, as a schema and its type |
| `src/app.ts` | 32 | p3's name, API modules, facet kinds, and the principals links stamp |
| `src/session-route.ts` | 22 | who reaches a session's worker: `mayReachSession`, `sessionExists` |
| `src/api/v1/index.ts` | 26 | what every plugin imports: Chord's surface, `defineFacet`, `Server`, `Session`, `forward`, `contribute` |
| `src/api/v1/server.ts` | 19 | for server facets: `AppInfo`, `Http`, `SessionRoute` |
| `src/api/v1/worker.ts` | 4 | for worker facets: `WorkerInfo` |

## The kit (`src/kit/`, base code too; copied from Chord's app kit and cut down)

| File | Lines | What it is for |
| --- | --- | --- |
| `start-server.ts` | 149 | `startServer`: the order of a start, and what it opens on disk |
| `app.ts` | 108 | the running app: what it reports, the owner link, the workers, the close |
| `session-workers.ts` | 64 | the workers component for sessions; what the server sends a worker |
| `worker.ts` | 47 | `startWorker`: a worker's store, host, link and plugins |
| `sign-ins.ts` | 300 | `SignIns`: issue, verify, revoke; the authenticator; the rolling cookie; a sign-in's open links |
| `owner.ts` | 112 | the one-time owner link and the owner token file |
| `secrets.ts` | 75 | tokens, hashes, secret files of mode 0600 |
| `layout.ts` | 104 | the data directory: its paths, private directories and stores, a worker's directory |
| `info.ts` | 43 | the start-data objects `AppInfo` and `WorkerInfo` |
| `forward.ts` | 42 | `forward`: a view's members from a store's reference |
| `contribute.ts` | 22 | `contribute`: an object that only contributes |

The same seven files in Chord's kit are 1,726 lines (about 2,600 with what they import of it); p3's nine are 1,002,
plus 64 for the two helpers.

## The sessions plugin (`plugins/sessions/`; a reload changes it)

| File | Lines | What it is for |
| --- | --- | --- |
| `contract.ts` | 112 | the contracts, one per audience: `Sessions`, `SessionsList`, `SessionFacts`, `SessionWorker` |
| `contract.server.ts` | 25 | `SessionsStore`: the store's contract, with its named queries |
| `server.ts` | 144 | the table, the store, the views, `SessionRoute` |
| `worker.ts` | 13 | `SessionWorker` on the session's worker |
| `package.json` | 5 | its name, `@p3/sessions` |

## Tests and numbers

| File | Lines | What it is for |
| --- | --- | --- |
| `plugins/sessions/sessions.test.ts` | 169 | plugin tier: the server facet alone, built as production builds it |
| `test/sessions.test.ts` | 307 | topology tier: server and workers in one process |
| `test/topology.ts`, `until.ts`, `client.ts` | 230, 31, 24 | the test topology; waiting for a value; an owner client over WebSocket |
| `test/plans.test.ts` | 86 | SQLite's plan of every statement the store's queries run |
| `test/app.test.ts`, `end-to-end.ts`, `api.test.ts` | 33, 52, 15 | end to end: the real server, a forked worker (the case is shared with slice 26's launched and release tests); the API module |
| `test/kit/*.test.ts` (9 files), `support.ts` | 940, 133 | the kit's tests, one file per kit file |
| `bench/slice-1.ts` | 346 | the numbers of the last chapter (slice 26 added a launched server to it) |

## Chord (`packages/chord/`)

| Change | Files | Why p3 needs it |
| --- | --- | --- |
| `memberNames(contract, variant)` (uncommitted, with slice 1) | `src/contracts/contract.ts` (+18), `index.ts` (+2), its test (+34), README, CHANGELOG | `forward` must know which members a view has |
| `links.opened(request, principal, close)` (uncommitted, with slice 1) | `src/node/http/http.ts`, `upgrades.ts` (about 12 changed lines), its test (+32), README, CHANGELOG | the kit closes the links of a sign-in that ended |
| a framed source set several times in one commit publishes one frame (`36c709e72`, committed) | `src/state/framed.ts` (51), tests (293) | a list row moving between two loaded pages closed the owner's link |
| a watched derive changed twice in one commit publishes one frame (`f6600b58f`, committed) | `src/state/derive.ts` (20), tests (183) | the same protocol error, by another path |

Docs: the brief `docs/slices/01-base-and-sessions.md`, `docs/overview.md`, `README.md`, this walkthrough.

:::note | Second printing, 2026-11-16
The code is printed from the tree as it is now, which includes slice 26 (the release build). Slice 26 moved the
start script out of `server.ts` into the command `bin.ts`, added `src/install.ts`, and added two timing lines to
`start-server.ts` (printed only with `NODE_DEBUG=p3`). Nothing else of slice 1 changed. Slice 26's own files (the
build, the release tests) are not part of this walkthrough.
:::

## Eight things to know

:::findings
1. **The kit is p3's now.** The parts of Chord's app kit that slice 1 uses were copied into `src/kit/` and cut to
   what it uses. It is typed to p3: no principal parameter, one worker kind (sessions).
2. **A session is one table row.** No second document, nothing written twice. State, last touch and the archive time
   are columns.
3. **Reads are named queries.** The store offers `active`, `archived` and `one`. The owner's list, each worker and
   the route to workers read them live; a write runs only the reads it can change.
4. **The list has no cap.** One list object per screen, 50 rows, `more` for the next 50. Only new rows cross the link.
5. **One audience per contract.** The owner, a session's worker and the server each get their own contract; a view is
   filled from the store with `forward`.
6. **No worker starts for a session that does not exist.** The route asks the sessions table before anything starts.
7. **A sign-in that ends takes its links with it,** and only its own: the owner's other devices notice nothing.
8. **Every rule has a test that fails without it.** 48 rules were undone one at a time; each time a test, or the
   type check, failed.
:::

## Words used throughout

The **owner** owns the Pi; a **person** is anyone else (none is let in yet). A **principal** says who calls; the
link a call arrives on stamps it. A **session** is one agent workspace with its own **worker** process and store; its
**address** is `Session({ id })`. A **contract** declares an object type: its members and who it is for. A **store**
is a `local` object that owns data; a **view** is a `remote` object that shows one audience part of a store. A
**named query** is a query a store offers under a name. A **sign-in** is one browser or device signed in as someone.
The **kit** is p3's base code that starts the server and the workers.

# Who Is Who {#principals lede="Two small files that everything else imports."}

`src/principals.ts`. The principal is identity only (decision of 2026-11-13): what someone may do is data, read where
it is needed. It is a schema, so that `SignIns` can check a value before it stores it.

```ts
// p3's principals (decision "The principal is identity only", 2026-11-13): who someone is, never what they may do.
// What a person may do is data of apps and plugins, read live by admissions.

/** Who someone is in p3: the owner, a person the owner let in, a session's worker, or the server. */
export const P3Principal = union([
	obj({ kind: lit("owner") }),
	obj({ kind: lit("person"), id: str(), name: str() }),
	obj({ kind: lit("worker"), session: str() }),
	obj({ kind: lit("server") }),
]);

/** Who someone is in p3 (see `P3Principal`). */
export type P3Principal = Static<typeof P3Principal>;
```

`src/app.ts` is p3's vocabulary for the kit, the entries and the tests. `PRINCIPALS.worker` turns a session's address
into its worker's principal: the server stamps that principal on the worker's link, so a worker cannot claim to be
another session's.

```ts
// What p3 is to its kit, its entries and its tests: its name, its API (the package, its versions, this process's
// instances of the modules), its facet kinds and its principals as links stamp them.

/** p3's name: its default data directory is `~/.pi/p3`. */
export const NAME = "p3";

/** p3's API: its package, its versions (newest first) and this process's modules by specifier. */
export const API = {
	name: "@p3/app",
	versions: ["v1"],
	modules: { "@p3/app/v1": v1, "@p3/app/v1/server": v1server, "@p3/app/v1/worker": v1worker },
};

/** p3's facet kinds: a plugin has one file per kind it runs on (`server.ts`, `worker.ts`). */
export const KINDS = { server: { platform: "node" }, worker: { platform: "node" } } as const;

/** p3's principals as links stamp them: the server's, a session worker's, the owner's. */
export const PRINCIPALS: {
	readonly server: P3Principal;
	readonly worker: (address: Address<typeof v1.Session>) => P3Principal;
	readonly owner: P3Principal;
} = {
	server: { kind: "server" },
	worker: (address) => ({ kind: "worker", session: address.params.id }),
	owner: { kind: "owner" },
};
```

# What a Plugin Imports {#api lede="Plugins never import Chord. They import p3's API, of which each process has one instance."}

`src/api/v1/index.ts` (`@p3/app/v1`). A plugin's build leaves this module out; the process that evaluates the plugin
passes its own instance in, so contracts and helpers are the same objects everywhere in a process.

```ts
// p3's API, version 1, for every host kind (`@p3/app/v1`): Chord's plugin surface re-exported once (so a plugin that
// needs one more of Chord's exports never forces an API change), `defineFacet` typed with p3's principals, p3's host
// kinds, and the kit's helpers for plugins (`forward`, `contribute`). Plugins import this module, never Chord: their
// builds leave it out and each process passes its own instance in.

// Everything of Chord's root; the names this module defines itself (`defineFacet`, `Server`, `Session`) win over a
// same-named export of Chord's.
export * from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
export { contribute } from "../../kit/contribute.ts";
export { forward } from "../../kit/forward.ts";
export type { P3Principal } from "../../principals.ts";

/** Defines a facet of p3: its factories get p3's principals. */
export function defineFacet(setup: (host: FacetHost<P3Principal>, self: FacetSelf) => void) {
	return chordFacet<P3Principal>(setup);
}

/** The server: one per Pi. */
export const Server = hostKind("server");

/** A session: a worker process of its own, with its own store. */
export const Session = hostKind("session", { id: str() });
```

`src/api/v1/server.ts` (`@p3/app/v1/server`). `SessionRoute` is declared here, in base code, and served by the
sessions plugin. The reason is in its comment; chapter VII uses it.

```ts
// p3's API v1 for server facets (`@p3/app/v1/server`): what only server facets import. The kit's start data on the
// server (`AppInfo`), the registry of HTTP routes (`Http`), and the contracts base code reads and a plugin serves
// (`SessionRoute`).

export { Http } from "@earendil-works/chord/http";
export { AppInfo } from "../../kit/info.ts";

/**
 * What the route to a session's worker asks before it starts or reaches one: whether the session exists. The API owns
 * the contract because the route is base code, which never reloads and keeps the contract it was built with; the
 * sessions plugin serves it.
 */
export const SessionRoute = local("p3.session-route", {
	version: 1,
	params: { session: str() },
	members: { exists: bool() },
});
```

`src/api/v1/worker.ts` is one line: `export { WorkerInfo } from "../../kit/info.ts";`

# The Server Starts {#start lede="A command and one function decide four things; the kit does the rest, in an order that matters."}

`server.ts`, whole: `startP3` is what tests and the command call.

```ts
// The p3 server (decision "Base entries are named after what they are"): `startP3` gives the kit what the start
// decides (the data directory, the plugins root, the port, the session worker's entry), the kit does the rest. The
// command that calls it is `bin.ts`.

/** p3's port: p2 keeps 8788. */
const PORT = 8789;

/** Starts p3 on `dataDir` (`~/.pi/p3` by default) with its built-in plugins from `root`, listening on `port`. */
export function startP3(
	context: Context,
	options: { readonly dataDir?: string; readonly root?: string; readonly port?: number } = {},
): Promise<App> {
	return startServer(
		{
			...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
			root: options.root ?? PLUGINS,
			listen: { host: "127.0.0.1", port: options.port ?? PORT },
			worker: WORKER,
			onError: (error) => console.error("p3:", error),
		},
		context,
	);
}
```

The start script is `bin.ts`, the `p3` command. Slice 26 moved it here from `server.ts` (which until then started
the server when run as a script), so that the same file runs from source and, bundled, as the released package's
command. Whole:

```ts
// The `p3` command: starts the server and prints the owner link. The same file runs from a source checkout
// (`node --conditions=source bin.ts`) and, bundled, as the installed package's `p3`. It closes the server on SIGINT and
// SIGTERM, so workers stop and the data directory's lock is free at once.

const USAGE = `Usage: p3 [dataDir] [--port <n>]

Starts the p3 server on dataDir (default: ~/.pi/p3) and prints the owner link.

Options:
  --port <n>   The port to listen on, on 127.0.0.1 (default: 8789; 0: a free one)
  --version    Print p3's version
  --help       Print this help`;

const { values, positionals } = parseArgs({
	options: { port: { type: "string" }, version: { type: "boolean" }, help: { type: "boolean" } },
	allowPositionals: true,
});
if (values.help === true) {
	console.log(USAGE);
} else if (values.version === true) {
	console.log(version());
} else {
	const port = values.port === undefined ? undefined : Number(values.port);
	// A trust boundary: the command line.
	if (positionals.length > 1 || (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535))) {
		console.error(USAGE);
		process.exit(2);
	}
	const [dataDir] = positionals;
	const app = await startP3(context, {
		...(dataDir === undefined ? {} : { dataDir }),
		...(port === undefined ? {} : { port }),
	});
	console.log(`p3 on ${app.dataDir}. Open ${app.ownerLink()}`);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => void app.close(context).finally(() => process.exit(0)));
	}
}
```

`src/install.ts` (slice 26) answers where p3's own files are, so that neither `server.ts` nor the kit builds such a
path. In a checkout the worker's entry is `worker.ts`, run with the flag that resolves workspace sources:

```ts
// Where p3's own files are. p3 runs from a source checkout (TypeScript, with the condition `source`: development,
// the tests) or from its built package (`dist/`, JavaScript: the release). Base code asks here for the plugins root,
// the worker's entry and the version, and never builds such a path itself. In both layouts this module's directory
// (`src/`, or `dist/` once bundled into `dist/main.js`) lies directly under p3's root.

/** Whether this is a source checkout: its files are TypeScript. */
const SOURCE = import.meta.filename.endsWith(".ts");

/** p3's root: `apps/p3` of a checkout, or the installed package. */
const ROOT = join(import.meta.dirname, "..");

/** The built-in plugins root: plugins are source in both layouts (the server builds them when it starts). */
export const PLUGINS = join(ROOT, "plugins");

/**
 * How a session's worker starts: the source entry with the flag that resolves workspace sources, or the built one.
 * Neither prints Node's experimental warnings (type stripping, `node:sqlite`).
 */
export const WORKER: WorkerOptions = SOURCE
	? { entry: join(ROOT, "worker.ts"), execArgv: ["--conditions=source", "--disable-warning=ExperimentalWarning"] }
	: { entry: join(import.meta.dirname, "worker.js"), execArgv: ["--disable-warning=ExperimentalWarning"] };

/** p3's version: its `package.json`'s. */
export function version(): string {
	// p3's own manifest: the checkout's, or the one the release build generated.
	return (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
}
```

:::flow wide | What a start makes, in order. The accent boxes are p3's kit; the others are Chord's components, used as they are.
row "on disk" muted
box lock "lock" "one server per data directory" muted
box layout "layout" "directories 0700, stores 0600" accent
box store "server store" "SQLite" muted
row "in the process" accent
box host "host" "at `Server()`, acts as the server" muted
box http "HTTP" "`/chord` links, deny by default" muted
box plugins "plugins" "builds `plugins/*`" muted
box workers "session workers" "route + fork" accent
row "core facets, loaded with the plugins" accent
box info "p3.info" "`AppInfo`" accent
box signins "p3.sign-ins" "`SignIns`, authenticator" accent
box owner "p3.owner" "the owner link" accent
arrow lock -> layout "then"
arrow layout -> store "then"
arrow host -> http ""
arrow http -> plugins ""
arrow plugins -> workers ""
:::

`src/kit/start-server.ts`, whole. Read `startServer` top to bottom: it is the order of a start.

```ts
// `startServer`: the p3 server. It opens the server's part of the data directory (its lock, the layout, the cookie
// secret, the store), creates the server host, Chord's HTTP component, its plugins component over p3's built-in root
// and the session workers, loads the server's plugins with the kit's own facets (the start data, sign-ins, the owner
// link), and gives its caller the running app. Right after the listen, off the start's path, it builds the workers'
// base.

/** What a start cost, printed with `NODE_DEBUG=p3` (nothing is formatted without it). */
const debug = debuglog("p3");

/** What `startServer` takes: what the start script decides. */
export type ServerOptions = {
	/** The data directory (no environment variables): `~/.pi/p3` by default. */
	readonly dataDir?: string;
	/** p3's built-in plugins root: a plugin of it failing stops the start. */
	readonly root: string;
	/** Where the server listens. */
	readonly listen: ListenAddress;
	/** How a session's worker starts. */
	readonly worker: WorkerOptions;
	readonly onError: (error: AppError) => void;
};

/**
 * Starts the p3 server: resolves once its plugins are loaded and it listens. A failing plugin of the root (or a
 * problem discovery reports there) rejects with the plugins component's `PluginError`, everything closed. The session
 * workers' base is built right after the listen, from the files as they are then: a worker start waits for it.
 */
export async function startServer(options: ServerOptions, context: Context): Promise<App> {
	const { layout, cookieSecret, store, lock } = await openServer(
		resolve(options.dataDir ?? defaultDataDir()),
		context,
	);
	const { onError } = options;
	const signIns = createSignIns(cookieSecret);
	const host = createHost<P3Principal>({
		address: Server(),
		principal: PRINCIPALS.server,
		store,
		onError: (error) => onError({ kind: "host", error }),
	});
	const http = createHttp(
		host,
		{
			listen: options.listen,
			links: { path: "/chord", opened: signIns.opened },
			onError: (error) => onError({ kind: "http", error }),
		},
		context,
	);
	const plugins = createPlugins(
		{
			roots: [{ path: resolve(options.root), required: true }],
			api: { name: API.name, versions: API.versions },
			kinds: Object.fromEntries(
				Object.entries(KINDS).map(([name, { platform }]) => [name, { platform, hostPackages: apiModules(name) }]),
			),
			onError: (error) => onError({ kind: "plugins", error }),
		},
		context,
	);
	const server = { host, store, plugins };
	const workers = sessionWorkers(
		options.worker,
		server,
		layout,
		(error) => onError({ kind: "workers", error }),
		context,
	);
	const link = new OwnerLink();
	const core = [
		{ name: "chord.http", facet: http.facet },
		{ name: "p3.info", facet: appInfoFacet({ dataDir: layout.dataDir, name: NAME, version: API.versions[0]! }) },
		{ name: "p3.sign-ins", facet: signIns.facet },
		{ name: "p3.owner", facet: ownerFacet(link) },
	];
	const app = new RunningApp({ host, http, workers, store, plugins, lock }, layout);
	try {
		const loading = performance.now();
		await plugins.load(host, { kind: "server", core, modules: API.modules }, context);
		debug("server plugins built and loaded in %d ms", Math.round(performance.now() - loading));
		await ownerTokenFile(layout.ownerToken, host, context);
		app.started(link.renew(), await http.listening(context));
	} catch (error) {
		await app.close(context);
		throw error;
	}
	// Not awaited: the server answers meanwhile. `build` never rejects; a failure after the close is dropped.
	const building = performance.now();
	void workers.build().then((built) => {
		debug("worker base built in %d ms", Math.round(performance.now() - building));
		if (built.kind === "failed" && !app.closing()) onError({ kind: "base_build", error: built.error });
	});
	return app;
}

/** The API's modules a facet of kind `kind` may import: the shared and the kind's own module of every version. */
function apiModules(kind: string): string[] {
	return API.versions.flatMap((version) => [`${API.name}/${version}`, `${API.name}/${version}/${kind}`]);
}

/** How long a second server waits for the data directory's lock before it is refused. */
const SERVER_LOCK_MS = 1000;

/**
 * The server's own part of the data directory `path`: its lock (one server per data directory, by its real path: a
 * second one, also through a symbolic link, would share its stores and secrets), the layout made private, the cookie
 * secret and the server's store; the lock released when the rest fails.
 */
async function openServer(
	path: string,
	context: Context,
): Promise<{ layout: Layout; cookieSecret: string; store: Store; lock: ProcessLock }> {
	const dataDir = await openDataDir(path);
	const waited = AbortSignal.timeout(SERVER_LOCK_MS);
	const lock = await processLock(`${NAME}-server:${dataDir}`, withAbortSignal(waited, context)).catch(
		(error: unknown) => {
			throw waited.aborted ? new Error(`startServer: another server runs on ${dataDir}`) : error;
		},
	);
	try {
		const layout = await createLayout(dataDir);
		const cookieSecret = await secretFile(layout.cookieSecret);
		await privateStore(layout.serverStore);
		const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(layout.serverStore)), context);
		return { layout, cookieSecret, store, lock };
	} catch (error) {
		await lock.release();
		throw error;
	}
}
```

Four things in it are decisions, not plumbing:

- **The lock comes first** and is by the directory's real path: a second server on the same data, also through a
  symbolic link, is refused after one second.
- **`links.opened: signIns.opened`**: the kit hears every link the HTTP component accepts. Chapter IX needs it.
- **A plugin of the root that fails stops the start** (`required: true`), and everything opened is closed: `app` is
  made before the load so that the `catch` can close it.
- **The worker base is built after the listen, not awaited.** The server answers at once; the first worker start
  waits for the build if it is still running.

The two `debug(…)` lines are slice 26's: with `NODE_DEBUG=p3` the kit prints what the plugin builds and the worker
base cost at a start; without it nothing is formatted.

`src/kit/app.ts`: what `startP3` returns, and the close order.

```ts
// The running app: what `startServer` gives its caller. The server's host, its session workers, the data directory,
// the owner's link of this start and token file, and the close.

/**
 * What the kit reports: from its host, its HTTP component, its workers or its plugins, or the session workers' base
 * that did not build after the start (`base_build`: the server runs on, workers fail their start).
 */
export type AppError =
	| { readonly kind: "host"; readonly error: HostError }
	| { readonly kind: "http"; readonly error: HttpError }
	| { readonly kind: "workers"; readonly error: WorkersError }
	| { readonly kind: "plugins"; readonly error: PluginsError }
	| { readonly kind: "base_build"; readonly error: unknown };

/** A running p3 server. */
export interface App {
	readonly host: Host<P3Principal>;
	/** The session workers: their state, `stop` and `retry`. */
	readonly workers: Workers<typeof Session>;
	/** The data directory. */
	readonly dataDir: string;
	/** The owner link of this start (single use, 10 minutes): `http://127.0.0.1:<port>/_p3/owner#<token>`. */
	ownerLink(): string;
	/** The owner token file's path (a device sign-in of the owner, mode 0600). */
	readonly ownerTokenFile: string;
	/** Closes the HTTP component, the workers, the host, the store, the plugins and the data directory's lock. */
	close(context: Context): Promise<void>;
}

/** What a running app is made of and closes. */
export type AppParts = {
	readonly host: Host<P3Principal>;
	readonly http: HttpComponent<P3Principal>;
	readonly workers: Workers<typeof Session>;
	readonly store: Store;
	readonly plugins: Plugins;
	readonly lock: ProcessLock;
};

/** The `App` of `startServer`: made before the server's plugins load, so a failed start closes what it opened. */
export class RunningApp implements App {
	readonly host: Host<P3Principal>;
	readonly workers: Workers<typeof Session>;
	readonly dataDir: string;
	readonly ownerTokenFile: string;
	readonly #parts: AppParts;
	/** The owner link, once the server listens. */
	#link: string | undefined;
	#closing: Promise<void> | undefined;

	constructor(parts: AppParts, layout: { readonly dataDir: string; readonly ownerToken: string }) {
		this.host = parts.host;
		this.workers = parts.workers;
		this.dataDir = layout.dataDir;
		this.ownerTokenFile = layout.ownerToken;
		this.#parts = parts;
	}

	/** The start finished: the owner link's token and the address it names (the one listened on). */
	started(token: string, listening: ListenAddress): void {
		this.#link = `http://${linkHost(listening.host)}:${listening.port}${OWNER_PATH}#${token}`;
	}

	ownerLink(): string {
		if (this.#link === undefined) throw new Error("ownerLink: the server has not started");
		return this.#link;
	}

	/** Whether the app is closing or closed: what runs after the start reports nothing more. */
	closing(): boolean {
		return this.#closing !== undefined;
	}

	close(context: Context): Promise<void> {
		this.#closing ??= this.#close(context);
		return this.#closing;
	}

	/**
	 * The close, in order: HTTP (it drains requests the host's close would seal), workers, host, store, the plugins'
	 * watcher, then the data directory's lock.
	 */
	async #close(context: Context): Promise<void> {
		const { http, workers, host, store, plugins, lock } = this.#parts;
		await http.close(context);
		await workers.close(context);
		await host.close(context);
		await store.close(context);
		plugins.close();
		await lock.release();
	}
}

/** The host of the owner link for the address listened on: loopback for a wildcard, an IPv6 address in brackets. */
function linkHost(host: string): string {
	if (host === "0.0.0.0" || host === "") return "127.0.0.1";
	if (host === "::") return "[::1]";
	return host.includes(":") ? `[${host}]` : host;
}
```

The data directory, as `src/kit/layout.ts` makes it (the file is in the appendix):

```text
~/.pi/p3/                        0700, like every directory below
  server/store.sqlite            the server's store, 0600 (sessions, sign-ins)
  server/cookie-secret           0600
  workers/session/<address>/     one per session: store.sqlite
  cache/worker/                  the worker base, written again at every start
  cache/node/                    Node's compile cache for the workers
  owner-token                    0600
```

# Signing In {#signing-in lede="No owner by loopback alone. A link printed at start, a token file, a cookie; all three are sign-ins."}

A **sign-in** is a row in one document: an id, the hash of a secret, a principal. The token a client holds is
`<id>.<secret>`; the server never stores the secret.

`src/kit/sign-ins.ts`, first part: the object's contract and its document.

```ts
export type SignInKind = "browser" | "device";

/** The kit's sign-ins (one per server): issue, verify, revoke, and the watchable list of them. */
export const SignIns = local("p3.sign-ins", {
	version: 1,
	params: {},
	members: {
		/** The sign-ins: never a token or a hash. */
		list: arr(
			obj({
				id: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: P3Principal,
				created: num(),
				lastUsed: num(),
			}),
		),
		/**
		 * A new sign-in for `principal`: its id, its token (shown once, kept only hashed) and the sign-in cookie carrying
		 * it for a browser (`Set-Cookie`; `secure` for a remote one).
		 */
		issue: method(
			obj({ principal: P3Principal, label: str(), kind: oneOf("browser", "device"), secure: opt(bool()) }),
			obj({ id: str(), token: str(), cookie: str() }),
		),
		/** The principal `token` authenticates as, or `null` (unknown, revoked, expired, malformed). */
		verify: method(str(), union([P3Principal, nul()])),
		/** Ends sign-in `id` at once: its token authenticates nothing more, and its open links are closed. */
		revoke: method(str()),
	},
});

/** The name of the sign-in cookie. */
export const SIGN_IN_COOKIE = "p3-sign-in";

/** The stored sign-ins: by id, each with its secret's hash and its principal. */
const SignInsDocument = defineState("p3.sign-ins", {
	schema: obj({
		signIns: map(
			obj({
				hash: str(),
				label: str(),
				kind: oneOf("browser", "device"),
				principal: P3Principal,
				created: num(),
				lastUsed: num(),
			}),
		),
	}),
	version: 1,
	initial: () => ({ signIns: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 50,
});
```

The facet. It serves `SignIns` and contributes two things to Chord's HTTP component: an authenticator (who is this
request?) and a wrap that renews a browser's cookie.

```ts
/** How long a sign-in lives unused: 400 days, as its cookie. */
const SIGN_IN_IDLE_MS = 400 * 24 * 60 * 60_000;

/** The facet of `createSignIns`. */
function signInsFacet(cookieSecret: string, links: SignInLinks): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) =>
		host.serve(SignIns, (_params, self) => {
			const document = self.state(SignInsDocument);
			links.serve((id) => {
				const signIns = document.value.signIns;
				return Object.hasOwn(signIns, id) && Date.now() - signIns[id]!.lastUsed <= SIGN_IN_IDLE_MS;
			});
			/** Ends sign-in `id`: removed from the store, then its open links closed. */
			const end = async (id: string, context: Context): Promise<null> => {
				await document.change((draft) => {
					delete draft.signIns[id];
				}, context);
				links.close(id);
				return null;
			};
			const authenticate = (token: string, context: Context) => authenticated(document, token, end, context);
			self.contribute(Authenticators, (request, context) => {
				const token = requestToken(request, cookieSecret);
				const principal = token === undefined ? undefined : authenticate(token, context);
				// A token that authenticates names its sign-in.
				if (principal !== undefined) links.signedIn(request, signInOf(token!)!);
				return principal;
			});
			self.contribute(Http, { wraps: [rollingCookie(cookieSecret, authenticate)] });
			return {
				list: self.derive([document], ([value]) =>
					Object.entries(value.signIns).map(([id, { hash: _, ...shown }]) => ({ id, ...shown })),
				),
				issue: async ({ principal, label, kind, secure }, ctx) => {
					const id = newToken(12);
					const secret = newToken(32);
					const now = Date.now();
					await document.change((draft) => {
						draft.signIns[id] = { hash: hashToken(secret), label, kind, principal, created: now, lastUsed: now };
					}, ctx);
					const token = `${id}.${secret}`;
					// Only whether the browser is remote matters to the cookie (`Secure`).
					const provenance: Provenance = secure === true ? { kind: "remote", host: "" } : { kind: "local" };
					return { id, token, cookie: signInCookie(token, { provenance }, cookieSecret) };
				},
				verify: async (token, ctx) => authenticate(token, ctx) ?? null,
				revoke: end,
			};
		}),
	);
}
```

What authenticating a token does. Note the three exits that answer "nobody": no such id, a wrong secret (compared in
constant time), unused for 400 days.

```ts
/** How often a sign-in's `lastUsed` is written at most: once a minute (not one commit per request). */
const TOUCH_MS = 60_000;

/**
 * The principal `token` authenticates as among `document`'s sign-ins, or `undefined`. It touches the sign-in it names,
 * or ends it (`end`) when it was unused too long; neither is awaited: the request goes on, and a write that fails is
 * made again by a later request.
 */
function authenticated(
	document: HandleOf<typeof SignInsDocument>,
	token: string,
	end: (id: string, context: Context) => Promise<null>,
	context: Context,
): P3Principal | undefined {
	const id = signInOf(token);
	// A trust boundary: `id` is the client's (`Object.hasOwn`: no inherited member is a sign-in).
	const signIns = document.value.signIns;
	if (id === undefined || !Object.hasOwn(signIns, id)) return undefined;
	const signIn = signIns[id]!;
	if (!matchesHash(token.slice(id.length + 1), signIn.hash)) return undefined;
	const now = Date.now();
	if (now - signIn.lastUsed > SIGN_IN_IDLE_MS) {
		void end(id, context).catch(() => {});
		return undefined;
	}
	if (now - signIn.lastUsed > TOUCH_MS) {
		const touch = document.change((draft) => {
			if (Object.hasOwn(draft.signIns, id)) draft.signIns[id]!.lastUsed = now;
		}, context);
		void touch.catch(() => {});
	}
	return signIn.principal;
}

/** The id of the sign-in a token `<id>.<secret>` names, or `undefined` for a text that is no token. */
function signInOf(token: string): string | undefined {
	const dot = token.indexOf(".");
	return dot > 0 ? token.slice(0, dot) : undefined;
}

/** The token `request` carries: its bearer token first, else its sign-in cookie signed with `secret`. */
function requestToken(request: HttpRequest, secret: string): string | undefined {
	const header = request.headers.get("authorization");
	const bearer = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header);
	return bearer?.[1] ?? readCookie(request, SIGN_IN_COOKIE, secret);
}
```

The cookie and its renewal:

```ts
/**
 * The sign-in cookie carrying `token` for a browser of `request`'s provenance: it lives as long as the sign-in does
 * unused (400 days, renewed by `rollingCookie`).
 */
function signInCookie(token: string, request: Pick<HttpRequest, "provenance">, secret: string): string {
	return cookie(SIGN_IN_COOKIE, token, { secret, request, maxAge: SIGN_IN_IDLE_MS / 1000 });
}

/** How old a sign-in cookie gets before a response renews it: a day. */
const ROLL_MS = 24 * 60 * 60_000;

/**
 * The wrap around every route renewing the sign-in cookie a request signed in with once it is older than a day: the
 * response sets it again with a fresh signed expiry, so a browser used within every 400 days stays signed in. Not when
 * the route sets a cookie itself, nor for a token that no longer authenticates.
 */
function rollingCookie(
	secret: string,
	authenticate: (token: string, context: Context) => P3Principal | undefined,
): HttpWrap {
	return {
		name: "p3.rolling-cookie",
		phase: "headers",
		scope: "all",
		wrap: async (request, next, ctx) => {
			const response = await next(request);
			const sets = Object.keys(response.headers ?? {}).some((name) => name.toLowerCase() === "set-cookie");
			if (ctx.principal === undefined || sets) return response;
			const signed = readSignedCookie(request, SIGN_IN_COOKIE, secret);
			if (signed?.expires === undefined || signed.expires - Date.now() > SIGN_IN_IDLE_MS - ROLL_MS) return response;
			if (authenticate(signed.value, ctx) === undefined) return response;
			const renewed = signInCookie(signed.value, request, secret);
			return { ...response, headers: { ...response.headers, "Set-Cookie": renewed } };
		},
	};
}
```

The part of the file about open links (`createSignIns`, `SignInLinks`) is in chapter IX, where it is used.

## The owner's two ways in

`src/kit/owner.ts`, whole. The link's token is in the URL's fragment, which a browser never sends, so it reaches no
log. `consume` uses the token up whether or not it has expired.

```ts
// The owner's sign-in: no owner by loopback alone. At each start the kit makes a one-time owner link (a random token,
// single use, valid 10 minutes, the previous one dropped); the start script prints it. Its page reads the token from
// the URL's fragment (never sent to a server, so never in a log) and posts it; the post consumes it and sets a browser
// sign-in cookie for the owner. The owner token file (mode 0600) carries a device sign-in of the owner for
// command-line clients on the same machine.

/** How long an owner link is valid: 10 minutes. */
const OWNER_LINK_MS = 10 * 60_000;

/** The owner link's one-time token: made at each start (the previous one dropped), consumed by its first use. */
export class OwnerLink {
	#hash: string | undefined;
	#expires = 0;

	/** A fresh token (the previous one no longer valid), valid for 10 minutes. */
	renew(): string {
		const token = newToken();
		this.#hash = hashToken(token);
		this.#expires = Date.now() + OWNER_LINK_MS;
		return token;
	}

	/** Whether `token` is the current one and has not expired; it is used up either way when it matches. */
	consume(token: string): boolean {
		const hash = this.#hash;
		if (hash === undefined || !matchesHash(token, hash)) return false;
		this.#hash = undefined;
		return Date.now() < this.#expires;
	}
}

/** The path of the owner link's page and post. */
export const OWNER_PATH = "/_p3/owner";

/**
 * The kit's facet for the owner link: `GET /_p3/owner`, a page posting the fragment's token, and `POST /_p3/owner`,
 * which consumes it and answers with a sign-in cookie of the owner.
 */
export function ownerFacet(link: OwnerLink): Facet<P3Principal> {
	return defineFacet<P3Principal>((_host, self) =>
		self.contribute(Http, {
			routes: {
				[`GET ${OWNER_PATH}`]: {
					public: true,
					handler: async (request) => ({ kind: "html", body: ownerPage(request.nonce) }),
				},
				[`POST ${OWNER_PATH}`]: {
					public: true,
					handler: async (request, ctx) => {
						const body = (await request.json()) as { readonly token?: unknown } | null;
						// A trust boundary: anyone may post here.
						if (typeof body?.token !== "string" || !link.consume(body.token))
							return { kind: "error", status: 403 };
						const signIns = await ctx.get(SignIns, {});
						const secure = request.provenance.kind !== "local";
						const owner = {
							principal: PRINCIPALS.owner,
							label: "owner browser",
							kind: "browser",
							secure,
						} as const;
						const issued = await signIns.issue(owner, ctx);
						return { kind: "json", value: "signed in", headers: { "Set-Cookie": issued.cookie } };
					},
				},
			},
		}),
	);
}

/** The owner link's page: its script (the response's nonce) posts the fragment's token, then opens p3. */
function ownerPage(nonce: string): string {
	return [
		"<!doctype html><title>Sign in</title><p id=status>Signing in…</p>",
		`<script nonce="${nonce}">`,
		"const token = location.hash.slice(1); history.replaceState(null, '', location.pathname);",
		`fetch(${JSON.stringify(OWNER_PATH)}, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })`,
		"  .then((r) => { if (r.ok) location.replace('/'); else document.getElementById('status').textContent = 'This link is used up or expired.'; });",
		"</script>",
	].join("\n");
}

/**
 * The owner token file at `path`: kept when its token still authenticates as the owner (its sign-in exists, its secret
 * matches, it has not expired; its mode set to 0600 again), else a new device sign-in of the owner written there (mode
 * 0600, in one step). Its token, for the start script.
 */
export async function ownerTokenFile(path: string, host: Host<P3Principal>, context: Context): Promise<string> {
	const existing = await readSecret(path);
	return host.root(async (ctx) => {
		const signIns = await ctx.get(SignIns, {});
		if (existing !== undefined) {
			if ((await signIns.verify(existing, ctx))?.kind === "owner") {
				await chmod(path, 0o600);
				return existing;
			}
		}
		const owner = { principal: PRINCIPALS.owner, label: "owner token file", kind: "device" } as const;
		const { token } = await signIns.issue(owner, ctx);
		await writeSecret(path, token, existing === undefined ? "create" : "replace");
		return token;
	}, context);
}
```

`src/kit/secrets.ts` (appendix) makes the tokens (`crypto.randomBytes`), hashes them (SHA-256) and writes secret
files in one step with mode 0600.

# One Plugin Owns Sessions {#plugin lede="Four files, 294 lines: the contracts, the store, the views, the worker's side."}

## The contracts: one per audience

`plugins/sessions/contract.ts`, whole. Every `remote` contract has one variant, named after who it is for. `Sessions`
has only methods; the list is its own contract because a list belongs to a screen (`view`).

```ts
// The sessions plugin's contracts, one per audience: what the owner does with sessions (`Sessions`), one screen's list
// of them (`SessionsList`), a session's row for its own worker (`SessionFacts`), and the session's worker as the owner
// sees it (`SessionWorker`). Every facet of the plugin imports this file.

/** Who made a session: the owner, or a person (by id). */
export const Creator = union([obj({ kind: lit("owner") }), obj({ kind: lit("person"), id: str() })]);

/** Who made a session (see `Creator`). */
export type Creator = Static<typeof Creator>;

/** What a session's agent is doing: working, waiting for someone, settled (nothing to do), or failed. */
export const SessionState = oneOf("working", "waiting", "settled", "failed");

/** What a session's agent is doing (see `SessionState`). */
export type SessionState = Static<typeof SessionState>;

/** A session's title: at most 200 characters. */
export const Title = str({ max: 200 });

/** The app every session belongs to until apps exist (slice 5): then `create` takes it. */
export const CODING = "coding";

/**
 * A session as lists and its worker see it: its id, title (empty until named: each view shows its own "New session" in
 * the viewer's language), app, creator, when it was made, its state, when it was last touched, and when it was
 * archived (`null`: it is not).
 */
export const SessionRow = obj({
	id: str(),
	title: Title,
	app: str(),
	creator: Creator,
	createdAt: num(),
	state: SessionState,
	lastTouch: num(),
	archivedAt: union([num(), nul()]),
});

/** A session as lists and its worker see it (see `SessionRow`). */
export type SessionRow = Static<typeof SessionRow>;

/** What the owner does with sessions. */
export const Sessions = remote("sessions.sessions", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: {
		owner: {
			methods: {
				/** Makes a session; answers its id. */
				create: method(obj({ title: opt(Title) }), str()),
				rename: method(obj({ id: str(), title: Title })),
				archive: method(obj({ id: str() })),
				restore: method(obj({ id: str() })),
			},
		},
	},
});

/**
 * One screen's list of an app's sessions, active (the last touched first) or archived (the last archived first):
 * `view` is the screen's own id, so a fresh id is a fresh list. `list` holds the rows loaded so far and whether rows
 * may follow; `more` loads the next page.
 */
export const SessionsList = remote("sessions.list", {
	version: 1,
	params: { app: str(), set: oneOf("active", "archived"), view: str() },
	hostAddress: () => Server(),
	variants: {
		owner: {
			state: { list: obj({ rows: arr(SessionRow), moreAfter: bool() }) },
			methods: { more: method() },
		},
	},
});

/**
 * A session's row for its own worker, which holds it as itself: its principal names the session (design §4). `null`
 * for a session the server does not know.
 */
export const SessionFacts = remote("sessions.facts", {
	version: 1,
	params: {},
	hostAddress: () => Server(),
	variants: { worker: { state: { session: union([SessionRow, nul()]) } } },
});

/** A session's worker as the owner sees it: the row it follows from the server. */
export const SessionWorker = remote("sessions.worker", {
	version: 1,
	params: { session: str() },
	hostAddress: ({ session }) => Session({ id: session }),
	variants: { owner: { state: { session: union([SessionRow, nul()]) } } },
});
```

`plugins/sessions/contract.server.ts`, whole. The store is `local`: no client reaches it. Its member `sessions` lists
the named queries with the schema of each one's arguments; any object on the server may read them.

```ts
// The sessions plugin's contract for server facets: the store of the sessions, whose named queries other objects on the
// server read (the plugin's own views now; groupings and people later).

/** The sessions: their rows as named queries, and the writes. Once per server. */
export const SessionsStore = local("sessions.store", {
	version: 1,
	params: {},
	members: {
		sessions: queries(SessionRow, {
			/** An app's sessions that are not archived, the last touched first. */
			active: obj({ app: str() }),
			/** An app's archived sessions, the last archived first. */
			archived: obj({ app: str() }),
			/** The session `id`, if there is one. */
			one: obj({ id: str() }),
		}),
		create: method(obj({ title: Title, creator: Creator }), str()),
		rename: method(obj({ id: str(), title: Title })),
		archive: method(obj({ id: str() })),
		restore: method(obj({ id: str() })),
	},
});
```

## The table, the store, the views

`plugins/sessions/server.ts`, whole. Read it in three parts: the table (to `Rows`), the store (the first
`host.serve`), then four small objects that show parts of the store to one audience each.

```ts
// The sessions plugin on the server. Every session is one row of a table keyed by its address, so a session's export,
// import and delete carry it. One local store (`SessionsStore`, `contract.server.ts`) owns the table, writes it and
// offers its rows as named queries; the owner's `Sessions` and `SessionsList`, each worker's `SessionFacts` and the
// route's `SessionRoute` read them.

/**
 * A session's row: its address, title, app, creator, when it was made, its state, when it was last touched, and when
 * it was archived. `archivedAt` is 0 while it is not archived: both lists need it in their index, and index and order
 * columns are never optional.
 */
const ROW = {
	id: hostColumn(Session),
	title: str(),
	app: str(),
	creator: json(Creator, { version: 1 }),
	createdAt: int(),
	state: str(),
	lastTouch: int(),
	archivedAt: int(),
};

/** A row of `Rows`. */
type Row = RowOf<typeof ROW>;

/**
 * Every session, one row each, by its address. One index per list: a list's whole order (its column, then the key)
 * must be its index's after the columns its condition fixes, or SQLite sorts every page it reads.
 */
const Rows = defineTable("sessions.rows", {
	version: 1,
	columns: ROW,
	key: ["id"],
	indexes: { active: ["app", "archivedAt", "lastTouch"], archived: ["app", "archivedAt"] },
});

/** How many sessions a page of a list holds. */
const PAGE = 50;

export default defineFacet((host) => {
	host.serve(SessionsStore, (_params, self) => {
		const rows = self.table(Rows);
		/** Sets `change` on session `id`'s row: an `update`, so only the reads that depend on those columns run. */
		const update = (id: string, change: Partial<Row>, ctx: Ctx) =>
			self.tx(async (tx) => {
				const key = { id: Session({ id }) };
				if ((await tx.get(rows, key)) === undefined) throw invalid("args", `sessions: no session ${id}`);
				tx.update(rows, key, change);
				return null;
			}, ctx);
		return {
			sessions: self.queries(
				rows,
				{ map: shown },
				{
					// Index `active`: `app` and `archivedAt` fixed, in the order of `lastTouch`, then the key.
					active: ({ app }: { app: string }) =>
						query(Rows)
							.where((s) => and(eq(s.app, app), eq(s.archivedAt, 0)))
							.orderBy((s) => s.lastTouch, "desc"),
					// Index `archived`: `app` fixed, a range of `archivedAt` in its order, then the key.
					archived: ({ app }: { app: string }) =>
						query(Rows)
							.where((s) => and(eq(s.app, app), gt(s.archivedAt, 0)))
							.orderBy((s) => s.archivedAt, "desc"),
					// The key.
					one: ({ id }: { id: string }) => query(Rows).where((s) => eq(s.id, Session({ id }))),
				},
			),
			create: async ({ title, creator }, ctx) => {
				const id = crypto.randomUUID();
				const now = Date.now();
				const state: SessionState = "settled";
				const row = { id: Session({ id }), title, app: CODING, creator, state };
				await self.tx(async (tx) => tx.put(rows, { ...row, createdAt: now, lastTouch: now, archivedAt: 0 }), ctx);
				return id;
			},
			rename: ({ id, title }, ctx) => update(id, { title }, ctx),
			archive: ({ id }, ctx) => update(id, { archivedAt: Date.now() }, ctx),
			restore: ({ id }, ctx) => update(id, { archivedAt: 0 }, ctx),
		};
	});

	host.serve(Sessions, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const store = self.get(SessionsStore, {});
		return forward(store, Sessions, "owner", {
			create: ({ title }, ctx) => store.create({ title: title ?? "", creator: { kind: "owner" } }, ctx),
		});
	});

	host.serve(SessionsList, ({ app, set }, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const list = self.list("sessions", [[self.get(SessionsStore, {}).sessions[set], { app }]], { first: PAGE });
		return { variant: "owner", members: { list: list.value, more: (ctx) => list.more(ctx) } };
	});

	host.serve(SessionFacts, (_params, principal, self) => {
		if (principal.kind !== "worker") throw forbidden("sessions: a session's worker only");
		const one = self.get(SessionsStore, {}).sessions.one;
		const found = self.liveQuery(one, { id: principal.session }, { first: 1 });
		return { variant: "worker", members: { session: self.derive([found], ([{ rows }]) => rows[0] ?? null) } };
	});

	host.serve(SessionRoute, ({ session }, self) => {
		const found = self.liveQuery(self.get(SessionsStore, {}).sessions.one, { id: session }, { first: 1 });
		return { exists: self.derive([found], ([{ rows }]) => rows.length === 1) };
	});
});

/** A table row as lists and a session's worker see it. */
function shown({ id, state, archivedAt, ...row }: Row): SessionRow {
	// `state` holds only what this plugin wrote: a `SessionState`.
	return { id: id.params.id, ...row, state: state as SessionState, archivedAt: archivedAt === 0 ? null : archivedAt };
}
```

What each part decides:

| Code | Decision |
| --- | --- |
| `id: hostColumn(Session)` | the row belongs to the session's address, so a later export, import or delete of a session carries it |
| `archivedAt: int()`, 0 while not archived | index and order columns cannot be optional; `shown` turns 0 into `null` |
| two indexes | each list's whole order (its column, then the key Chord appends) is its index's, so SQLite never sorts (chapter VI shows the plans) |
| `update` = `tx.get`, then `tx.update(rows, key, change)` | an unknown id is refused `invalid`; an `update` names the columns it changes, so reads that depend on none of them are not run |
| `create` is a `put` with `state: "settled"`, `lastTouch: now` | nothing writes state or last touch after create yet: the harness reports runs in slice 3 |
| `forward(store, Sessions, "owner", { create })` | rename, archive and restore are the store's; `create` is the view's own because it records who created |
| `self.list("sessions", [[…sessions[set], { app }]], { first: PAGE })` | the list: 50 rows, live, `more` for the next page |
| `{ id: principal.session }` in `SessionFacts` | a worker cannot name another session: its link stamps its principal |
| `SessionRoute` served here | the contract is the API's (base code reads it), the answer is the plugin's |

## `forward`: a view's members from the store

Without it every view writes each member a second time (`rename: (args, ctx) => store.rename(args, ctx)`, four times
here, 40 of 48 remote factories in p2). `src/kit/forward.ts`, whole:

```ts
// `forward`: a view's members taken from a store's reference. Most remote objects own nothing: their factory gets a
// `local` store and hands its members on to one audience. The remote contract still lists that audience's members
// explicitly; `forward` fills them from the same-named members of the store, so no member is written a second time.
// Browser-safe: the API module exports it.

/** One variant of the remote contract `C` as its factory returns it. */
type Served<C extends Contract, V extends string> = Extract<
	Implementation<C, Ctx<P3Principal>>,
	{ readonly variant: V }
>;

/** The names of a remote contract's variants. */
type VariantOf<C extends Contract> = Extract<Implementation<C>, { readonly variant: string }>["variant"];

/**
 * `variant` of `Remote` for a factory to return: each member is `own`'s when it gives one (a member that needs the
 * caller), else the same-named member of `store` (a reference: its state members follow it live, its methods are
 * called with the caller's `ctx`).
 */
export function forward<
	C extends Contract,
	V extends VariantOf<C>,
	// The names of the members `own` gives; none without it, so `store` owes every member.
	K extends keyof Served<C, V>["members"] = never,
>(
	store: Omit<Served<C, V>["members"], K>,
	Remote: C,
	variant: V,
	own?: Pick<Served<C, V>["members"], K>,
): Served<C, V> {
	const { state, methods, events } = memberNames(Remote, variant);
	const members: Record<string, unknown> = {};
	for (const name of [...state, ...methods, ...events]) {
		// The types require `store` to have every member `own` does not give; a reference's members are own properties.
		members[name] = own !== undefined && Object.hasOwn(own, name) ? own[name as K] : store[name as never];
	}
	// The members are the variant's by construction (the names its contract lists).
	return { variant, members } as Served<C, V>;
}
```

- The contract stays explicit: `Sessions` lists exactly what the owner gets. `forward` only fills it. A store member
  that the view does not list (`sessions`, the queries) stays out, because the names come from the view's contract.
- The types: `K` is the names of `own`'s members. `store` must have every other member with a fitting type. Without
  `own`, `K` is `never` and the store owes all of them. Seven `@ts-expect-error` lines in `test/kit/forward.test.ts`
  pin that (`npm run check` fails on an unused one).

`memberNames` is the one thing `forward` needed from Chord, which had no public way to read a contract's members.
`packages/chord/src/contracts/contract.ts`:

```ts
/** The member names of one variant of a contract, by kind. */
export type MemberNames = {
	readonly state: readonly string[];
	readonly methods: readonly string[];
	readonly events: readonly string[];
};

/**
 * The names of the state members, methods and event members of `variant` of a contract's current version (a local
 * contract has one variant: leave `variant` out), in the order declared: for code that fills an implementation from
 * another object's members. A local contract's keyed and `queries` members are not among them.
 */
export function memberNames(contract: Contract, variant: string = LOCAL): MemberNames {
	const found = currentVariants(contract).get(variant);
	if (found === undefined) throw new Error(`${contract.name}: no variant "${variant}"`);
	return { state: [...found.state.keys()], methods: [...found.methods.keys()], events: [...found.events.keys()] };
}
```

## The worker's side

`plugins/sessions/worker.ts`, whole. The object serves the owner, on the session's worker. Its
`self.get(SessionFacts, {})` goes up the worker's link to the server, where it arrives as the worker.

```ts
// The sessions plugin on a session's worker: `SessionWorker`, the session's worker as the owner sees it. It forwards
// the session's row from the server's `SessionFacts`, held as this worker (its principal names the session, design
// §4), so a rename on the server reaches it live.

export default defineFacet((host) => {
	host.serve(SessionWorker, (_params, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		return forward(self.get(SessionFacts, {}), SessionWorker, "owner");
	});
});
```

# One Request, End to End {#request lede="The owner opens his list of sessions. Eight stops, with the code and the real SQL at each."}

:::sequence animate | Opening the list. Only the accent steps do work that grows with the data; both are one index walk of 51 rows.
actor client "owner's client" "a page, a terminal, a test" blue
actor http "HTTP + sign-ins" "kit"
actor host "server host" "Chord"
actor list "SessionsList" "sessions plugin" accent
actor store "SessionsStore" "sessions plugin" accent
actor db "SQLite"
client -> http: GET /chord, Upgrade, Bearer token
http -> http: authenticate: { kind: "owner" }
http -> host: accept(link, principal)
client -> host: hold SessionsList { app, set, view }
host -> list: factory (owner? yes)
list => store: self.list(sessions.active, { app })
store => db: SELECT … LIMIT 51
db --> store: 51 rows
store --> list: rows mapped, page 1
host --> client: bound: { rows: 50, moreAfter: true }
:::

:::steps | The eight stops
+++ 1. The socket
The client opens a WebSocket to `/chord` with its token. This is the test client (`test/client.ts`), which signs in
as a command-line client on the same machine does: with the owner token file.

```ts
export async function ownerClient(server: Reachable, context: Context): Promise<Host<P3Principal>> {
	const { port } = new URL(server.ownerLink());
	const token = (await readFile(server.ownerTokenFile, "utf8")).trim();
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols, hence the cast.
	const init = { headers: { authorization: `Bearer ${token}` } } as unknown as string[];
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, init);
	// A worker that fails its start fails a test in seconds, not after a minute.
	const client = createHost<P3Principal>({ readyTimeout: 5000, onError: (error) => console.error("client:", error) });
	client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
	await client.load([], context);
	return client;
}
```

+++ 2. Who is it
Chord's HTTP component asks its authenticators before any plugin code runs; a request without a principal gets 401.
The kit's authenticator (chapter IV) reads the bearer token, finds the sign-in by its id, compares the secret's hash
and answers `{ kind: "owner" }`. The component then accepts the socket as a link whose every hold and call acts as
that principal, and tells the kit (`links.opened`), which notes the link under its sign-in (chapter IX).

+++ 3. The hold
```ts
const list = await client.get(SessionsList, { app: "coding", set: "active", view: "screen-1" }, context);
```
The contract says where the object lives (`hostAddress: () => Server()`), so the hold stops at the server. An object
is one per (type, params, principal): this screen's list for the owner. `view` is the screen's own id: another id is
another list, with its own loaded pages.

+++ 4. The factory
```ts
	host.serve(SessionsList, ({ app, set }, principal, self) => {
		if (principal.kind !== "owner") throw forbidden("sessions: the owner's");
		const list = self.list("sessions", [[self.get(SessionsStore, {}).sessions[set], { app }]], { first: PAGE });
		return { variant: "owner", members: { list: list.value, more: (ctx) => list.more(ctx) } };
	});
```
A person or a worker is refused here (`forbidden`). `self.get(SessionsStore, {})` is a dependency: the list is live
only once the store is. `sessions[set]` picks the named query `active` or `archived`.

+++ 5. The named query
```ts
					// Index `active`: `app` and `archivedAt` fixed, in the order of `lastTouch`, then the key.
					active: ({ app }: { app: string }) =>
						query(Rows)
							.where((s) => and(eq(s.app, app), eq(s.archivedAt, 0)))
							.orderBy((s) => s.lastTouch, "desc"),
```
The builder is a pure function of its arguments. Chord checks the arguments against the schema in the contract
(`active: obj({ app: str() })`), builds the query, registers the read with the store, and runs it before the list
goes live.

+++ 6. SQLite
What Chord runs, as recorded from the real plugin (`test/plans.test.ts` does the same and asserts the plan):

```text
SELECT t."id", t."title", t."app", t."creator", t."createdAt", t."state", t."lastTouch", t."archivedAt", t."creator$v"
FROM "sessions.store:sessions.rows" AS t
WHERE (t."app" = ? AND t."archivedAt" = ?)
ORDER BY t."lastTouch" DESC, t."id" DESC
LIMIT ?
   parameters: ["coding", 0, 51]
   plan:       SEARCH t USING INDEX sessions.store:sessions.rows:active (app=? AND archivedAt=?)
```
51 rows are asked for 50: the 51st says whether more follow. Chord adds the key (`id`) to the order, so ties of one
millisecond have a fixed order. The plan is one search of the index `active`, in order, no sort.

+++ 7. The frame back
Each row goes through `shown` (the address becomes its id, 0 becomes `null`). The list's value is
`{ rows: [50 rows], moreAfter: true }`; the client gets it in one `bound` message and `get` resolves. From here the
list is live: a session created now enters this page in the commit that creates it.

+++ 8. More
```ts
await list.more(context);        // list.list.value.rows.length: 100
```
```text
SELECT ... FROM "sessions.store:sessions.rows" AS t
WHERE (t."app" = ? AND t."archivedAt" = ?) AND (t."lastTouch", t."id") < (?, ?)
ORDER BY t."lastTouch" DESC, t."id" DESC
LIMIT ?
   parameters: ["coding", 0, 1794813861313, "session|d7a8c617-b9cd-444c-85d4-d522d08bfed4", 51]
   plan:       SEARCH t USING INDEX sessions.store:sessions.rows:active (app=? AND archivedAt=? AND (lastTouch,id)<(?,?))
```
The second page starts after a **bookmark**: the order values of the last row of page 1. The index seeks to it. Only
the 50 new rows cross the link; the first 50 stay the same objects in the client (the test asserts identity).
:::

:::stats
0.7 ms | an open, warm, over the WebSocket
0.5 ms | a `more`
0.02 ms | the seek to the bookmark
the same | at 1,000, 10,000 and 100,000 sessions
:::

## Why two indexes

The first version of the redo had one index for both lists. Sol asked SQLite for the plan and found a sort:

```text
CREATE INDEX "sessions.store:sessions.rows:active"   ON "sessions.store:sessions.rows" ("app", "archivedAt", "lastTouch", "id")
CREATE INDEX "sessions.store:sessions.rows:archived" ON "sessions.store:sessions.rows" ("app", "archivedAt", "id")

archived, first page:
   WHERE (t."app" = ? AND t."archivedAt" > ?) ORDER BY t."archivedAt" DESC, t."id" DESC LIMIT ?
   plan: SEARCH t USING INDEX sessions.store:sessions.rows:archived (app=? AND archivedAt>?)
archived, with ONE index for both lists (the first version of the redo):
   plan: SEARCH t USING INDEX sessions.store:sessions.rows:by_app (app=? AND archivedAt>?)
         USE TEMP B-TREE FOR LAST TERM OF ORDER BY
one:
   WHERE t."id" = ? ...
   plan: SEARCH t USING PRIMARY KEY (id=?)
```

The archived list orders by `(archivedAt, id)`; in the shared index `lastTouch` sat between them, so every page read
and sorted all rows of one archive time. Now each list has the index of its own order.

# A Worker Per Session {#workers lede="A process per session, started by its first hold, if the route lets the hold through."}

## The route's policy

`src/session-route.ts`, whole. Two questions, in this order. `mayReachSession` is synchronous and looks only at who
asks. `sessionExists` is an **admission**: it reads data, and Chord follows its answer.

```ts
// Who reaches a session's worker: the policy of the route from the server to session workers. Its `authorize` decides
// by the principal alone, before anything else; its admission then reads the sessions table, so no worker starts for
// a session that does not exist. The kit gives both to the workers component, the test topology to its own route.

/** Who may reach a session's worker: the owner and the server (persons come with admission, slice 5). */
export function mayReachSession(principal: P3Principal): boolean {
	return principal.kind === "owner" || principal.kind === "server";
}

/**
 * The route's admission: allowed while the session at `address` exists. It reads the sessions table through
 * `SessionRoute`, a contract the API owns (a route is base code and never reloads) and the sessions plugin serves.
 */
export function sessionExists(_principal: P3Principal, address: Address<typeof Session>, self: AdmitSelf) {
	const route = self.get(SessionRoute, { session: address.params.id });
	return self.derive([route.exists], ([exists]) => (exists ? allow(null) : deny("no such session")));
}
```

## The server's side

`src/kit/session-workers.ts`, whole. Chord's `createWorkers` does the work: it routes `Session` addresses, forks a
process for the first hold of each, stops it after five idle minutes, and publishes a worker's exit only after its
link closed and its queued commits settled (so no plugin checks for stale workers).

```ts
// Session workers on the server: every session's host runs as a forked process (Chord's workers component: one per
// address, started by its first hold the route admits, stopped when idle). What the start script decides of them, and
// what the server sends a worker at its start. The worker's side is `worker.ts`.

/** How a session's worker starts: what the start script decides. */
export type WorkerOptions = {
	/**
	 * The worker's entry module (it calls `startWorker`), bundled with the base code it imports at start (every worker
	 * runs that snapshot until the server restarts), and its Node flags.
	 */
	readonly entry: string;
	readonly execArgv?: readonly string[];
};

/** What the server sends a worker at its start: its directory. */
export type WorkerStart = { readonly dir: string };

/** The facet kind a worker loads. */
export const WORKER_FACET = "worker";

/**
 * The workers component of sessions on `host` (its base built by `build`, into `cache/worker/`): the route's policy is
 * `session-route.ts`'s, each worker gets its directory under the data directory and acts as `PRINCIPALS.worker`.
 */
export function sessionWorkers(
	options: WorkerOptions,
	server: { readonly host: Host<P3Principal>; readonly store: Store; readonly plugins: Plugins },
	layout: Layout,
	onError: (error: WorkersError) => void,
	context: Context,
): Workers<typeof Session> {
	const { dataDir } = layout;
	return createWorkers(
		server.host,
		Session,
		{
			kind: WORKER_FACET,
			entry: options.entry,
			...(options.execArgv === undefined ? {} : { execArgv: options.execArgv }),
			baseDir: layout.workerBase,
			compileCache: layout.compileCache,
			// The server's: a worker's exit is published after the commits its calls queued there.
			store: server.store,
			authorize: mayReachSession,
			admit: sessionExists,
			principal: PRINCIPALS.worker,
			start: (address): WorkerStart => ({ dir: workerDirectory(dataDir, address) }),
			lock: (address) => `${NAME}-worker:${dataDir}:${address.key}`,
			plugins: server.plugins,
			onError,
		},
		context,
	);
}
```

## The worker's side

`worker.ts` (the entry) is `startWorker({ onError: … })`. `src/kit/worker.ts`, whole:

```ts
// `startWorker`: a worker of p3, in its entry module. Chord's `workerMain` plus the kit's part: the worker's directory
// with its store, the host at the worker's address acting as `PRINCIPALS.worker`, connected to the server first, its
// plugins loaded with the kit's worker facet (`WorkerInfo`).

/** Runs this process as a worker of p3: once the start message arrived, its host is up and its plugins loaded. */
export function startWorker(options: {
	/** The worker host's errors (`HostError`) and a failed start's. */
	readonly onError: (error: unknown) => void;
}): void {
	workerMain(
		async ({ address: started, start, parent, plugins, onClose }, context) => {
			// The server's `sessionWorkers` forks workers of sessions only, each with a `WorkerStart`.
			const address = started as Address<typeof Session>;
			const { dir } = start as WorkerStart;
			const file = join(dir, "store.sqlite");
			await privateDirectory(dir);
			await privateStore(file);
			const store = await openStore(sqliteBackend(await openNodeSqliteDatabase(file)), context);
			onClose((ctx) => store.close(ctx));
			const principal = PRINCIPALS.worker(address);
			const host = createHost<P3Principal>({ address, principal, store, onError: options.onError });
			onClose((ctx) => host.close(ctx));
			// First: the server sees the worker started, then the load runs.
			host.connect(parent, { principal: PRINCIPALS.server, trusted: true }, context);
			const core = [{ name: "p3.worker-info", facet: workerInfoFacet(address) }];
			await plugins.load(host, { kind: WORKER_FACET, core }, context);
			return {};
		},
		{
			hostPackages: API.modules,
			// Worker errors are public: a fixed message, never the error's own.
			redact: () => ({ message: "worker failed" }),
			onError: options.onError,
		},
	);
}
```

It connects before it loads: the plugins' objects may need the server (`SessionWorker` needs `SessionFacts`), and
the server sees the worker as started. The start data both hosts serve, `src/kit/info.ts`:

```ts
// The start-data objects: process values served to plugins as objects they `get`, never through closures over the
// start script. `AppInfo` on the server (the data directory, p3's name, its newest API version), `WorkerInfo` on a
// worker (its address).

/** What the server knows of the Pi: its data directory, its name, its newest API version. */
export const AppInfo = local("p3.info", {
	version: 1,
	params: {},
	members: { dataDir: str(), name: str(), version: str() },
});

/** What a worker knows of itself: its address (kind, params, key). */
export const WorkerInfo = local("p3.worker-info", {
	version: 1,
	params: {},
	members: { address: obj({ kind: str(), key: str(), params: unknown() }) },
});

/** The facet serving `AppInfo` with `info`. */
export function appInfoFacet(info: {
	readonly dataDir: string;
	readonly name: string;
	readonly version: string;
}): Facet<P3Principal> {
	return defineFacet<P3Principal>((host) =>
		host.serve(AppInfo, () => ({
			dataDir: constant(info.dataDir),
			name: constant(info.name),
			version: constant(info.version),
		})),
	);
}

/** The facet serving `WorkerInfo` for the worker at `address`. */
export function workerInfoFacet(address: Address): Facet<P3Principal> {
	// An address's params are JSON scalars (a host kind's params).
	const info = { kind: address.kind, key: address.key, params: address.params as JsonValue };
	return defineFacet<P3Principal>((host) => host.serve(WorkerInfo, () => ({ address: constant(info) })));
}
```

## A hold of a session that does not exist

:::sequence | The owner asks for the worker of an id nobody created. Nothing is forked.
actor client "owner's client" "" blue
actor route "route (server)" "createWorkers"
actor sr "SessionRoute { session }" "sessions plugin" accent
actor store "SessionsStore"
client -> route: hold SessionWorker { session: "nope" }
route -> route: authorize: owner, yes
route => sr: admit: get SessionRoute, read exists
sr -> store: liveQuery(sessions.one, { id: "nope" })
store --> sr: no row
sr --> route: exists: false
route --> client: failed { denied }: "no such session"
:::

`get` rejects `forbidden`; the workers' state has no entry for the id. If a session with that id is created while the
hold is still there, `exists` turns true in that commit and the route starts the worker. In the first build this hold
forked a worker for nothing.

# A Rename Reaches the Worker {#rename lede="One update on the server; the reads that show that session run, no other."}

:::sequence animate | The owner renames session A while A's worker and another session's worker are running.
actor owner "owner's client" "Sessions, SessionsList, SessionWorker" blue
actor store "SessionsStore" "server" accent
actor facts "SessionFacts (as worker A)" "server"
actor worker "worker A" "SessionWorker"
owner -> store: Sessions.rename({ id: A, title })
store => store: tx.update(rows, A, { title }), commit
store -> store: re-run: the list's page, A's two reads
store --> facts: one(A): new row
facts --> worker: state: session.title
worker --> owner: state (SessionWorker, relayed by the server)
store --> owner: state (the list's row), then the call's answer
:::

The write is `update(id, { title }, ctx)` in the store. Inside the commit, Chord looks at every open read of the table
and decides by the columns the update names:

| Open read | What the commit does | Why |
| --- | --- | --- |
| the owner's list, page 1 | runs it | it shows A, and `title` is a column its rows carry |
| `one(A)` for worker A's `SessionFacts` | runs it | the same |
| `one(A)` for the route's `SessionRoute` | runs it | the same (reads are not shared between readers yet) |
| `one(B)`, twice, for session B | nothing, not even a probe | B's row is not A's, and `title` cannot bring A into a read by id |

The test that pins it (`test/sessions.test.ts`); the counts come from Chord's own telemetry counters:

```ts
	it("runs only the reads that show a renamed session", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		const a = await sessions.create({ title: "A" }, context);
		const b = await sessions.create({ title: "B" }, context);
		const workerB = await owner.get(SessionWorker, { session: b }, context);
		await owner.get(SessionWorker, { session: a }, context);
		const before = [t.count("chord.query.runs"), t.count("chord.query.probes")];
		await sessions.rename({ id: a, title: "A2" }, context);
		// The list's page and session A's two reads (its worker's and its route's); B's are not run, and ask nothing.
		assert.deepEqual([t.count("chord.query.runs") - before[0]!, t.count("chord.query.probes") - before[1]!], [3, 0]);
		assert.equal(workerB.session.value?.title, "B");
	});
```

If `rename` were a `put` of the whole row, Chord would not know which columns changed: B's reads would each ask
SQLite a probe, and this test fails (it is one of the 48 mutations).

# A Revoke Closes One Device {#revoke lede="The owner has two devices. One sign-in is revoked. Its socket dies; the other device notices nothing."}

Before review round 1, `revoke` deleted the stored sign-in and nothing else: an open socket kept its principal and
went on creating sessions. `host.revoke` could not fix it: it ends objects by principal, and both devices are
`{ kind: "owner" }` and share the owner's objects. So the kit closes links itself.

The rest of `src/kit/sign-ins.ts`:

```ts
/** The kit's sign-ins: the facet for the server's core facets, and the links endpoint's `opened` hook. */
export type KitSignIns = {
	readonly facet: Facet<P3Principal>;
	/**
	 * A link was accepted for `request`: `close` ends it when the sign-in the request authenticated with ends, at once
	 * when it has ended already. The signature is Chord's (`createHttp`'s `links.opened`): the kit needs the sign-in,
	 * which it noted when it authenticated the request, not the principal.
	 */
	readonly opened: (request: HttpRequest, principal: unknown, close: () => void) => (() => void) | undefined;
};

/**
 * The kit's sign-ins: its facet serving `SignIns` (a host-lifetime object) and contributing its authenticator (the
 * bearer token first, else the sign-in cookie signed with `cookieSecret`) and the wrap that renews a browser's cookie,
 * and the links hook through which a sign-in that ends closes its open links.
 */
export function createSignIns(cookieSecret: string): KitSignIns {
	const links = new SignInLinks();
	return {
		facet: signInsFacet(cookieSecret, links),
		opened: (request, _principal, close) => links.opened(request, close),
	};
}

/** The open links of each sign-in, by its id: what closes each; and which sign-in each request authenticated with. */
class SignInLinks {
	readonly #closes = new Map<string, Set<() => void>>();
	/** The sign-in each request authenticated with, kept while the HTTP component keeps the request. */
	readonly #requests = new WeakMap<HttpRequest, string>();
	/** Whether a sign-in is live now: `SignIns` says, once it serves; before, none is. */
	#live: (id: string) => boolean = () => false;

	/** `SignIns` serves: `live` says whether a sign-in exists and has not expired, read when a link opens. */
	serve(live: (id: string) => boolean): void {
		this.#live = live;
	}

	/** `request` authenticated with sign-in `id`: a link it opens is that sign-in's. */
	signedIn(request: HttpRequest, id: string): void {
		this.#requests.set(request, id);
	}

	/**
	 * A link opened for `request`; `close` ends it. Its sign-in is the one the request authenticated with, never read
	 * from the request again: a cookie that expired meanwhile would name none. A request another authenticator signed
	 * in is not the kit's to close. A sign-in may end between the authenticator's answer and this call (the upgrade is
	 * asynchronous): the link of one that is not live now is closed at once, and the check and the registration are
	 * one synchronous step, so an end after it finds the link. Returns what to call when the link closed.
	 */
	opened(request: HttpRequest, close: () => void): (() => void) | undefined {
		const id = this.#requests.get(request);
		if (id === undefined) return undefined;
		if (!this.#live(id)) {
			close();
			return undefined;
		}
		const closes = this.#closes.get(id) ?? new Set();
		this.#closes.set(id, closes.add(close));
		return () => {
			closes.delete(close);
			if (closes.size === 0) this.#closes.delete(id);
		};
	}

	/** Closes every open link of sign-in `id`: only its own, whoever else is signed in as the same principal. */
	close(id: string): void {
		for (const close of this.#closes.get(id) ?? []) close();
	}
}
```

Chord's side is one argument. `packages/chord/src/node/http/upgrades.ts`, the links endpoint; `end` terminates the
socket without a close handshake a peer could ignore:

```ts
	link<P extends Principal>(
		message: IncomingMessage,
		stream: Duplex,
		head: Buffer,
		admission: Admission<P> & LinkOptions,
		host: Host<P>,
		context: Context,
		opened: (close: () => void) => (() => void) | undefined,
	): void {
		const { principal, limits } = admission;
		upgrade(message, stream, head, admission.maxPayload ?? DEFAULT_LINK_PAYLOAD, (socket) => {
			const link = webSocketLink(limitedSocket(socket));
			const upgraded = {
				socket,
				allowed: admission.allowed,
				relay: admission.relay,
				handler: undefined,
				seal: () => link.close(),
			};
			this.#keep(upgraded);
			host.accept(link, { principal, ...(limits === undefined ? {} : { limits }) }, context);
			const closed = opened(() => end(upgraded));
			if (closed !== undefined) socket.once("close", closed);
		});
	}
```

:::sequence animate | Two devices of the owner. The laptop's sign-in is revoked.
actor laptop "laptop" "sign-in L, bearer token" blue
actor phone "phone" "sign-in P, cookie" blue
actor kit "SignIns + SignInLinks" "kit" accent
actor http "HTTP component" "Chord"
laptop -> http: upgrade /chord
http -> kit: authenticate(request): owner; note request -> L
http -> kit: opened(request, principal, close): L live? yes: keep close under L
phone -> http: upgrade /chord (the same, under P)
laptop -> kit: Sessions.create (works)
kit => kit: revoke(L): delete from the store, commit
kit => http: close() of every link under L
http --> laptop: socket terminated
phone -> kit: Sessions.create (works: its link, its objects, its list untouched)
:::

## The race the reviewers found

An upgrade is asynchronous: between the authenticator's answer and `opened`, a revoke can commit. Three rules in
`SignInLinks` close that window:

1. `opened` asks **now** whether the sign-in is live, and closes the link at once if not.
2. The check and the registration are one synchronous step, so a revoke after it finds the link.
3. `opened` takes the sign-in's id from the note the authenticator made for this request, not from the request's
   cookie again: a cookie that expired in between would name no sign-in, and the link would be neither checked nor
   registered (Astra's last finding).

The test forces the order by wrapping the kit's authenticator (`test/kit/sign-ins.test.ts`):

```ts
	it("are closed at once when the sign-in ended between its authentication and the link's registration", async () => {
		// Review round 2 (Sol's and Astra's reproductions): the upgrade is asynchronous, so a sign-in can end after the
		// authenticator answered and before the kit hears of the link. The test forces that order: it wraps the kit's
		// authenticator so that a request marked `x-race` is revoked, or outlives its 400 days (its cookie's too),
		// right after it authenticated; with a bearer token and with a cookie.
		const root = fileURLToPath(new URL("../../plugins/", import.meta.url));
		const { app, port } = await kitApp({ root });
		const owner: P3Principal = { kind: "owner" };
		const authenticators = await app.host.registry(Authenticators, context);
		// The composed entry is replaced for this test only: a scheduling hook, restored below.
		const found = authenticators.value.find(({ plugin }) => plugin === "p3.sign-ins");
		const entry = found as { authenticate: Authenticator };
		const original = entry.authenticate;
		entry.authenticate = async (request, ctx) => {
			const principal = await original(request, ctx);
			const [race, id] = (request.headers.get("x-race") ?? "").split(" ");
			if (race === "revoke") {
				await app.host.root(async (scope) => (await scope.get(SignIns, {})).revoke(id!, scope), context);
			}
			if (race === "expire") mock.timers.enable({ apis: ["Date"], now: Date.now() + 401 * DAY });
			return principal;
		};
		const kept = await device(port, credentials(await issue(app, owner, "device"), "bearer"));
		try {
			for (const [carry, race] of [
				["bearer", "revoke"],
				["bearer", "expire"],
				["cookie", "revoke"],
				["cookie", "expire"],
			] as const) {
				const issued = await issue(app, owner, carry === "cookie" ? "browser" : "device");
				const raced = await device(port, { ...credentials(issued, carry), "x-race": `${race} ${issued.id}` });
				for (let waited = 0; !raced.state.closed && waited < 400; waited += 1) {
					await new Promise((resolve) => setImmediate(resolve));
				}
				mock.timers.reset();
				assert.equal(raced.state.closed, true, `${carry}, ${race}`);
				await raced.host.close(context);
			}
			// The owner's other device signed in before and is untouched.
			const others = await kept.host.get(Sessions, {}, context);
			await others.create({ title: "by the other device" }, context);
			assert.equal(kept.state.closed, false);
		} finally {
			entry.authenticate = original;
			await kept.host.close(context);
		}
	});
});
```

# A Row Moves Between Pages {#reorder lede="The one blocker of the reviews was in Chord, found through p3's archived list."}

51 archived sessions, two loaded pages. The last one is archived again, so it moves from page 2 to the top of page
1. Both pages changed in one commit; the list set its value once per page; Chord sent the list's member twice in one
state message; the client rejected that as a protocol error and closed the owner's whole link.

The fix is in Chord's `FramedSource` (lists and live queries): however often a commit sets it, it is listed for
delivery once, and its one frame is the diff from the value before the commit. `src/state/framed.ts`:

```ts
	/**
	 * Its state becomes `next` in the batch running now. The first change of a batch lists it for that batch's frame
	 * and keeps what its watches have, which the frame diffs from; a later one lists nothing (a source listed twice
	 * delivers twice: two frames of one member in one commit, which a link refuses). Every change marks its
	 * dependents: one may have read the value since the last.
	 */
	#change(next: FramedState): void {
		if (this.watched && this.#framed === undefined) {
			const state = this.#state;
			this.#framed = state.kind === "value" ? state.value : NO_VALUE;
			this.batch.changed(this);
		}
		this.#state = next;
		for (const dependent of this.dependents) dependent.invalidate();
	}
}
```

A watched derive had the same flaw by another path (read between two changes in one commit); `src/state/derive.ts`
got the same rule. p3's regression test is Astra's reproduction:

```ts
	it("moves a row from its last page to its first in one frame: the link stays open", async () => {
		// Review round 1 (Astra): both pages changed in one commit, the list's member was sent twice in one state
		// message, and the client closed the owner's link for the protocol error.
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		for (let i = 0; i < 51; i++) await sessions.archive({ id: await sessions.create({}, context) }, context);
		const archived = await owner.get(SessionsList, ARCHIVED, context);
		await archived.more(context);
		assert.equal(archived.list.value.rows.length, 51);
		const last = archived.list.value.rows.at(-1)!.id;
		// Archived again, strictly later: the last archived first.
		await new Promise((resolve) => setTimeout(resolve, 2));
		await sessions.archive({ id: last }, context);
		assert.deepEqual([archived.list.value.rows[0]?.id, archived.list.value.rows.length], [last, 51]);
		assert.equal(archived.state.value.kind, "live");
	});
```

# Before and After {#before-after lede="What the first build of slice 1 did, and why the redo does not."}

The first build (committed `0db9861ec`, on Chord before its slice 14) is replaced.

| | First build | Redo |
| --- | --- | --- |
| a session's data | a table row and a facts document, written in one transaction | the row |
| the owner's list | the newest 200, archived ones included, no paging | a list per app and set, 50 at a time, `more`, no cap |
| a worker's view of its session | a document keyed by its address | one live read by id |
| a hold for an unknown id | forked a worker | denied by the route, nothing starts |
| rename, archive | `put` of the row and a rewrite of the document | `update` of the changed columns |
| the kit | Chord's `chord/app` (surfaces, files, export, pairing, telemetry loaded and unused) | `src/kit/`, what slice 1 uses |
| a revoked sign-in | kept its open links | closes them, and only them |

The cap and the copy, as they were (`git show 0db9861ec:apps/p3/plugins/sessions/server.ts`):

```ts
/** How many sessions the owner's list holds: the newest. */
const LIST = 200;

/** The newest sessions first (the key breaks ties of one millisecond). */
const NEWEST = query(Rows).orderBy((row) => row.createdAt, "desc");
```

```ts
		const newest = self.query(rows, NEWEST, LIST);
		/** Replaces session `id`'s row by `change(row)` and writes its facts from the new row, in one transaction. */
		const update = (id: string, change: (row: Row) => Row, ctx: Ctx) =>
			self.tx(async (tx) => {
				const old = await tx.get(rows, { id: Session({ id }) });
				if (old === undefined) throw invalid("args", `sessions: no session ${id}`);
				const row = change(old);
				tx.put(rows, row);
				await writeFacts(tx, facts, row);
			}, ctx);
```

```ts
/** Writes the facts of `row`'s session from it, inside `tx`. */
async function writeFacts(tx: Tx, facts: HandleOf<typeof FactsDocs>, row: Row): Promise<void> {
	const draft = await tx.draft(facts, row.id);
	draft.session = infoOf(row);
}
```

Session 201 was invisible, and every write was two writes that had to agree. The practices file records both as
mistakes with their fix (`docs/chord-practices.md`).

The same bench on the same day and Chord (slayer, three runs each):

| | First build | Redo |
| --- | --- | --- |
| server listening | 47–49 ms | 41–53 ms (42 typical) |
| server `RssAnon` (with the bench's client) | 115–118 MiB | 105–114 MiB |
| worker start, cold (with the worker base's build) | 268–336 ms | 198–219 ms |
| worker start, warm | 102–104 ms | 91–92 ms |
| idle worker `RssAnon` | 37.4–37.9 MiB | 34.4–34.5 MiB |

# What Breaks If a Line Goes {#mutations lede="Each rule undone alone in a copy; the test that fails says the rule is real."}

48 mutations, each caught. The most telling ones:

| The line | Without it | The test that fails |
| --- | --- | --- |
| `if (principal.kind !== "owner") throw forbidden(…)` in `Sessions`, `SessionsList` | a person or a worker gets the owner's objects | "refuses persons and workers the owner's sessions and lists" |
| `{ id: principal.session }` in `SessionFacts` | a worker reads a fixed or foreign row | "gives a worker its own session's row, and an unknown session none" |
| `if ((await tx.get(rows, key)) === undefined) throw invalid(…)` | a rename of an unknown id succeeds silently | "refuses a rename of a session that does not exist" |
| `tx.update(rows, key, change)` (against a `put`) | every write probes every open read | "runs only the reads that show a renamed session" |
| `eq(s.app, app)` in `active`, `archived` | every app's sessions in one list | "lists an app's sessions only: another app's lists are empty" |
| `eq(s.archivedAt, 0)` / `gt(s.archivedAt, 0)` | archived sessions among the active, or the reverse | "moves an archived session to the archived list, and a restored one back" |
| the index `archived` (or `active`) | SQLite sorts every page | "walk their index in order: no query sorts" |
| `const PAGE = 50` | another page size | "has no cap: `more` loads every session once" |
| `archivedAt === 0 ? null : archivedAt` | clients see the storage's 0 | "creates, renames, archives and restores for the owner, and lists each step" |
| `rows.length === 1` in `SessionRoute` | every id "exists" | "tells the route whether a session exists" |
| `deny("no such session")` in `sessionExists` | a worker forks for any id | "starts no worker for a session that does not exist"; end to end too |
| `authorize: mayReachSession`, `admit: sessionExists` in the kit | the real server's route lets anyone, or any id, through | "is asked before a worker starts…" (kit) |
| `dir: workerDirectory(dataDir, address)` | workers share one directory | "keeps its store in workers/<kind>/<key>/…, each address its own" |
| `K … = never` in `forward` | a view without `own` type-checks with any store | `npm run check`: unused `@ts-expect-error` |
| the names from `memberNames` only | a store's private member leaks into a view | "gives a view the store's state and methods, and its own members" |
| `links.close(id)` in `end` | a revoked device keeps working | "are closed at once; the owner's other devices keep their links…" |
| `this.#closes.get(id)` (against all ids) | a revoke disconnects every device | the same test: the other device's link must stay |
| `if (!this.#live(id)) { close(); … }` | the race of chapter IX | "are closed at once when the sign-in ended between its authentication and the link's registration" |
| `links.signedIn(request, …)` for cookies too | a cookie link is never tracked | the same test, its cookie cases |
| `new WeakMap<HttpRequest, string>()` | every authenticated request is kept forever | "keeps no request it authenticated" (GC) |
| `this.#hash = undefined` in `OwnerLink.consume` | the owner link works twice | "serves a page reading the fragment, signs the owner in once…" |
| `join(homedir(), ".pi", NAME)` | another default data directory | "makes the layout's directories with mode 0700…" |

Two tests had waits without a bound and hung under a mutation; both are bounded now. The script is
`/tmp/p3-s1-redo/mutate.py` on slayer: it copies nothing into the repository.

# The Tests {#tests lede="65 tests of slice 1, three tiers and the kit's own, about two seconds."}

| Tier | Where | What runs | Tests |
| --- | --- | --- | --- |
| plugin | `plugins/sessions/sessions.test.ts` | the server facet, built as production builds it, on one host (`testPlugin`) | 7 |
| topology | `test/sessions.test.ts` | server and workers as hosts in one process, linked in memory, real SQLite stores | 16 |
| plans | `test/plans.test.ts` | the store on its own SQLite; `EXPLAIN QUERY PLAN` of each statement Chord runs | 1 |
| kit | `test/kit/*.test.ts` | the real `startServer` on a temporary directory, HTTP requests, forked workers | 38 |
| end to end | `test/app.test.ts` (the case is `end-to-end.ts`), `api.test.ts` | `startP3`, a WebSocket client with the owner token, a forked worker, a restart | 3 |

The topology is what makes most tests take milliseconds. `test/topology.ts`, its core: the server's route with the
real policy, and a worker made as the kit makes one (connected first, then loaded).

```ts
	async start(): Promise<void> {
		const context = this.#context;
		const store = await storeAt(this.#store.kind === "file" ? this.#store.path : ":memory:", context);
		const onError = (error: HostError) => this.#errors.push(error);
		const server = createHost<P3Principal>({
			address: Server(),
			principal: PRINCIPALS.server,
			store,
			telemetry: this.#telemetry,
			readyTimeout: READY,
			onError,
		});
		this.#server = { host: server, store };
		const route = {
			authorize: mayReachSession,
			admit: sessionExists,
			resolve: (address: Address<typeof Session>) => this.#worker(address),
		};
		server.route(Session, route, context);
		try {
			throwFailed(await server.load([this.#info, { name: SESSIONS, facet: sessionsServer }], context));
		} catch (error) {
			// Nobody gets the topology: what it opened closes here (the kit closes a failed start the same way).
			await this.close();
			throw error;
		}
	}

	/** Starts the worker at `address`, as the kit does: connected first, then loaded (W6); its link for the route. */
	async #worker(address: Address<typeof Session>) {
		const context = this.#context;
		const principal = PRINCIPALS.worker(address);
		const store = await storeAt(":memory:", context);
		const onError = (error: HostError) => this.#errors.push(error);
		const host = createHost<P3Principal>({ address, principal, store, readyTimeout: READY, onError });
		const facets = [{ name: "p3.worker-info", facet: workerInfoFacet(address) }, ...WORKER_PLUGINS];
		this.#workers.set(address.key, { host, store, facets });
		const [up, down] = memoryLinkPair();
		host.connect(up, { principal: PRINCIPALS.server, trusted: true }, context);
		// Not awaited: the route returns the link before the worker loaded (its load may wait on the server).
		void host.load(facets, context).then(
			(report) => {
				if (report.failed.length > 0) {
					this.#errors.push({ kind: "worker_load_failed", worker: address.key, failed: report.failed });
				}
			},
			(error: unknown) =>
				this.#errors.push({ kind: "worker_load_failed", worker: address.key, failed: [{ plugin: "", error }] }),
		);
		return { link: down, principal, trusted: true };
	}
```

It can reload the sessions plugin on the server and on a worker, as an Apply will (slice 2). The reload test under
an open list of three pages:

```ts
	it("keeps its pages across a reload of the sessions plugin", async () => {
		const t = await start();
		const { owner, sessions } = await ownerSessions(t);
		for (let i = 0; i < 120; i++) await sessions.create({ title: `s${i}` }, context);
		const list = await owner.get(SessionsList, { ...ACTIVE, view: "later" }, context);
		await list.more(context);
		await list.more(context);
		const loaded = ids(list.list.value);
		assert.deepEqual([loaded.length, list.list.value.moreAfter], [120, false]);
		const worker = await owner.get(SessionWorker, { session: loaded[0]! }, context);
		const sizes: number[] = [];
		const watch = await list.list.watch(context);
		watch.start(async (call) => {
			if (call.kind === "value") sizes.push(call.value.rows.length);
		});
		await t.reloadSessions();
		await new Promise((resolve) => setTimeout(resolve, 2));
		const id = await sessions.create({ title: "after" }, context);
		await sessions.rename({ id: loaded[0]!, title: "renamed after" }, context);
		await until(list.list, ({ rows }) => rows[0]?.id === id && rows[1]?.title === "renamed after", context);
		await until(worker.session, (session) => session?.title === "renamed after", context);
		await watch.stop();
		assert.deepEqual(ids(list.list.value), [id, ...loaded]);
		// No frame showed fewer rows than were loaded: the successor opened the pages the list had.
		assert.ok(sizes.length > 0 && sizes.every((size) => size >= 120));
	});
});
```

After every topology test, nothing may have failed in the background but the refusals the test asked for.

# The Numbers {#numbers lede="Measured by bench/slice-1.ts on slayer (Linux x64, Node 24.4.1), three runs."}

:::stats
42 ms | server listening
91 ms | a worker's warm start
35.1 MiB | an idle worker's own memory (USS)
0.7 ms | opening a list, at any size
:::

## What a worker really costs

USS is `Private_Clean + Private_Dirty` of `/proc/<pid>/smaps_rollup`: memory no other process shares. PSS adds each
shared page divided by its sharers.

| | Value |
| --- | --- |
| idle worker `RssAnon` (median of 10) | 34.4–34.5 MiB |
| idle worker USS (median of 10) | 35.1 MiB |
| ten idle workers at once, USS in all | 343–351 MiB (35 each) |
| ten idle workers at once, PSS in all | 383–391 MiB (38–39 each) |

Ten cost ten times one. 100 idle session workers need about 3.5 GiB. Nearly all of it is Node and Chord loaded in
each process: the worker's own plugin code is 13 lines.

## The list, and where its time goes

Medians of 30 runs; each run opens a fresh list (50 rows) and calls `more` once.

| | 1,000 sessions | 10,000 | 100,000 |
| --- | --- | --- | --- |
| over the WebSocket: open | 1.0–1.3 ms | 0.74 ms | 0.71–0.73 ms |
| over the WebSocket: `more` | 0.75 ms | 0.51 ms | 0.48 ms |
| over the WebSocket: a trivial object held, a trivial call | 0.21, 0.12 ms | 0.17, 0.09 ms | 0.16, 0.09 ms |
| on the server's host, no link: open, `more` | 0.43, 0.25 ms | 0.40, 0.23 ms | 0.40, 0.23 ms |
| the store's page of 51 rows alone: first, after a bookmark | 0.16, 0.19 ms | 0.14, 0.16 ms | 0.15, 0.17 ms |

The 1,000 column is slower only because it runs first, on code still being compiled. The very first open after a
start takes 2.4–3.5 ms.

:::flow wide | One open, 0.72 ms at 100,000 sessions, by subtraction of the rows above.
row "0.72 ms" accent
box rt "round trip" "0.12 ms" muted
box act "activation" "0.04 ms" muted
box read "the page's read" "0.15 ms: SQLite, decoding, mapping" accent
box obj "the list's object" "0.2 ms: its reference to the store, its page registered" accent
box enc "encode + decode" "0.2 ms: 50 rows, both ends" blue
arrow rt -> act ""
arrow act -> read ""
arrow read -> obj ""
arrow obj -> enc ""
:::

By CPU time (a profile of 200 opens and `more`s; server and client share the bench's process; 1.25–1.32 ms for one
open plus one `more`): the link (encoding, decoding, replicas) 0.35–0.40 ms; SQLite's statements 0.21 ms; the store
around them 0.20 ms; socket I/O 0.21 ms; objects 0.12 ms; the list's pages 0.06 ms; the plugin's mapping 0.03 ms.
Nothing dominates, and nothing grows with the number of sessions.

# Open Points {.epilogue lede="What the owner decided, what the slice leaves for later, and what to look at in the review."}

**Decided for the redo (owner, 2026-11-15):** the kit is typed to p3; `forward` takes the view's own members as a
fourth argument; state and last touch get their writers with the harness (slice 3); the kit's names are p3's
(`p3.info`, `p3.sign-ins`, the cookie `p3-sign-in`, `/_p3/owner`); the default data directory is `~/.pi/p3`; Chord
exports `memberNames`; a sign-in that ends closes its own links through Chord's `links.opened` close.

**Carried to later slices:**

- who writes `state` and `lastTouch` after create (slice 3);
- archive stopping the worker and refusing its start; delete, export, import, fork (slice 18);
- persons, devices, pairing (slice 5); the web and terminal surfaces (slice 16); Apply and the restart mark (slice 2);
- one read per session instead of two, once Chord shares reads between readers;
- `contribute` has no user yet (its first comes with slice 2 or later).

**Worth a look in the review:**

- `startServer` is one sequence of about 50 lines; splitting it would hide the order.
- The race test replaces Chord's composed authenticator entry through a cast, to force an order no real timing
  gives reliably.
- The kit closes only links its own authenticator signed in. A later authenticator (Radius sign-in) must close its
  own links when its credential ends.
- A `~/.p3` from the first build is not read any more; the data directory is `~/.pi/p3`.

# The Remaining Kit Files {.appendix}

`src/kit/layout.ts`, whole:

```ts
// The data directory: one fixed layout, made private at every start. `server/` holds the server's store and its cookie
// secret, `workers/<kind>/<address>/` each worker's store, `cache/` what only saves time (`worker/`, the session
// workers' base, written again at every start; `node/`, the workers' compile cache), `owner-token` the owner's token
// for command-line clients. Directories are 0700 and stores 0600, also when they existed looser before (other
// local users must not read the sign-ins in a store, nor replace it).

/** The paths of a data directory. */
export type Layout = {
	readonly dataDir: string;
	readonly serverStore: string;
	readonly cookieSecret: string;
	/** The session workers' base (`WorkersOptions.baseDir`): written again at every start. */
	readonly workerBase: string;
	/** Node's compile cache for the workers (`NODE_COMPILE_CACHE`). */
	readonly compileCache: string;
	readonly ownerToken: string;
};

/** The data directory unless the start script names one: `~/.pi/p3`. */
export function defaultDataDir(): string {
	return join(homedir(), ".pi", NAME);
}

/**
 * The real path of the data directory `path`, made when missing (mode 0700), refused when the kit must not make it
 * private: the home directory, a file system's root, or a directory another user owns (a clear error, instead of
 * tightening a directory others use or failing on `EPERM`). Its mode is set on the real path, never through a link.
 */
export async function openDataDir(path: string): Promise<string> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const dataDir = await realpath(path);
	const home = await realpath(homedir());
	if (dataDir === home || dataDir === parse(dataDir).root) {
		const what = dataDir === home ? "the home directory" : "a file system's root";
		throw new Error(`startServer: the data directory ${dataDir} is ${what}; name a directory of p3's own`);
	}
	const { uid } = await stat(dataDir);
	if (process.getuid !== undefined && uid !== process.getuid()) {
		throw new Error(`startServer: the data directory ${dataDir} belongs to another user (uid ${uid})`);
	}
	return dataDir;
}

/** The layout of `dataDir` (a real path, `openDataDir`'s), its directories made private (`privateDirectory`). */
export async function createLayout(dataDir: string): Promise<Layout> {
	const layout: Layout = {
		dataDir,
		serverStore: join(dataDir, "server", "store.sqlite"),
		cookieSecret: join(dataDir, "server", "cookie-secret"),
		workerBase: join(dataDir, "cache", "worker"),
		compileCache: join(dataDir, "cache", "node"),
		ownerToken: join(dataDir, "owner-token"),
	};
	const parents = [dataDir, join(dataDir, "server"), join(dataDir, "workers"), join(dataDir, "cache")];
	for (const dir of [...parents, layout.workerBase, layout.compileCache]) await privateDirectory(dir);
	return layout;
}

/** Makes `dir` (and missing parents) with mode 0700, and sets 0700 on it when it existed. */
export async function privateDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
}

/**
 * Makes the store file `path` private before SQLite opens it: created empty with mode 0600 when missing (SQLite gives
 * its journal files the database's mode), else set to 0600 with the journal files it has.
 */
export async function privateStore(path: string): Promise<void> {
	await (await open(path, "a", 0o600)).close();
	for (const file of [path, `${path}-wal`, `${path}-shm`]) {
		await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

/** The directory of the worker at `address`: `workers/<kind>/<its key, encoded>`. */
export function workerDirectory(dataDir: string, address: Address): string {
	return join(dataDir, "workers", address.kind, encodedKey(address.key));
}

/** The longest key kept readable as a directory name; a longer one is named by its hash. */
const READABLE_KEY = 160;

/**
 * An address key as one directory name: percent-encoded (`/`, `\`, `.` and every other character a file system might
 * treat specially included), or its SHA-256 when that is longer than `READABLE_KEY`. Capital letters are encoded too:
 * on a case-insensitive file system (macOS) `p|A` and `p|a` would otherwise share a directory.
 */
function encodedKey(key: string): string {
	const encoded = encodeURIComponent(key).replace(
		/(%[0-9A-F]{2})|[.!'()*~A-Z]/g,
		(match, escaped: string | undefined) => escaped ?? `%${match.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return encoded.length <= READABLE_KEY ? encoded : `sha256-${createHash("sha256").update(key).digest("hex")}`;
}
```

`src/kit/secrets.ts`, whole:

```ts
// Secrets of the kit: tokens from `crypto.randomBytes`, kept only as their SHA-256 hashes and compared in constant
// time, and secret files (the cookie key, the owner token file) created with mode 0600 in one step, so no other OS user
// and no half-written file ever reads them.

/** A fresh random token of `bytes` bytes, base64url. */
export function newToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

/** The hash a token is kept as (SHA-256, hex): what leaks from a store is no credential. */
export function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

/** Whether `token` hashes to `hash`, compared in constant time. */
export function matchesHash(token: string, hash: string): boolean {
	const given = Buffer.from(hashToken(token), "hex");
	const kept = Buffer.from(hash, "hex");
	return given.length === kept.length && timingSafeEqual(given, kept);
}

/** The secret in the file at `path`, created (mode 0600, in one step) with a fresh token when it does not exist yet. */
export async function secretFile(path: string): Promise<string> {
	const existing = await readSecret(path);
	if (existing !== undefined) return existing;
	const secret = newToken();
	const written = await writeSecret(path, secret, "create");
	return written === "exists" ? ((await readSecret(path)) ?? secret) : secret;
}

/** The text of the secret file at `path`, or `undefined` when it does not exist. */
export async function readSecret(path: string): Promise<string | undefined> {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Writes `text` to `path` with mode 0600 in one step: a temporary file of the same directory (made exclusively, 0600)
 * linked into place (`create`: refused when `path` exists, `"exists"` returned) or renamed over it (`replace`).
 */
export async function writeSecret(
	path: string,
	text: string,
	mode: "create" | "replace",
): Promise<"written" | "exists"> {
	const temporary = join(dirname(path), `.${newToken(9)}.tmp`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(`${text}\n`);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		if (mode === "replace") {
			await rename(temporary, path);
			return "written";
		}
		await link(temporary, path);
		return "written";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
		throw error;
	} finally {
		await unlink(temporary).catch(() => {});
	}
}
```

`src/kit/contribute.ts`, whole (p2's helper; unused in this slice, tested alone):

```ts
// `contribute`: an object that only contributes. A facet's own `self.contribute` takes plain values; a contribution
// that needs a reference, a registry, a derive or a writable needs an object to declare them in. Browser-safe: the API
// module exports it.

/**
 * Serves a host-lifetime local object named `name` with no members, whose factory only calls `register(self)`: what it
 * contributes (routes, tools, renderers) is in its registries from the moment the object is live until it ends, fails
 * or restarts. A contribution that needs nothing at run time belongs to the facet's own `self.contribute` instead.
 */
export function contribute(
	host: FacetHost<P3Principal>,
	name: string,
	register: (self: StoreSelf<P3Principal>) => void,
): void {
	host.serve(local(name, { version: 1, params: {}, members: {} }), (_params, self) => {
		register(self);
		return {};
	});
}
```

`worker.ts`, the worker's entry, whole:

```ts
// A p3 session worker (decision "Base entries are named after what they are"): one process per session, started by the
// server. The kit's `startWorker` opens the session's store, connects to the server and loads the plugins' worker
// facets.

startWorker({ onError: (error) => console.error("p3 worker:", error) });
```

# How to Run It {.appendix}

```sh
export PATH=/home/badlogic/node-v24.4.1-linux-x64/bin:$PATH
cd apps/p3
npm run check                    # biome and tsc
npm test                         # 73 tests, about 3 s (65 of slice 1, 8 of slice 26)
node --conditions=source --disable-warning=ExperimentalWarning bin.ts /tmp/p3-data        # prints the owner link
node --conditions=source --disable-warning=ExperimentalWarning bench/slice-1.ts           # the numbers, about 12 s
```

The four reviews of the redo (two rounds, and the re-checks) are `/tmp/p3-s1-v2-r{1,2}-{opus,sol,astra,fable}.md` on
slayer; the brief lists every finding with its fix.
