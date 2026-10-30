// Tests of the plugins component (slice 7c §4, §5, §7): per plugin at startup and reload (a failing build, evaluation,
// setup; unchanged plugins untouched; added and removed plugins; the closure rule through builds), `rollout` (order,
// stopping at a rejecting step, marks), installs through the component, GC over 200 reloads, and end to end a server
// and a worker loading plugin directories, an edit rolled out, a broken edit kept old on both hosts.

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { hostKind, int, local, method, remote, str } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet, type Host, type ReloadReport } from "../../../src/next/host/index.ts";
import type { ChordHost } from "../../../src/next/host/internal.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { createPlugins, type Plugins, type RolloutStep } from "../../../src/next-node/plugins/index.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	rejection,
	settledHeap,
	transported,
	valuesOf,
} from "../../next/support.ts";
import { HOST_PACKAGES, KINDS, tempRoot, writeFiles, writePackage, writePlugin } from "./support.ts";

/** The fixtures' contracts, as the `contracts` fixture declares them. */
const Worker = hostKind("test.worker");
const Notes = remote("test.notes", {
	version: 1,
	params: {},
	hostAddress: () => Worker(),
	variants: { main: { state: { label: str(), count: int() }, methods: { add: method(undefined, int()) } } },
});
const Index = local("test.index", { version: 1, params: {}, members: { label: str() } });
const Item = local("test.item", { version: 1, params: {}, members: { label: str() } });

/** A plugin `dir` named `@test/<dir>` serving `Item` labelled `label` from its worker facet. */
async function itemPlugin(root: string, dir: string, label: string): Promise<void> {
	await writePlugin(root, dir, `@test/${dir}`, {
		"worker.ts": [
			'import { constant, defineFacet, local, str } from "@earendil-works/chord/next";',
			`const Item = local("test.${dir}", { version: 1, params: {}, members: { label: str() } });`,
			`export default defineFacet((host) => host.serve(Item, () => ({ label: constant(${JSON.stringify(label)}) })));`,
		].join("\n"),
	});
}

/** The component over `root`, its reports collected. */
function component(root: string): { plugins: Plugins; reported: unknown[] } {
	const reported: unknown[] = [];
	const plugins = createPlugins(
		{
			roots: [root],
			kinds: KINDS,
			browserKinds: ["web"],
			hostPackages: HOST_PACKAGES,
			onError: (e) => reported.push(e),
		},
		context,
	);
	return { plugins, reported };
}

/** The failures of a report as plugin names. */
const failedNames = (report: { readonly failed: readonly { readonly plugin: string }[] }) =>
	report.failed.map(({ plugin }) => plugin);

describe("per plugin at startup", () => {
	it("leaves out a plugin whose build fails, whose evaluation throws or whose setup throws; loads the others and core", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "good", "good");
		await writePlugin(root, "syntax", "@test/syntax", { "worker.ts": "export default {" });
		await writePlugin(root, "throws", "@test/throws", {
			"worker.ts": 'throw new Error("at import");\nexport default {};',
		});
		await writePlugin(root, "setup", "@test/setup", {
			"worker.ts":
				'import { defineFacet } from "@earendil-works/chord/next";\nexport default defineFacet(() => { throw new Error("in setup"); });',
		});
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		const core = defineFacet((h) => h.serve(Item, () => ({ label: constant("core") })));
		const report = await plugins.load(host, { kind: "worker", core: [{ name: "@app/core", facet: core }] }, context);
		expect(report.failed.map(({ plugin, error }) => [plugin, (error as Error).message])).toEqual([
			[
				"@test/syntax",
				expect.stringMatching(/^plugin "@test\/syntax": its worker facet failed to build:\nworker\.ts:1:/),
			],
			["@test/throws", "at import"],
			["@test/setup", 'plugin "@test/setup": in setup'],
		]);
		const Good = local("test.good", { version: 1, params: {}, members: { label: str() } });
		expect((await host.get(Good, {}, context)).label.value).toBe("good");
		expect((await host.get(Item, {}, context)).label.value).toBe("core");
		await host.close(context);
		plugins.close();
	});
});

