// Tests of discovery (slice 7c §1, slice 12 §1, §2, §4): names from package.json, the first root winning a duplicate,
// directories reported (no or an invalid package.json, an invalid name, two files of one kind), contracts-only plugins,
// symlinks, required roots, checkouts of several plugins, packages' chord.plugins manifests, single-file plugins.

import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { discoverPlugins } from "../../../src/node/plugins/index.ts";
import { KINDS, tempRoot, writeFiles, writePlugin } from "./support.ts";

describe("discovery", () => {
	it("names a plugin by its package.json, lists its facet files by kind, its dependencies and externals", async () => {
		const root = await tempRoot(["contracts", "notes"]);
		const dir = await writePlugin(
			root,
			"deps-dir",
			"@test/deps",
			{ "worker.ts": "", "store.ts": "" },
			{
				dependencies: { marked: "1.0.0" },
				chord: { external: ["better-sqlite3"] },
			},
		);
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		expect(problems).toEqual([]);
		const real = await realpath(root);
		const of = { root: real, required: false, layout: "directory" } as const;
		expect(plugins).toEqual([
			{ name: "@test/contracts", dir: join(real, "contracts"), ...of, facets: {}, dependencies: [], external: [] },
			{
				name: "@test/deps",
				dir: await realpath(dir),
				...of,
				facets: { worker: join(real, "deps-dir", "worker.ts") },
				dependencies: ["marked"],
				external: ["better-sqlite3"],
			},
			{
				name: "@test/notes",
				dir: join(real, "notes"),
				...of,
				facets: { server: join(real, "notes", "server.ts"), worker: join(real, "notes", "worker.ts") },
				dependencies: [],
				external: [],
			},
		]);
	});

	it("reports a directory without package.json, with an invalid one, an invalid name or two files of a kind", async () => {
		const root = await tempRoot();
		await mkdir(join(root, "bare"));
		await writeFiles(join(root, "broken"), { "package.json": "{ not json" });
		await writePlugin(root, "invalid", "Not A Name", {});
		await writePlugin(root, "two", "@test/two", { "worker.ts": "", "worker.js": "" });
		await writePlugin(root, "good", "@test/good", { "web.tsx": "" });
		// Not plugins and not reported: hidden directories and a root's own packages.
		await mkdir(join(root, ".git"));
		await mkdir(join(root, "node_modules"));
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		expect(plugins.map(({ name }) => name)).toEqual(["@test/good"]);
		const real = await realpath(root);
		expect(problems.map(({ path, error }) => ({ path, error }))).toEqual([
			{ path: join(real, "bare"), error: "no package.json" },
			{ path: join(real, "broken"), error: expect.stringMatching(/^package\.json: /) },
			{ path: join(real, "invalid"), error: 'package.json: "Not A Name" is not a valid plugin name' },
			{ path: join(real, "two"), error: "two worker facets: worker.ts, worker.js" },
		]);
	});

	it("keeps the first root's plugin of a duplicate name and reports the other; a missing root is empty", async () => {
		const first = await tempRoot();
		const second = await tempRoot();
		await writePlugin(first, "a", "@test/same", { "worker.ts": "" });
		await writePlugin(second, "b", "@test/same", { "server.ts": "" });
		const { plugins, problems } = await discoverPlugins(
			[first, join(first, "missing"), second],
			{ kinds: KINDS },
			context,
		);
		expect(plugins.map(({ dir }) => dir)).toEqual([join(await realpath(first), "a")]);
		expect(problems.map(({ path, error }) => ({ path, error }))).toEqual([
			{
				path: join(await realpath(second), "b"),
				error: `plugin "@test/same" is in ${join(await realpath(first), "a")} already`,
			},
		]);
	});

	it("follows a symlinked plugin directory to its real path", async () => {
		const elsewhere = await tempRoot();
		const root = await tempRoot();
		const dir = await writePlugin(elsewhere, "linked", "@test/linked", { "worker.ts": "" });
		await symlink(dir, join(root, "link"));
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		expect(plugins.map((each) => [each.name, each.dir])).toEqual([["@test/linked", await realpath(dir)]]);
		expect(plugins[0]!.facets).toEqual({ worker: join(await realpath(dir), "worker.ts") });
	});
});

