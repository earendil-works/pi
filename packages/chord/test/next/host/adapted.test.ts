// Tests of adapted members (Q10, §22, slice 7b §7): consumers bound at an older version a provider accepts read its
// state mapped (diffs per commit), call it with mapped arguments and results or its replacement of a removed method,
// read keyed members mapped per key, and are refused a member the provider refuses.

import { describe, expect, it } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, evolve, int, keyed, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { AdaptedMembers } from "../../../src/next/host/adapted.ts";
import { createHost, defineFacet, type FacetHost, type Host } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	flushed,
	instancesOf,
	metered,
	rejection,
	valuesOf,
} from "../support.ts";

/** v1: a list of texts, `add` taking a text and returning the count, `clear`, keyed notes of a title. */
const NotesV1 = local("app.notes", {
	version: 1,
	params: {},
	members: {
		items: arr(str()),
		add: method(obj({ text: str() }), int()),
		clear: method(),
		notes: keyed(obj({ title: str() })),
	},
});

/** v2: items carry a tag, `add` takes one and returns an object, `clear` is gone, notes have a body. */
const NotesV2 = evolve(NotesV1, (e) =>
	e
		.state("items", arr(obj({ text: str(), tag: str() })))
		.method("add", obj({ text: str(), tag: str() }), obj({ count: int() }))
		.removeMethod("clear")
		.keyed("notes", obj({ title: str(), body: str() })),
);

const Items = defineState("items", {
	schema: obj({ items: arr(obj({ text: str(), tag: str() })) }),
	version: 1,
	initial: () => ({ items: [] }),
});

const Notes = defineState("notes", {
	schema: obj({ title: str(), body: str() }),
	version: 1,
	initial: () => ({ title: "", body: "" }),
	keyed: true,
});

/** Serves `NotesV2`, accepting v1 consumers (`clear` replaced, or refused with `refuse`). */
function serveV2(h: FacetHost, refuse = false): void {
	const clears: string[] = [];
	h.serve(
		NotesV2,
		(_, self) => {
			const items = self.state(Items);
			const notes = self.state(Notes);
			return {
				items: self.derive([items], ([value]) => value.items),
				notes,
				add: async ({ text, tag }: { text: string; tag: string }, ctx: Context) => {
					await items.change((draft) => void draft.items.push({ text, tag }), ctx);
					await notes.change(
						text,
						(draft) => {
							draft.title = text;
							draft.body = tag;
						},
						ctx,
					);
					return { count: items.value.items.length };
				},
			};
		},
		{
			accepts: {
				1: {
					state: { items: (current) => current.map(({ text }) => text) },
					methods: {
						add: { args: (old) => ({ text: old.text, tag: "v1" }), result: (current) => current.count },
						clear: refuse
							? "refuse"
							: {
									call: async () => {
										clears.push("clear");
										return null;
									},
								},
					},
					keyed: { notes: refuse ? "refuse" : (current) => ({ title: current.title }) },
				},
			},
		},
	);
}

describe("an older consumer of a provider's accepted version", () => {
	it("reads state mapped, with diffs per commit; its calls are mapped forwards and their results back", async () => {
		const { telemetry, counts } = await metered();
		const host = createHost({ telemetry, onError: () => {} });
		await host.load([{ name: "@test/app", facet: defineFacet((h) => serveV2(h)) }], context);
		const old = await host.get(NotesV1, {}, context);
		const items = changesOf(await old.items.watch(context));
		expect(await old.add({ text: "a" }, context)).toBe(1);
		expect(await old.add({ text: "b" }, context)).toBe(2);
		await delivered();
		expect(items).toEqual([
			{ kind: "value", value: ["a"], ops: [["p", [], 0, 0, ["a"]]], retired: false },
			{ kind: "value", value: ["a", "b"], ops: [["p", [], 1, 0, ["b"]]], retired: false },
		]);
		// Once for the watch's first value, then once per commit: never per consumer or per read.
		expect(counts()["chord.contract.adapts"]).toBe(3);
		expect(old.items.value).toEqual(["a", "b"]);
		expect(counts()["chord.contract.adapts"]).toBe(3);
		await host.close(context);
	});

	it("calls the provider's replacement of a removed method; a refused one fails contract_mismatch", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: defineFacet((h) => serveV2(h)) }], context);
		const old = await host.get(NotesV1, {}, context);
		expect(await old.clear(context)).toBeNull();
		await host.close(context);
	});

	it("is refused a binding whose member the provider refuses: it waits contract_mismatch", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: defineFacet((h) => serveV2(h, true)) }], context);
		const old = host.hold(NotesV1, {}, context);
		await flushed();
		expect(old.state.value).toMatchObject({
			kind: "failed",
			cause: { kind: "waiting", error: { code: "contract_mismatch" } },
		});
		expect(await rejection(old.clear(context))).toMatchObject({ code: "contract_mismatch" });
		await host.close(context);
	});

	it("reads keyed members mapped per key: get, watch and a factory's at(key)", async () => {
		const View = local("app.view", { version: 1, params: { key: str() }, members: { title: str() } });
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@test/app", facet: defineFacet((h) => serveV2(h)) },
				{
					name: "@test/view",
					facet: defineFacet((h) =>
						h.serve(View, ({ key }, self) => {
							const note = self.get(NotesV1, {}).notes.at(key);
							return { title: self.derive([note], ([value]) => value.title) };
						}),
					),
				},
			],
			context,
		);
		const old = await host.get(NotesV1, {}, context);
		await old.add({ text: "a" }, context);
		expect(await old.notes.get("a", context)).toEqual({ title: "a" });
		const watch = (await old.notes.watch("a", context))!;
		expect(watch.value).toEqual({ title: "a" });
		const view = await host.get(View, { key: "a" }, context);
		expect(view.title.value).toBe("a");
		await host.close(context);
	});
});

