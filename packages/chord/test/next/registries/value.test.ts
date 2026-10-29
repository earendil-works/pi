import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal, withCancel } from "../../../src/context/index.ts";
import { int, local, method, str } from "../../../src/next/contracts/index.ts";
import type { FollowObserver } from "../../../src/next/host/follow.ts";
import { createHost, defineFacet, type Native } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineRegistry, type Registry } from "../../../src/next/registries/index.ts";
import type { NativeWatchCall, WatchEnd } from "../../../src/watch.ts";
import {
	expectCollected,
	failures,
	flushed,
	instancesOf,
	loadedPlugins,
	metered,
	rejection,
	settledHeap,
} from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

/** The provider's version 2: contributions are numbers, the value their sum. */
const Sum = defineRegistry<number, { readonly total: number }>("app.sum", { version: 2 });

/** A reader built against version 1: its value was a plain number. */
const SumV1 = defineRegistry<number, number>("app.sum", { version: 1 });

/** A reader built against a version the provider does not know yet. */
const SumV3 = defineRegistry<number, { readonly total: number; readonly count: number }>("app.sum", { version: 3 });

const Setter = local("app.setter", { version: 1, params: {}, members: { set: method(int()) } });

/** Serves `Setter`, contributing a writable number to `Sum`. */
function setter(host: Parameters<Parameters<typeof defineFacet>[0]>[0], initial = 1): void {
	host.serve(Setter, (_, self) => {
		const value = self.writable(initial);
		self.contribute(Sum, value);
		return {
			set: async (n: number) => {
				value.set(n);
				return null;
			},
		};
	});
}

const total = (table: readonly { readonly value: number }[]) => ({
	total: table.reduce((n, { value }) => n + value, 0),
});

