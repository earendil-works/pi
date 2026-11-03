// Tests of building (slice 7c §2): every row of the import table, failures as results, source maps relative to the
// plugin and digests stable across two checkout paths, inputs hashed as esbuild read them.

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	type BuildOptions,
	type BuiltFacet,
	buildFacet,
	discoverPlugins,
	type Plugin,
} from "../../../src/node/plugins/index.ts";
import { KINDS, tempRoot, writeFiles, writePackage, writePlugin } from "./support.ts";

const NODE: BuildOptions = { hostPackages: ["@earendil-works/chord"], platform: "node" };
const BROWSER: BuildOptions = {
	hostPackages: ["@earendil-works/chord", "react/jsx-runtime"],
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
		expect(built.source).toContain('require("@earendil-works/chord")');
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
					'import { pluginFile } from "@earendil-works/chord/plugins";',
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
		for (const external of ["native-dep", "node:path", "fs", "@earendil-works/chord/plugins"]) {
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

	it("scopes a CSS module's class names to its file, the import giving the mapping (slice 11 §4b)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "web", "@test/web", {
			"web.ts": 'import styles from "./notes.module.css";\nexport default { setup: () => styles.card };',
			"notes.module.css": ".card { color: var(--accent); }",
		});
		const { plugin } = await discovered(root, "@test/web");
		const built = script(await buildFacet(plugin, "web", BROWSER, context));
		const scoped = /\.(chord_[0-9a-f]{8}_notes_card)\{color:var\(--accent\)\}/.exec(built.css?.text ?? "");
		expect(scoped).not.toBeNull();
		expect(built.source).toContain(`card:"${scoped![1]}"`);
		// Another plugin's `notes.module.css` gets other names.
		await writePlugin(root, "other", "@test/other", {
			"web.ts": 'import styles from "./notes.module.css";\nexport default { setup: () => styles.card };',
			"notes.module.css": ".card { color: red; }",
		});
		const other = script(await buildFacet((await discovered(root, "@test/other")).plugin, "web", BROWSER, context));
		expect(other.css?.text).toMatch(/\.chord_[0-9a-f]{8}_notes_card\{/);
		expect(other.css?.text).not.toContain(scoped![1]);
	});

	it("gives a CSS module's url() assets, its @import, composes and escaped class names (Opus L1)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "web", "@test/web", {
			"web.ts": 'import styles from "./notes.module.css";\nexport default { setup: () => styles };',
			"notes.module.css": [
				'@import "./plain.css";',
				".base { color: red; }",
				".card { composes: base; background: url(./bg.png); }",
				".café { color: blue; }",
			].join("\n"),
			"plain.css": ".plain { color: green; }",
			"bg.png": "PNG",
		});
		const { plugin } = await discovered(root, "@test/web");
		const built = script(await buildFacet(plugin, "web", BROWSER, context));
		const css = built.css?.text ?? "";
		const card = /\.(chord_[0-9a-f]{8}_notes_card)\{/.exec(css)![1]!;
		const base = /\.(chord_[0-9a-f]{8}_notes_base)\{/.exec(css)![1]!;
		// composes: the class names both; the escaped name maps from the real one.
		expect(built.source).toContain(`card:"${base} ${card}"`);
		expect(built.source).toMatch(/caf\\u00E9:"chord_[0-9a-f]{8}_notes_caf\\xE9"/);
		expect(css).toContain(".plain{color:green}");
		expect(built.assets.map(({ name }) => name)).toEqual([expect.stringMatching(/^bg-[A-Z0-9]+\.png$/)]);
		expect(css).toContain(`url("/assets/${built.assets[0]!.name}")`);
	});

	it("gives a plain stylesheet's url() an asset", async () => {
		const root = await tempRoot();
		await writePlugin(root, "web", "@test/web", {
			"web.ts": 'import "./a.css";\nexport default { setup: () => {} };',
			"a.css": ".x { background: url(./bg.png); }",
			"bg.png": "PNG",
		});
		const { plugin } = await discovered(root, "@test/web");
		const built = script(await buildFacet(plugin, "web", BROWSER, context));
		expect(built.css?.text).toContain(`url("/assets/${built.assets[0]!.name}")`);
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

	it("refuses a path leaving the root, a file in no plugin, a package not in its dependencies, a package in a copied file", async () => {
		const root = await tempRoot(["contracts"]);
		const away = await tempRoot();
		await writeFiles(away, { "far.ts": "export const far = 1;" });
		await writePlugin(root, "out", "@test/out", {
			"worker.ts": [
				'import { base } from "../base.ts";',
				`import { far } from ${JSON.stringify(join(away, "far.ts"))};`,
				'import x from "left-out";',
				"export default { setup: () => [base, far, x] };",
			].join("\n"),
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
			'worker.ts:1:22: "../base.ts": not a file of a plugin in this root',
			expect.stringMatching(
				/^worker\.ts:2:21: ".*far\.ts": outside the plugin's root \(base code is reached through a host package, other repositories' plugins through dependencies\)$/,
			),
			'worker.ts:3:15: "left-out": neither a host package nor in the dependencies of plugin "@test/out"',
		]);
		const copier = plugins.find(({ name }) => name === "@test/copier")!;
		expect(errors(await buildFacet(copier, "worker", { ...NODE, plugins }, context))).toEqual([
			'../shared/shared.ts:1:15: "some-package": a file copied from plugin "@test/shared" may import only host packages and files of its own plugin',
		]);
	});

	it("inlines another plugin's files of the same root by relative path; refuses one of another root and names by plugin name", async () => {
		const first = await tempRoot();
		const second = await tempRoot();
		await writePlugin(first, "contracts", "@test/contracts", {
			"contract.ts": 'export const name = "contract";',
			"other.ts": 'import { name } from "./contract.ts";\nexport const other = name;',
		});
		await writePlugin(second, "elsewhere", "@test/elsewhere", { "contract.ts": 'export const name = "far";' });
		await writePlugin(first, "user", "@test/user", {
			"worker.ts": [
				'import { name } from "../contracts/contract.ts";',
				'import { other } from "../contracts/other.ts";',
				"export default { setup: () => [name, other] };",
			].join("\n"),
		});
		await writePlugin(first, "far", "@test/far", {
			"worker.ts": `import { name } from ${JSON.stringify(join(second, "elsewhere", "contract.ts"))};\nexport default { setup: () => name };`,
		});
		await writePlugin(first, "named", "@test/named", {
			"worker.ts": 'import { name } from "@test/contracts/contract";\nexport default { setup: () => name };',
		});
		const { plugins } = await discoverPlugins([first, second], { kinds: KINDS }, context);
		const build = (name: string) =>
			buildFacet(plugins.find((each) => each.name === name)!, "worker", { ...NODE, plugins }, context);
		const real = await realpath(first);
		expect(script(await build("@test/user")).copied).toEqual([
			join(real, "contracts", "contract.ts"),
			join(real, "contracts", "other.ts"),
		]);
		expect(errors(await build("@test/far"))).toEqual([
			expect.stringMatching(
				/^worker\.ts:1:22: ".*": outside the plugin's root \(base code is reached through a host package/,
			),
		]);
		expect(errors(await build("@test/named"))).toEqual([
			'worker.ts:1:22: "@test/contracts/contract": neither a host package nor in the dependencies of plugin "@test/named"',
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

/** The app's API of slice 12's tests: two versions, a shared module and per-kind modules. */
const API = { name: "@acme/app", versions: ["v3", "v2"] } as const;

/** Each kind's host packages with the API: v3's shared and kind modules, and v2. */
function apiKind(kind: string): BuildOptions {
	return {
		hostPackages: ["@acme/app/v3", `@acme/app/v3/${kind}`, "@acme/app/v2"],
		platform: kind === "web" ? "browser" : "node",
		api: API,
		kinds: KINDS,
	};
}

describe("building a facet: the app's API (slice 12 §1)", () => {
	it("keeps a listed version and the kind's module external, and the plugins component's pluginFile", async () => {
		const root = await tempRoot();
		await writePlugin(root, "good", "@test/good", {
			"worker.ts": [
				'import { defineFacet } from "@acme/app/v3";',
				'import { Tools } from "@acme/app/v3/worker";',
				'import { pluginFile } from "@earendil-works/chord/plugins";',
				"export default defineFacet(() => [Tools, pluginFile]);",
			].join("\n"),
		});
		const { plugin } = await discovered(root, "@test/good");
		const built = script(await buildFacet(plugin, "worker", apiKind("worker"), context));
		expect(built.source).toContain('require("@acme/app/v3/worker")');
	});

	it("refuses an unlisted version, no version, another kind's module and Chord itself", async () => {
		const root = await tempRoot();
		await writePlugin(root, "bad", "@test/bad", {
			"worker.ts": [
				'import { a } from "@acme/app/v1";',
				'import { b } from "@acme/app";',
				'import { c } from "@acme/app/v3/web";',
				'import { d } from "@earendil-works/chord";',
				"export default { setup: () => [a, b, c, d] };",
			].join("\n"),
		});
		const { plugin } = await discovered(root, "@test/bad");
		// Chord is refused even when the app lists it as a host package.
		const options = {
			...apiKind("worker"),
			hostPackages: [...apiKind("worker").hostPackages, "@earendil-works/chord"],
		};
		expect(errors(await buildFacet(plugin, "worker", options, context))).toEqual([
			'worker.ts:1:19: "@acme/app/v1": @acme/app/v1 is not available: this app provides v3, v2',
			'worker.ts:2:19: "@acme/app": import a version of the app\'s API (this app provides v3, v2)',
			'worker.ts:3:19: "@acme/app/v3/web": not available to worker facets',
			'worker.ts:4:19: "@earendil-works/chord": plugins import Chord through the app\'s API ("@acme/app/v3"), never directly',
		]);
	});

	it("refuses two versions in one facet, naming both with their importers", async () => {
		const root = await tempRoot();
		await writePlugin(root, "mixed", "@test/mixed", {
			"worker.ts":
				'import { a } from "@acme/app/v3";\nimport { b } from "./old.ts";\nexport default { setup: () => [a, b] };',
			"old.ts": 'export { b } from "@acme/app/v2";',
		});
		const { plugin } = await discovered(root, "@test/mixed");
		expect(errors(await buildFacet(plugin, "worker", apiKind("worker"), context))).toEqual([
			"one facet imports one version of @acme/app: this one imports @acme/app/v2 (old.ts) and @acme/app/v3 (worker.ts)",
		]);
	});

	it("names the app's API in the refusal of a path leaving the root", async () => {
		const root = await tempRoot();
		const away = await tempRoot();
		await writeFiles(away, { "base.ts": "export const base = 1;" });
		await writePlugin(root, "out", "@test/out", {
			"worker.ts": `import { base } from ${JSON.stringify(join(away, "base.ts"))};\nexport default { setup: () => base };`,
		});
		const { plugin } = await discovered(root, "@test/out");
		expect(errors(await buildFacet(plugin, "worker", apiKind("worker"), context))).toEqual([
			expect.stringMatching(/base code is reached through the app's API \("@acme\/app\/v3"\)/),
		]);
	});
});

describe("building a facet: per-kind files (slice 12 §3)", () => {
	it("allows a file of the facet's own kind; refuses one of another kind, naming the chain that reached it", async () => {
		const root = await tempRoot();
		await writePlugin(root, "notes", "@test/notes", {
			"contract.ts": 'export const shared = "shared";',
			"contract.worker.ts": 'export const tools = "tools";',
			"contract.web.tsx": 'export const panel = "panel";',
			"view.ts": 'export { panel } from "./contract.web.tsx";',
			"worker.ts": [
				'import { shared } from "./contract.ts";',
				'import { tools } from "./contract.worker.ts";',
				"export default { setup: () => [shared, tools] };",
			].join("\n"),
			"server.ts": 'import { panel } from "./view.ts";\nexport default { setup: () => panel };',
		});
		const { plugins, plugin } = await discovered(root, "@test/notes");
		script(await buildFacet(plugin, "worker", { ...NODE, kinds: KINDS, plugins }, context));
		expect(errors(await buildFacet(plugin, "server", { ...NODE, kinds: KINDS, plugins }, context))).toEqual([
			'view.ts:1:23: "./contract.web.tsx": a web file, imported into a server facet (server.ts → view.ts → contract.web.tsx)',
		]);
	});

	it("checks another plugin's copied files; never a package's file names (pdfjs's pdf.worker.mjs)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "notes", "@test/notes", { "contract.web.tsx": 'export const panel = "panel";' });
		const user = await writePlugin(
			root,
			"user",
			"@test/user",
			{
				"server.ts": 'import { panel } from "../notes/contract.web.tsx";\nexport default { setup: () => panel };',
				"worker.ts":
					'import { list } from "@bob/notes/web";\nimport pdf from "pdfjs-like";\nexport default { setup: () => [list, pdf] };',
			},
			{ dependencies: { "@bob/notes": "1.0.0", "pdfjs-like": "1.0.0" } },
		);
		await writePackage(
			user,
			"@bob/notes",
			{ "contract.ts": "export const list = 1;", "contract.web.tsx": "export const list = 2;" },
			{ exports: { ".": "./contract.ts", "./web": "./contract.web.tsx" } },
		);
		await writePackage(
			user,
			"pdfjs-like",
			{
				"index.mjs": 'export { default } from "./build/pdf.worker.mjs";',
				"build/pdf.worker.mjs": "export default 1;",
			},
			{ type: "module", main: "index.mjs" },
		);
		const { plugins, plugin } = await discovered(root, "@test/user");
		const options = { ...NODE, kinds: KINDS, plugins };
		expect(errors(await buildFacet(plugin, "server", options, context))).toEqual([
			'server.ts:1:23: "../notes/contract.web.tsx": a web file, imported into a server facet (server.ts → ../notes/contract.web.tsx)',
		]);
		script(await buildFacet(plugin, "worker", options, context));
	});

	it("refuses another kind's facet file and a per-kind name of any case (Opus L1, M2)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "f", "@test/f", {
			"worker.ts":
				'import { a } from "./web.tsx";\nimport { b } from "./contract.Web.ts";\nexport default { setup: () => [a, b] };',
			"web.tsx": "export const a = 1;",
			"contract.Web.ts": "export const b = 2;",
		});
		const { plugins, plugin } = await discovered(root, "@test/f");
		expect(errors(await buildFacet(plugin, "worker", { ...NODE, kinds: KINDS, plugins }, context))).toEqual([
			'worker.ts:1:19: "./web.tsx": a web file, imported into a worker facet (worker.ts → web.tsx)',
			'worker.ts:2:19: "./contract.Web.ts": a web file, imported into a worker facet (worker.ts → contract.Web.ts)',
		]);
	});

	it("names the chain of an import cycle without hanging (Sol)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "cycle", "@test/cycle", {
			"worker.ts": 'import { value } from "./a.ts";\nexport default { setup: () => value };',
			"a.ts": 'import "./worker.ts";\nexport { value } from "./bridge.ts";',
			"bridge.ts": 'export { value } from "./bad.web.ts";',
			"bad.web.ts": "export const value = 1;",
		});
		const { plugins, plugin } = await discovered(root, "@test/cycle");
		expect(errors(await buildFacet(plugin, "worker", { ...NODE, kinds: KINDS, plugins }, context))).toEqual([
			'bridge.ts:1:23: "./bad.web.ts": a web file, imported into a worker facet (worker.ts → a.ts → bridge.ts → bad.web.ts)',
		]);
	});
});

