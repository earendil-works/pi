import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { ChordError } from "../../../src/next/data/index.ts";
import { Replica } from "../../../src/next/remote/replica.ts";
import { Batch, Derive } from "../../../src/next/state/internal.ts";
import { changesOf, delivered, framesOf } from "../support.ts";

/** A replica of `{ n }` on a fresh batch, with a derive over it attached. */
function replica() {
	const batch = new Batch(() => {}, undefined);
	const source = new Replica(batch, { kind: "value", value: { n: 1 } });
	const double = new Derive([source], ([value]) => (value as { n: number }).n * 2, batch);
	double.attach(
		(declared) => declared as Replica,
		() => {},
	);
	return { batch, source, double };
}

describe("replicas", () => {
	it("adopt a value and its ops inside a batch: one frame, derives recomputed", async () => {
		const { batch, source, double } = replica();
		const frames = framesOf(source.openWatch(context));
		const doubles = framesOf(double.openWatch(context));
		batch.commit(() => source.adopt({ n: 2 }, [["s", ["n"], 2]], false), context);
		await delivered();
		expect(frames).toEqual([[{ n: 2 }, [["s", ["n"], 2]]]]);
		expect(doubles).toEqual([[4, [["r", 4]]]]);
	});

	it("fail: reads throw the error, watches and derives over it get one failure call and recover with a root replacement", async () => {
		const { batch, source, double } = replica();
		const calls = changesOf(source.openWatch(context));
		const derived = changesOf(double.openWatch(context));
		const error = new Error("member failed");
		batch.commit(() => source.fail(error), context);
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error }]);
		expect(derived).toEqual([{ kind: "failed", error }]);
		expect(() => source.value).toThrow("member failed");
		// A non-root op cannot apply to a failed member; its recovery is a root replacement.
		expect(() => source.decode([["s", ["n"], 2]])).toThrow("root replacement");
		const { value, ops } = source.decode([["r", { n: 3 }]]);
		batch.commit(() => source.adopt(value, ops, false), context);
		await delivered();
		expect(calls.at(-1)).toEqual({ kind: "value", value: { n: 3 }, ops: [["r", { n: 3 }]], retired: false });
		expect(derived.at(-1)).toEqual({ kind: "value", value: 6, ops: [["r", 6]], retired: false });
	});

	it("fail once per episode: a second failure while failed gives no call; a retirement meanwhile waits for the value", async () => {
		const { batch, source } = replica();
		const calls = changesOf(source.openWatch(context));
		const first = new Error("first");
		batch.commit(() => source.fail(first), context);
		batch.commit(() => source.fail(new Error("second")), context);
		await delivered();
		// A retirement alone while failed: the value is not read, the flag waits.
		batch.commit(() => source.retireAlone(), context);
		const { value, ops } = source.decode([["r", { n: 5 }]]);
		batch.commit(() => source.adopt(value, ops, false), context);
		await delivered();
		expect(calls).toEqual([
			{ kind: "failed", error: first },
			{ kind: "value", value: { n: 5 }, ops: [["r", { n: 5 }]], retired: true },
		]);
	});

	it("open a new watch while failed at the last value, the failure first; with no value yet, reject it", async () => {
		const { batch, source } = replica();
		const error = new Error("member failed");
		batch.commit(() => source.fail(error), context);
		const watch = source.openWatch(context);
		expect(watch.value).toEqual({ n: 1 });
		const calls = changesOf(watch);
		await delivered();
		expect(calls).toEqual([{ kind: "failed", error }]);
		// Failed since its binding: there is no value to start at.
		const unborn = new Replica(batch, { kind: "failed", error });
		expect(() => unborn.openWatch(context)).toThrow(error);
	});

	it("end with their hold: reads throw its error, watches end", async () => {
		const { source } = replica();
		const watch = source.openWatch(context);
		source.end(new ChordError({ code: "released", message: "app.notes: ended" }));
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(() => source.value).toThrow("app.notes: ended");
	});
});
