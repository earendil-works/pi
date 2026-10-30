import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { bool, int, local, method, obj } from "../../../src/next/contracts/index.ts";
import { defineState } from "../../../src/next/documents/index.ts";
import { createHost, defineFacet, type HostError } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import {
	defineRegistry,
	keyedEntries,
	type Registry,
	type RegistryTable,
	type TableItem,
} from "../../../src/next/registries/index.ts";
import type { Writable } from "../../../src/next/state/index.ts";
import type { NativeWatchCall } from "../../../src/watch.ts";
import {
	delivered,
	expectCollected,
	failures,
	flushed,
	instancesOf,
	loadedPlugins,
	metered,
	storeRestartable,
} from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

/** A registry whose composition is its table as `plugin:type=value` strings. */
const Names = defineRegistry<string, readonly string[]>("app.names", { version: 1 });

const listed = (table: RegistryTable<string>): readonly string[] =>
	table.map(({ plugin, type, value }) => `${plugin}:${type ?? ""}=${value}`);

/** A host-lifetime object contributing a writable it sets with `set`. */
const Setter = local("app.setter", { version: 1, params: {}, members: { set: method(int()) } });

/** Serves `Setter` contributing a writable of `R`'s contribution type, `initial` first, `set(n)` makes `of(n)`. */
function setter<C>(R: Registry<C, unknown>, initial: C, of: (n: number) => C) {
	return (host: Parameters<Parameters<typeof loadedPlugins>[0][string]>[0]) =>
		host.serve(Setter, (_, self) => {
			const value = self.writable(initial);
			self.contribute(R, value);
			return {
				set: async (n: number) => {
					value.set(of(n));
					return null;
				},
			};
		});
}

function kinds(errors: readonly HostError[]): string[] {
	return errors.map((error) => error.kind);
}

describe("the table", () => {
	it("is sorted by plugin name, then type, a facet first: never load order", async () => {
		const { host } = await loadedPlugins({
			"@z/late": (_, self) => self.contribute(Names, "z"),
			"@a/early": (host, self) => {
				self.contribute(Names, "a");
				setter(Names, "store", String)(host);
			},
			"@m/provider": (host) => host.serve(Names, { compose: listed }),
		});
		const value = await host.registry(Names, context);
		expect(value.value).toEqual(["@a/early:=a", "@a/early:app.setter=store", "@z/late:=z"]);
		await host.close(context);
	});

	it("adapts an older contribution once per value; a newer one, or an older one without an adapter, is left out and reported once", async () => {
		const V3 = defineRegistry<string, readonly string[]>("app.versions", { version: 3 });
		const V2 = defineRegistry<{ old: string }, unknown>("app.versions", { version: 2 });
		const V1 = defineRegistry<string, unknown>("app.versions", { version: 1 });
		const V4 = defineRegistry<string, unknown>("app.versions", { version: 4 });
		const adapted: string[] = [];
		const { host, errors } = await loadedPlugins({
			"@app/provider": (host) =>
				host.serve(V3, {
					compose: listed,
					accepts: {
						2: {
							contribution: (old: { old: string }) => {
								adapted.push(old.old);
								return `adapted ${old.old}`;
							},
						},
					},
				}),
			"@app/one": (_, self) => self.contribute(V1, "one"),
			"@app/two": setter(V2, { old: "first" }, (n) => ({ old: `${n}` })),
			"@app/three": (_, self) => self.contribute(V3, "three"),
			"@app/four": (_, self) => self.contribute(V4, "four"),
		});
		const value = await host.registry(V3, context);
		expect(value.value).toEqual(["@app/three:=three", "@app/two:app.setter=adapted first"]);
		expect(errors).toEqual([
			{ kind: "contribution_refused", registry: "app.versions", plugin: "@app/four", version: 4 },
			{ kind: "contribution_refused", registry: "app.versions", plugin: "@app/one", version: 1 },
		]);
		const setters = await host.get(Setter, {}, context);
		await setters.set(5, context);
		expect(value.value).toEqual(["@app/three:=three", "@app/two:app.setter=adapted 5"]);
		// Each value adapted once, though the table was built again; no refusal reported twice.
		expect(adapted).toEqual(["first", "5"]);
		expect(kinds(errors)).toEqual(["contribution_refused", "contribution_refused"]);
		await host.close(context);
	});

	it("takes a contribution declared before its provider's setup into the first composition", async () => {
		let composed: readonly string[] | undefined;
		const { host } = await loadedPlugins({
			"@app/a": (_, self) => self.contribute(Names, "first"),
			"@app/provider": (host) =>
				host.serve(Names, {
					compose: (table) => {
						composed = listed(table);
						return composed;
					},
				}),
		});
		expect(composed).toEqual(["@app/a:=first"]);
		await host.close(context);
	});
});

