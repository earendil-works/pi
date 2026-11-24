import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

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

const context = normalizeContext({
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

describe("OpenAI completions raw stop reasons", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("preserves raw finish reasons for successful stops", async () => {
		mockState.chunks = [{ id: "chatcmpl-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
	});

	it("preserves raw finish reasons for provider error stops", async () => {
		mockState.chunks = [{ id: "chatcmpl-2", choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("content_filter");
		expect(message.errorMessage).toBe("Provider finish_reason: content_filter");
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	// #12206
	it("retries a stream that ends with finish_reason error", async () => {
		mockState.chunks = [{ id: "chatcmpl-3", choices: [{ index: 0, delta: {}, finish_reason: "error" }] }];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider finish_reason: error");
		expect(isRetryableAssistantError(message)).toBe(true);
	});
});

// #12407, #11931
describe("OpenRouter native_finish_reason", () => {
	const openRouterModel: Model<"openai-completions"> = {
		...model,
		id: "google/gemini-4-neon",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
	};

	beforeEach(() => {
		mockState.chunks = [];
	});

	it("records a native reason hidden behind a successful finish_reason without changing the stop reason", async () => {
		mockState.chunks = [
			{
				id: "gen-1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "MALFORMED_RESPONSE" }],
			},
		];

		const message = await streamOpenAICompletions(openRouterModel, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.rawStopReason).toBe("stop.MALFORMED_RESPONSE");
		expect(message.errorMessage).toBeUndefined();
	});

	it("records the native reason of a tool call", async () => {
		mockState.chunks = [
			{
				id: "gen-2",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{}" } }] },
						finish_reason: null,
					},
				],
			},
			// Gemini reports STOP for tool calls; OpenRouter's finish_reason carries the tool call.
			{ id: "gen-2", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", native_finish_reason: "STOP" }] },
		];

		const message = await streamOpenAICompletions(openRouterModel, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.rawStopReason).toBe("tool_calls.STOP");
	});

	it("adds the native reason to an error message and keeps it retryable", async () => {
		mockState.chunks = [
			{
				id: "gen-3",
				choices: [{ index: 0, delta: {}, finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }],
			},
		];

		const message = await streamOpenAICompletions(openRouterModel, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("error.MALFORMED_FUNCTION_CALL");
		expect(message.errorMessage).toBe(
			"Provider finish_reason: error (native_finish_reason: MALFORMED_FUNCTION_CALL)",
		);
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it("keeps the native reason when a trailing chunk repeats finish_reason without it", async () => {
		mockState.chunks = [
			{
				id: "gen-4",
				choices: [{ index: 0, delta: {}, finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }],
			},
			{ id: "gen-4", choices: [{ index: 0, delta: {}, finish_reason: "error" }] },
		];

		const message = await streamOpenAICompletions(openRouterModel, context, { apiKey: "test" }).result();

		expect(message.rawStopReason).toBe("error.MALFORMED_FUNCTION_CALL");
		expect(message.errorMessage).toBe(
			"Provider finish_reason: error (native_finish_reason: MALFORMED_FUNCTION_CALL)",
		);
	});

	it("does not repeat a native reason equal to finish_reason", async () => {
		mockState.chunks = [
			{ id: "gen-5", choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "stop" }] },
		];

		const message = await streamOpenAICompletions(openRouterModel, context, { apiKey: "test" }).result();

		expect(message.rawStopReason).toBe("stop");
	});

	it("ignores native_finish_reason from providers other than OpenRouter", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-6",
				choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "MALFORMED_RESPONSE" }],
			},
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.rawStopReason).toBe("stop");
	});
});
