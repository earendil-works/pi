// Tests for Chord's watch handles: the shared lifecycle through `Watch`, and what `NativeWatch` does differently.
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BACKGROUND_CONTEXT,
	type Context,
	createContextKey,
	withAbortSignal,
	withContextValue,
} from "../src/context/index.ts";
import { applyImmutable, type Op, track } from "../src/delta/index.ts";
import { MAX_PENDING_OPS } from "../src/delta/pending.ts";
import type { JsonValue } from "../src/json.ts";
import { NativeWatch, type NativeWatchCall, Watch, type WatchCall, type WatchEnd } from "../src/watch.ts";

const context = BACKGROUND_CONTEXT;

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return { promise, resolve: () => resolve() };
}

/** A source's frame that is not a retirement. */
function frame<T>(value: T, ops: readonly Op[]): WatchValue<T> {
	return { kind: "value", value, ops, retired: false };
}

/** A source's retirement frame. */
function retirement<T>(value: T, ops: readonly Op[] = []): WatchValue<T> {
	return { kind: "value", value, ops, retired: true };
}

type WatchValue<T> = Extract<WatchCall<T>, { kind: "value" }>;

/** A listener for value calls only: a `failed` call throws. */
function onValue<C extends { readonly kind: string }>(
	listener: (call: Extract<C, { kind: "value" }>, context: Context) => Promise<void>,
): (call: C, context: Context) => Promise<void> {
	return (call, deliveryContext) => {
		if (call.kind !== "value") throw new Error(`Unexpected ${call.kind} call`);
		return listener(call as Extract<C, { kind: "value" }>, deliveryContext);
	};
}

/** A watch whose detach and reports are recorded. */
function recordedWatch<T>(value: T) {
	const recorded = { detached: 0, reported: [] as unknown[] };
	const watch = new Watch<T>(
		value,
		() => recorded.detached++,
		(error) => recorded.reported.push(error),
	);
	return { watch, recorded };
}

/** A started watch collecting its calls. */
function collectingWatch<T>(value: T) {
	const { watch, recorded } = recordedWatch(value);
	const frames: Array<{ value: T; ops: readonly Op[]; retired?: true }> = [];
	watch.start(
		onValue(async ({ value: delivered, ops, retired }) => {
			frames.push(retired ? { value: delivered, ops, retired } : { value: delivered, ops });
		}),
	);
	return { watch, recorded, frames };
}

/** The end of `closed`, or undefined while the watch is open. */
function endOf(watch: { readonly closed: Promise<WatchEnd> }): { readonly end: WatchEnd | undefined } {
	const settled: { end: WatchEnd | undefined } = { end: undefined };
	void watch.closed.then((end) => {
		settled.end = end;
	});
	return settled;
}

const collect = (() => {
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;
	return async (): Promise<void> => {
		for (let round = 0; round < 5; round++) {
			await flush();
			gc();
		}
	};
})();

describe("Watch delivery", () => {
	it("keeps the acquisition value until start, then delivers the frames since in one call", async () => {
		const { watch } = recordedWatch<JsonValue>({ n: 0, text: "" });
		watch.advance(frame({ n: 1, text: "" }, [["s", ["n"], 1]]), context);
		watch.advance(
			frame({ n: 2, text: "a" }, [
				["s", ["n"], 2],
				["a", ["text"], "a"],
			]),
			context,
		);
		watch.advance(frame({ n: 2, text: "ab" }, [["a", ["text"], "b"]]), context);
		await flush();
		expect(watch.value).toEqual({ n: 0, text: "" });

		const frames: Array<{ value: JsonValue; ops: readonly Op[] }> = [];
		watch.start(
			onValue(async ({ value, ops }) => {
				frames.push({ value, ops });
			}),
		);
		expect(frames).toEqual([]);
		await flush();
		expect(frames).toEqual([
			{
				value: { n: 2, text: "ab" },
				ops: [
					["s", ["n"], 2],
					["a", ["text"], "ab"],
				],
			},
		]);
		expect(watch.value).toEqual({ n: 2, text: "ab" });
	});

	it("passes a frame's ops on by identity to a listener that keeps up", async () => {
		const { watch } = recordedWatch<JsonValue>(0);
		const delivered: Array<readonly Op[]> = [];
		watch.start(
			onValue(async ({ ops }) => {
				delivered.push(ops);
			}),
		);
		const first: readonly Op[] = [["r", 1]];
		const second: readonly Op[] = [["r", 2]];
		watch.advance(frame(1, first), context);
		await flush();
		watch.advance(frame(2, second), context);
		await flush();
		expect(delivered).toHaveLength(2);
		expect(delivered[0]).toBe(first);
		expect(delivered[1]).toBe(second);
	});

	it("never invokes the listener inline", async () => {
		const { watch, frames } = collectingWatch<JsonValue>(0);
		watch.advance(frame(1, [["r", 1]]), context);
		expect(frames).toEqual([]);
		await flush();
		expect(frames).toEqual([{ value: 1, ops: [["r", 1]] }]);
	});

	it("awaits each callback and folds frames advanced while one is in flight into the next call", async () => {
		const { watch } = recordedWatch<JsonValue>({ text: "" });
		const gate = deferred();
		const calls: string[] = [];
		const frames: Array<{ value: JsonValue; ops: readonly Op[] }> = [];
		watch.start(
			onValue(async ({ value, ops }) => {
				calls.push(`start ${JSON.stringify(value)}`);
				frames.push({ value, ops });
				if (frames.length === 1) await gate.promise;
				calls.push(`end ${JSON.stringify(value)}`);
			}),
		);
		watch.advance(frame({ text: "a" }, [["a", ["text"], "a"]]), context);
		await flush();
		watch.advance(frame({ text: "ab" }, [["a", ["text"], "b"]]), context);
		watch.advance(frame({ text: "abc" }, [["a", ["text"], "c"]]), context);
		await flush();
		expect(calls).toEqual(['start {"text":"a"}']);
		gate.resolve();
		await flush();
		expect(calls).toEqual(['start {"text":"a"}', 'end {"text":"a"}', 'start {"text":"abc"}', 'end {"text":"abc"}']);
		expect(frames[1]).toEqual({ value: { text: "abc" }, ops: [["a", ["text"], "bc"]] });
	});

	it("delivers the newest frame's context, without its abort signal", async () => {
		const { watch } = recordedWatch<JsonValue>(0);
		const key = createContextKey<string>("frame");
		const controller = new AbortController();
		const delivered: Context[] = [];
		watch.start(async (_change, deliveryContext) => {
			delivered.push(deliveryContext);
		});
		watch.advance(frame(1, [["r", 1]]), withContextValue(key, "first", context));
		watch.advance(frame(2, [["r", 2]]), withContextValue(key, "second", withAbortSignal(controller.signal, context)));
		await flush();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.value(key)).toBe("second");
		expect(delivered[0]?.abortSignal).toBeUndefined();
	});
});

