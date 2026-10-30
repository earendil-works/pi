import { getHeapStatistics } from "node:v8";
import { InMemoryTelemetryContext, type TelemetrySpan } from "@earendil-works/pi-telemetry";
import { describe, expect, it, vi } from "vitest";
import { lazyStream } from "../src/api/lazy.ts";
import { AI_TELEMETRY_SCHEMA, createModels, createProvider } from "../src/models.ts";
import { observeModelRequest } from "../src/telemetry.ts";
import type { AssistantMessage, AssistantMessageEvent, DeferredHandle, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { collectGarbage } from "./memory-helpers.ts";

const model: Model<"telemetry-test"> = {
	id: "model",
	name: "Model",
	api: "telemetry-test",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
	contextWindow: 1000,
	maxTokens: 100,
};
const handle: DeferredHandle = { provider: model.provider, modelId: model.id, api: model.api, id: "deferred-secret" };

function message(stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{ type: "text", text: "text-secret" },
			{ type: "thinking", thinking: "thinking-secret" },
			{ type: "toolCall", id: "call-secret", name: "lookup", arguments: { value: "argument-secret" } },
		],
		usage: {
			input: 11,
			output: 22,
			cacheRead: 33,
			cacheWrite: 44,
			totalTokens: 110,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 },
		},
		responseId: "response",
		stopReason,
		timestamp: Date.now(),
	};
}

function events(result: AssistantMessage): AssistantMessageEvent[] {
	const toolCall = result.content[2];
	if (toolCall.type !== "toolCall") throw new Error("Missing tool call");
	return [
		{ type: "start", partial: result },
		{ type: "text_delta", contentIndex: 0, delta: "text-secret", partial: result },
		{ type: "text_end", contentIndex: 0, content: "text-secret", partial: result },
		{ type: "thinking_end", contentIndex: 1, content: "thinking-secret", partial: result },
		{ type: "toolcall_delta", contentIndex: 2, delta: '{"value":', partial: result },
		{ type: "toolcall_delta", contentIndex: 2, delta: '"argument-secret"}', partial: result },
		{ type: "toolcall_end", contentIndex: 2, toolCall, partial: result },
		result.stopReason === "error" || result.stopReason === "aborted"
			? { type: "error", reason: result.stopReason, error: result }
			: {
					type: "done",
					reason: result.stopReason === "pending" ? "deferred" : result.stopReason,
					message: result,
				},
	];
}

function setup(result: AssistantMessage = message()) {
	const models = createModels();
	const streamEvents = events(result);
	const respond = () => {
		const stream = new AssistantMessageEventStream();
		for (const event of streamEvents) stream.push(event);
		stream.end(result);
		return stream;
	};
	models.setProvider(
		createProvider({
			id: model.provider,
			models: [model],
			auth: { apiKey: { name: "Test", resolve: async () => ({ auth: {} }) } },
			api: { stream: respond, streamSimple: respond, fetchDeferred: respond },
		}),
	);
	return { models, streamEvents };
}

async function settled(telemetry: InMemoryTelemetryContext): Promise<void> {
	await vi.waitFor(() => expect(telemetry.getSpans().every((span) => span.settled)).toBe(true));
}

