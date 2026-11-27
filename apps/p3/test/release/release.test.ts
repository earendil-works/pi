// The installed release: p3 as `npm run release:p3:local` built, packed and installed it outside the repository.
// `P3_RELEASE` names the install directory; the release script sets it. Not part of `npm test`: it needs that install.
// It checks what the package holds, the command, a session's worker forked from the release's own bundle, the page
// (its base bundle built in the install), and a third-party plugin written against nothing but the installed API:
// type-checked, its own tests run on the installed `/v1/testing` (the plugin tier, and end to end: the installed
// server with its workers forked from the release's bundle), loaded from the Pi's user root, and called by a client
// that uses the compiled API modules.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ownerClient, ownerCookie } from "@earendil-works/p3/v1/testing";
import { SessionWorker } from "../../plugins/sessions/contract.ts";
import { childrenOf, launch, newSession, offline, TMP } from "../support.ts";
import { eventually } from "../until.ts";

const run = promisify(execFile);

const { P3_RELEASE } = process.env;
if (P3_RELEASE === undefined) throw new Error("release.test.ts: set P3_RELEASE to the install directory");

/** The install's node_modules and the installed package. */
const MODULES = join(P3_RELEASE, "node_modules");
const PACKAGE = join(MODULES, "@earendil-works", "p3");

/** Node's arguments that run the installed command. */
const P3 = [join(PACKAGE, "dist", "p3.js")];

/** The repository's TypeScript: a plugin author's own would do the same. */
const TSC = fileURLToPath(new URL("../../../../node_modules/typescript/bin/tsc", import.meta.url));

/** A temporary directory of the run's, removed afterwards. */
const root = await mkdtemp(join(tmpdir(), "p3-release-test-"));
after(() => rm(root, { recursive: true, force: true }));

