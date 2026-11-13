// Test support for the app kit (slice 13): an app started in a temporary data directory with a temporary plugins root,
// the tests' API (Chord's surface as `@test/app/v1`), a worker kind whose entry is the fixture worker, and requests to
// it as a browser or a command-line client would make them.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { type Address, hostKind, int, method, remote, str, unknown } from "../../../src/contracts/index.ts";
import type { Principal } from "../../../src/data/index.ts";
import * as chord from "../../../src/index.ts";
import {
	type App,
	AppInfo,
	type AppOptions,
	Files,
	Sessions,
	startServer,
	WorkerInfo,
} from "../../../src/node/app/index.ts";
import { Http } from "../../../src/node/http/index.ts";
import { settleFileEvents, writeFiles, writePlugin } from "../plugins/support.ts";

/** The principals of these tests. */
export type TestPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "owner" }
	| { readonly kind: "worker"; readonly key: string }
	| { readonly kind: "user"; readonly id: string; readonly name: string };

/** The principals of an app whose owner is one of its users: no owner kind. */
export type UserPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "worker"; readonly key: string }
	| { readonly kind: "user"; readonly id: string; readonly name?: string };

/** The tests' worker kind: a project by id. */
export const Project = hostKind("project", { id: str() });

/** The tests' API v1: Chord's surface and the kit's objects, as an app's API re-exports them. */
export const API_V1 = { ...chord, AppInfo, WorkerInfo, Files, Sessions };

/** The tests' API, as the server and the fixture worker have it. */
export const API = {
	name: "@test/app",
	versions: ["v1"],
	modules: { "@test/app/v1": API_V1, "@test/app/v1/server": { Http } },
} as const;

/** The fixture worker's entry. */
export const WORKER_ENTRY = fileURLToPath(new URL("../fixtures/app/worker.ts", import.meta.url));

const made: string[] = [];

afterEach(async () => {
	for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A temporary directory removed after the test. */
export async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "chord-app-"));
	made.push(dir);
	return dir;
}

/**
 * What a test app takes: `AppOptions` but its principals (the test app's), and plugins (directory name to files)
 * written into its root first.
 */
type TestAppOptions<P extends Principal> = Partial<Omit<AppOptions<P>, "principal">> & {
	readonly plugins?: Readonly<Record<string, Readonly<Record<string, string>>>>;
	readonly withWorkers?: boolean;
	/** Whether the app is handed out before its bases are built (`basesBuilt`): after by default. */
	readonly unbuilt?: boolean;
};

/** The test apps' server principal. */
const SERVER = { kind: "server" } as const;

/** The test apps' worker principal at `address`. */
function workerOf(address: Address) {
	return { kind: "worker", key: address.key } as const;
}

/** A started test app (owner `{ kind: "owner" }`) and what it reported. */
export function testApp(options: TestAppOptions<TestPrincipal> = {}) {
	return startTestApp<TestPrincipal>({ server: SERVER, worker: workerOf, owner: { kind: "owner" } }, options);
}

/** A started test app whose owner is `owner`, one of its users, and what it reported. */
export function userOwnerApp(owner: UserPrincipal, options: TestAppOptions<UserPrincipal> = {}) {
	return startTestApp<UserPrincipal>({ server: SERVER, worker: workerOf, owner }, options);
}

/**
 * A test app with the principals `principal` (`worker` only for worker kinds), started in a temporary data directory
 * and plugins root, its bases built, and what it reported.
 */
export async function startTestApp<P extends Principal>(
	principal: { readonly server: P; readonly worker?: (address: Address) => P; readonly owner: P },
	options: TestAppOptions<P>,
): Promise<{ app: App<P>; errors: unknown[]; dataDir: string; root: string; port: number }> {
	const base = await tempDir();
	const dataDir = options.dataDir ?? join(base, "data");
	const root = options.root ?? join(base, "plugins");
	await writeFiles(root, { ".keep": "" });
	for (const [dir, files] of Object.entries(options.plugins ?? {}))
		await writePlugin(root, dir, `@test/${dir}`, files);
	await settleFileEvents();
	const errors: unknown[] = [];
	const app = await startServer<P>(
		// The tests pass worker kinds (`withWorkers`, `workers`) only with `principal.worker`.
		{
			name: "chord-test",
			dataDir,
			root,
			listen: { host: "127.0.0.1", port: 0 },
			api: API,
			kinds: { server: { platform: "node" }, worker: { platform: "node" } },
			principal,
			workers:
				options.withWorkers === true
					? [
							{
								kind: Project,
								entry: WORKER_ENTRY,
								execArgv: ["--conditions=source", "--experimental-strip-types", "--no-warnings"],
								start: (address) => ({ project: address.key }),
								authorize: () => true,
								idleMs: () => 60_000,
							},
						]
					: [],
			onError: (error) => errors.push(error),
			...options,
		} as AppOptions<P>,
		context,
	);
	// The bases built after the listen: most tests get the app as its first requests see it.
	if (options.unbuilt !== true) {
		await app.basesBuilt;
		// Retire startup events before a test makes its first distinct edit.
		await settleFileEvents();
	}
	const port = Number(new URL(app.ownerLink()).port);
	return { app, errors, dataDir, root, port };
}

