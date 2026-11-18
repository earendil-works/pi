// The installed release (`docs/slices/26-release.md`): p3 as `npm run release:p3:local` built, packed and installed it
// outside the repository. `P3_RELEASE` names the install directory; the release script sets it. Not part of
// `npm test`: it needs that install.

import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Sessions, SessionWorker } from "../../plugins/sessions/contract.ts";
import { ownerClient } from "../client.ts";
import { CASES, cli } from "../commands.ts";
import { endToEnd } from "../end-to-end.ts";
import { launch, type Ran, releaseOf, run } from "../launched.ts";

const { P3_RELEASE } = process.env;
if (P3_RELEASE === undefined)
	throw new Error("release.test.ts: set P3_RELEASE to the install directory (npm run release:p3:local)");

/** The install directory: its `node_modules` holds the release. */
const INSTALL: string = P3_RELEASE;

/** The installed package, and the packages it depends on. */
const PACKAGE = join(INSTALL, "node_modules", "@earendil-works", "p3");
const DEPENDENCIES = [
	"@earendil-works/chord",
	"@earendil-works/pi-schema",
	"@earendil-works/pi-telemetry",
	"esbuild",
	"ws",
];

/** The repository, and its TypeScript: a plugin author's own would do the same. */
const REPOSITORY = fileURLToPath(new URL("../../../../", import.meta.url));
const TSC = join(REPOSITORY, "node_modules", "typescript", "bin", "tsc");

/** How long a case may take: a command, a server or a worker that hangs fails its case instead of the run. */
const CASE_MS = 120_000;