describe("Watch with a slow listener", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("gets one call per batch whose ops turn the previous delivered value into the newest", async () => {
		vi.useFakeTimers();
		type Doc = { entries: Array<{ text: string; status: string }>; tokens: number };
		const tracker = track<Doc>({ entries: [], tokens: 0 });
		const { watch } = recordedWatch<Doc>(tracker.value);
		const commit = (edit: (draft: Doc) => void): void => {
			const change = tracker.beginChange();
			edit(change.state as Doc);
			const prepared = change.prepare();
			tracker.adopt(prepared);
			watch.advance(frame(tracker.value, prepared.ops), context);
		};
		let replica: Doc = tracker.value;
		const calls: Array<{ commits: number; ops: number }> = [];
		let commits = 0;
		watch.start(
			onValue(async ({ value, ops }) => {
				replica = applyImmutable(replica, ops);
				expect(replica).toEqual(value);
				calls.push({ commits, ops: ops.length });
				// A listener taking a second per call, as a slow client would.
				await new Promise((resolve) => setTimeout(resolve, 1000));
			}),
		);
		// Ten seconds of a streamed reply at 60 tokens per second, a new entry every second.
		for (let tick = 0; tick < 600; tick++) {
			if (tick % 60 === 0) commit((draft) => void draft.entries.push({ text: "", status: "streaming" }));
			commit((draft) => {
				draft.entries.at(-1)!.text += "tok ";
				draft.tokens++;
			});
			commits++;
			await vi.advanceTimersByTimeAsync(1000 / 60);
		}
		await vi.advanceTimersByTimeAsync(2000);
		expect(replica).toEqual(tracker.value);
		// One call per second, each carrying at most one op per path written since the previous one.
		expect(calls.length).toBeGreaterThanOrEqual(10);
		expect(calls.length).toBeLessThanOrEqual(12);
		for (const call of calls) expect(call.ops).toBeLessThanOrEqual(5);
		await watch.stop();
	});
});

/** Advance `watch` by one frame per element of `{ k: [0, ..., count - 1] }`, each setting its own path. */
function advanceDistinct(watch: Watch<JsonValue>, count: number): JsonValue {
	const values: number[] = [];
	for (let index = 0; index < count; index++) {
		values.push(index);
		watch.advance(frame({ k: [...values] }, [["s", ["k", index], index]]), context);
	}
	return { k: values };
}