describe("the installed release", () => {
	it("holds the bundles, the API's types and the built-in plugins as source, and nothing else", async () => {
		const dist = await readdir(join(PACKAGE, "dist"));
		for (const file of ["p3.js", "main.js", "worker.js", "supervisor.js", "minimum-node.js"]) {
			assert.ok(dist.includes(file), file);
		}
		for (const module of ["index", "server", "worker", "testing"]) {
			await readFile(join(PACKAGE, "dist", "src", "api", "v1", `${module}.d.ts`));
		}
		const plugins = await readdir(join(PACKAGE, "plugins"), { recursive: true });
		assert.deepEqual(
			plugins.filter((path) => /\.(test\.ts|js|d\.ts|map)$/.test(path) || /(^|[/\\])test([/\\]|$)/.test(path)),
			[],
			"plugins ship as source only, no tests",
		);
		for (const plugin of ["control", "runner", "sessions", "sign-in"]) assert.ok(plugins.includes(plugin), plugin);
	});

	it("starts in the background, says it runs, and stops", async () => {
		const home = join(root, "home");
		await mkdir(home);
		const p3 = (...args: string[]) =>
			run(process.execPath, [...P3, ...args], { env: offline({ ...process.env, HOME: home }) });
		const started = await p3("--port", "0");
		assert.match(started.stdout, /port \d+\. Open http:\/\/127\.0\.0\.1:\d+\/_p3\/owner#/);
		assert.match((await p3("status")).stdout, /running/);
		assert.equal((await p3("stop")).stdout.trim(), "stopped");
	});

	it("forks a session's worker from the release's own worker bundle", async () => {
		const server = await launch(P3, join(root, "workers"));
		try {
			const client = await ownerClient(server.dataDir, server.port, context, 30_000);
			const id = await newSession(client, "one", context, TMP);
			const worker = await client.get(SessionWorker, { session: id }, context);
			assert.equal(worker.state.value.kind, "live");
			// Besides the worker, the server has esbuild's service as a child (it builds the plugins).
			const children = await eventually(
				() => childrenOf(server.pid),
				(found) => found.some(({ args }) => args.some((arg) => arg.includes("worker"))),
			);
			const workers = children.filter(({ args }) => args.some((arg) => arg.includes("worker")));
			assert.equal(workers.length, 1, JSON.stringify(children));
			assert.ok(workers[0]!.args.includes(join(PACKAGE, "dist", "worker.js")), workers[0]!.args.join(" "));
			await client.close(context);
		} finally {
			await server.stop();
		}
	});

	it("serves the page, its base bundle built from the installed src/web and the compiled web API", async () => {
		const server = await launch(P3, join(root, "page"));
		try {
			const cookie = await ownerCookie(server.dataDir, server.port, context);
			const page = await fetch(`http://127.0.0.1:${server.port}/`, { headers: { cookie } });
			assert.equal(page.status, 200, "the page's build succeeded");
			const script = /<script defer src="(\/_chord\/web\/base\.[0-9a-f]+\.js)"/.exec(await page.text())?.[1];
			assert.ok(script !== undefined, "the page links its base bundle");
			const base = await fetch(`http://127.0.0.1:${server.port}${script}`, { headers: { cookie } });
			assert.equal(base.status, 200);
			assert.ok((await base.text()).length > 0);
		} finally {
			await server.stop();
		}
	});

	it("loads a third-party plugin written against the installed API alone, type-checked, tested and called", async () => {
		const dataDir = join(root, "third-party");
		const plugin = join(dataDir, "plugins", "hello");
		await mkdir(join(plugin, "test"), { recursive: true });
		for (const [name, text] of Object.entries(HELLO)) await writeFile(join(plugin, name), text);
		// The author's project resolves `@earendil-works/p3` from the install, as an npm dependency would.
		await symlink(MODULES, join(plugin, "node_modules"));
		const checked = await run(process.execPath, [TSC, "-p", plugin]).catch((error: { stdout: string }) => error);
		assert.equal(checked.stdout, "", "the plugin type-checks against the installed API");
		// The plugin's own tests, on the installed `/v1/testing`; a run of its own (`node --test` inside a test reports to
		// its parent's runner when it finds the parent's context).
		const env = { ...process.env, NODE_TEST_CONTEXT: undefined };
		const tests = ["hello.test.ts", "e2e.test.ts"].map((name) => join(plugin, "test", name));
		const tested = await run(process.execPath, ["--test", "--test-reporter=tap", ...tests], {
			cwd: plugin,
			env,
		}).catch((error: { stdout: string; stderr: string }) => assert.fail(`${error.stdout}\n${error.stderr}`));
		assert.match(tested.stdout, /# pass 2\n/);
		const server = await launch(P3, dataDir);
		try {
			const cookie = await ownerCookie(dataDir, server.port, context);
			const said = await run(process.execPath, [join(plugin, "client.mjs"), String(server.port), cookie]);
			assert.deepEqual(JSON.parse(said.stdout), ["HELLO", "HELLO, P3"]);
		} finally {
			await server.stop();
		}
	});
});

/** A third-party plugin as its author writes it, with nothing but the installed release to resolve. */
const HELLO = {
	"package.json": JSON.stringify({ name: "@someone/hello", private: true, type: "module" }),
	"tsconfig.json": JSON.stringify({
		compilerOptions: {
			strict: true,
			target: "ES2024",
			module: "NodeNext",
			moduleResolution: "NodeNext",
			allowImportingTsExtensions: true,
			noEmit: true,
			skipLibCheck: true,
			types: [],
		},
		include: ["contract.ts", "server.ts", "worker.ts"],
	}),
	"contract.ts": [
		'import { method, obj, oneOf, OwnerAdmission, remote, Server, Session, str } from "@earendil-works/p3/v1";',
		"",
		"/** A greeting the server has for its owner, plain or loud. */",
		'export const Hello = remote("hello.greeting", {',
		"	version: 1,",
		'	params: { tone: oneOf("plain", "loud") },',
		"	hostAddress: () => Server(),",
		"	admission: OwnerAdmission,",
		"	state: { text: str() },",
		"	methods: { greet: method(obj({ name: str() }), str()) },",
		"});",
		"",
		"/** The session whose worker serves it, as that worker's runtime says, for whoever the session gives anything. */",
		'export const Where = remote("hello.where", {',
		"	version: 1,",
		"	params: { session: str() },",
		"	hostAddress: ({ session }) => Session({ id: session }),",
		"	admission: obj({}),",
		"	state: { session: str() },",
		"});",
	].join("\n"),
	"server.ts": [
		'import { admitOwner, constant, defineFacet } from "@earendil-works/p3/v1";',
		'import { Hello } from "./contract.ts";',
		"",
		"export default defineFacet((host) => {",
		"	host.serve(",
		"		Hello,",
		"		({ tone }) => {",
		'			const said = (text: string): string => (tone === "loud" ? text.toUpperCase() : text);',
		'			return { text: constant(said("hello")), greet: async ({ name }) => said("hello, " + name) };',
		"		},",
		"		{ admit: admitOwner },",
		"	);",
		"});",
	].join("\n"),
	"worker.ts": [
		'import { constant, defineFacet, followSession } from "@earendil-works/p3/v1";',
		'import { WorkerRuntime } from "@earendil-works/p3/v1/worker";',
		'import { Where } from "./contract.ts";',
		"",
		"export default defineFacet((host) => {",
		"	host.serve(",
		"		Where,",
		"		(_params, _principal, _admitted, self) => ({ session: constant(self.registry(WorkerRuntime).value.session) }),",
		"		{ admit: followSession() },",
		"	);",
		"});",
	].join("\n"),
	// The plugin's own tests, as its author writes them (the release ships no tests of its own to copy): the plugin
	// tier, and end to end.
	"test/hello.test.ts": [
		'import assert from "node:assert/strict";',
		'import { it } from "node:test";',
		'import { fileURLToPath } from "node:url";',
		'import { BACKGROUND_CONTEXT as context, constant, defineFacet, OwnerAccess } from "@earendil-works/p3/v1";',
		'import { testPlugin } from "@earendil-works/p3/v1/testing";',
		'import { Hello } from "../contract.ts";',
		"",
		"/** Who the owner is, as the people plugin answers `admitOwner`: a stand-in, Olga. */",
		'const OWNER = { kind: "person", id: "o", name: "Olga" } as const;',
		"const owner = defineFacet((host) =>",
		'	host.serve(OwnerAccess, ({ caller }) => ({ owner: constant(caller === "person:o") })),',
		");",
		"",
		'it("greets the owner, loud", async () => {',
		'	const stubs = [{ name: "people", facet: owner }];',
		'	const t = await testPlugin(fileURLToPath(new URL("../", import.meta.url)), { kind: "server", stubs }, context);',
		"	try {",
		"		const said = await t.root(",
		"			async (ctx) => {",
		'				const hello = await ctx.get(Hello, { tone: "loud" });',
		'				return [hello.text.value, await hello.greet({ name: "p3" }, ctx)];',
		"			},",
		"			context,",
		"			{ principal: OWNER },",
		"		);",
		'		assert.deepEqual(said, ["HELLO", "HELLO, P3"]);',
		"		// Anyone else is denied.",
		'		const max = { kind: "person", id: "m", name: "Max" } as const;',
		"		await assert.rejects(",
		'			t.root(async (ctx) => ctx.get(Hello, { tone: "plain" }, { readyTimeout: 500 }), context, { principal: max }),',
		"		);",
		"	} finally {",
		"		await t.close(context);",
		"	}",
		"});",
	].join("\n"),
	"test/e2e.test.ts": [
		'import assert from "node:assert/strict";',
		'import { it } from "node:test";',
		'import { fileURLToPath } from "node:url";',
		'import { BACKGROUND_CONTEXT as context, Roots, SessionKind, ThisDevice, until, withGranted, Workspace } from "@earendil-works/p3/v1";',
		'import { testServer } from "@earendil-works/p3/v1/testing";',
		'import { Hello, Where } from "../contract.ts";',
		"",
		'it("greets the owner over /chord, and runs on a session\'s worker of its own", async () => {',
		'	const t = await testServer({ plugins: [fileURLToPath(new URL("../", import.meta.url))] }, context);',
		"	try {",
		"		const client = await t.client(context);",
		'		const hello = await client.get(Hello, { tone: "plain" }, context);',
		'		assert.equal(await hello.greet({ name: "p3" }, context), "hello, p3");',
		"		const device = await client.get(ThisDevice, {}, context);",
		'		const machine = await until(device.machine, (id) => id !== "", context);',
		"		const location = { environment: machine, folder: t.dataDir };",
		'		const roots = await client.get(Roots, { view: "e2e" }, context);',
		"		const [pi] = (await until(roots.list, (list) => list.rows.length > 0, context)).rows;",
		"		const workspace = await client.get(Workspace, { workspace: pi.workspace }, context);",
		'		const maker = withGranted(workspace, "make")!;',
		'		const session = await maker.make({ kind: SessionKind.name, name: "one", input: { location } }, context);',
		"		const where = await client.get(Where, { session }, context);",
		"		assert.equal(where.session.value, session);",
		'		assert.equal((await t.workers(context))[session]?.status, "running");',
		"		assert.deepEqual(t.errors, []);",
		"	} finally {",
		"		await t.close(context);",
		"	}",
		"});",
	].join("\n"),
	// The plugin's own client, outside the server: the compiled API modules run it.
	"client.mjs": [
		'import { BACKGROUND_CONTEXT as context, createHost, webSocketLink } from "@earendil-works/p3/v1";',
		'import { Hello } from "./contract.ts";',
		"",
		"const [port, cookie] = process.argv.slice(2);",
		'const socket = new WebSocket("ws://127.0.0.1:" + port + "/chord", { headers: { cookie } });',
		"const client = createHost({ readyTimeout: 5000, onError: (error) => console.error(error) });",
		'client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);',
		"await client.load([], context);",
		'const hello = await client.get(Hello, { tone: "loud" }, context);',
		'console.log(JSON.stringify([hello.text.value, await hello.greet({ name: "p3" }, context)]));',
		"await client.close(context);",
	].join("\n"),
};
