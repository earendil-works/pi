// Tests of the watcher (slice 7c §5): dirty marks from the files facets used and from plugin directories, `install`,
// `set`, `base`, a change during a build keeping its mark, `node_modules` and `.git` ignored, real file events, and the
// marks as a JSON watchable.

import { readdirSync, readFileSync } from "node:fs";
import { realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { Batch } from "../../../src/next/state/internal.ts";
import { type BuiltFacet, discoverPlugins } from "../../../src/next-node/plugins/index.ts";
import { PluginWatcher } from "../../../src/next-node/plugins/watcher.ts";
import { changesOf, delivered } from "../../next/support.ts";
import { KINDS, tempRoot, writeFiles, writePlugin } from "./support.ts";

/** A root with plugins `a` (worker), `b` (server) and the contracts fixture, a base directory, and a watcher of both. */
async function watched() {
	const root = await realpath(await tempRoot(["contracts"]));
	const base = await realpath(await tempRoot());
	await writePlugin(root, "a", "@test/a", { "worker.ts": "", "own.ts": "" });
	await writePlugin(root, "b", "@test/b", { "server.ts": "" });
	const failures: unknown[] = [];
	const watcher = new PluginWatcher(
		{ roots: [root], base: [base], kinds: KINDS, failed: (error) => failures.push(error) },
		new Batch(() => {}, undefined),
	);
	const discovery = await discoverPlugins([root], { kinds: KINDS }, context);
	watcher.know(discovery, watcher.discoverySnapshot());
	const contract = join(root, "contracts", "contract.ts");
	const used = (plugin: string, facet: string, files: readonly string[]): BuiltFacet => ({
		kind: "script",
		plugin,
		facet,
		source: "",
		digest: "",
		inputs: files.map((file) => ({ file, hash: "" })),
		copied: [contract],
		assets: [],
	});
	watcher.used([
		used("@test/a", "worker", [join(root, "a", "worker.ts"), contract]),
		used("@test/b", "server", [join(root, "b", "server.ts"), contract]),
	]);
	return { root, base, watcher, failures };
}

describe("the watcher's marks", () => {
	it("dirties every plugin whose facets used a changed file, and the plugin whose directory contains it", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "contracts", "contract.ts"));
		expect(watcher.value).toEqual({
			dirty: ["@test/a", "@test/b", "@test/contracts"],
			install: [],
			set: false,
			base: false,
		});
		watcher.close();
	});

	it("dirties the plugin of a file no facet read yet; asks for an install for a package.json", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "a", "new.ts"));
		watcher.mark(join(root, "b", "package.json"));
		expect(watcher.value).toEqual({ dirty: ["@test/a"], install: ["@test/b"], set: false, base: false });
		// Installed: the mark clears, and the plugin is dirty (its packages changed).
		watcher.installed("@test/b");
		expect(watcher.value).toEqual({ dirty: ["@test/a", "@test/b"], install: [], set: false, base: false });
		watcher.close();
	});

	it("asks for discovery for a directory under a root and a facet file at a plugin's top; base for base code", async () => {
		const { root, base, watcher } = await watched();
		watcher.mark(join(root, "c"));
		expect(watcher.value).toMatchObject({ set: true, dirty: [] });
		const seen = watcher.discoverySnapshot();
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		expect(watcher.value).toMatchObject({ set: false });
		watcher.mark(join(root, "b", "web.tsx"));
		expect(watcher.value).toMatchObject({ set: true, dirty: ["@test/b"] });
		watcher.mark(join(base, "core.ts"));
		expect(watcher.value).toMatchObject({ base: true });
		watcher.close();
	});

	it("ignores node_modules and .git", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "a", "node_modules", "x", "index.js"));
		watcher.mark(join(root, "a", ".git", "HEAD"));
		expect(watcher.value).toEqual({ dirty: [], install: [], set: false, base: false });
		watcher.close();
	});

	it("keeps the mark of a change during a build: only an unchanged mark clears when applied", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "a", "own.ts"));
		const snapshot = watcher.snapshot(["@test/a"]);
		// Saved again while the build runs.
		watcher.mark(join(root, "a", "own.ts"));
		watcher.applied(["@test/a"], snapshot);
		expect(watcher.value).toMatchObject({ dirty: ["@test/a"] });
		watcher.applied(["@test/a"], watcher.snapshot(["@test/a"]));
		expect(watcher.value).toMatchObject({ dirty: [] });
		// A discovery that started before a change of the set keeps `set`.
		const seen = watcher.discoverySnapshot();
		watcher.mark(join(root, "d"));
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		expect(watcher.value).toMatchObject({ set: true });
		watcher.close();
	});

	it("marks from real file events, publishing the marks to a watch", async () => {
		const { root, watcher } = await watched();
		const changes = changesOf(await watcher.watch(context));
		await writeFile(join(root, "a", "node_modules-free.ts"), "export {};");
		await writeFiles(join(root, "b", "node_modules", "pkg"), { "index.js": "" });
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ dirty: ["@test/a"] }), { timeout: 5_000 });
		await delivered();
		expect(changes.at(-1)).toMatchObject({ kind: "value", value: { dirty: ["@test/a"] } });
		watcher.close();
	});
});

