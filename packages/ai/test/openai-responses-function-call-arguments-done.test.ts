import { afterEach, describe, expect, it, vi } from "vitest";

let nextStreamEvents: unknown[] = [];

vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (_params: unknown) => {
					async function* gen(): AsyncGenerator<unknown> {
						for (const ev of nextStreamEvents) yield ev;
					}
					return gen();
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model } from "../src/types.js";

afterEach(() => {
	nextStreamEvents = [];
	vi.restoreAllMocks();
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "Call a tool", timestamp: Date.now() }],
	};
}

describe("openai-responses function_call_arguments.done", () => {
	it("uses response.function_call_arguments.done to populate tool arguments", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "example_tool",
					arguments: "",
					status: "in_progress",
				},
			},
			{
				type: "response.function_call_arguments.done",
				arguments: '{"path":"README.md","mode":"fast"}',
				item_id: "fc_1",
				output_index: 0,
				sequence_number: 2,
			},
			{
				type: "response.output_item.done",
				item: {
					type: "function_call",
					id: "fc_1",
					call_id: "call_1",
					name: "example_tool",
					arguments: "",
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const message = await stream.result();

		expect(message.stopReason).toBe("toolUse");
		const toolCalls = message.content.filter((c) => c.type === "toolCall");
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0]?.arguments).toEqual({ path: "README.md", mode: "fast" });
	});
});
