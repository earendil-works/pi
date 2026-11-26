// The release build's guards (`scripts/build-release.ts`), each seen to refuse, and its bundle options keeping what an
// entry imports lazily out of the entry. The whole build into `dist/`, installed, is tested by `test/release/`.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { bundleOptions, checkExternals, checkLean, checkPlacement, checkVersions } from "../scripts/build-release.ts";

describe("the build's guards", () => {
	/** An input importing `paths`, all left external. */
	const importing = (...paths: string[]) => ({
		inputs: {
			"src/bin.ts": {
				bytes: 1,
				imports: paths.map((path) => ({ path, kind: "import-statement" as const, external: true })),
			},
		},
	});

	it("refuse an import left to node_modules that the package does not ship, naming it", () => {
		checkExternals(importing("node:fs", "fs", "esbuild", "bufferutil", "utf-8-validate", "kerberos"));
		assert.throws(
			() => checkExternals(importing("node:fs", "left-pad", "ws", "left-pad")),
			/the bundle left unexpected external imports: left-pad, ws$/,
		);
	});

	it("refuse `src/install.ts` anywhere but in `main.js` alone: it finds p3's files from its own place", () => {
		const output = (...inputs: string[]) => ({
			bytes: 1,
			imports: [],
			exports: [],
			inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 1 }])),
		});
		checkPlacement(
			{ outputs: { "dist/main.js": output("src/bin.ts", "src/install.ts") } },
			"src/install.ts",
			"main.js",
		);
		const inChunk = {
			"dist/main.js": output("src/bin.ts"),
			"dist/chunks/chunk-A.js": output("src/install.ts"),
		};
		assert.throws(
			() => checkPlacement({ outputs: inChunk }, "src/install.ts", "main.js"),
			/src\/install\.ts must be bundled into main\.js, found in dist\/chunks\/chunk-A\.js$/,
		);
		const inBoth = { "dist/main.js": output("src/install.ts"), "dist/worker.js": output("src/install.ts") };
		assert.throws(
			() => checkPlacement({ outputs: inBoth }, "src/install.ts", "main.js"),
			/found in dist\/main\.js, /,
		);
		assert.throws(() => checkPlacement({ outputs: {} }, "src/install.ts", "main.js"), /found in no output$/);
		// Not a file that merely ends the same.
		const similar = { "dist/not-main.js": output("src/install.ts") };
		assert.throws(() => checkPlacement({ outputs: similar }, "src/install.ts", "main.js"), /found in dist\/not-main/);
	});

	// The owner, 2026-11-16 (the worker-only entry with splitting kept): one build per process, and inside it what an
	// entry imports lazily stays a chunk of its own, not loaded at the process's start.
	// Astra, review of the provider logins (round 1): pi-ai imports its OAuth flows and Bedrock through a variable
	// specifier unless the API registers them, and a bundle cannot follow it: the first sign-in or refresh failed with
	// ERR_MODULE_NOT_FOUND.
	it("bundle pi-ai's providers so their OAuth flows and Bedrock's SDK load on first use", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-providers-"));
		try {
			const api = (module: string) => fileURLToPath(new URL(`../src/api/v1/${module}.ts`, import.meta.url));
			const entry = [
				`import { builtinProviders } from ${JSON.stringify(api("server"))};`,
				`import { loadProvider } from ${JSON.stringify(api("worker"))};`,
				'const oauth = builtinProviders().find(({ id }) => id === "anthropic").auth.oauth;',
				'const auth = await oauth.toAuth({ type: "oauth", access: "a-token", refresh: "r", expires: 0 });',
				'const bedrock = await loadProvider("amazon-bedrock");',
				// Bedrock's SDK calls onPayload before it sends anything: offline, its request code ran.
				"const message = { role: 'user', content: 'x', timestamp: 0 };",
				"const sent = await bedrock.streamSimple(bedrock.getModels()[0], { messages: [message] },",
				"\t{ apiKey: 'synthetic', onPayload: () => { throw new Error('offline: nothing sent'); } }).result();",
				"console.log(JSON.stringify({ auth, bedrock: sent.errorMessage }));",
			];
			await writeFile(join(dir, "entry.ts"), entry.join("\n"));
			const dist = join(dir, "dist");
			await build({ ...bundleOptions(dist), entryPoints: { entry: join(dir, "entry.ts") } });
			const { stdout } = await promisify(execFile)(process.execPath, [join(dist, "entry.js")]);
			const shown = JSON.parse(stdout.trim().split("\n").at(-1)!) as { auth: object; bedrock: string };
			assert.match(shown.bedrock, /offline: nothing sent/);
			assert.ok(JSON.stringify(shown.auth).includes("a-token"), stdout);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("keep what an entry imports lazily in a chunk of its own, out of the entry", async () => {
		const dir = await mkdtemp(join(tmpdir(), "p3-split-"));
		try {
			await writeFile(join(dir, "eager.ts"), 'export const eager = "the eager module";\n');
			await writeFile(join(dir, "lazy.ts"), 'export const lazy = "the lazy module";\n');
			const entry = ['import { eager } from "./eager.ts";', 'console.log(eager, (await import("./lazy.ts")).lazy);'];
			await writeFile(join(dir, "entry.ts"), entry.join("\n"));
			const dist = join(dir, "dist");
			await build({ ...bundleOptions(dist), entryPoints: { entry: join(dir, "entry.ts") } });
			const main = await readFile(join(dist, "entry.js"), "utf8");
			const chunks = await readdir(join(dist, "chunks"));
			assert.equal(chunks.length, 1);
			const chunk = await readFile(join(dist, "chunks", chunks[0]!), "utf8");
			assert.deepEqual(
				[main.includes("the eager module"), main.includes("the lazy module"), chunk.includes("the lazy module")],
				[true, false, true],
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuse a worker's or the supervisor's bundle that imports or holds the server's code, naming it", () => {
		const bundle = (imports: string[], inputs: string[]) => ({
			outputs: {
				"dist/worker.js": {
					bytes: 1,
					exports: [],
					imports: imports.map((path) => ({ path, kind: "import-statement" as const, external: true })),
					inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 1 }])),
				},
			},
		});
		const chord = "../../packages/chord/src";
		checkLean(
			bundle(["node:fs", "node:net"], [`${chord}/host/host.ts`, `${chord}/node/http/router.ts`]),
			"worker.js",
		);
		for (const [imports, inputs, named] of [
			[["esbuild"], [], "esbuild"],
			[["node:http"], [], "node:http"],
			[["https"], [], "https"],
			[[], ["../../node_modules/ws/lib/websocket.js"], "ws/lib/websocket.js"],
			[[], [`${chord}/node/http/http.ts`], "http/http.ts"],
			[[], [`${chord}/node/workers/workers.ts`], "workers/workers.ts"],
			[[], [`${chord}/node/workers/base.ts`], "workers/base.ts"],
			[[], [`${chord}/node/plugins/build.ts`], "plugins/build.ts"],
		] as const) {
			assert.throws(
				() => checkLean(bundle([...imports], [...inputs]), "worker.js"),
				new RegExp(`worker\\.js holds the server's .*${named.replace(/[.]/g, "\\.")}`),
			);
		}
		assert.throws(() => checkLean(bundle([], []), "supervisor.js"), /no output supervisor\.js/);
		// A chunk the worker loads lazily may hold Node's HTTP and `ws` (a provider SDK's, loaded on its first request);
		// imported statically it counts as much as its entry; the server's own code counts in any chunk.
		const withChunk = (kind: "import-statement" | "dynamic-import", inputs: string[]) => ({
			outputs: {
				"dist/worker.js": {
					bytes: 1,
					exports: [],
					imports: [{ path: "dist/chunks/sdk-X.js", kind }],
					inputs: {},
				},
				"dist/chunks/sdk-X.js": {
					bytes: 1,
					exports: [],
					imports: [{ path: "node:https", kind: "import-statement" as const, external: true }],
					inputs: Object.fromEntries(inputs.map((input) => [input, { bytesInOutput: 1 }])),
				},
			},
		});
		checkLean(withChunk("dynamic-import", ["../../node_modules/ws/lib/websocket.js"]), "worker.js");
		assert.throws(
			() => checkLean(withChunk("import-statement", ["../../node_modules/ws/lib/websocket.js"]), "worker.js"),
			/worker\.js holds the server's .*ws\/lib\/websocket\.js, node:https/,
		);
		assert.throws(
			() => checkLean(withChunk("dynamic-import", [`${chord}/node/http/http.ts`]), "worker.js"),
			/worker\.js holds the server's .*http\/http\.ts/,
		);
	});

	it("refuse a dependency pinned to another version than the workspace's, which the bundle inlines", () => {
		const manifest = { version: "0.0.1", dependencies: { "@earendil-works/chord": "1.5.2", esbuild: "0.28.2" } };
		checkVersions(manifest, { "@earendil-works/chord": "1.5.2" });
		assert.throws(
			() => checkVersions(manifest, { "@earendil-works/chord": "1.5.3" }),
			/@earendil-works\/chord is pinned to 1\.5\.2, the workspace has 1\.5\.3$/,
		);
	});

	it("check only workspace packages: a registry dependency is installed as pinned, whatever the root holds", () => {
		const manifest = { version: "0.0.1", dependencies: { "@earendil-works/chord": "1.5.2", react: "19.3.0" } };
		checkVersions(manifest, { "@earendil-works/chord": "1.5.2" });
	});
});
