import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import type { Context } from "../src/types.js";

const state = vi.hoisted(() => ({
	createCalls: [] as Array<Record<string, unknown>>,
	streamCalled: false,
}));

vi.mock("@anthropic-ai/sdk", () => {
	const failingStream = {
		async *[Symbol.asyncIterator]() {
			yield {
				type: "message_start",
				message: {
					id: "msg_stream",
					usage: {
						input_tokens: 8,
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
					type: "text",
					text: "",
				},
			};
			yield {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "text_delta",
					text: "partial",
				},
			};
			throw new Error("stream dropped");
		},
	};

	const nonStreamingResponse = {
		id: "msg_fallback",
		content: [
			{
				type: "text",
				text: "Recovered in non-streaming mode",
			},
		],
		stop_reason: "end_turn",
		usage: {
			input_tokens: 8,
			output_tokens: 6,
			cache_read_input_tokens: 0,
			cache_creation_input_tokens: 0,
		},
	};

	class FakeAnthropic {
		messages = {
			create: async (params: Record<string, unknown>) => {
				state.createCalls.push(params);
				if (params.stream === true) {
					return failingStream;
				}
				return nonStreamingResponse;
			},
			stream: (_params: Record<string, unknown>) => {
				state.streamCalled = true;
				throw new Error("messages.stream should not be called");
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("anthropic streaming fallback", () => {
	it("retries in non-streaming mode when raw streaming fails mid-turn", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const { streamAnthropic } = await import("../src/providers/anthropic.js");
		const s = streamAnthropic(model, context, { apiKey: "sk-ant-api03-test" });

		const eventTypes: string[] = [];
		for await (const event of s) {
			eventTypes.push(event.type);
		}

		const result = await s.result();

		expect(state.streamCalled).toBe(false);
		expect(state.createCalls).toHaveLength(2);
		expect(state.createCalls[0]?.stream).toBe(true);
		expect(state.createCalls[1]?.stream).toBe(false);

		expect(eventTypes).toContain("start");
		expect(eventTypes).toContain("done");
		expect(eventTypes).not.toContain("error");

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Recovered in non-streaming mode",
			},
		]);
	});
});