describe("Watch overflow", () => {
	it(`keeps ${MAX_PENDING_OPS} pending ops after folding and replaces the root past them`, async () => {
		const exact = collectingWatch<JsonValue>({ k: [] });
		advanceDistinct(exact.watch, MAX_PENDING_OPS);
		await flush();
		expect(exact.frames).toHaveLength(1);
		expect(exact.frames[0]?.ops).toHaveLength(MAX_PENDING_OPS);

		const over = collectingWatch<JsonValue>({ k: [] });
		const newest = advanceDistinct(over.watch, MAX_PENDING_OPS + 1);
		await flush();
		expect(over.frames).toEqual([{ value: newest, ops: [["r", newest]] }]);
	});

	it("never folds the in-flight call into an overflow", async () => {
		const { watch } = recordedWatch<JsonValue>({ k: [] });
		const gate = deferred();
		const frames: Array<{ value: JsonValue; ops: readonly Op[] }> = [];
		watch.start(
			onValue(async ({ value, ops }) => {
				frames.push({ value, ops });
				if (frames.length === 1) await gate.promise;
			}),
		);
		watch.advance(frame({ k: [], first: true }, [["s", ["first"], true]]), context);
		await flush();
		const newest = advanceDistinct(watch, MAX_PENDING_OPS + 1);
		gate.resolve();
		await flush();
		expect(frames).toEqual([
			{ value: { k: [], first: true }, ops: [["s", ["first"], true]] },
			{ value: newest, ops: [["r", newest]] },
		]);
	});

	it("starts folding again after an overflow was delivered", async () => {
		const { watch, frames } = collectingWatch<JsonValue>({ k: [] });
		advanceDistinct(watch, MAX_PENDING_OPS + 1);
		await flush();
		watch.advance(frame({ n: 1 }, [["r", { n: 1 }]]), context);
		watch.advance(frame({ n: 2 }, [["s", ["n"], 2]]), context);
		await flush();
		expect(frames.at(-1)).toEqual({
			value: { n: 2 },
			ops: [
				["r", { n: 1 }],
				["s", ["n"], 2],
			],
		});
	});
});

describe("Watch retirement", () => {
	it("reports a retirement in the next call with the value the source gives, and goes on", async () => {
		const { watch, frames, recorded } = collectingWatch<JsonValue>(1);
		const settled = endOf(watch);
		watch.advance(frame(2, [["r", 2]]), context);
		await flush();
		watch.advance(retirement(2), context);
		await flush();
		watch.advance(frame(3, [["r", 3]]), context);
		await flush();
		expect(frames).toEqual([
			{ value: 2, ops: [["r", 2]] },
			{ value: 2, ops: [], retired: true },
			{ value: 3, ops: [["r", 3]] },
		]);
		expect(watch.value).toBe(3);
		expect(settled.end).toBeUndefined();
		expect(recorded.detached).toBe(0);
		await watch.stop();
	});

	it("folds a retirement and the frames around it into one call that reports it", async () => {
		const { watch } = recordedWatch<JsonValue>({ n: 0 });
		watch.advance(frame({ n: 1 }, [["s", ["n"], 1]]), context);
		watch.advance(retirement({ n: 1 }), context);
		watch.advance(frame({ m: 1 }, [["r", { m: 1 }]]), context);
		const changes: WatchCall<JsonValue>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		await flush();
		expect(changes).toEqual([{ kind: "value", value: { m: 1 }, ops: [["r", { m: 1 }]], retired: true }]);
		watch.advance(frame({ m: 2 }, [["s", ["m"], 2]]), context);
		await flush();
		expect(changes[1]).toEqual({ kind: "value", value: { m: 2 }, ops: [["s", ["m"], 2]], retired: false });
		await watch.stop();
	});

	it("keeps reporting the retirement past an overflow", async () => {
		const { watch } = recordedWatch<JsonValue>({ k: [] });
		watch.advance(retirement({ k: [] }), context);
		const newest = advanceDistinct(watch, MAX_PENDING_OPS + 1);
		const changes: WatchCall<JsonValue>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		await flush();
		expect(changes).toEqual([{ kind: "value", value: newest, ops: [["r", newest]], retired: true }]);
		await watch.stop();
	});

	it("treats a null value as a value, never as a retirement", async () => {
		const { watch, frames } = collectingWatch<JsonValue>(1);
		const settled = endOf(watch);
		watch.advance(frame(null, [["r", null]]), context);
		await flush();
		watch.advance(frame(2, [["r", 2]]), context);
		await flush();
		expect(frames).toEqual([
			{ value: null, ops: [["r", null]] },
			{ value: 2, ops: [["r", 2]] },
		]);
		expect(settled.end).toBeUndefined();
		expect(await watch.stop()).toEqual({ kind: "stopped" });
	});

	it("discards a retirement still pending when the source ends", async () => {
		const { watch } = recordedWatch<JsonValue>(1);
		watch.advance(retirement(1), context);
		watch.end({ kind: "ended" });
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(watch.value).toBe(1);
	});
});

