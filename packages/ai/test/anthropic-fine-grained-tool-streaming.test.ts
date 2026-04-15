import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import type { Context } from "../src/types.js";

const mockState = vi.hoisted(() => ({
	createCalled: false,
	streamCalled: false,
}));

vi.mock("@anthropic-ai/sdk", () => {
	const fakeStream = {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "message_start",
				message: {
					id: "msg_test",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			};
			yield {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "toolu_test",
					name: "edit",
					input: {},
				},
			};
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: '{"project_id": 3' },
			};
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: ', "ref": "HEAD"' },
			};
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: ', "path": ' },
			};
			yield {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: "}" },
			};
			yield {
				type: "content_block_stop",
				index: 0,
			};
			yield {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: {
					input_tokens: 12,
					output_tokens: 4,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			};
		},
	};

	class FakeAnthropic {
		messages = {
			create: async (_params: Record<string, unknown>) => {
				mockState.createCalled = true;
				return fakeStream;
			},
			stream: (_params: Record<string, unknown>) => {
				mockState.streamCalled = true;
				throw new Error("messages.stream should not be called");
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("anthropic fine-grained tool streaming", () => {
	it("falls back to empty arguments when streamed tool-input JSON is malformed", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "run edit", timestamp: Date.now() }],
		};

		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const result = await streamAnthropic(model, context, { apiKey: "sk-ant-api03-test" }).result();

		expect(mockState.createCalled).toBe(true);
		expect(mockState.streamCalled).toBe(false);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content).toHaveLength(1);

		const toolCall = result.content[0];
		expect(toolCall?.type).toBe("toolCall");
		if (!toolCall || toolCall.type !== "toolCall") {
			throw new Error("Expected toolCall block");
		}

		expect(toolCall.arguments).toEqual({});
		expect(toolCall.argumentsParseError).toBe("parse error");
		expect("partialJson" in toolCall).toBe(false);
	});
});