describe("per plugin at reload", () => {
	/** A host loaded with plugins `a`, `b` and `c` (worker facets), and the component. */
	async function loaded() {
		const root = await tempRoot();
		for (const dir of ["a", "b", "c"]) await itemPlugin(root, dir, `${dir}1`);
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		const label = async (dir: string) =>
			(await host.get(local(`test.${dir}`, { version: 1, params: {}, members: { label: str() } }), {}, context))
				.label.value;
		return { root, plugins, host, label };
	}

	it("rebuilds one plugin of three: only it changes; the others are passed as the same facets, untouched", async () => {
		const { root, plugins, host, label } = await loaded();
		await itemPlugin(root, "b", "b2");
		const built = await plugins.build(["@test/b"], context);
		expect(built.facets.map(({ plugin, facet }) => [plugin, facet])).toEqual([["@test/b", "worker"]]);
		const report = await plugins.reload(host, built, context);
		expect(report.plugins).toEqual({ added: [], changed: ["@test/b"], removed: [] });
		expect(report.objects).toEqual([{ object: "test.b", kind: "swapped" }]);
		expect([await label("a"), await label("b"), await label("c")]).toEqual(["a1", "b2", "c1"]);
		// Built again unchanged: the same digest, nothing reloaded.
		const again = await plugins.reload(host, await plugins.build(["@test/b"], context), context);
		expect(again.plugins).toEqual({ added: [], changed: [], removed: [] });
		await host.close(context);
		plugins.close();
	});

	it("keeps the loaded facet of a plugin whose build fails or whose evaluation throws; the others apply", async () => {
		const { root, plugins, host, label } = await loaded();
		await writeFiles(join(root, "a"), { "worker.ts": "export default {" });
		await writeFiles(join(root, "b"), { "worker.ts": 'throw new Error("at import");\nexport default {};' });
		await itemPlugin(root, "c", "c2");
		const report = await plugins.reload(
			host,
			await plugins.build(["@test/a", "@test/b", "@test/c"], context),
			context,
		);
		expect(report.plugins).toEqual({ added: [], changed: ["@test/c"], removed: [] });
		expect(failedNames(report)).toEqual(["@test/a", "@test/b"]);
		expect([await label("a"), await label("b"), await label("c")]).toEqual(["a1", "b1", "c2"]);
		await host.close(context);
		plugins.close();
	});

	it("adds a plugin discovered since, removes one no longer there; an added plugin that fails is left out", async () => {
		const { root, plugins, host, label } = await loaded();
		await itemPlugin(root, "d", "d1");
		await writePlugin(root, "e", "@test/e", { "worker.ts": "export default {" });
		await rm(join(root, "c"), { recursive: true });
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ set: true }), { timeout: 5_000 });
		const built = await plugins.build([], context);
		expect(built.removed).toEqual(["@test/c"]);
		const report = await plugins.reload(host, built, context);
		expect(report.plugins).toEqual({ added: ["@test/d"], changed: [], removed: ["@test/c"] });
		expect(failedNames(report)).toEqual(["@test/e"]);
		expect(await label("d")).toBe("d1");
		await host.close(context);
		plugins.close();
	});

	it("keeps a consumer edited together with a provider whose new build fails (the closure rule through builds)", async () => {
		const root = await tempRoot();
		const provider = (version: number) =>
			[
				'import { constant, defineFacet, local, int } from "@earendil-works/chord/next";',
				`export const P = local("test.provider", { version: ${version}, params: {}, members: { n: int() } });`,
				`export default defineFacet((host) => host.serve(P, () => ({ n: constant(${version}) })));`,
			].join("\n");
		const consumer = (version: number) =>
			[
				'import { defineFacet, local, int, str } from "@earendil-works/chord/next";',
				`const P = local("test.provider", { version: ${version}, params: {}, members: { n: int() } });`,
				'const C = local("test.consumer", { version: 1, params: {}, members: { label: str() } });',
				`export default defineFacet((host) => host.serve(C, (_, self) => ({ label: self.derive([self.get(P, {}).n], ([n]) => "v${version} " + n) })));`,
			].join("\n");
		await writePlugin(root, "provider", "@test/provider", { "worker.ts": provider(1) });
		await writePlugin(root, "consumer", "@test/consumer", { "worker.ts": consumer(1) });
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		const C = local("test.consumer", { version: 1, params: {}, members: { label: str() } });
		const shown = await host.get(C, {}, context);
		await writeFiles(join(root, "provider"), { "worker.ts": `${provider(2)}\nexport const broken = ;` });
		await writeFiles(join(root, "consumer"), { "worker.ts": consumer(2) });
		const report = await plugins.reload(
			host,
			await plugins.build(["@test/provider", "@test/consumer"], context),
			context,
		);
		expect(failedNames(report)).toEqual(["@test/provider", "@test/consumer"]);
		expect((report.failed[1]!.error as Error).message).toBe(
			'plugin "@test/consumer": needs test.provider v2, which plugin "@test/provider" serves on its old code',
		);
		expect(shown.label.value).toBe("v1 1");
		await host.close(context);
		plugins.close();
	});
});

