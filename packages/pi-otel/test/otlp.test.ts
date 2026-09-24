import type { TelemetrySpan } from "@earendil-works/pi-telemetry";
import { describe, expect, it } from "vitest";
import { OtlpTelemetryContext, type OtlpTraceRequest } from "../src/index.ts";

interface CapturedRequest {
	url: string;
	headers: Record<string, string>;
	body: OtlpTraceRequest;
}

const HEX128 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{16}$/;

function createHarness(options?: {
	scheduleDelayMs?: number;
	maxBatchSize?: number;
	maxQueueSize?: number;
	retries?: number;
	retryBaseDelayMs?: number;
	serviceName?: string;
	resourceAttributes?: Record<string, string | number | boolean>;
	headers?: Record<string, string>;
	statuses?: number[];
	neverAck?: boolean;
}) {
	const requests: CapturedRequest[] = [];
	let cursor = 0;
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		const status = options?.neverAck ? 500 : (options?.statuses?.[cursor] ?? 200);
		cursor += 1;
		requests.push({
			url: String(url),
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: JSON.parse(String(init?.body ?? "{}")) as OtlpTraceRequest,
		});
		return new Response(null, { status });
	}) as typeof fetch;
	const context = new OtlpTelemetryContext({
		endpoint: "http://collector.invalid/v1/traces",
		scheduleDelayMs: options?.scheduleDelayMs ?? 0,
		maxBatchSize: options?.maxBatchSize,
		maxQueueSize: options?.maxQueueSize,
		retries: options?.retries,
		retryBaseDelayMs: options?.retryBaseDelayMs,
		serviceName: options?.serviceName,
		resourceAttributes: options?.resourceAttributes,
		headers: options?.headers,
		fetchImpl,
	});
	return { context, requests };
}

function createFromEndpoint(endpoint: string) {
	const requests: CapturedRequest[] = [];
	const context = new OtlpTelemetryContext({
		endpoint,
		scheduleDelayMs: 0,
		fetchImpl: ((url: string, init?: RequestInit) => {
			requests.push({
				url: String(url),
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: JSON.parse(String(init?.body ?? "{}")) as OtlpTraceRequest,
			});
			return Promise.resolve(new Response(null, { status: 200 }));
		}) as typeof fetch,
	});
	return { context, requests };
}

const spansOf = (request: CapturedRequest | undefined) => request?.body.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];

