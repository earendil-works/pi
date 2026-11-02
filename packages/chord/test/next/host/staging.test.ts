// Tests of staging (slice 7b §2, per plugin since slice 7c): a reload's setups and recorded factories; each kind of
// throw keeps the failing plugin on its old code, reported; recorded declarations decide an object's fate.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { hostKind, int, local, method, obj, remote, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import {
	createHost,
	defineFacet,
	type FacetHost,
	type Host,
	type PluginFacet,
	type PluginFailure,
	type StoreSelf,
} from "../../../src/next/host/index.ts";
import { defineJob } from "../../../src/next/jobs/index.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import { defineTable } from "../../../src/next/store/table.ts";
import { evolveTable } from "../../../src/next/store/table-evolve.ts";
import { flushed, memoryStore, Server } from "../support.ts";

const Store = local("app.store", { version: 1, params: {}, members: { label: str(), bump: method(undefined, int()) } });

/** Serves `Store` labelled `label`, its factory running `declare` first. */
function serveStore(label: string, declare: (self: StoreSelf) => void = () => {}) {
	return defineFacet((h: FacetHost) =>
		h.serve(Store, (_, self) => {
			declare(self);
			return { label: constant(label), bump: async () => 0 };
		}),
	);
}

/** The error of the one plugin `facets`' reload reports failed (it kept its old code). */
async function failedReload(host: Host, facets: readonly PluginFacet[]): Promise<Error> {
	const { failed } = await host.reload(facets, context);
	expect(failed).toHaveLength(1);
	return failed[0]!.error as Error;
}

describe("staging: a throw keeps the plugin on its old code, reported", () => {
	const throwing: [string, ReturnType<typeof serveStore>, string][] = [
		[
			"a setup",
			defineFacet(() => {
				throw new Error("boom");
			}),
			'plugin "@test/app": boom',
		],
		[
			"a factory",
			serveStore("v2", () => {
				throw new Error("boom");
			}),
			'plugin "@test/app", app.store: boom',
		],
		[
			"a declaration error",
			serveStore("v2", (self) => {
				self.state(defineState("d", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) }));
				self.state(defineState("d", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) }));
			}),
			'state "d" is declared twice',
		],
		[
			"a document at an older version than the object's",
			serveStore("v2", (self) =>
				self.state(defineState("doc", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) })),
			),
			"version 1 is older than its documents' (2)",
		],
		[
			"a broken accepts table",
			defineFacet((h) =>
				h.serve(Store, () => ({ label: constant("x"), bump: async () => 0 }), {
					accepts: { 7: {} } as never,
				}),
			),
			"accepts[7]: not an older version",
		],
	];
	for (const [what, facet, message] of throwing) {
		it(`${what}: the reload reports it, the plugin unchanged`, async () => {
			const host = createHost({ onError: () => {} });
			const v2 = defineState("doc", {
				schema: obj({ n: int() }),
				version: 2,
				initial: () => ({ n: 0 }),
				migrate: () => ({ n: 0 }),
			});
			await host.load([{ name: "@test/app", facet: serveStore("v1", (self) => self.state(v2)) }], context);
			const store = await host.get(Store, {}, context);
			expect((await failedReload(host, [{ name: "@test/app", facet }])).message).toContain(message);
			expect(store.label.value).toBe("v1");
			expect(store.state.value).toEqual({ kind: "live" });
			// The plugin is still the old one: reloading it with the same facet set again is a change of nothing.
			await host.close(context);
		});
	}

	it("a remote type on a host without an address is refused, as at load", async () => {
		const Remote = remote("app.remote", {
			version: 1,
			params: {},
			hostAddress: () => Server(),
			variants: { v: { state: { n: int() } } },
		});
		const host = createHost({ principal: { kind: "server" }, onError: () => {} });
		await host.load([], context);
		const facet = defineFacet((h) => h.serve(Remote, () => ({ variant: "v", members: { n: constant(1) } })));
		expect((await failedReload(host, [{ name: "@test/app", facet }])).message).toContain(
			"a host without an address serves only local types",
		);
		await host.close(context);
	});
});