describe("rollout", () => {
	/** A step recording its name into `order`, answering `report`, or rejecting with `error`. */
	const step = (name: string, order: string[], outcome: { report?: ReloadReport; error?: Error }): RolloutStep => ({
		name,
		kinds: ["worker"],
		reload: async () => {
			order.push(name);
			if (outcome.error !== undefined) throw outcome.error;
			return outcome.report!;
		},
	});
	const report = (failed: readonly string[]): ReloadReport => ({
		plugins: { added: [], changed: [], removed: [] },
		failed: failed.map((plugin) => ({ plugin, error: new Error("x") })),
		objects: [],
	});

	it("runs the steps in order, clears the marks of plugins applied on every step, keeps a plugin failed on any", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		await itemPlugin(root, "b", "b1");
		const { plugins } = component(root);
		await plugins.build([], context);
		await writeFile(join(root, "a", "worker.ts"), "// a\n");
		await writeFile(join(root, "b", "worker.ts"), "// b\n");
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ dirty: ["@test/a", "@test/b"] }), {
			timeout: 5_000,
		});
		const built = await plugins.build(["@test/a", "@test/b"], context);
		const order: string[] = [];
		const result = await plugins.rollout(
			[step("server", order, { report: report([]) }), step("worker", order, { report: report(["@test/b"]) })],
			built,
			context,
		);
		expect([order, result.stopped, result.steps.map(({ name }) => name)]).toEqual([
			["server", "worker"],
			undefined,
			["server", "worker"],
		]);
		expect(plugins.state.value).toMatchObject({ dirty: ["@test/b"] });
		plugins.close();
	});

	it("stops at a step that rejects, clearing no mark; a change during the build keeps its mark", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		const { plugins } = component(root);
		await plugins.build([], context);
		await writeFile(join(root, "a", "worker.ts"), "// 1\n");
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ dirty: ["@test/a"] }), { timeout: 5_000 });
		const built = await plugins.build(["@test/a"], context);
		const order: string[] = [];
		const stopped = await plugins.rollout(
			[step("server", order, { error: new Error("closed") }), step("worker", order, { report: report([]) })],
			built,
			context,
		);
		expect([order, stopped.stopped?.step, (stopped.stopped?.error as Error).message]).toEqual([
			["server"],
			"server",
			"closed",
		]);
		expect(plugins.state.value).toMatchObject({ dirty: ["@test/a"] });
		// Saved again after the build: applied, the mark stays (the build did not include the new content).
		const later = await plugins.build(["@test/a"], context);
		await writeFile(join(root, "a", "worker.ts"), "// 2\n");
		await vi.waitFor(async () => {
			await plugins.rollout([step("server", [], { report: report([]) })], later, context);
			expect(plugins.state.value).toMatchObject({ dirty: ["@test/a"] });
		});
		plugins.close();
	});
});

describe("installs through the component", () => {
	it("clears the plugin's install mark and dirties it", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		const tools = await tempRoot();
		await writeFiles(tools, { "npm.mjs": "process.exit(0);" });
		const reported: unknown[] = [];
		const plugins = createPlugins(
			{
				roots: [root],
				kinds: KINDS,
				hostPackages: HOST_PACKAGES,
				install: { npmCommand: [process.execPath, join(tools, "npm.mjs")] },
				onError: (error) => reported.push(error),
			},
			context,
		);
		await plugins.build([], context);
		await writeFile(
			join(root, "a", "package.json"),
			JSON.stringify({ name: "@test/a", type: "module", dependencies: {} }),
		);
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ install: ["@test/a"] }), { timeout: 5_000 });
		await plugins.installDependencies("@test/a", context);
		expect(plugins.state.value).toMatchObject({ install: [], dirty: ["@test/a"] });
		expect(reported).toEqual([]);
		plugins.close();
	});
});

