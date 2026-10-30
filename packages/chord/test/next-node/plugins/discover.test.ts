// Tests of discovery (slice 7c §1): names from package.json, the first root winning a duplicate, directories reported
// (no or an invalid package.json, an invalid name, two files of one kind), contracts-only plugins, symlinks.

import { mkdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { discoverPlugins } from "../../../src/next-node/plugins/index.ts";
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
		expect(plugins).toEqual([
			{ name: "@test/contracts", dir: join(real, "contracts"), facets: {}, dependencies: [], external: [] },
			{
				name: "@test/deps",
				dir: await realpath(dir),
				facets: { worker: join(real, "deps-dir", "worker.ts") },
				dependencies: ["marked"],
				external: ["better-sqlite3"],
			},
			{
				name: "@test/notes",
				dir: join(real, "notes"),
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
		expect(problems).toEqual([
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
		expect(problems).toEqual([
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
