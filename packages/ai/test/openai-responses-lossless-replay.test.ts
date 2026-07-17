import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};
}

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

class RecordingStream extends AssistantMessageEventStream {
	readonly events: AssistantMessageEvent[] = [];

	override push(event: AssistantMessageEvent): void {
		this.events.push(event);
		super.push(event);
	}
}

async function* completedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_test",
			status: "completed",
			output: [],
		},
	} as unknown as ResponseStreamEvent;
}

describe("OpenAI Responses lossless replay", () => {
	it("replays opaque provider items and text annotations", () => {
		const model = createModel();
		const providerItem = {
			type: "web_search_call",
			id: "ws_1",
			status: "completed",
			action: { type: "search", query: "Pi" },
		};
		const annotations = [{ type: "url_citation", url: "https://example.com", title: "Example" }];
		const assistant: AssistantMessage = {
			...createOutput(model),
			content: [
				{ type: "providerItem", item: providerItem },
				{ type: "text", text: "See the result.", textSignature: "msg_1", annotations },
			] as unknown as AssistantMessage["content"],
		};
		const context: Context = {
			messages: [{ role: "user", content: "search", timestamp: Date.now() - 1 }, assistant],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai"]));

		expect(input[1]).toEqual(providerItem);
		expect(input[2]).toMatchObject({
			type: "message",
			content: [{ type: "output_text", text: "See the result.", annotations }],
		});
	});

	it("emits every raw provider event when enabled", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new RecordingStream();

		await processResponsesStream(completedEvents(), output, stream, model, { emitProviderEvents: true });

		expect(stream.events).toHaveLength(1);
		expect(stream.events[0]).toMatchObject({
			type: "provider_event",
			event: { type: "response.completed", response: { id: "resp_test" } },
		});
	});

	it("does not emit raw provider events by default", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new RecordingStream();

		await processResponsesStream(completedEvents(), output, stream, model);

		expect(stream.events).toEqual([]);
	});
});
