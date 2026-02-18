// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";

let nextStreamEvents: unknown[] = [];
let capturedParams: unknown;

vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (params: unknown) => {
					capturedParams = params;
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
import type { AssistantMessage, Context, Model, ToolResultMessage } from "../src/types.ts";

afterEach(() => {
	nextStreamEvents = [];
	capturedParams = undefined;
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

function baseUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("openai-responses history sanitization", () => {
	it("does not replay aborted assistant/tool-result turns into request input", async () => {
		const abortedAssistant: AssistantMessage = {
			role: "assistant",
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5-mini",
			usage: baseUsage(),
			stopReason: "aborted",
			timestamp: Date.now(),
			content: [
				{ type: "text", text: "SHOULD_NOT_REPLAY" },
				{
					type: "toolCall",
					id: "aborted_call|fc_aborted",
					name: "exec_command",
					arguments: { cmd: "pwd" },
				},
			],
		};

		const abortedToolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "aborted_call|fc_aborted",
			toolName: "exec_command",
			content: [{ type: "text", text: "SHOULD_NOT_REPLAY_TOOL_RESULT" }],
			isError: false,
			timestamp: Date.now(),
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "First question", timestamp: Date.now() },
				abortedAssistant,
				abortedToolResult,
				{ role: "user", content: "Continue now", timestamp: Date.now() },
			],
		};

		nextStreamEvents = [
			{
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
				},
			},
		];

		const stream = streamOpenAIResponses(createModel(), context, { apiKey: "test-key" });
		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		const input = (capturedParams as { input?: unknown[] } | undefined)?.input ?? [];
		const serialized = JSON.stringify(input);

		expect(serialized).not.toContain("SHOULD_NOT_REPLAY");
		expect(serialized).not.toContain("SHOULD_NOT_REPLAY_TOOL_RESULT");
		expect(serialized).not.toContain("aborted_call");
		expect(serialized).toContain("Continue now");
	});
});
