import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTelemetryContext, type TelemetrySpan, telemetryNow } from "../src/index.ts";
import { telemetryStoreConformance } from "./store-conformance.ts";

afterEach(() => vi.restoreAllMocks());

telemetryStoreConformance("in-memory telemetry store conformance", async () => {
	const context = new InMemoryTelemetryContext();
	return { context, store: context, flush: async () => {}, [Symbol.asyncDispose]: async () => {} };
});

describe("in-memory store snapshots", () => {
	it("records wall-clock boundaries and relative event times without changing normalized event snapshots", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		const telemetry = new InMemoryTelemetryContext();
		let id = "";
		await telemetry.startSpan({ name: "timed" }, (span) => {
			const carrier = telemetry.inject(span)!;
			id = `${carrier["pi-memory-scope"]}:${carrier["pi-memory-span"]}`;
			clock.mockReturnValue(110);
			span.addEvent("event", { count: 1 });
			clock.mockReturnValue(125);
		});
		expect(await telemetry.getTrace(id)).toEqual({
			traceId: id,
			spans: [
				{
					id,
					traceId: id,
					name: "timed",
					startedMs: 1000,
					endedMs: 1025,
					attributes: {},
					events: [{ name: "event", timeMs: 10, attributes: { count: 1 } }],
					links: [],
					status: { status: "ok" },
				},
			],
		});
		expect(telemetry.getSpans()[0]?.events).toEqual([{ name: "event", attributes: { count: 1 } }]);
		expect(telemetry.getSpans()[0]).not.toHaveProperty("startedMs");
	});

	it("stamps starts with telemetryNow: spans of one millisecond apart to the microsecond, in their order", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(100);
		const telemetry = new InMemoryTelemetryContext();
		await telemetry.startSpan({ name: "first" }, () => {
			clock.mockReturnValue(100.25);
		});
		await telemetry.startSpan({ name: "second" }, () => {
			clock.mockReturnValue(100.5);
		});
		const spans = (await telemetry.findTraces()).traces.flatMap((trace) => trace.spans);
		expect(spans.map(({ name, startedMs, endedMs }) => [name, startedMs, endedMs])).toEqual([
			["second", 1000.25, 1000.5],
			["first", 1000, 1000.25],
		]);
	});

	it("maps raw metric measurements to count-one rows without exposing private timing in getMetrics", async () => {
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		const telemetry = new InMemoryTelemetryContext();
		telemetry.counter("calls").add(2);
		telemetry.counter("calls").add(3);
		expect(
			(await telemetry.findMetrics({ name: "calls" })).map((row) => [row.intervalMs, row.count, row.sum]),
		).toEqual([
			[20_000, 1, 2],
			[20_000, 1, 3],
		]);
		expect(telemetry.getMetrics()).toEqual([
			{ kind: "counter", name: "calls", value: 2, attributes: {}, context: null },
			{ kind: "counter", name: "calls", value: 3, attributes: {}, context: null },
		]);
	});

	it("detaches link attributes and error details", async () => {
		const telemetry = new InMemoryTelemetryContext();
		let target!: TelemetrySpan;
		await telemetry.startSpan({ name: "target" }, (span) => {
			target = span;
		});
		await telemetry.startSpan(
			{ name: "source", links: [{ context: target, attributes: { tags: ["original"] } }] },
			(span) => {
				span.setStatus({ status: "error", error: { name: "Expected", message: "original" } });
			},
		);
		const trace = (await telemetry.findTraces({ name: "source" })).traces[0]!;
		const span = trace.spans[0]!;
		span.links[0]!.attributes!.tags = ["changed"];
		if (span.status.status === "error" && span.status.error) span.status.error.message = "changed";
		const fresh = (await telemetry.getTrace(trace.traceId))!.spans[0]!;
		expect(fresh.links[0]?.attributes?.tags).toEqual(["original"]);
		expect(fresh.status).toEqual({ status: "error", error: { name: "Expected", message: "original" } });
	});
});

describe("telemetryNow", () => {
	it("counts sub-millisecond steps of the monotonic clock while the wall clock stays in its millisecond", () => {
		vi.spyOn(Date, "now").mockReturnValue(50_000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(1000.25);
		const first = telemetryNow();
		clock.mockReturnValue(1000.2504);
		expect(telemetryNow() - first).toBeCloseTo(0, 6);
		clock.mockReturnValue(1000.7512);
		expect(telemetryNow() - first).toBeCloseTo(0.501, 6);
		expect(Number.isInteger(telemetryNow() * 1000)).toBe(true);
	});

	it("follows a step of the wall clock (set, or a sleep the monotonic clock did not count) past 10 ms", () => {
		// Far from the anchor any earlier call left: anchored anew, at the wall clock's millisecond.
		const wall = vi.spyOn(Date, "now").mockReturnValue(80_000);
		const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
		expect(telemetryNow()).toBe(80_000);
		clock.mockReturnValue(1003.5);
		wall.mockReturnValue(80_005);
		// Within 10 ms the anchored clock keeps its own spacing.
		expect(telemetryNow()).toBe(80_003.5);
		clock.mockReturnValue(1004);
		wall.mockReturnValue(3_650_004);
		expect(telemetryNow()).toBe(3_650_004);
		clock.mockReturnValue(1004.125);
		expect(telemetryNow()).toBe(3_650_004.125);
	});
});
