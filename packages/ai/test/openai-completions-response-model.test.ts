import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/stream.js";
import type { Model } from "../src/types.js";

// Router/virtual ids (e.g. OpenRouter `auto`) keep `model` pinned to the
// requested id and surface the routed concrete id on `responseModel`.

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunks;
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
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
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function openRouterAuto(): Model<"openai-completions"> {
	return {
		id: "openrouter/auto",
		name: "OpenRouter Auto",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("openai-completions responseModel", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("surfaces routed chunk.model on responseModel without changing model", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-1", model: "anthropic/claude-opus-4.7", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "chatcmpl-1",
				model: "anthropic/claude-opus-4.7",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBe("anthropic/claude-opus-4.7");
		expect(message.provider).toBe("openrouter");
		expect(message.stopReason).toBe("stop");
	});

	it("leaves responseModel undefined when chunks echo the requested id", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-2", model: "openrouter/auto", choices: [{ index: 0, delta: { content: "hi" } }] },
			{
				id: "chatcmpl-2",
				model: "openrouter/auto",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBeUndefined();
	});

	it("ignores empty or missing chunk.model", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-3", choices: [{ index: 0, delta: { content: "hi" } }] },
			{ id: "chatcmpl-3", model: "", choices: [{ index: 0, delta: { content: "!" } }] },
			{
				id: "chatcmpl-3",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 2,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const message = await complete(
			openRouterAuto(),
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		expect(message.model).toBe("openrouter/auto");
		expect(message.responseModel).toBeUndefined();
	});
});