describe("staging: recorded declarations decide the fate", () => {
	it("records without activating: no native opens, no reference binds, no document is made", async () => {
		const Dep = local("app.dep", { version: 1, params: {}, members: { n: int() } });
		const opened: string[] = [];
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: serveStore("v1") }], context);
		const store = await host.get(Store, {}, context);
		const facet = serveStore("v2", (self) => {
			self.open(
				async () => void opened.push("opened"),
				() => {},
			);
			self.get(Dep, {});
			self.state(defineState("fresh", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) }));
		});
		const report = await host.reload([{ name: "@test/app", facet }], context);
		// It opens natives now: a restart, whose activation opened its native once.
		expect(report.objects).toEqual([{ object: "app.store", kind: "restarted" }]);
		await flushed();
		// Neither staging nor the restart opened it: the new attempt parks on the missing `Dep` first.
		expect(opened).toEqual([]);
		expect(store.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await host.close(context);
	});

	it("a table of the new factory at a newer version than the store's restarts the object (its eager migration)", async () => {
		const store = await memoryStore();
		const V1 = defineTable("items", { version: 1, columns: { id: str(), name: str() }, key: ["id"] });
		const V2 = evolveTable(V1, (t) => t.rename("name", "title"));
		const host = createHost({ store, onError: () => {} });
		await host.load([{ name: "@test/app", facet: serveStore("v1", (self) => self.table(V1)) }], context);
		await host.get(Store, {}, context);
		const same = await host.reload(
			[{ name: "@test/app", facet: serveStore("v2", (self) => self.table(V1)) }],
			context,
		);
		expect(same.objects).toEqual([{ object: "app.store", kind: "swapped" }]);
		const newer = await host.reload(
			[{ name: "@test/app", facet: serveStore("v3", (self) => self.table(V2)) }],
			context,
		);
		expect(newer.objects).toEqual([{ object: "app.store", kind: "restarted" }]);
		await host.close(context);
		await store.close(context);
	});

	it("a job declared at its version with another schema is refused at staging", async () => {
		const Job1 = defineJob("app.job", { version: 1, args: obj({}), result: int() });
		const Job1b = defineJob("app.job", { version: 1, args: obj({ x: int() }), result: int() });
		const host = createHost({ onError: () => {} });
		const run = { run: async () => 1 };
		await host.load([{ name: "@test/app", facet: serveStore("v1", (self) => void self.job(Job1, run)) }], context);
		await host.get(Store, {}, context);
		const facet = serveStore("v2", (self) => void self.job(Job1b, run));
		expect((await failedReload(host, [{ name: "@test/app", facet }])).message).toContain(
			"schema changed without a version bump",
		);
		await host.close(context);
	});

	it("a contribution outside a host-lifetime object is a declaration error at staging", async () => {
		const Names = defineRegistry<string, string[]>("app.names", { version: 1 });
		const Page = local("app.page", { version: 1, params: { id: int() }, members: { id: int() } });
		const host = createHost({ onError: () => {} });
		const page = (contribute: boolean) =>
			defineFacet((h) =>
				h.serve(Page, ({ id }, self) => {
					if (contribute) (self as unknown as StoreSelf).contribute(Names, "x");
					return { id: constant(id) };
				}),
			);
		await host.load([{ name: "@test/app", facet: page(false) }], context);
		await host.get(Page, { id: 1 }, context);
		expect((await failedReload(host, [{ name: "@test/app", facet: page(true) }])).message).toContain(
			"self.contribute is valid only in a local type with empty params",
		);
		await host.close(context);
	});
});