describe("Watch failure calls", () => {
	/** A started watch recording every call, failures included. */
	function recordingWatch<T>(value: T) {
		const { watch, recorded } = recordedWatch(value);
		const calls: WatchCall<T>[] = [];
		watch.start(async (call) => {
			calls.push(call);
		});
		return { watch, recorded, calls };
	}

	it("delivers a failure as a call, stays open, keeps the last value, and replaces the root on recovery", async () => {
		const { watch, recorded, calls } = recordingWatch<JsonValue>({ n: 0 });
		const settled = endOf(watch);
		watch.advance(frame({ n: 1 }, [["s", ["n"], 1]]), context);
		await flush();
		const error = new Error("cannot compute");
		watch.fail(error, context);
		await flush();
		expect(calls[1]).toEqual({ kind: "failed", error });
		expect(watch.value).toEqual({ n: 1 });
		expect(settled.end).toBeUndefined();
		expect(recorded.detached).toBe(0);
		watch.advance(frame({ n: 2 }, [["s", ["n"], 2]]), context);
		await flush();
		expect(calls[2]).toEqual({ kind: "value", value: { n: 2 }, ops: [["r", { n: 2 }]], retired: false });
		// Recovered: frames pass on as the source made them again.
		const next = frame({ n: 3 }, [["s", ["n"], 3]]);
		watch.advance(next, context);
		await flush();
		expect(calls[3]).toBe(next);
		expect(watch.value).toEqual({ n: 3 });
		await watch.stop();
	});

	it("takes a failure through `advance()` as through `fail()`", async () => {
		const { watch, calls } = recordingWatch<JsonValue>(0);
		const failure: WatchCall<JsonValue> = { kind: "failed", error: "down" };
		watch.advance(failure, context);
		await flush();
		expect(calls).toEqual([failure]);
		expect(calls[0]).toBe(failure);
		await watch.stop();
	});

	it("folds pending values followed by a failure into the failure", async () => {
		const { watch } = recordedWatch<JsonValue>({ n: 0 });
		watch.advance(frame({ n: 1 }, [["s", ["n"], 1]]), context);
		watch.advance(frame({ n: 2 }, [["s", ["n"], 2]]), context);
		const first = new Error("first");
		const second = new Error("second");
		watch.fail(first, context);
		watch.fail(second, context);
		const calls: WatchCall<JsonValue>[] = [];
		watch.start(async (call) => {
			calls.push(call);
		});
		await flush();
		expect(calls).toEqual([{ kind: "failed", error: second }]);
		expect(watch.value).toEqual({ n: 0 });
		await watch.stop();
	});

	it("folds a pending failure followed by values into one root replacement with the newest value", async () => {
		const { watch } = recordedWatch<JsonValue>({ n: 0 });
		const key = createContextKey<string>("frame");
		watch.fail(new Error("down"), withContextValue(key, "failure", context));
		watch.advance(frame({ n: 1 }, [["s", ["n"], 1]]), context);
		watch.advance(retirement({ n: 1 }), context);
		watch.advance(frame({ m: 2 }, [["r", { m: 2 }]]), withContextValue(key, "newest", context));
		const calls: Array<{ call: WatchCall<JsonValue>; frame: string | undefined }> = [];
		watch.start(async (call, deliveryContext) => {
			calls.push({ call, frame: deliveryContext.value(key) });
		});
		await flush();
		expect(calls).toEqual([
			{ call: { kind: "value", value: { m: 2 }, ops: [["r", { m: 2 }]], retired: true }, frame: "newest" },
		]);
		await watch.stop();
	});

	it("delivers a failure that arrives during a call after it, then the recovery", async () => {
		const { watch } = recordedWatch<JsonValue>(0);
		const gate = deferred();
		const calls: WatchCall<JsonValue>[] = [];
		watch.start(async (call) => {
			calls.push(call);
			if (calls.length === 1) await gate.promise;
		});
		watch.advance(frame(1, [["r", 1]]), context);
		await flush();
		watch.advance(frame(2, [["r", 2]]), context);
		watch.fail("down", context);
		gate.resolve();
		await flush();
		watch.advance(frame(3, [["r", 3]]), context);
		await flush();
		expect(calls.map((call) => (call.kind === "value" ? call.value : call.error))).toEqual([1, "down", 3]);
		expect(watch.value).toBe(3);
		await watch.stop();
	});

	it("drops a pending failure when the source ends, and ignores one after", async () => {
		const { watch, calls } = recordingWatch<JsonValue>(0);
		watch.fail("down", context);
		watch.end({ kind: "ended" });
		watch.fail("later", context);
		await flush();
		expect(calls).toEqual([]);
		expect(await watch.closed).toEqual({ kind: "ended" });
	});

	it("passes every lone value call on by identity, so a value call costs the watch no allocation", async () => {
		const { watch, calls } = recordingWatch<JsonValue>(0);
		const sent: WatchCall<JsonValue>[] = [];
		for (let n = 1; n <= 1_000; n++) {
			const call = frame(n, [["r", n]]);
			sent.push(call);
			watch.advance(call, context);
			await Promise.resolve();
			await Promise.resolve();
		}
		await flush();
		expect(calls).toHaveLength(sent.length);
		for (const [index, call] of calls.entries()) expect(call).toBe(sent[index]);
		await watch.stop();
	});
});