describe("building a facet: roots under node_modules and plugin packages (slice 12 fix round 2: Opus N1, N2)", () => {
	it("builds a plugin of a root that lies under a node_modules (an app installed from npm with its plugins)", async () => {
		const app = await tempRoot();
		const root = join(app, "node_modules", "@acme", "app", "plugins");
		await writePlugin(root, "notes", "@acme/notes", {
			"worker.ts":
				'import { x } from "./helper.ts";\nimport { c } from "../contracts/contract.ts";\nexport default { setup: () => [x, c] };',
			"helper.ts": "export const x = 1;",
		});
		await writePlugin(root, "contracts", "@acme/contracts", { "contract.ts": "export const c = 1;" });
		const { plugins, plugin } = await discovered(root, "@acme/notes");
		expect(script(await buildFacet(plugin, "worker", { ...NODE, plugins }, context)).copied).toEqual([
			join(await realpath(root), "contracts", "contract.ts"),
		]);
	});

	it("checks per-kind files in a package that is plugin code (a chord field), not in a library", async () => {
		const root = await tempRoot();
		const user = await writePlugin(
			root,
			"user",
			"@test/user",
			{
				"worker.ts":
					'import { panel } from "@bob/plugins/notes/contract.web.tsx";\nexport default { setup: () => panel };',
				"server.ts": 'import { a } from "@bob/plugins/notes/web.tsx";\nexport default { setup: () => a };',
			},
			{ dependencies: { "@bob/plugins": "1.0.0" } },
		);
		await writeFiles(join(user, "node_modules", "@bob", "plugins"), {
			"package.json": JSON.stringify({ name: "@bob/plugins", chord: { plugins: ["notes"] } }),
			"notes/package.json": JSON.stringify({ name: "@bob/notes" }),
			"notes/contract.web.tsx": 'export const panel = "panel";',
			"notes/web.tsx": "export const a = 1;",
		});
		const { plugins, plugin } = await discovered(root, "@test/user");
		const options = { ...NODE, kinds: KINDS, plugins };
		expect(errors(await buildFacet(plugin, "worker", options, context))).toEqual([
			'worker.ts:1:23: "@bob/plugins/notes/contract.web.tsx": a web file, imported into a worker facet (worker.ts → node_modules/@bob/plugins/notes/contract.web.tsx)',
		]);
		expect(errors(await buildFacet(plugin, "server", options, context))).toEqual([
			'server.ts:1:19: "@bob/plugins/notes/web.tsx": a web file, imported into a server facet (server.ts → node_modules/@bob/plugins/notes/web.tsx)',
		]);
	});
});

