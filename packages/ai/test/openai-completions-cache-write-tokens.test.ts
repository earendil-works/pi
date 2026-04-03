import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
	chunks: undefined as
		| Array<null | {
				id?: string;
				choices?: Array<{ delta: Record<string, unknown>; finish_reason: string | null; usage?: unknown }>;
				usage?: {
					prompt_tokens: number;
					completion_tokens: number;
					prompt_tokens_details: { cached_tokens: number; cache_write_tokens?: number };
					completion_tokens_details: { reasoning_tokens: number };
				};
		  }>
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: async (params: unknown) => {
					mockState.lastParams = params;
					return {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [
								{
									choices: [{ delta: {}, finish_reason: "stop" }],
									usage: {
										prompt_tokens: 1,
										completion_tokens: 1,
										prompt_tokens_details: { cached_tokens: 0 },
										completion_tokens_details: { reasoning_tokens: 0 },
									},
								},
							];
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions cache write token parsing", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
	});

	it("maps cache_write_tokens from prompt_tokens_details into usage.cacheWrite", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: { content: "READY" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-cache-write",
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 100,
					completion_tokens: 5,
					prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const model = getModel("openrouter", "google/gemini-3-flash-preview")!;
		const response = await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: "Reply with READY",
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		expect(response.stopReason).toBe("stop");
		expect(response.usage.input).toBe(20);
		expect(response.usage.output).toBe(5);
		expect(response.usage.cacheRead).toBe(80);
		expect(response.usage.cacheWrite).toBe(20);
		expect(response.usage.totalTokens).toBe(125);
	});
});
