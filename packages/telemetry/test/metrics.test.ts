import { describe, expect, expectTypeOf, it } from "vitest";
import {
	createTypedMetrics,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type SpanAttributes,
	type TelemetryCarrier,
	type TelemetryMetricDefinition,
} from "../src/index.ts";

const traffic = defineTelemetrySchema({
	version: 1,
	spans: {},
	metrics: {
		"network.bytes": {
			kind: "counter",
			description: "Encoded bytes",
			unit: "By",
			attributes: {
				direction: {
					type: "string",
					values: ["in", "out"],
					required: true,
					description: "Direction",
					cardinality: "low",
				},
			},
		},
		"network.active": { kind: "upDownCounter", description: "Open links", attributes: {} },
	},
} as const);
const latency = defineTelemetrySchema({
	version: 1,
	spans: {},
	metrics: {
		"call.duration": {
			kind: "histogram",
			description: "Call duration",
			unit: "ms",
			boundaries: [1, 10, 100],
			attributes: { method: { type: "string", required: false, description: "Method" } },
		},
	},
} as const);

describe("metrics", () => {
	it("binds schema names, kinds, metadata, and exact measurement attributes", async () => {
		const adapter = new InMemoryTelemetryContext();
		const metrics = createTypedMetrics(adapter, [traffic, latency]);
		metrics.counter("network.bytes").add(128, { direction: "out" });
		metrics.upDownCounter("network.active").add(1);
		metrics.upDownCounter("network.active").add(-1);
		await adapter.startSpan({ name: "request" }, (span) => {
			metrics.histogram("call.duration").record(12, { method: "read" }, span);
			metrics.histogram("call.duration").record(13);
			metrics.histogram("call.duration").record(14, undefined, span);
		});
		const measurements = adapter.getMetrics();
		expect(measurements[0]).toMatchObject({
			kind: "counter",
			name: "network.bytes",
			description: "Encoded bytes",
			unit: "By",
			value: 128,
			attributes: { direction: "out" },
		});
		expect(measurements[3]).toMatchObject({
			kind: "histogram",
			boundaries: [1, 10, 100],
			context: adapter.getSpans()[0]?.context,
		});
		expect(measurements[4]?.context).toBeNull();
		expect(measurements[5]?.context).toEqual(adapter.getSpans()[0]?.context);
		const compileTimeFailures = () => {
			// @ts-expect-error counter names are restricted to counters
			metrics.counter("call.duration");
			// @ts-expect-error histogram names are restricted to histograms
			metrics.histogram("network.bytes");
			// @ts-expect-error unknown names are rejected
			metrics.upDownCounter("unknown");
			// @ts-expect-error required metric attributes cannot be omitted
			metrics.counter("network.bytes").add(1);
			// @ts-expect-error closed-set metric values are exact
			metrics.counter("network.bytes").add(1, { direction: "sideways" });
			const extra = { direction: "in", unknown: true } as const;
			// @ts-expect-error variables containing unknown attributes are rejected
			metrics.counter("network.bytes").add(1, extra);
			// @ts-expect-error an empty attribute schema rejects every attribute
			metrics.upDownCounter("network.active").add(1, { unknown: true });
			// @ts-expect-error duplicate metric names are rejected
			createTypedMetrics(adapter, [traffic, traffic]);
			const invalid: TelemetryMetricDefinition = {
				kind: "counter",
				description: "Invalid",
				attributes: {
					// @ts-expect-error high-cardinality attributes do not belong on metrics
					request: { type: "string", required: false, description: "Request", cardinality: "high" },
				},
			};
			return invalid;
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
		expect(() => JSON.stringify(traffic)).not.toThrow();
	});

	it("requires histogram attributes when the schema declares them", () => {
		const schema = defineTelemetrySchema({
			version: 1,
			spans: {},
			metrics: {
				required: {
					kind: "histogram",
					description: "Required tag",
					attributes: {
						cache: { type: "boolean", required: true, description: "Cache hit" },
					},
				},
			},
		} as const);
		const metrics = createTypedMetrics(new InMemoryTelemetryContext(), [schema]);
		metrics.histogram("required").record(1, { cache: true });
		const compileTimeFailures = () => {
			// @ts-expect-error histogram attributes are required
			metrics.histogram("required").record(1);
			// @ts-expect-error histogram values match their attribute schema
			metrics.histogram("required").record(1, { cache: "true" });
			// @ts-expect-error optional exemplar context does not replace required attributes
			metrics.histogram("required").record(1, NOOP_TELEMETRY_CONTEXT);
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});

	it("returns detached measurement snapshots including exemplars and boundaries", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const histogram = telemetry.histogram("duration", { boundaries: [1, 2] });
		await telemetry.startSpan({ name: "request" }, (span) => histogram.record(1, { tags: ["original"] }, span));
		const measurement = telemetry.getMetrics()[0];
		if (!measurement?.context) throw new Error("Expected measurement context");
		(measurement.boundaries as number[]).push(3);
		(measurement.attributes as SpanAttributes).tags = ["mutated"];
		(measurement.context as TelemetryCarrier)["pi-memory-span"] = "999";
		expect(telemetry.getMetrics()[0]).toMatchObject({
			boundaries: [1, 2],
			attributes: { tags: ["original"] },
			context: telemetry.getSpans()[0]?.context,
		});
	});

	it("shares frozen no-op instruments", () => {
		const options = { unit: "By" };
		const attributes = { direction: "out" };
		const counter = NOOP_TELEMETRY_METRICS.counter("bytes", options);
		const active = NOOP_TELEMETRY_METRICS.upDownCounter("active", options);
		const histogram = NOOP_TELEMETRY_METRICS.histogram("duration", options);
		expect(counter).toBe(NOOP_TELEMETRY_METRICS.counter("other"));
		expect(Object.isFrozen(counter)).toBe(true);
		expect(Object.isFrozen(active)).toBe(true);
		expect(Object.isFrozen(histogram)).toBe(true);
		counter.add(1, attributes);
		active.add(-1, attributes);
		histogram.record(1, attributes, NOOP_TELEMETRY_CONTEXT);
	});
});