describe("discovery: roots and checkouts (slice 12)", () => {
	it("marks the plugins of a required root and records each plugin's root", async () => {
		const app = await tempRoot();
		const user = await tempRoot();
		await writePlugin(app, "core", "@test/core", { "server.ts": "" });
		await writePlugin(user, "extra", "@test/extra", { "server.ts": "" });
		const { plugins } = await discoverPlugins([{ path: app, required: true }, user], { kinds: KINDS }, context);
		expect(plugins.map(({ name, root, required }) => [name, root, required])).toEqual([
			["@test/core", await realpath(app), true],
			["@test/extra", await realpath(user), false],
		]);
	});

	it("lists the plugins of a checkout of several (a directory without package.json), within its root", async () => {
		const root = await tempRoot();
		await writePlugin(join(root, "repo"), "notes", "@test/notes", { "worker.ts": "" });
		await writePlugin(join(root, "repo"), "search", "@test/search", { "worker.ts": "" });
		await mkdir(join(root, "repo", "docs"));
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		const real = await realpath(root);
		expect(problems).toEqual([]);
		expect(plugins.map(({ name, dir, root: of }) => [name, dir, of])).toEqual([
			["@test/notes", join(real, "repo", "notes"), real],
			["@test/search", join(real, "repo", "search"), real],
		]);
	});
});

describe("discovery: packages and their chord.plugins manifests (slice 12 §2)", () => {
	it("lists the folders chord.plugins names: paths, globs and exclusions", async () => {
		const root = await tempRoot();
		await writeFiles(join(root, "bob"), {
			"package.json": JSON.stringify({
				name: "@bob/plugins",
				chord: { plugins: ["./notes/", "extra/*", "!extra/old", "deep/**/p?"] },
			}),
			"server.ts": "",
		});
		await writePlugin(join(root, "bob"), "notes", "@bob/notes", { "worker.ts": "" });
		await writePlugin(join(root, "bob"), "unlisted", "@bob/unlisted", { "worker.ts": "" });
		await writePlugin(join(root, "bob", "extra"), "search", "@bob/search", { "worker.ts": "" });
		await writePlugin(join(root, "bob", "extra"), "old", "@bob/old", { "worker.ts": "" });
		await writePlugin(join(root, "bob", "deep", "a", "b"), "p1", "@bob/p1", { "worker.ts": "" });
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		expect(problems).toEqual([]);
		const real = await realpath(root);
		expect(plugins.map(({ name, dir }) => [name, dir.slice(real.length + 1)])).toEqual([
			["@bob/notes", "bob/notes"],
			["@bob/p1", "bob/deep/a/b/p1"],
			["@bob/search", "bob/extra/search"],
		]);
	});

	it("lists the package itself as `.`, and reports a listed folder inside another listed one (Opus N5)", async () => {
		const root = await tempRoot();
		await writeFiles(join(root, "one"), {
			"package.json": JSON.stringify({ name: "@bob/one", chord: { plugins: ["."] } }),
			"worker.ts": "",
		});
		await writeFiles(join(root, "two"), {
			"package.json": JSON.stringify({ name: "@bob/two", chord: { plugins: [".", "./sub"] } }),
			"sub/package.json": JSON.stringify({ name: "@bob/sub" }),
		});
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		expect(plugins.map(({ name }) => name)).toEqual(["@bob/one"]);
		expect(problems.map(({ error }) => error)).toEqual([
			'package.json: chord.plugins lists "sub" inside the listed "."',
		]);
	});

	it("reports a manifest that is no list, lists nothing, leaves the package or names no directory", async () => {
		const root = await tempRoot();
		const manifest = (plugins: unknown) => JSON.stringify({ name: "@bob/x", chord: { plugins } });
		await writeFiles(root, {
			"a/package.json": manifest({ "@bob/notes": "github:bob/plugins#v1:notes" }),
			"b/package.json": manifest(["nothing/*"]),
			"c/package.json": manifest(["../a"]),
			"d/package.json": manifest(["./file.txt"]),
			"d/file.txt": "",
		});
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		const real = await realpath(root);
		expect(plugins).toEqual([]);
		expect(problems.map(({ path, error }) => [path.slice(real.length + 1), error])).toEqual([
			["a", "package.json: chord.plugins is not a list of plugin folders"],
			["b", "package.json: chord.plugins lists no plugin folder"],
			["c", 'package.json: chord.plugins "../a" leaves the package'],
			["d/file.txt", "listed in chord.plugins, not a directory"],
		]);
	});

	it("by convention: a package with facet files at its top is one plugin, else its subfolders with a package.json", async () => {
		const root = await tempRoot();
		await writePlugin(root, "single", "@test/single", { "worker.ts": "", "fixtures/package.json": "{}" });
		await writeFiles(join(root, "repo"), { "package.json": JSON.stringify({ name: "@test/repo" }) });
		await writePlugin(join(root, "repo"), "notes", "@test/notes", { "worker.ts": "" });
		await writePlugin(root, "contracts-only", "@test/contracts", { "contract.ts": "" });
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		expect(problems).toEqual([]);
		expect(plugins.map(({ name }) => name)).toEqual(["@test/contracts", "@test/notes", "@test/single"]);
	});

	it("reports a required root that does not exist, and records each problem's root", async () => {
		const root = await tempRoot();
		await writeFiles(join(root, "broken"), { "package.json": "{ not json" });
		const missing = join(root, "missing");
		const { problems } = await discoverPlugins(
			[
				{ path: root, required: true },
				{ path: missing, required: true },
			],
			{ kinds: KINDS },
			context,
		);
		expect(problems).toEqual([
			{
				path: join(await realpath(root), "broken"),
				error: expect.stringMatching(/^package\.json: /),
				root: await realpath(root),
				required: true,
			},
			{ path: missing, error: "the required root does not exist", root: missing, required: true },
		]);
	});
});

