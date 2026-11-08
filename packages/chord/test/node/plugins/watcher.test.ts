// Tests of the watcher (slice 7c §5, slice 12 §4, p3 step 0a): dirty marks from the files facets used and from plugin
// directories, `install`, `set`, `base` compared with what the running base artifacts read, a change during a build
// keeping its mark, `node_modules` and `.git` ignored, real file events, the marks as a JSON watchable, and single-file
// plugins' files.

import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { chmod, mkdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { contentHash } from "../../../src/node/plugins/base-inputs.ts";
import { type BuiltFacet, discoverPlugins } from "../../../src/node/plugins/index.ts";
import { PluginWatcher } from "../../../src/node/plugins/watcher.ts";
import { Batch } from "../../../src/state/internal.ts";
import { changesOf, delivered } from "../../support.ts";
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
		await writeFile(join(base, "core.ts"), "export {};");
		watcher.mark(join(base, "core.ts"));
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ base: true }), { timeout: 5_000 });
		watcher.close();
	});

	it("compares a recorded base file, not its siblings; never under node_modules", async () => {
		const { base, watcher } = await watched();
		const elsewhere = await realpath(await tempRoot());
		await writeFiles(elsewhere, { "entry.ts": "", "sibling.ts": "", "node_modules/react/index.js": "" });
		watcher.recordBase(
			new Map([
				[join(elsewhere, "entry.ts"), hashOf("")],
				[join(elsewhere, "node_modules", "react", "index.js"), hashOf("")],
			]),
		);
		await writeFile(join(elsewhere, "sibling.ts"), "export {};");
		await writeFile(join(elsewhere, "node_modules", "react", "index.js"), "export {};");
		watcher.mark(join(elsewhere, "sibling.ts"));
		watcher.mark(join(elsewhere, "node_modules", "react", "index.js"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(watcher.value).toMatchObject({ base: false });
		// A real event on the file: its directory is watched.
		await writeFile(join(elsewhere, "entry.ts"), "export {};");
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ base: true }), { timeout: 5_000 });
		expect(base).not.toBe(elsewhere);
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

describe("the watcher and single-file plugins (slice 12 §4)", () => {
	it("dirties a single-file plugin for a change of its file; a file appearing or disappearing at a root's top sets set", async () => {
		const { root, watcher } = await watched();
		await writeFiles(root, { "hello.server.ts": "" });
		watcher.mark(join(root, "hello.server.ts"));
		expect(watcher.value).toMatchObject({ set: true, dirty: [] });
		const seen = watcher.discoverySnapshot();
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), seen);
		expect(watcher.value).toMatchObject({ set: false, dirty: [] });
		// Its own file: only it is dirty (not every plugin of the root its directory is).
		watcher.mark(join(root, "hello.server.ts"));
		expect(watcher.value).toMatchObject({ set: false, dirty: ["hello"] });
		await writeFiles(root, { "hello.web.tsx": "" });
		watcher.mark(join(root, "hello.web.tsx"));
		expect(watcher.value).toMatchObject({ set: true });
		watcher.know(await discoverPlugins([root], { kinds: KINDS }, context), watcher.discoverySnapshot());
		await rm(join(root, "hello.server.ts"));
		watcher.mark(join(root, "hello.server.ts"));
		expect(watcher.value).toMatchObject({ set: true, dirty: ["hello"] });
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

describe("base code compared with what the running bases read (p3 step 0a)", () => {
	/** A watcher of a base directory holding `files` (the server's own code, hashed at its start), and no roots. */
	async function based(files: Readonly<Record<string, string>>) {
		const base = await realpath(await tempRoot());
		await writeFiles(base, files);
		const watcher = new PluginWatcher(
			{ roots: [], base: [base], kinds: KINDS, failed: () => {} },
			new Batch(() => {}, undefined),
		);
		return { base, watcher };
	}

	/** Waits until the watcher's `base` mark is `value`. */
	async function baseIs(watcher: PluginWatcher, value: boolean): Promise<void> {
		await vi.waitFor(() => expect(watcher.value).toMatchObject({ base: value }), { timeout: 5_000 });
	}

	/** Lets the watch events and the comparisons of the last writes run. */
	async function settled(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 200));
	}

	it("ignores a rewrite with the same bytes; marks a change and clears at its revert", async () => {
		const { base, watcher } = await based({ "core.ts": "export const a = 1;\n" });
		await writeFile(join(base, "core.ts"), "export const a = 1;\n");
		await settled();
		expect(watcher.value).toMatchObject({ base: false });
		await writeFile(join(base, "core.ts"), "export const a = 2;\n");
		await baseIs(watcher, true);
		await writeFile(join(base, "core.ts"), "export const a = 1;\n");
		await baseIs(watcher, false);
		watcher.close();
	});

	it("takes the latest of a burst of writes: a change and its quick revert leave no mark", async () => {
		const { base, watcher } = await based({ "core.ts": "v1" });
		for (let round = 0; round < 20; round++) {
			await writeFile(join(base, "core.ts"), `v${round + 2}`);
			watcher.mark(join(base, "core.ts"));
		}
		await writeFile(join(base, "core.ts"), "v1");
		watcher.mark(join(base, "core.ts"));
		await settled();
		expect(watcher.value).toMatchObject({ base: false });
		watcher.close();
	});

	it("ignores a swap file; marks a new source file and clears once it is removed", async () => {
		const { base, watcher } = await based({ "core.ts": "" });
		await writeFile(join(base, ".core.ts.swp"), "swap");
		await writeFile(join(base, "notes.md"), "notes");
		await settled();
		expect(watcher.value).toMatchObject({ base: false });
		await writeFile(join(base, "extra.ts"), "export {};");
		await baseIs(watcher, true);
		await rm(join(base, "extra.ts"));
		await baseIs(watcher, false);
		watcher.close();
	});

	it("finds an edit made between a base build and its watch, with no later event", async () => {
		const { base, watcher } = await based({});
		const elsewhere = await realpath(await tempRoot());
		await writeFiles(elsewhere, { "entry.ts": "edited after the build" });
		watcher.recordBase(new Map([[join(elsewhere, "entry.ts"), hashOf("as built")]]));
		await baseIs(watcher, true);
		expect(base).not.toBe(elsewhere);
		watcher.close();
	});

	it("watches a base directory removed and recreated, and compares its files", async () => {
		const parent = await realpath(await tempRoot());
		const base = join(parent, "app");
		await writeFiles(base, { "core.ts": "v1", "sub/inner.ts": "inner" });
		const watcher = new PluginWatcher(
			{ roots: [], base: [base], kinds: KINDS, failed: () => {} },
			new Batch(() => {}, undefined),
		);
		await rename(base, join(parent, "moved"));
		await baseIs(watcher, true);
		await rename(join(parent, "moved"), base);
		await baseIs(watcher, false);
		// Watched again: an edit after it came back is seen, in a subdirectory too.
		await writeFile(join(base, "sub", "inner.ts"), "edited");
		await baseIs(watcher, true);
		await writeFile(join(base, "sub", "inner.ts"), "inner");
		await baseIs(watcher, false);
		// A subdirectory removed and made again with its file.
		await rm(join(base, "sub"), { recursive: true });
		await baseIs(watcher, true);
		await mkdir(join(base, "sub"));
		await writeFile(join(base, "sub", "inner.ts"), "inner");
		await baseIs(watcher, false);
		watcher.close();
	}, 30_000);

	it("follows an ancestor of a recorded file moved away and its subtree made again: edit, revert", async () => {
		const { watcher } = await based({});
		const root = await realpath(await tempRoot());
		const file = join(root, "parent", "child", "entry.ts");
		await writeFiles(join(root, "parent", "child"), { "entry.ts": "v1" });
		watcher.recordBase(new Map([[file, hashOf("v1")]]));
		await settled();
		expect(watcher.value).toMatchObject({ base: false });
		await rename(join(root, "parent"), join(root, "moved"));
		await baseIs(watcher, true);
		await writeFiles(join(root, "parent", "child"), { "entry.ts": "v2" });
		await settled();
		expect(watcher.value).toMatchObject({ base: true });
		await writeFile(file, "v1");
		await baseIs(watcher, false);
		await writeFile(file, "v3");
		await baseIs(watcher, true);
		await writeFile(file, "v1");
		await baseIs(watcher, false);
		watcher.close();
	}, 30_000);

	it("renews the watch of an ancestor removed and made again while the recorded directory is missing", async () => {
		const { watcher } = await based({});
		const root = await realpath(await tempRoot());
		await mkdir(join(root, "a"));
		const file = join(root, "a", "b", "x.ts");
		watcher.recordBase(new Map([[file, hashOf("as built")]]));
		await baseIs(watcher, true);
		rmSync(join(root, "a"), { recursive: true });
		mkdirSync(join(root, "a"));
		await settled();
		await writeFiles(join(root, "a", "b"), { "x.ts": "as built" });
		await baseIs(watcher, false);
		await writeFile(file, "edited");
		await baseIs(watcher, true);
		watcher.close();
	}, 30_000);

	it.skipIf(process.platform !== "linux")(
		"reads one path in order: a second comparison waits for the first, held on a pipe, and decides",
		async () => {
			const { watcher } = await based({});
			const root = await realpath(await tempRoot());
			const pipe = join(root, "held.ts");
			execFileSync("mkfifo", [pipe]);
			// The first comparison opens the pipe and waits for a writer; a second one is queued behind it.
			watcher.recordBase(new Map([[pipe, hashOf("as built")]]));
			watcher.mark(pipe);
			await settled();
			// The first read gets other bytes: marked. (Two readers at once would split this: one of them gets nothing.)
			await writeWhenRead(pipe, "other bytes");
			await baseIs(watcher, true);
			// Only now does the second read open the pipe, and it decides: the recorded bytes.
			await writeWhenRead(pipe, "as built");
			await baseIs(watcher, false);
			watcher.close();
		},
		30_000,
	);

	it.skipIf(process.platform !== "linux")(
		"renews nothing for a burst of attribute changes on an ancestor, and renews at its rename",
		async () => {
			const { watcher } = await based({});
			const root = await realpath(await tempRoot());
			await mkdir(join(root, "ancestor", "dir"), { recursive: true });
			const pipe = join(root, "ancestor", "dir", "held.ts");
			execFileSync("mkfifo", [pipe]);
			watcher.recordBase(new Map([[pipe, hashOf("as built")]]));
			await writeWhenRead(pipe, "as built");
			await settled();
			expect(watcher.value).toMatchObject({ base: false });
			for (let round = 0; round < 20; round++) {
				await chmod(join(root, "ancestor"), round % 2 === 0 ? 0o700 : 0o755);
				await chmod(join(root, "ancestor", "dir"), round % 2 === 0 ? 0o700 : 0o755);
			}
			await settled();
			// A renewal would compare the file again: a reader would wait on the pipe.
			expect(readerWaits(pipe)).toBe(false);
			await rename(join(root, "ancestor"), join(root, "moved"));
			await baseIs(watcher, true);
			await rename(join(root, "moved"), join(root, "ancestor"));
			await writeWhenRead(pipe, "as built");
			await baseIs(watcher, false);
			watcher.close();
		},
		30_000,
	);

	it("keeps a file two bases read with different bytes marked whatever it holds", async () => {
		const { watcher } = await based({});
		const elsewhere = await realpath(await tempRoot());
		const file = join(elsewhere, "shared.ts");
		await writeFiles(elsewhere, { "shared.ts": "first" });
		watcher.recordBase(new Map([[file, hashOf("first")]]));
		watcher.recordBase(new Map([[file, hashOf("second")]]));
		await baseIs(watcher, true);
		await writeFile(file, "second");
		await settled();
		expect(watcher.value).toMatchObject({ base: true });
		watcher.close();
	});
});

/** Whether a reader has the pipe at `path` open (a non-blocking open for writing succeeds; it then reads nothing). */
function readerWaits(path: string): boolean {
	try {
		closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
		return true;
	} catch {
		return false;
	}
}

/**
 * Writes `text` into the pipe at `path` once a reader has it open (a non-blocking open for writing fails until then),
 * and closes it: that reader reads `text`.
 */
async function writeWhenRead(path: string, text: string): Promise<void> {
	for (let tries = 0; ; tries++) {
		let fd: number;
		try {
			fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
		} catch (error) {
			if (tries === 300) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
			continue;
		}
		writeSync(fd, text);
		closeSync(fd);
		return;
	}
}

/** The hash a base record keeps for a file holding `text`. */
function hashOf(text: string): string {
	return contentHash(new TextEncoder().encode(text));
}

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