describe("older readers (S2)", () => {
	it("get the composition mapped back with accepts[old].value, once per composition", async () => {
		const { telemetry, counts } = await metered();
		const mapped: number[] = [];
		const { host } = await loadedPlugins(
			{
				"@app/sum": (host) => {
					host.serve(Sum, {
						compose: total,
						accepts: {
							1: {
								value: (current) => {
									mapped.push(current.total);
									return current.total;
								},
							},
						},
					});
					setter(host);
				},
			},
			{ telemetry },
		);
		const old = await host.registry(SumV1, context);
		const current = await host.registry(Sum, context);
		expect(old.value).toBe(1);
		expect(old.value).toBe(1);
		expect(current.value).toEqual({ total: 1 });
		await (await host.get(Setter, {}, context)).set(4, context);
		expect(old.value).toBe(4);
		expect(mapped).toEqual([1, 4]);
		expect(counts()["chord.registry.adapts"]).toBe(2);
		await host.close(context);
	});

	it("without a value mapping, and for a reader newer than the provider, park readers failed { waiting } (contract_mismatch)", async () => {
		const Newer = local("app.newer", { version: 1, params: {}, members: { total: int() } });
		const Older = local("app.older", { version: 1, params: {}, members: { total: int() } });
		const { host, errors } = await loadedPlugins({
			"@app/sum": (host) => {
				host.serve(Sum, { compose: total });
				host.serve(Newer, (_, self) => ({ total: self.derive([self.registry(SumV3)], ([v]) => v.total) }));
				host.serve(Older, (_, self) => ({ total: self.derive([self.registry(SumV1)], ([v]) => v) }));
			},
		});
		const quick = { readyTimeout: 5 };
		expect(await rejection(host.registry(SumV1, context, quick))).toMatchObject({ code: "contract_mismatch" });
		expect(await rejection(host.registry(SumV3, context, quick))).toMatchObject({ code: "contract_mismatch" });
		// Not their fault: waiting (a reload serving the version wakes them), no backoff, nothing failed.
		expect(failures(errors)).toEqual([]);
		expect(host.hold(Newer, {}, context).state.value).toMatchObject({
			kind: "failed",
			cause: {
				kind: "waiting",
				error: {
					message: "waiting for registry app.sum: registry app.sum: version 3 is not served here (version 2 is)",
				},
			},
			retryAt: undefined,
		});
		await host.close(context);
	});

	it("drops an older reader's last good mapping after a contributor it was built from failed live (fix round 1, Astra 2)", async () => {
		const R = defineRegistry<number, number>("app.mapped", { version: 2 });
		const Old = defineRegistry<number, number>("app.mapped", { version: 1 });
		const Contributor = local("app.contributor", { version: 1, params: {}, members: { n: int() } });
		let observer: FollowObserver<unknown> | undefined;
		const { host } = await loadedPlugins({
			"@app/mapping": (h) => {
				h.serve(R, {
					compose: (table) => table.reduce((n, e) => n + e.value, 0),
					accepts: {
						1: {
							value: (n) => {
								if (n === 0) throw new Error("old version cannot map the empty table");
								return n;
							},
						},
					},
				});
				h.serve(Contributor, (_, self) => {
					self.contribute(R, 42);
					return {
						n: self.follow(async (followed) => {
							observer = followed;
							return { value: 42, detach() {} };
						}),
					};
				});
			},
		});
		const old = await host.registry(Old, context);
		expect(old.value).toBe(42);
		observer!.end({ kind: "failed", error: new Error("runtime ended") });
		await flushed();
		expect(() => old.value).toThrow("old version cannot map the empty table");
		await host.close(context);
	});

	it("never hands out a mapped native whose contributor failed and closed it (fix round 1, Sol 2)", async () => {
		type Resource = { closed: boolean };
		const Current = defineRegistry<Native<Resource>, readonly Native<Resource>[]>("app.resources", { version: 2 });
		const Old = defineRegistry<Native<Resource>, Native<Resource>>("app.resources", { version: 1 });
		const Owner = local("app.owner", { version: 1, params: {}, members: {} });
		const resource = { closed: false };
		let failRuntime: () => void = () => {};
		const { host } = await loadedPlugins({
			"@app/resources": (h) => {
				h.serve(Current, {
					compose: (table) => table.map(({ value }) => value),
					accepts: {
						1: {
							value: (current) => {
								if (current.length === 0) throw new Error("no current resource");
								return current[0]!;
							},
						},
					},
				});
				h.serve(Owner, (_, self) => {
					const native = self.open(
						async () => resource,
						() => {
							resource.closed = true;
						},
					);
					self.contribute(Current, native);
					self.follow(async (observer) => {
						failRuntime = () => observer.end({ kind: "failed", error: new Error("runtime closed") });
						return { value: 1, detach: () => {} };
					});
					return {};
				});
			},
		});
		const value = await host.registry(Old, context);
		expect(value.value.value).toBe(resource);
		failRuntime();
		await flushed();
		expect(resource.closed).toBe(true);
		expect(() => value.value).toThrow("no current resource");
		await host.close(context);
	});

	it("maps an `undefined` composition (Sol, Astra)", async () => {
		const Nothing = defineRegistry<number, undefined>("app.nothing", { version: 2 });
		const NothingV1 = defineRegistry<number, string>("app.nothing", { version: 1 });
		const { host } = await loadedPlugins({
			"@app/a": (h) => h.serve(Nothing, { compose: () => undefined, accepts: { 1: { value: () => "mapped" } } }),
		});
		expect((await host.registry(NothingV1, context)).value).toBe("mapped");
		await host.close(context);
	});

	it("a failed mapping heals when the composition is the one mapped before (Astra)", async () => {
		const Count = defineRegistry<number, number>("app.count", { version: 2 });
		const CountV1 = defineRegistry<number, number>("app.count", { version: 1 });
		const Counter = local("app.counter", { version: 1, params: {}, members: { set: method(int()) } });
		const { host } = await loadedPlugins({
			"@app/count": (h) => {
				h.serve(Count, {
					compose: (table) => table.reduce((n, { value }) => n + value, 0),
					accepts: {
						1: {
							value: (n) => {
								if (n < 0) throw new Error("negative");
								return n;
							},
						},
					},
				});
				h.serve(Counter, (_, self) => {
					const value = self.writable(1);
					self.contribute(Count, value);
					return {
						set: async (n: number) => {
							value.set(n);
							return null;
						},
					};
				});
			},
		});
		const old = await host.registry(CountV1, context);
		const calls: NativeWatchCall<number>[] = [];
		old.observe({ advance: (call) => calls.push(call), end: () => {} }, context);
		const counter = await host.get(Counter, {}, context);
		await counter.set(-1, context);
		// Back to the composition mapped before (the same number): the mapping heals.
		await counter.set(1, context);
		expect(calls).toEqual([
			{ kind: "failed", error: new Error("negative") },
			{ kind: "value", value: 1 },
		]);
		await host.close(context);
	});
});