describe("compose", () => {
	it("composes every served registry once at the end of load's setups, an empty table too, before any object activates", async () => {
		const { telemetry, counts } = await metered();
		const Other = defineRegistry<string, number>("app.other", { version: 1 });
		const Reader = local("app.reader", { version: 1, params: {}, members: { seen: int() } });
		let seen: readonly string[] | undefined;
		const { host } = await loadedPlugins(
			{
				"@app/provider": (host, self) => {
					host.serve(Names, { compose: listed });
					host.serve(Other, { compose: (table) => table.length });
					self.contribute(Names, "a");
					host.serve(Reader, (_, self) => {
						const names = self.registry(Names);
						self.open(
							async () => {
								seen = names.value;
							},
							() => {},
						);
						return { seen: self.derive([self.registry(Other)], ([n]) => n) };
					});
				},
			},
			{ telemetry },
		);
		expect(seen).toEqual(["@app/provider:=a"]);
		expect((await host.get(Reader, {}, context)).seen.value).toBe(0);
		expect(counts()["chord.registry.composes"]).toBe(2);
		await host.close(context);
	});

	it("is lazy: a change marks the table, a read composes it once; no compose for an unchanged table", async () => {
		const { telemetry, counts } = await metered();
		const Flags = defineRegistry<boolean, number>("app.flags", { version: 1 });
		const Doc = defineState("app.flag", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 1 }) });
		const Flagger = local("app.flagger", { version: 1, params: {}, members: { set: method(int()) } });
		const { host } = await loadedPlugins(
			{
				"@app/flags": (host) => {
					host.serve(Flags, { compose: (table) => table.filter(({ value }) => value).length });
					host.serve(Flagger, (_, self) => {
						const doc = self.state(Doc);
						self.contribute(
							Flags,
							self.derive([doc], ([d]) => d.n > 0),
						);
						return {
							set: async (n: number, ctx) => {
								await doc.change((d) => {
									d.n = n;
								}, ctx);
								return null;
							},
						};
					});
				},
			},
			{ telemetry },
		);
		const flags = await host.registry(Flags, context);
		const flagger = await host.get(Flagger, {}, context);
		expect(flags.value).toBe(1);
		const base = counts()["chord.registry.composes"]!;
		expect(flags.value).toBe(1);
		expect(counts()["chord.registry.composes"]).toBe(base);
		// The derive changes, its value does not: the table stays, nothing composes.
		await flagger.set(2, context);
		await flagger.set(3, context);
		expect(flags.value).toBe(1);
		expect(counts()["chord.registry.composes"]).toBe(base);
		// Nobody reads it: nothing composes until a read.
		await flagger.set(-1, context);
		await flagger.set(-2, context);
		expect(counts()["chord.registry.composes"]).toBe(base);
		expect(flags.value).toBe(0);
		expect(counts()["chord.registry.composes"]).toBe(base + 1);
		await host.close(context);
	});

	it("composes a watched registry in the batch of the commit that changed a contribution, once per batch", async () => {
		const { telemetry, counts } = await metered();
		const Doc = defineState("app.names", {
			schema: obj({ a: int(), b: int() }),
			version: 1,
			initial: () => ({ a: 0, b: 0 }),
		});
		const Two = local("app.two", { version: 1, params: {}, members: { both: method(int()), sum: int() } });
		const Sum = defineRegistry<{ readonly a: number; readonly b: number }, number>("app.sum", { version: 1 });
		const { host } = await loadedPlugins(
			{
				"@app/sum": (host) => {
					host.serve(Sum, { compose: (table) => table.reduce((n, { value }) => n + value.a + value.b, 0) });
					host.serve(Two, (_, self) => {
						const doc = self.state(Doc);
						self.contribute(Sum, doc);
						return {
							sum: self.derive([self.registry(Sum)], ([n]) => n),
							both: async (n: number, ctx) => {
								await self.tx(async (tx) => {
									const d = await tx.draft(doc);
									d.a = n;
									d.b = n;
								}, ctx);
								return null;
							},
						};
					});
				},
			},
			{ telemetry },
		);
		const two = await host.get(Two, {}, context);
		const sums: number[] = [];
		const watch = await two.sum.watch(context);
		watch.start(async (call) => {
			if (call.kind === "value") sums.push(call.value);
		});
		const base = counts()["chord.registry.composes"]!;
		await two.both(2, context);
		await delivered();
		// One commit, both fields: one compose in its batch, one frame of the derive over it.
		expect(sums).toEqual([4]);
		expect(counts()["chord.registry.composes"]).toBe(base + 1);
		await host.close(context);
	});

	it("reports a conflict once per episode", async () => {
		const Routes = defineRegistry<Readonly<Record<string, string>>, ReadonlyMap<string, TableItem<string>>>(
			"app.routes",
			{ version: 1 },
		);
		const { host, errors } = await loadedPlugins({
			"@app/a": (_, self) => self.contribute(Routes, { "/x": "a" }),
			"@app/b": setter(Routes, { "/x": "b" } as Readonly<Record<string, string>>, (n) => ({
				"/x": "b",
				[`/${n}`]: "b",
			})),
			"@app/http": (host) =>
				host.serve(Routes, { compose: (table, { report }) => keyedEntries(table, (c) => c, report) }),
		});
		const routes = await host.registry(Routes, context);
		expect(routes.value.get("/x")).toEqual({ value: "a", plugin: "@app/a" });
		const setters = await host.get(Setter, {}, context);
		await setters.set(1, context);
		void routes.value;
		await setters.set(2, context);
		void routes.value;
		expect(errors).toEqual([
			{
				kind: "registry_conflict",
				registry: "app.routes",
				message: '"/x" is contributed twice',
				plugins: ["@app/a", "@app/b"],
			},
		]);
		await host.close(context);
	});

	it("a throwing compose: reported once, a failed call, `.value` keeps the last good composition; the next good one heals", async () => {
		const Count = defineRegistry<number, number>("app.count", { version: 1 });
		const { host, errors } = await loadedPlugins({
			"@app/count": (host) => {
				host.serve(Count, {
					compose: (table) => {
						const sum = table.reduce((n, { value }) => n + value, 0);
						if (sum < 0) throw new Error(`negative: ${sum}`);
						return sum;
					},
				});
				setter(Count, 1, (n) => n)(host);
			},
		});
		const count = await host.registry(Count, context);
		const calls: NativeWatchCall<number>[] = [];
		const watch = await count.watch(context);
		watch.start(async (call) => void calls.push(call));
		const setters = await host.get(Setter, {}, context);
		await setters.set(-1, context);
		await setters.set(-2, context);
		await delivered();
		expect(count.value).toBe(1);
		expect(errors).toEqual([{ kind: "registry_failed", registry: "app.count", error: new Error("negative: -1") }]);
		await setters.set(1, context);
		await delivered();
		// The heal is a value call, also when its value is the last good one.
		expect(calls).toEqual([
			{ kind: "failed", error: new Error("negative: -1") },
			{ kind: "value", value: 1 },
		]);
		await setters.set(3, context);
		await delivered();
		expect(calls.at(-1)).toEqual({ kind: "value", value: 3 });
		await host.close(context);
	});

	it("before any good composition, `.value` throws the error and `host.registry` rejects with it at its readyTimeout", async () => {
		const Broken = defineRegistry<number, number>("app.broken", { version: 1 });
		const { host, errors } = await loadedPlugins({
			"@app/broken": (host) =>
				host.serve(Broken, {
					compose: () => {
						throw new Error("bug");
					},
				}),
		});
		await expect(host.registry(Broken, context, { readyTimeout: 5 })).rejects.toThrow("bug");
		expect(kinds(errors)).toEqual(["registry_failed"]);
		await host.close(context);
	});
});