describe("reload: adapted members follow the provider's topology (fix round 1)", () => {
	it("rebuilds a changed-member adapter as a whole-state adapter when a later version removes it", async () => {
		const V1 = local("astra.adapt", { version: 1, params: {}, members: { n: int() } });
		const V2 = evolve(V1, (e) => e.state("n", obj({ value: int() })));
		const V3 = evolve(V2, (e) => e.removeState("n").addState("m", int()));
		const host = createHost({ onError: () => {} });
		const first = defineFacet((h) =>
			h.serve(V2, () => ({ n: constant({ value: 5 }) }), { accepts: { 1: { state: { n: (n) => n.value } } } }),
		);
		const second = defineFacet((h) =>
			h.serve(V3, () => ({ m: constant(9) }), { accepts: { 1: { state: { n: (s) => s.m } } } }),
		);
		await host.load([{ name: "@astra/adapt", facet: first }], context);
		const old = await host.get(V1, {}, context);
		expect(old.n.value).toBe(5);
		await host.reload([{ name: "@astra/adapt", facet: second }], context);
		await flushed();
		let actual: unknown;
		try {
			actual = old.n.value;
		} catch (error) {
			actual = error;
		}
		old.release();
		await host.close(context);
		expect(actual).toBe(9);
	});

	it("maps existing local watches when the consumer's current version becomes an accepted older one", async () => {
		const V1 = local("sol.state", { version: 1, params: {}, members: { x: int() } });
		const V2 = evolve(V1, (e) => e.state("x", obj({ n: int() })));
		const host = createHost({ onError: () => {} });
		try {
			await host.load(
				[{ name: "@sol/state", facet: defineFacet((h) => h.serve(V1, () => ({ x: constant(1) }))) }],
				context,
			);
			const old = await host.get(V1, {}, context);
			const calls = changesOf(await old.x.watch(context));
			await host.reload(
				[
					{
						name: "@sol/state",
						facet: defineFacet((h) =>
							h.serve(V2, () => ({ x: constant({ n: 7 }) }), {
								accepts: { 1: { state: { x: (value) => value.n } } },
							}),
						),
					},
				],
				context,
			);
			(await host.get(V2, {}, context)).release();
			await delivered();
			expect(valuesOf(calls)).toEqual([7]);
		} finally {
			await host.close(context);
		}
	});

	it("rebuilds an existing adapted member's dependencies when a later provider removes that member", async () => {
		const V1 = local("sol.removed-member", { version: 1, params: {}, members: { x: int() } });
		const V2 = evolve(V1, (e) => e.state("x", obj({ n: int() })));
		const V3 = evolve(V2, (e) => e.removeState("x").addState("y", int()));
		const host = createHost({ onError: () => {} });
		try {
			await host.load(
				[
					{
						name: "@sol/state",
						facet: defineFacet((h) =>
							h.serve(V2, () => ({ x: constant({ n: 2 }) }), {
								accepts: { 1: { state: { x: (value) => value.n } } },
							}),
						),
					},
				],
				context,
			);
			const old = await host.get(V1, {}, context);
			expect(old.x.value).toBe(2);
			await host.reload(
				[
					{
						name: "@sol/state",
						facet: defineFacet((h) =>
							h.serve(V3, () => ({ y: constant(7) }), {
								accepts: {
									1: { state: { x: (state) => state.y } },
									2: { state: { x: (state) => ({ n: state.y }) } },
								},
							}),
						),
					},
				],
				context,
			);
			(await host.get(V3, {}, context)).release();
			expect(old.state.value.kind).toBe("live");
			expect(old.x.value).toBe(7);
		} finally {
			await host.close(context);
		}
	});
});

describe("reload: adapted members publish one coherent frame (fix round 1)", () => {
	it("does not publish the new mapping applied to the old attempt's state", async () => {
		const V1 = local("astra.atomic", { version: 1, params: {}, members: { n: int() } });
		const V2 = evolve(V1, (e) => e.state("n", int()));
		const facet = (n: number, factor: number) =>
			defineFacet((h) =>
				h.serve(V2, () => ({ n: constant(n) }), { accepts: { 1: { state: { n: (v) => v * factor } } } }),
			);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@astra/atomic", facet: facet(2, 2) }], context);
		const old = await host.get(V1, {}, context);
		const watch = await old.n.watch(context);
		const changes = changesOf(watch);
		await delivered();
		expect(old.n.value).toBe(4);
		await host.reload([{ name: "@astra/atomic", facet: facet(3, 3) }], context);
		await flushed();
		await delivered();
		const values = changes.map((call) => (call.kind === "value" ? call.value : "failed"));
		await watch.stop();
		old.release();
		await host.close(context);
		expect(values).toEqual([9]);
	});

	it("never computes a new accepted-version mapping over the old provider shape", async () => {
		const V1 = local("sol.mapping-publication", { version: 1, params: {}, members: { x: int() } });
		const V2 = evolve(V1, (e) => e.state("x", obj({ n: int() })));
		const V3 = evolve(V2, (e) => e.state("x", obj({ wrapped: obj({ n: int() }) })));
		const host = createHost({ onError: () => {} });
		try {
			await host.load(
				[
					{
						name: "@sol/state",
						facet: defineFacet((h) =>
							h.serve(V2, () => ({ x: constant({ n: 2 }) }), {
								accepts: { 1: { state: { x: (value) => value.n } } },
							}),
						),
					},
				],
				context,
			);
			const old = await host.get(V1, {}, context);
			const calls = changesOf(await old.x.watch(context));
			await host.reload(
				[
					{
						name: "@sol/state",
						facet: defineFacet((h) =>
							h.serve(V3, () => ({ x: constant({ wrapped: { n: 7 } }) }), {
								accepts: {
									1: { state: { x: (value) => value.wrapped.n } },
									2: { state: { x: (value) => value.wrapped } },
								},
							}),
						),
					},
				],
				context,
			);
			(await host.get(V3, {}, context)).release();
			await delivered();
			expect(valuesOf(calls)).toEqual([7]);
		} finally {
			await host.close(context);
		}
	});
});

describe("reload: an older consumer across a removal (fix round 1)", () => {
	it("keeps an older watch open and heals it after the type is served again", async () => {
		const V1 = local("sol.older-removal", { version: 1, params: {}, members: { x: int() } });
		const V2 = evolve(V1, (e) => e.state("x", obj({ n: int() })));
		const facet = (n: number) =>
			defineFacet((h) =>
				h.serve(V2, () => ({ x: constant({ n }) }), { accepts: { 1: { state: { x: (value) => value.n } } } }),
			);
		const host = createHost({ onError: () => {} });
		try {
			await host.load([{ name: "@sol/older", facet: facet(1) }], context);
			const old = await host.get(V1, {}, context);
			const watch = await old.x.watch(context);
			const calls = changesOf(watch);
			await host.reload([], context);
			await host.reload([{ name: "@sol/older", facet: facet(7) }], context);
			(await host.get(V2, {}, context)).release();
			await delivered();
			// The removal's failure once, then the re-served value, whole.
			expect(valuesOf(calls)).toEqual([{ failed: "sol.older-removal is not served here" }, 7]);
		} finally {
			await host.close(context);
		}
	});
});