describe("Watch end after delivery", () => {
	it("takes no more frames, delivers what is pending, then ends `ended` and only then detaches", async () => {
		const { watch, frames, recorded } = collectingWatch<JsonValue>(1);
		const settled = endOf(watch);
		watch.advance(retirement(1), context);
		watch.endAfterDelivery();
		expect(recorded.detached).toBe(0);
		// The source sends nothing more: a later frame is not taken.
		watch.advance(frame(2, [["r", 2]]), context);
		await flush();
		expect(frames).toEqual([{ value: 1, ops: [], retired: true }]);
		expect(settled.end).toEqual({ kind: "ended" });
		expect(recorded.detached).toBe(1);
	});

	it("waits for start to deliver, and ends at once with nothing pending", async () => {
		const { watch, recorded } = recordedWatch<JsonValue>(1);
		watch.advance(frame(2, [["r", 2]]), context);
		watch.endAfterDelivery();
		await flush();
		const settled = endOf(watch);
		await flush();
		expect(settled.end).toBeUndefined();
		expect(recorded.detached).toBe(0);
		const values: JsonValue[] = [];
		watch.start(
			onValue(async ({ value }) => {
				values.push(value);
			}),
		);
		expect(await watch.closed).toEqual({ kind: "ended" });
		expect(values).toEqual([2]);
		expect(recorded.detached).toBe(1);

		const idle = collectingWatch<JsonValue>(1);
		idle.watch.endAfterDelivery();
		expect(await idle.watch.closed).toEqual({ kind: "ended" });
		expect(idle.frames).toEqual([]);
		expect(idle.recorded.detached).toBe(1);
	});

	it("ends a never-started watch at its source's end, dropping what is pending", async () => {
		const { watch, recorded } = recordedWatch<JsonValue>(1);
		watch.advance(retirement(1), context);
		watch.endAfterDelivery();
		const failure = new Error("source failed");
		watch.end({ kind: "failed", error: failure });
		expect(await watch.closed).toEqual({ kind: "failed", error: failure });
		expect(recorded.detached).toBe(1);
		expect(() => watch.start(async () => {})).toThrow("Watch is stopped");
	});

	/** A started watch whose listener is in a call held by `gate`, with nothing pending, then `endAfterDelivery()`. */
	async function endingWhileRunning(settle: () => Promise<void>) {
		const { watch, recorded } = recordedWatch<JsonValue>(0);
		const gate = deferred();
		const values: JsonValue[] = [];
		let returned = false;
		watch.start(
			onValue(async ({ value }) => {
				values.push(value);
				await gate.promise;
				await settle();
				returned = true;
			}),
		);
		watch.advance(retirement(1, [["r", 1]]), context);
		await flush();
		expect(values).toEqual([1]);
		watch.endAfterDelivery();
		const settled = endOf(watch);
		await flush();
		return { watch, recorded, values, settled, release: gate.resolve, returned: () => returned };
	}

	it("ends `ended` only after the running call returns when nothing is pending, detached then", async () => {
		const ending = await endingWhileRunning(async () => {});
		expect(ending.settled.end).toBeUndefined();
		expect(ending.recorded.detached).toBe(0);
		ending.release();
		expect(await ending.watch.closed).toEqual({ kind: "ended" });
		expect(ending.returned()).toBe(true);
		expect(ending.values).toEqual([1]);
		expect(ending.recorded.detached).toBe(1);
	});

	it("ends `listener_error` and reports it when the running call throws after `endAfterDelivery()`", async () => {
		const failure = new Error("listener failed");
		const ending = await endingWhileRunning(async () => {
			throw failure;
		});
		expect(ending.settled.end).toBeUndefined();
		ending.release();
		expect(await ending.watch.closed).toEqual({ kind: "listener_error", error: failure });
		expect(ending.recorded.reported).toEqual([failure]);
		expect(ending.recorded.detached).toBe(1);
	});

	it("ends `stopped` when stopped while ending, without awaiting the running call", async () => {
		const ending = await endingWhileRunning(async () => {});
		expect(await ending.watch.stop()).toEqual({ kind: "stopped" });
		expect(ending.recorded.detached).toBe(1);
		expect(ending.returned()).toBe(false);
		ending.release();
		await flush();
		expect(await ending.watch.closed).toEqual({ kind: "stopped" });
	});
});

describe("Watch call objects", () => {
	/** A frame context carrying `payload` and an abort signal, as a producer's is. */
	function producerContext(payload: object) {
		const controller = new AbortController();
		return withAbortSignal(
			controller.signal,
			withContextValue(createContextKey<object>("payload"), payload, context),
		);
	}

	it("hands a listener plain data only: `{ kind, value, ops, retired }`, cloneable and serializable", async () => {
		const { watch } = recordedWatch<JsonValue>({ n: 0 });
		const changes: WatchCall<JsonValue>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		watch.advance(frame({ n: 1 }, [["s", ["n"], 1]]), producerContext({}));
		await flush();
		// Folded: the watch builds the change.
		watch.advance(frame({ n: 2 }, [["s", ["n"], 2]]), producerContext({}));
		watch.advance(retirement({ n: 2 }), producerContext({}));
		await flush();
		expect(changes).toHaveLength(2);
		for (const change of changes) {
			expect(Object.keys(change)).toEqual(["kind", "value", "ops", "retired"]);
			expect(structuredClone(change)).toEqual(change);
			expect(JSON.parse(JSON.stringify(change))).toEqual(change);
		}
		expect(changes[1]).toEqual({ kind: "value", value: { n: 2 }, ops: [["s", ["n"], 2]], retired: true });
		await watch.stop();
	});

	it("passes a frame delivered alone on as the source made it", async () => {
		const { watch } = recordedWatch<JsonValue>(0);
		const changes: WatchCall<JsonValue>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		const alone = frame(1, [["r", 1]]);
		watch.advance(alone, context);
		await flush();
		expect(changes[0]).toBe(alone);
		await watch.stop();
	});

	it("keeps no frame context alive through a call a listener keeps", async () => {
		const kept: Array<WatchCall<JsonValue> | NativeWatchCall<number>> = [];
		/** Deliver one frame whose context alone references `payload`, keep the change, and stop the watch. */
		const deliver = async (native: boolean): Promise<WeakRef<object>> => {
			const payload = { big: "x".repeat(1000) };
			if (native) {
				const watch = new NativeWatch<number>(
					0,
					() => {},
					() => {},
				);
				watch.start(async (change) => {
					kept.push(change);
				});
				watch.advance(1, producerContext(payload));
				await flush();
				expect(Object.keys(kept.at(-1)!)).toEqual(["kind", "value"]);
				expect(structuredClone(kept.at(-1))).toEqual({ kind: "value", value: 1 });
				await watch.stop();
			} else {
				const { watch } = recordedWatch<JsonValue>(0);
				watch.start(async (change) => {
					kept.push(change);
				});
				watch.advance(frame(1, [["r", 1]]), producerContext(payload));
				await flush();
				await watch.stop();
			}
			return new WeakRef(payload);
		};
		for (const native of [false, true]) {
			const payload = await deliver(native);
			await collect();
			expect(kept).toHaveLength(native ? 2 : 1);
			expect(payload.deref()).toBeUndefined();
		}
	});
});