describe("the watcher, fix round 1", () => {
	it("never lets an older build's applied snapshot clear a newer edit's mark (Astra)", async () => {
		const { root, watcher } = await watched();
		const file = join(root, "a", "own.ts");
		watcher.mark(file);
		const first = watcher.snapshot(["@test/a"]);
		watcher.mark(file);
		const second = watcher.snapshot(["@test/a"]);
		watcher.applied(["@test/a"], second);
		expect(watcher.value).toMatchObject({ dirty: [] });
		watcher.mark(file);
		watcher.applied(["@test/a"], first);
		expect(watcher.value).toMatchObject({ dirty: ["@test/a"] });
		watcher.close();
	});

	it("drops the install mark of a plugin the next discovery no longer has (example 38)", async () => {
		const { root, watcher } = await watched();
		watcher.mark(join(root, "b", "package.json"));
		expect(watcher.value).toMatchObject({ install: ["@test/b"] });
		await rm(join(root, "b"), { recursive: true });
		const seen = watcher.discoverySnapshot();
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		expect(watcher.value).toMatchObject({ install: [] });
		watcher.close();
	});

	it.skipIf(process.platform !== "linux")(
		"puts no watch on node_modules or .git (Opus N2): 200 packages add no inotify watch",
		async () => {
			const root = await realpath(await tempRoot());
			const dir = await writePlugin(root, "a", "@test/a", { "worker.ts": "" });
			for (let i = 0; i < 200; i++)
				await writeFiles(join(dir, "node_modules", `pkg${i}`, "lib"), { "index.js": "" });
			await writeFiles(join(dir, ".git", "objects"), { x: "" });
			const before = inotifyWatches();
			const watcher = new PluginWatcher(
				{ roots: [root], base: [], kinds: KINDS, failed: () => {} },
				new Batch(() => {}, undefined),
			);
			// The root and the plugin's directory.
			expect(inotifyWatches() - before).toBe(2);
			watcher.close();
		},
	);

	it("watches a directory that appears later, and marks the files in it", async () => {
		const { root, watcher } = await watched();
		await writeFiles(join(root, "a", "lib"), { "first.ts": "" });
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ dirty: ["@test/a"] }), { timeout: 5_000 });
		watcher.applied(["@test/a"], watcher.snapshot(["@test/a"]));
		await writeFile(join(root, "a", "lib", "second.ts"), "export {};");
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ dirty: ["@test/a"] }), { timeout: 5_000 });
		watcher.close();
	});
});

describe("the watcher and links", () => {
	it("survives a link loop created under a root (its stat never escapes the callback) and still marks it (Sol)", async () => {
		const { root, watcher } = await watched();
		await symlink("loop", join(root, "a", "loop"));
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ dirty: ["@test/a"] }), { timeout: 5_000 });
		watcher.close();
	});
});

/** The inotify watches this process holds (Linux): one line per watch in its inotify descriptors' fdinfo. */
function inotifyWatches(): number {
	let count = 0;
	for (const fd of readdirSync("/proc/self/fdinfo")) {
		try {
			count += readFileSync(`/proc/self/fdinfo/${fd}`, "utf8")
				.split("\n")
				.filter((line) => line.startsWith("inotify wd:")).length;
		} catch {
			// Closed meanwhile.
		}
	}
	return count;
}
