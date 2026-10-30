import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "../../../src/context/index.ts";
import { int, local, method } from "../../../src/next/contracts/index.ts";
import type { ChordHost } from "../../../src/next/host/host.ts";
import type { Self } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { defineRegistry } from "../../../src/next/registries/index.ts";
import type { Writable } from "../../../src/next/state/index.ts";
import type { WritableSource } from "../../../src/next/state/internal.ts";
import type { NativeWatchCall, WatchEnd } from "../../../src/watch.ts";
import { delivered, expectCollected, instancesOf, loaded, metered, rejection, restartable } from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

const Counter = local("app.counter", { version: 1, params: {}, members: { doubled: int(), set: method(int()) } });

/** Serves `Counter` with a writable number, its double as a state member; the writable is handed out to the test. */
async function counter(options: Parameters<typeof loaded>[1] = {}) {
	let writable: Writable<number> | undefined;
	let self: Self | undefined;
	const { host, errors } = await loaded((h) => {
		h.serve(Counter, (_, made) => {
			self = made;
			const value = made.writable(1);
			writable = value;
			return {
				doubled: made.derive([value], ([n]) => n * 2),
				set: async (n: number) => {
					value.set(n);
					return null;
				},
			};
		});
	}, options);
	const reference = await host.get(Counter, {}, context);
	return { host, errors, reference, writable: writable!, self: self! };
}