/** A directory of test `t`'s own under the system's temporary directory (outside the repository), removed after it. */
async function tempDir(t: TestContext): Promise<string> {
	const dir = await realpath(await mkdtemp(join(tmpdir(), "p3-release-")));
	t.after(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** The JSON in the file `path`. */
async function json<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

/** What the tests read of a `package.json`. */
type Manifest = {
	readonly name: string;
	readonly version: string;
	readonly private?: boolean;
	readonly bin: Readonly<Record<string, string>>;
	readonly dependencies: Readonly<Record<string, string>>;
	readonly exports: Readonly<Record<string, { readonly types: string; readonly import: string }>>;
};

describe("the installed release", { concurrency: true, timeout: CASE_MS }, () => {
	it("is outside the repository and resolves nothing from it: p3, its dependencies at the pinned versions, real directories", async () => {
		assert.ok(relative(REPOSITORY, INSTALL).startsWith(`..${sep}`), "the install is inside the repository");
		const installed = (await readdir(join(INSTALL, "node_modules"))).filter((name) => !name.startsWith("."));
		assert.deepEqual(installed.sort(), ["@earendil-works", "@esbuild", "esbuild", "ws"]);
		const scoped = await readdir(join(INSTALL, "node_modules", "@earendil-works"));
		assert.deepEqual(scoped.sort(), ["chord", "p3", "pi-schema", "pi-telemetry"]);
		const manifest = await json<Manifest>(join(PACKAGE, "package.json"));
		assert.deepEqual(
			[manifest.name, manifest.bin, manifest.private],
			["@earendil-works/p3", { p3: "dist/p3.js" }, true],
		);
		assert.deepEqual(Object.keys(manifest.dependencies).sort(), DEPENDENCIES);
		for (const name of DEPENDENCIES) {
			// Exactly the pinned version: the bundle inlines the same Chord the types come from.
			const dependency = await json<Manifest>(join(INSTALL, "node_modules", name, "package.json"));
			assert.equal(manifest.dependencies[name], dependency.version, name);
			// No link out of the install: every package is a real directory in it.
			assert.ok((await realpath(join(INSTALL, "node_modules", name))).startsWith(`${INSTALL}${sep}`), name);
		}
	});

	it("ships the bundles, the plugins as source without tests, and the API as JavaScript, declarations and source", async () => {
		const files = (await readdir(PACKAGE, { recursive: true, withFileTypes: true }))
			.filter((file) => file.isFile())
			.map((file) => relative(PACKAGE, join(file.parentPath, file.name)));
		const source = files.filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts")).sort();
		assert.deepEqual(source, [
			"plugins/sessions/contract.server.ts",
			"plugins/sessions/contract.ts",
			"plugins/sessions/server.ts",
			"plugins/sessions/worker.ts",
			"src/api/v1/index.ts",
			"src/api/v1/server.ts",
			"src/api/v1/worker.ts",
			"src/kit/contribute.ts",
			"src/kit/forward.ts",
			"src/kit/info.ts",
			"src/principals.ts",
		]);
		const { exports } = await json<Manifest>(join(PACKAGE, "package.json"));
		assert.deepEqual(Object.keys(exports), ["./v1", "./v1/server", "./v1/worker"]);
		for (const target of Object.values(exports).flatMap((entry) => [entry.types, entry.import])) {
			assert.ok(files.includes(target.replace(/^\.\//, "")), target);
		}
		// "Go to definition" has a target: every declaration map names a source file that is in the install.
		const maps = files.filter((file) => file.endsWith(".d.ts.map"));
		assert.equal(maps.length, 7);
		for (const map of maps) {
			const { sources } = await json<{ sources: string[] }>(join(PACKAGE, map));
			const named = sources.map((source) => relative(PACKAGE, resolve(PACKAGE, dirname(map), source)));
			assert.ok(named.length === 1 && source.includes(named[0]!), `${map}: ${named}`);
		}
	});

	it("answers --version and --help through the installed command, without a warning", async (t) => {
		const p3 = [join(INSTALL, "node_modules", ".bin", "p3")];
		const cwd = await tempDir(t);
		const manifest = await json<Manifest>(join(PACKAGE, "package.json"));
		assert.deepEqual(await run(p3, ["--version"], { cwd }), { code: 0, stdout: `${manifest.version}\n`, stderr: "" });
		const help = await run(p3, ["--help"], { cwd });
		assert.match(help.stdout, /^Usage: p3 \[command\]/);
		assert.deepEqual([help.code, help.stderr], [0, ""]);
	});

	it("drops only experimental warnings: every other warning goes Node's way, to its printer, its flags and other listeners", async (t) => {
		const dir = await tempDir(t);
		// A listener of someone else's, and three warnings emitted after the launcher ran.
		const preload = join(dir, "preload.mjs");
		const emitted = [
			'process.on("warning", (warning) => console.error("heard", warning.name));',
			'process.once("beforeExit", () => {',
			'	process.emitWarning("an ordinary one", { type: "Warning", code: "P3_TEST" });',
			'	process.emitWarning("a deprecation", "DeprecationWarning", "P3_DEP");',
			'	process.emitWarning("an experiment", { type: "ExperimentalWarning" });',
			'	process.emitWarning("another experiment", "ExperimentalWarning");',
			"});",
		];
		await writeFile(preload, emitted.join("\n"));
		const p3 = (...flags: string[]): Promise<Ran> =>
			run([process.execPath, ...flags, `--import=${preload}`, ...releaseOf(INSTALL).slice(1)], ["--version"], {
				cwd: dir,
			});
		const lines = (text: string) =>
			text
				.replace(/\(node:\d+\) /g, "")
				.split("\n")
				.filter(Boolean);
		const printed = ["[P3_TEST] Warning: an ordinary one", "[P3_DEP] DeprecationWarning: a deprecation"];
		const hint = "(Use `node --trace-warnings ...` to show where the warning was created)";
		const heard = ["heard Warning", "heard DeprecationWarning"];
		assert.deepEqual(lines((await p3()).stderr).sort(), [...printed, hint, ...heard].sort());
		assert.deepEqual(lines((await p3("--no-warnings")).stderr), heard);
		const redirected = await p3(`--redirect-warnings=${join(dir, "warnings.log")}`);
		assert.deepEqual(lines(redirected.stderr), heard);
		assert.deepEqual(lines(await readFile(join(dir, "warnings.log"), "utf8")), [printed[0], hint, printed[1]]);
	});

	it("runs the end-to-end case: launched outside the repository, a forked worker, a restart", async (t) => {
		const cwd = await tempDir(t);
		const start = async (dataDir: string) => {
			const launched = await launch(releaseOf(INSTALL), dataDir, { cwd });
			return {
				...launched,
				workers: async () => (await launched.workers()).length,
				close: async () => {
					await launched.close();
					// Neither the server nor a worker printed a warning or an error.
					assert.equal(launched.stderr(), "");
				},
			};
		};
		await endToEnd(start, join(cwd, "data"));
	});

	it("closes on SIGTERM: its worker is gone and the data directory is free at once", async (t) => {
		const cwd = await tempDir(t);
		const launched = await launch(releaseOf(INSTALL), join(cwd, "data"), { cwd });
		// A case that failed half way leaves the server running: its process would keep the test runner alive.
		t.after(() => launched.close("SIGKILL"));
		const client = await ownerClient(launched, context);
		const sessions = await client.get(Sessions, {}, context);
		await client.get(SessionWorker, { session: await sessions.create({}, context) }, context);
		const workers = await launched.workers();
		assert.equal(workers.length, 1);
		// It runs with the V8 flags for its memory (owner, 2026-11-16; the memory reducer's delay and the zones 2026-11-18).
		const argv = (await readFile(`/proc/${workers[0]}/cmdline`, "utf8")).split("\0");
		// Named here, not read from `WORKER_V8_FLAGS`: a mutation that drops one there would drop it here too.
		const flags = [
			"--liftoff-only",
			"--optimize-for-size",
			"--max-semi-space-size=4",
			"--gc-memory-reducer-start-delay-ms=8000",
		];
		for (const flag of flags) {
			assert.ok(argv.includes(flag), `${flag}: ${argv.join(" ")}`);
		}
		// V8's managed zone memory on Node 26 only: Node 24's V8 would refuse to start with it.
		const zones = Number(process.versions.node.split(".")[0]) >= 26;
		assert.equal(argv.includes("--managed-zone-memory"), zones, argv.join(" "));
		await launched.close("SIGTERM");
		await client.close(context);
		await assert.rejects(stat(`/proc/${launched.pid}`));
		await assert.rejects(stat(`/proc/${workers[0]}`));
		const again = await launch(releaseOf(INSTALL), join(cwd, "data"), { cwd });
		t.after(() => again.close("SIGKILL"));
		await again.close();
	});

	for (const [name, command] of Object.entries(CASES)) {
		it(`the command: ${name}`, async (t) => command(await cli(releaseOf(INSTALL), t)));
	}
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
			declaration: true,
			noEmit: true,
			skipLibCheck: true,
			// Nothing but the release: no `@types/node` either, the plugin uses none of Node's.
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
		"	variants: { owner: { state: { text: str() }, methods: { greet: method(obj({ name: str() }), str()) } } },",
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
		"		return {",
		'			variant: "owner",',
		'			members: { text: constant(said("hello")), greet: async ({ name }) => said("hello, " + name) },',
		"		};",
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

describe("a third-party plugin against the installed release", { timeout: CASE_MS }, () => {
	/** The plugin in a directory of its own whose `node_modules` is the install's. */
	async function hello(t: TestContext, files: Readonly<Record<string, string>> = HELLO): Promise<string> {
		const dir = join(await tempDir(t), "hello");
		await mkdir(dir);
		for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
		await symlink(join(INSTALL, "node_modules"), join(dir, "node_modules"));
		return dir;
	}

	/** Runs the TypeScript compiler on the project in `dir`. */
	const tsc = (dir: string, ...flags: string[]): Promise<Ran> =>
		run([process.execPath, TSC], ["-p", dir, ...flags], { cwd: dir });

	it("type-checks under `strict`, and its contract's declaration names every type through the release", async (t) => {
		const dir = await hello(t);
		assert.deepEqual(await tsc(dir), { code: 0, stdout: "", stderr: "" });
		const emitted = await tsc(dir, "--noEmit", "false", "--emitDeclarationOnly", "--outDir", join(dir, "types"));
		assert.deepEqual(emitted, { code: 0, stdout: "", stderr: "" });
		const declaration = await readFile(join(dir, "types", "contract.d.ts"), "utf8");
		// The contract's whole type is there, written with imports a consumer of the plugin resolves.
		assert.match(declaration, /readonly greet: import\("@earendil-works\/[^"]+"\)\.Method</);
		assert.match(declaration, /\.LiteralsSchema<"loud" \| "plain">/);
		assert.doesNotMatch(declaration, /node_modules|\bany\b/);
	});

	// Chord's `serve` is overloaded, so TypeScript reports a factory that does not fit at the call.
	it("fails the type check for a member of the wrong type, and for a method answering another type", async (t) => {
		const wrong = HELLO["server.ts"].replace('text: constant(said("hello"))', "text: constant(1)");
		assert.notEqual(wrong, HELLO["server.ts"]);
		const checked = await tsc(await hello(t, { ...HELLO, "server.ts": wrong }));
		assert.equal(checked.code, 1);
		assert.match(checked.stdout, /^server\.ts\(5,\d+\): error TS2769: No overload matches this call\./);
		const unanswered = HELLO["server.ts"].replace('said("hello, " + name)', "name.length");
		assert.notEqual(unanswered, HELLO["server.ts"]);
		const refused = await tsc(await hello(t, { ...HELLO, "server.ts": unanswered }));
		assert.equal(refused.code, 1);
		assert.match(refused.stdout, /^server\.ts\(5,\d+\): error TS2769: /);
	});

	// Sol, review round 2: `/v1/server` failed to import outside the server (Chord's HTTP module needs `ws`, which p3
	// did not depend on); the plugin's own client only imported `/v1`.
	it("imports the three API modules at run time, as a plugin's own tests outside the server do", async (t) => {
		const dir = await hello(t);
		const script = [
			'const v1 = await import("@earendil-works/p3/v1");',
			'const server = await import("@earendil-works/p3/v1/server");',
			'const worker = await import("@earendil-works/p3/v1/worker");',
			"const names = (module, ...names) => names.map((name) => typeof module[name]);",
			'console.log(JSON.stringify([names(v1, "defineFacet", "Server", "Session", "forward", "remote"),',
			'	names(server, "Http", "SessionRoute", "AppInfo"), names(worker, "WorkerInfo")]));',
		].join("\n");
		await writeFile(join(dir, "imports.mjs"), script);
		// As the plugin's client: Node's own warning about `node:sqlite` is not the module's.
		const node = [process.execPath, "--disable-warning=ExperimentalWarning"];
		const imported = await run([...node, join(dir, "imports.mjs")], [], { cwd: dir });
		const kinds = [
			["function", "function", "function", "function", "function"],
			["object", "object", "object"],
			["object"],
		];
		assert.deepEqual(imported, { code: 0, stdout: `${JSON.stringify(kinds)}\n`, stderr: "" });
	});

	it("loads from the installed server's plugins root and serves its object to a client", async (t) => {
		// A copy of the install, so the one the release script made stays as it was packed.
		const install = join(await tempDir(t), "install");
		await cp(INSTALL, install, { recursive: true, verbatimSymlinks: true });
		const root = join(install, "node_modules", "@earendil-works", "p3", "plugins", "hello");
		await mkdir(root);
		for (const name of ["package.json", "contract.ts", "server.ts"] as const) {
			await writeFile(join(root, name), HELLO[name]);
		}
		const dir = await hello(t);
		const launched = await launch(releaseOf(install), join(dirname(install), "data"), { cwd: dirname(install) });
		t.after(() => launched.close());
		const token = (await readFile(launched.ownerTokenFile, "utf8")).trim();
		const port = new URL(launched.ownerLink()).port;
		const client = [process.execPath, "--disable-warning=ExperimentalWarning", join(dir, "client.mjs")];
		const answered = await run(client, [port, token], { cwd: dir });
		assert.deepEqual(answered, { code: 0, stdout: '["HELLO","HELLO, P3"]\n', stderr: "" });
		assert.equal(launched.stderr(), "");
	});
});