describe("GC", () => {
	it("collects old facets over 200 reloads; the heap stays flat after warm-up", async () => {
		const root = await tempRoot();
		const made: WeakRef<object>[] = [];
		const probe = { made: (closure: object) => void made.push(new WeakRef(closure)) };
		const source = (label: string) =>
			[
				'import { constant, defineFacet, local, str } from "@earendil-works/chord/next";',
				'import { made } from "@test/probe";',
				'const Item = local("test.gc", { version: 1, params: {}, members: { label: str() } });',
				// A closure per evaluation, which only this evaluation's code holds.
				`const state = { label: ${JSON.stringify(label)}, big: new Array(10_000).fill(${JSON.stringify(label)}) };`,
				"made(state);",
				"export default defineFacet((host) => host.serve(Item, () => ({ label: constant(state.label) })));",
			].join("\n");
		await writePlugin(root, "gc", "@test/gc", { "worker.ts": source("a") });
		const plugins = createPlugins(
			{ roots: [root], kinds: KINDS, hostPackages: { ...HOST_PACKAGES, "@test/probe": probe }, onError: () => {} },
			context,
		);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		const first = await plugins.build(["@test/gc"], context);
		await writeFiles(join(root, "gc"), { "worker.ts": source("b") });
		const second = await plugins.build(["@test/gc"], context);
		const reload = async (count: number) => {
			for (let i = 0; i < count; i++) await plugins.reload(host, i % 2 === 0 ? second : first, context);
		};
		await reload(20);
		const warm = await settledHeap();
		await reload(200);
		const after = await settledHeap();
		expect(after - warm).toBeLessThan(2 * 1024 * 1024);
		await expectCollected(...made.slice(0, made.length - 2));
		await host.close(context);
		plugins.close();
	});
});

describe("end to end: a server and a worker", () => {
	it("loads plugin directories, rolls an edit out (server, then worker), and keeps a broken edit old on both", async () => {
		type P = { readonly kind: "server" } | { readonly kind: "worker" };
		const root = await tempRoot(["contracts", "notes"]);
		const { plugins } = component(root);
		const [up, down] = memoryLinkPair();
		const worker = createHost<P>({ address: Worker(), principal: { kind: "worker" }, onError: () => {} });
		worker.connect(up, { principal: { kind: "server" } }, context);
		const server = createHost<P>({ principal: { kind: "server" }, onError: () => {} });
		server.route(
			Worker,
			{ authorize: () => true, resolve: async () => ({ link: down, principal: { kind: "worker" } }) },
			context,
		);
		await plugins.load(worker, { kind: "worker", core: [] }, context);
		await plugins.load(server, { kind: "server", core: [] }, context);
		const notes = await server.get(Notes, {}, context);
		const index = await server.get(Index, {}, context);
		expect([notes.label.value, index.label.value]).toEqual(["v1", "v1"]);
		await notes.add(context);
		const frames = changesOf(await notes.label.watch(context));
		const steps = [plugins.step("server", server as Host<P>), plugins.step("worker", worker as Host<P>)];

		await writeFile(join(root, "notes", "label.ts"), 'export const label = "v2";\n');
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ dirty: ["@test/notes"] }), { timeout: 5_000 });
		const rolled = await plugins.rollout(steps, await plugins.build(plugins.state.value.dirty, context), context);
		expect(rolled.steps.map(({ name, report }) => [name, report.plugins.changed, report.objects])).toEqual([
			["server", ["@test/notes"], [{ object: "test.index", kind: "swapped" }]],
			["worker", ["@test/notes"], [{ object: "test.notes", kind: "swapped" }]],
		]);
		await transported();
		await delivered();
		expect(valuesOf(frames)).toEqual(["v2"]);
		expect([notes.label.value, notes.count.value, index.label.value]).toEqual(["v2", 1, "v2"]);
		expect(plugins.state.value).toMatchObject({ dirty: [] });

		await writeFile(join(root, "notes", "label.ts"), "export const label = ;\n");
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ dirty: ["@test/notes"] }), { timeout: 5_000 });
		const broken = await plugins.rollout(steps, await plugins.build(plugins.state.value.dirty, context), context);
		expect(broken.steps.map(({ name, report }) => [name, failedNames(report)])).toEqual([
			["server", ["@test/notes"]],
			["worker", ["@test/notes"]],
		]);
		await transported();
		expect([notes.label.value, index.label.value, notes.state.value]).toEqual(["v2", "v2", { kind: "live" }]);
		expect(plugins.state.value).toMatchObject({ dirty: ["@test/notes"] });
		await server.close(context);
		await worker.close(context);
		plugins.close();
	});
});