describe("reload: keyed members of an older version follow the provider (fix round 1)", () => {
	it("updates an open old-version watch when only its mapping changes", async () => {
		const V1 = local("astra.keyed", { version: 1, params: {}, members: { rows: keyed(int()), set: method(int()) } });
		const V2 = evolve(V1, (e) => e.keyed("rows", obj({ n: int() })));
		const Rows = defineState("rows", {
			version: 1,
			schema: obj({ n: int() }),
			initial: () => ({ n: 0 }),
			keyed: true,
		});
		const facet = (factor: number) =>
			defineFacet((h) =>
				h.serve(
					V2,
					(_, self) => {
						const rows = self.state(Rows);
						return {
							rows,
							set: async (n, ctx) => {
								await rows.change(
									"a",
									(draft) => {
										draft.n = n;
									},
									ctx,
								);
								return null;
							},
						};
					},
					{ accepts: { 1: { keyed: { rows: (current) => current.n * factor } } } },
				),
			);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@astra/keyed", facet: facet(2) }], context);
		const old = await host.get(V1, {}, context);
		await old.set(3, context);
		const watch = (await old.rows.watch("a", context))!;
		expect(watch.value).toBe(6);
		watch.start(async () => {});
		await host.reload([{ name: "@astra/keyed", facet: facet(4) }], context);
		await flushed();
		await old.set(5, context);
		await delivered();
		const actual = watch.value;
		const fresh = await old.rows.get("a", context);
		await watch.stop();
		old.release();
		await host.close(context);
		expect({ actual, fresh }).toEqual({ actual: 20, fresh: 20 });
	});

	it("updates mappings of an existing older watch and factory pin", async () => {
		const V1 = local("sol.keyed", {
			version: 1,
			params: {},
			members: { entries: keyed(obj({ old: int() })), set: method(int()) },
		});
		const V2 = evolve(V1, (e) => e.keyed("entries", obj({ n: int() })));
		const V3 = evolve(V2, (e) => e.keyed("entries", obj({ n: int() })));
		const Doc = defineState("entries", {
			version: 1,
			schema: obj({ n: int() }),
			keyed: true,
			initial: () => ({ n: 0 }),
		});
		const View = local("sol.keyed.view", { version: 1, params: {}, members: { old: int() } });
		const view = defineFacet((h) =>
			h.serve(View, (_, self) => {
				const pin = self.get(V1, {}).entries.at("k");
				return { old: self.derive([pin], ([value]) => value.old) };
			}),
		);
		const host = createHost({ onError: () => {} });
		try {
			await host.load(
				[
					{
						name: "@sol/keyed",
						facet: defineFacet((h) =>
							h.serve(
								V2,
								(_, self) => {
									const entries = self.state(Doc);
									return {
										entries,
										set: async (n: number, ctx: Context) => {
											await entries.change(
												"k",
												(draft) => {
													draft.n = n;
												},
												ctx,
											);
											return null;
										},
									};
								},
								{ accepts: { 1: { keyed: { entries: (value) => ({ old: value.n }) } } } },
							),
						),
					},
					{ name: "@sol/view", facet: view },
				],
				context,
			);
			const old = await host.get(V1, {}, context);
			const reader = await host.get(View, {}, context);
			await old.set(1, context);
			const watch = (await old.entries.watch("k", context))!;
			const calls = changesOf(watch);
			await host.reload(
				[
					{
						name: "@sol/keyed",
						facet: defineFacet((h) =>
							h.serve(
								V3,
								(_, self) => {
									const entries = self.state(Doc);
									return {
										entries,
										set: async (n: number, ctx: Context) => {
											await entries.change(
												"k",
												(draft) => {
													draft.n = n;
												},
												ctx,
											);
											return null;
										},
									};
								},
								{
									accepts: {
										1: { keyed: { entries: (value) => ({ old: value.n * 10 }) } },
										2: { keyed: { entries: (value) => value } },
									},
								},
							),
						),
					},
					{ name: "@sol/view", facet: view },
				],
				context,
			);
			(await host.get(V3, {}, context)).release();
			await old.set(2, context);
			await delivered();
			expect(valuesOf(calls).at(-1)).toEqual({ old: 20 });
			expect(reader.old.value).toBe(20);
		} finally {
			await host.close(context);
		}
	});
});

describe("adapted members' lifetime (fix round 1)", () => {
	const adapted = instancesOf(AdaptedMembers, "member");

	it("drops an older version's adapted members when its last consumer leaves, while the object lives on", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@test/app", facet: defineFacet((h) => serveV2(h)) }], context);
		const current = await host.get(NotesV2, {}, context);
		const from = adapted.length;
		const old = await host.get(NotesV1, {}, context);
		expect(old.items.value).toEqual([]);
		expect(adapted.length).toBeGreaterThan(from);
		// The older version's: those of the version shown stay while the object lives (the mappings read them).
		const older = adapted.slice(from).filter((ref) => ref.deref()?.version === 1);
		expect(older.length).toBeGreaterThan(0);
		old.release();
		await flushed();
		await expectCollected(...older);
		expect(current.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});
});

describe("reload: keyed members unchanged at a consumer's version follow a later mapping (fix round 1)", () => {
	const RowsV1 = local("app.rows", {
		version: 1,
		params: {},
		members: { rows: keyed(obj({ n: int() })), set: method(int()) },
	});
	/** v2 adds a member: `rows` is unchanged for v1 consumers. */
	const RowsV2 = evolve(RowsV1, (e) => e.addState("extra", int()));
	/** v3 changes `rows` (same shape): v1 and v2 consumers read it mapped. */
	const RowsV3 = evolve(RowsV2, (e) => e.keyed("rows", obj({ n: int() })));
	const Rows = defineState("rows", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }), keyed: true });
	const View = local("app.rows.view", { version: 1, params: {}, members: { n: int() } });
	const ten = (value: { readonly n: number }) => ({ n: value.n * 10 });

	/** Serves `contract` with its keyed rows, `set` writing row "k", and `accepts`. */
	function rows(contract: typeof RowsV1 | typeof RowsV2 | typeof RowsV3, accepts: object) {
		return defineFacet((h) =>
			h.serve(
				contract as typeof RowsV3,
				(_, self) => {
					const docs = self.state(Rows);
					const set = async (n: number, ctx: Context) => {
						await docs.change(
							"k",
							(draft) => {
								draft.n = n;
							},
							ctx,
						);
						return null;
					};
					return (contract === RowsV1 ? { rows: docs, set } : { rows: docs, set, extra: constant(0) }) as never;
				},
				{ accepts } as never,
			),
		);
	}

	/** A v1 consumer's factory pin of row "k". */
	const view = defineFacet((h) =>
		h.serve(View, (_, self) => {
			const pin = self.get(RowsV1, {}).rows.at("k");
			return { n: self.derive([pin], ([value]) => value.n) };
		}),
	);

	/** Loads `first`, watches and pins row "k" as a v1 consumer, reloads to `second`, sets 2 and reads all three. */
	async function across(first: ReturnType<typeof rows>, second: ReturnType<typeof rows>) {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@app/rows", facet: first },
				{ name: "@app/view", facet: view },
			],
			context,
		);
		const old = await host.get(RowsV1, {}, context);
		const reader = await host.get(View, {}, context);
		await old.set(1, context);
		const watch = (await old.rows.watch("k", context))!;
		watch.start(async () => {});
		await host.reload(
			[
				{ name: "@app/rows", facet: second },
				{ name: "@app/view", facet: view },
			],
			context,
		);
		await flushed();
		await old.set(2, context);
		await delivered();
		const result = { watch: watch.value, get: await old.rows.get("k", context), pin: reader.n.value };
		await watch.stop();
		old.release();
		reader.release();
		await host.close(context);
		return result;
	}

	it("re-maps a key watched and pinned at the provider's current version once a later provider maps it", async () => {
		const result = await across(
			rows(RowsV1, {}),
			rows(RowsV3, { 1: { keyed: { rows: ten } }, 2: { keyed: { rows: ten } } }),
		);
		expect(result).toEqual({ watch: { n: 20 }, get: { n: 20 }, pin: 20 });
	});

	it("re-maps a key of an older version its provider left unchanged once a later provider maps it", async () => {
		const result = await across(
			rows(RowsV2, { 1: {} }),
			rows(RowsV3, { 1: { keyed: { rows: ten } }, 2: { keyed: { rows: ten } } }),
		);
		expect(result).toEqual({ watch: { n: 20 }, get: { n: 20 }, pin: 20 });
	});
});