describe("building a facet: libraries inside plugin packages (slice 12 fix round 3: Opus R2)", () => {
	it("leaves a library unchecked by kind, also one nested in a plugin package's own node_modules", async () => {
		const root = await tempRoot();
		const user = await writePlugin(
			root,
			"p",
			"@test/p",
			{ "server.ts": 'import x from "@bob/plugins/notes/contract.ts";\nexport default { setup: () => x };' },
			{ dependencies: { "@bob/plugins": "1.0.0" } },
		);
		await writeFiles(join(user, "node_modules", "@bob", "plugins"), {
			"package.json": JSON.stringify({ name: "@bob/plugins", chord: { plugins: ["./notes"] } }),
			"notes/package.json": JSON.stringify({ name: "@bob/notes", dependencies: { "pdfjs-like": "1.0.0" } }),
			"notes/contract.ts": 'import pdf from "pdfjs-like";\nexport default pdf;',
			"notes/node_modules/pdfjs-like/package.json": JSON.stringify({
				name: "pdfjs-like",
				type: "module",
				main: "index.mjs",
			}),
			"notes/node_modules/pdfjs-like/index.mjs": 'export { default } from "./build/pdf.worker.mjs";',
			"notes/node_modules/pdfjs-like/build/pdf.worker.mjs": "export default 1;",
		});
		const { plugins, plugin } = await discovered(root, "@test/p");
		script(await buildFacet(plugin, "server", { ...NODE, kinds: KINDS, plugins }, context));
	});
});