describe("readers (S3)", () => {
	const Reader = local("app.reader", { version: 1, params: {}, members: { total: int() } });
	const serveReader = (
		host: Parameters<Parameters<typeof defineFacet>[0]>[0],
		R: Registry<number, { readonly total: number }> = Sum,
	) => host.serve(Reader, (_, self) => ({ total: self.derive([self.registry(R)], ([v]) => v.total) }));

	it("activate once the registry has a value; a reader of a registry nobody serves parks failed { waiting }, `load` waits for nothing", async () => {
		const started = Date.now();
		const { host, errors } = await loadedPlugins({ "@app/reader": (host) => serveReader(host) });
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(errors).toEqual([]);
		expect(host.hold(Reader, {}, context).state.value).toMatchObject({
			kind: "failed",
			cause: {
				kind: "waiting",
				error: {
					code: "unavailable",
					message: "waiting for registry app.sum: registry app.sum: no plugin serves it here",
					cause: { code: "unavailable", reason: "undeclared" },
				},
			},
		});
		expect(await rejection(host.registry(Sum, context, { readyTimeout: 5 }))).toMatchObject({
			code: "unavailable",
			reason: "undeclared",
		});
		await host.close(context);
	});

	it("a reader parked on a first `compose` that threw goes on at the first good composition", async () => {
		const { host, errors } = await loadedPlugins({
			"@app/sum": (host) => {
				host.serve(Sum, {
					compose: (table) => {
						const sum = total(table);
						if (sum.total === 0) throw new Error("empty");
						return sum;
					},
				});
				serveReader(host);
			},
			"@app/setter": (host) => setter(host, 0),
		});
		expect(failures(errors)).toEqual([]);
		const held = host.hold(Reader, {}, context);
		expect(held.state.value).toMatchObject({ kind: "failed", cause: { kind: "waiting" } });
		const setters = await host.get(Setter, {}, context);
		await setters.set(3, context);
		// Woken by the composition: no timer of its own.
		const reader = await host.get(Reader, {}, context, { readyTimeout: 500 });
		held.release();
		expect(reader.total.value).toBe(3);
		await host.close(context);
	});

	it("host.registry before the publication waits for it, then resolves with the provider it served", async () => {
		const host = createHost({ onError: () => {} });
		const waiting = host.registry(Sum, context);
		await host.load([{ name: "@app/sum", facet: defineFacet((h) => h.serve(Sum, { compose: total })) }], context);
		expect((await waiting).value).toEqual({ total: 0 });
		await host.close(context);
	});

	it("host.registry waits through no value until a first good composition, woken by it, its wait then gone", async () => {
		const { host } = await loadedPlugins({
			"@app/sum": (host) => {
				host.serve(Sum, {
					compose: (table) => {
						const sum = total(table);
						if (sum.total === 0) throw new Error("empty");
						return sum;
					},
				});
				setter(host, 0);
			},
		});
		const waiting = host.registry(Sum, context, { readyTimeout: 500 });
		await flushed();
		await (await host.get(Setter, {}, context)).set(5, context);
		expect((await waiting).value).toEqual({ total: 5 });
		await host.close(context);
	});

	it("once live, a later throwing `compose` changes nothing for the reader: `.value` keeps the last good one", async () => {
		const { host } = await loadedPlugins({
			"@app/sum": (host) => {
				host.serve(Sum, {
					compose: (table) => {
						const sum = total(table);
						if (sum.total < 0) throw new Error("negative");
						return sum;
					},
				});
				serveReader(host);
				setter(host, 2);
			},
		});
		const reader = await host.get(Reader, {}, context);
		const setters = await host.get(Setter, {}, context);
		expect(reader.total.value).toBe(2);
		await setters.set(-1, context);
		expect(reader.total.value).toBe(2);
		expect(reader.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});
});

describe("readers' memory", () => {
	it("an ended reader is collected while the registry lives: its derive and its read leave the value", async () => {
		const Reader = local("app.reader", { version: 1, params: { id: int() }, members: { total: int() } });
		const { host } = await loadedPlugins({
			"@app/sum": (host) => {
				host.serve(Sum, { compose: total, accepts: { 1: { value: ({ total }) => total } } });
				host.serve(Reader, (_, self) => ({
					total: self.derive([self.registry(Sum), self.registry(SumV1)], ([v, old]) => v.total + old),
				}));
				setter(host);
			},
		});
		const refs = await (async () => {
			const reader = await host.get(Reader, { id: 1 }, context);
			expect(reader.total.value).toBe(2);
			reader.release();
			await new Promise((resolve) => setTimeout(resolve, 0));
			return objects.filter((ref) => ref.deref()?.label === "app.reader(1)");
		})();
		expect(refs.length).toBeGreaterThan(0);
		await (await host.get(Setter, {}, context)).set(5, context);
		await expectCollected(...refs);
		await host.close(context);
	});
});

describe("values' memory", () => {
	it("drops an older version's mapping once its last reader ended (Sol)", async () => {
		const New = defineRegistry<number, number>("app.version-gc", { version: 2 });
		const Old = defineRegistry<number, { readonly n: number; readonly payload: Uint8Array }>("app.version-gc", {
			version: 1,
		});
		const Reader = local("app.old-reader", { version: 1, params: { id: int() }, members: { n: int() } });
		let mapped: WeakRef<object> | undefined;
		const { host } = await loadedPlugins({
			"@app/a": (h) => {
				h.serve(New, {
					compose: () => 1,
					accepts: {
						1: {
							value: (n) => {
								const value = { n, payload: new Uint8Array(1_000_000) };
								mapped = new WeakRef(value);
								return value;
							},
						},
					},
				});
				h.serve(Reader, (_, self) => ({ n: self.derive([self.registry(Old)], ([v]) => v.n) }));
			},
		});
		const reader = await host.get(Reader, { id: 1 }, context);
		expect(reader.n.value).toBe(1);
		reader.release();
		await flushed();
		await expectCollected(mapped!);
		await host.close(context);
	});

	it("keeps no old composition once its readers stopped waiting and nobody follows it (Opus)", async () => {
		const Big = defineRegistry<number, { readonly payload: number[] }>("app.big", { version: 1 });
		let first = true;
		const made: WeakRef<object>[] = [];
		const Waiting = local("app.waiting", { version: 1, params: {}, members: {} });
		const Counter = local("app.counter", { version: 1, params: {}, members: { set: method(int()) } });
		const { host } = await loadedPlugins({
			"@app/a": (h) => {
				h.serve(Big, {
					compose: (table) => {
						if (first) throw new Error("first");
						const value = { payload: new Array(1000).fill(table.length) };
						made.push(new WeakRef(value));
						return value;
					},
				});
				h.serve(Counter, (_, self) => {
					const value = self.writable(0);
					self.contribute(Big, value);
					return {
						set: async (n: number) => {
							value.set(n);
							return null;
						},
					};
				});
				h.serve(Waiting, (_, self) => {
					void self.registry(Big);
					return {};
				});
			},
		});
		const counter = await host.get(Counter, {}, context);
		first = false;
		// The waiting reader's composition (pulled in the batch of this set) wakes it.
		await counter.set(1, context);
		await flushed();
		await counter.set(2, context);
		void (await host.registry(Big, context)).value;
		await settledHeap();
		// Only the current composition is alive.
		expect(made.map((ref) => ref.deref() !== undefined)).toEqual([false, true]);
		await host.close(context);
	});

	it("a value an app keeps after `host.close` keeps no closed host, and reads its last composition (Sol, Astra)", async () => {
		const Kept = defineRegistry<number, number>("app.kept", { version: 1 });
		const signal = new AbortController();
		const { weak, value } = await (async () => {
			const { host } = await loadedPlugins({ "@app/a": (h) => h.serve(Kept, { compose: () => 7 }) });
			const value = await host.registry(Kept, context);
			value.observe({ advance: () => {}, end: () => {} }, withAbortSignal(signal.signal, context));
			expect(getEventListeners(signal.signal, "abort")).toHaveLength(1);
			await host.close(context);
			// The observation ended with the host: its abort listener went with it.
			expect(getEventListeners(signal.signal, "abort")).toHaveLength(0);
			return { weak: new WeakRef(host), value };
		})();
		await expectCollected(weak);
		expect(value.value).toBe(7);
	});
});

describe("observe", () => {
	it("calls a synchronous observer inside the batch that composed; it counts as watching", async () => {
		const Labels = defineRegistry<string, string>("app.labels", { version: 1 });
		const Label = local("app.label", { version: 1, params: {}, members: { set: method(str()) } });
		const { host } = await loadedPlugins({
			"@app/labels": (host) => {
				host.serve(Labels, { compose: (table) => table.map(({ value }) => value).join(",") });
				host.serve(Label, (_, self) => {
					const label = self.writable("a");
					self.contribute(Labels, label);
					return {
						set: async (text: string) => {
							label.set(text);
							return null;
						},
					};
				});
			},
		});
		const labels = await host.registry(Labels, context);
		const calls: (NativeWatchCall<string> | WatchEnd)[] = [];
		const { context: cancellable, cancel } = withCancel(context);
		const observation = labels.observe(
			{ advance: (call) => calls.push(call), end: (end) => calls.push(end) },
			cancellable,
		);
		expect(observation.value).toBe("a");
		const label = await host.get(Label, {}, context);
		await label.set("b", context);
		// Already called: synchronously, in the set's batch.
		expect(calls).toEqual([{ kind: "value", value: "b" }]);
		cancel();
		await label.set("c", context);
		expect(calls).toEqual([{ kind: "value", value: "b" }, { kind: "aborted" }]);
		const again = labels.observe({ advance: (call) => calls.push(call), end: (end) => calls.push(end) }, context);
		again.detach();
		await label.set("d", context);
		expect(calls).toHaveLength(2);
		labels.observe({ advance: () => {}, end: (end) => calls.push(end) }, context);
		await host.close(context);
		expect(calls.at(-1)).toEqual({ kind: "ended" });
	});
});