describe("reload: keyed sources of an older version through a removal (fix round 2)", () => {
	const V1 = local("app.keyed.removal", {
		version: 1,
		params: {},
		members: { rows: keyed(int()), set: method(int()) },
	});
	const V2 = evolve(V1, (e) => e.keyed("rows", obj({ n: int() })));
	const Rows = defineState("rows", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }), keyed: true });
	const View = local("app.keyed.removal.view", { version: 1, params: {}, members: { n: int() } });
	const keyMappings = instancesOf(AdaptedMembers, "key");

	/** Serves `V2`, mapping its rows to v1 times `factor`; `set` writes row "a". */
	const rows = (factor: number) =>
		defineFacet((h) =>
			h.serve(
				V2,
				(_, self) => {
					const docs = self.state(Rows);
					const set = async (n: number, ctx: Context) => {
						await docs.change(
							"a",
							(draft) => {
								draft.n = n;
							},
							ctx,
						);
						return null;
					};
					return { rows: docs, set };
				},
				{ accepts: { 1: { keyed: { rows: (current) => current.n * factor } } } },
			),
		);

	/** A v1 consumer's factory pin of row "a". */
	const view = defineFacet((h) =>
		h.serve(View, (_, self) => {
			const pin = self.get(V1, {}).rows.at("a");
			return { n: self.derive([pin], ([value]) => value) };
		}),
	);

	it("re-maps an open older keyed watch and a factory pin through the re-served provider (Astra, Sol)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@app/rows", facet: rows(2) },
				{ name: "@app/view", facet: view },
			],
			context,
		);
		const old = await host.get(V1, {}, context);
		const reader = await host.get(View, {}, context);
		await old.set(3, context);
		const watch = (await old.rows.watch("a", context))!;
		const calls = changesOf(watch);
		expect([watch.value, reader.n.value]).toEqual([6, 6]);
		await host.reload([{ name: "@app/view", facet: view }], context);
		await flushed();
		// Frozen while the type is gone: the last mapped value.
		expect(watch.value).toBe(6);
		await host.reload(
			[
				{ name: "@app/rows", facet: rows(4) },
				{ name: "@app/view", facet: view },
			],
			context,
		);
		await flushed();
		await old.set(5, context);
		await delivered();
		expect({ watch: watch.value, get: await old.rows.get("a", context), pin: reader.n.value }).toEqual({
			watch: 20,
			get: 20,
			pin: 20,
		});
		expect(valuesOf(calls).at(-1)).toBe(20);
		await watch.stop();
		old.release();
		reader.release();
		await host.close(context);
	});

	it("keeps no removed instance's mappings once the reference moved, its watch open (decision: references only)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/rows", facet: rows(2) }], context);
		const from = keyMappings.length;
		const old = await host.get(V1, {}, context);
		await old.set(3, context);
		const watch = (await old.rows.watch("a", context))!;
		watch.start(async () => {});
		// The removed instance's mapping of the key: nothing of it outlives it through the reference.
		const removed = keyMappings.slice(from);
		expect(removed.length).toBeGreaterThan(0);
		await host.reload([], context);
		await host.reload([{ name: "@app/rows", facet: rows(4) }], context);
		// The re-served object's documents start over (no store here).
		await old.set(3, context);
		await delivered();
		expect(watch.value).toBe(12);
		await expectCollected(...removed);
		await watch.stop();
		old.release();
		await host.close(context);
	});
});

describe("reload: a version refusal keeps the waiting reference's last values (fix round 2)", () => {
	const V1 = local("app.version.return", { version: 1, params: {}, members: { n: int() } });
	const V2 = evolve(V1, (e) => e.state("n", obj({ value: int() })));
	const accepted = (value: number) =>
		defineFacet((h) =>
			h.serve(V2, () => ({ n: constant({ value }) }), { accepts: { 1: { state: { n: (v) => v.value } } } }),
		);
	const refused = defineFacet((h) => h.serve(V2, () => ({ n: constant({ value: 2 }) })));

	it("keeps an older watch open while its version is refused and heals it when it is accepted again (Astra)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/version", facet: accepted(4) }], context);
		const old = await host.get(V1, {}, context);
		const watch = await old.n.watch(context);
		const calls = changesOf(watch);
		let closed = false;
		void watch.closed.then(() => {
			closed = true;
		});
		await host.reload([{ name: "@app/version", facet: refused }], context);
		await delivered();
		expect(old.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		// Its last mapped value, read directly too.
		expect([watch.value, old.n.value]).toEqual([4, 4]);
		await host.reload([{ name: "@app/version", facet: accepted(9) }], context);
		await delivered();
		expect({ closed, watch: watch.value, read: old.n.value, last: valuesOf(calls).at(-1) }).toEqual({
			closed: false,
			watch: 9,
			read: 9,
			last: 9,
		});
		old.release();
		await host.close(context);
	});

	it("heals a watch of the previous current version once a later provider accepts it (Sol)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[{ name: "@app/version", facet: defineFacet((h) => h.serve(V1, () => ({ n: constant(1) }))) }],
			context,
		);
		const old = await host.get(V1, {}, context);
		const calls = changesOf(await old.n.watch(context));
		await host.reload([{ name: "@app/version", facet: refused }], context);
		(await host.get(V2, {}, context)).release();
		expect(old.state.value.kind).toBe("failed");
		await host.reload([{ name: "@app/version", facet: accepted(3) }], context);
		(await host.get(V2, {}, context)).release();
		await delivered();
		expect(old.state.value.kind).toBe("live");
		expect(valuesOf(calls).at(-1)).toBe(3);
		old.release();
		await host.close(context);
	});
});

