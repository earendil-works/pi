// Tests of `self.follow` (slice 6b §3, D9, R4): a source over another runtime's synchronous observer, attached during
// activation, its calls marked in the running batch or grouped into one batch outside it, its ends.

import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { Op } from "../../../src/delta/index.ts";
import { int, local, obj } from "../../../src/next/contracts/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { FollowSource } from "../../../src/next/host/follow.ts";
import type { ChordHost } from "../../../src/next/host/host.ts";
import type { FollowAttach, FollowObserver } from "../../../src/next/host/index.ts";
import { Batch } from "../../../src/next/state/batch.ts";
import type { Watchable, WatchEnd } from "../../../src/watch.ts";
import { changesOf, delivered, expectCollected, instancesOf, loaded, valuesOf } from "../support.ts";

const followed = instancesOf(FollowSource, "attach");

type Count = { readonly n: number };

/** A runtime with synchronous observers, as Durable's views have them. */
class Runtime {
	value: Count = { n: 0 };
	readonly observers = new Set<FollowObserver<Count>>();
	attachments = 0;
	detached = 0;
	/** Resolves the next attachment when set (an attachment that takes time). */
	gate: Promise<void> | undefined;
	absent = false;

	readonly attach: FollowAttach<Count> = async (observer) => {
		this.observers.add(observer);
		this.attachments++;
		await this.gate;
		if (this.absent) return undefined;
		return {
			value: this.value,
			detach: () => {
				this.observers.delete(observer);
				this.detached++;
			},
		};
	};

	/** One change: every observer advanced with its ops. */
	set(n: number, retired = false): void {
		const ops: Op[] = [["s", ["n"], n]];
		this.value = { n };
		for (const observer of this.observers)
			observer.advance({ kind: "value", value: this.value, ops, retired }, context);
	}

	end(end: WatchEnd): void {
		for (const observer of [...this.observers]) observer.end(end);
		this.observers.clear();
	}
}

const View = local("app.view", { version: 1, params: {}, members: { a: obj({ n: int() }), sum: int() } });

/** Serves `View`, following `a` and `b`, its `sum` a derive over both (its computes counted). */
async function served(a = new Runtime(), b = new Runtime()) {
	let computes = 0;
	const { host, errors } = await loaded((h) =>
		h.serve(View, (_, self) => {
			const left = self.follow(a.attach);
			const right = self.follow(b.attach);
			const sum = self.derive([left, right], ([x, y]) => {
				computes++;
				return x.n + y.n;
			});
			return { a: left, sum };
		}),
	);
	const view = await host.get(View, {}, context);
	const batch = (host as unknown as ChordHost).batch;
	return { host, errors, view, a, b, batch, computes: () => computes };
}

describe("calls", () => {
	it("inside a running batch: one frame per commit, and a derive over two views computes once with both", async () => {
		const { view, a, b, batch, computes } = await served();
		const calls = changesOf(await view.a.watch(context));
		const sums = changesOf(await view.sum.watch(context));
		const before = computes();
		batch.commit(() => {
			a.set(1);
			a.set(2);
			b.set(10);
		}, context);
		await delivered();
		expect(calls).toEqual([
			{
				kind: "value",
				value: { n: 2 },
				ops: [
					["s", ["n"], 1],
					["s", ["n"], 2],
				],
				retired: false,
			},
		]);
		expect(valuesOf(sums)).toEqual([12]);
		expect(computes() - before).toBe(1);
	});

	it("outside any batch: queued and applied in one batch on the next microtask", async () => {
		const { view, a, b, computes } = await served();
		const sums = changesOf(await view.sum.watch(context));
		const before = computes();
		a.set(1);
		b.set(2);
		expect(view.a.value).toEqual({ n: 0 });
		await delivered();
		expect(view.a.value).toEqual({ n: 1 });
		expect(valuesOf(sums)).toEqual([3]);
		expect(computes() - before).toBe(1);
	});

	it("before the attachment resolved: applied in order on its value", async () => {
		const a = new Runtime();
		const gate = Promise.withResolvers<void>();
		a.gate = gate.promise;
		const serving = served(a);
		await delivered();
		a.set(5);
		a.set(6);
		gate.resolve();
		const { view } = await serving;
		expect(view.a.value).toEqual({ n: 6 });
	});
});

