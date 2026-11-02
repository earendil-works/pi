import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { arr, int, local, method, obj, str } from "../../../src/next/contracts/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import type { Self } from "../../../src/next/host/index.ts";
import { ChordObject } from "../../../src/next/host/object.ts";
import { mapShared } from "../../../src/next/state/index.ts";
import { Derive } from "../../../src/next/state/internal.ts";
import type { Watchable } from "../../../src/watch.ts";
import {
	changesOf,
	delivered,
	expectCollected,
	framesOf,
	instancesOf,
	loaded,
	metered,
	restartable,
} from "../support.ts";

const objects = instancesOf(ChordObject, "attempt");

const Num = defineState("num", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });
const Store = local("app.store", {
	version: 1,
	params: {},
	members: { n: int(), double: int(), set: method(int()) },
});

/** A store with a number, its double, and a setter. */
function serveStore(self: Self) {
	const num = self.state(Num);
	return {
		n: self.derive([num], ([v]) => v.n),
		double: self.derive([num], ([v]) => v.n * 2),
		set: async (n: number, ctx: typeof context) => {
			await num.change((draft) => {
				draft.n = n;
			}, ctx);
			return null;
		},
	};
}

/** Counts derive computes on a host's adapter. */
async function computes() {
	const telemetry = await metered();
	return { telemetry: telemetry.telemetry, count: () => telemetry.counts()["chord.derive.computes"] ?? 0 };
}

describe("derives across objects", () => {
	it("update in the batch of the commit that changed their source's object", async () => {
		const Viewer = local("app.viewer", { version: 1, params: {}, members: { label: str() } });
		const { host } = await loaded((h) => {
			h.serve(Store, (_, self) => serveStore(self));
			h.serve(Viewer, (_, self) => ({
				label: self.derive([self.get(Store, {}).double], ([d]) => `double ${d}`),
			}));
		});
		const store = await host.get(Store, {}, context);
		const viewer = await host.get(Viewer, {}, context);
		const frames = framesOf(await viewer.label.watch(context));
		await store.set(2, context);
		await delivered();
		expect(frames).toEqual([["double 4", [["r", "double 4"]]]]);
	});
});

describe("the pull model", () => {
	it("computes a diamond's derives once each per batch", async () => {
		const { telemetry, count } = await computes();
		const Diamond = local("app.diamond", { version: 1, params: {}, members: { d: int(), set: method(int()) } });
		const { host } = await loaded(
			(h) =>
				h.serve(Diamond, (_, self) => {
					const num = self.state(Num);
					const b = self.derive([num], ([v]) => v.n + 1);
					const c = self.derive([num], ([v]) => v.n + 2);
					return {
						d: self.derive([b, c], ([x, y]) => x + y),
						set: async (n, ctx) => {
							await num.change((draft) => {
								draft.n = n;
							}, ctx);
							return null;
						},
					};
				}),
			{ telemetry },
		);
		const diamond = await host.get(Diamond, {}, context);
		const frames = framesOf(await diamond.d.watch(context));
		const before = count();
		await diamond.set(1, context);
		expect(count() - before).toBe(3);
		await delivered();
		expect(frames.map(([value]) => value)).toEqual([5]);
	});

	it("leaves unwatched derives dirty until read; a one-off read does not make them eager", async () => {
		const { telemetry, count } = await computes();
		const { host } = await loaded((h) => h.serve(Store, (_, self) => serveStore(self)), { telemetry });
		const store = await host.get(Store, {}, context);
		const before = count();
		await store.set(1, context);
		expect(count()).toBe(before);
		expect(store.double.value).toBe(2);
		expect(store.double.value).toBe(2);
		expect(count()).toBe(before + 1);
		await store.set(2, context);
		expect(count()).toBe(before + 1);
	});

	it("diffs a watched derive's old and new value (counted), and sends no frame when they are equal", async () => {
		const telemetry = await metered();
		const Parity = local("app.parity", {
			version: 1,
			params: {},
			members: { even: obj({ even: int() }), set: method(int()) },
		});
		const { host } = await loaded(
			(h) =>
				h.serve(Parity, (_, self) => {
					const num = self.state(Num);
					return {
						even: self.derive([num], ([v]) => ({ even: v.n % 2 })),
						set: async (n, ctx) => {
							await num.change((draft) => {
								draft.n = n;
							}, ctx);
							return null;
						},
					};
				}),
			{ telemetry: telemetry.telemetry },
		);
		const parity = await host.get(Parity, {}, context);
		const frames = framesOf(await parity.even.watch(context));
		await parity.set(2, context);
		await parity.set(3, context);
		await delivered();
		expect(frames).toEqual([[{ even: 1 }, [["s", ["even"], 1]]]]);
		expect(telemetry.counts()["chord.derive.diffs"]).toBe(2);
	});
});