describe("staging: declaration parity with an attempt (fix round 1)", () => {
	it("refuses retryOn of an attempt-owned writable, the plugin kept on its old code", async () => {
		const T = local("astra.staging", { version: 1, params: {}, members: { n: int() } });
		const oldFacet = defineFacet((h) => h.serve(T, () => ({ n: constant(1) })));
		const newFacet = defineFacet((h) =>
			h.serve(T, (_, self) => {
				self.retryOn(self.writable(0));
				return { n: constant(2) };
			}),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@astra/staging", facet: oldFacet }], context);
		const old = await host.get(T, {}, context);
		const { failed } = await host.reload([{ name: "@astra/staging", facet: newFacet }], context);
		const state = old.state.value;
		old.release();
		await host.close(context);
		expect({ failed: failed.map(({ plugin }) => plugin), state: state.kind }).toEqual({
			failed: ["@astra/staging"],
			state: "live",
		});
	});
});

describe("staging per plugin (slice 7c §4)", () => {
	const NotesV1 = local("app.notes", { version: 1, params: {}, members: { count: int() } });
	const NotesV2 = local("app.notes", { version: 2, params: {}, members: { count: int(), title: str() } });
	const View = local("app.view", { version: 1, params: {}, members: { label: str() } });
	const Extra = local("app.extra", { version: 1, params: {}, members: { n: int() } });

	/** The notes provider at `version`, labelled through its count. */
	const notes = (version: 1 | 2, count: number) =>
		defineFacet((h) =>
			version === 1
				? h.serve(NotesV1, () => ({ count: constant(count) }))
				: h.serve(NotesV2, () => ({ count: constant(count), title: constant("t") })),
		);
	/** A consumer of the notes at `version`, labelled `label` and the count it reads. */
	const view = (version: 1 | 2, label: string) =>
		defineFacet((h) =>
			h.serve(View, (_, self) => {
				const count = (version === 1 ? self.get(NotesV1, {}) : self.get(NotesV2, {})).count;
				return { label: self.derive([count], ([n]) => `${label} ${n}`) };
			}),
		);
	const throwing = defineFacet(() => {
		throw new Error("setup threw");
	});
	const failedOf = (report: { readonly failed: readonly PluginFailure[] }) =>
		report.failed.map(({ plugin, error }) => [plugin, (error as Error).message]);

	it("a failing plugin keeps its old code; the others of the reload apply", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/notes", facet: notes(1, 1) },
				{ name: "@test/store", facet: serveStore("v1") },
			],
			context,
		);
		const store = await host.get(Store, {}, context);
		const counted = await host.get(NotesV1, {}, context);
		const report = await host.reload(
			[
				{ name: "@test/notes", facet: throwing },
				{ name: "@test/store", facet: serveStore("v2") },
			],
			context,
		);
		expect(report.plugins).toEqual({ added: [], changed: ["@test/store"], removed: [] });
		expect(failedOf(report)).toEqual([["@test/notes", 'plugin "@test/notes": setup threw']]);
		expect(report.objects).toEqual([{ object: "app.store", kind: "swapped" }]);
		await flushed();
		expect([store.label.value, counted.count.value, counted.state.value]).toEqual(["v2", 1, { kind: "live" }]);
		// Fixed later, it applies as any change does.
		const fixed = await host.reload(
			[
				{ name: "@test/notes", facet: notes(1, 2) },
				{ name: "@test/store", facet: serveStore("v2") },
			],
			context,
		);
		expect([fixed.plugins.changed, fixed.failed]).toEqual([["@test/notes", "@test/store"], []]);
		await host.close(context);
	});

	it("a factory throwing in staging fails its plugin alone; an added plugin that fails is left out", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/notes", facet: notes(1, 1) },
				{ name: "@test/store", facet: serveStore("v1") },
			],
			context,
		);
		await host.get(Store, {}, context);
		const counted = await host.get(NotesV1, {}, context);
		const report = await host.reload(
			[
				{ name: "@test/extra", facet: throwing },
				{ name: "@test/notes", facet: notes(1, 2) },
				{
					name: "@test/store",
					facet: serveStore("v2", () => {
						throw new Error("factory threw");
					}),
				},
			],
			context,
		);
		expect(report.plugins).toEqual({ added: [], changed: ["@test/notes"], removed: [] });
		expect(failedOf(report)).toEqual([
			["@test/extra", 'plugin "@test/extra": setup threw'],
			["@test/store", 'plugin "@test/store", app.store: factory threw'],
		]);
		await flushed();
		expect(counted.count.value).toBe(2);
		await host.close(context);
	});

	it("the closure rule: a consumer edited together with a failing provider keeps its old code", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/notes", facet: notes(1, 1) },
				{ name: "@test/view", facet: view(1, "old") },
			],
			context,
		);
		const shown = await host.get(View, {}, context);
		const report = await host.reload(
			[
				{ name: "@test/notes", facet: throwing },
				{ name: "@test/view", facet: view(2, "new") },
			],
			context,
		);
		expect(report.plugins.changed).toEqual([]);
		expect(failedOf(report)).toEqual([
			["@test/notes", 'plugin "@test/notes": setup threw'],
			["@test/view", 'plugin "@test/view": needs app.notes v2, which plugin "@test/notes" serves on its old code'],
		]);
		expect(report.objects).toEqual([]);
		await flushed();
		expect([shown.label.value, shown.state.value]).toEqual(["old 1", { kind: "live" }]);
		// Both fixed together: both apply.
		const both = await host.reload(
			[
				{ name: "@test/notes", facet: notes(2, 5) },
				{ name: "@test/view", facet: view(2, "new") },
			],
			context,
		);
		expect([both.plugins.changed, both.failed]).toEqual([["@test/notes", "@test/view"], []]);
		await flushed();
		expect(shown.label.value).toBe("new 5");
		await host.close(context);
	});

	it("takes the plugins whose new code failed before staging (`failed`): the closure rule and the report see them", async () => {
		const host = createHost({ onError: () => {} });
		const provider = notes(1, 1);
		await host.load(
			[
				{ name: "@test/notes", facet: provider },
				{ name: "@test/view", facet: view(1, "old") },
			],
			context,
		);
		const shown = await host.get(View, {}, context);
		// Its new build failed: the caller passes its loaded facet, and says so.
		const before = [{ plugin: "@test/notes", error: new Error("build failed") }];
		const report = await host.reload(
			[
				{ name: "@test/notes", facet: provider },
				{ name: "@test/view", facet: view(2, "new") },
			],
			context,
			{ failed: before },
		);
		expect(failedOf(report)).toEqual([
			["@test/notes", "build failed"],
			["@test/view", 'plugin "@test/view": needs app.notes v2, which plugin "@test/notes" serves on its old code'],
		]);
		expect([report.plugins.changed, shown.label.value]).toEqual([[], "old 1"]);
		await host.close(context);
	});

	it("the closure rule checks a request as a real bind does, the kept provider's host address included (Astra)", async () => {
		const Here = hostKind("app.here");
		const Elsewhere = hostKind("app.elsewhere");
		const placed = (only: boolean) =>
			remote("app.provider", {
				version: 1,
				params: { id: int() },
				hostAddress: ({ id }) => (only && id !== 1 ? Elsewhere() : Here()),
				variants: { main: { state: { n: int() } } },
			});
		const Consumer = local("app.consumer", { version: 1, params: {}, members: { n: int() } });
		const consumer = (id: number) =>
			defineFacet((h) =>
				h.serve(Consumer, (_, self) => ({ n: self.derive([self.get(placed(false), { id }).n], ([n]) => n) })),
			);
		const host = createHost({ address: Here(), principal: { kind: "owner" }, onError: () => {} });
		await host.load(
			[
				// The provider's own code places every id but 1 on another host.
				{
					name: "@test/provider",
					facet: defineFacet((h) =>
						h.serve(placed(true), ({ id }) => ({ variant: "main", members: { n: constant(id) } })),
					),
				},
				{ name: "@test/consumer", facet: consumer(1) },
			],
			context,
		);
		const shown = await host.get(Consumer, {}, context);
		const report = await host.reload(
			[
				{ name: "@test/provider", facet: throwing },
				{ name: "@test/consumer", facet: consumer(2) },
			],
			context,
		);
		expect(report.failed.map(({ plugin }) => plugin)).toEqual(["@test/provider", "@test/consumer"]);
		expect([shown.state.value, shown.n.value]).toEqual([{ kind: "live" }, 1]);
		await host.close(context);
	});

	it("the closure rule covers a name nobody serves while a plugin failed, and runs to a fixpoint", async () => {
		const Middle = local("app.middle", { version: 2, params: {}, members: { n: int() } });
		const Top = local("app.top", { version: 1, params: {}, members: { n: int() } });
		const host = createHost({ onError: () => {} });
		const middle = (needs: boolean) =>
			defineFacet((h) => h.serve(Middle, (_, self) => ({ n: needs ? self.get(Extra, {}).n : constant(0) })));
		const top = (needs: boolean) =>
			defineFacet((h) => h.serve(Top, (_, self) => ({ n: needs ? self.get(Middle, {}).n : constant(0) })));
		await host.load(
			[
				{ name: "@test/middle", facet: middle(false) },
				{ name: "@test/top", facet: top(false) },
			],
			context,
		);
		await host.get(Top, {}, context);
		await host.get(Middle, {}, context);
		// The new extra plugin fails: the middle's new code needs Extra, served by nobody now; the top's new code needs
		// the middle, which keeps its old code (another version is not involved: its request binds to the old one).
		const report = await host.reload(
			[
				{ name: "@test/extra", facet: throwing },
				{ name: "@test/middle", facet: middle(true) },
				{ name: "@test/top", facet: top(true) },
			],
			context,
		);
		expect(failedOf(report)).toEqual([
			["@test/extra", 'plugin "@test/extra": setup threw'],
			["@test/middle", 'plugin "@test/middle": needs app.extra v1, which no plugin serves now (a plugin failed)'],
		]);
		expect(report.plugins.changed).toEqual(["@test/top"]);
		await host.close(context);
	});

	it("without a failing plugin, a request that does not bind is an ordinary wait: the consumer applies and parks", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/notes", facet: notes(1, 1) },
				{ name: "@test/view", facet: view(1, "old") },
			],
			context,
		);
		const shown = await host.get(View, {}, context);
		const report = await host.reload(
			[
				{ name: "@test/notes", facet: notes(1, 1) },
				{ name: "@test/view", facet: view(2, "new") },
			],
			context,
		);
		expect([report.plugins.changed, report.failed]).toEqual([["@test/notes", "@test/view"], []]);
		expect(report.objects).toEqual([
			{ object: "app.notes", kind: "swapped" },
			expect.objectContaining({ object: "app.view", kind: "parked" }),
		]);
		await flushed();
		expect(shown.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await host.close(context);
	});

	it("a type moving between plugins while its old owner fails: the new owner collides and keeps its old code too", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/a", facet: notes(1, 1) },
				{ name: "@test/b", facet: defineFacet(() => {}) },
			],
			context,
		);
		const counted = await host.get(NotesV1, {}, context);
		const report = await host.reload(
			[
				{ name: "@test/a", facet: throwing },
				{ name: "@test/b", facet: notes(1, 2) },
			],
			context,
		);
		expect(failedOf(report)).toEqual([
			["@test/a", 'plugin "@test/a": setup threw'],
			["@test/b", 'plugin "@test/b": app.notes is served twice (plugin "@test/a")'],
		]);
		expect(counted.count.value).toBe(1);
		await host.close(context);
	});
});
