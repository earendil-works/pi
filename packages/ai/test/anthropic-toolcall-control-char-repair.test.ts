import { describe, expect, it, vi } from "vitest";
import type { AssistantMessageEvent, Context, Model } from "../src/types.js";

vi.mock("@anthropic-ai/sdk", () => {
	class MockAnthropic {
		public messages: {
			stream: (_params: unknown, _opts?: unknown) => AsyncIterable<unknown>;
		};

		constructor(_opts: unknown) {
			this.messages = {
				stream: () => {
					async function* gen(): AsyncGenerator<unknown> {
						yield {
							type: "message_start",
							message: {
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
								name: "bash",
								input: {},
							},
						};

						yield {
							type: "content_block_delta",
							index: 0,
							delta: {
								type: "input_json_delta",
								partial_json: '{"command":"git commit -m \\"subject',
							},
						};

						yield {
							type: "content_block_delta",
							index: 0,
							delta: {
								type: "input_json_delta",
								partial_json: '\n\nbody\\" -- devdocs/runbooks/deploy-staging.md"}',
							},
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
								output_tokens: 15,
								cache_read_input_tokens: 0,
								cache_creation_input_tokens: 0,
							},
						};
					}

					return gen();
				},
			};
		}
	}

	return { default: MockAnthropic };
});

import { streamAnthropic } from "../src/providers/anthropic.js";

function getToolCallEndEvent(
	events: AssistantMessageEvent[],
): Extract<AssistantMessageEvent, { type: "toolcall_end" }> | undefined {
	return events.find((event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => {
		return event.type === "toolcall_end";
	});
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "hf:nvidia/Kimi-K2.5-NVFP4",
		name: "Kimi K2.5 NVFP4",
		api: "anthropic-messages",
		provider: "synthetic",
		baseUrl: "https://api.synthetic.new/anthropic",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
	};
}

function createContext(): Context {
	return {
		messages: [{ role: "user", content: "commit this", timestamp: Date.now() }],
	};
}

describe("anthropic toolcall argument repair", () => {
	it("recovers bash.command when input_json_delta contains raw newlines in the JSON string literal", async () => {
		const stream = streamAnthropic(createModel(), createContext(), { apiKey: "test-key" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) {
			events.push(event);
		}
		const result = await stream.result();
		const toolCallEnd = getToolCallEndEvent(events);

		expect(result.stopReason).toBe("toolUse");
		expect(toolCallEnd).toBeDefined();
		expect(toolCallEnd?.toolCall.name).toBe("bash");
		expect(toolCallEnd?.toolCall.arguments).toEqual({
			command: 'git commit -m "subject\n\nbody" -- devdocs/runbooks/deploy-staging.md',
		});
	});
});