describe("contributions", () => {
	it("a watchable contribution that fails is left out and reported once, and is back once it heals", async () => {
		const Doc = defineState("app.n", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 1 }) });
		const Failing = local("app.failing", { version: 1, params: {}, members: { set: method(int()) } });
		const { host, errors } = await loadedPlugins({
			"@app/names": (host, self) => {
				host.serve(Names, { compose: listed });
				self.contribute(Names, "facet");
				host.serve(Failing, (_, self) => {
					const doc = self.state(Doc);
					self.contribute(
						Names,
						self.derive([doc], ([d]) => {
							if (d.n < 0) throw new Error("negative");
							return `n${d.n}`;
						}),
					);
					return {
						set: async (n: number, ctx) => {
							await doc.change((d) => {
								d.n = n;
							}, ctx);
							return null;
						},
					};
				});
			},
		});
		const names = await host.registry(Names, context);
		const failing = await host.get(Failing, {}, context);
		expect(names.value).toEqual(["@app/names:=facet", "@app/names:app.failing=n1"]);
		await failing.set(-1, context);
		expect(names.value).toEqual(["@app/names:=facet"]);
		await failing.set(-2, context);
		expect(names.value).toEqual(["@app/names:=facet"]);
		await failing.set(2, context);
		expect(names.value).toEqual(["@app/names:=facet", "@app/names:app.failing=n2"]);
		expect(errors.filter(({ kind }) => kind === "contribution_failed")).toEqual([
			{
				kind: "contribution_failed",
				registry: "app.names",
				plugin: "@app/names",
				type: "app.failing",
				error: new Error("negative"),
			},
		]);
		await host.close(context);
	});

	it("a contribution adapter that throws leaves that contribution out (`contribution_failed`)", async () => {
		const V2 = defineRegistry<string, readonly string[]>("app.adapted", { version: 2 });
		const V1 = defineRegistry<string, unknown>("app.adapted", { version: 1 });
		const { host, errors } = await loadedPlugins({
			"@app/provider": (host, self) => {
				host.serve(V2, {
					compose: listed,
					accepts: {
						1: {
							contribution: () => {
								throw new Error("cannot adapt");
							},
						},
					},
				});
				self.contribute(V2, "current");
			},
			"@app/old": (_, self) => self.contribute(V1, "old"),
		});
		expect((await host.registry(V2, context)).value).toEqual(["@app/provider:=current"]);
		expect(errors).toEqual([
			{ kind: "contribution_failed", registry: "app.adapted", plugin: "@app/old", error: new Error("cannot adapt") },
		]);
		await host.close(context);
	});

	it("catches a ring of registries at its first composition: the contributors go live, the rest works (audit A2)", async () => {
		const A = defineRegistry<unknown, number>("app.ring-a", { version: 1 });
		const B = defineRegistry<unknown, number>("app.ring-b", { version: 1 });
		const ToA = local("app.to-a", { version: 1, params: {}, members: {} });
		const ToB = local("app.to-b", { version: 1, params: {}, members: {} });
		const { host, errors } = await loadedPlugins({
			"@app/ring": (h, self) => {
				h.serve(A, { compose: (table) => table.length });
				h.serve(B, { compose: (table) => table.length });
				h.serve(ToA, (_, self) => {
					self.contribute(A, self.registry(B));
					return {};
				});
				h.serve(ToB, (_, self) => {
					self.contribute(B, self.registry(A));
					return {};
				});
				self.contribute(A, "plain");
				self.contribute(B, "plain");
			},
		});
		const live = [await host.get(ToA, {}, context), await host.get(ToB, {}, context)];
		expect(live.map((reference) => reference.state.value)).toEqual([{ kind: "live" }, { kind: "live" }]);
		// A composes first: B composes for it and its contribution of A, read while A composes, is left out. A has its
		// plain entry and B's value, B its plain entry.
		expect([(await host.registry(A, context)).value, (await host.registry(B, context)).value]).toEqual([2, 1]);
		expect(errors).toEqual([
			{
				kind: "contribution_failed",
				registry: "app.ring-b",
				plugin: "@app/ring",
				type: "app.to-b",
				error: expect.objectContaining({ code: "invalid", reason: "cycle" }),
			},
		]);
		await host.close(context);
	});

	it("keeps a ring's later recompositions bounded: a change composes each registry once, then nothing (audit A2)", async () => {
		const A = defineRegistry<unknown, number>("app.later-a", { version: 1 });
		const B = defineRegistry<unknown, number>("app.later-b", { version: 1 });
		const Ring = local("app.later-ring", { version: 1, params: {}, members: {} });
		const Back = local("app.later-back", { version: 1, params: {}, members: {} });
		const Extra = local("app.later-extra", { version: 1, params: {}, members: {} });
		let composes = 0;
		let extra: Writable<number> | undefined;
		const sum = (table: RegistryTable<unknown>): number => {
			composes++;
			return table.reduce((total, { value }) => total + (typeof value === "number" ? value : 0), 0);
		};
		const { host, errors } = await loadedPlugins({
			"@app/later": (h) => {
				h.serve(A, { compose: sum });
				h.serve(B, { compose: sum });
				h.serve(Ring, (_, self) => {
					self.contribute(A, self.registry(B));
					return {};
				});
				h.serve(Back, (_, self) => {
					self.contribute(B, self.registry(A));
					return {};
				});
				h.serve(Extra, (_, self) => {
					extra = self.writable(1);
					self.contribute(B, extra);
					return {};
				});
			},
		});
		await host.get(Ring, {}, context);
		await host.get(Back, {}, context);
		await host.get(Extra, {}, context);
		const a = await host.registry(A, context);
		const b = await host.registry(B, context);
		const watches = [await a.watch(context), await b.watch(context)];
		await flushed();
		const before = composes;
		extra!.set(5);
		await flushed();
		// B changed and composes first now: it reads A, whose contribution of B, read while B composes, is cut instead.
		expect(composes - before).toBe(2);
		expect([a.value, b.value]).toEqual([0, 5]);
		expect(errors.map((error) => (error.kind === "contribution_failed" ? error.registry : error.kind))).toEqual([
			"app.later-b",
			"app.later-a",
		]);
		// Nothing composes on by itself.
		await flushed();
		expect(composes - before).toBe(2);
		for (const watch of watches) await watch.stop();
		await host.close(context);
	});

	it("catches a ring through a derive, and one declared within one factory, the same way (audit A2)", async () => {
		const A = defineRegistry<unknown, number>("app.both-a", { version: 1 });
		const B = defineRegistry<unknown, number>("app.both-b", { version: 1 });
		const Both = local("app.both", { version: 1, params: {}, members: {} });
		const { host, errors } = await loadedPlugins({
			"@app/both": (h) => {
				h.serve(A, { compose: (table) => table.length });
				h.serve(B, { compose: (table) => table.length });
				h.serve(Both, (_, self) => {
					self.contribute(A, self.registry(B));
					self.contribute(
						B,
						self.derive([self.registry(A)], ([n]) => n as number),
					);
					return {};
				});
			},
		});
		expect((await host.get(Both, {}, context)).state.value).toEqual({ kind: "live" });
		await host.registry(A, context);
		await host.registry(B, context);
		const cut = errors.filter((error) => error.kind === "contribution_failed");
		expect(cut.length).toBeGreaterThan(0);
		for (const error of cut) expect(error).toMatchObject({ error: { code: "invalid", reason: "cycle" } });
		expect(failures(errors)).toEqual([]);
		await host.close(context);
	});

	it("follows only Chord watchables: anything else is a plain value, whatever methods it has (Sol)", async () => {
		const Natives = defineRegistry<{ watch(): string; readonly value: string }, readonly string[]>("app.natives", {
			version: 1,
		});
		const native = { value: "a handle", watch: () => "a native operation" };
		const { host } = await loadedPlugins({
			"@app/x": (h, self) => {
				h.serve(Natives, { compose: (table) => table.map(({ value }) => value.watch()) });
				self.contribute(Natives, native);
			},
		});
		expect((await host.registry(Natives, context)).value).toEqual(["a native operation"]);
		await host.close(context);
	});

	it("keeps an `undefined` contribution in the table (Sol, Astra)", async () => {
		const Nothing = defineRegistry<undefined, number>("app.undefined", { version: 1 });
		const { host } = await loadedPlugins({
			"@app/a": (h, self) => {
				h.serve(Nothing, { compose: (table) => table.length });
				self.contribute(Nothing, undefined);
			},
		});
		expect((await host.registry(Nothing, context)).value).toBe(1);
		await host.close(context);
	});

	it("leaves out a registry's value contributed to another while that registry's compose throws (Sol, Astra)", async () => {
		const Source = defineRegistry<number, number>("app.source", { version: 1 });
		const Target = defineRegistry<number, readonly number[]>("app.target", { version: 1 });
		const Bridge = local("app.bridge", { version: 1, params: {}, members: {} });
		const { host, errors } = await loadedPlugins({
			"@app/a": (h) => {
				h.serve(Source, {
					compose: (table) => {
						const n = table.reduce((sum, { value }) => sum + value, 0);
						if (n < 0) throw new Error("negative");
						return n;
					},
				});
				h.serve(Target, { compose: (table) => table.map(({ value }) => value) });
				setter(Source, 1, (n) => n)(h);
				h.serve(Bridge, (_, self) => {
					self.contribute(Target, self.registry(Source));
					return {};
				});
			},
		});
		const target = await host.registry(Target, context);
		expect(target.value).toEqual([1]);
		const setters = await host.get(Setter, {}, context);
		await setters.set(-1, context);
		// The source's readers keep its last good value; as a contribution it is failed: left out, reported.
		expect((await host.registry(Source, context)).value).toBe(1);
		expect(target.value).toEqual([]);
		expect(errors.find((error) => error.kind === "contribution_failed")).toMatchObject({
			registry: "app.target",
			plugin: "@app/a",
			type: "app.bridge",
			error: new Error("negative"),
		});
		await setters.set(3, context);
		expect(target.value).toEqual([3]);
		await host.close(context);
	});

	it("a followed contribution whose runtime ended its observer stays with its last value (R4: the source keeps it)", async () => {
		let end: (() => void) | undefined;
		const Follower = local("app.follower", { version: 1, params: {}, members: {} });
		const { host, errors } = await loadedPlugins({
			"@app/a": (h) => {
				h.serve(Names, { compose: listed });
				h.serve(Follower, (_, self) => {
					self.contribute(
						Names,
						self.follow(async (observer) => {
							end = () => observer.end({ kind: "ended" });
							return { value: "followed", detach: () => {} };
						}),
					);
					return {};
				});
			},
		});
		const names = await host.registry(Names, context);
		expect(names.value).toEqual(["@app/a:app.follower=followed"]);
		end!();
		await flushed();
		expect(names.value).toEqual(["@app/a:app.follower=followed"]);
		expect(errors.filter(({ kind }) => kind === "contribution_failed")).toEqual([]);
		await host.close(context);
	});

	it("an object's contribution is in the table from live until it fails, again once retried, until it ends", async () => {
		const { host, fail, retry } = await storeRestartable(
			objects,
			(attempt, self) => self.contribute(Names, `attempt ${attempt}`),
			{ serve: (host) => host.serve(Names, { compose: listed }) },
		);
		const names = await host.registry(Names, context);
		expect(names.value).toEqual(["@test/app:app.store=attempt 1"]);
		fail();
		expect(names.value).toEqual([]);
		await retry();
		expect(names.value).toEqual(["@test/app:app.store=attempt 2"]);
		await host.close(context);
		// Closed: nothing composes any more; a value a reader keeps reads the last composition.
		expect(names.value).toEqual(["@test/app:app.store=attempt 2"]);
	});
});

