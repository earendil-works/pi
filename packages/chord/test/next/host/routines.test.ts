// Tests of routines (§14): `on` (the first call with the current value, folding, no overlap, retries after a throw
// with the whole value, retirements, the source ending or failing, native sources, facets), `onLive` (returning,
// retries, the backoff reset after a long run, aborts), the drain and `host.close`, and what routines leave behind.

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { type Context, BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { Op } from "../../../src/delta/index.ts";
import { int, local, method, obj, remote } from "../../../src/next/contracts/index.ts";
import { defineState, type SingletonHandle } from "../../../src/next/documents/index.ts";
import {
	type Ctx,
	createHost,
	defineFacet,
	type HostError,
	type RefState,
	type Self,
	sleep,
	untilAborted,
} from "../../../src/next/host/index.ts";
import { memoryLinkPair } from "../../../src/next/link/index.ts";
import { jsonPart } from "../../../src/next/link/internal.ts";
import {
	NativeWatch,
	type NativeWatchable,
	type NativeWatchCall,
	Watch,
	type Watchable,
	type WatchCall,
} from "../../../src/watch.ts";
import {
	EDITOR,
	expectCollected,
	fakeTimers,
	flushed,
	linked,
	loaded,
	Notes,
	rawParent,
	serveNotes,
	type TestPrincipal,
	transported,
} from "../support.ts";

/** What an `on` handler gets: a watch's value call. */
type WatchValueCall<T> = Extract<WatchCall<T>, { kind: "value" }>;
type NativeWatchValueCall<T> = Extract<NativeWatchCall<T>, { kind: "value" }>;

const Doc = defineState("doc", { schema: obj({ n: int() }), version: 1, initial: () => ({ n: 0 }) });

/** A host-lifetime object with a counter document and `bump`; its factory declares routines with `routines`. */
const Store = local("app.store", { version: 1, params: {}, members: { n: int(), bump: method() } });

/** The same with params: it lives while referenced. */
const Item = local("app.item", { version: 1, params: { id: int() }, members: { n: int(), bump: method() } });

/** Loads a host serving `Store`; `declare` declares its routines over its document. */
async function store(
	declare: (doc: SingletonHandle<{ n: number }>, self: Self) => void,
	options: { readonly closeTimeout?: number } = {},
) {
	const loadedHost = await loaded(
		(h) =>
			h.serve(Store, (_, self) => {
				const doc = self.state(Doc);
				declare(doc, self);
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			}),
		options,
	);
	const ref = await loadedHost.host.get(Store, {}, context);
	return { ...loadedHost, ref };
}

/** Counts one up in one transaction. */
async function bump(doc: SingletonHandle<{ n: number }>, ctx: Context): Promise<null> {
	await doc.change((d) => {
		d.n++;
	}, ctx);
	return null;
}

/** Waits one macrotask and a little: a call after a busy one waits for one (`settling`). */
function settled(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

/** The routine reports among `errors`, as `kind #position: message`. */
function reports(errors: readonly HostError[]): string[] {
	return errors.flatMap((error) =>
		error.kind === "routine_failed"
			? [`${error.routine.kind} #${error.routine.position}: ${(error.error as Error).message}`]
			: [],
	);
}

/** A JSON watchable (Chord's shared `Watch`) the test advances by hand, as a Durable document would. */
function jsonSource(initial: { n: number }) {
	let value = initial;
	const watches = new Set<Watch<{ n: number }>>();
	const source: Watchable<{ n: number }> = {
		get value() {
			return value;
		},
		async watch(ctx) {
			const watch: Watch<{ n: number }> = new Watch(
				value,
				() => watches.delete(watch),
				() => {},
			);
			watches.add(watch);
			if (ctx.abortSignal !== undefined) watch.observeAbort(ctx.abortSignal);
			return watch;
		},
	};
	const advance = (call: WatchCall<{ n: number }>): void => {
		if (call.kind === "value") value = call.value;
		for (const watch of watches) watch.advance(call, context);
	};
	return { source, advance };
}

/** A native watchable the test sets and ends by hand. */
function writable<T>(initial: T) {
	let value = initial;
	const watches = new Set<NativeWatch<T>>();
	const source: NativeWatchable<T> & { set(next: T): void; end(): void } = {
		get value() {
			return value;
		},
		async watch(ctx) {
			const watch: NativeWatch<T> = new NativeWatch(
				value,
				() => watches.delete(watch),
				() => {},
			);
			watches.add(watch);
			if (ctx.abortSignal !== undefined) watch.observeAbort(ctx.abortSignal);
			return watch;
		},
		set(next) {
			value = next;
			for (const watch of watches) watch.advance(next, context);
		},
		end() {
			for (const watch of watches) watch.end({ kind: "ended" });
		},
	};
	return { source, watches };
}

describe("on", () => {
	it("calls first with the current value as [['r', value]], then once per change with its ops", async () => {
		const calls: [unknown, readonly Op[]][] = [];
		const { ref } = await store((doc, self) => {
			self.on(doc, async ({ value, ops }) => {
				calls.push([value, ops]);
			});
		});
		await flushed();
		await ref.bump(context);
		await flushed();
		expect(calls).toEqual([
			[{ n: 0 }, [["r", { n: 0 }]]],
			[{ n: 1 }, [["s", ["n"], 1]]],
		]);
	});

	it("never overlaps calls: changes during a call fold into the next, which is not aborted by them", async () => {
		const gate = Promise.withResolvers<void>();
		const calls: [unknown, readonly Op[]][] = [];
		let running = 0;
		let overlapped = false;
		let aborted = false;
		const { ref } = await store((doc, self) => {
			self.on(doc, async ({ value, ops }, ctx) => {
				overlapped ||= running > 0;
				running++;
				calls.push([value, ops]);
				if (calls.length === 2) await gate.promise;
				aborted ||= ctx.abortSignal?.aborted === true;
				running--;
			});
		});
		await flushed();
		await ref.bump(context);
		await flushed();
		await ref.bump(context);
		await ref.bump(context);
		gate.resolve();
		await settled();
		expect(calls.map(([value]) => value)).toEqual([{ n: 0 }, { n: 1 }, { n: 3 }]);
		expect(calls[2]![1]).toEqual([["s", ["n"], 3]]);
		expect({ overlapped, aborted }).toEqual({ overlapped: false, aborted: false });
	});

	describe("after a throw", () => {
		fakeTimers();

		it("reports, keeps the watch, and calls again with [['r', value]] after 1 s doubling; success resets", async () => {
			const calls: [unknown, readonly Op[], number][] = [];
			let failing = 3;
			const { ref, errors } = await store((doc, self) => {
				self.on(doc, async ({ value, ops }) => {
					calls.push([value, ops, Date.now()]);
					if (failing-- > 0) throw new Error(`fail ${calls.length}`);
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(2_000);
			await vi.advanceTimersByTimeAsync(4_000);
			expect(calls.map(([, , at]) => at)).toEqual([0, 1_000, 3_000, 7_000]);
			expect(calls.every(([, ops]) => ops[0]![0] === "r")).toBe(true);
			expect(reports(errors)).toEqual(["on #1: fail 1", "on #1: fail 2", "on #1: fail 3"]);
			// Succeeded: the next change gets its ops, and a later throw backs off from 1 s again.
			await ref.bump(context);
			await vi.advanceTimersByTimeAsync(0);
			expect(calls.at(-1)!.slice(0, 2)).toEqual([{ n: 1 }, [["s", ["n"], 1]]]);
			failing = 1;
			await ref.bump(context);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(calls.map(([, , at]) => at).slice(-2)).toEqual([7_000, 8_000]);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("retries a change folded behind the throwing call after the backoff, once: no third call, no timer", async () => {
			const gate = Promise.withResolvers<void>();
			const calls: [unknown, readonly Op[], number][] = [];
			const { ref } = await store((doc, self) => {
				self.on(doc, async ({ value, ops }) => {
					calls.push([value, ops, Date.now()]);
					if (calls.length === 1) {
						await gate.promise;
						throw new Error("first");
					}
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			await ref.bump(context);
			gate.resolve();
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(5_000);
			expect(calls).toEqual([
				[{ n: 0 }, [["r", { n: 0 }]], 0],
				[{ n: 1 }, [["r", { n: 1 }]], 1_000],
			]);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("makes one retry per throw; a change during a failing retry waits for its backoff; no timer left", async () => {
			const calls: [unknown, number][] = [];
			const { host, errors } = await loaded((h) =>
				h.serve(Item, (_, self) => {
					const doc = self.state(Doc);
					self.on(doc, async ({ value }) => {
						calls.push([value, Date.now()]);
						// The retry at 1 s changes the source, then throws too.
						if (calls.length === 2) await bump(doc, context);
						if (calls.length <= 2) throw new Error(`fail ${calls.length}`);
					});
					return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
				}),
			);
			const item = await host.get(Item, { id: 1 }, context);
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(calls).toEqual([
				[{ n: 0 }, 0],
				[{ n: 0 }, 1_000],
				[{ n: 1 }, 3_000],
			]);
			expect(reports(errors)).toEqual(["on #1: fail 1", "on #1: fail 2"]);
			expect(vi.getTimerCount()).toBe(0);
			item.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("backs off after a throw even when the failed call changed its own source: no burst", async () => {
			const calls: number[] = [];
			const { errors } = await store((doc, self) => {
				self.on(doc, async (_change, ctx) => {
					calls.push(Date.now());
					if (calls.length > 100) return;
					// A reconciler that records its attempt in its own source, then fails.
					await bump(doc, ctx);
					throw new Error("downstream unavailable");
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toEqual([0]);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(calls).toEqual([0, 1_000, 3_000]);
			expect(reports(errors)).toHaveLength(3);
		});

		it("retries with the value that arrived during the failed call, as a whole value", async () => {
			const calls: [unknown, readonly Op[], number][] = [];
			await store((doc, self) => {
				self.on(doc, async ({ value, ops }, ctx) => {
					calls.push([value, ops, Date.now()]);
					if (calls.length > 1) return;
					await bump(doc, ctx);
					throw new Error("once");
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(calls).toEqual([
				[{ n: 0 }, [["r", { n: 0 }]], 0],
				[{ n: 1 }, [["r", { n: 1 }]], 1_000],
			]);
		});

		it("folds changes made during a slow retry into one call with the newest value", async () => {
			const gate = Promise.withResolvers<void>();
			const calls: [unknown, readonly Op[]][] = [];
			const { ref } = await store((doc, self) => {
				self.on(doc, async ({ value, ops }) => {
					calls.push([value, ops]);
					if (calls.length === 1) throw new Error("first");
					if (calls.length === 2) await gate.promise;
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			for (let i = 0; i < 3; i++) await ref.bump(context);
			gate.resolve();
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toEqual([
				[{ n: 0 }, [["r", { n: 0 }]]],
				[{ n: 0 }, [["r", { n: 0 }]]],
				[{ n: 3 }, [["s", ["n"], 3]]],
			]);
		});

		it("waits for the next good value when its source fails during the backoff: the retry is dropped", async () => {
			const calls: unknown[] = [];
			let set: ((n: number) => Promise<unknown>) | undefined;
			const { errors } = await store((doc, self) => {
				const failing = self.derive([doc], ([d]) => {
					if (d.n < 0) throw new Error("compute");
					return d.n;
				});
				set = (n) =>
					doc.change((d) => {
						d.n = n;
					}, context);
				self.on(failing, async ({ value }) => {
					calls.push(value);
					if (value === 1) throw new Error("handler threw");
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			await set!(1);
			await vi.advanceTimersByTimeAsync(0);
			await set!(-1);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(calls).toEqual([0, 1]);
			expect(vi.getTimerCount()).toBe(0);
			await set!(3);
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toEqual([0, 1, 3]);
			expect(reports(errors)).toEqual(["on #1: handler threw"]);
		});

		it("clears its retry timer when its object ends during the backoff", async () => {
			const { host } = await loaded((h) =>
				h.serve(Item, (_, self) => {
					const doc = self.state(Doc);
					self.on(doc, async () => {
						throw new Error("always");
					});
					return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
				}),
			);
			const item = await host.get(Item, { id: 1 }, context);
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(1);
			item.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(vi.getTimerCount()).toBe(0);
		});

		it("reports a retirement again on the retry after the call that got it threw", async () => {
			const { source, advance } = jsonSource({ n: 0 });
			const calls: WatchValueCall<{ n: number }>[] = [];
			await store((_, self) => {
				self.on(source, async (call) => {
					calls.push(call);
					if (calls.length === 2) throw new Error("retirement not handled");
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			advance({ kind: "value", value: { n: 0 }, ops: [], retired: true });
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(1_000);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(calls.slice(1)).toEqual([
				{ kind: "value", value: { n: 0 }, ops: [], retired: true },
				{ kind: "value", value: { n: 0 }, ops: [["r", { n: 0 }]], retired: true },
			]);
		});

		it("calls at once with the newest whole value when the source changes during the backoff", async () => {
			const calls: [unknown, readonly Op[], number][] = [];
			const { ref } = await store((doc, self) => {
				self.on(doc, async ({ value, ops }) => {
					calls.push([value, ops, Date.now()]);
					if (calls.length === 1) throw new Error("first");
				});
			});
			await vi.advanceTimersByTimeAsync(0);
			await vi.advanceTimersByTimeAsync(500);
			await ref.bump(context);
			await vi.advanceTimersByTimeAsync(0);
			await ref.bump(context);
			await vi.advanceTimersByTimeAsync(0);
			expect(calls).toEqual([
				[{ n: 0 }, [["r", { n: 0 }]], 0],
				[{ n: 1 }, [["r", { n: 1 }]], 500],
				[{ n: 2 }, [["s", ["n"], 2]], 500],
			]);
			// The backoff timer is gone: nothing calls again.
			await vi.advanceTimersByTimeAsync(10_000);
			expect(calls).toHaveLength(3);
		});
	});

	it("folds every change made during the first call into one next call: [0, 3], not [0, 1, 3]", async () => {
		const gate = Promise.withResolvers<void>();
		const calls: [unknown, readonly Op[]][] = [];
		const { ref } = await store((doc, self) => {
			self.on(doc, async ({ value, ops }) => {
				calls.push([value, ops]);
				if (calls.length === 1) await gate.promise;
			});
		});
		await flushed();
		for (let i = 0; i < 3; i++) await ref.bump(context);
		await flushed();
		gate.resolve();
		await settled();
		expect(calls).toEqual([
			[{ n: 0 }, [["r", { n: 0 }]]],
			[{ n: 3 }, [["s", ["n"], 3]]],
		]);
	});

	it("follows an app's JSON watchable whose watch is Chord's shared Watch with ops, as its type says", async () => {
		const { source, advance } = jsonSource({ n: 0 });
		const calls: [unknown, readonly Op[]][] = [];
		await store((_, self) => {
			self.on(source, async ({ value, ops }) => void calls.push([value, ops]));
		});
		await flushed();
		advance({ kind: "value", value: { n: 1 }, ops: [["s", ["n"], 1]], retired: false });
		await flushed();
		expect(calls).toEqual([
			[{ n: 0 }, [["r", { n: 0 }]]],
			[{ n: 1 }, [["s", ["n"], 1]]],
		]);
	});

	it("reports a retirement as retired, folded with the changes around it into one call, and goes on", async () => {
		const gate = Promise.withResolvers<void>();
		const { source, advance } = jsonSource({ n: 0 });
		const calls: WatchValueCall<{ n: number }>[] = [];
		await store((_, self) => {
			self.on(source, async (call) => {
				calls.push(call);
				if (calls.length === 1) await gate.promise;
			});
		});
		await flushed();
		// A Durable document retired (the last value, no ops) and created again, while the first call runs.
		advance({ kind: "value", value: { n: 0 }, ops: [], retired: true });
		advance({ kind: "value", value: { n: 5 }, ops: [["r", { n: 5 }]], retired: false });
		gate.resolve();
		await settled();
		advance({ kind: "value", value: { n: 6 }, ops: [["s", ["n"], 6]], retired: false });
		await flushed();
		expect(calls).toEqual([
			{ kind: "value", value: { n: 0 }, ops: [["r", { n: 0 }]], retired: false },
			{ kind: "value", value: { n: 5 }, ops: [["r", { n: 5 }]], retired: true },
			{ kind: "value", value: { n: 6 }, ops: [["s", ["n"], 6]], retired: false },
		]);
	});

	it("folds a native source to its newest value after a busy call", async () => {
		const gate = Promise.withResolvers<void>();
		const { source } = writable("a");
		const calls: unknown[] = [];
		await store((_, self) => {
			self.on(source, async ({ value }: { value: string }) => {
				calls.push(value);
				if (calls.length === 1) await gate.promise;
			});
		});
		await flushed();
		source.set("b");
		source.set("c");
		await flushed();
		gate.resolve();
		await settled();
		expect(calls).toEqual(["a", "c"]);
	});

	it("takes every value a busy call left buffered before calling again: [0, 20], also when it set them itself", async () => {
		const { source } = writable(0);
		const calls: unknown[] = [];
		await store((_, self) => {
			self.on(source, async ({ value }: { value: number }) => {
				calls.push(value);
				if (value === 0) for (let n = 1; n <= 20; n++) source.set(n);
			});
		});
		await settled();
		expect(calls).toEqual([0, 20]);
		const gate = Promise.withResolvers<void>();
		const later = writable(0);
		const seen: unknown[] = [];
		await store((_, self) => {
			self.on(later.source, async ({ value }: { value: number }) => {
				seen.push(value);
				if (value === 0) await gate.promise;
			});
		});
		await flushed();
		for (let n = 1; n <= 20; n++) later.source.set(n);
		// No flush in between: the watch still holds the values when the call ends.
		gate.resolve();
		await settled();
		expect(seen).toEqual([0, 20]);
	});

	it("reports a source whose watch cannot be taken; a source that ended meanwhile ends it quietly", async () => {
		const failing: NativeWatchable<number> = {
			value: 0,
			watch: async () => {
				throw new Error("no watch");
			},
		};
		const ended: NativeWatchable<number> = {
			value: 0,
			watch: async () => {
				const watch = new NativeWatch(
					0,
					() => {},
					() => {},
				);
				watch.end({ kind: "ended" });
				return watch;
			},
		};
		const calls: unknown[] = [];
		const { errors } = await store((_, self) => {
			self.on(failing, async ({ value }) => void calls.push(value));
			self.on(ended, async ({ value }) => void calls.push(value));
		});
		await flushed();
		expect(calls).toEqual([]);
		expect(reports(errors)).toEqual(["on #1: no watch"]);
	});

	it("ends without a report when its source ends", async () => {
		const Other = local("app.other", { version: 1, params: { id: int() }, members: { n: int() } });
		let otherDoc: SingletonHandle<{ n: number }> | undefined;
		const calls: unknown[] = [];
		const { host, errors } = await loaded((h) => {
			h.serve(Other, (_, self) => {
				otherDoc = self.state(Doc);
				return { n: self.derive([otherDoc], ([d]) => d.n) };
			});
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				// Another object's document: it ends with that object.
				self.on(otherDoc!, async ({ value }) => void calls.push(value));
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			});
		});
		const other = await host.get(Other, { id: 1 }, context);
		await host.get(Item, { id: 1 }, context);
		await flushed();
		other.release();
		await flushed();
		expect(calls).toEqual([{ n: 0 }]);
		expect(errors).toEqual([]);
	});

	it("is not called for its source's failures: it waits for the next value (a derive healing)", async () => {
		const calls: unknown[] = [];
		const { ref, errors } = await store((doc, self) => {
			const failing = self.derive([doc], ([d]) => {
				if (d.n > 0 && d.n < 3) throw new Error("compute");
				return d.n;
			});
			self.on(failing, async ({ value, ops }) => void calls.push([value, ops]));
		});
		await flushed();
		await ref.bump(context);
		await ref.bump(context);
		await flushed();
		expect(calls).toEqual([[0, [["r", 0]]]]);
		await ref.bump(context);
		await flushed();
		expect(calls).toEqual([
			[0, [["r", 0]]],
			[3, [["r", 3]]],
		]);
		// The derive's owner reports the failure (once for the episode); the routine reports nothing.
		expect(errors).toEqual([expect.objectContaining({ kind: "derive_failed", error: new Error("compute") })]);
	});

	it("drops a value queued behind a busy call when a failure follows it; the next call is the healed value", async () => {
		const calls: unknown[] = [];
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		let set: ((n: number) => Promise<unknown>) | undefined;
		const { errors } = await store((doc, self) => {
			const failing = self.derive([doc], ([d]) => {
				if (d.n < 0) throw new Error("compute");
				return d.n;
			});
			set = (n) =>
				doc.change((d) => {
					d.n = n;
				}, context);
			self.on(failing, async ({ value }) => {
				calls.push(value);
				if (value === 1) {
					entered.resolve();
					await gate.promise;
				}
			});
		});
		await flushed();
		await set!(1);
		await entered.promise;
		// Queued behind the busy call, then replaced by the failure.
		await set!(2);
		await set!(-1);
		gate.resolve();
		await settled();
		expect(calls).toEqual([0, 1]);
		await set!(3);
		await settled();
		expect(calls).toEqual([0, 1, 3]);
		expect(reports(errors)).toEqual([]);
	});

	it("starts on a source failed now: no call and no report until its first good value (a reference member)", async () => {
		const Failing = local("app.failing", { version: 1, params: {}, members: { t: int(), set: method(int()) } });
		const Viewer = local("app.on-viewer", { version: 1, params: { id: int() }, members: { m: method() } });
		const calls: unknown[] = [];
		const { host, errors } = await loaded((h) => {
			h.serve(Failing, (_, self) => {
				const doc = self.state(Doc);
				return {
					t: self.derive([doc], ([d]) => {
						if (d.n === 1) throw new Error("t threw");
						return d.n;
					}),
					set: async (n, ctx) => {
						await doc.change((d) => {
							d.n = n;
						}, ctx);
						return null;
					},
				};
			});
			h.serve(Viewer, (_, self) => {
				self.on(self.get(Failing, {}).t, async ({ value, ops }) => void calls.push([value, ops]));
				return { m: async () => null };
			});
		});
		const failing = await host.get(Failing, {}, context);
		await failing.set(1, context);
		const viewer = await host.get(Viewer, { id: 1 }, context);
		await settled();
		expect(calls).toEqual([]);
		await failing.set(2, context);
		await settled();
		expect(calls).toEqual([[2, [["r", 2]]]]);
		expect(errors.map(({ kind }) => kind)).toEqual(["derive_failed"]);
		viewer.release();
		await host.close(context);
	});

	it("follows a reference member: the provider's value first, then its changes", async () => {
		const calls: [unknown, readonly Op[]][] = [];
		let bumper: (() => Promise<null>) | undefined;
		const { host } = await loaded((h) => {
			h.serve(Store, (_, self) => {
				const doc = self.state(Doc);
				bumper = () => bump(doc, context);
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			});
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				const store = self.get(Store, {});
				self.on(store.n, async ({ value, ops }) => void calls.push([value, ops]));
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			});
		});
		await host.get(Item, { id: 1 }, context);
		await flushed();
		await bumper!();
		await flushed();
		expect(calls).toEqual([
			[0, [["r", 0]]],
			[1, [["r", 1]]],
		]);
	});

	it("converges when it writes its own source: an unchanged draft commits nothing", async () => {
		let calls = 0;
		await store((doc, self) => {
			self.on(doc, async ({ value }, ctx) => {
				calls++;
				await doc.change((d) => {
					d.n = Math.min(value.n + 1, 3);
				}, ctx);
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		// 0 → 1 → 2 → 3, then the write of 3 changes nothing and nothing calls again.
		expect(calls).toBe(4);
	});

	it("follows a native source: one call per new value, without ops; ends with it", async () => {
		const { source, watches } = writable("a");
		const calls: unknown[] = [];
		const { errors } = await store((_, self) => {
			self.on(source, async (call) => void calls.push(call));
		});
		await flushed();
		source.set("b");
		source.set("c");
		await settled();
		expect(calls).toEqual([
			{ kind: "value", value: "a" },
			{ kind: "value", value: "b" },
			{ kind: "value", value: "c" },
		]);
		source.end();
		expect(watches.size).toBe(0);
		expect(errors).toEqual([]);
	});

	it("on a remote member with no value yet, a first value followed at once by a failure calls nothing", async () => {
		const Viewer = local("app.viewer", { version: 1, params: { id: int() }, members: {} });
		const calls: unknown[] = [];
		const client = createHost<TestPrincipal>({ onError: () => {} });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(Viewer, (_, self) => {
				self.on(self.get(Notes, { session: "S1" }).count, async ({ value }) => void calls.push(value));
				return {};
			}),
		);
		await client.load([{ name: "@test/client", facet }], context);
		const peer = await rawParent(client);
		const getting = client.get(Viewer, { id: 1 }, context);
		const { hold } = await peer.next("hold");
		const member = EDITOR.state.count!;
		const failed = [{ member, error: { kind: "plugin", code: "internal", message: "count threw" } } as const];
		const notes = { member: EDITOR.state.notes!, value: jsonPart([]) };
		peer.send({ kind: "bound", holds: [{ hold, variant: EDITOR.variant, members: [notes], failed }] });
		await getting;
		await transported();
		// Two state messages in one receive turn: the first value, then a failure again.
		const value = (n: number) => [{ member, ops: jsonPart([["r", n]]) }];
		peer.send({ kind: "state", holds: [{ hold, members: value(5), failed: [], retired: [] }] });
		peer.send({ kind: "state", holds: [{ hold, members: [], failed, retired: [] }] });
		await transported();
		await flushed();
		expect(calls).toEqual([]);
		peer.send({ kind: "state", holds: [{ hold, members: value(6), failed: [], retired: [] }] });
		await transported();
		await flushed();
		expect(calls).toEqual([6]);
		await client.close(context);
	});

	it("on a remote member failed since its binding (no value yet), waits for its first value", async () => {
		const Halves = remote("app.halves", {
			version: 1,
			params: {},
			variants: { v: { state: { half: int() }, methods: { set: method(int()) } } },
		});
		const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		const serve = defineFacet<TestPrincipal>((h) =>
			h.serve(Halves, (_, _principal, self) => {
				const doc = self.state(Doc);
				return {
					variant: "v",
					members: {
						half: self.derive([doc], ([{ n }]) => {
							if (n === 2) throw new Error("half threw");
							return n / 2;
						}),
						set: async (n, ctx) => {
							await doc.change((d) => {
								d.n = n;
							}, ctx);
							return null;
						},
					},
				};
			}),
		);
		await server.load([{ name: "@test/app", facet: serve }], context);
		const halves = await server.get(Halves, {}, context);
		if (halves.variant !== "v") throw new Error("expected variant v");
		await halves.set(2, context);
		const Viewer = local("app.viewer", { version: 1, params: { id: int() }, members: {} });
		const calls: unknown[] = [];
		const errors: HostError[] = [];
		const client = createHost<TestPrincipal>({ onError: (error) => errors.push(error) });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(Viewer, (_, self) => {
				self.on(self.get(Halves, {}).half, async ({ value, ops }) => void calls.push([value, ops]));
				return {};
			}),
		);
		await client.load([{ name: "@test/client", facet }], context);
		const [a, b] = memoryLinkPair();
		// The server's own principal: the client holds the object `halves` refers to.
		server.accept(a, { principal: { kind: "server" } }, context);
		client.connect(b, { principal: { kind: "server" } }, context);
		await client.get(Viewer, { id: 1 }, context);
		await transported();
		await flushed();
		expect([calls, errors]).toEqual([[], []]);
		await halves.set(4, context);
		await transported();
		await flushed();
		expect(calls).toEqual([[2, [["r", 2]]]]);
		await client.close(context);
		await server.close(context);
	});

	it("follows ref.state: a reference over a link going loading and live again", async () => {
		const server = createHost<TestPrincipal>({ principal: { kind: "server" }, onError: () => {} });
		await server.load([{ name: "@test/app", facet: defineFacet<TestPrincipal>((h) => void serveNotes(h)) }], context);
		const Viewer = local("app.viewer", { version: 1, params: { id: int() }, members: {} });
		const states: string[] = [];
		const client = createHost<TestPrincipal>({ onError: () => {} });
		const facet = defineFacet<TestPrincipal>((h) =>
			h.serve(Viewer, (_, self) => {
				const notes = self.get(Notes, { session: "S1" });
				self.on(notes.state, async ({ value: state }: { value: RefState }) => void states.push(state.kind));
				return {};
			}),
		);
		await client.load([{ name: "@test/client", facet }], context);
		const connect = () => {
			const [a, b] = memoryLinkPair();
			server.accept(a, { principal: { kind: "owner" } }, context);
			client.connect(b, { principal: { kind: "server" } }, context);
			return a;
		};
		const link = connect();
		await client.get(Viewer, { id: 1 }, context);
		await flushed();
		link.close();
		await transported();
		connect();
		await transported();
		await flushed();
		expect(states).toEqual(["live", "loading", "live"]);
		await client.close(context);
		await server.close(context);
	});

	it("releases its watch when its object ends; a call that throws as it ends is not reported", async () => {
		const { source, watches } = writable(0);
		const { host, errors } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				self.on(source, async (_change, ctx) => {
					await untilAborted(ctx);
					throw new Error("stopping");
				});
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		await flushed();
		expect(watches.size).toBe(1);
		item.release();
		await flushed();
		expect(watches.size).toBe(0);
		expect(errors).toEqual([]);
	});
});

describe("onLive", () => {
	fakeTimers();

	it("is called once when its object is live; returning ends it", async () => {
		let calls = 0;
		await store((_, self) => {
			self.onLive(async () => {
				calls++;
			});
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(calls).toBe(1);
	});

	it("restarts after a throw with the backoff, reset after a run of at least a minute", async () => {
		const starts: number[] = [];
		const { errors } = await store((_, self) => {
			self.onLive(async (ctx) => {
				starts.push(Date.now());
				if (starts.length === 3) await sleep(60_000, ctx);
				throw new Error(`run ${starts.length}`);
			});
		});
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(2_000 + 60_000);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(starts).toEqual([0, 1_000, 3_000, 64_000]);
		expect(reports(errors)).toEqual(["onLive #1: run 1", "onLive #1: run 2", "onLive #1: run 3", "onLive #1: run 4"]);
	});

	it("is aborted by its object's end: no report, no restart", async () => {
		let calls = 0;
		const { host, errors } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				self.onLive(async (ctx) => {
					calls++;
					await sleep(1_000_000, ctx);
				});
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		await vi.advanceTimersByTimeAsync(0);
		item.release();
		await vi.advanceTimersByTimeAsync(10_000);
		expect({ calls, errors, timers: vi.getTimerCount() }).toEqual({ calls: 1, errors: [], timers: 0 });
	});
});

describe("routines and the end", () => {
	it("start in the turn their object went live, next to a method call admitted in that turn", async () => {
		const order: string[] = [];
		const { host } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				self.on(doc, async ({ value }) => void order.push(`on ${value.n}`));
				self.onLive(async () => void order.push("onLive"));
				return {
					n: self.derive([doc], ([d]) => d.n),
					bump: async (ctx) => {
						order.push("bump");
						return bump(doc, ctx);
					},
				};
			}),
		);
		const item = host.hold(Item, { id: 1 }, context);
		const bumped = item.bump(context);
		// The parked call runs as the object goes live, then `onLive` in that turn, the first `on` call after its watch;
		// the call's commit may land while `on 0` runs, and a call after a busy one waits for the settling turn.
		await item.state.watch(context).then((watch) => watch.stop());
		await bumped;
		await settled();
		expect(order).toEqual(["bump", "onLive", "on 0", "on 1"]);
	});

	it("never start a routine call once the object ended in its first turn: no call, no report, no rejection", async () => {
		const calls: string[] = [];
		let held: { release(): void } | undefined;
		const { host, errors } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				self.on(doc, async () => void calls.push("on"));
				self.onLive(async () => {
					calls.push("onLive #1");
					held!.release();
				});
				self.onLive(async () => void calls.push("onLive #2"));
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			}),
		);
		held = host.hold(Item, { id: 1 }, context);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect({ calls, errors }).toEqual({ calls: ["onLive #1"], errors: [] });
	});

	it("are in the drain before their handler runs: a handler releasing the last reference keeps natives open", async () => {
		const gate = Promise.withResolvers<void>();
		const events: string[] = [];
		let held: { release(): void } | undefined;
		const { host } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				self.open(
					async () => null,
					() => void events.push("native closed"),
				);
				self.on(doc, async ({ value }) => {
					if (value.n === 0) return;
					// Ends its own object before its first await.
					held!.release();
					await gate.promise;
					events.push("handler done");
				});
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		held = item;
		await flushed();
		// The call may see its object end: its own routine ends it.
		await item.bump(context).catch(() => {});
		await flushed();
		expect(events).toEqual([]);
		gate.resolve();
		await flushed();
		expect(events).toEqual(["handler done", "native closed"]);
	});

	it("make no call queued behind a busy one once the object ended", async () => {
		const gate = Promise.withResolvers<void>();
		const calls: unknown[] = [];
		const { host } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				self.on(doc, async ({ value }) => {
					calls.push(value);
					await gate.promise;
				});
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		await flushed();
		await item.bump(context);
		await flushed();
		item.release();
		gate.resolve();
		await flushed();
		expect(calls).toEqual([{ n: 0 }]);
	});

	it("release their calls' ctx.get references when each call settles", async () => {
		const Other = local("app.other", { version: 1, params: { id: int() }, members: { n: int() } });
		const { host } = await loaded((h) => {
			h.serve(Other, (_, self) => ({ n: self.derive([self.state(Doc)], ([d]) => d.n) }));
			h.serve(Store, (_, self) => {
				const doc = self.state(Doc);
				self.onLive(async (ctx) => {
					await ctx.get(Other, { id: 1 });
				});
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			});
		});
		await flushed();
		expect(host.references(Other).value).toEqual([]);
	});

	it("act as a remote object's principal", async () => {
		const Watcher = remote("app.watcher", { version: 1, params: {}, variants: { v: { state: {} } } });
		const seen: unknown[] = [];
		const { client } = await linked(
			(h) =>
				h.serve(Watcher, (_, _principal, self) => {
					self.onLive(async (ctx) => void seen.push(ctx.principal));
					return { variant: "v", members: {} };
				}),
			{ child: { kind: "guest", session: "S1" } },
		);
		await client.get(Watcher, {}, context);
		await flushed();
		expect(seen).toEqual([{ kind: "guest", session: "S1" }]);
	});

	it("type their handler by the source's kind: ops and retired for a JSON watchable, the value alone for a native one", () => {
		const declare = (self: Self<TestPrincipal>, doc: Watchable<{ n: number }>, state: NativeWatchable<RefState>) => {
			self.on(doc, async (call, ctx) => {
				expectTypeOf(call).toEqualTypeOf<WatchValueCall<{ n: number }>>();
				expectTypeOf(call.ops).toEqualTypeOf<readonly Op[]>();
				expectTypeOf(call.retired).toEqualTypeOf<boolean>();
				expectTypeOf(ctx).toEqualTypeOf<Ctx<TestPrincipal>>();
			});
			self.on(state, async (call, ctx) => {
				expectTypeOf(call).toEqualTypeOf<NativeWatchValueCall<RefState>>();
				expectTypeOf(ctx).toEqualTypeOf<Ctx<TestPrincipal>>();
			});
		};
		void declare;
	});

	it("are aborted by host.close, which drains their running calls (bounded by closeTimeout)", async () => {
		const ended: string[] = [];
		const { host, errors } = await loaded(
			(h) => {
				h.serve(Store, (_, self) => {
					const doc = self.state(Doc);
					self.onLive(async (ctx) => {
						await new Promise((resolve) => ctx.abortSignal?.addEventListener("abort", resolve));
						await new Promise((resolve) => setTimeout(resolve, 10));
						ended.push("object");
					});
					self.onLive(async () => {
						// Never stops: the drain gives up at closeTimeout.
						await new Promise(() => {});
					});
					return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
				});
			},
			{ closeTimeout: 50 },
		);
		await flushed();
		await host.close(context);
		expect(ended).toEqual(["object"]);
		expect(errors).toEqual([{ kind: "drain_timeout", object: "app.store" }]);
	});

	it("leave nothing of an ended object: its routines' watches and contexts are collected", async () => {
		const { source, watches } = writable(0);
		let refs: WeakRef<object>[] = [];
		const { host } = await loaded((h) =>
			h.serve(Item, (_, self) => {
				const doc = self.state(Doc);
				self.on(source, async (_change, ctx) => void refs.push(new WeakRef(ctx)));
				self.on(doc, async (_change, ctx) => void refs.push(new WeakRef(ctx)));
				return { n: self.derive([doc], ([d]) => d.n), bump: async (ctx) => bump(doc, ctx) };
			}),
		);
		const item = await host.get(Item, { id: 1 }, context);
		await flushed();
		item.release();
		await flushed();
		expect({ watches: watches.size, calls: refs.length }).toEqual({ watches: 0, calls: 2 });
		await expectCollected(...refs);
		refs = [];
	});
});
