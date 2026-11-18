// The release build (`scripts/build-release.ts`) into a temporary directory: what `dist/` holds, the launcher, the API
// modules' declarations, and the build's guards, each seen to refuse. No install and no network: the installed release
// is tested by `test/release/`.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { build } from "esbuild";
import {
	type Built,
	buildRelease,
	bundleOptions,
	checkExternals,
	checkLean,
	checkPlacement,
	checkVersions,
} from "../scripts/build-release.ts";

describe("the release build", () => {
	let dir: string;
	let built: Built;
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "p3-build-"));
		built = await buildRelease(join(dir, "dist"));
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("holds one bundle per process, the launcher, and the API modules compiled with their declarations, and nothing else", () => {
		const compiled = (module: string) => [`${module}.d.ts`, `${module}.d.ts.map`, `${module}.js`];
		// No chunk: a bundle shares none with another.
		assert.deepEqual(built.files, [
			...["api/v1/index", "api/v1/server", "api/v1/worker"].flatMap(compiled),
			...["kit/contribute", "kit/forward", "kit/info"].flatMap(compiled),
			"main.js",
			"minimum-node.js",
			"p3.js",
			...compiled("principals"),
			"supervisor.js",
			"worker.js",
		]);
	});

	it("writes an executable launcher that enables the compile cache before it loads the bundle", async () => {
		const path = join(built.dist, "p3.js");
		assert.equal((await stat(path)).mode & 0o111, 0o111);
		const launcher = await readFile(path, "utf8");
		assert.ok(launcher.startsWith("#!/usr/bin/env node\n"));
		const enabled = launcher.indexOf("\nenableCompileCache();");
		assert.ok(enabled > 0 && enabled < launcher.indexOf('import("./main.js")'));
	});

	// Opus, review round 5: on Node 22.12 `p3.js` failed with "No such built-in module: node:sqlite", on Node 20 with
	// `enableCompileCache` missing: a static import is linked before the check could run.
	it("writes a launcher with no static import, which checks the Node before it loads anything else", async () => {
		const launcher = await readFile(join(built.dist, "p3.js"), "utf8");
		assert.doesNotMatch(launcher, /^\s*import[\s{*"']/m);
		assert.doesNotMatch(launcher, /^\s*export\b/m);
		const order = ['import("./minimum-node.js")', 'import("node:module")', 'import("./main.js")'].map((text) =>
			launcher.indexOf(text),
		);
		assert.ok(order[0]! > 0 && order[0]! < order[1]! && order[1]! < order[2]!, launcher);
		// The check's own bundle imports nothing either.
		const check = await readFile(join(built.dist, "minimum-node.js"), "utf8");
		assert.doesNotMatch(check, /\bimport\s*[\s{*"'(]|\bfrom\s*"/);
		assert.ok(check.includes('MINIMUM_NODE="26.3.1"') && check.includes("process.exit(1)"), check);
	});

	it("leaves no workspace package and no TypeScript for the bundles to resolve at run time", async () => {
		// An import of a workspace package or of a TypeScript file, as the bundles would still have it.
		const left = /(?:\bfrom|\bimport)\s*\(?\s*"(@earendil-works\/[^"]*|[^"]*\.ts)"/;
		for (const file of ["main.js", "worker.js", "supervisor.js", "p3.js"]) {
			const code = await readFile(join(built.dist, file), "utf8");
			assert.equal(left.exec(code)?.[1], undefined, file);
		}
	});

	// The owner, 2026-11-16 (decision "The release gets a worker-only entry"): a worker loaded the chunk it shared with
	// the server, with esbuild's JS API, `ws`, Node's HTTP and the server side of Chord's workers.
	it("gives a worker and the supervisor bundles that import and hold none of the server's code", async () => {
		// An import of the server's packages or of Node's HTTP, as a bundle would have it (minified: `from"esbuild"`).
		const server = /(?:\bfrom|\bimport\(|\brequire\()\s*"((?:node:)?https?|esbuild|ws)"/;
		for (const file of ["worker.js", "supervisor.js"]) {
			const code = await readFile(join(built.dist, file), "utf8");
			assert.equal(server.exec(code)?.[1], undefined, file);
			// `ws`'s own text, and the HTTP component's: neither is inlined.
			assert.doesNotMatch(code, /Sec-WebSocket-Accept|createHttp\b/, file);
		}
		// The server's bundle has both, so the patterns find them where they are.
		const main = await readFile(join(built.dist, "main.js"), "utf8");
		assert.ok(server.test(main) && /Sec-WebSocket-Accept/.test(main));
		const sizes = await Promise.all(
			["main.js", "worker.js"].map(async (file) => (await stat(join(built.dist, file))).size),
		);
		assert.ok(sizes[1]! < sizes[0]!, `worker.js ${sizes[1]}, main.js ${sizes[0]}`);
	});

	it("compiles the API modules for a plugin's type check: Chord imported from the dependency, relative files as JavaScript", async () => {
		const code = await readFile(join(built.dist, "api", "v1", "index.js"), "utf8");
		assert.match(code, /export \* from "@earendil-works\/chord";/);
		assert.match(code, /from "\.\.\/\.\.\/kit\/forward\.js";/);
		const declaration = await readFile(join(built.dist, "api", "v1", "server.d.ts"), "utf8");
		assert.match(declaration, /export declare const SessionRoute: import\("@earendil-works\/chord"\)\.Contract</);
		// No type is named by a path into another package's files.
		for (const file of built.files.filter((name) => name.endsWith(".d.ts"))) {
			assert.doesNotMatch(await readFile(join(built.dist, file), "utf8"), /node_modules|packages\/chord/, file);
		}
	});
});

describe("the build's guards", () => {
	/** An input importing `paths`, all left external. */
	const importing = (...paths: string[]) => ({
		inputs: {
			"src/bootstrap/bin.ts": {
				bytes: 1,
				imports: paths.map((path) => ({ path, kind: "import-statement" as const, external: true })),
			},
		},
	});

	it("refuse an import left to node_modules that the package does not ship, naming it", () => {
		checkExternals(importing("node:fs", "fs", "esbuild", "bufferutil", "utf-8-validate"));
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
			{ outputs: { "dist/main.js": output("src/bootstrap/bin.ts", "src/install.ts") } },
			"src/install.ts",
			"main.js",
		);
		const inChunk = {
			"dist/main.js": output("src/bootstrap/bin.ts"),
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
		// A chunk the worker loads lazily counts as much as its entry.
		const lazily = bundle([], []);
		const chunk = {
			bytes: 1,
			exports: [],
			imports: [],
			inputs: { "../../node_modules/ws/lib/websocket.js": { bytesInOutput: 1 } },
		};
		assert.throws(
			() => checkLean({ outputs: { ...lazily.outputs, "dist/chunks/lazy-X.js": chunk } }, "worker.js"),
			/worker\.js holds the server's .*ws\/lib\/websocket\.js/,
		);
	});

	it("refuse a dependency pinned to another version than the workspace's, which the bundle inlines", () => {
		const manifest = { version: "0.0.1", dependencies: { "@earendil-works/chord": "1.5.2", esbuild: "0.28.2" } };
		checkVersions(manifest, { "@earendil-works/chord": "1.5.2", esbuild: "0.28.2" });
		assert.throws(
			() => checkVersions(manifest, { "@earendil-works/chord": "1.5.3", esbuild: "0.28.2" }),
			/@earendil-works\/chord is pinned to 1\.5\.2, the workspace has 1\.5\.3$/,
		);
	});
});
