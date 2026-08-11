import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

type Scenario = "normal" | "stall" | "done-hold" | "slow" | "delayed-first";

const mockState = vi.hoisted(() => ({
	scenario: "normal" as Scenario,
	requestOptions: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_params: unknown, options: unknown) => {
					mockState.requestOptions.push(options);
					const signal = (options as { signal?: AbortSignal }).signal;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const stall = (): Promise<void> =>
								new Promise((resolve) => {
									signal?.addEventListener("abort", () => resolve());
								});
							switch (mockState.scenario) {
								case "stall":
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "hello" } }] };
									await stall();
									throw new Error("request aborted");
								case "done-hold":
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "hello" } }] };
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
									await stall();
									throw new Error("request aborted");
								case "slow":
									for (let i = 0; i < 5; i++) {
										await new Promise<void>((resolve) => setTimeout(resolve, 30));
										yield { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "x" } }] };
									}
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
									return;
								case "delayed-first":
									await new Promise<void>((resolve) => setTimeout(resolve, 500));
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "hi" } }] };
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
									return;
								default:
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "ok" } }] };
									yield { id: "chatcmpl-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
							}
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

async function consume(streamIdleTimeoutMs?: number) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}) });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions stream idle timeout", () => {
	beforeEach(() => {
		mockState.scenario = "normal";
		mockState.requestOptions = [];
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("aborts with a retryable timeout error when the stream stalls after content", async () => {
		mockState.scenario = "stall";
		const resultPromise = consume(100);
		await vi.advanceTimersByTimeAsync(100);
		const result = await resultPromise;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timeout");
		expect(result.errorMessage).toContain("100ms");
	});

	it("aborts even when finish_reason was delivered but the connection never closes", async () => {
		mockState.scenario = "done-hold";
		const resultPromise = consume(100);
		await vi.advanceTimersByTimeAsync(100);
		const result = await resultPromise;
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("timeout");
	});

	it("keeps the stream alive while chunks arrive within the deadline", async () => {
		mockState.scenario = "slow";
		const resultPromise = consume(100);
		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(30);
		}
		const result = await resultPromise;
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("does not apply the deadline before the first chunk (TTFB covered by the SDK timeout)", async () => {
		mockState.scenario = "delayed-first";
		const resultPromise = consume(100);
		await vi.advanceTimersByTimeAsync(500);
		const result = await resultPromise;
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
	});

	it("leaves normal streams untouched and still passes the merged signal", async () => {
		const result = await consume();
		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(mockState.requestOptions[0]).toMatchObject({ maxRetries: 0 });
		expect((mockState.requestOptions[0] as { signal?: unknown }).signal).toBeDefined();
	});
});
