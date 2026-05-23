import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [
									{
										delta: { reasoning_content: "thinking", content: "answer" },
										finish_reason: "stop",
									},
								],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 1 },
								},
							};
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

describe("dashscope qwen3.7-max thinking", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends enable_thinking, preserve_thinking, and thinking_budget for reasoning requests", async () => {
		const model = getModel("dashscope", "qwen3.7-max");
		expect(model).toBeDefined();

		await streamSimple(
			model!,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", reasoning: "high" },
		).result();

		const params = mockState.lastParams as {
			enable_thinking?: boolean;
			preserve_thinking?: boolean;
			thinking_budget?: number;
			tools?: unknown;
		};
		expect(params.enable_thinking).toBe(true);
		expect(params.preserve_thinking).toBe(true);
		expect(params.thinking_budget).toBe(131072);
		expect("tools" in (params as object)).toBe(false);
	});

	it("omits thinking flags when reasoning is off", async () => {
		const model = getModel("dashscope", "qwen3.7-max")!;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test", reasoning: "off" },
		).result();

		const params = mockState.lastParams as {
			enable_thinking?: boolean;
			preserve_thinking?: boolean;
			thinking_budget?: number;
		};
		expect(params.enable_thinking).toBe(false);
		expect(params.preserve_thinking).toBeUndefined();
		expect(params.thinking_budget).toBeUndefined();
	});

	it("omits tools field when conversation has tool history but no active tools", async () => {
		const model = getModel("dashscope", "qwen3.7-max")!;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "use the tool", timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{
								type: "toolCall",
								id: "t1",
								name: "noop",
								arguments: {},
							},
						],
						stopReason: "toolUse",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						api: "openai-completions",
						provider: "dashscope",
						model: "qwen3.7-max",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "noop",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [],
			},
			{ apiKey: "test", reasoning: "high" },
		).result();

		const params = mockState.lastParams as { tools?: unknown[] };
		expect("tools" in (params as object)).toBe(false);
	});
});
