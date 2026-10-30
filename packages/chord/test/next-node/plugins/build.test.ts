// Tests of building (slice 7c §2): every row of the import table, failures as results, source maps relative to the
// plugin and digests stable across two checkout paths, inputs hashed as esbuild read them.

import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	type BuildOptions,
	type BuiltFacet,
	buildFacet,
	discoverPlugins,
	type Plugin,
} from "../../../src/next-node/plugins/index.ts";
import { KINDS, tempRoot, writeFiles, writePackage, writePlugin } from "./support.ts";

const NODE: BuildOptions = { hostPackages: ["@earendil-works/chord/next"], platform: "node" };
const BROWSER: BuildOptions = {
	hostPackages: ["@earendil-works/chord/next", "react/jsx-runtime"],
	platform: "browser",
	publicPath: "/assets/",
};

/** The plugins under `root`, and the one named `name`. */
async function discovered(root: string, name: string): Promise<{ plugins: readonly Plugin[]; plugin: Plugin }> {
	const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
	return { plugins, plugin: plugins.find((each) => each.name === name)! };
}

/** `built`'s script, failing the test with its errors when it failed. */
function script(built: BuiltFacet): Extract<BuiltFacet, { kind: "script" }> {
	if (built.kind === "failed") throw new Error(`build failed: ${built.errors.join("\n")}`);
	return built;
}

/** The errors of a build that must fail. */
function errors(built: BuiltFacet): readonly string[] {
	if (built.kind !== "failed") throw new Error("the build succeeded");
	return built.errors;
}

/** The sources of `built`'s inline source map. */
function sourcesOf(built: Extract<BuiltFacet, { kind: "script" }>): string[] {
	const inline = /sourceMappingURL=data:application\/json;base64,(\S+)/.exec(built.source)![1]!;
	return JSON.parse(Buffer.from(inline, "base64").toString()).sources;
}

