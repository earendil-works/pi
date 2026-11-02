// Tests of testing a plugin alone (slice 12 §6): the plugin built as production builds it against the app's API
// modules, loaded on an in-memory host beside a stub serving what it uses; the registries it contributes to that nobody
// serves collected; the contracts it waits for unserved listed; a principal for the host and for a root scope.

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import * as chordNext from "../../../src/next/index.ts";
import { defineFacet, int, local, str } from "../../../src/next/index.ts";
import { testPlugin } from "../../../src/next-node/plugins/index.ts";
import { rejection } from "../../next/support.ts";
import { tempRoot, writeFiles, writePlugin } from "./support.ts";

/** The app's API v3 for the tests: Chord's surface re-exported, and a worker module with the app's `Panels`. */
const Panels = chordNext.defineRegistry<{ readonly title: string }, unknown>("acme.panels", { version: 2 });
const MODULES = { "@acme/app/v3": { ...chordNext }, "@acme/app/v3/worker": { Panels } };
const API = { name: "@acme/app", versions: ["v3"] } as const;

/** The notes contract the stats plugin uses, as the notes plugin declares it. */
const Notes = local("acme.notes", { version: 1, params: { project: str() }, members: { words: int() } });

/** The stats plugin's contract, as a test of it declares it again. */
const Stats = local("acme.stats", { version: 1, params: { project: str() }, members: { words: int() } });

/** A root with the stats plugin: serves `Stats` over `Notes`, contributes a panel, and a tag cloud over `Tags`. */
async function statsPlugin(): Promise<string> {
	const root = await tempRoot();
	return writePlugin(root, "stats", "@acme/stats", {
		"worker.ts": [
			'import { constant, defineFacet, int, local, str } from "@acme/app/v3";',
			'import { Panels } from "@acme/app/v3/worker";',
			'const Notes = local("acme.notes", { version: 1, params: { project: str() }, members: { words: int() } });',
			'const Tags = local("acme.tags", { version: 1, params: {}, members: { list: str() } });',
			'const Stats = local("acme.stats", { version: 1, params: { project: str() }, members: { words: int() } });',
			'const Cloud = local("acme.cloud", { version: 1, params: {}, members: { list: str() } });',
			"export default defineFacet((host, self) => {",
			'	self.contribute(Panels, { title: "Word count" });',
			"	host.serve(Stats, ({ project }, self) => ({ words: self.get(Notes, { project }).words }));",
			"	host.serve(Cloud, (_params, self) => ({ list: self.get(Tags, {}).list }));",
			"});",
		].join("\n"),
	});
}

/** A stub of the notes plugin: every project has 42 words. */
const notesStub = defineFacet((host) => host.serve(Notes, () => ({ words: chordNext.constant(42) })));