describe("reload: watches of one version across a rollback (fix round 2)", () => {
	it("keeps both generations of v1 watches after v1 to v2 to v1 to v2 (Sol)", async () => {
		const V1 = local("app.rollback", { version: 1, params: {}, members: { x: int() } });
		const V2 = evolve(V1, (e) => e.state("x", obj({ n: int() })));
		const v1 = (n: number) => defineFacet((h) => h.serve(V1, () => ({ x: constant(n) })));
		const v2 = (n: number) =>
			defineFacet((h) =>
				h.serve(V2, () => ({ x: constant({ n }) }), { accepts: { 1: { state: { x: (value) => value.n } } } }),
			);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/rollback", facet: v1(1) }], context);
		const first = await host.get(V1, {}, context);
		const firstCalls = changesOf(await first.x.watch(context));
		await host.reload([{ name: "@app/rollback", facet: v2(2) }], context);
		(await host.get(V2, {}, context)).release();
		await host.reload([{ name: "@app/rollback", facet: v1(3) }], context);
		const second = await host.get(V1, {}, context);
		const secondCalls = changesOf(await second.x.watch(context));
		await host.reload([{ name: "@app/rollback", facet: v2(4) }], context);
		(await host.get(V2, {}, context)).release();
		await delivered();
		expect(valuesOf(firstCalls)).toEqual([2, 3, 4]);
		expect(valuesOf(secondCalls)).toEqual([4]);
		expect(second.x.value).toBe(4);
		first.release();
		second.release();
		await host.close(context);
	});
});

describe("reload: an older consumer's reads while its type is removed (fix round 2)", () => {
	const V1 = local("app.removed.value", { version: 1, params: {}, members: { n: int(), gone: int() } });
	const V2 = evolve(V1, (e) => e.state("n", obj({ value: int() })).removeState("gone"));
	const facet = defineFacet((h) =>
		h.serve(V2, () => ({ n: constant({ value: 5 }) }), {
			accepts: { 1: { state: { n: (v) => v.value, gone: (state) => state.n.value + 1 } } },
		}),
	);

	it("reads its last mapped value, not the provider's raw shape, a member read before or not (Astra)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/removed", facet }], context);
		const old = await host.get(V1, {}, context);
		expect(old.n.value).toBe(5);
		await host.reload([], context);
		// `gone` was never read before the removal: the current version has no such member.
		expect({ n: old.n.value, gone: old.gone.value }).toEqual({ n: 5, gone: 6 });
		old.release();
		await host.close(context);
	});
});

describe("reload: an older consumer's first read during a parked swap (fix round 2)", () => {
	it("maps with the provider whose attempt is shown until the new one goes live (Sol)", async () => {
		const V1 = local("app.lazy", { version: 1, params: {}, members: { x: int() } });
		const V2 = evolve(V1, (e) => e.state("x", obj({ n: int() })));
		const Missing = local("app.lazy.missing", { version: 1, params: {}, members: {} });
		const host = createHost({ onError: () => {} });
		await host.load(
			[{ name: "@app/lazy", facet: defineFacet((h) => h.serve(V1, () => ({ x: constant(1) }))) }],
			context,
		);
		const old = await host.get(V1, {}, context);
		// Nothing read before the swap: the first read comes while the new attempt parks on a missing dependency.
		const v2 = defineFacet((h) =>
			h.serve(
				V2,
				(_, self) => {
					self.get(Missing, {});
					return { x: constant({ n: 7 }) };
				},
				{ accepts: { 1: { state: { x: (value) => value.n } } } },
			),
		);
		await host.reload([{ name: "@app/lazy", facet: v2 }], context);
		await delivered();
		expect(old.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect(old.x.value).toBe(1);
		const calls = changesOf(await old.x.watch(context));
		await host.reload(
			[
				{ name: "@app/lazy", facet: v2 },
				{ name: "@app/missing", facet: defineFacet((h) => h.serve(Missing, () => ({}))) },
			],
			context,
		);
		await delivered();
		expect(old.state.value).toEqual({ kind: "live" });
		expect([old.x.value, valuesOf(calls).at(-1)]).toEqual([7, 7]);
		old.release();
		await host.close(context);
	});
});

describe("reload: references keep their last values through a removal, a refusal and an end while they wait (fix round 3)", () => {
	const V1 = local("app.waiting", {
		version: 1,
		params: { id: int() },
		members: { rows: keyed(int()), set: method(int()) },
	});
	const V2 = evolve(V1, (e) => e.keyed("rows", obj({ n: int() })));
	const Rows = defineState("rows", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 0 }), keyed: true });
	const keyMappings = instancesOf(AdaptedMembers, "key");

	/** Serves `V2`, `set` writing row "a"; mapping v1's rows times `factor`, or refusing v1 without one. */
	const rows = (factor?: number) =>
		defineFacet((h) =>
			h.serve(
				V2,
				(_, self) => {
					const docs = self.state(Rows);
					const set = async (n: number, ctx: Context) => {
						await docs.change(
							"a",
							(draft) => {
								draft.n = n;
							},
							ctx,
						);
						return null;
					};
					return { rows: docs, set };
				},
				factor === undefined ? {} : { accepts: { 1: { keyed: { rows: (current) => current.n * factor } } } },
			),
		);

	/** A v1 reference to object `id` with row "a" at 3 and an open, started watch of it. */
	async function watched(host: Host, id: number) {
		const old = await host.get(V1, { id }, context);
		await old.set(3, context);
		const watch = (await old.rows.watch("a", context))!;
		const calls = changesOf(watch);
		let closed = false;
		void watch.closed.then(() => {
			closed = true;
		});
		return { old, watch, calls, closed: () => closed };
	}

	it("keeps an older keyed watch when the refusal idles its object, which ends (Astra)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/rows", facet: rows(2) }], context);
		const { old, watch, closed } = await watched(host, 1);
		expect(watch.value).toBe(6);
		// v1 refused: its only holder waits, so the object (with params) ends; its pinned keys wait too.
		await host.reload([{ name: "@app/rows", facet: rows() }], context);
		await flushed();
		expect(old.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		await host.reload([{ name: "@app/rows", facet: rows(4) }], context);
		await old.set(5, context);
		await delivered();
		expect({ closed: closed(), watch: watch.value, get: await old.rows.get("a", context) }).toEqual({
			closed: false,
			watch: 20,
			get: 20,
		});
		old.release();
		await host.close(context);
	});

	it("keeps an older keyed watch through a refusal and then a removal of its type (Sol)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/rows", facet: rows(2) }], context);
		const { old, calls, closed } = await watched(host, 1);
		const current = await host.get(V2, { id: 1 }, context);
		await host.reload([{ name: "@app/rows", facet: rows() }], context);
		await delivered();
		expect(old.state.value.kind).toBe("failed");
		current.release();
		await host.reload([], context);
		await host.reload([{ name: "@app/rows", facet: rows(4) }], context);
		await old.set(3, context);
		await delivered();
		expect([closed(), valuesOf(calls).at(-1)]).toEqual([false, 12]);
		old.release();
		await host.close(context);
	});

	it("keeps no removed instance's mappings while its keyed watch stays open (Sol)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/rows", facet: rows(2) }], context);
		const from = keyMappings.length;
		const { old, watch } = await watched(host, 1);
		const removed = keyMappings.slice(from);
		expect(removed.length).toBeGreaterThan(0);
		await host.reload([], context);
		await host.reload([{ name: "@app/rows", facet: rows(4) }], context);
		await old.set(3, context);
		await delivered();
		expect(watch.value).toBe(12);
		// The watch is still open: what it follows now is the re-served object's instance.
		await expectCollected(...removed);
		old.release();
		await host.close(context);
	});

	it("reads an older member never read before at its last mapped value after a refusal (Astra)", async () => {
		const State1 = local("app.waiting.state", { version: 1, params: {}, members: { n: int() } });
		const State2 = evolve(State1, (e) => e.state("n", obj({ value: int() })));
		const serve = (value: number, accepts: boolean) =>
			defineFacet((h) =>
				h.serve(
					State2,
					() => ({ n: constant({ value }) }),
					accepts ? { accepts: { 1: { state: { n: (v) => v.value } } } } : {},
				),
			);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/state", facet: serve(4, true) }], context);
		const old = await host.get(State1, {}, context);
		await host.reload([{ name: "@app/state", facet: serve(9, false) }], context);
		await flushed();
		expect(old.n.value).toBe(4);
		old.release();
		await host.close(context);
	});

	it("follows a newer consumer through two rollbacks, its last value kept while refused (Sol)", async () => {
		const X1 = local("app.waiting.rollback", { version: 1, params: {}, members: { x: int() } });
		const X2 = evolve(X1, (e) => e.state("x", obj({ n: int() })));
		const v1 = (n: number) => defineFacet((h) => h.serve(X1, () => ({ x: constant(n) })));
		const v2 = (n: number) =>
			defineFacet((h) =>
				h.serve(X2, () => ({ x: constant({ n }) }), { accepts: { 1: { state: { x: (value) => value.n } } } }),
			);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/rollback", facet: v2(1) }], context);
		const held = await host.get(X2, {}, context);
		const calls = changesOf(await held.x.watch(context));
		for (const [back, ahead] of [
			[2, 3],
			[4, 5],
		]) {
			// A v1 provider cannot serve the v2 consumer: it waits with its source, then takes it back.
			await host.reload([{ name: "@app/rollback", facet: v1(back!) }], context);
			await delivered();
			expect(held.state.value.kind).toBe("failed");
			await host.reload([{ name: "@app/rollback", facet: v2(ahead!) }], context);
			(await host.get(X2, {}, context)).release();
			await delivered();
		}
		// Each refusal's failure once, then each return's value, whole.
		const refused = { failed: "app.waiting.rollback v2 is not served here" };
		expect([held.x.value, valuesOf(calls)]).toEqual([{ n: 5 }, [refused, { n: 3 }, refused, { n: 5 }]]);
		held.release();
		await host.close(context);
	});
});

