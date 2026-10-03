import { beforeEach, describe, expect, it, vi } from "vitest";
import { completeSimple } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers({ "x-request-id": "req-1" }) },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function openRouterModel(provider = "openrouter"): Model<"openai-completions"> {
	return {
		id: "openrouter/auto",
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider,
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("openai-completions provider stream events", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	// Regression test for #9784.
	it("exposes provider chunks including OpenRouter metadata", async () => {
		const firstChunk = {
			id: "chatcmpl-1",
			model: "anthropic/claude-sonnet-4.6",
			choices: [{ index: 0, delta: { content: "hello" } }],
		};
		const finalChunk = {
			id: "chatcmpl-1",
			model: "anthropic/claude-sonnet-4.6",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 10,
				completion_tokens: 2,
				total_tokens: 12,
				cost: 0.0012,
				is_byok: false,
			},
			openrouter_metadata: { strategy: "direct", region: "iad" },
		};
		mockState.chunks = [firstChunk, finalChunk];
		const events: unknown[] = [];

		const message = await completeSimple(
			openRouterModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{
				apiKey: "test",
				onProviderStreamEvent: (data) => {
					events.push(data);
				},
			},
		);

		expect(message.content).toEqual([{ type: "text", text: "hello" }]);
		expect(events).toEqual([firstChunk, finalChunk]);
	});

	// Regression test for #9980.
	it("uses OpenRouter's reported total without double-counting non-BYOK upstream cost", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cost",
				model: "openrouter/auto",
				choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
				// These billing fields were captured from a production OpenRouter stream
				// even though the OpenAI SDK omits them from CompletionUsage.
				usage: {
					prompt_tokens: 100,
					completion_tokens: 20,
					cost: 0.004,
					is_byok: false,
					cost_details: { upstream_inference_cost: 0.003 },
				},
			},
		];

		const message = await completeSimple(
			openRouterModel("openrouter-work"),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.usage.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 });
	});

	it("includes upstream inference cost for OpenRouter BYOK requests", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-byok",
				model: "openrouter/auto",
				choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 20,
					cost: 0.0002,
					is_byok: true,
					cost_details: { upstream_inference_cost: 0.003 },
				},
			},
		];

		const message = await completeSimple(
			openRouterModel(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.usage.cost.total).toBeCloseTo(0.0032, 10);
	});
});
