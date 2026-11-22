// The release build's guards (`scripts/build-release.ts`), each seen to refuse, and its bundle options keeping what an
// entry imports lazily out of the entry. The whole build into `dist/`, installed, is tested by `test/release/`.

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