describe("reload: a released reference's last values go with it while another version waits (fix round 4)", () => {
	it("drops a removed version's mapped value when its last request leaves while another version waits (Astra)", async () => {
		const H1 = local("app.waiting.versions", {
			version: 1,
			params: { id: int() },
			members: { n: obj({ mapped: int() }) },
		});
		const H2 = evolve(H1, (e) => e.state("n", obj({ raw: int() })));
		const facet = defineFacet((h) =>
			h.serve(H2, () => ({ n: constant({ raw: 7 }) }), {
				accepts: { 1: { state: { n: (v) => ({ mapped: v.raw }) } } },
			}),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/versions", facet }], context);
		const older = await host.get(H1, { id: 1 }, context);
		const newer = await host.get(H2, { id: 1 }, context);
		const mapped = new WeakRef(older.n.value);
		// Both versions wait with their last values; v1's reference is released, v2's stays.
		await host.reload([], context);
		older.release();
		await flushed();
		await expectCollected(mapped);
		newer.release();
		await host.close(context);
	});

	it("drops a refused version's snapshot when its last request leaves while an older one waits (Sol)", async () => {
		const G1 = local("app.waiting.chain", { version: 1, params: {}, members: { x: obj({ n: int() }) } });
		const G2 = evolve(G1, (e) => e.state("x", obj({ n: int() })));
		const G3 = evolve(G2, (e) => e.state("x", obj({ n: int() })));
		const serve = (contract: typeof G1 | typeof G2 | typeof G3, n: number) =>
			defineFacet((h) => h.serve(contract as typeof G3, () => ({ x: constant({ n }) })));
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/chain", facet: serve(G1, 1) }], context);
		const first = await host.get(G1, {}, context);
		await host.reload([{ name: "@app/chain", facet: serve(G2, 2) }], context);
		const second = await host.get(G2, {}, context);
		const snapshot = new WeakRef(second.x.value);
		// v3 accepts neither: both wait; v2's last request leaves, v1's stays.
		await host.reload([{ name: "@app/chain", facet: serve(G3, 3) }], context);
		(await host.get(G3, {}, context)).release();
		second.release();
		await delivered();
		expect(first.state.value.kind).toBe("failed");
		await expectCollected(snapshot);
		first.release();
		await host.close(context);
	});
});

describe("reload: stopping a keyed watch drops its pin and last value while its reference waits (fix round 4)", () => {
	it("drops a stopped key's document while its reference still waits (Sol)", async () => {
		const K1 = local("app.waiting.key", {
			version: 1,
			params: {},
			members: { rows: keyed(obj({ n: int() })), extra: int(), set: method(int()) },
		});
		const K2 = evolve(K1, (e) => e.state("extra", int()));
		const Doc = defineState("rows", {
			version: 1,
			schema: obj({ n: int() }),
			initial: () => ({ n: 1 }),
			keyed: true,
		});
		const facet = defineFacet((h) =>
			h.serve(
				K2,
				(_, self) => {
					const rows = self.state(Doc);
					const set = async (n: number, ctx: Context) => {
						await rows.change(
							"k",
							(draft) => {
								draft.n = n;
							},
							ctx,
						);
						return null;
					};
					return { rows, extra: constant(0), set };
				},
				{ accepts: { 1: { state: { extra: (value) => value } } } },
			),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/key", facet }], context);
		const ref = await host.get(K1, {}, context);
		await ref.set(3, context);
		// A watch of the key while the type is removed (the reference waits, its key with its last value), then
		// stopped; the watch itself goes out of scope here.
		const watched = async () => {
			const watch = (await ref.rows.watch("k", context))!;
			watch.start(async () => {});
			const value = new WeakRef(watch.value);
			await host.reload([], context);
			await watch.stop();
			return value;
		};
		const document = await watched();
		expect(ref.state.value.kind).toBe("failed");
		await expectCollected(document);
		ref.release();
		await host.close(context);
	});
});

describe("reload: a reference that never had values reads none during a parked swap (fix round 4)", () => {
	it("has a newer reference read nothing during a parked swap, its watch waiting, then the new instance's values (Sol)", async () => {
		const N1 = local("app.unshown", { version: 1, params: {}, members: { x: int() } });
		const N2 = evolve(N1, (e) => e.state("x", obj({ n: int() })));
		const Missing = local("app.unshown.missing", { version: 1, params: {}, members: {} });
		const v2 = defineFacet((h) =>
			h.serve(
				N2,
				(_, self) => {
					self.get(Missing, {});
					return { x: constant({ n: 7 }) };
				},
				{ accepts: { 1: { state: { x: (value) => value.n } } } },
			),
		);
		const host = createHost({ onError: () => {} });
		await host.load(
			[{ name: "@app/unshown", facet: defineFacet((h) => h.serve(N1, () => ({ x: constant(1) }))) }],
			context,
		);
		const old = await host.get(N1, {}, context);
		await host.reload([{ name: "@app/unshown", facet: v2 }], context);
		const newer = host.hold(N2, {}, context);
		expect(newer.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		// The swap parks: the shown values are v1's; a v2 reference never had values, never v1's shape: its read throws
		// the parked swap's failure.
		expect(old.x.value).toBe(1);
		expect(() => newer.x.value).toThrow(expect.objectContaining({ code: "unavailable" }));
		// A watch waits for its first values through the failure (Opus G3).
		const waiting = newer.x.watch(context);
		await host.reload(
			[
				{ name: "@app/unshown", facet: v2 },
				{ name: "@app/missing", facet: defineFacet((h) => h.serve(Missing, () => ({}))) },
			],
			context,
		);
		await delivered();
		expect(newer.state.value).toEqual({ kind: "live" });
		expect([newer.x.value, old.x.value]).toEqual([{ n: 7 }, 7]);
		expect([(await waiting).value, (await newer.x.watch(context)).value]).toEqual([{ n: 7 }, { n: 7 }]);
		newer.release();
		old.release();
		await host.close(context);
	});
});

describe("reload: a reference reads its last value while its version's return parks (fix round 5)", () => {
	it("reads the last value its surviving watch shows after v2 to v1 to a parked v2 (Sol)", async () => {
		const R1 = local("app.return", { version: 1, params: {}, members: { x: int() } });
		const R2 = evolve(R1, (e) => e.state("x", obj({ n: int() })));
		const Missing = local("app.return.missing", { version: 1, params: {}, members: {} });
		const host = createHost({ onError: () => {} });
		await host.load(
			[{ name: "@app/return", facet: defineFacet((h) => h.serve(R2, () => ({ x: constant({ n: 7 }) }))) }],
			context,
		);
		const ref = await host.get(R2, {}, context);
		const watch = await ref.x.watch(context);
		watch.start(async () => {});
		// A v1 provider cannot serve v2: the reference waits with its last value.
		await host.reload(
			[{ name: "@app/return", facet: defineFacet((h) => h.serve(R1, () => ({ x: constant(1) }))) }],
			context,
		);
		expect(ref.x.value).toEqual({ n: 7 });
		// v2 is served again but its swap parks: the sources taken back are v2's own, shown before.
		const parked = defineFacet((h) =>
			h.serve(R2, (_, self) => {
				self.get(Missing, {});
				return { x: constant({ n: 9 }) };
			}),
		);
		await host.reload([{ name: "@app/return", facet: parked }], context);
		await delivered();
		expect([watch.value, ref.x.value, (await ref.x.watch(context)).value]).toEqual([{ n: 7 }, { n: 7 }, { n: 7 }]);
		ref.release();
		await host.close(context);
	});
});

describe("reload: one rule for reads and watches across a new object (fix round 6)", () => {
	const Type = local("app.successor", { version: 1, params: {}, members: { x: int() } });
	const Missing = local("app.successor.missing", { version: 1, params: {}, members: {} });

	it("reads the last value its watch shows while the re-served object parks (Sol)", async () => {
		const host = createHost({ onError: () => {} });
		await host.load(
			[{ name: "@app/successor", facet: defineFacet((h) => h.serve(Type, () => ({ x: constant(7) }))) }],
			context,
		);
		const ref = await host.get(Type, {}, context);
		const watch = await ref.x.watch(context);
		watch.start(async () => {});
		await host.reload([], context);
		expect(ref.x.value).toBe(7);
		// Re-served: a new object, which parks before any instance of it went live: the reference keeps its last value.
		const parked = defineFacet((h) =>
			h.serve(Type, (_, self) => {
				self.get(Missing, {});
				return { x: constant(9) };
			}),
		);
		await host.reload([{ name: "@app/successor", facet: parked }], context);
		await delivered();
		expect(ref.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		expect([watch.value, ref.x.value]).toEqual([7, 7]);
		ref.release();
		await host.close(context);
	});

	it("opens a new watch at its last value while the re-served object's native opens (Sol)", async () => {
		const gate = Promise.withResolvers<number>();
		const host = createHost({ onError: () => {} });
		await host.load(
			[{ name: "@app/successor", facet: defineFacet((h) => h.serve(Type, () => ({ x: constant(7) }))) }],
			context,
		);
		const ref = await host.get(Type, {}, context);
		await host.reload([], context);
		const opening = defineFacet((h) =>
			h.serve(Type, (_, self) => {
				self.open(
					async () => gate.promise,
					() => {},
				);
				return { x: constant(9) };
			}),
		);
		const reloading = host.reload([{ name: "@app/successor", facet: opening }], context);
		await delivered();
		expect(ref.state.value.kind).toBe("loading");
		expect(ref.x.value).toBe(7);
		// At once, not after hydration: the source of its version exists.
		const watch = await ref.x.watch(context);
		expect(watch.value).toBe(7);
		const calls = changesOf(watch);
		gate.resolve(1);
		await reloading;
		await delivered();
		expect(valuesOf(calls).at(-1)).toBe(9);
		ref.release();
		await host.close(context);
	});
});

describe("reload: an older version only a pending provider maps has no values yet (fix round 7)", () => {
	const A1 = local("app.pending.accept", { version: 1, params: {}, members: { x: int() } });
	const A2 = evolve(A1, (e) => e.state("x", obj({ n: int() })));
	const A3 = evolve(A2, (e) => e.state("x", obj({ wrapped: obj({ n: int() }) })));

	/** v2 shown (no accepts for v1), a reload to v3 (accepting v1 and v2) gated on a native; a new v1 hold, loading. */
	async function pending() {
		const gate = Promise.withResolvers<number>();
		const host = createHost({ onError: () => {} });
		await host.load(
			[{ name: "@app/accept", facet: defineFacet((h) => h.serve(A2, () => ({ x: constant({ n: 2 }) }))) }],
			context,
		);
		const v3 = defineFacet((h) =>
			h.serve(
				A3,
				(_, self) => {
					self.open(
						async () => gate.promise,
						() => {},
					);
					return { x: constant({ wrapped: { n: 7 } }) };
				},
				{
					accepts: {
						1: { state: { x: (value) => value.wrapped.n } },
						2: { state: { x: (value) => value.wrapped } },
					},
				},
			),
		);
		const reloading = host.reload([{ name: "@app/accept", facet: v3 }], context);
		await delivered();
		return { host, ref: host.hold(A1, {}, context), gate, reloading };
	}

	it("reads not_ready rather than asking the shown provider for a mapping it lacks (Sol)", async () => {
		const { host, ref, gate, reloading } = await pending();
		expect(ref.state.value.kind).toBe("loading");
		expect(() => ref.x.value).toThrow(expect.objectContaining({ code: "not_ready" }));
		gate.resolve(1);
		await reloading;
		await delivered();
		expect(ref.x.value).toBe(7);
		ref.release();
		await host.close(context);
	});

	it("opens a watch once the accepting provider is live, not before (Sol)", async () => {
		const { host, ref, gate, reloading } = await pending();
		let opened = false;
		const opening = ref.x.watch(context).then((watch) => {
			opened = true;
			return watch;
		});
		await delivered();
		expect(opened).toBe(false);
		gate.resolve(1);
		await reloading;
		expect((await opening).value).toBe(7);
		ref.release();
		await host.close(context);
	});
});

describe('an older consumer keeps nothing of its instance\'s mapping (decision "References are the only indirection")', () => {
	const mappings = instancesOf(AdaptedMembers, "member");

	it("lets an ended instance's mapping derives go while the older reference waits with an open watch", async () => {
		const M1 = local("app.mapped.gc", { version: 1, params: {}, members: { n: int() } });
		const M2 = evolve(M1, (e) => e.state("n", obj({ value: int() })));
		const facet = defineFacet((h) =>
			h.serve(M2, () => ({ n: constant({ value: 4 }) }), { accepts: { 1: { state: { n: (v) => v.value } } } }),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/mapped", facet }], context);
		const from = mappings.length;
		const old = await host.get(M1, {}, context);
		const calls = changesOf(await old.n.watch(context));
		const used = mappings.slice(from);
		expect(used.length).toBeGreaterThan(0);
		await host.reload([], context);
		await delivered();
		// Its last mapped value and the failure once; the instance's mapping went with it.
		expect([old.n.value, valuesOf(calls)]).toEqual([4, [{ failed: "app.mapped.gc is not served here" }]]);
		await expectCollected(...used);
		old.release();
		await host.close(context);
	});
});

describe("an instance's mapping detaches only what it made (final review)", () => {
	it("keeps an unchanged member, the instance's own derive, when the last older reference leaves (Astra)", async () => {
		const D1 = local("app.shared-derive", { version: 1, params: {}, members: { n: int(), set: method(int()) } });
		const D2 = evolve(D1, (e) => e.addState("extra", int()));
		const Counter = defineState("counter", { version: 1, schema: obj({ n: int() }), initial: () => ({ n: 1 }) });
		const facet = defineFacet((h) =>
			h.serve(
				D2,
				(_, self) => {
					const counter = self.state(Counter);
					const set = async (n: number, ctx: Context) => {
						await counter.change((draft) => {
							draft.n = n;
						}, ctx);
						return null;
					};
					return { n: self.derive([counter], ([c]) => c.n * 2), extra: constant(0), set };
				},
				{ accepts: { 1: {} } },
			),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/derive", facet }], context);
		const newer = await host.get(D2, {}, context);
		const older = await host.get(D1, {}, context);
		// v1 reads `n` unchanged: the instance's own derive, not a mapping.
		expect(older.n.value).toBe(2);
		const calls = changesOf(await newer.n.watch(context));
		older.release();
		await newer.set(3, context);
		await delivered();
		expect([newer.n.value, valuesOf(calls)]).toEqual([6, [6]]);
		newer.release();
		await host.close(context);
	});
});

describe("keyed mappings per member (final review)", () => {
	it("maps one document exposed as two keyed members through each member's own mapping (Astra)", async () => {
		const K1 = local("app.keyed-alias", {
			version: 1,
			params: {},
			members: { first: keyed(int()), second: keyed(int()), set: method(int()) },
		});
		const K2 = evolve(K1, (e) => e.keyed("first", obj({ n: int() })).keyed("second", obj({ n: int() })));
		const Rows = defineState("rows", {
			version: 1,
			schema: obj({ n: int() }),
			initial: () => ({ n: 0 }),
			keyed: true,
		});
		const facet = defineFacet((h) =>
			h.serve(
				K2,
				(_, self) => {
					const rows = self.state(Rows);
					const set = async (n: number, ctx: Context) => {
						await rows.change(
							"a",
							(draft) => {
								draft.n = n;
							},
							ctx,
						);
						return null;
					};
					return { first: rows, second: rows, set };
				},
				{ accepts: { 1: { keyed: { first: (value) => value.n, second: (value) => value.n * 10 } } } },
			),
		);
		const host = createHost({ onError: () => {} });
		await host.load([{ name: "@app/keyed-alias", facet }], context);
		const ref = await host.get(K1, {}, context);
		await ref.set(5, context);
		const first = (await ref.first.watch("a", context))!;
		const second = (await ref.second.watch("a", context))!;
		expect({ first: first.value, second: second.value, read: await ref.second.get("a", context) }).toEqual({
			first: 5,
			second: 50,
			read: 50,
		});
		await first.stop();
		await second.stop();
		ref.release();
		await host.close(context);
	});
});