describe("AI telemetry", () => {
	it.each(["stream", "streamSimple", "streamDeferred"] as const)(
		"observes %s without changing delivered events or results",
		async (method) => {
			const telemetry = new InMemoryTelemetryContext();
			const result = message();
			const { models, streamEvents } = setup(result);
			await telemetry.startSpan({ name: "caller" }, async (parent) => {
				const stream =
					method === "streamDeferred"
						? models.streamDeferred(model, handle, { telemetry: parent })
						: models[method](model, { messages: [] }, { telemetry: parent, reasoning: "high" });
				const received: AssistantMessageEvent[] = [];
				for await (const event of stream) received.push(event);
				expect(received).toEqual(streamEvents);
				for (const [index, event] of received.entries()) expect(event).toBe(streamEvents[index]);
				expect(await stream.result()).toBe(result);
			});
			await settled(telemetry);
			const [parent, span] = telemetry.getSpans();
			expect(span.name).toBe(method === "streamDeferred" ? "pi.ai.poll" : "pi.ai.request");
			expect(span.parentId).toBe(parent.id);
			expect(span.attributes).toEqual({
				provider: "test",
				api: "telemetry-test",
				model: "model",
				...(method === "streamDeferred" ? {} : { reasoning: "high" }),
				stop: "stop",
				"usage.input": 11,
				"usage.output": 22,
				"usage.cache_read": 33,
				"usage.cache_write": 44,
				"cost.total": 1,
				"response.id": "response",
			});
			expect(span.events).toEqual([
				{ name: "pi.ai.first_chunk", attributes: {} },
				{ name: "pi.ai.block", attributes: { type: "text", index: 0, chars: 11 } },
				{ name: "pi.ai.block", attributes: { type: "thinking", index: 1, chars: 15 } },
				{ name: "pi.ai.block", attributes: { type: "tool_call", index: 2, chars: 27, tool: "lookup" } },
			]);
			expect(JSON.stringify(span)).not.toMatch(
				/text-secret|thinking-secret|argument-secret|call-secret|deferred-secret/,
			);
			const measurements = telemetry.getMetrics();
			expect(measurements).toHaveLength(7);
			expect(measurements.filter((measurement) => measurement.kind === "counter").map(({ value }) => value)).toEqual(
				[11, 22, 33, 44, 1],
			);
			for (const measurement of measurements) {
				expect(Object.keys(measurement.attributes).sort()).toEqual(
					measurement.name === "pi.ai.tokens"
						? ["kind", "model", "provider"]
						: measurement.name === "pi.ai.request.duration"
							? ["model", "provider", "stop"]
							: ["model", "provider"],
				);
				if (measurement.kind === "histogram") expect(measurement.context).toEqual(span.context);
			}
		},
	);

	it.each(["error", "aborted"] as const)("reports %s status without error attributes or events", async (reason) => {
		const telemetry = new InMemoryTelemetryContext();
		const result = { ...message(reason), errorMessage: "error-secret" };
		const { models } = setup(result);
		expect(
			await telemetry.startSpan({ name: "caller" }, (span) =>
				models.completeSimple(model, { messages: [] }, { telemetry: span }),
			),
		).toBe(result);
		await settled(telemetry);
		const [, span] = telemetry.getSpans();
		expect(span.status).toEqual(
			reason === "error"
				? { status: "error", error: { name: "provider_error", message: "error-secret" } }
				: { status: "ok" },
		);
		expect(span.attributes.stop).toBe(reason);
		expect(JSON.stringify(span.attributes)).not.toContain("error-secret");
		expect(JSON.stringify(span.events)).not.toContain("error-secret");
		if (reason === "aborted") expect(JSON.stringify(span)).not.toContain("error-secret");
	});

	it.each([false, true])("bounds poll error messages, including missing messages (missing=%s)", async (missing) => {
		const telemetry = new InMemoryTelemetryContext();
		const result = message("error");
		if (!missing) result.errorMessage = `${"x".repeat(500)}discarded-tail`;
		const { models } = setup(result);
		expect(
			await telemetry.startSpan({ name: "caller" }, (span) =>
				models.fetchDeferred(model, handle, { telemetry: span }),
			),
		).toBe(result);
		await settled(telemetry);
		const [, span] = telemetry.getSpans();
		expect(span.status).toEqual({
			status: "error",
			error: { name: "provider_error", message: missing ? "" : "x".repeat(500) },
		});
		expect(JSON.stringify(span)).not.toContain("discarded-tail");
		expect(JSON.stringify(span.attributes)).not.toContain("xxx");
		expect(JSON.stringify(span.events)).not.toContain("xxx");
	});

	// #9265
	it("keeps a bounded error message that does not hold the provider's whole message alive", async () => {
		const telemetry = new InMemoryTelemetryContext();
		await collectGarbage();
		const before = getHeapStatistics().used_heap_size;
		await (async () => {
			const result = message("error");
			result.errorMessage = `${"x".repeat(4_000_000)}tail`;
			const { models } = setup(result);
			await telemetry.startSpan({ name: "caller" }, (span) =>
				models.fetchDeferred(model, handle, { telemetry: span }),
			);
			await settled(telemetry);
		})();
		await collectGarbage();
		const [, span] = telemetry.getSpans();
		expect(span?.status).toEqual({ status: "error", error: { name: "provider_error", message: "x".repeat(500) } });
		// A slice of the 4 MB message would keep all of it alive with the span.
		expect(getHeapStatistics().used_heap_size - before).toBeLessThan(2_000_000);
	});

	it("includes setup failures and omits non-scalar native reasoning", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const models = createModels();
		const result = await telemetry.startSpan({ name: "caller" }, (span) =>
			models.complete(
				model,
				{ messages: [] },
				{
					telemetry: span,
					reasoning: { effort: "native-secret" },
				},
			),
		);
		expect(result.stopReason).toBe("error");
		await settled(telemetry);
		const [, span] = telemetry.getSpans();
		expect(span.attributes).not.toHaveProperty("reasoning");
		expect(span.events).toEqual([{ name: "pi.ai.first_chunk", attributes: {} }]);
		expect(span.status).toEqual({
			status: "error",
			error: { name: "provider_error", message: "Unknown provider: test" },
		});
		expect(JSON.stringify(span.attributes)).not.toContain("Unknown provider");
		expect(JSON.stringify(span)).not.toContain("native-secret");
	});

	it("counts interleaved tool deltas independently without reading arguments", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const result = message();
		await telemetry.startSpan({ name: "caller" }, (span) => {
			const observer = observeModelRequest(model, { telemetry: span }, false);
			const toolCall = {
				type: "toolCall" as const,
				id: "call",
				name: "lookup",
				get arguments(): Record<string, string> {
					throw new Error("Telemetry must not inspect or serialize arguments");
				},
			};
			for (const [index, delta] of [
				[2, "ab"],
				[3, "123"],
				[2, "c"],
			] as const) {
				observer.onEvent?.({ type: "toolcall_delta", contentIndex: index, delta, partial: result });
			}
			observer.onEvent?.({ type: "toolcall_end", contentIndex: 3, toolCall, partial: result });
			observer.onEvent?.({ type: "toolcall_end", contentIndex: 2, toolCall, partial: result });
			observer.onEvent?.({ type: "toolcall_end", contentIndex: 4, toolCall, partial: result });
			observer.onResult?.(result);
		});
		await settled(telemetry);
		expect(telemetry.getSpans()[1].events.slice(1)).toEqual([
			{ name: "pi.ai.block", attributes: { type: "tool_call", index: 3, chars: 3, tool: "lookup" } },
			{ name: "pi.ai.block", attributes: { type: "tool_call", index: 2, chars: 3, tool: "lookup" } },
			{ name: "pi.ai.block", attributes: { type: "tool_call", index: 4, chars: 0, tool: "lookup" } },
		]);
	});

	it("supports a tracing-only span without metric capabilities", async () => {
		const adapter = new InMemoryTelemetryContext();
		const { models } = setup();
		await adapter.startSpan({ name: "caller" }, (span) => {
			const telemetry: TelemetrySpan = { ...span, metrics: undefined };
			return models.completeSimple(model, { messages: [] }, { telemetry });
		});
		await settled(adapter);
		expect(adapter.getSpans()).toHaveLength(2);
		expect(adapter.getMetrics()).toEqual([]);
	});

	it("defaults to no-op telemetry", async () => {
		const { models } = setup();
		expect((await models.completeSimple(model, { messages: [] })).stopReason).toBe("stop");
		expect(AI_TELEMETRY_SCHEMA.spans["pi.ai.request"].startAttributes.provider.required).toBe(true);
	});

	it("records low-cardinality metrics with monotonic durations", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const result = message();
		let clock = 100;
		const monotonic = vi.spyOn(performance, "now").mockImplementation(() => clock);
		try {
			await telemetry.startSpan({ name: "caller" }, (span) => {
				const observer = observeModelRequest(model, { telemetry: span }, false);
				clock = 125;
				observer.onEvent?.({ type: "start", partial: result });
				clock = 175;
				observer.onResult?.(result);
			});
			await settled(telemetry);
		} finally {
			monotonic.mockRestore();
		}
		const metrics = telemetry.getMetrics();
		expect(metrics.map(({ name, value, attributes, unit }) => ({ name, value, attributes, unit }))).toEqual([
			{
				name: "pi.ai.first_chunk.duration",
				value: 25,
				attributes: { provider: "test", model: "model" },
				unit: "ms",
			},
			{
				name: "pi.ai.request.duration",
				value: 75,
				attributes: { provider: "test", model: "model", stop: "stop" },
				unit: "ms",
			},
			...[
				["input", 11],
				["output", 22],
				["cache_read", 33],
				["cache_write", 44],
			].map(([kind, value]) => ({
				name: "pi.ai.tokens",
				value,
				attributes: { provider: "test", model: "model", kind },
				unit: "token",
			})),
			{ name: "pi.ai.cost", value: 1, attributes: { provider: "test", model: "model" }, unit: "USD" },
		]);
		expect(metrics.slice(0, 2).every((measurement) => measurement.context !== null)).toBe(true);
	});

	it.each(["pending", "deferred", "stop", "error"] as const)(
		"records usage for a %s poll only when final",
		async (reason) => {
			const telemetry = new InMemoryTelemetryContext();
			const { models } = setup(message(reason));
			await telemetry.startSpan({ name: "caller" }, (span) =>
				models.fetchDeferred(model, handle, { telemetry: span }),
			);
			await settled(telemetry);
			const counters = telemetry.getMetrics().filter((metric) => metric.kind === "counter");
			expect(counters).toHaveLength(reason === "pending" || reason === "deferred" ? 0 : 5);
		},
	);

	it("creates instruments once per metrics object across root and child requests", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const histogram = vi.spyOn(telemetry, "histogram");
		const counter = vi.spyOn(telemetry, "counter");
		const { models } = setup();
		await telemetry.startSpan({ name: "caller" }, (span) =>
			models.completeSimple(model, { messages: [] }, { telemetry: span }),
		);
		await telemetry.startSpan({ name: "caller" }, (span) => models.fetchDeferred(model, handle, { telemetry: span }));
		await telemetry.startSpan({ name: "caller" }, (span) =>
			models.complete(model, { messages: [] }, { telemetry: span }),
		);
		await settled(telemetry);
		expect(histogram.mock.calls.map(([name]) => name)).toEqual([
			"pi.ai.request.duration",
			"pi.ai.first_chunk.duration",
		]);
		expect(counter.mock.calls.map(([name]) => name)).toEqual(["pi.ai.tokens", "pi.ai.cost"]);
		expect(telemetry.getMetrics()).toHaveLength(21);
	});
});

