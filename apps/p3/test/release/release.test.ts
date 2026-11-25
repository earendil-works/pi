// The installed release: p3 as `npm run release:p3:local` built, packed and installed it outside the repository.
// `P3_RELEASE` names the install directory; the release script sets it. Not part of `npm test`: it needs that install.
// It checks what the package holds, the command, a session's worker forked from the release's own bundle, and a
// third-party plugin written against nothing but the installed API: type-checked, loaded from the Pi's user root, and
// called by a client that uses the compiled API modules.

import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHost, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { P3Principal } from "@earendil-works/p3/v1";
import { Sessions, SessionWorker } from "../../plugins/sessions/contract.ts";
import { eventually } from "../support.ts";

const run = promisify(execFile);

const { P3_RELEASE } = process.env;
if (P3_RELEASE === undefined) throw new Error("release.test.ts: set P3_RELEASE to the install directory");

/** The install's node_modules and the installed package. */
const MODULES = join(P3_RELEASE, "node_modules");
const PACKAGE = join(MODULES, "@earendil-works", "p3");

/** The installed command. */
const P3 = [process.execPath, join(PACKAGE, "dist", "p3.js")];

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
		for (const module of ["index", "server", "worker"]) {
			await readFile(join(PACKAGE, "dist", "src", "api", "v1", `${module}.d.ts`));
		}
		const plugins = await readdir(join(PACKAGE, "plugins"), { recursive: true });
		assert.deepEqual(
			plugins.filter((path) => /\.(test\.ts|js|d\.ts|map)$/.test(path)),
			[],
			"plugins ship as source only, no tests",
		);
		for (const plugin of ["control", "runner", "sessions", "sign-in"]) assert.ok(plugins.includes(plugin), plugin);
	});

	it("starts in the background, says it runs, and stops", async () => {
		const home = join(root, "home");
		await mkdir(home);
		const p3 = (...args: string[]) => run(P3[0]!, [...P3.slice(1), ...args], { env: { ...process.env, HOME: home } });
		const started = await p3("--port", "0");
		assert.match(started.stdout, /port \d+\. Open http:\/\/127\.0\.0\.1:\d+\/_p3\/owner#/);
		assert.match((await p3("status")).stdout, /running/);
		assert.equal((await p3("stop")).stdout.trim(), "stopped");
	});

	it("forks a session's worker from the release's own worker bundle", async () => {
		const server = await launch(join(root, "workers"));
		try {
			const client = await ownerClient(server.dataDir, server.port);
			const id = await (await client.get(Sessions, {}, context)).create({ title: "one" }, context);
			const worker = await client.get(SessionWorker, { session: id }, context);
			assert.equal(worker.state.value.kind, "live");
			// Besides the worker, the server has esbuild's service as a child (it builds the plugins).
			const commands = await eventually(
				async () =>
					Promise.all((await childrenOf(server.pid)).map((pid) => readFile(`/proc/${pid}/cmdline`, "utf8"))),
				(found) => found.some((command) => command.includes("worker")),
			);
			const workers = commands
				.map((command) => command.split("\0"))
				.filter((args) => args.some((arg) => arg.includes("worker")));
			assert.equal(workers.length, 1, commands.join("\n"));
			assert.ok(workers[0]!.includes(join(PACKAGE, "dist", "worker.js")), workers[0]!.join(" "));
			await client.close(context);
		} finally {
			await server.stop();
		}
	});

	it("loads a third-party plugin written against the installed API alone, type-checked and called", async () => {
		const dataDir = join(root, "third-party");
		const plugin = join(dataDir, "plugins", "hello");
		await mkdir(plugin, { recursive: true });
		for (const [name, text] of Object.entries(HELLO)) await writeFile(join(plugin, name), text);
		// The author's project resolves `@earendil-works/p3` from the install, as an npm dependency would.
		await symlink(MODULES, join(plugin, "node_modules"));
		const checked = await run(process.execPath, [TSC, "-p", plugin]).catch((error: { stdout: string }) => error);
		assert.equal(checked.stdout, "", "the plugin type-checks against the installed API");
		const server = await launch(dataDir);
		try {
			const token = (await readFile(join(dataDir, "owner-token"), "utf8")).trim();
			const said = await run(process.execPath, [join(plugin, "client.mjs"), String(server.port), token]);
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
		include: ["contract.ts", "server.ts"],
	}),
	"contract.ts": [
		'import { method, obj, oneOf, remote, Server, str } from "@earendil-works/p3/v1";',
		"",
		"/** A greeting the server has for its owner, plain or loud. */",
		'export const Hello = remote("hello.greeting", {',
		"	version: 1,",
		'	params: { tone: oneOf("plain", "loud") },',
		"	hostAddress: () => Server(),",
		"	state: { text: str() },",
		"	methods: { greet: method(obj({ name: str() }), str()) },",
		"});",
	].join("\n"),
	"server.ts": [
		'import { constant, defineFacet, forbidden } from "@earendil-works/p3/v1";',
		'import { Hello } from "./contract.ts";',
		"",
		"export default defineFacet((host) => {",
		"	host.serve(Hello, ({ tone }, principal) => {",
		'		if (principal.kind !== "owner") throw forbidden("hello: the owner\'s");',
		'		const said = (text: string): string => (tone === "loud" ? text.toUpperCase() : text);',
		'		return { text: constant(said("hello")), greet: async ({ name }) => said("hello, " + name) };',
		"	});",
		"});",
	].join("\n"),
	// The plugin's own client, outside the server: the compiled API modules run it.
	"client.mjs": [
		'import { BACKGROUND_CONTEXT as context, createHost, webSocketLink } from "@earendil-works/p3/v1";',
		'import { Hello } from "./contract.ts";',
		"",
		"const [port, token] = process.argv.slice(2);",
		'const socket = new WebSocket("ws://127.0.0.1:" + port + "/chord", { headers: { authorization: "Bearer " + token } });',
		"const client = createHost({ readyTimeout: 5000, onError: (error) => console.error(error) });",
		'client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);',
		"await client.load([], context);",
		'const hello = await client.get(Hello, { tone: "loud" }, context);',
		'console.log(JSON.stringify([hello.text.value, await hello.greet({ name: "p3" }, context)]));',
		"await client.close(context);",
	].join("\n"),
};

/** The installed release's server in the foreground on `dataDir`, on a free port, once it listens. */
async function launch(dataDir: string) {
	const child = spawn(P3[0]!, [...P3.slice(1), "server", "--dir", dataDir, "--port", "0"], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const port = await new Promise<number>((resolve, reject) => {
		let out = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			const found = /port (\d+)\. Open/.exec(out);
			if (found !== null) resolve(Number(found[1]));
		});
		child.once("exit", (code) => reject(new Error(`p3 server exited with ${code}`)));
	});
	return { pid: child.pid!, port, dataDir, stop: () => stop(child) };
}

/** Stops `child` with `SIGTERM` and waits for its exit. */
async function stop(child: ChildProcess): Promise<void> {
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await exited;
}

/** A client of the server on `port`, signed in as the owner with the owner token file. */
async function ownerClient(dataDir: string, port: number) {
	const token = (await readFile(join(dataDir, "owner-token"), "utf8")).trim();
	// Node's WebSocket (undici) takes an init object with headers; the DOM type knows only protocols.
	const init = { headers: { authorization: `Bearer ${token}` } } as unknown as string[];
	const client = createHost<P3Principal>({ readyTimeout: 30_000, onError: (error) => console.error(error) });
	const socket = new WebSocket(`ws://127.0.0.1:${port}/chord`, init);
	client.connect(webSocketLink(socket), { principal: { kind: "server" } }, context);
	await client.load([], context);
	return client;
}

/** The children of `pid` (`/proc/*\/stat`; Android has no `children` file). */
async function childrenOf(pid: number): Promise<number[]> {
	const children: number[] = [];
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => "");
		if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === pid) children.push(Number(entry));
	}
	return children;
}