describe("failures", () => {
	it("give the throwing derive's watches and those of the derives over it one failure call; they heal on a later change", async () => {
		const { failing, errors } = await failingDerives();
		const [t, u, v] = await Promise.all([
			failing.t.watch(context),
			failing.u.watch(context),
			failing.v.watch(context),
		]);
		const [ts, us] = [changesOf(t), changesOf(u)];
		const frames = framesOf(v);
		await failing.set(1, context);
		await delivered();
		expect(ts).toEqual([{ kind: "failed", error: THREW }]);
		expect(us).toEqual([{ kind: "failed", error: THREW }]);
		expect(() => failing.t.value).toThrow(THREW);
		expect(() => failing.u.value).toThrow(THREW);
		expect(failing.v.value).toBe(1);
		await failing.set(2, context);
		await delivered();
		// Open all along; the next value replaces the root.
		expect(ts.at(-1)).toEqual({ kind: "value", value: 2, ops: [["r", 2]], retired: false });
		expect(us.at(-1)).toEqual({ kind: "value", value: 3, ops: [["r", 3]], retired: false });
		expect(frames.map(([value]) => value)).toEqual([1, 2]);
		// The throwing derive's owner reports it, once; the derive over it (its source failed) does not.
		expect(errors).toEqual([{ kind: "derive_failed", object: "app.failing", member: "t", error: THREW }]);
	});

	it("give one failure call per episode: a recompute that throws again is quiet; a heal ends the episode", async () => {
		const { failing } = await failingDerives();
		const [t, u] = [changesOf(await failing.t.watch(context)), changesOf(await failing.u.watch(context))];
		for (const n of [1, -1, -2, 3, -3]) {
			await failing.set(n, context);
			await delivered();
		}
		const failed = { kind: "failed", error: THREW };
		expect(t).toEqual([failed, { kind: "value", value: 3, ops: [["r", 3]], retired: false }, failed]);
		expect(u).toEqual([failed, { kind: "value", value: 4, ops: [["r", 4]], retired: false }, failed]);
	});

	it("open a new watch on a failed derive at its last good value, the failure its first call, then the heal", async () => {
		const { failing } = await failingDerives();
		await failing.set(5, context);
		// Lazy: the last good value is the last one computed.
		expect(failing.u.value).toBe(6);
		await failing.set(1, context);
		const [t, u] = [await failing.t.watch(context), await failing.u.watch(context)];
		expect([t.value, u.value]).toEqual([5, 6]);
		const [ts, us] = [changesOf(t), changesOf(u)];
		await delivered();
		await failing.set(-1, context);
		await failing.set(7, context);
		await delivered();
		const failed = { kind: "failed", error: THREW };
		expect(ts).toEqual([failed, { kind: "value", value: 7, ops: [["r", 7]], retired: false }]);
		expect(us).toEqual([failed, { kind: "value", value: 8, ops: [["r", 8]], retired: false }]);
	});

	it("report once per failure episode, also when nothing watches (a lazy derive fails when read)", async () => {
		const { failing, errors } = await failingDerives();
		await failing.set(1, context);
		expect(() => failing.t.value).toThrow(THREW);
		expect(() => failing.t.value).toThrow(THREW);
		await failing.set(-1, context);
		expect(() => failing.t.value).toThrow(THREW);
		expect(errors).toHaveLength(1);
		await failing.set(2, context);
		expect(failing.t.value).toBe(2);
		await failing.set(1, context);
		expect(() => failing.t.value).toThrow(THREW);
		expect(errors).toHaveLength(2);
	});

	it("fold a failure and a value for a busy listener: the value replaces the failure, as a root replacement", async () => {
		const { failing } = await failingDerives();
		const watch = await failing.t.watch(context);
		const calls: unknown[] = [];
		const gate = Promise.withResolvers<void>();
		watch.start(async (call) => {
			calls.push(call);
			if (calls.length === 1) await gate.promise;
		});
		await failing.set(5, context);
		await delivered();
		await failing.set(1, context);
		await failing.set(6, context);
		gate.resolve();
		await delivered();
		expect(calls).toEqual([
			{ kind: "value", value: 5, ops: [["r", 5]], retired: false },
			{ kind: "value", value: 6, ops: [["r", 6]], retired: false },
		]);
	});
});

