import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunks: [] as Array<{
		id: string;
		choices: Array<{
			index: number;
			delta: Record<string, unknown>;
			finish_reason: string | null;
		}>;
	} | null>,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of mockState.chunks) {
								yield chunk;
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
	provider: "test-provider",
	baseUrl: "https://example.invalid",
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

beforeEach(() => {
	mockState.chunks = [];
});

describe("openai-completions malformed tool call handling", () => {
	it.each([
		{
			name: "id",
			toolCall: {
				index: 0,
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
			},
		},
		{
			name: "name",
			toolCall: {
				index: 0,
				id: "call_test",
				type: "function",
				function: { arguments: '{"path":"README.md"}' },
			},
		},
	])("fails when the provider emits a tool call without $name", async ({ name, toolCall }) => {
		mockState.chunks = [
			{
				id: "chatcmpl-test",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [toolCall],
						},
						finish_reason: "tool_calls",
					},
				],
			},
		];

		const stream = streamOpenAICompletions(model, context, { apiKey: "test" });
		let errorMessage: string | undefined;
		for await (const event of stream) {
			if (event.type === "error") {
				errorMessage = event.error.errorMessage;
			}
		}

		const expectedError = `Malformed tool call from provider: missing ${name}`;
		const result = await stream.result();
		expect(errorMessage).toBe(expectedError);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(expectedError);
		expect(result.content).toEqual([]);
	});
});
