import { beforeEach, describe, expect, it, vi } from "vitest";
import { complete } from "../src/stream.ts";
import type { Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks) yield chunk;
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

const TOOL_CALL_ID = "call_test_abc123";
const ENCRYPTED_SIG = "AY89a18_test_encrypted_signature_data==";

function geminiModel(): Model<"openai-completions"> {
	return {
		id: "google/gemini-3-flash-preview",
		name: "Gemini 3 Flash",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 16384,
	};
}

const toolCallChunk = {
	id: "gen-1",
	choices: [
		{
			index: 0,
			delta: {
				tool_calls: [
					{
						index: 0,
						id: TOOL_CALL_ID,
						type: "function",
						function: { name: "calculator", arguments: '{"expr":"2+2"}' },
					},
				],
			},
		},
	],
};

const reasoningDetailsChunk = {
	id: "gen-1",
	choices: [
		{
			index: 0,
			delta: {
				reasoning_details: [
					{ type: "reasoning.encrypted", id: TOOL_CALL_ID, data: ENCRYPTED_SIG, format: "google-gemini-v1" },
				],
			},
		},
	],
};

const finishChunk = {
	id: "gen-1",
	choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
	usage: { prompt_tokens: 10, completion_tokens: 5 },
};

describe("openai-completions reasoning_details ordering", () => {
	beforeEach(() => {
		mockState.chunks = [];
	});

	it("captures reasoning_details streamed AFTER tool_calls", async () => {
		mockState.chunks = [toolCallChunk, reasoningDetailsChunk, finishChunk];

		const message = await complete(
			geminiModel(),
			{ messages: [{ role: "user", content: "compute 2+2", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const toolCall = message.content.find((b) => b.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall!.thoughtSignature).toBeDefined();
		expect(JSON.parse(toolCall!.thoughtSignature!).data).toBe(ENCRYPTED_SIG);
	});

	it("captures reasoning_details streamed BEFORE tool_calls", async () => {
		mockState.chunks = [reasoningDetailsChunk, toolCallChunk, finishChunk];

		const message = await complete(
			geminiModel(),
			{ messages: [{ role: "user", content: "compute 2+2", timestamp: Date.now() }] },
			{ apiKey: "test" },
		);

		const toolCall = message.content.find((b) => b.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall!.thoughtSignature).toBeDefined();
		expect(JSON.parse(toolCall!.thoughtSignature!).data).toBe(ENCRYPTED_SIG);
	});
});