const THREW = new Error("t threw");

/** `app.failing`: `t` throws while `n` is 1 or negative, `u` is `t + 1`, `v` is `n`; the host's reports collected. */
async function failingDerives() {
	const Failing = local("app.failing", {
		version: 1,
		params: {},
		members: { t: int(), u: int(), v: int(), set: method(int()) },
	});
	const { host, errors } = await loaded((h) =>
		h.serve(Failing, (_, self) => {
			const num = self.state(Num);
			const t = self.derive([num], ([v]) => {
				if (v.n === 1 || v.n < 0) throw THREW;
				return v.n;
			});
			return {
				t,
				u: self.derive([t], ([x]) => x + 1),
				v: self.derive([num], ([x]) => x.n),
				set: async (n, ctx) => {
					await num.change((draft) => {
						draft.n = n;
					}, ctx);
					return null;
				},
			};
		}),
	);
	const failing = await host.get(Failing, {}, context);
	return { host, failing, errors };
}

describe("GC", () => {
	it("a detached derive is not held by its former sources", async () => {
		const Viewer = local("app.viewer", { version: 1, params: { id: int() }, members: { label: int() } });
		const refs: WeakRef<object>[] = [];
		const { host } = await loaded((h) => {
			h.serve(Store, (_, self) => serveStore(self));
			h.serve(Viewer, (_, self) => {
				const label = self.derive([self.get(Store, {}).n], ([n]) => n);
				refs.push(new WeakRef(label));
				return { label };
			});
		});
		const store = await host.get(Store, {}, context);
		(await host.get(Viewer, { id: 1 }, context)).release();
		await store.set(1, context);
		await expectCollected(...refs);
	});

	it("a watch open on a failed derive keeps nothing more: it ends with its reference, and a retained one holds no source", async () => {
		const Paged = local("app.paged", {
			version: 1,
			params: { id: int() },
			members: { t: int(), set: method(int()) },
		});
		const refs: WeakRef<object>[] = [];
		const { host } = await loaded((h) =>
			h.serve(Paged, (_, self) => {
				const num = self.state(Num);
				const t = self.derive([num], ([v]) => {
					if (v.n === 1) throw THREW;
					return v.n;
				});
				refs.push(new WeakRef(t), new WeakRef(num));
				return {
					t,
					set: async (n, ctx) => {
						await num.change((draft) => {
							draft.n = n;
						}, ctx);
						return null;
					},
				};
			}),
		);
		const paged = await host.get(Paged, { id: 1 }, context);
		const watch = await paged.t.watch(context);
		const calls = changesOf(watch);
		await paged.set(1, context);
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error: THREW }]);
		paged.release();
		expect(await watch.closed).toEqual({ kind: "ended" });
		// `watch` stays referenced here.
		await expectCollected(...refs);
		void watch;
		await host.close(context);
	});
});

describe("GC of handed-out errors", () => {
	it("a failure call's fresh error kept by its listener keeps nothing of its host once the host closes", async () => {
		const Fresh = local("app.fresh", { version: 1, params: {}, members: { t: int(), set: method(int()) } });
		const refs: WeakRef<object>[] = [];
		const kept: unknown[] = [];
		await (async () => {
			const { host } = await loaded((h) =>
				h.serve(Fresh, (_, self) => {
					const num = self.state(Num);
					const t = self.derive([num], ([v]) => {
						// A fresh error: its stack's frames hold the derive, the document and the attempt.
						if (v.n === 1) throw new Error("fresh");
						return v.n;
					});
					refs.push(new WeakRef(t), new WeakRef(num), new WeakRef(self));
					return {
						t,
						set: async (n, ctx) => {
							await num.change((draft) => {
								draft.n = n;
							}, ctx);
							return null;
						},
					};
				}),
			);
			refs.push(new WeakRef(host));
			const fresh = await host.get(Fresh, {}, context);
			(await fresh.t.watch(context)).start(async (call) => {
				if (call.kind === "failed") kept.push(call.error);
			});
			await fresh.set(1, context);
			await delivered();
			await host.close(context);
		})();
		expect(kept).toHaveLength(1);
		await expectCollected(...refs);
	});
});

