import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	requestOptions: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_params: unknown, options: unknown) => {
					mockState.requestOptions.push(options);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: { content: "ok" } }],
							};
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
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

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

async function consume(options?: { maxRetries?: number }) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions provider retries", () => {
	beforeEach(() => {
		mockState.requestOptions = [];
	});

	it("disables SDK retries by default", async () => {
		await consume();
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("honors explicit provider retry settings", async () => {
		await consume({ maxRetries: 2 });
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 2 })]);
	});
});
