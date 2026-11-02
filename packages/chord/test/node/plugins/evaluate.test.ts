// Tests of evaluation (slice 7c §3): host packages as the host's instances (`instanceof ChordError` across a plugin),
// default and named imports of ESM and CommonJS host packages, chord.external packages and builtins from the plugin,
// `pluginFile` and its `..` refusal (and a single-file plugin's, slice 12 §4), an import-time throw, a non-facet export,
// a refused require, a computed import(), the filename.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { local, str } from "../../../src/contracts/index.ts";
import { ChordError, isChordError } from "../../../src/data/index.ts";
import { createHost } from "../../../src/host/index.ts";
import {
	type BuiltScript,
	buildFacet,
	discoverPlugins,
	evaluateFacet,
	type Plugin,
	pluginFile,
} from "../../../src/node/plugins/index.ts";
import { expectCollected } from "../../support.ts";
import * as esmHost from "../fixtures/esm-host.ts";
import { HOST_PACKAGES, KINDS, tempRoot, writeFiles, writePackage, writePlugin } from "./support.ts";

const HOSTS = { ...HOST_PACKAGES, "esm-host": esmHost, "cjs-host": { named: "cjs named" } };

/** The fixtures' `Files` contract, as the `contracts` fixture declares it. */
const Files = local("test.files", { version: 1, params: {}, members: { text: str() } });

/** Builds `name`'s `kind` facet under `root` for Node and returns the script and the plugin. */
async function built(root: string, name: string, kind = "worker"): Promise<{ script: BuiltScript; plugin: Plugin }> {
	const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
	const plugin = plugins.find((each) => each.name === name)!;
	const result = await buildFacet(
		plugin,
		kind,
		{ hostPackages: Object.keys(HOSTS), platform: "node", plugins },
		context,
	);
	if (result.kind === "failed") throw new Error(result.errors.join("\n"));
	return { script: result, plugin };
}

/** A facet with extra members a test reads. */
type Probe = { readonly setup: () => void; readonly [name: string]: unknown };

