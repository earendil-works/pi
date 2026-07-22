import type { ResponseReasoningItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"azure-openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "azure-openai-responses",
		provider: "azure-openai-responses",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function createOutput(model: Model<"azure-openai-responses">): AssistantMessage {
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

async function* createEvents(
	doneItem: ResponseReasoningItem,
	completedItem: ResponseReasoningItem,
): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		output_index: 0,
		sequence_number: 0,
		item: { type: "reasoning", id: doneItem.id, summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		sequence_number: 1,
		item: doneItem,
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: {
			id: "resp_test",
			status: "completed",
			output: [completedItem],
		},
	} as ResponseStreamEvent;
}

function getReplayedReasoning(model: Model<"azure-openai-responses">, assistant: AssistantMessage) {
	const context: Context = {
		messages: [
			{ role: "user", content: "first", timestamp: Date.now() - 1 },
			assistant,
			{ role: "user", content: "follow-up", timestamp: Date.now() },
		],
	};
	const input = convertResponsesMessages(model, context, new Set(["azure-openai-responses"]));
	return input.find((item) => item.type === "reasoning");
}

describe("Azure OpenAI Responses reasoning replay", () => {
	it("preserves existing encrypted_content from output_item.done", async () => {
		const model = createModel();
		const output = createOutput(model);
		const doneItem: ResponseReasoningItem = {
			type: "reasoning",
			id: "rs_done",
			summary: [],
			encrypted_content: "from-output-item-done",
		};
		const completedItem: ResponseReasoningItem = {
			...doneItem,
			encrypted_content: "from-response-completed",
		};

		await processResponsesStream(
			createEvents(doneItem, completedItem),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(getReplayedReasoning(model, output)).toMatchObject({
			type: "reasoning",
			id: "rs_done",
			encrypted_content: "from-output-item-done",
		});
	});

	it("fills encrypted_content when output_item.done omitted it", async () => {
		const model = createModel();
		const output = createOutput(model);
		const doneItem: ResponseReasoningItem = {
			type: "reasoning",
			id: "rs_missing",
			summary: [],
		};
		const completedItem: ResponseReasoningItem = {
			...doneItem,
			encrypted_content: "from-response-completed",
		};

		await processResponsesStream(
			createEvents(doneItem, completedItem),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(getReplayedReasoning(model, output)).toMatchObject({
			type: "reasoning",
			id: "rs_missing",
			encrypted_content: "from-response-completed",
		});
	});
});
