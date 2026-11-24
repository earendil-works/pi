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

	// #12407
	it("retries a stop that OpenRouter reports with native_finish_reason MALFORMED_RESPONSE", async () => {
		mockState.chunks = [
			{
				id: "gen-1",
				choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "MALFORMED_RESPONSE" }],
			},
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("stop.MALFORMED_RESPONSE");
		expect(message.errorMessage).toBe("Provider native_finish_reason: MALFORMED_RESPONSE");
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	// #12407
	it("surfaces content-safety native finish reasons as errors without retrying", async () => {
		mockState.chunks = [
			{ id: "gen-2", choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "SAFETY" }] },
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider native_finish_reason: SAFETY");
		expect(isRetryableAssistantError(message)).toBe(false);
	});

	// #12407
	it("keeps finish_reason for normal and unknown native finish reasons", async () => {
		mockState.chunks = [
			{
				id: "gen-3",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{}" } }] },
						finish_reason: null,
					},
				],
			},
			// Gemini reports STOP for tool calls; OpenRouter's finish_reason carries the tool call.
			{ id: "gen-3", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls", native_finish_reason: "STOP" }] },
		];
		const toolMessage = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();
		expect(toolMessage.stopReason).toBe("toolUse");
		expect(toolMessage.rawStopReason).toBe("tool_calls.STOP");

		mockState.chunks = [
			{ id: "gen-4", choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "eos" }] },
		];
		const unknownMessage = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();
		expect(unknownMessage.stopReason).toBe("stop");
		expect(unknownMessage.rawStopReason).toBe("stop.eos");
		expect(unknownMessage.errorMessage).toBeUndefined();
	});

	// #12407
	it("keeps the native failure when a trailing chunk repeats finish_reason without it", async () => {
		mockState.chunks = [
			{
				id: "gen-5",
				choices: [{ index: 0, delta: {}, finish_reason: "stop", native_finish_reason: "MALFORMED_RESPONSE" }],
			},
			{ id: "gen-5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Provider native_finish_reason: MALFORMED_RESPONSE");
	});

	// #11931
	it("adds the native reason to an error finish_reason and keeps it retryable", async () => {
		mockState.chunks = [
			{
				id: "gen-6",
				choices: [{ index: 0, delta: {}, finish_reason: "error", native_finish_reason: "OTHER" }],
			},
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.rawStopReason).toBe("error.OTHER");
		expect(message.errorMessage).toBe("Provider finish_reason: error (native_finish_reason: OTHER)");
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	// #11931
	it("keeps the native reason when a trailing chunk repeats finish_reason without it", async () => {
		mockState.chunks = [
			{
				id: "gen-7",
				choices: [{ index: 0, delta: {}, finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }],
			},
			{ id: "gen-7", choices: [{ index: 0, delta: {}, finish_reason: "error" }] },
		];

		const message = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();

		expect(message.rawStopReason).toBe("error.MALFORMED_FUNCTION_CALL");
		expect(message.errorMessage).toBe(
			"Provider finish_reason: error (native_finish_reason: MALFORMED_FUNCTION_CALL)",
		);
	});
});
