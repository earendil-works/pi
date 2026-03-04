import { beforeEach, describe, expect, it, vi } from "vitest";

let capturedParams: unknown = null;
let mockedChunks: unknown[] = [];

vi.mock("openai", () => {
	class MockOpenAI {
		public chat: {
			completions: {
				create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
			};
		};

		constructor(_opts: unknown) {
			this.chat = {
				completions: {
					create: async (params: unknown) => {
						capturedParams = params;

						async function* gen(): AsyncGenerator<unknown> {
							for (const chunk of mockedChunks) {
								yield chunk;
							}
						}

						return gen();
					},
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model } from "../src/types.js";

function createBasetenModel(id: string, name: string): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "baseten",
		baseUrl: "https://inference.baseten.co/v1",
		reasoning: true,
		reasoningFormat: "reasoning_content",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32768,
	};
}

describe("baseten OpenAI-compat", () => {
	beforeEach(() => {
		capturedParams = null;
		mockedChunks = [];
	});

	it("uses chat_template_args for GLM/Kimi and parses reasoning_content from choice.message", async () => {
		const model = createBasetenModel("zai-org/GLM-5", "GLM-5 (Baseten)");
		const context: Context = {
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};

		mockedChunks = [
			{
				choices: [
					{
						message: {
							content: "Final answer",
							reasoning_content: "step by step",
						},
						finish_reason: "stop",
					},
				],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 20,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const s = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			reasoningEffort: "high",
		});
		const result = await s.result();

		expect(capturedParams).not.toBeNull();
		const params = capturedParams as Record<string, unknown>;
		expect(params.chat_template_args).toEqual({ enable_thinking: true });
		expect(params.reasoning_effort).toBeUndefined();

		const thinkingBlock = result.content.find((b) => b.type === "thinking");
		const textBlock = result.content.find((b) => b.type === "text");
		expect(thinkingBlock).toMatchObject({ type: "thinking", thinking: "step by step" });
		expect(textBlock).toMatchObject({ type: "text", text: "Final answer" });
	});

	it("uses reasoning_effort for Baseten gpt-oss-120b", async () => {
		const model = createBasetenModel("openai/gpt-oss-120b", "GPT OSS 120B (Baseten)");
		const context: Context = {
			messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
		};

		mockedChunks = [
			{
				choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 5,
					completion_tokens: 7,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const s = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			reasoningEffort: "high",
		});
		await s.result();

		expect(capturedParams).not.toBeNull();
		const params = capturedParams as Record<string, unknown>;
		expect(params.reasoning_effort).toBe("high");
		expect(params.chat_template_args).toBeUndefined();
	});
});
