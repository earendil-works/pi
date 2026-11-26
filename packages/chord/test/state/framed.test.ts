// Tests of framed sources (design §11): one frame per batch however often the batch set the source, of the state the
// batch left, diffed from the value its watches had before the batch; failures and recoveries within one batch; its
// dependents marked by every change; nothing listed while unwatched.

import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../src/context/index.ts";
import { applyImmutable } from "../../src/delta/index.ts";
import type { JsonValue } from "../../src/json.ts";
import { Batch, Derive, type FramedOwner, FramedSource, type Subscriber } from "../../src/state/internal.ts";
import type { WatchCall } from "../../src/watch.ts";
import { expectCollected } from "../support.ts";

/** A framed source a test feeds, counting its deliveries. */
class Fed extends FramedSource {
	deliveries = 0;

	put(value: JsonValue): void {
		this.set(value);
	}

	fail(error: unknown): void {
		this.failWith(error);
	}

	finish(): void {
		this.end(new Error("ended"));
	}

	override deliver(...args: Parameters<FramedSource["deliver"]>): void {
		this.deliveries++;
		super.deliver(...args);
	}
}

/** A fed source with the value `initial`, its batch, what its owner was told, and a subscriber's calls. */
function fed(initial?: JsonValue) {
	const errors: unknown[] = [];
	const reports: unknown[] = [];
	const batch = new Batch((error) => errors.push(error), undefined);
	const owner: FramedOwner = { label: "test", report: (error) => reports.push(error) };
	const source = new Fed(batch, owner);
	if (initial !== undefined) batch.commit(() => source.put(initial), context);
	const calls: WatchCall<JsonValue>[] = [];
	const subscriber: Subscriber = {
		advance: (call) => void calls.push(call),
		end: () => {},
		endAfterDelivery: () => {},
	};
	const subscribe = (): void => source.subscribe(subscriber);
	return { source, batch, errors, reports, calls, subscribe };
}

describe("a framed source set several times in one batch", () => {
	it("delivers one frame: its last value, diffed from the value before the batch", () => {
		const before = { a: 1, b: 1, c: 1 };
		const { source, batch, errors, calls, subscribe } = fed(before);
		subscribe();
		batch.commit(() => {
			source.put({ a: 2, b: 1, c: 1 });
			source.put({ a: 2, b: 3, c: 1 });
			source.put({ a: 2, b: 3, c: 4 });
		}, context);
		expect(errors).toEqual([]);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		if (call?.kind !== "value") throw new Error("no value call");
		expect(call.value).toEqual({ a: 2, b: 3, c: 4 });
		// The ops apply to what the subscriber had, not to a value in between.
		expect(applyImmutable(before, call.ops)).toEqual(call.value);
		expect(call.ops).toEqual([
			["s", ["a"], 2],
			["s", ["b"], 3],
			["s", ["c"], 4],
		]);
		// Listed once in the batch (the cost: one delivery, one diff).
		expect(source.deliveries).toBe(1);
		// The next batch starts from the last value.
		batch.commit(() => source.put({ a: 2, b: 4, c: 4 }), context);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ kind: "value", ops: [["s", ["b"], 4]] });
	});

	it("delivers nothing when the batch ends at the value it started from", () => {
		const { source, batch, calls, subscribe } = fed({ n: 1 });
		subscribe();
		batch.commit(() => {
			source.put({ n: 2 });
			source.put({ n: 1 });
		}, context);
		expect(calls).toEqual([]);
		expect(source.deliveries).toBe(1);
	});

	it("marks its dependents with every change: a derive read between two sets reads again after the second", () => {
		const { source, batch } = fed(1);
		const double = new Derive([source], ([n]) => (n as number) * 2, batch);
		double.attach(
			() => source,
			() => {},
		);
		expect(double.value).toBe(2);
		const read: unknown[] = [];
		batch.commit(() => {
			source.put(2);
			read.push(double.value);
			source.put(3);
			read.push(double.value);
		}, context);
		expect(read).toEqual([4, 6]);
		expect(double.value).toBe(6);
	});

	it("tells a dependent of a change after it took the value: one that reads at once reads the new one", () => {
		const { source, batch } = fed(1);
		const read: unknown[] = [];
		source.dependents.add({ invalidate: () => void read.push(source.value), sourceRetired: () => {} });
		batch.commit(() => {
			source.put(2);
			source.put(3);
		}, context);
		expect(read).toEqual([2, 3]);
	});

	it("lists nothing while nobody watches it; a subscriber taken on between two sets gets the diff from what it took", () => {
		const { source, batch, calls, subscribe } = fed({ n: 1 });
		batch.commit(() => {
			source.put({ n: 2 });
			source.put({ n: 3 });
		}, context);
		expect(source.deliveries).toBe(0);
		expect(source.value).toEqual({ n: 3 });
		let taken: JsonValue | undefined;
		batch.commit(() => {
			source.put({ n: 4 });
			taken = source.value;
			subscribe();
			source.put({ n: 5 });
			source.put({ n: 6 });
		}, context);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		if (call?.kind !== "value") throw new Error("no value call");
		expect(applyImmutable(taken, call.ops)).toEqual({ n: 6 });
	});
});