describe("writable", () => {
	it("a new value (by identity) is a new frame; the same value notifies nobody and costs one comparison", async () => {
		const { telemetry, counts } = await metered();
		const { host, reference, writable } = await counter({ telemetry });
		const calls: NativeWatchCall<number>[] = [];
		(await writable.watch(context)).start(async (call) => void calls.push(call));
		const doubled: number[] = [];
		(await reference.doubled.watch(context)).start(
			async (call) => void (call.kind === "value" && doubled.push(call.value)),
		);
		const computes = counts()["chord.derive.computes"];
		writable.set(1);
		await delivered();
		expect(calls).toEqual([]);
		expect(counts()["chord.derive.computes"]).toBe(computes);
		writable.set(2);
		writable.set(3);
		await delivered();
		expect(calls).toEqual([
			{ kind: "value", value: 2 },
			{ kind: "value", value: 3 },
		]);
		// A JSON watch folds what came while it waited: the derive's last value.
		expect(doubled).toEqual([6]);
		expect(writable.value).toBe(3);
		await host.close(context);
	});

	it("inside a batch, sets mark it there: one frame with the last value, the derives over it computed once", async () => {
		const { telemetry, counts } = await metered();
		const { host, reference, writable } = await counter({ telemetry });
		const calls: NativeWatchCall<number>[] = [];
		(await writable.watch(context)).start(async (call) => void calls.push(call));
		const doubled: number[] = [];
		(await reference.doubled.watch(context)).start(
			async (call) => void (call.kind === "value" && doubled.push(call.value)),
		);
		const computes = counts()["chord.derive.computes"]!;
		(host as unknown as ChordHost).batch.commit(() => {
			writable.set(5);
			writable.set(6);
		}, context);
		await delivered();
		expect(calls).toEqual([{ kind: "value", value: 6 }]);
		expect(doubled).toEqual([12]);
		expect(counts()["chord.derive.computes"]).toBe(computes + 1);
		await host.close(context);
	});

	it("refuses a set inside a derive compute or a compose (`invalid/reentrant`)", async () => {
		const Echo = defineRegistry<number, number>("app.echo", { version: 1 });
		let inner: Writable<number> | undefined;
		const Bad = local("app.bad", { version: 1, params: {}, members: { bad: int() } });
		const Good = local("app.good", { version: 1, params: {}, members: {} });
		const { host, errors } = await loaded((h) => {
			h.serve(Echo, {
				compose: (table) => {
					inner?.set(table.length + 100);
					return table.length;
				},
			});
			h.serve(Good, (_, self) => {
				inner = self.writable(0);
				self.contribute(Echo, inner);
				return {};
			});
			h.serve(Bad, (_, self) => {
				const own = self.writable(0);
				return {
					bad: self.derive([own], ([n]) => {
						own.set(n + 1);
						return n;
					}),
				};
			});
		});
		expect((await host.registry(Echo, context)).value).toBe(0);
		expect(errors.find((error) => error.kind === "registry_failed")).toMatchObject({
			error: { code: "invalid", reason: "reentrant" },
		});
		expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
			object: "app.bad",
			failure: { kind: "broken", error: { code: "invalid", reason: "reentrant" } },
		});
		await host.close(context);
	});

	it("is the attempt's: `set` after its end throws `released`, its watches end `ended`, its value stays readable", async () => {
		let writable: Writable<number> | undefined;
		const { host, restart } = await restartable(objects, (attempt, self) => {
			if (attempt === 1) writable = self.writable(1);
		});
		const watch = await writable!.watch(context);
		await restart();
		expect(await watch.closed).toEqual({ kind: "ended" } satisfies WatchEnd);
		expect(() => writable!.set(2)).toThrow("app.restartable(1): ended");
		expect(writable!.value).toBe(1);
		await host.close(context);
	});

	it("is a contribution, a derive source and an `on` source", async () => {
		const Values = defineRegistry<number, readonly number[]>("app.values", { version: 1 });
		const Source = local("app.source", { version: 1, params: {}, members: { set: method(int()), seen: int() } });
		const seen: number[] = [];
		const { host } = await loaded((h) => {
			h.serve(Values, { compose: (table) => table.map(({ value }) => value) });
			h.serve(Source, (_, self) => {
				const value = self.writable(1);
				self.contribute(Values, value);
				self.on(value, ({ value: n }) => void seen.push(n));
				return {
					seen: self.derive([value], ([n]) => n),
					set: async (n: number) => {
						value.set(n);
						return null;
					},
				};
			});
		});
		const source = await host.get(Source, {}, context);
		const values = await host.registry(Values, context);
		await source.set(2, context);
		await delivered();
		expect(values.value).toEqual([2]);
		expect(source.seen.value).toBe(2);
		expect(seen).toEqual([1, 2]);
		await host.close(context);
	});

	it("is collected with its attempt", async () => {
		const refs = await (async () => {
			const made: WeakRef<object>[] = [];
			const { host, restart } = await restartable(objects, (attempt, self) => {
				if (attempt === 1) made.push(new WeakRef(self.writable({ big: new Array(1000).fill(0) })));
			});
			await restart();
			await host.close(context);
			return made;
		})();
		await expectCollected(...refs);
	});

	it("a set of the same value after its attempt ended throws `released` too (Sol, Astra)", async () => {
		const { host, writable } = await counter();
		await host.close(context);
		expect(() => writable.set(1)).toThrow("app.counter: ended");
	});

	it("a writable an app keeps after `host.close` keeps no closed host; its observers' abort listeners go (Sol)", async () => {
		const signal = new AbortController();
		const { weak, writable } = await (async () => {
			const { host, writable } = await counter();
			(writable as WritableSource<number>).observe(
				{ advance: () => {}, end: () => {} },
				withAbortSignal(signal.signal, context),
			);
			expect(getEventListeners(signal.signal, "abort")).toHaveLength(1);
			await host.close(context);
			expect(getEventListeners(signal.signal, "abort")).toHaveLength(0);
			return { weak: new WeakRef(host), writable };
		})();
		await expectCollected(weak);
		expect(writable.value).toBe(1);
	});

	it("a late callback's set after the host closed throws `released`", async () => {
		const { host, writable } = await counter();
		await host.close(context);
		expect(await rejection(Promise.resolve().then(() => writable.set(9)))).toMatchObject({ code: "released" });
	});
});