describe("Watch ends", () => {
	it("stops idempotently and rejects a repeated or late start", async () => {
		const { watch, recorded } = recordedWatch<JsonValue>(0);
		watch.start(async () => {});
		expect(() => watch.start(async () => {})).toThrow("Watch is already started");
		expect(await watch.stop()).toEqual({ kind: "stopped" });
		expect(await watch.stop()).toEqual({ kind: "stopped" });
		expect(recorded.detached).toBe(1);

		const late = recordedWatch<JsonValue>(0).watch;
		await late.stop();
		expect(() => late.start(async () => {})).toThrow("Watch is stopped");
	});

	it("ends `ended` or `failed` from its source, dropping pending frames", async () => {
		const { watch, frames } = collectingWatch<JsonValue>(0);
		watch.advance(frame(1, [["r", 1]]), context);
		watch.end({ kind: "ended" });
		await flush();
		expect(frames).toEqual([]);
		expect(await watch.closed).toEqual({ kind: "ended" });

		const failure = new Error("source failed");
		const failed = recordedWatch<JsonValue>(0).watch;
		failed.end({ kind: "failed", error: failure });
		failed.end({ kind: "ended" });
		expect(await failed.closed).toEqual({ kind: "failed", error: failure });
	});

	it("stops future delivery without aborting or awaiting an in-flight callback", async () => {
		const { watch } = recordedWatch<JsonValue>(0);
		const gate = deferred();
		const calls: string[] = [];
		watch.start(
			onValue(async ({ value }) => {
				calls.push(`start ${value}`);
				await gate.promise;
				calls.push(`end ${value}`);
			}),
		);
		watch.advance(frame(1, [["r", 1]]), context);
		await flush();
		watch.advance(frame(2, [["r", 2]]), context);
		expect(await watch.stop()).toEqual({ kind: "stopped" });
		gate.resolve();
		await flush();
		expect(calls).toEqual(["start 1", "end 1"]);
	});

	it("ends `aborted` when its acquisition signal aborts, also when already aborted", async () => {
		const controller = new AbortController();
		const { watch, recorded } = recordedWatch<JsonValue>(0);
		watch.observeAbort(controller.signal);
		expect(() => watch.observeAbort(controller.signal)).toThrow("Watch abort is already installed");
		controller.abort();
		expect(await watch.closed).toEqual({ kind: "aborted" });
		expect(recorded.detached).toBe(1);

		const aborted = recordedWatch<JsonValue>(0).watch;
		aborted.observeAbort(AbortSignal.abort());
		expect(await aborted.closed).toEqual({ kind: "aborted" });

		const direct = recordedWatch<JsonValue>(0).watch;
		direct.abort();
		expect(await direct.closed).toEqual({ kind: "aborted" });
	});

	it("ends `listener_error` on a throw, reports it, and delivers nothing more", async () => {
		const { watch, recorded } = recordedWatch<JsonValue>(0);
		const failure = new Error("listener failed");
		const gate = deferred();
		const values: JsonValue[] = [];
		watch.start(
			onValue(async ({ value }) => {
				values.push(value);
				await gate.promise;
				throw failure;
			}),
		);
		watch.advance(frame(1, [["r", 1]]), context);
		await flush();
		watch.advance(frame(2, [["r", 2]]), context);
		gate.resolve();
		expect(await watch.closed).toEqual({ kind: "listener_error", error: failure });
		expect(values).toEqual([1]);
		expect(recorded.reported).toEqual([failure]);
		expect(recorded.detached).toBe(1);
	});

	it("wraps a thrown non-Error in an Error", async () => {
		const { watch } = recordedWatch<JsonValue>(0);
		watch.start(() => Promise.reject("plain"));
		watch.advance(frame(1, [["r", 1]]), context);
		const end = await watch.closed;
		expect(end.kind).toBe("listener_error");
		expect(end.kind === "listener_error" && end.error.message).toBe("plain");
	});
});