describe("the last good composition (decision 5)", () => {
	it("is dropped when a contribution it was built from leaves: `.value` throws until `compose` succeeds", async () => {
		const Count = defineRegistry<number, number>("app.count", { version: 1 });
		const compose = (table: RegistryTable<number>): number => {
			if (table.length === 0) throw new Error("no contributor");
			return table[0]!.value;
		};
		const { host, fail, retry } = await storeRestartable(
			objects,
			(attempt, self) => self.contribute(Count, attempt),
			{
				serve: (host) => host.serve(Count, { compose }),
			},
		);
		const count = await host.registry(Count, context);
		expect(count.value).toBe(1);
		// Its contributor failed: the last good value was built from its contribution (a native may have closed with it).
		fail();
		expect(() => count.value).toThrow("no contributor");
		await retry();
		expect(count.value).toBe(2);
		await host.close(context);
	});
});

describe("the table's memory", () => {
	it("keeps nothing of a closed host: records, tables and followed contributions go with it", async () => {
		const Doc = defineState("app.kept", { schema: obj({ on: bool() }), version: 1, initial: () => ({ on: true }) });
		const Kept = local("app.kept", { version: 1, params: {}, members: {} });
		const refs = await (async () => {
			const { host } = await loadedPlugins({
				"@app/kept": (host) => {
					host.serve(Names, { compose: listed });
					host.serve(Kept, (_, self) => {
						self.contribute(
							Names,
							self.derive([self.state(Doc)], ([d]) => `${d.on}`),
						);
						return {};
					});
				},
			});
			const names = new WeakRef(await host.registry(Names, context));
			await host.close(context);
			return [names, new WeakRef(host)];
		})();
		await expectCollected(...refs);
	});
});

describe("a reload's new contribution adapter (fix round 1)", () => {
	it("remaps an unchanged contributor with the new provider's adapter", async () => {
		const R = defineRegistry<number, number>("astra.contrib", { version: 2 });
		const Old = defineRegistry<number, number>("astra.contrib", { version: 1 });
		const contribution = defineFacet((_, self) => self.contribute(Old, 7));
		const provider = (factor: number) =>
			defineFacet((h) =>
				h.serve(R, {
					compose: (entries) => entries.reduce((n, e) => n + e.value, 0),
					accepts: { 1: { contribution: (n) => n * factor, value: (n) => n } },
				}),
			);
		const host = createHost({ onError: () => {} });
		await host.load(
			[
				{ name: "@astra/provider", facet: provider(2) },
				{ name: "@astra/contribution", facet: contribution },
			],
			context,
		);
		const value = await host.registry(R, context);
		expect(value.value).toBe(14);
		await host.reload(
			[
				{ name: "@astra/provider", facet: provider(3) },
				{ name: "@astra/contribution", facet: contribution },
			],
			context,
		);
		const actual = value.value;
		await host.close(context);
		expect(actual).toBe(21);
	});
});
