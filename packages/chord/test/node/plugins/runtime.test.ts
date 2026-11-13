// Tests of the plugin runtime (slice 10 §3, D11): loading and reloading hosts with complete sets of shipped scripts
// (unchanged digests kept as the same facet, removed = loaded minus shipped, failed builds and evaluations kept old),
// a required root's failed plugin rejecting `load`, and that importing it loads no esbuild.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { local, str } from "../../../src/contracts/index.ts";
import { createHost } from "../../../src/host/index.ts";
import {
	buildFacet,
	createPluginRuntime,
	discoverPlugins,
	PluginError,
	type PluginScript,
} from "../../../src/node/plugins/index.ts";
import { rejection } from "../../support.ts";
import { HOST_PACKAGES, tempRoot, writePlugin } from "./support.ts";

/** Writes plugin `@test/<dir>` serving `test.<dir>` labelled `label` from its worker facet (or `source` as it is). */
async function plugin(root: string, dir: string, label: string, source?: string): Promise<void> {
	await writePlugin(root, dir, `@test/${dir}`, {
		"worker.ts":
			source ??
			[
				'import { constant, defineFacet, local, str } from "@earendil-works/chord";',
				`const Item = local("test.${dir}", { version: 1, params: {}, members: { label: str() } });`,
				`export default defineFacet((host) => host.serve(Item, () => ({ label: constant(${JSON.stringify(label)}) })));`,
			].join("\n"),
	});
}

/** The worker scripts of every plugin under `root`, built now: what the server would ship. */
async function shipped(root: string): Promise<PluginScript[]> {
	const { plugins } = await discoverPlugins([root], { kinds: ["worker"] }, context);
	const options = { hostPackages: Object.keys(HOST_PACKAGES), platform: "node", plugins } as const;
	return Promise.all(
		plugins.map(async (each) => ({ plugin: each, built: await buildFacet(each, "worker", options, context) })),
	);
}

/** The label `test.<dir>` shows on `host`. */
async function label(host: ReturnType<typeof createHost>, dir: string): Promise<string> {
	const Item = local(`test.${dir}`, { version: 1, params: {}, members: { label: str() } });
	return (await host.get(Item, {}, context)).label.value;
}

describe("loading and reloading with complete sets", () => {
	it("loads a set and leaves out a plugin whose build or evaluation failed, reported with the host's report", async () => {
		const root = await tempRoot();
		await plugin(root, "a", "a1");
		await plugin(root, "broken", "", "export const = ;");
		await plugin(root, "throws", "", 'throw new Error("at import");');
		const runtime = createPluginRuntime();
		const host = createHost({ onError: () => {} });
		const report = await runtime.load(
			host,
			{ kind: "worker", core: [], scripts: await shipped(root), modules: HOST_PACKAGES },
			context,
		);
		expect(report.failed.map(({ plugin }) => plugin).sort()).toEqual(["@test/broken", "@test/throws"]);
		expect(await label(host, "a")).toBe("a1");
		await host.close(context);
	});

	it("reloads a complete set: same digests unchanged, a changed one applied, a loaded one not shipped removed", async () => {
		const root = await tempRoot();
		await plugin(root, "a", "a1");
		await plugin(root, "b", "b1");
		await plugin(root, "c", "c1");
		const runtime = createPluginRuntime();
		const host = createHost({ onError: () => {} });
		await runtime.load(
			host,
			{ kind: "worker", core: [], scripts: await shipped(root), modules: HOST_PACKAGES },
			context,
		);
		await plugin(root, "b", "b2");
		const next = (await shipped(root)).filter(({ plugin }) => plugin.name !== "@test/c");
		const report = await runtime.reload(host, next, context);
		expect(report.plugins).toEqual({ added: [], changed: ["@test/b"], removed: ["@test/c"] });
		expect([await label(host, "a"), await label(host, "b")]).toEqual(["a1", "b2"]);
		await host.close(context);
	});

	it("keeps the loaded facet of a plugin whose new build or evaluation failed; an added failing one is left out", async () => {
		const root = await tempRoot();
		await plugin(root, "a", "a1");
		const runtime = createPluginRuntime();
		const host = createHost({ onError: () => {} });
		await runtime.load(
			host,
			{ kind: "worker", core: [], scripts: await shipped(root), modules: HOST_PACKAGES },
			context,
		);
		await plugin(root, "a", "", "export const = ;");
		await plugin(root, "new", "", 'throw new Error("at import");');
		const report = await runtime.reload(host, await shipped(root), context);
		expect(report.failed.map(({ plugin }) => plugin).sort()).toEqual(["@test/a", "@test/new"]);
		expect(report.plugins).toEqual({ added: [], changed: [], removed: [] });
		expect(await label(host, "a")).toBe("a1");
		await host.close(context);
	});
});

describe("required roots at load (slice 12 §1)", () => {
	it("rejects with a PluginError naming a required plugin that failed, after the host's load settled", async () => {
		const app = await tempRoot();
		const user = await tempRoot();
		await plugin(app, "core", "core");
		await plugin(app, "broken", "", "export const = ;");
		await plugin(user, "flaky", "", 'throw new Error("at import");');
		const { plugins } = await discoverPlugins([{ path: app, required: true }, user], { kinds: ["worker"] }, context);
		const options = { hostPackages: Object.keys(HOST_PACKAGES), platform: "node", plugins } as const;
		const scripts = await Promise.all(
			plugins.map(async (each) => ({ plugin: each, built: await buildFacet(each, "worker", options, context) })),
		);
		const host = createHost({ onError: () => {} });
		const error = await rejection(
			createPluginRuntime().load(host, { kind: "worker", core: [], scripts, modules: HOST_PACKAGES }, context),
		);
		expect(error).toBeInstanceOf(PluginError);
		const failure = error as PluginError;
		expect(failure.message).toMatch(
			/^required plugin failed at load: "@test\/broken": plugin "@test\/broken": its worker facet failed to build/,
		);
		expect(failure.required.map(({ plugin }) => plugin)).toEqual(["@test/broken"]);
		expect(failure.failed.map(({ plugin }) => plugin).sort()).toEqual(["@test/broken", "@test/flaky"]);
		// The load settled: the required root's other plugin is loaded.
		expect(await label(host, "core")).toBe("core");
		await host.close(context);
	});

	it("only reports a failed plugin of a root that is not required", async () => {
		const user = await tempRoot();
		await plugin(user, "flaky", "", 'throw new Error("at import");');
		const host = createHost({ onError: () => {} });
		const report = await createPluginRuntime().load(
			host,
			{ kind: "worker", core: [], scripts: await shipped(user), modules: HOST_PACKAGES },
			context,
		);
		expect(report.failed.map(({ plugin }) => plugin)).toEqual(["@test/flaky"]);
		await host.close(context);
	});
});

describe("the runtime's imports", () => {
	it("loads no esbuild: a worker that only evaluates never imports it", () => {
		const runtime = fileURLToPath(new URL("../../../src/node/plugins/runtime.ts", import.meta.url));
		// A hook refusing esbuild, then the runtime imported.
		const script = [
			'import { registerHooks } from "node:module";',
			"registerHooks({ resolve(specifier, context, next) {",
			'  if (specifier === "esbuild") throw new Error("esbuild imported");',
			"  return next(specifier, context);",
			"} });",
			`const { createPluginRuntime } = await import(${JSON.stringify(runtime)});`,
			"createPluginRuntime();",
			'console.log("ok");',
		].join("\n");
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", script],
			{ encoding: "utf8" },
		);
		expect(output.trim()).toBe("ok");
	});
});