describe("lazyStream observation", () => {
	it("uses one source iterator and observes after push, once per terminal result", async () => {
		const result = message();
		const order: string[] = [];
		let iterators = 0;
		const source = {
			async *[Symbol.asyncIterator]() {
				iterators++;
				yield { type: "done", reason: "stop", message: result } as const;
			},
			result: async () => result,
		};
		const stream = lazyStream(model, async () => source, {
			onEvent: () => {
				order.push("event");
				void stream.result().then(() => order.push("resolved"));
			},
			onResult: (received) => {
				expect(received).toBe(result);
				order.push("result");
			},
		});
		expect(await stream.result()).toBe(result);
		await vi.waitFor(() => expect(order).toEqual(["event", "resolved", "result"]));
		expect(iterators).toBe(1);
	});

	it("reports a terminal result from an iterable without a result method", async () => {
		const result = message();
		const observed: Array<AssistantMessage | undefined> = [];
		const source = {
			async *[Symbol.asyncIterator]() {
				yield { type: "done", reason: "stop", message: result } as const;
			},
		};
		const stream = lazyStream(model, async () => source, { onResult: (value) => observed.push(value) });
		expect(await stream.result()).toBe(result);
		await vi.waitFor(() => expect(observed).toEqual([result]));
	});

	it("observes a result-only source once", async () => {
		const result = message();
		const observed: Array<AssistantMessage | undefined> = [];
		const source = { async *[Symbol.asyncIterator]() {}, result: async () => result };
		const stream = lazyStream(model, async () => source, { onResult: (value) => observed.push(value) });
		expect(await stream.result()).toBe(result);
		expect(observed).toEqual([result]);
	});

	it("reports setup failure events and the result once", async () => {
		const observed: string[] = [];
		const stream = lazyStream(
			model,
			async () => {
				throw new Error("setup-secret");
			},
			{
				onEvent: (event) => observed.push(event.type),
				onResult: (result) => observed.push(result?.stopReason ?? "missing"),
			},
		);
		expect((await stream.result()).errorMessage).toBe("setup-secret");
		expect(observed).toEqual(["error", "error"]);
	});
});
