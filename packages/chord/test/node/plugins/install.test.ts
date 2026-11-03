// Tests of installing (slice 7c §5, slice 12 §2, §5): the npm arguments, run in the plugin's real directory, the command
// overridable; a failure and an abort reject; git dependencies with a ref, a plugin inside a repository of several
// reached by path; plugins installed from git and npm (a package's chord.plugins manifest, the refusals, claims and
// cleanup). Git repositories and tarballs are local: no network.

import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, realpath, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withCancel } from "../../../src/context/index.ts";
import { buildFacet, discoverPlugins, installDependencies, installPlugin } from "../../../src/node/plugins/index.ts";
import { rejection } from "../../support.ts";
import { gitRepository, KINDS, tempRoot, writeFiles, writePlugin } from "./support.ts";

/** A fake npm (a Node script) that records its arguments and directory, and exits with `code` after `delayMs`. */
async function fakeNpm(dir: string, code: number, delayMs = 0): Promise<readonly string[]> {
	const script = join(dir, "fake-npm.mjs");
	await writeFiles(dir, {
		"fake-npm.mjs": [
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(join(dir, "record.json"))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
			`setTimeout(() => { if (${code} !== 0) console.error("npm said no"); process.exit(${code}); }, ${delayMs});`,
		].join("\n"),
	});
	return [process.execPath, script];
}

