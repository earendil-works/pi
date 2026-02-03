import { describe, expect, it, vi } from "vitest";

let capturedAnthropicParams: unknown = null;

let capturedOpenAIParams: unknown = null;

vi.mock("@anthropic-ai/sdk", () => {
	class MockAnthropic {
		public messages: {
			stream: (params: unknown, _opts?: unknown) => AsyncIterable<unknown>;
		};

		constructor(_opts: unknown) {
			this.messages = {
				stream: (params: unknown) => {
					capturedAnthropicParams = params;

					async function* gen(): AsyncGenerator<unknown> {
						yield {
							type: "message_start",
							message: {
								usage: {
									input_tokens: 0,
									output_tokens: 0,
									cache_read_input_tokens: 0,
									cache_creation_input_tokens: 0,
								},
							},
						};
						yield {
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: {
								input_tokens: 0,
								output_tokens: 0,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						};
					}

					return gen();
				},
			};
		}
	}

	return { default: MockAnthropic };
});

vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (params: unknown) => {
					capturedOpenAIParams = params;
					async function* gen(): AsyncGenerator<unknown> {
						yield {
							type: "response.completed",
							response: {
								status: "completed",
								usage: {
									input_tokens: 0,
									output_tokens: 0,
									input_tokens_details: { cached_tokens: 0 },
								},
							},
						};
					}
					return gen();
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamAnthropic } from "../src/providers/anthropic.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";

function getCapturedAnthropicMessages(): Array<{ role: string; content: unknown }> {
	expect(capturedAnthropicParams).not.toBeNull();
	const params = capturedAnthropicParams as Record<string, unknown>;
	const messages = params.messages;
	expect(Array.isArray(messages)).toBe(true);
	return messages as Array<{ role: string; content: unknown }>;
}

describe("cross-provider thinking conversion (anthropic-messages)", () => {
	it("sends signature-less thinking blocks to non-official anthopic-messages endpoints", async () => {
		capturedAnthropicParams = null;

		const thirdPartyModel: Model<"anthropic-messages"> = {
			id: "hf:deepseek-ai/DeepSeek-V3.2",
			name: "Third-party Anthropic-compatible model",
			api: "anthropic-messages",
			provider: "third-party",
			baseUrl: "https://api.synthetic.new/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};

		const priorAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			content: [
				{ type: "thinking", thinking: "trace-1", thinkingSignature: "openai-reasoning-item" },
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
			messages: [priorAssistant, { role: "user", content: "ping", timestamp: Date.now() }],
		};

		const s = streamAnthropic(thirdPartyModel, context, { apiKey: "test-key" });
		await s.result();

		const messages = getCapturedAnthropicMessages();
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeTruthy();
		expect(Array.isArray(assistant?.content)).toBe(true);

		const blocks = assistant?.content as Array<Record<string, unknown>>;
		const thinking = blocks.find((b) => b.type === "thinking");
		expect(thinking).toBeTruthy();
		expect(thinking?.thinking).toBe("trace-1");
		// Synthetic docs: thinking object does not require a signature.
		expect("signature" in (thinking as Record<string, unknown>)).toBe(false);
	});

	it("falls back to tagged text when signature is missing for official Anthropic", async () => {
		capturedAnthropicParams = null;

		const anthropicModel: Model<"anthropic-messages"> = {
			id: "claude-test",
			name: "Claude Test",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};

		const priorAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-test",
			content: [{ type: "thinking", thinking: "trace-1", thinkingSignature: "openai-reasoning-item" }],
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
			messages: [priorAssistant, { role: "user", content: "ping", timestamp: Date.now() }],
		};

		const s = streamAnthropic(anthropicModel, context, { apiKey: "test-key" });
		await s.result();

		const messages = getCapturedAnthropicMessages();
		const assistant = messages.find((m) => m.role === "assistant");
		expect(assistant).toBeTruthy();
		expect(Array.isArray(assistant?.content)).toBe(true);

		const blocks = assistant?.content as Array<Record<string, unknown>>;
		const thinkingAsText = blocks.find((b) => b.type === "text");
		expect(thinkingAsText).toBeTruthy();
		expect(thinkingAsText?.text).toContain("trace-1");
		expect(thinkingAsText?.text).not.toContain("<thinking>");
	});
});

describe("cross-provider thinking conversion (openai-responses)", () => {
	function getCapturedOpenAIInput(): unknown[] {
		expect(capturedOpenAIParams).not.toBeNull();
		const params = capturedOpenAIParams as Record<string, unknown>;
		const input = params.input;
		expect(Array.isArray(input)).toBe(true);
		return input as unknown[];
	}

	it("preserves signature-less thinking blocks by sending them as a reasoning item", async () => {
		capturedOpenAIParams = null;

		const openaiModel: Model<"openai-responses"> = {
			id: "gpt-test",
			name: "GPT Test",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		};

		const priorAssistant: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			content: [{ type: "thinking", thinking: "trace-1", thinkingSignature: "anthropic-signature" }],
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
			messages: [priorAssistant, { role: "user", content: "ping", timestamp: Date.now() }],
		};

		const s = streamOpenAIResponses(openaiModel, context, { apiKey: "test-key" });
		await s.result();

		const input = getCapturedOpenAIInput();
		const reasoningItems = input.filter((item) => {
			if (typeof item !== "object" || item === null) return false;
			const r = item as Record<string, unknown>;
			return r.type === "reasoning";
		});
		expect(reasoningItems.length).toBeGreaterThan(0);

		const hasThinkingContent = reasoningItems.some((item) => {
			const r = item as Record<string, unknown>;
			const content = r.content;
			if (!Array.isArray(content)) return false;
			return content.some((part) => {
				if (typeof part !== "object" || part === null) return false;
				const p = part as Record<string, unknown>;
				return p.type === "reasoning_text" && typeof p.text === "string" && p.text.includes("trace-1");
			});
		});

		expect(hasThinkingContent).toBe(true);
	});
});