describe("discovery: single-file plugins (slice 12 §4)", () => {
	it("groups <name>.<kind>.<ext> files at a root's top by name, one facet per file, without package.json", async () => {
		const root = await tempRoot();
		await writeFiles(root, {
			"hello.server.ts": "",
			"hello.web.tsx": "",
			"clock.worker.mjs": "",
			"notes.md": "",
			"helper.ts": "",
			"other.thing.ts": "",
		});
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		const real = await realpath(root);
		expect(problems).toEqual([]);
		const of = { dir: real, root: real, required: false, layout: "file", dependencies: [], external: [] };
		expect(plugins).toEqual([
			{ name: "clock", ...of, facets: { worker: join(real, "clock.worker.mjs") } },
			{
				name: "hello",
				...of,
				facets: { server: join(real, "hello.server.ts"), web: join(real, "hello.web.tsx") },
			},
		]);
	});

	it("reports an invalid name and two files of a kind; a directory plugin of the same name wins", async () => {
		const root = await tempRoot();
		await writeFiles(root, {
			"Bad.server.ts": "",
			"twice.server.ts": "",
			"twice.server.js": "",
			"notes.server.ts": "",
		});
		const dir = await writePlugin(root, "zz-notes", "notes", { "server.ts": "" });
		const { plugins, problems } = await discoverPlugins([root], { kinds: KINDS }, context);
		const real = await realpath(root);
		expect(plugins.map(({ name, layout, dir: at }) => [name, layout, at])).toEqual([
			["notes", "directory", await realpath(dir)],
		]);
		expect(problems.map(({ path, error }) => ({ path, error }))).toEqual([
			{ path: join(real, "Bad.server.ts"), error: '"Bad" is not a valid unscoped plugin name' },
			{ path: join(real, "twice.server.js"), error: "two server facets: twice.server.js, twice.server.ts" },
			{ path: join(real, "notes.server.ts"), error: `plugin "notes" is in ${await realpath(dir)} already` },
		]);
	});
});
