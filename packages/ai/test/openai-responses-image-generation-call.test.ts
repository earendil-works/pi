import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/providers/openai-responses-shared.js";
import type { AssistantMessage, Model } from "../src/types.js";
import { AssistantMessageEventStream } from "../src/utils/event-stream.js";

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

async function* createImageGenerationEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.done",
		item: {
			type: "image_generation_call",
			id: "ig_123",
			status: "completed",
			revised_prompt: "A tiny blue square",
			result: "Zm9v",
		},
	} as unknown as ResponseStreamEvent;
}

describe("openai responses image generation calls", () => {
	it("maps image_generation_call to assistant image content", async () => {
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

		await processResponsesStream(createImageGenerationEvents(), output, stream, model);

		expect(output.content).toEqual([
			{ type: "image", mimeType: "image/png", data: "Zm9v" },
			{ type: "text", text: "A tiny blue square" },
		]);
	});
});
