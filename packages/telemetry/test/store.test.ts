import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTelemetryContext, type TelemetrySpan } from "../src/index.ts";
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