describe("types", () => {
	it("infers the value type from the attachment, without a type argument", async () => {
		const runtime = new Runtime();
		// A runtime's own observe, as Durable's `observeConversation` is: typed by its value, not by Chord's observer.
		const observe = (observer: FollowObserver<Count>) => runtime.attach(observer, context);
		await loaded((h) =>
			h.serve(View, (_, self) => {
				const a = self.follow((observer) => observe(observer));
				expectTypeOf(a).toEqualTypeOf<Watchable<Count>>();
				return { a, sum: self.derive([a], ([x]) => x.n) };
			}),
		);
	});
});

describe("activation", () => {
	it("an absent address fails the activation transient; a failed activation detaches what attached", async () => {
		const a = new Runtime();
		const b = new Runtime();
		b.absent = true;
		const { host, errors } = await loaded((h) =>
			h.serve(View, (_, self) => ({ a: self.follow(a.attach), sum: self.derive([self.follow(b.attach)], () => 0) })),
		);
		await expect(host.get(View, {}, context, { readyTimeout: 50 })).rejects.toThrow("followed address is absent");
		expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
			failure: { kind: "transient" },
		});
		await delivered();
		expect([a.attachments, a.detached]).toEqual([a.attachments, a.attachments]);
		await host.close(context);
	});
});

describe("ends (R4)", () => {
	it("failed: the live object fails transient once, reported, and its retry attaches again", async () => {
		const { host, errors, view, a, b } = await served();
		a.end({ kind: "failed", error: new ChordError({ code: "unavailable", message: "session failed" }) });
		b.end({ kind: "failed", error: new ChordError({ code: "unavailable", message: "session failed" }) });
		expect(view.state.value).toMatchObject({ kind: "failed", cause: { kind: "transient" } });
		expect((view.state.value as { retryAt?: number }).retryAt).toBeGreaterThan(0);
		expect(errors.filter((error) => error.kind === "object_failed")).toHaveLength(1);
		expect(view.a.value).toEqual({ n: 0 });
		await delivered();
		view.retry();
		await delivered();
		await delivered();
		expect(view.state.value).toEqual({ kind: "live" });
		expect([a.attachments, a.detached, b.attachments]).toEqual([2, 1, 2]);
		a.set(3);
		await delivered();
		expect(view.a.value).toEqual({ n: 3 });
		await host.close(context);
	});

	it("ended: final; a queued retirement reaches the watch first, the value stays, a new watch ends at once", async () => {
		const { host, errors, view, a } = await served();
		const watch = await view.a.watch(context);
		const calls = changesOf(watch);
		a.set(4, true);
		a.end({ kind: "ended" });
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(calls).toMatchObject([{ kind: "value", value: { n: 4 }, retired: true }]);
		expect(view.a.value).toEqual({ n: 4 });
		const late = await view.a.watch(context);
		expect(late.value).toEqual({ n: 4 });
		expect(await late.closed).toEqual({ kind: "ended" });
		expect(errors).toEqual([]);
		expect(view.state.value).toEqual({ kind: "live" });
		await host.close(context);
	});
});

