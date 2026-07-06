import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";

interface CapturedParams {
	stream?: boolean | null;
	stream_options?: unknown;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedParams | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedParams) => {
					mockState.lastParams = params;
					const completion = {
						id: "chatcmpl-test",
						object: "chat.completion",
						created: 1,
						model: "glm-5.2",
						choices: [
							{
								index: 0,
								logprobs: null,
								finish_reason: "tool_calls",
								message: {
									role: "assistant",
									content: null,
									reasoning_content: "thinking about graph stats",
									refusal: null,
									tool_calls: [
										{
											id: "call_1",
											type: "function",
											function: { name: "graph_stats", arguments: '{"depth":1}' },
										},
									],
								},
							},
						],
						usage: {
							prompt_tokens: 10,
							completion_tokens: 5,
							prompt_tokens_details: { cached_tokens: 0 },
							completion_tokens_details: { reasoning_tokens: 2 },
						},
					};
					const promise = Promise.resolve(completion) as Promise<typeof completion> & {
						withResponse: () => Promise<{
							data: typeof completion;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: completion,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

describe("openai-completions disableToolStreaming", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("detects routed OpenCode Go GLM-5.2 and preserves tool calls", async () => {
		const model: Model<"openai-completions"> = {
			id: "opencode-go/glm-5.2",
			name: "GLM-5.2",
			api: "openai-completions",
			provider: "openai-compatible-proxy",
			baseUrl: "https://proxy.example/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			compat: { maxTokensField: "max_tokens" },
		};

		const message = await streamOpenAICompletions(
			model,
			{
				messages: [{ role: "user", content: "check graph stats", timestamp: Date.now() }],
				tools: [
					{
						name: "graph_stats",
						description: "Get graph stats",
						parameters: Type.Object({ depth: Type.Number() }),
					},
				],
			},
			{ apiKey: "test-key" },
		).result();

		expect(mockState.lastParams?.stream).toBe(false);
		expect(mockState.lastParams?.stream_options).toBeUndefined();
		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{
				type: "thinking",
				thinking: "thinking about graph stats",
				thinkingSignature: "reasoning_content",
			},
			{ type: "toolCall", id: "call_1", name: "graph_stats", arguments: { depth: 1 } },
		]);
		expect(message.usage.output).toBe(5);
	});
});