describe("a framed source failing and recovering in one batch", () => {
	it("a failure and the value after it are one frame, the diff from the value before; no failure call", () => {
		const { source, batch, reports, calls, subscribe } = fed({ n: 1 });
		subscribe();
		batch.commit(() => {
			source.fail(new Error("a page in between"));
			source.put({ n: 2 });
		}, context);
		expect(calls).toEqual([{ kind: "value", value: { n: 2 }, ops: [["s", ["n"], 2]], retired: false }]);
		// The episode was the owner's to hear of.
		expect(reports).toHaveLength(1);
	});

	it("a value and the failure after it, or two failures, are one failure call and one report", () => {
		const { source, batch, reports, calls, subscribe } = fed({ n: 1 });
		subscribe();
		const first = new Error("first");
		const last = new Error("last");
		batch.commit(() => {
			source.put({ n: 2 });
			source.fail(first);
			source.fail(last);
		}, context);
		expect(calls).toEqual([{ kind: "failed", error: last }]);
		expect(reports).toHaveLength(1);
		expect(source.failure).toMatchObject({ error: last, last: { n: 2 } });
		// Still failed in a later batch: nothing new for the watches; the next value replaces the value whole.
		batch.commit(() => source.fail(new Error("again")), context);
		expect(calls).toHaveLength(1);
		batch.commit(() => {
			source.fail(new Error("once more"));
			source.put({ n: 3 });
			source.put({ n: 4 });
		}, context);
		expect(calls.slice(1)).toEqual([{ kind: "value", value: { n: 4 }, ops: [["r", { n: 4 }]], retired: false }]);
	});

	it("an end in the batch that set it delivers nothing", () => {
		const { source, batch, errors, calls, subscribe } = fed({ n: 1 });
		subscribe();
		batch.commit(() => {
			source.put({ n: 2 });
			source.finish();
			source.put({ n: 3 });
		}, context);
		expect(calls).toEqual([]);
		expect(errors).toEqual([]);
		expect(source.detached).toBe(true);
	});
});

describe("sources handed the same values (a shared read's subscribers)", () => {
	it("diff them once: their frames carry the same ops", () => {
		const a = fed({ rows: [1, 2] });
		const batch = a.batch;
		const owner: FramedOwner = { label: "b", report: () => {} };
		const b = new Fed(batch, owner);
		const value = a.source.value;
		batch.commit(() => b.put(value), context);
		const ops: (readonly unknown[])[] = [];
		const subscriber = (into: (readonly unknown[])[]): Subscriber => ({
			advance: (call) => void (call.kind === "value" && into.push(call.ops)),
			end: () => {},
			endAfterDelivery: () => {},
		});
		a.source.subscribe(subscriber(ops));
		b.subscribe(subscriber(ops));
		const next = { rows: [0, 1, 2] };
		batch.commit(() => {
			a.source.put(next);
			b.put(next);
		}, context);
		expect(ops).toHaveLength(2);
		expect(ops[0]).toBe(ops[1]);
	});

	it("keep no later value alive through an earlier one somebody holds: the diffs go with the commit (round 1)", async () => {
		// Opus M3, Astra 3: a cache by the earlier value kept the next value, whose entry kept the one after.
		const { source, batch } = fed();
		batch.commit(() => source.put({ step: 0 }), context);
		// Watched (its frames are diffed) by a subscriber that keeps nothing.
		source.subscribe({ advance: () => {}, end: () => {}, endAfterDelivery: () => {} });
		const held = source.value;
		batch.commit(() => source.put({ step: 1 }), context);
		const later = new WeakRef(source.value as object);
		for (let step = 2; step < 10; step++) batch.commit(() => source.put({ step }), context);
		await expectCollected(later);
		expect(held).toEqual({ step: 0 });
		expect(batch.diffs.size).toBe(0);
	});
});