describe("evaluating a facet", () => {
	it("gives host packages as the host's instances: a ChordError crosses the plugin as one", async () => {
		const root = await tempRoot();
		await writePlugin(root, "p", "@test/p", {
			"worker.ts": [
				'import { ChordError, defineFacet } from "@earendil-works/chord";',
				"const facet = defineFacet(() => {});",
				'export default { ...facet, made: new ChordError({ code: "unavailable", message: "m" }), is: (e: unknown) => e instanceof ChordError };',
			].join("\n"),
		});
		const { script, plugin } = await built(root, "@test/p");
		const facet = evaluateFacet(script, { hostPackages: HOSTS, plugin }) as unknown as Probe;
		expect(facet.made).toBeInstanceOf(ChordError);
		expect(isChordError(facet.made, "unavailable")).toBe(true);
		expect((facet.is as (e: unknown) => boolean)(new ChordError({ code: "unavailable", message: "x" }))).toBe(true);
	});

	it("answers default and named imports of an ESM and a CommonJS host package", async () => {
		const root = await tempRoot();
		await writePlugin(root, "p", "@test/p", {
			"worker.ts": [
				'import esm, { named as esmNamed } from "esm-host";',
				'import * as esmAll from "esm-host";',
				'import cjs, { named as cjsNamed } from "cjs-host";',
				"export default { setup: () => {}, values: [esm, esmNamed, esmAll.named, cjs, cjsNamed] };",
			].join("\n"),
		});
		const { script, plugin } = await built(root, "@test/p");
		const facet = evaluateFacet(script, { hostPackages: HOSTS, plugin }) as unknown as Probe;
		expect(facet.values).toEqual(["esm default", "esm named", "esm named", { named: "cjs named" }, "cjs named"]);
	});

	it("loads chord.external packages and Node builtins from the plugin's directory", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(
			root,
			"p",
			"@test/p",
			{
				"worker.ts":
					'import ext from "ext-dep";\nimport { basename } from "node:path";\nexport default { setup: () => {}, values: [ext, basename("/a/b")] };',
			},
			{ chord: { external: ["ext-dep"] } },
		);
		await writePackage(dir, "ext-dep", { "index.js": 'module.exports = "from the plugin";' });
		const { script, plugin } = await built(root, "@test/p");
		const facet = evaluateFacet(script, { hostPackages: HOSTS, plugin }) as unknown as Probe;
		expect(facet.values).toEqual(["from the plugin", "b"]);
	});

	it("gives each facet pluginFile for its own plugin's directory and refuses .. out of it", async () => {
		const root = await tempRoot(["contracts", "files"]);
		const { script, plugin } = await built(root, "@test/files");
		const facet = evaluateFacet(script, { hostPackages: HOSTS, plugin });
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/files", facet }], context);
		expect((await host.get(Files, {}, context)).text.value).toBe("a file of the plugin");
		await host.close(context);
		await writePlugin(root, "escape", "@test/escape", {
			"worker.ts":
				'import { pluginFile } from "@earendil-works/chord/plugins";\nexport default { setup: () => {}, escape: () => pluginFile("../files/assets/data.txt") };',
		});
		const escaping = await built(root, "@test/escape");
		const probe = evaluateFacet(escaping.script, {
			hostPackages: HOSTS,
			plugin: escaping.plugin,
		}) as unknown as Probe;
		expect(() => (probe.escape as () => string)()).toThrow(
			'pluginFile("../files/assets/data.txt"): outside the directory of plugin "@test/escape"',
		);
		// Outside an evaluated facet it has none.
		expect(() => pluginFile("x")).toThrow("only a plugin's facet script");
	});

	it("refuses pluginFile in a single-file plugin: it has no directory of its own (slice 12 §4)", async () => {
		const root = await tempRoot();
		await writeFiles(root, {
			"lone.worker.ts":
				'import { pluginFile } from "@earendil-works/chord/plugins";\nexport default { setup: () => {}, read: () => pluginFile("x.txt") };',
		});
		const { script, plugin } = await built(root, "lone");
		const probe = evaluateFacet(script, { hostPackages: HOSTS, plugin }) as unknown as Probe;
		expect(() => (probe.read as () => string)()).toThrow(
			'pluginFile("x.txt"): single-file plugin "lone" has no directory of its own',
		);
	});

	it("throws an import-time throw, a non-facet export and a refused require, naming the facet", async () => {
		const root = await tempRoot();
		await writePlugin(root, "p", "@test/p", {
			"worker.ts": 'throw new Error("import time");\nexport default { setup: () => {} };',
			"server.ts": "export default 42;",
		});
		const thrown = await built(root, "@test/p");
		expect(() => evaluateFacet(thrown.script, { hostPackages: HOSTS, plugin: thrown.plugin })).toThrow("import time");
		const notFacet = await built(root, "@test/p", "server");
		expect(() => evaluateFacet(notFacet.script, { hostPackages: HOSTS, plugin: notFacet.plugin })).toThrow(
			'plugin "@test/p" (server): its default export is not a facet (defineFacet)',
		);
		const handmade: BuiltScript = {
			...thrown.script,
			source: '(function (require, module, exports) { require("nope"); })',
		};
		expect(() => evaluateFacet(handmade, { hostPackages: HOSTS, plugin: thrown.plugin })).toThrow(
			'plugin "@test/p" (worker): "nope" is not a host package, a Node builtin or one of its chord.external packages',
		);
	});

	it("runs a computed import() through the facet's require: an unknown one names the facet (Astra)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "dynamic", "@test/dynamic", {
			"worker.ts": [
				'import { defineFacet } from "@earendil-works/chord";',
				"const later = (specifier: string) => import(specifier);",
				"export default { ...defineFacet(() => {}), later };",
			].join("\n"),
		});
		const { script, plugin } = await built(root, "@test/dynamic");
		// The fixture attaches its computed import to the facet.
		const { later } = evaluateFacet(script, { hostPackages: HOSTS, plugin }) as unknown as {
			later: (specifier: string) => Promise<{ readonly named?: string }>;
		};
		await expect(later("missing-package")).rejects.toThrow(
			'plugin "@test/dynamic" (worker): "missing-package" is not a host package',
		);
		expect((await later("cjs-host")).named).toBe("cjs named");
	});

	it("runs a script under a stable filename per plugin, kind and digest", async () => {
		const root = await tempRoot();
		await writePlugin(root, "p", "@test/p", {
			"worker.ts": 'export default { setup: () => {}, fail: () => { throw new Error("x"); } };',
		});
		const { script, plugin } = await built(root, "@test/p");
		const facet = evaluateFacet(script, { hostPackages: HOSTS, plugin }) as unknown as Probe;
		let stack = "";
		try {
			(facet.fail as () => void)();
		} catch (error) {
			stack = (error as Error).stack!;
		}
		expect(stack).toContain(`/chord-plugins/@test/p/worker.ts?${script.digest}:`);
	});
});