describe("installDependencies", () => {
	it("runs npm install without dev dependencies, peers, scripts, audit or funding, in the plugin's real directory", async () => {
		const tools = await tempRoot();
		const elsewhere = await tempRoot();
		const root = await tempRoot();
		const dir = await writePlugin(
			elsewhere,
			"deps",
			"@test/deps",
			{ "worker.ts": "" },
			{ dependencies: { a: "1.0.0" } },
		);
		await symlink(dir, join(root, "deps"));
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		await installDependencies(plugins[0]!, context, { npmCommand: await fakeNpm(tools, 0) });
		expect(JSON.parse(await readFile(join(tools, "record.json"), "utf8"))).toEqual({
			args: ["install", "--omit=dev", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund"],
			cwd: await realpath(dir),
		});
	});

	it("rejects with the command's output when it fails, and when the context aborts", async () => {
		const tools = await tempRoot();
		const root = await tempRoot();
		await writePlugin(root, "deps", "@test/deps", {});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const plugin = plugins[0]!;
		expect(
			await rejection(installDependencies(plugin, context, { npmCommand: await fakeNpm(tools, 1) })),
		).toMatchObject({
			message: expect.stringMatching(/^plugin "@test\/deps": .* install failed \(exit 1\): npm said no$/),
		});
		const { context: aborted, cancel } = withCancel(context);
		const running = installDependencies(plugin, aborted, { npmCommand: await fakeNpm(tools, 0, 5_000) });
		setTimeout(() => cancel(new Error("stop")), 50);
		expect(await rejection(running)).toMatchObject({ name: "AbortError" });
	});
});

/** The worker facet of plugin `name` under `root`, built for Node with Chord as the host package. */
async function workerOf(root: string, name: string): Promise<string> {
	const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
	const plugin = plugins.find((each) => each.name === name)!;
	const options = { hostPackages: ["@earendil-works/chord"], platform: "node", plugins } as const;
	const built = await buildFacet(plugin, "worker", options, context);
	if (built.kind === "failed") throw new Error(built.errors.join("\n"));
	return built.source;
}

/** A contracts package `@bob/notes` whose contract says `label`. */
function notesPackage(label: string): Record<string, string> {
	return {
		"package.json": JSON.stringify({ name: "@bob/notes", version: "1.0.0", exports: { ".": "./contract.ts" } }),
		"contract.ts": `export const label = ${JSON.stringify(label)};`,
	};
}

describe("installDependencies: git dependencies (slice 12 §2)", () => {
	it("installs a git dependency pinned to a commit with npm; the build inlines that commit's file", async () => {
		const first = await gitRepository("notes", notesPackage("notes at v1"), "v1");
		await gitRepository("notes", notesPackage("notes at v2"), "v2", first);
		const root = await tempRoot();
		await writePlugin(
			root,
			"stats",
			"@test/stats",
			{ "worker.ts": 'import { label } from "@bob/notes";\nexport default { setup: () => label };' },
			{ dependencies: { "@bob/notes": `git+${first.url}#${first.commit}` } },
		);
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		await installDependencies(plugins[0]!, context);
		const source = await workerOf(root, "@test/stats");
		expect(source).toContain("notes at v1");
		expect(source).not.toContain("notes at v2");
	}, 60_000);

	it("reaches a plugin inside a multi-plugin repository through a dependency on the whole repository, by path", async () => {
		const repository = await gitRepository(
			"plugins",
			{
				"package.json": JSON.stringify({ name: "@bob/plugins", version: "1.0.0", chord: { plugins: ["notes"] } }),
				"notes/package.json": JSON.stringify({ name: "@bob/notes" }),
				"notes/contract.ts": 'export const label = "notes inside a repository of several";',
			},
			"v1",
		);
		const root = await tempRoot();
		await writePlugin(
			root,
			"stats",
			"@test/stats",
			{
				"worker.ts":
					'import { label } from "@bob/plugins/notes/contract.ts";\nexport default { setup: () => label };',
			},
			{ dependencies: { "@bob/plugins": `git+${repository.url}#${repository.commit}` } },
		);
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		await installDependencies(plugins[0]!, context);
		expect(await workerOf(root, "@test/stats")).toContain("notes inside a repository of several");
	}, 60_000);
});

describe("installPlugin (slice 12 §5)", () => {
	it("clones a repository whose top is a plugin into <root>/<repository>, at a tag, and installs its dependencies", async () => {
		const repository = await gitRepository(
			"hello",
			{ "package.json": JSON.stringify({ name: "@bob/hello" }), "worker.ts": "export default { setup: () => {} };" },
			"v1",
		);
		const root = await tempRoot();
		const tools = await tempRoot();
		const npmCommand = await fakeNpm(tools, 0);
		expect(await installPlugin({ git: repository.url, ref: "v1" }, root, context, { npmCommand })).toEqual([
			"@bob/hello",
		]);
		expect(JSON.parse(await readFile(join(tools, "record.json"), "utf8")).cwd).toBe(
			await realpath(join(root, "hello")),
		);
		// No updating in place.
		expect(
			await rejection(installPlugin({ git: repository.url, ref: "v1" }, root, context, { npmCommand })),
		).toMatchObject({
			message: `installPlugin: ${join(root, "hello")} exists already`,
		});
	});

	it("clones a repository of several plugins (its subdirectories), pinned to a commit", async () => {
		const first = await gitRepository(
			"bob-plugins",
			{
				"notes/package.json": JSON.stringify({ name: "@bob/notes" }),
				"search/package.json": JSON.stringify({ name: "@bob/search" }),
			},
			"v1",
		);
		await gitRepository("bob-plugins", { "later/package.json": JSON.stringify({ name: "@bob/later" }) }, "v2", first);
		const root = await tempRoot();
		const tools = await tempRoot();
		const names = await installPlugin({ git: first.url, ref: first.commit }, root, context, {
			npmCommand: await fakeNpm(tools, 0),
		});
		expect([...names].sort()).toEqual(["@bob/notes", "@bob/search"]);
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		expect(plugins.map(({ name }) => name)).toEqual(["@bob/notes", "@bob/search"]);
	});

	it("installs an npm package (here a local tarball) into <root>/<name>", async () => {
		const source = await tempRoot();
		await writeFiles(source, {
			"package.json": JSON.stringify({ name: "@bob/clock", version: "1.2.0" }),
			"worker.ts": "export default { setup: () => {} };",
		});
		const packed = execFileSync("npm", ["pack", "--silent", "--pack-destination", source], {
			cwd: source,
			encoding: "utf8",
		}).trim();
		const root = await tempRoot();
		const names = await installPlugin({ npm: "@bob/clock", version: `file:${join(source, packed)}` }, root, context);
		expect(names).toEqual(["@bob/clock"]);
		expect(JSON.parse(await readFile(join(root, "@bob", "clock", "package.json"), "utf8"))).toMatchObject({
			version: "1.2.0",
		});
	}, 60_000);

	it("installs exactly the folders a package's chord.plugins lists", async () => {
		const repository = await gitRepository(
			"bob-plugins",
			{
				"package.json": JSON.stringify({
					name: "@bob/plugins",
					chord: { plugins: ["plugins/*", "!plugins/draft"] },
				}),
				"plugins/notes/package.json": JSON.stringify({ name: "@bob/notes" }),
				"plugins/draft/package.json": JSON.stringify({ name: "@bob/draft" }),
				"tools/package.json": JSON.stringify({ name: "@bob/tools" }),
			},
			"v1",
		);
		const root = await tempRoot();
		const tools = await tempRoot();
		const names = await installPlugin({ git: repository.url, ref: "v1" }, root, context, {
			npmCommand: await fakeNpm(tools, 0),
		});
		expect(names).toEqual(["@bob/notes"]);
	});

	it("refuses a ref, a repository and a package name an option could hide in (Sol P1)", async () => {
		const repository = await gitRepository("hello", { "package.json": JSON.stringify({ name: "@bob/hello" }) }, "v1");
		const root = await tempRoot();
		const marker = join(root, "..", "upload-pack-ran");
		for (const source of [
			{ git: repository.url, ref: `--upload-pack=touch ${marker}` },
			{ git: "--upload-pack=x", ref: "v1" },
			{ npm: "--registry=http://evil", version: "1.0.0" },
			{ npm: "x", version: "--foreground-scripts" },
			{ npm: "../escaped", version: "1.0.0" },
		]) {
			expect(await rejection(installPlugin(source, root, context))).toMatchObject({
				message: expect.stringMatching(/^installPlugin: .* (is refused|is not an npm package name)$/),
			});
		}
		expect(await readdir(root)).toEqual([]);
		expect(await readdir(join(root, "..")).then((names) => names.includes("upload-pack-ran"))).toBe(false);
	});

	it("refuses a plugin name another root has, and leaves nothing behind (Opus M4)", async () => {
		const first = await tempRoot();
		const root = await tempRoot();
		await writePlugin(first, "zeta", "@test/same", {});
		const repository = await gitRepository("alpha", { "package.json": JSON.stringify({ name: "@test/same" }) }, "v1");
		const roots = [first, root];
		expect(
			await rejection(installPlugin({ git: repository.url, ref: "v1" }, root, context, { roots })),
		).toMatchObject({
			message: `installPlugin: plugin "@test/same" is in ${join(await realpath(first), "zeta")} already`,
		});
		expect(await readdir(root)).toEqual([]);
	});

	it("claims its directory first: of two concurrent installs one wins, the other removes nothing of it (Sol)", async () => {
		const repository = await gitRepository("hello", { "package.json": JSON.stringify({ name: "@bob/hello" }) }, "v1");
		const root = await tempRoot();
		const tools = await tempRoot();
		const npmCommand = await fakeNpm(tools, 0);
		const both = await Promise.allSettled([
			installPlugin({ git: repository.url, ref: "v1" }, root, context, { npmCommand }),
			installPlugin({ git: repository.url, ref: "v1" }, root, context, { npmCommand }),
		]);
		expect(both.map((each) => each.status).sort()).toEqual(["fulfilled", "rejected"]);
		expect(both.find((each) => each.status === "rejected")).toMatchObject({
			reason: { message: `installPlugin: ${join(root, "hello")} exists already` },
		});
		expect(await readdir(join(root, "hello"))).toContain("package.json");
	});

	it("removes the scope directory it made when a scoped npm install fails (Opus L2)", async () => {
		const root = await tempRoot();
		const tools = await tempRoot();
		expect(
			await rejection(
				installPlugin({ npm: "@bob/notes", version: "1.0.0" }, root, context, {
					npmCommand: await fakeNpm(tools, 1),
				}),
			),
		).toMatchObject({ message: expect.stringContaining("pack @bob/notes@1.0.0 failed") });
		expect(await readdir(root)).toEqual([]);
	});

	it("removes staging directories an install crashed out of, once an hour old (Opus N6)", async () => {
		const repository = await gitRepository("hello", { "package.json": JSON.stringify({ name: "@bob/hello" }) }, "v1");
		const root = await tempRoot();
		await mkdir(join(root, ".chord-install-old"));
		await mkdir(join(root, ".chord-install-recent"));
		const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		await utimes(join(root, ".chord-install-old"), hourAgo, hourAgo);
		const tools = await tempRoot();
		await installPlugin({ git: repository.url, ref: "v1" }, root, context, { npmCommand: await fakeNpm(tools, 0) });
		expect((await readdir(root)).sort()).toEqual([".chord-install-recent", "hello"]);
	});

	it("removes what arrived when it holds no plugin", async () => {
		const repository = await gitRepository("empty", { "readme.md": "" }, "v1");
		const root = await tempRoot();
		expect(await rejection(installPlugin({ git: repository.url, ref: "v1" }, root, context))).toMatchObject({
			message: expect.stringMatching(/^installPlugin: .*empty: no package\.json$/),
		});
		expect(await readdir(root)).toEqual([]);
	});
});
