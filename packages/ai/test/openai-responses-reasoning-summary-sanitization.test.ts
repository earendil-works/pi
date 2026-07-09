import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createOutput(model: Model<"openai-responses">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* createReasoningSummaryEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 0,
		item: { type: "reasoning", id: "rs_test", summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_text.delta",
		sequence_number: 2,
		output_index: 0,
		delta: "**Planning CI test suite optimization**\n\n<!-- -->",
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_part.done",
		sequence_number: 3,
		output_index: 0,
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_summary_text.delta",
		sequence_number: 4,
		output_index: 0,
		delta: "**Evaluating test duration reduction strategies**\n\n<!-- -->",
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 5,
		output_index: 0,
		item: {
			type: "reasoning",
			id: "rs_test",
			summary: [
				{ type: "summary_text", text: "**Planning CI test suite optimization**\n\n<!-- -->" },
				{ type: "summary_text", text: "**Evaluating test duration reduction strategies**\n\n<!-- -->" },
			],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 5,
		response: { id: "resp_test", status: "completed" },
	} as ResponseStreamEvent;
}

describe("openai responses reasoning summary sanitization", () => {
	it("removes provider-inserted HTML comment separators from visible thinking", async () => {
		const model: Model<"openai-responses"> = {
			id: "gpt-5-mini",
			name: "GPT-5 Mini",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400000,
			maxTokens: 128000,
		};
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const pushSpy = vi.spyOn(stream, "push");

		await processResponsesStream(createReasoningSummaryEvents(), output, stream, model);

		expect(output.content).toHaveLength(1);
		const thinkingBlock = output.content[0];
		expect(thinkingBlock?.type).toBe("thinking");
		if (!thinkingBlock || thinkingBlock.type !== "thinking") {
			throw new Error("Expected thinking block");
		}
		expect(thinkingBlock.thinking).toBe(
			"**Planning CI test suite optimization**\n\n**Evaluating test duration reduction strategies**",
		);
		expect(thinkingBlock.thinking).not.toContain("<!-- -->");
		expect(thinkingBlock.thinkingSignature).toContain("<!-- -->");

		const emittedEvents = pushSpy.mock.calls.map(([event]) => event as AssistantMessageEvent);
		const thinkingEvents = emittedEvents.filter(
			(event) => event.type === "thinking_delta" || event.type === "thinking_end",
		);
		expect(thinkingEvents.length).toBeGreaterThan(0);
		for (const event of thinkingEvents) {
			if (event.type === "thinking_delta") {
				expect(event.delta).not.toContain("<!-- -->");
			} else {
				expect(event.content).not.toContain("<!-- -->");
			}
		}
	});
});