describe("mapShared", () => {
	it("maps an object element once while it stays the same object; primitives every time", () => {
		const f = vi.fn((x: { n: number } | number) => (typeof x === "number" ? x : x.n));
		const map = mapShared(f);
		const a = { n: 1 };
		const b = { n: 2 };
		expect(map([a, b, 3])).toEqual([1, 2, 3]);
		expect(map([a, { n: 2 }, 3])).toEqual([1, 2, 3]);
		expect(f.mock.calls.map(([x]) => x)).toEqual([a, b, 3, { n: 2 }, 3]);
	});

	it("keeps no element alive in its cache", async () => {
		const map = mapShared((note: { text: string }) => ({ text: note.text }));
		const refs = (() => {
			const note = { text: "t" };
			const [result] = map([note]);
			return [new WeakRef(note), new WeakRef(result!)];
		})();
		await expectCollected(...refs);
		expect(map([{ text: "u" }])).toEqual([{ text: "u" }]);
	});

	it("returns the previous result object for an unchanged element", () => {
		const strip = mapShared((note: { text: string; at: number }) => ({ text: note.text }));
		const note = { text: "t", at: 1 };
		expect(strip([note])[0]).toBe(strip([note, { text: "u", at: 2 }])[0]);
	});
});

const ListV1 = defineState("list", { schema: obj({ items: arr(str()) }), version: 1, initial: () => ({ items: [] }) });

describe("the retired flag", () => {
	it("a derive over a retired source publishes retired: true although its value and ops are unchanged (rule 21)", async () => {
		let list: SingletonHandle<{ items: string[] }> | undefined;
		let many: Watchable<boolean> | undefined;
		let twice: Watchable<boolean> | undefined;
		await restartable(objects, (_, self) => {
			list = self.state(ListV1);
			many = self.derive([list], ([value]) => value.items.length > 1);
			twice = self.derive([many], ([value]) => !value);
		});
		await list!.change((draft) => void draft.items.push("a"), context);
		const manys = changesOf(await many!.watch(context));
		const twices = changesOf(await twice!.watch(context));
		await list!.retire(context);
		await delivered();
		expect(manys).toEqual([{ kind: "value", value: false, ops: [], retired: true }]);
		expect(twices).toEqual([{ kind: "value", value: true, ops: [], retired: true }]);
		await list!.change((draft) => void draft.items.push("a", "b"), context);
		await delivered();
		expect(manys.at(-1)).toEqual({ kind: "value", value: true, ops: [["r", true]], retired: false });
	});

	it("a retirement while the derive is failed travels with its next good value", async () => {
		const Gate = defineState("gate", { schema: obj({ on: int() }), version: 1, initial: () => ({ on: 0 }) });
		let num: SingletonHandle<{ n: number }> | undefined;
		let gate: SingletonHandle<{ on: number }> | undefined;
		let n: Watchable<number> | undefined;
		await restartable(objects, (_, self) => {
			num = self.state(Num);
			gate = self.state(Gate);
			n = self.derive([num, gate], ([v, g]) => {
				if (g.on === 1 && v.n === 0) throw THREW;
				return v.n;
			});
		});
		await num!.change((draft) => {
			draft.n = 1;
		}, context);
		await gate!.change((draft) => {
			draft.on = 1;
		}, context);
		const calls = changesOf(await n!.watch(context));
		// The retirement makes `n` 0 again, which throws.
		await num!.retire(context);
		await num!.change((draft) => {
			draft.n = 2;
		}, context);
		await delivered();
		expect(calls).toEqual([
			{ kind: "failed", error: THREW },
			{ kind: "value", value: 2, ops: [["r", 2]], retired: true },
		]);
	});

	it("a retirement visits each derive of a diamond once, not once per path (40 derives)", async () => {
		let list: SingletonHandle<{ items: string[] }> | undefined;
		let bottom: Watchable<number> | undefined;
		await restartable(objects, (_, self) => {
			list = self.state(ListV1);
			let previous: Watchable<number> = self.derive([list], ([value]) => value.items.length);
			// 13 layers of two derives joined by a third: 2^13 paths from the top to the bottom.
			for (let layer = 0; layer < 13; layer++) {
				const left = self.derive([previous], ([n]) => n + 1);
				const right = self.derive([previous], ([n]) => n + 2);
				previous = self.derive([left, right], ([a, b]) => a + b);
			}
			bottom = previous;
		});
		await list!.change((draft) => void draft.items.push("a"), context);
		const frames = changesOf(await bottom!.watch(context));
		const visits = vi.spyOn(Derive.prototype, "sourceRetired");
		try {
			await list!.retire(context);
			await delivered();
			expect(visits.mock.calls.length).toBeLessThan(100);
		} finally {
			visits.mockRestore();
		}
		expect(frames.at(-1)).toMatchObject({ retired: true });
	});
});