describe("testPlugin", () => {
	it("loads the plugin built against the API beside a stub; collects its contributions and lists what it waits for", async () => {
		const dir = await statsPlugin();
		const t = await testPlugin(
			dir,
			{
				kind: "worker",
				api: API,
				modules: MODULES,
				stubs: [{ name: "@acme/notes", facet: notesStub }],
				principal: { kind: "user", id: "u1" },
			},
			context,
		);
		const stats = await t.host.get(Stats, { project: "p1" }, context);
		expect(stats.words.value).toBe(42);
		expect(t.contributions(Panels).map(({ plugin, value }) => [plugin, value])).toEqual([
			["@acme/stats", { title: "Word count" }],
		]);
		expect(t.unserved()).toEqual(["acme.tags"]);
		expect(await t.root(async (ctx) => ctx.principal, context)).toEqual({ kind: "user", id: "u1" });
		expect(await t.root(async (ctx) => ctx.principal, context, { principal: { kind: "user", id: "u2" } })).toEqual({
			kind: "user",
			id: "u2",
		});
		expect(() => t.contributions(chordNext.defineRegistry("acme.other", { version: 1 }))).toThrow(
			"testPlugin: registry acme.other is not collected",
		);
		await t.close(context);
	});

	it("rejects a build production would refuse, and a setup that throws", async () => {
		const root = await tempRoot();
		const old = await writePlugin(root, "old", "@acme/old", {
			"worker.ts": 'import { defineFacet } from "@acme/app/v1";\nexport default defineFacet(() => {});',
		});
		expect(await rejection(testPlugin(old, { kind: "worker", api: API, modules: MODULES }, context))).toMatchObject({
			message: expect.stringContaining('"@acme/app/v1": @acme/app/v1 is not available: this app provides v3'),
		});
		const throwing = await writePlugin(root, "throwing", "@acme/throwing", {
			"worker.ts":
				'import { defineFacet } from "@acme/app/v3";\nexport default defineFacet(() => { throw new Error("no"); });',
		});
		expect(
			await rejection(testPlugin(throwing, { kind: "worker", api: API, modules: MODULES }, context)),
		).toMatchObject({ message: expect.stringMatching(/^testPlugin: setup failed: plugin "@acme\/throwing": no$/) });
	});

	it("builds as production by default: the per-kind check active, api required with versioned modules (Opus M5)", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(root, "peek", "@acme/peek", {
			"worker.ts":
				'import { defineFacet } from "@acme/app/v3";\nimport { panel } from "./contract.web.ts";\nexport default defineFacet(() => console.log(panel));',
			"contract.web.ts": 'export const panel = "panel";',
		});
		expect(await rejection(testPlugin(dir, { kind: "worker", api: API, modules: MODULES }, context))).toMatchObject({
			message: expect.stringContaining('"./contract.web.ts": a web file, imported into a worker facet'),
		});
		expect(await rejection(testPlugin(dir, { kind: "worker", modules: MODULES }, context))).toMatchObject({
			message: 'testPlugin: modules hold the app\'s versioned API ("@acme/app/v3"): pass api, as production does',
		});
	});

	it("tests a single-file plugin and a plugin in a checkout of several (Opus L4)", async () => {
		const root = await tempRoot();
		await writeFiles(root, {
			"hello.worker.ts": [
				'import { constant, defineFacet, local, str } from "@acme/app/v3";',
				'const Hello = local("acme.hello", { version: 1, params: {}, members: { text: str() } });',
				'export default defineFacet((host) => host.serve(Hello, () => ({ text: constant("hello") })));',
			].join("\n"),
		});
		const single = await testPlugin(
			join(root, "hello.worker.ts"),
			{ kind: "worker", api: API, modules: MODULES },
			context,
		);
		const Hello = local("acme.hello", { version: 1, params: {}, members: { text: str() } });
		expect((await single.host.get(Hello, {}, context)).text.value).toBe("hello");
		await single.close(context);
		// A checkout of several (its own package.json) beside another plugin of the root it copies from.
		await writePlugin(root, "words", "@acme/words", { "contract.ts": 'export const WORDS = "words";' });
		await writeFiles(join(root, "repo"), { "package.json": JSON.stringify({ name: "@bob/repo" }) });
		const inner = await writePlugin(join(root, "repo"), "counter", "@bob/counter", {
			"worker.ts": [
				'import { constant, defineFacet, local, str } from "@acme/app/v3";',
				'import { WORDS } from "../../words/contract.ts";',
				'const Count = local("bob.count", { version: 1, params: {}, members: { text: str() } });',
				"export default defineFacet((host) => host.serve(Count, () => ({ text: constant(WORDS) })));",
			].join("\n"),
		});
		const checkout = await testPlugin(inner, { kind: "worker", api: API, modules: MODULES }, context);
		const Count = local("bob.count", { version: 1, params: {}, members: { text: str() } });
		expect((await checkout.host.get(Count, {}, context)).text.value).toBe("words");
		await checkout.close(context);
	});

	it("collects until no new registry appears: an object live after the first collection contributes too (Sol)", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(root, "chain", "@acme/chain", {
			"worker.ts": [
				'import { constant, defineFacet, defineRegistry, local, str } from "@acme/app/v3";',
				'const A = defineRegistry("acme.a", { version: 1 });',
				'const B = defineRegistry("acme.b", { version: 1 });',
				'const Reader = local("acme.reader", { version: 1, params: {}, members: { s: str() } });',
				"export default defineFacet((host, self) => {",
				'\tself.contribute(A, "a");',
				'\thost.serve(Reader, (_params, self) => { self.registry(A); self.contribute(B, "b"); return { s: constant("x") }; });',
				"});",
			].join("\n"),
		});
		const t = await testPlugin(dir, { kind: "worker", api: API, modules: MODULES }, context);
		const B = chordNext.defineRegistry<string, unknown>("acme.b", { version: 1 });
		expect(t.contributions(B).map(({ value }) => value)).toEqual(["b"]);
		await t.close(context);
	});

	it("waits for slow activations a collection woke before it looks again (Opus R1)", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(root, "slow", "@acme/slow", {
			"worker.ts": [
				'import { constant, defineFacet, defineRegistry, local, str } from "@acme/app/v3";',
				'const A = defineRegistry("acme.a", { version: 1 });',
				'const B = defineRegistry("acme.b", { version: 1 });',
				'const Reader = local("acme.reader", { version: 1, params: {}, members: { s: str() } });',
				"export default defineFacet((host, self) => {",
				'\tself.contribute(A, "a");',
				"\thost.serve(Reader, (_params, self) => {",
				"\t\tself.registry(A);",
				"\t\tself.open(() => new Promise((resolve) => setTimeout(resolve, 50)), () => {});",
				'\t\tself.contribute(B, "b");',
				'\t\treturn { s: constant("x") };',
				"\t});",
				"});",
			].join("\n"),
		});
		const t = await testPlugin(dir, { kind: "worker", api: API, modules: MODULES }, context);
		const B = chordNext.defineRegistry<string, unknown>("acme.b", { version: 1 });
		expect(t.contributions(B).map(({ value }) => value)).toEqual(["b"]);
		await t.close(context);
	});

	it("serves a registry contributed at a high version without an adapter per older version (Sol)", async () => {
		const root = await tempRoot();
		const dir = await writePlugin(root, "high", "@acme/high", {
			"worker.ts":
				'import { defineFacet, defineRegistry } from "@acme/app/v3";\nconst R = defineRegistry("acme.high", { version: 2000000 });\nexport default defineFacet((_host, self) => self.contribute(R, 1));',
		});
		const started = performance.now();
		const t = await testPlugin(dir, { kind: "worker", api: API, modules: MODULES }, context);
		expect(performance.now() - started).toBeLessThan(1_000);
		const R = chordNext.defineRegistry<number, unknown>("acme.high", { version: 1 });
		expect(t.contributions(R).map(({ value }) => value)).toEqual([1]);
		await t.close(context);
	});

	it("takes no kind from test and declaration files (Opus N6)", async () => {
		const root = await tempRoot();
		await writeFiles(root, {
			"hello.worker.ts": 'import { defineFacet } from "@acme/app/v3";\nexport default defineFacet(() => {});',
			"hello.test.ts": "",
			"env.d.ts": "",
		});
		const t = await testPlugin(
			join(root, "hello.worker.ts"),
			{ kind: "worker", api: API, modules: MODULES },
			context,
		);
		expect(Object.keys(t.plugin.facets)).toEqual(["worker"]);
		await t.close(context);
	});
});