describe("building a facet: the import table", () => {
	it("inlines the plugin's own files and another plugin's file (copied); keeps host packages external", async () => {
		const root = await tempRoot(["contracts", "notes"]);
		const { plugins, plugin } = await discovered(root, "@test/notes");
		const built = script(await buildFacet(plugin, "worker", { ...NODE, plugins }, context));
		const real = await realpath(root);
		expect(built).toMatchObject({ plugin: "@test/notes", facet: "worker", assets: [] });
		expect(built.source.startsWith("(function (require, module, exports) {")).toBe(true);
		expect(built.source).toContain('require("@earendil-works/chord/next")');
		expect(built.copied).toEqual([join(real, "contracts", "contract.ts")]);
		expect(built.inputs.map(({ file }) => file)).toEqual([
			join(real, "contracts", "contract.ts"),
			join(real, "notes", "label.ts"),
			join(real, "notes", "worker.ts"),
		]);
		// Relative to the plugin (a file whose code minified away maps nothing and is left out).
		expect(sourcesOf(built)).toEqual(expect.arrayContaining(["worker.ts", "../contracts/contract.ts"]));
		for (const source of sourcesOf(built)) expect(source.startsWith("/")).toBe(false);
		// Positions only: no copy of the sources' text in the script (Opus N3).
		const inline = /sourceMappingURL=data:application\/json;base64,(\S+)/.exec(built.source)![1]!;
		expect(JSON.parse(Buffer.from(inline, "base64").toString())).not.toHaveProperty("sourcesContent");
	});

	it("hashes each input as esbuild read it; the digest is the source's hash", async () => {
		const root = await tempRoot(["contracts", "notes"]);
		const { plugins, plugin } = await discovered(root, "@test/notes");
		const built = script(await buildFacet(plugin, "worker", { ...NODE, plugins }, context));
		for (const { file, hash } of built.inputs) {
			expect(hash).toBe(
				createHash("sha256")
					.update(await readFile(file))
					.digest("hex"),
			);
		}
		expect(built.digest).toBe(createHash("sha256").update(built.source).digest("hex"));
	});

	it("gives the same script and digest from two checkout paths (relative source maps)", async () => {
		const first = await tempRoot(["contracts", "notes"]);
		const second = await tempRoot(["contracts", "notes"]);
		const builds = await Promise.all(
			[first, second].map(async (root) => {
				const { plugins, plugin } = await discovered(root, "@test/notes");
				return script(await buildFacet(plugin, "worker", { ...NODE, plugins }, context));
			}),
		);
		expect(builds[0]!.digest).toBe(builds[1]!.digest);
		expect(builds[0]!.source).toBe(builds[1]!.source);
	});

	it("inlines a package of its dependencies; keeps chord.external packages and Node builtins external on Node", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(
			root,
			"deps",
			"@test/deps",
			{
				"worker.ts": [
					'import { pad } from "pad-dep";',
					'import native from "native-dep";',
					'import { join } from "node:path";',
					'import { readFileSync } from "fs";',
					'import { pluginFile } from "@earendil-works/chord/next/plugins";',
					"export default { setup: () => [pad, native, join, readFileSync, pluginFile] };",
				].join("\n"),
			},
			{ dependencies: { "pad-dep": "1.0.0" }, chord: { external: ["native-dep"] } },
		);
		await writePackage(dir, "pad-dep", { "index.js": 'exports.pad = (s) => "pad:" + s;' });
		await writePackage(dir, "native-dep", { "index.js": "module.exports = 1;" });
		const { plugin } = await discovered(root, "@test/deps");
		const built = script(await buildFacet(plugin, "worker", NODE, context));
		expect(built.source).toContain('"pad:"');
		for (const external of ["native-dep", "node:path", "fs", "@earendil-works/chord/next/plugins"]) {
			expect(built.source).toContain(`require("${external}")`);
		}
		// Packages are no inputs: the watcher ignores node_modules.
		expect(built.inputs.map(({ file }) => file)).toEqual([join(await realpath(dir), "worker.ts")]);
	});

	it("refuses a chord.external package and a Node builtin in a browser build", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(
			root,
			"web",
			"@test/web",
			{
				"web.ts":
					'import native from "native-dep";\nimport { join } from "node:path";\nexport default { setup: () => [native, join] };',
			},
			{ chord: { external: ["native-dep"] } },
		);
		await writePackage(dir, "native-dep", { "index.js": "module.exports = 1;" });
		const { plugin } = await discovered(root, "@test/web");
		expect(errors(await buildFacet(plugin, "web", BROWSER, context))).toEqual([
			'web.ts:1:20: "native-dep": chord.external packages are for Node builds',
			'web.ts:2:22: "node:path": a Node builtin in a browser build',
		]);
	});

	it("collects a browser build's CSS into one stylesheet and its assets into content-hashed files", async () => {
		const root = await tempRoot();
		await writePlugin(root, "web", "@test/web", {
			"web.tsx": [
				'import "./notes.css";',
				'import iconUrl from "./assets/icon.svg?url";',
				"const Icon = () => <img src={iconUrl} />;",
				"export default { setup: () => Icon };",
			].join("\n"),
			"notes.css": ".notes { color: red; }",
			"assets/icon.svg": "<svg></svg>",
		});
		const { plugin } = await discovered(root, "@test/web");
		const built = script(await buildFacet(plugin, "web", BROWSER, context));
		expect(built.css?.name).toMatch(/^web-[A-Z0-9]+\.css$/);
		expect(built.css?.text).toContain(".notes{color:red}");
		expect(built.assets.map(({ name }) => name)).toEqual([expect.stringMatching(/^icon-[A-Z0-9]+\.svg$/)]);
		expect(new TextDecoder().decode(built.assets[0]!.bytes)).toBe("<svg></svg>");
		expect(built.source).toContain(`"/assets/${built.assets[0]!.name}"`);
		expect(built.source).toContain('require("react/jsx-runtime")');
	});

	it("refuses CSS and assets in a Node build", async () => {
		const root = await tempRoot();
		await writePlugin(root, "n", "@test/n", {
			"worker.ts": 'import "./a.css";\nimport url from "./icon.svg?url";\nexport default { setup: () => url };',
			"a.css": "a{}",
			"icon.svg": "<svg/>",
		});
		const { plugin } = await discovered(root, "@test/n");
		const found = errors(await buildFacet(plugin, "worker", NODE, context));
		expect(found).toEqual([
			'worker.ts:1:8: "./a.css": stylesheets and assets are for browser builds',
			expect.stringMatching(/^worker\.ts:2:17: "\.\/icon\.svg\?url": assets by URL are for browser builds/),
		]);
	});

	it("refuses import.meta.url, __dirname, __filename, a dynamic import() and top-level await, pointing to pluginFile", async () => {
		const root = await tempRoot();
		await writePlugin(root, "bad", "@test/bad", {
			"worker.ts": "export const a = import.meta.url;\nexport default { setup: () => [__dirname, __filename] };",
			"server.ts": 'export default { setup: () => import("./other.ts") };',
			"web.ts": "await Promise.resolve();\nexport default { setup: () => {} };",
			"other.ts": "export const x = 1;",
		});
		const { plugin } = await discovered(root, "@test/bad");
		const meta = errors(await buildFacet(plugin, "worker", NODE, context));
		expect(meta.length).toBeGreaterThan(0);
		for (const error of meta)
			expect(error).toMatch(/^worker\.ts:\d+:\d+: import\.meta\.url, __dirname and __filename .*pluginFile/);
		// Without `import.meta` in the file: each free `__dirname` and `__filename` at its own line (example 37).
		await writeFiles(join(root, "bad"), {
			"worker.ts": "// The globals.\nconsole.log(__dirname);\nexport default { setup: () => __filename };",
		});
		expect(errors(await buildFacet(plugin, "worker", NODE, context))).toEqual([
			expect.stringMatching(/^worker\.ts:2:13: import\.meta\.url, __dirname and __filename .*pluginFile/),
			expect.stringMatching(/^worker\.ts:3:\d+: import\.meta\.url, __dirname and __filename .*pluginFile/),
		]);
		expect(errors(await buildFacet(plugin, "server", NODE, context))).toEqual([
			expect.stringMatching(
				/^server\.ts:1:\d+: import\("\.\/other\.ts"\): a plugin script has no dynamic import .*pluginFile/,
			),
		]);
		expect(errors(await buildFacet(plugin, "web", NODE, context))).toEqual([
			"web.ts:1:1: a plugin script has no top-level await (a facet declares synchronously)",
		]);
	});

	it("refuses a path outside the plugin, a package not in its dependencies, and a package in a copied file", async () => {
		const root = await tempRoot(["contracts"]);
		await writePlugin(root, "out", "@test/out", {
			"worker.ts":
				'import { base } from "../base.ts";\nimport x from "left-out";\nexport default { setup: () => [base, x] };',
		});
		await writeFiles(root, { "base.ts": "export const base = 1;" });
		await writePlugin(root, "copier", "@test/copier", {
			"worker.ts": 'import { y } from "../shared/shared.ts";\nexport default { setup: () => y };',
		});
		await writePlugin(root, "shared", "@test/shared", {
			"shared.ts": 'import y from "some-package";\nexport { y };',
		});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const out = plugins.find(({ name }) => name === "@test/out")!;
		expect(errors(await buildFacet(out, "worker", { ...NODE, plugins }, context))).toEqual([
			'worker.ts:1:22: "../base.ts": outside the plugin (base code is reached through a host package, packages through dependencies)',
			'worker.ts:2:15: "left-out": neither a host package nor in the dependencies of plugin "@test/out"',
		]);
		const copier = plugins.find(({ name }) => name === "@test/copier")!;
		expect(errors(await buildFacet(copier, "worker", { ...NODE, plugins }, context))).toEqual([
			'../shared/shared.ts:1:15: "some-package": a file copied from plugin "@test/shared" may import only host packages and files of its own plugin',
		]);
	});

	it("returns a syntax error and a missing facet as failed results, never a throw", async () => {
		const root = await tempRoot();
		await writePlugin(root, "syntax", "@test/syntax", { "worker.ts": "export default {" });
		const { plugin } = await discovered(root, "@test/syntax");
		expect(errors(await buildFacet(plugin, "worker", NODE, context))).toEqual([
			expect.stringMatching(/^worker\.ts:1:\d+: Expected /),
		]);
		expect(await buildFacet(plugin, "server", NODE, context)).toEqual({
			kind: "failed",
			plugin: "@test/syntax",
			facet: "server",
			errors: ['plugin "@test/syntax" has no server facet'],
		});
	});
});
