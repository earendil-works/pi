import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		defaultHeaders: Record<string, string>;

		constructor(config: { defaultHeaders?: Record<string, string> }) {
			this.defaultHeaders = config.defaultHeaders ?? {};
		}

		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
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

describe("openai-completions alibaba cache control", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("should add cache_control to messages when cacheControlFormat is alibaba", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			api: "openai-completions",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			provider: "alibaba",
			compat: { cacheControlFormat: "alibaba" },
		} as const;

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "System prompt here", timestamp: Date.now() },
					{ role: "user", content: "Hello", timestamp: Date.now() },
				],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { messages: { role: string; content: unknown }[] };
		const lastMessage = params.messages[params.messages.length - 1];
		expect(Array.isArray(lastMessage.content)).toBe(true);
		const textPart = (lastMessage.content as any[]).find((p: any) => p.type === "text");
		expect(textPart.cache_control).toEqual({ type: "ephemeral" });
	});

	it("should not add cache_control when cacheControlFormat is anthropic", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			api: "openai-completions",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			compat: { cacheControlFormat: "anthropic" },
		} as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { messages: { role: string; content: unknown }[] };
		const lastMessage = params.messages[params.messages.length - 1];
		expect(typeof lastMessage.content).toBe("string");
	});

	it("should auto-detect alibaba provider from dashscope URL", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			api: "openai-completions",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		} as const;

		await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { messages: { role: string; content: unknown }[] };
		const lastMessage = params.messages[params.messages.length - 1];
		expect(Array.isArray(lastMessage.content)).toBe(true);
		const textPart = (lastMessage.content as any[]).find((p: any) => p.type === "text");
		expect(textPart.cache_control).toEqual({ type: "ephemeral" });
	});

	it("should add cache_control to existing content array", async () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini")!;
		const model = {
			...baseModel,
			api: "openai-completions",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			provider: "alibaba",
			compat: { cacheControlFormat: "alibaba" },
		} as const;

		await streamSimple(
			model,
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text" as const, text: "Hello" },
							{
								type: "image" as const,
								data: "abc",
								mimeType: "image/png",
							},
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: "test" },
		).result();

		const params = mockState.lastParams as { messages: { role: string; content: unknown }[] };
		const lastMessage = params.messages[params.messages.length - 1];
		expect(Array.isArray(lastMessage.content)).toBe(true);
		const textPart = (lastMessage.content as any[]).find((p: any) => p.type === "text");
		expect(textPart.cache_control).toEqual({ type: "ephemeral" });
	});
});
