import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

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

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

describe("openai-completions missing finish_reason tolerance", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("completes with stop and a warning when content arrives but finish_reason is absent", async () => {
		// Simulate a gateway that sends content chunks with finish_reason: null,
		// then only a metadata/usage chunk with choices: [] and no finish_reason.
		mockState.chunks = [
			{
				id: "chatcmpl-1",
				choices: [{ index: 0, delta: { content: "hello" }, finish_reason: null }],
			},
			{
				id: "chatcmpl-1",
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 1 },
			},
		];

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("stop");
		expect(warnSpy).toHaveBeenCalledOnce();
		expect(warnSpy.mock.calls[0][0]).toContain("finish_reason");
	});

	it("throws when the stream ends with zero chunks (real transport failure)", async () => {
		mockState.chunks = [];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Stream ended without finish_reason");
	});

	it("normal stream with finish_reason behaves unchanged", async () => {
		mockState.chunks = [
			{ id: "chatcmpl-2", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
			{ id: "chatcmpl-2", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("stop");
	});
});