describe("building a facet: what lies outside the plugin (slice 12 fix round 1: Opus M1, Sol)", () => {
	it("refuses a package file whose real path is outside the plugin's node_modules", async () => {
		const app = await tempRoot();
		await writeFiles(app, {
			"src/core.ts": "export const SECRET = 'base code';",
			"src/package.json": '{ "name": "base", "main": "core.ts" }',
		});
		const root = join(app, "plugins");
		const a = await writePlugin(
			root,
			"a",
			"@test/a",
			{ "worker.ts": 'import { SECRET } from "base";\nexport default { setup: () => SECRET };' },
			{ dependencies: { base: "file:../../src" } },
		);
		await mkdir(join(a, "node_modules"), { recursive: true });
		// npm's `file:` dependency: a link out of node_modules.
		await symlink(join(app, "src"), join(a, "node_modules", "base"), "dir");
		const b = await writePlugin(
			root,
			"b",
			"@test/b",
			{ "worker.ts": 'import { S } from "dep";\nexport default { setup: () => S };' },
			{ dependencies: { dep: "1.0.0" } },
		);
		await writePackage(b, "dep", { "index.js": 'export { SECRET as S } from "../../../../src/core.ts";' });
		const c = await writePlugin(
			root,
			"c",
			"@test/c",
			{ "worker.ts": 'import { S } from "dep";\nexport default { setup: () => S };' },
			{ dependencies: { dep: "1.0.0" } },
		);
		await writePackage(c, "dep", { "package.json": '{ "name": "dep", "main": "index.js" }' });
		// A link inside the package pointing out of it.
		await symlink(join(app, "src", "core.ts"), join(c, "node_modules", "dep", "index.js"));
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const build = (name: string) =>
			buildFacet(plugins.find((each) => each.name === name)!, "worker", { ...NODE, plugins }, context);
		const outside = /: resolves outside the plugin's node_modules \(.*src\/core\.ts\)$/;
		expect(errors(await build("@test/a"))).toEqual([expect.stringMatching(outside)]);
		expect(errors(await build("@test/b"))).toEqual([expect.stringMatching(outside)]);
		expect(errors(await build("@test/c"))).toEqual([expect.stringMatching(outside)]);
	});

	it("refuses a facet file linked out of its plugin, or to a file of another kind (Sol)", async () => {
		const root = await tempRoot();
		const away = await tempRoot();
		await writeFiles(away, { "facet.ts": "export default { setup: () => {} };" });
		const out = await writePlugin(root, "out", "@test/out", {});
		await symlink(join(away, "facet.ts"), join(out, "worker.ts"));
		const kind = await writePlugin(root, "kind", "@test/kind", { "web.tsx": "export default { setup: () => {} };" });
		await symlink(join(kind, "web.tsx"), join(kind, "worker.ts"));
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const build = (name: string) =>
			buildFacet(plugins.find((each) => each.name === name)!, "worker", { ...NODE, kinds: KINDS, plugins }, context);
		expect(errors(await build("@test/out"))).toEqual([
			expect.stringMatching(/^worker\.ts: the facet file links out of its plugin/),
		]);
		expect(errors(await build("@test/kind"))).toEqual([
			"worker.ts: links to a web file (web.tsx), not a worker facet",
		]);
	});

	it("refuses a Node builtin in a copied file (Sol)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "other", "@test/other", {
			"contract.ts": 'import { basename } from "node:path";\nexport const value = basename("x/y");',
		});
		await writePlugin(root, "user", "@test/user", {
			"worker.ts": 'import { value } from "../other/contract.ts";\nexport default { setup: () => value };',
		});
		const { plugins, plugin } = await discovered(root, "@test/user");
		expect(errors(await buildFacet(plugin, "worker", { ...NODE, plugins }, context))).toEqual([
			'../other/contract.ts:1:26: "node:path": a file copied from plugin "@test/other" may import only host packages and files of its own plugin',
		]);
	});
});