describe("Watch references", () => {
	it("retains neither its source, its listener, nor its signal once ended, while still referenced", async () => {
		/** A watch over a source only its closures reference; `end` ends it before returning. */
		const acquire = async (end: (watch: Watch<JsonValue>) => void) => {
			const source = { value: 1 as JsonValue };
			const controller = new AbortController();
			const watch = new Watch<JsonValue>(
				0,
				() => void source,
				() => void source,
			);
			const listener = async (): Promise<void> => {};
			watch.observeAbort(controller.signal);
			watch.start(listener);
			watch.advance(frame(1, [["r", 1]]), context);
			await flush();
			end(watch);
			return {
				watch,
				source: new WeakRef(source),
				listener: new WeakRef(listener),
				signal: new WeakRef(controller.signal),
			};
		};

		// Control: an open watch keeps its source, so the collections below are real.
		const open = await acquire(() => {});
		await collect();
		expect(open.source.deref()).toBeDefined();
		expect(open.listener.deref()).toBeDefined();
		expect(open.signal.deref()).toBeDefined();
		await open.watch.stop();

		for (const end of [
			(watch: Watch<JsonValue>) => void watch.stop(),
			(watch: Watch<JsonValue>) => watch.abort(),
			(watch: Watch<JsonValue>) => watch.end({ kind: "ended" }),
			(watch: Watch<JsonValue>) => watch.endAfterDelivery(),
		]) {
			const ended = await acquire(end);
			await flush();
			await collect();
			expect(ended.source.deref()).toBeUndefined();
			expect(ended.listener.deref()).toBeUndefined();
			expect(ended.signal.deref()).toBeUndefined();
		}
	});

	it("keeps no ops a fold or an overflow dropped, while it waits", async () => {
		/** Feed an unstarted watch four tracker batches of 4,000 sets each: the third overflows, the fourth is ignored. */
		const overflow = () => {
			const initial: Record<string, number> = {};
			for (let i = 0; i < 16_000; i++) initial[`k${i}`] = 0;
			const tracker = track<Record<string, number>>(initial);
			const watch = new Watch<JsonValue>(
				initial,
				() => {},
				() => {},
			);
			const batches: Array<WeakRef<readonly Op[]>> = [];
			for (let round = 0; round < 4; round++) {
				const change = tracker.beginChange();
				for (let i = round * 4_000; i < (round + 1) * 4_000; i++) change.state[`k${i}`] = 1;
				const prepared = change.prepare();
				tracker.adopt(prepared);
				batches.push(new WeakRef(prepared.ops));
				watch.advance(frame(tracker.value, prepared.ops), context);
			}
			return { watch, batches, newest: tracker.value };
		};
		const { watch, batches, newest } = overflow();
		await collect();
		expect(batches.map((batch) => batch.deref() === undefined)).toEqual([true, true, true, true]);
		const changes: WatchCall<JsonValue>[] = [];
		watch.start(async (change) => {
			changes.push(change);
		});
		await flush();
		expect(changes).toEqual([{ kind: "value", value: newest, ops: [["r", newest]], retired: false }]);
		await watch.stop();
	});

	it("delivers a native backlog that never drains in order", async () => {
		const watch = new NativeWatch<number>(
			0,
			() => {},
			() => {},
		);
		const values: number[] = [];
		let next = 50;
		// Each call queues one more value behind a backlog of 50, so the queue never empties for 1,000 values.
		watch.start(
			onValue(async ({ value }) => {
				values.push(value);
				if (next < 1_000) watch.advance(next++, context);
			}),
		);
		for (let n = 0; n < 50; n++) watch.advance(n, context);
		await flush();
		expect(values).toEqual(Array.from({ length: 1_000 }, (_, n) => n));
		await watch.stop();
	});

	it("releases its pending queue and leaf index once delivered or ended", async () => {
		/** Two pending frames, folded, whose ops alone reference `payload`; `settle` delivers or ends them. */
		const pending = async (settle: (watch: Watch<JsonValue>, gate: () => void) => Promise<void>) => {
			const payload = { big: "x".repeat(1000) };
			const watch = new Watch<JsonValue>(
				0,
				() => {},
				() => {},
			);
			const gate = deferred();
			let calls = 0;
			watch.start(async () => {
				if (++calls === 1) await gate.promise;
			});
			watch.advance(frame(1, [["s", ["n"], 1]]), context);
			await flush();
			watch.advance(frame(2, [["s", ["o"], payload]]), context);
			watch.advance(frame(3, [["s", ["n"], 3]]), context);
			await settle(watch, gate.resolve);
			return { watch, payload: new WeakRef(payload) };
		};

		const delivered = await pending(async (_watch, gate) => {
			gate();
			await flush();
		});
		await collect();
		expect(delivered.payload.deref()).toBeUndefined();
		expect(delivered.watch.value).toBe(3);

		const stopped = await pending(async (watch) => {
			await watch.stop();
		});
		await collect();
		expect(stopped.payload.deref()).toBeUndefined();
	});
});

