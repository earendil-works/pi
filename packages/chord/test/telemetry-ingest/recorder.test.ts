// Tests of Chord's telemetry recorder: settled spans and metric aggregates kept for its owner, taken as batches; ids
// under a scope read at the first span; the queue bounded with a taken batch counted until released; ingested spans
// and metrics join the queue; a stop makes later spans inert.

import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryRecorder } from "../../src/telemetry-ingest/index.ts";

afterEach(() => vi.restoreAllMocks());

describe("recording", () => {
	it("keeps settled spans only, its ids under the scope it reads at its first span, carriers its own", async () => {
		let scope = "early";
		const recorder = new TelemetryRecorder(() => scope, 100);
		scope = "browser:inc";
		const gate = Promise.withResolvers<void>();
		const open = recorder.startSpan({ name: "open" }, () => gate.promise);
		let carrier: Record<string, string> | undefined;
		await recorder.startSpan({ name: "root" }, (span) => {
			carrier = recorder.inject(span);
			return span.startSpan({ name: "child" }, () => {});
		});
		const { spans } = recorder.take(false);
		expect(spans.map(({ id, parentId, name }) => [id, parentId, name])).toEqual([
			["browser:inc:3", "browser:inc:2", "child"],
			["browser:inc:2", undefined, "root"],
		]);
		expect(carrier).toEqual({ "pi-sqlite-span": "browser:inc:2", "pi-sqlite-trace": "browser:inc:2" });
		gate.resolve();
		await open;
		expect(recorder.take(false).spans.map(({ name }) => name)).toEqual(["open"]);
	});

	it("aggregates metrics per series and 10 s, taking only intervals that are over unless partial", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(20_001);
		const recorder = new TelemetryRecorder(() => "s", 100);
		recorder.metrics.counter("hits").add(2, { b: 1, a: true });
		recorder.metrics.counter("hits").add(3, { a: true, b: 1 });
		expect(recorder.take(false).metrics).toEqual([]);
		now.mockReturnValue(30_001);
		expect(recorder.take(false).metrics).toEqual([
			{
				intervalMs: 20_000,
				name: "hits",
				kind: "counter",
				attributes: { a: true, b: 1 },
				count: 2,
				sum: 5,
				min: 2,
				max: 3,
			},
		]);
		recorder.metrics.counter("hits").add(1);
		expect(recorder.take(true).metrics.map(({ intervalMs, sum }) => [intervalMs, sum])).toEqual([[30_000, 1]]);
	});
});

describe("the queue", () => {
	it("counts a taken batch against its bound until released, dropping and counting past it", async () => {
		const recorder = new TelemetryRecorder(() => "s", 2);
		await recorder.startSpan({ name: "a" }, () => {});
		await recorder.startSpan({ name: "b" }, () => {});
		const taken = recorder.take(false, 1);
		expect(taken.spans.map(({ name }) => name)).toEqual(["a"]);
		await recorder.startSpan({ name: "c" }, () => {});
		expect(recorder.droppedSpans).toBe(1);
		recorder.release();
		await recorder.startSpan({ name: "d" }, () => {});
		expect(recorder.take(false).spans.map(({ name }) => name)).toEqual(["b", "d"]);
	});

	it("queues ingested spans and merges ingested metric rows within its bounds", () => {
		const recorder = new TelemetryRecorder(() => "s", 1);
		const span = {
			id: "w:1",
			traceId: "w:1",
			name: "x",
			startedMs: 1,
			endedMs: 2,
			attributes: {},
			events: [],
			links: [],
			status: { status: "ok" },
		} as const;
		const metric = {
			intervalMs: 0,
			name: "m",
			kind: "counter",
			attributes: {},
			count: 1,
			sum: 2,
			min: 2,
			max: 2,
		} as const;
		expect(recorder.ingest({ spans: [span, { ...span, id: "w:2" }], metrics: [metric, metric] })).toBe(1);
		expect(recorder.droppedSpans).toBe(1);
		const batch = recorder.take(true);
		expect(batch.spans.map(({ id }) => id)).toEqual(["w:1"]);
		expect(batch.metrics).toEqual([{ ...metric, count: 2, sum: 4 }]);
	});

	it("records nothing once stopped; a discarding stop drops what waits", async () => {
		const recorder = new TelemetryRecorder(() => "s", 10);
		await recorder.startSpan({ name: "kept" }, () => {});
		recorder.stop("keep");
		await recorder.startSpan({ name: "late" }, () => {});
		recorder.metrics.counter("late").add(1);
		expect(recorder.take(true)).toEqual({ spans: [expect.objectContaining({ name: "kept" })], metrics: [] });
		const discarding = new TelemetryRecorder(() => "s", 10);
		await discarding.startSpan({ name: "gone" }, () => {});
		discarding.stop("discard");
		expect(discarding.take(true)).toEqual({ spans: [], metrics: [] });
	});
});