describe("ends during activation and in one batch (review regressions)", () => {
	it("an end before the attachment resolved keeps the attachment's value on the source", async () => {
		const source = new FollowSource(
			async (observer) => {
				observer.end({ kind: "ended" });
				return { value: { n: 7 }, detach() {} };
			},
			{ label: "early end", context, ended() {} },
			new Batch(() => {}, undefined),
		);
		await source.attach(context);
		expect(source.value).toEqual({ n: 7 });
	});

	it.each([
		["ended", { kind: "ended" } as const],
		["failed", { kind: "failed", error: new Error("early failure") } as const],
	])("an %s end before the attachment resolved fails the activation transient", async (_, end) => {
		const a = new Runtime();
		const gate = Promise.withResolvers<void>();
		a.gate = gate.promise;
		// Loading activates the object (local, empty params): its follow attaches meanwhile.
		const loading = loaded((h) =>
			h.serve(View, (_, self) => {
				const left = self.follow(a.attach);
				return { a: left, sum: self.derive([left], ([x]) => x.n) };
			}),
		);
		await delivered();
		a.end(end);
		gate.resolve();
		const { host, errors } = await loading;
		await delivered();
		expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
			failure: { kind: "transient" },
		});
		await host.close(context);
		expect(a.detached).toBe(a.attachments);
	});

	it("an end while the object activates (after its sources attached) fails the activation transient", async () => {
		const a = new Runtime();
		let ended = false;
		const { host, errors } = await loaded((h) =>
			h.serve(View, (_, self) => {
				const left = self.follow(a.attach);
				// The activation computes the derives after the follows attached: the runtime ends then.
				const sum = self.derive([left], ([x]) => {
					if (!ended) {
						ended = true;
						a.end({ kind: "ended" });
					}
					return x.n;
				});
				return { a: left, sum };
			}),
		);
		await expect(host.get(View, {}, context, { readyTimeout: 50 })).rejects.toThrow();
		expect(ended).toBe(true);
		expect(errors.find((error) => error.kind === "activation_failed")).toMatchObject({
			failure: { kind: "transient" },
		});
		await host.close(context);
	});

	it("a retirement and an end inside one batch: the watch gets the retirement, then ends", async () => {
		const batch = new Batch(() => {}, undefined);
		let observer: FollowObserver<unknown> | undefined;
		const source = new FollowSource(
			async (attached) => {
				observer = attached;
				return { value: { n: 7 }, detach() {} };
			},
			{ label: "retirement", context, ended() {} },
			batch,
		);
		await source.attach(context);
		const watch = await source.watch(context);
		const calls = changesOf(watch);
		batch.commit(() => {
			observer!.advance({ kind: "value", value: { n: 7 }, ops: [], retired: true }, context);
			observer!.end({ kind: "ended" });
		}, context);
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(calls).toEqual([{ kind: "value", value: { n: 7 }, ops: [], retired: true }]);
	});

	it("a call and an end outside a batch with nothing watching: a later watch opens at the value and ends", async () => {
		let observer: FollowObserver<unknown> | undefined;
		const source = new FollowSource(
			async (attached) => {
				observer = attached;
				return { value: { n: 0 }, detach() {} };
			},
			{ label: "unwatched", context, ended() {} },
			new Batch(() => {}, undefined),
		);
		await source.attach(context);
		observer!.advance({ kind: "value", value: { n: 1 }, ops: [["s", ["n"], 1]], retired: true }, context);
		observer!.end({ kind: "ended" });
		await delivered();
		const watch = await source.watch(context);
		expect(watch.value).toEqual({ n: 1 });
		expect(await watch.closed).toEqual({ kind: "ended" });
		source.detach();
	});

	it("an end outside a batch after calls of two views: the views of one commit are delivered together", async () => {
		const { host, view, a, b, computes } = await served();
		const sums = changesOf(await view.sum.watch(context));
		const before = computes();
		a.set(1, true);
		b.set(2);
		a.end({ kind: "ended" });
		await delivered();
		expect(valuesOf(sums)).toEqual([3]);
		expect(computes() - before).toBe(1);
		await host.close(context);
	});
});

describe("GC", () => {
	it("a source its runtime ended is still detached at the object's end, then collected", async () => {
		const a = new Runtime();
		const { host } = await served(a);
		a.end({ kind: "ended" });
		await delivered();
		expect(a.detached).toBe(0);
		await host.close(context);
		expect(a.detached).toBe(1);
		await expectCollected(...followed.splice(0));
	});

	it("an ended object's followed sources are collected, and their observers detached", async () => {
		const a = new Runtime();
		const { host } = await served(a);
		await host.close(context);
		expect(a.observers.size).toBe(0);
		await expectCollected(...followed.splice(0));
	});
});