describe("NativeWatch", () => {
	it("delivers values by identity in order with a context, never inline", async () => {
		const first = { run: () => 1 };
		const second = { run: () => 2 };
		const watch = new NativeWatch<{ run: () => number }>(
			{ run: () => 0 },
			() => {},
			() => {},
		);
		const key = createContextKey<string>("frame");
		const delivered: Array<{ value: { run: () => number }; frame: string | undefined }> = [];
		watch.start(
			onValue(async ({ value }, deliveryContext) => {
				delivered.push({ value, frame: deliveryContext.value(key) });
			}),
		);
		watch.advance(first, withContextValue(key, "first", context));
		watch.advance(second, withContextValue(key, "second", context));
		expect(delivered).toEqual([]);
		await flush();
		expect(delivered).toHaveLength(2);
		expect(delivered[0].value).toBe(first);
		expect(delivered[1].value).toBe(second);
		expect(delivered.map((entry) => entry.frame)).toEqual(["first", "second"]);
		expect(watch.value).toBe(second);
	});

	it("collapses 101 pending values to the newest", async () => {
		const watch = new NativeWatch<number>(
			0,
			() => {},
			() => {},
		);
		for (let n = 1; n <= 101; n++) watch.advance(n, context);
		const values: number[] = [];
		watch.start(
			onValue(async ({ value }) => {
				values.push(value);
			}),
		);
		await flush();
		expect(values).toEqual([101]);
	});

	it("collapses 101 pending values to the value of `replace`", async () => {
		const watch = new NativeWatch<string>(
			"",
			() => {},
			() => {},
			() => "replacement",
		);
		for (let n = 1; n <= 101; n++) watch.advance(`value ${n}`, context);
		const values: string[] = [];
		watch.start(
			onValue(async ({ value }) => {
				values.push(value);
			}),
		);
		await flush();
		expect(values).toEqual(["replacement"]);
	});

	it("ends with every reason of its lifecycle", async () => {
		const create = () =>
			new NativeWatch<number>(
				0,
				() => {},
				() => {},
			);
		const stopped = create();
		expect(await stopped.stop()).toEqual({ kind: "stopped" });

		const aborted = create();
		aborted.observeAbort(AbortSignal.abort());
		expect(await aborted.closed).toEqual({ kind: "aborted" });

		const ended = create();
		ended.end({ kind: "ended" });
		expect(await ended.closed).toEqual({ kind: "ended" });

		const finishing = create();
		const finished: number[] = [];
		finishing.advance(1, context);
		finishing.advance(2, context);
		finishing.endAfterDelivery();
		finishing.advance(3, context);
		finishing.start(
			onValue(async ({ value }) => {
				finished.push(value);
			}),
		);
		expect(await finishing.closed).toEqual({ kind: "ended" });
		expect(finished).toEqual([1, 2]);

		const error = new Error("source failed");
		const failed = create();
		failed.end({ kind: "failed", error });
		expect(await failed.closed).toEqual({ kind: "failed", error });

		const reported: unknown[] = [];
		const throwing = new NativeWatch<number>(
			0,
			() => {},
			(thrown) => reported.push(thrown),
		);
		const failure = new Error("listener failed");
		throwing.start(() => Promise.reject(failure));
		throwing.advance(1, context);
		expect(await throwing.closed).toEqual({ kind: "listener_error", error: failure });
		expect(reported).toEqual([failure]);
	});

	it("delivers a failure as a call, stays open, and folds it with the values around it", async () => {
		const reported: unknown[] = [];
		const watch = new NativeWatch<number>(
			0,
			() => {},
			(error) => reported.push(error),
		);
		const calls: NativeWatchCall<number>[] = [];
		watch.start(async (call) => {
			calls.push(call);
		});
		watch.advance(1, context);
		await flush();
		// Values followed by a failure: the failure; a failure followed by values: the values, in order.
		watch.advance(2, context);
		watch.advance(3, context);
		watch.fail("down", context);
		await flush();
		expect(watch.value).toBe(1);
		watch.fail("again", context);
		watch.advance(4, context);
		watch.advance(5, context);
		await flush();
		expect(calls).toEqual([
			{ kind: "value", value: 1 },
			{ kind: "failed", error: "down" },
			{ kind: "value", value: 4 },
			{ kind: "value", value: 5 },
		]);
		expect(watch.value).toBe(5);
		expect(reported).toEqual([]);
		await watch.stop();
	});

	it("retains neither its source nor its listener once stopped, while still referenced", async () => {
		const acquire = async (stop: boolean) => {
			const source = { value: 1 };
			const watch = new NativeWatch<number>(
				0,
				() => void source,
				() => void source,
			);
			const listener = async (): Promise<void> => {};
			watch.start(listener);
			watch.advance(source.value, context);
			await flush();
			if (stop) await watch.stop();
			return { watch, source: new WeakRef(source), listener: new WeakRef(listener) };
		};

		const open = await acquire(false);
		await collect();
		expect(open.source.deref()).toBeDefined();
		await open.watch.stop();

		const stopped = await acquire(true);
		await collect();
		expect(stopped.source.deref()).toBeUndefined();
		expect(stopped.listener.deref()).toBeUndefined();
		expect(stopped.watch.value).toBe(1);
	});
});
