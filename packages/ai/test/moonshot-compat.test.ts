import { describe, expect, it, vi } from "vitest";

// Captured request params passed to OpenAI client's chat.completions.create()
let capturedParams: unknown = null;

// Mock the OpenAI SDK used by openai-completions provider.
// We only need enough surface area to capture params and return a minimal async iterable stream.
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
							// Minimal single-chunk streaming response
							yield {
								choices: [{ delta: { content: "ok" } }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
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

import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

describe("moonshot (kimi-k2.5) OpenAI-compat", () => {
	it("uses max_tokens, avoids stream_options + reasoning_effort, and sends thinking back via reasoning_content", async () => {
		capturedParams = null;

		const moonshotModel: Model<"openai-completions"> = {
			id: "kimi-k2.5",
			name: "Kimi K2.5 (Moonshot)",
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			reasoning: true,
			reasoningFormat: "reasoning_content",
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 32768,
			extraBody: {
				thinking: { type: "enabled" },
				temperature: 1.0,
				top_p: 0.95,
				n: 1,
				presence_penalty: 0.0,
				frequency_penalty: 0.0,
			},
		};

		const priorAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "moonshot",
			model: "kimi-k2.5",
			content: [
				{ type: "thinking", thinking: "trace-1", thinkingSignature: "reasoning_content" },
				{ type: "text", text: "hello" },
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const context: Context = {
			systemPrompt: "You are Kimi.",
			messages: [priorAssistant, { role: "user", content: "ping", timestamp: Date.now() }],
		};

		const s = streamOpenAICompletions(moonshotModel, context, {
			apiKey: "test-key",
			maxTokens: 123,
			reasoningEffort: "high",
		});
		await s.result();

		expect(capturedParams).not.toBeNull();
		const params = capturedParams as Record<string, unknown>;

		// Moonshot uses OpenAI-compatible API but expects max_tokens (not max_completion_tokens)
		expect(params.max_tokens).toBe(123);
		expect(params.max_completion_tokens).toBeUndefined();

		// Keep Moonshot requests conservative
		expect(params.stream_options).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();

		// Ensure our model-level Moonshot params are forwarded
		expect(params.thinking).toEqual({ type: "enabled" });

		// Ensure prior thinking is sent back via reasoning_content (not embedded <think> text)
		const messages = params.messages as unknown;
		expect(Array.isArray(messages)).toBe(true);

		const assistantMsg = (messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant");
		expect(assistantMsg).toBeTruthy();
		expect(assistantMsg?.reasoning_content).toBe("trace-1");
	});
});
