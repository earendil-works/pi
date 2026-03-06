// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

let capturedResponsesParams: unknown;
let capturedCompletionsParams: unknown;
let nextStreamEvents: unknown[] = [];

vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		public chat: {
			completions: {
				create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
			};
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (params: unknown) => {
					capturedResponsesParams = params;
					async function* gen(): AsyncGenerator<unknown> {
						for (const ev of nextStreamEvents) yield ev;
					}
					return gen();
				},
			};

			this.chat = {
				completions: {
					create: async (params: unknown) => {
						capturedCompletionsParams = params;
						async function* gen(): AsyncGenerator<unknown> {
							yield {
								choices: [{ delta: { content: "Hello" }, finish_reason: null, index: 0 }],
								usage: undefined,
							};
							yield {
								choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
								usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
							};
						}
						return gen();
					},
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.js";

afterEach(() => {
	capturedResponsesParams = undefined;
	capturedCompletionsParams = undefined;
	nextStreamEvents = [];
	vi.restoreAllMocks();
});

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

describe("OpenAI fast mode request params", () => {
	it("sends service_tier=priority for gpt responses models when fast mode is enabled", async () => {
		nextStreamEvents = [{ type: "response.completed", response: { status: "completed", usage: {} } }];

		const model: Model<"openai-responses"> = {
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		const stream = streamOpenAIResponses(model, createContext(), { apiKey: "test-key", fastMode: true });
		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		expect(capturedResponsesParams?.service_tier).toBe("priority");
	});

	it("does not send service_tier for non-gpt responses models", async () => {
		nextStreamEvents = [{ type: "response.completed", response: { status: "completed", usage: {} } }];

		const model: Model<"openai-responses"> = {
			id: "o3-mini",
			name: "o3-mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		const stream = streamOpenAIResponses(model, createContext(), { apiKey: "test-key", fastMode: true });
		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		expect(capturedResponsesParams?.service_tier).toBeUndefined();
	});

	it("sends service_tier=priority for gpt completions models when fast mode is enabled", async () => {
		const model: Model<"openai-completions"> = {
			id: "gpt-4o",
			name: "GPT-4o",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};

		const stream = streamOpenAICompletions(model, createContext(), { apiKey: "test-key", fastMode: true });
		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		expect(capturedCompletionsParams?.service_tier).toBe("priority");
	});
});
