// Tests of stack traces (slice 7c §3, decision Q1 (b)): `mapStack` names plugin files and lines through each
// evaluated script's source map; nothing global; a script's map goes with its facet.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import {
	type BuiltScript,
	buildFacet,
	discoverPlugins,
	evaluateFacet,
	mapStack,
	type Plugin,
} from "../../../src/next-node/plugins/index.ts";
import { expectCollected, settledHeap } from "../../next/support.ts";
import { HOST_PACKAGES, KINDS, tempRoot, writePlugin } from "./support.ts";

/** A plugin `notes` whose worker facet's `fail` throws from `helper.ts` line 3. */
async function failing(): Promise<{ script: BuiltScript; plugin: Plugin }> {
	const root = await tempRoot();
	await writePlugin(root, "notes", "@test/notes", {
		"worker.ts": 'import { helper } from "./helper.ts";\nexport default { setup: () => {}, fail: () => helper() };',
		"helper.ts":
			'// A helper.\nexport function helper(): never {\n\tthrow new Error("helper failed at " + Date.now());\n}',
	});
	const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
	const plugin = plugins[0]!;
	const built = await buildFacet(
		plugin,
		"worker",
		{ hostPackages: Object.keys(HOST_PACKAGES), platform: "node" },
		context,
	);
	if (built.kind === "failed") throw new Error(built.errors.join("\n"));
	return { script: built, plugin };
}

/** The error `facet`'s `fail` throws. */
function thrownBy(facet: object): unknown {
	try {
		(facet as { readonly fail: () => void }).fail();
	} catch (error) {
		return error;
	}
	throw new Error("fail did not throw");
}

describe("mapStack", () => {
	it("maps a plugin script's positions to the plugin's files and lines; other lines stay; nothing global", async () => {
		const { script, plugin } = await failing();
		const prepare = Error.prepareStackTrace;
		const facet = evaluateFacet(script, { hostPackages: HOST_PACKAGES, plugin });
		const error = thrownBy(facet);
		const mapped = mapStack(error);
		expect(mapped).toMatch(/at \S+ \(notes\/helper\.ts:3:8\)/);
		expect(mapped).toMatch(/notes\/worker\.ts:2:\d+/);
		expect(mapped).not.toContain("/chord-plugins/");
		// The raw stack is untouched: no `Error.prepareStackTrace` of the component's.
		expect((error as Error).stack).toContain("/chord-plugins/@test/notes/worker.ts?");
		expect(Error.prepareStackTrace).toBe(prepare);
		expect(mapStack("not an error")).toBe("not an error");
	});

	it("lets a script's source map go with its facet", async () => {
		const { script, plugin } = await failing();
		const error = await (async () => {
			const facet = evaluateFacet(script, { hostPackages: HOST_PACKAGES, plugin });
			return { error: thrownBy(facet), ref: new WeakRef(facet) };
		})();
		expect(mapStack(error.error)).toContain("notes/helper.ts:3:8");
		await expectCollected(error.ref);
		// The finalization runs after the collection.
		for (let round = 0; round < 10 && mapStack(error.error).includes("notes/helper.ts"); round++) await settledHeap();
		expect(mapStack(error.error)).toContain("/chord-plugins/@test/notes/worker.ts?");
	});
});

describe("mapStack, fix round 1", () => {
	it("maps an import-time throw (the map is registered before the script runs) (Sol)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "evaluation", "@test/evaluation", {
			"worker.ts":
				'// An import-time throw.\n\nthrow new Error("at import");\nexport default { setup: () => {} };\n',
		});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const plugin = plugins[0]!;
		const built = await buildFacet(plugin, "worker", { hostPackages: [], platform: "node" }, context);
		if (built.kind === "failed") throw new Error(built.errors.join("\n"));
		let failure: unknown;
		try {
			evaluateFacet(built, { hostPackages: {}, plugin });
		} catch (error) {
			failure = error;
		}
		expect(mapStack(failure)).toContain("evaluation/worker.ts:3:");
	});

	it("maps a throw while its default export is read (a getter) (Sol)", async () => {
		const root = await tempRoot();
		await writePlugin(root, "getter", "@test/getter", {
			"worker.ts": '// A getter failure.\nexport default {\n\tget setup() { throw new Error("getter boom"); } };\n',
		});
		const { plugins } = await discoverPlugins([root], { kinds: KINDS }, context);
		const plugin = plugins[0]!;
		const built = await buildFacet(plugin, "worker", { hostPackages: [], platform: "node" }, context);
		if (built.kind === "failed") throw new Error(built.errors.join("\n"));
		let failure: unknown;
		try {
			evaluateFacet(built, { hostPackages: {}, plugin });
		} catch (error) {
			failure = error;
		}
		expect(mapStack(failure)).toContain("getter/worker.ts:3:");
	});

	it("keeps a script's map while any evaluation of it lives: two hosts share it (Sol, Opus N3)", async () => {
		const { script, plugin } = await failing();
		const first = evaluateFacet(script, { hostPackages: HOST_PACKAGES, plugin });
		const second = (() => new WeakRef(evaluateFacet(script, { hostPackages: HOST_PACKAGES, plugin })))();
		await expectCollected(second);
		for (let round = 0; round < 5; round++) await settledHeap();
		expect(mapStack(thrownBy(first))).toContain("notes/helper.ts:3:8");
	});
});