describe("fix round 1", () => {
	it("serializes reloads of one host: two started together keep both changes (Astra, Sol, Opus S1)", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		await itemPlugin(root, "b", "b1");
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		await itemPlugin(root, "a", "a2");
		const builtA = await plugins.build(["@test/a"], context);
		await itemPlugin(root, "b", "b2");
		const builtB = await plugins.build(["@test/b"], context);
		const reports = await Promise.all([plugins.reload(host, builtA, context), plugins.reload(host, builtB, context)]);
		expect(reports.map(({ plugins: { changed } }) => changed)).toEqual([["@test/a"], ["@test/b"]]);
		const label = async (dir: string) =>
			(await host.get(local(`test.${dir}`, { version: 1, params: {}, members: { label: str() } }), {}, context))
				.label.value;
		expect([await label("a"), await label("b")]).toEqual(["a2", "b2"]);
		await host.close(context);
		plugins.close();
	});

	it("applies the removals of the build it was given, never a later discovery's (Astra)", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		await itemPlugin(root, "b", "b1");
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		await itemPlugin(root, "a", "a2");
		const first = await plugins.build(["@test/a"], context);
		await rm(join(root, "b"), { recursive: true });
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ set: true }), { timeout: 5_000 });
		const later = await plugins.build([], context);
		expect([first.removed, later.removed]).toEqual([[], ["@test/b"]]);
		const report = await plugins.reload(host, first, context);
		expect(report.plugins).toEqual({ added: [], changed: ["@test/a"], removed: [] });
		expect((await plugins.reload(host, later, context)).plugins.removed).toEqual(["@test/b"]);
		await host.close(context);
		plugins.close();
	});

	it("adopts what a reload committed when its wait aborts after the commit: a later reload keeps it (Astra)", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		await itemPlugin(root, "b", "b1");
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		const Item = local("test.a", { version: 1, params: {}, members: { label: str() } });
		const item = await host.get(Item, {}, context);
		await itemPlugin(root, "a", "a2");
		const first = await plugins.build(["@test/a"], context);
		// The abort lands right after the reload's commit (its publication batch), while it waits for its report.
		const { batch } = host as ChordHost;
		const commit = batch.commit.bind(batch);
		const controller = new AbortController();
		const aborting = withAbortSignal(controller.signal, context);
		const hook = vi.spyOn(batch, "commit").mockImplementation((adopt, ctx) => {
			commit(adopt, ctx);
			if (ctx === aborting) controller.abort();
		});
		expect(await rejection(plugins.reload(host, first, aborting))).toMatchObject({
			code: "aborted",
			details: { committed: { added: [], changed: ["@test/a"], removed: [], failed: [] } },
		});
		hook.mockRestore();
		expect(item.label.value).toBe("a2");
		await itemPlugin(root, "b", "b2");
		await plugins.reload(host, await plugins.build(["@test/b"], context), context);
		expect(item.label.value).toBe("a2");
		await host.close(context);
		plugins.close();
	});

	it("leaves a plugin out of a host whose kind its rebuilt facets no longer have (Opus recheck R1)", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		// The plugin keeps a server facet only.
		await rm(join(root, "a", "worker.ts"));
		await writeFiles(join(root, "a"), {
			"server.ts":
				'import { defineFacet } from "@earendil-works/chord/next";\nexport default defineFacet(() => {});',
		});
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ set: true }), { timeout: 5_000 });
		const built = await plugins.build(["@test/a"], context);
		expect(built.removed).toEqual([]);
		expect((await plugins.reload(host, built, context)).plugins).toEqual({
			added: [],
			changed: [],
			removed: ["@test/a"],
		});
		await host.close(context);
		plugins.close();
	});

	it("reloads a structured clone of a build as the build itself: it is plain data (Astra)", async () => {
		const root = await tempRoot();
		await itemPlugin(root, "a", "a1");
		const { plugins } = component(root);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		const item = await host.get(local("test.a", { version: 1, params: {}, members: { label: str() } }), {}, context);
		await itemPlugin(root, "a", "a2");
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ dirty: ["@test/a"] }), { timeout: 5_000 });
		const built = await plugins.build(["@test/a"], context);
		expect((await plugins.reload(host, structuredClone(built), context)).plugins.changed).toEqual(["@test/a"]);
		expect(item.label.value).toBe("a2");
		// The marks clear only through the build object itself (a copy carries no snapshot).
		const result = await plugins.rollout([plugins.step("worker", host)], structuredClone(built), context);
		expect(result.stopped).toBeUndefined();
		expect(plugins.state.value).toMatchObject({ dirty: ["@test/a"] });
		await host.close(context);
		plugins.close();
	});

	it("reads a changed package.json again at the next build: a new dependency is accepted (Astra, Sol)", async () => {
		const root = await tempRoot();
		const tools = await tempRoot();
		await writeFiles(tools, { "npm.mjs": "process.exit(0);" });
		const dir = await writePlugin(root, "a", "@test/a", {
			"worker.ts": 'import { label } from "./helper.ts";\nexport default { setup: () => {}, label };',
			"helper.ts": 'export const label = "old";',
		});
		const plugins = createPlugins(
			{
				roots: [root],
				kinds: KINDS,
				hostPackages: HOST_PACKAGES,
				install: { npmCommand: [process.execPath, join(tools, "npm.mjs")] },
				onError: () => {},
			},
			context,
		);
		expect((await plugins.build([], context)).facets.map(({ kind }) => kind)).toEqual(["script"]);
		await writeFiles(dir, {
			"package.json": JSON.stringify({ name: "@test/a", type: "module", dependencies: { "new-dep": "1.0.0" } }),
		});
		await vi.waitFor(() => expect(plugins.state.value).toMatchObject({ install: ["@test/a"] }), { timeout: 5_000 });
		await writePackage(dir, "new-dep", { "index.js": 'exports.label = "new";' });
		await writeFiles(dir, { "helper.ts": 'export { label } from "new-dep";' });
		await plugins.installDependencies("@test/a", context);
		expect(plugins.state.value).toMatchObject({ set: false });
		const built = await plugins.build(["@test/a"], context);
		expect(built.facets).toEqual([expect.objectContaining({ kind: "script", plugin: "@test/a" })]);
		expect(plugins.discovery.plugins[0]!.dependencies).toEqual(["new-dep"]);
		plugins.close();
	});
});

