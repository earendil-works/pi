// @ts-nocheck
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

import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

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
		messages: [{ role: "user", content: "Call tool", timestamp: Date.now() }],
	};
}

describe("openai-responses non-function tool call parsing", () => {
	it("parses custom_tool_call with noisy envelope text into toolCall", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: {
					type: "custom_tool_call",
					id: "ct_1",
					call_id: "call_custom_1",
					name: "functions.exec_command",
					input: 'I’ll summarize all results.numerusformassistant to=functions.exec_command մեկնաբանություն json {"cmd":"pwd"}',
					status: "in_progress",
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "custom_tool_call",
					id: "ct_1",
					call_id: "call_custom_1",
					name: "functions.exec_command",
					input: 'I’ll summarize all results.numerusformassistant to=functions.exec_command մեկնաբանություն json {"cmd":"pwd"}',
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const eventTypes: string[] = [];
		for await (const ev of stream) {
			eventTypes.push(ev.type);
		}
		const message = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(message.stopReason).toBe("toolUse");

		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("exec_command");
			expect(toolCall.arguments).toEqual({ cmd: "pwd" });
		}
	});

	it("parses local_shell_call into exec_command-style toolCall", async () => {
		nextStreamEvents = [
			{
				type: "response.output_item.added",
				item: {
					type: "local_shell_call",
					id: "ls_1",
					call_id: "call_shell_1",
					action: { type: "exec", command: ["pwd"] },
					status: "in_progress",
				},
			},
			{
				type: "response.output_item.done",
				item: {
					type: "local_shell_call",
					id: "ls_1",
					call_id: "call_shell_1",
					action: { type: "exec", command: ["pwd"] },
					status: "completed",
				},
			},
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		const eventTypes: string[] = [];
		for await (const ev of stream) {
			eventTypes.push(ev.type);
		}
		const message = await stream.result();

		expect(eventTypes).toContain("toolcall_start");
		expect(eventTypes).toContain("toolcall_end");
		expect(message.stopReason).toBe("toolUse");

		const toolCall = message.content.find((block) => block.type === "toolCall");
		expect(toolCall).toBeDefined();
		expect(toolCall?.type).toBe("toolCall");
		if (toolCall?.type === "toolCall") {
			expect(toolCall.name).toBe("exec_command");
			expect(toolCall.arguments).toEqual({ cmd: "pwd" });
		}
	});
});