describe("OtlpTelemetryContext wire format", () => {
	it("encodes spans, ids, parentage, and status in OTLP/JSON", async () => {
		const { context, requests } = createHarness();
		await context.startSpan({ name: "root", attributes: { root: 1 } }, async (root) => {
			await root.startSpan({ name: "child" }, async (child) => {
				child.setStatus({ status: "error", error: { name: "Boom", message: "exploded" } });
				await child.startSpan({ name: "grandchild" }, (grand) => {
					grand.addEvent("mark", { n: 2 });
				});
			});
		});
		await context.flush();

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://collector.invalid/v1/traces");
		expect(requests[0]?.headers["content-type"]).toBe("application/json");
		const resourceSpan = requests[0]?.body.resourceSpans[0];
		expect(
			resourceSpan?.resource.attributes.some((kv) => kv.key === "service.name" && kv.value?.stringValue === "pi"),
		).toBe(true);
		expect(resourceSpan?.scopeSpans[0]?.scope.name).toBe("@earendil-works/pi-otel");
		const spans = spansOf(requests[0]);
		expect(spans).toHaveLength(3);

		const byName = new Map(spans.map((span) => [span.name, span]));
		const root = byName.get("root");
		const child = byName.get("child");
		const grand = byName.get("grandchild");
		expect(root).toBeDefined();
		expect(child).toBeDefined();
		expect(grand).toBeDefined();
		if (!root || !child || !grand) return;

		// W3C ids: 128/64-bit lowercase hex, shared trace across the tree.
		expect(root.traceId).toMatch(HEX128);
		expect(root.spanId).toMatch(HEX64);
		expect(root.parentSpanId).toBeUndefined();
		expect(child.traceId).toBe(root.traceId);
		expect(grand.traceId).toBe(root.traceId);
		expect(child.parentSpanId).toBe(root.spanId);
		expect(grand.parentSpanId).toBe(child.spanId);
		expect(new Set([root.spanId, child.spanId, grand.spanId]).size).toBe(3);

		// Timestamps are int64 strings, ordered along the tree.
		expect(root.startTimeUnixNano).toMatch(/^\d+$/);
		expect(BigInt(root.startTimeUnixNano)).toBeLessThanOrEqual(BigInt(root.endTimeUnixNano));
		expect(BigInt(child.startTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(root.startTimeUnixNano));
		expect(BigInt(child.endTimeUnixNano)).toBeLessThanOrEqual(BigInt(root.endTimeUnixNano));

		// Status: ok spans are code 0; the failed child is code 2 with its message.
		expect(root.status.code).toBe(0);
		expect(child.status.code).toBe(2);
		expect(child.status.message).toBe("exploded");
		expect(grand.events.some((event) => event.name === "mark" && /^\d+$/.test(event.timeUnixNano))).toBe(true);
	});

	it("emits true nanosecond timestamps at the real epoch", async () => {
		const { context, requests } = createHarness();
		await context.startSpan({ name: "t" }, () => undefined);
		await context.flush();
		const span = spansOf(requests[0])[0];
		expect(span).toBeDefined();
		if (!span) return;
		const startNs = BigInt(span.startTimeUnixNano);
		// Millisecond granularity: ns values are whole-millisecond multiples.
		expect(startNs % 1_000_000n).toBe(0n);
		// Not a scaled-down epoch: within 60s of Date.now() in true nanoseconds.
		const nowNs = BigInt(Math.floor(Date.now())) * 1_000_000n;
		expect(nowNs - startNs).toBeLessThan(60_000_000_000n);
		expect(startNs).toBeGreaterThan(1_700_000_000_000_000_000n);
	});

	it("enqueues a span that settles after a flush passed it", async () => {
		const { context, requests } = createHarness();
		const done = context.startSpan({ name: "late" }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		// First flush finds the span unsettled and must not lose it.
		await context.flush();
		await done;
		await context.flush();
		const names = requests.flatMap((request) => spansOf(request).map((span) => span.name));
		expect(names).toContain("late");
		expect(context.getDroppedSpanCount()).toBe(0);
		await context.close();
	});

	it("encodes every attribute value kind and drops undefined", async () => {
		const { context, requests } = createHarness();
		await context.startSpan(
			{
				name: "attrs",
				attributes: {
					text: "value",
					count: 3,
					ratio: 1.5,
					enabled: true,
					flags: [true, false],
					names: ["a", "b"],
					missing: undefined,
				},
			},
			(span: TelemetrySpan) => {
				span.addEvent("event", { detail: 1 });
			},
		);
		await context.flush();
		const span = spansOf(requests[0])[0];
		expect(span).toBeDefined();
		if (!span) return;
		const attrs = new Map(span.attributes.map((kv) => [kv.key, kv.value]));
		expect(attrs.get("text")?.stringValue).toBe("value");
		expect(attrs.get("count")?.intValue).toBe("3");
		expect(attrs.get("ratio")?.doubleValue).toBe(1.5);
		expect(attrs.get("enabled")?.boolValue).toBe(true);
		expect(attrs.get("flags")?.arrayValue?.values).toEqual([{ boolValue: true }, { boolValue: false }]);
		expect(attrs.get("names")?.arrayValue?.values).toEqual([{ stringValue: "a" }, { stringValue: "b" }]);
		expect(attrs.has("missing")).toBe(false);
		expect(span.events.some((event) => event.name === "event")).toBe(true);
	});

	it("sends a new trace id per root span", async () => {
		const { context, requests } = createHarness();
		await context.startSpan({ name: "first" }, () => undefined);
		await context.startSpan({ name: "second" }, () => undefined);
		await context.flush();
		const spans = spansOf(requests[0]);
		expect(spans[0]?.traceId).not.toBe(spans[1]?.traceId);
	});

	it("records the end time at settlement, not at export", async () => {
		const { context, requests } = createHarness();
		await context.startSpan({ name: "slow" }, async () => {
			await new Promise((resolve) => setTimeout(resolve, 40));
		});
		await context.flush();
		const span = spansOf(requests[0])[0];
		expect(span).toBeDefined();
		if (!span) return;
		const durationMs = Number(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000;
		expect(durationMs).toBeGreaterThanOrEqual(30);
	});

	it("batches by maxBatchSize in order", async () => {
		const { context, requests } = createHarness({ maxBatchSize: 2 });
		for (let i = 0; i < 5; i += 1) await context.startSpan({ name: `s${i}` }, () => undefined);
		await context.flush();
		expect(requests).toHaveLength(3);
		const names = requests.flatMap((request) => spansOf(request).map((span) => span.name));
		expect(names).toEqual(["s0", "s1", "s2", "s3", "s4"]);
		expect(spansOf(requests[0])).toHaveLength(2);
		expect(spansOf(requests[2])).toHaveLength(1);
		expect(context.getExportedSpanCount()).toBe(5);
	});

	it("retries 408/429/5xx with bounded backoff, then counts the export", async () => {
		const { context, requests } = createHarness({ statuses: [503, 429, 200], retryBaseDelayMs: 1 });
		await context.startSpan({ name: "retried" }, () => undefined);
		await context.flush();
		expect(requests).toHaveLength(3);
		expect(context.getExportedSpanCount()).toBe(1);
		expect(context.getDroppedSpanCount()).toBe(0);
	});

	it("drops a batch once retries are exhausted", async () => {
		const { context, requests } = createHarness({ neverAck: true, retries: 1, retryBaseDelayMs: 1 });
		await context.startSpan({ name: "lost" }, () => undefined);
		await context.flush();
		expect(requests).toHaveLength(2); // initial attempt + one retry
		expect(context.getExportedSpanCount()).toBe(0);
		expect(context.getDroppedSpanCount()).toBe(1);
	});

	it("drops other 4xx without retry", async () => {
		const { context, requests } = createHarness({ statuses: [400], retries: 3, retryBaseDelayMs: 1 });
		await context.startSpan({ name: "bad" }, () => undefined);
		await context.flush();
		expect(requests).toHaveLength(1);
		expect(context.getDroppedSpanCount()).toBe(1);
		expect(context.getFatalError()).toBeUndefined();
	});

	it("treats 401 as fatal: stops exporting and drops the queue", async () => {
		const { context, requests } = createHarness({ statuses: [401, 200], scheduleDelayMs: 0 });
		await context.startSpan({ name: "authed" }, () => undefined);
		await context.flush();
		expect(requests).toHaveLength(1);
		expect(context.getFatalError()).toMatch(/HTTP 401/);
		await context.startSpan({ name: "after-fault" }, () => undefined);
		await context.flush();
		// No second request: export is stopped.
		expect(requests).toHaveLength(1);
		expect(context.getDroppedSpanCount()).toBeGreaterThanOrEqual(2);
		await context.close();
	});

	it("drops the oldest spans beyond maxQueueSize", async () => {
		const { context, requests } = createHarness({ maxQueueSize: 2 });
		for (let i = 0; i < 4; i += 1) await context.startSpan({ name: `q${i}` }, () => undefined);
		await context.flush();
		expect(context.getDroppedSpanCount()).toBe(2);
		expect(spansOf(requests[0]).map((span) => span.name)).toEqual(["q2", "q3"]);
	});

	it("flushes on the schedule without an explicit call", async () => {
		const { context, requests } = createHarness({ scheduleDelayMs: 25 });
		await context.startSpan({ name: "scheduled" }, () => undefined);
		await new Promise((resolve) => setTimeout(resolve, 120));
		expect(requests.length).toBeGreaterThanOrEqual(1);
		await context.close();
	});

	it("close performs a final flush and then stops", async () => {
		const { context, requests } = createHarness();
		await context.startSpan({ name: "final" }, () => undefined);
		await context.close();
		expect(requests).toHaveLength(1);
		await context.startSpan({ name: "post-close" }, () => undefined);
		await context.flush();
		expect(requests).toHaveLength(1);
	});

	it("merges headers, service name, and resource attributes (service name wins)", async () => {
		const { context, requests } = createHarness({
			headers: { Authorization: "Bearer tok" },
			serviceName: "pi-worker",
			resourceAttributes: { "run.id": "r1", "service.name": "spoofed" },
		});
		await context.startSpan({ name: "cfg" }, () => undefined);
		await context.flush();
		expect(requests[0]?.headers["Authorization"]).toBe("Bearer tok");
		const resource = requests[0]?.body.resourceSpans[0]?.resource.attributes ?? [];
		const serviceNames = resource.filter((kv) => kv.key === "service.name");
		expect(serviceNames).toHaveLength(1);
		expect(serviceNames[0]?.value?.stringValue).toBe("pi-worker");
		expect(resource.some((kv) => kv.key === "run.id" && kv.value?.stringValue === "r1")).toBe(true);
	});

	it("normalizes endpoints: base URL gets /v1/traces, full URLs are kept", async () => {
		const base = createFromEndpoint("http://collector.invalid:4318/");
		await base.context.startSpan({ name: "a" }, () => undefined);
		await base.context.flush();
		expect(base.requests[0]?.url).toBe("http://collector.invalid:4318/v1/traces");
		const full = createFromEndpoint("http://collector.invalid:4318/v1/traces/");
		await full.context.startSpan({ name: "b" }, () => undefined);
		await full.context.flush();
		expect(full.requests[0]?.url).toBe("http://collector.invalid:4318/v1/traces");
	});
});