describe("the reload queues and garbage collection", () => {
	it("lets a rejected new facet go once its report is dropped, the kept old one live (Sol)", async () => {
		const root = await tempRoot();
		const made: WeakRef<object>[] = [];
		const probe = { made: (value: object) => made.push(new WeakRef(value)) };
		const source = (bad: boolean) =>
			[
				'import { constant, defineFacet, int, local } from "@earendil-works/chord/next";',
				'import { made } from "@test/probe";',
				`const state = { bad: ${bad}, big: new Array(10000).fill("payload") };`,
				"made(state);",
				'const Type = local("test.failed-gc", { version: 1, params: {}, members: { n: int() } });',
				"export default defineFacet((h) => {",
				'\tif (state.bad) throw new Error("bad setup");',
				"\th.serve(Type, () => ({ n: constant(state.big.length) }));",
				"});",
			].join("\n");
		const dir = await writePlugin(root, "failed", "@test/failed", { "worker.ts": source(false) });
		const plugins = createPlugins(
			{ roots: [root], kinds: KINDS, hostPackages: { ...HOST_PACKAGES, "@test/probe": probe }, onError: () => {} },
			context,
		);
		const host = createHost({ onError: () => {} });
		await plugins.load(host, { kind: "worker", core: [] }, context);
		await writeFiles(dir, { "worker.ts": source(true) });
		const built = await plugins.build(["@test/failed"], context);
		// The report (its failure's error holds the new facet's closure) is dropped here; the queues must not keep it.
		expect((await plugins.reload(host, built, context)).failed.map(({ plugin }) => plugin)).toEqual(["@test/failed"]);
		await expectCollected(made[1]!);
		expect(made[0]!.deref()).toBeDefined();
		await host.close(context);
		plugins.close();
	});
});