/** A plugin's server facet serving `Echo` (a `local` type) through the tests' API. */
export const ECHO_SERVER = [
	'import { constant, defineFacet, local, str } from "@test/app/v1";',
	'const Echo = local("test.echo", { version: 1, params: {}, members: { text: str() } });',
	'export default defineFacet((host) => host.serve(Echo, () => ({ text: constant("echo") })));',
].join("\n");

/** The notes plugin's remote contract (`NOTES_PLUGIN`), declared again for the tests (contracts are data). */
export const Notes = remote("test.notes", {
	version: 1,
	params: { id: str() },
	hostAddress: ({ id }) => Project({ id }),
	variants: {
		main: {
			state: { text: str(), start: unknown() },
			methods: {
				write: method(str()),
				visit: method(str(), int()),
				attach: method(str(), str()),
				file: method(str(), str()),
			},
		},
	},
});

/**
 * The notes plugin of the export tests (`withWorkers`): on each project's worker a store object with a persisted
 * document, a table and the worker's files, reached from the server through the remote `Notes`.
 */
export const NOTES_PLUGIN: Readonly<Record<string, string>> = {
	"contract.ts": [
		'import { hostKind, int, method, remote, str, unknown } from "@test/app/v1";',
		'export const Project = hostKind("project", { id: str() });',
		'export const Notes = remote("test.notes", {',
		"\tversion: 1,",
		"\tparams: { id: str() },",
		"\thostAddress: ({ id }) => Project({ id }),",
		"\tvariants: { main: { state: { text: str(), start: unknown() }, methods: {",
		"\t\twrite: method(str()), visit: method(str(), int()), attach: method(str(), str()), file: method(str(), str()),",
		"\t} } },",
		"});",
	].join("\n"),
	"worker.ts": [
		'import { defineFacet, defineState, defineTable, Files, int, local, method, obj, str, WorkerInfo } from "@test/app/v1";',
		'import { Notes } from "./contract.ts";',
		'const Text = defineState("test.text", { schema: obj({ text: str() }), version: 1, initial: () => ({ text: "" }), persist: true, checkpointWhen: () => false });',
		'const Visits = defineTable("test.visits", { version: 1, columns: { page: str(), count: int() }, key: ["page"] });',
		'const Store = local("test.store", { version: 1, params: {}, members: { text: str(), write: method(str()), visit: method(str(), int()) } });',
		"export default defineFacet((host) => {",
		"\thost.serve(Store, (_params, self) => {",
		"\t\tconst text = self.state(Text);",
		"\t\tconst visits = self.table(Visits);",
		"\t\treturn {",
		"\t\t\ttext: self.derive([text], ([value]) => value.text),",
		"\t\t\twrite: async (next, ctx) => { await text.change((draft) => { draft.text = next; }, ctx); return null; },",
		"\t\t\tvisit: async (page, ctx) => self.tx(async (tx) => { const count = ((await tx.get(visits, { page }))?.count ?? 0) + 1; tx.put(visits, { page, count }); return count; }, ctx),",
		"\t\t};",
		"\t});",
		"\thost.serve(Notes, (_params, _principal, self) => {",
		"\t\tconst store = self.get(Store, {});",
		"\t\tconst info = self.get(WorkerInfo, {});",
		"\t\tconst files = self.get(Files, {});",
		"\t\tconst decoder = new TextDecoder();",
		'\t\treturn { variant: "main", members: {',
		"\t\t\ttext: self.derive([store.text], ([value]) => value),",
		"\t\t\tstart: self.derive([info.start], ([value]) => value),",
		"\t\t\twrite: (next, ctx) => store.write(next, ctx),",
		"\t\t\tvisit: (page, ctx) => store.visit(page, ctx),",
		'\t\t\tattach: async (body, ctx) => (await files.put({ space: "notes", path: "note.txt", mime: "text/plain", source: "test", bytes: new TextEncoder().encode(body) }, ctx)).id,',
		"\t\t\tfile: async (id, ctx) => decoder.decode(await files.read({ id, offset: 0, length: 1024 }, ctx)),",
		"\t\t} };",
		"\t});",
		"});",
	].join("\n"),
};

/** A plugin's server facet with a route (not public) answering who it runs as: `GET /whoami`. */
export const WHOAMI = [
	'import { defineFacet } from "@test/app/v1";',
	'import { Http } from "@test/app/v1/server";',
	'export default defineFacet((_host, self) => self.contribute(Http, { routes: { "GET /whoami": async (_request, ctx) => ({ kind: "json", value: ctx.principal ?? null }) } }));',
].join("\n");

/** The `Authorization` header of a new device session for `principal` on `app`. */
export async function bearerFor<P extends Principal>(
	app: App<P>,
	principal: P,
): Promise<{ readonly authorization: string }> {
	const { token } = await app.host.root(
		async (ctx) => (await ctx.get(Sessions, {})).issue({ principal, label: "test", kind: "device" }, ctx),
		context,
	);
	return { authorization: `Bearer ${token}` };
}