describe("building a facet: packages through their exports (slice 12 §2)", () => {
	it("inlines a dependency's shared and per-kind contract files as its exports map them", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(
			root,
			"stats",
			"@test/stats",
			{
				"worker.ts": 'import { Notes } from "@bob/notes";\nexport default { setup: () => Notes };',
				"web.tsx": 'import { Panel } from "@bob/notes/web";\nexport default { setup: () => Panel };',
			},
			{ dependencies: { "@bob/notes": "1.0.0" } },
		);
		await writePackage(
			dir,
			"@bob/notes",
			{
				"contract.ts": 'export const Notes = "notes v1";',
				"contract.web.tsx": 'export const Panel = "panel v1";',
			},
			{ exports: { ".": "./contract.ts", "./web": "./contract.web.tsx" }, type: "module" },
		);
		const { plugin } = await discovered(root, "@test/stats");
		const worker = script(await buildFacet(plugin, "worker", { ...NODE, kinds: KINDS }, context));
		expect(worker.source).toContain("notes v1");
		const web = script(await buildFacet(plugin, "web", { ...BROWSER, kinds: KINDS }, context));
		expect(web.source).toContain("panel v1");
		// Packages are not the watcher's inputs.
		expect(worker.inputs.map(({ file }) => file)).toEqual([join(await realpath(dir), "worker.ts")]);
	});
});

describe("building a facet: single-file plugins (slice 12 §4)", () => {
	it("allows host packages only, refusing other files, packages and builtins with a pointer to a directory", async () => {
		const root = await tempRoot();
		await writeFiles(root, {
			"hello.server.ts":
				'import { defineFacet } from "@earendil-works/chord";\nexport default defineFacet(() => {});',
			"bad.server.ts": [
				'import { a } from "./hello.server.ts";',
				'import b from "some-package";',
				'import { join } from "node:path";',
				"export default { setup: () => [a, b, join] };",
			].join("\n"),
		});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const build = (name: string) =>
			buildFacet(plugins.find((each) => each.name === name)!, "server", { ...NODE, plugins }, context);
		expect(sourcesOf(script(await build("hello")))).toEqual(["hello.server.ts"]);
		const hint =
			'a single-file plugin imports only host packages (the app\'s API); make it a directory "bad/" with a package.json';
		expect(errors(await build("bad"))).toEqual([
			`bad.server.ts:1:19: "./hello.server.ts": ${hint}`,
			`bad.server.ts:2:15: "some-package": ${hint}`,
			`bad.server.ts:3:22: "node:path": ${hint}`,
		]);
	});
});