describe("a computed require refuses what the build refuses (slice 12 fix round 1, Sol)", () => {
	it("refuses another version of the app's API, Chord itself, and builtins in a single-file plugin", async () => {
		const root = await tempRoot();
		const api = { name: "@acme/app", versions: ["v3", "v2"] };
		const modules = { "@acme/app/v3": { value: 3 }, "@acme/app/v2": { value: 2 }, "@earendil-works/chord": {} };
		const join = (...parts: string[]) => `[${parts.map((part) => JSON.stringify(part)).join(", ")}].join("/")`;
		await writePlugin(root, "mixed", "@test/mixed", {
			"worker.ts": [
				'import { value } from "@acme/app/v3";',
				`export default { setup: () => {}, other: () => require(${join("@acme/app", "v2")}), chord: () => require(${join("@earendil-works", "chord", "next")}), same: () => require(${join("@acme/app", "v3")}).value + value };`,
			].join("\n"),
		});
		await writeFiles(root, {
			"lone.worker.ts": 'export default { setup: () => {}, builtin: () => require(["node", "path"].join(":")) };',
		});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const options = { hostPackages: Object.keys(modules), platform: "node", api, kinds: KINDS, plugins } as const;
		const evaluated = async (name: string) => {
			const plugin = plugins.find((each) => each.name === name)!;
			const built = await buildFacet(plugin, "worker", options, context);
			if (built.kind === "failed") throw new Error(built.errors.join("\n"));
			return evaluateFacet(built, { hostPackages: modules, plugin }) as unknown as Probe;
		};
		const mixed = await evaluated("@test/mixed");
		expect((mixed.same as () => number)()).toBe(6);
		expect(() => (mixed.other as () => unknown)()).toThrow(
			'"@acme/app/v2": this script uses @acme/app/v3: one facet uses one version of the API',
		);
		expect(() => (mixed.chord as () => unknown)()).toThrow("plugins import Chord through the app's API");
		// Without a static import the first version required pins the facet's (Opus N3).
		await writePlugin(root, "computed", "@test/computed", {
			"worker.ts": `export default { setup: () => {}, both: () => [require(${join("@acme/app", "v3")}).value, require(${join("@acme/app", "v2")}).value] };`,
		});
		const fresh = await discoverPlugins([root], { kinds: KINDS }, context);
		const computedPlugin = fresh.plugins.find((each) => each.name === "@test/computed")!;
		const computedBuilt = await buildFacet(computedPlugin, "worker", { ...options, plugins: fresh.plugins }, context);
		if (computedBuilt.kind === "failed") throw new Error(computedBuilt.errors.join("\n"));
		const computed = evaluateFacet(computedBuilt, {
			hostPackages: modules,
			plugin: computedPlugin,
		}) as unknown as Probe;
		expect(() => (computed.both as () => unknown)()).toThrow(
			'"@acme/app/v2": this script uses @acme/app/v3: one facet uses one version of the API',
		);
		const lone = await evaluated("lone");
		expect(() => (lone.builtin as () => unknown)()).toThrow(
			'"node:path": a single-file plugin requires only host packages',
		);
	});
});

describe("ESM host packages' wrappers", () => {
	it("wraps a namespace once, and keeps no namespace nobody else holds", async () => {
		const root = await tempRoot();
		await writePlugin(root, "p", "@test/p", {
			"worker.ts": 'import * as ns from "fake-esm";\nexport default { setup: () => {}, ns };',
		});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const plugin = plugins[0]!;
		const result = await buildFacet(plugin, "worker", { hostPackages: ["fake-esm"], platform: "node" }, context);
		if (result.kind === "failed") throw new Error(result.errors.join("\n"));
		// What `Object.prototype.toString` calls a module namespace.
		const evaluate = (namespace: object) =>
			evaluateFacet(result, { hostPackages: { "fake-esm": namespace }, plugin }) as unknown as Probe;
		// Wrapping reads each export once: twice evaluated, read once.
		let reads = 0;
		const namespace = {
			[Symbol.toStringTag]: "Module",
			get named() {
				reads++;
				return 1;
			},
		};
		expect([
			(evaluate(namespace).ns as { named: number }).named,
			(evaluate(namespace).ns as { named: number }).named,
		]).toEqual([1, 1]);
		expect(reads).toBe(1);
		const ref = (() => {
			const dropped = { [Symbol.toStringTag]: "Module", named: 2 };
			expect((evaluate(dropped).ns as { named: number }).named).toBe(2);
			return new WeakRef(dropped);
		})();
		await expectCollected(ref);
	});
});
