import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

vi.mock("openai", () => {
	async function* createMockResponsesStream(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_wrapper_early_eof" },
		} as ResponseStreamEvent;
		yield {
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "reasoning", id: "rs_wrapper_early_eof", summary: [] },
		} as ResponseStreamEvent;
		yield {
			type: "response.reasoning_text.delta",
			sequence_number: 2,
			output_index: 0,
			content_index: 0,
			item_id: "rs_wrapper_early_eof",
			delta: "partial reasoning before the wrapper stream ends",
		} as ResponseStreamEvent;
	}

	class FakeOpenAI {
		responses = {
			create: () => {
				const responseStream = createMockResponsesStream();
				const promise = Promise.resolve(responseStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: responseStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { default: FakeOpenAI };
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
		contextWindow: 400000,
		maxTokens: 128000,
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function* createEarlyEofEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.created",
		sequence_number: 0,
		response: { id: "resp_early_eof" },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.added",
		sequence_number: 1,
		output_index: 0,
		item: { type: "reasoning", id: "rs_early_eof", summary: [] },
	} as ResponseStreamEvent;
	yield {
		type: "response.reasoning_text.delta",
		sequence_number: 2,
		output_index: 0,
		content_index: 0,
		item_id: "rs_early_eof",
		delta: "partial reasoning before the stream ends",
	} as ResponseStreamEvent;
}

async function* createCompletedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.completed",
		sequence_number: 0,
		response: {
			id: "resp_completed",
			status: "completed",
			usage: {
				input_tokens: 20,
				output_tokens: 7,
				total_tokens: 27,
				input_tokens_details: { cached_tokens: 2, cache_write_tokens: 3 },
			},
		},
	} as unknown as ResponseStreamEvent;
}

async function* createIncompleteEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.incomplete",
		sequence_number: 0,
		response: {
			id: "resp_incomplete",
			status: "incomplete",
			usage: {
				input_tokens: 30,
				output_tokens: 12,
				total_tokens: 42,
				input_tokens_details: { cached_tokens: 5 },
			},
		},
	} as ResponseStreamEvent;
}

async function* createFailedEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.failed",
		sequence_number: 0,
		response: {
			id: "resp_failed",
			status: "failed",
			error: { code: "server_error", message: "boom" },
		},
	} as ResponseStreamEvent;
}

async function* createPhasedMessageEvents(
	phases: readonly ["commentary" | "final_answer", "commentary" | "final_answer"],
	terminalStatus: "completed" | "incomplete" = "completed",
): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: {
			type: "message",
			id: "msg_phase",
			role: "assistant",
			status: "in_progress",
			content: [],
			phase: phases[0],
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: {
			type: "message",
			id: "msg_phase",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "answer", annotations: [] }],
			phase: phases[1],
		},
	} as ResponseStreamEvent;
	if (terminalStatus === "incomplete") {
		yield {
			type: "response.incomplete",
			sequence_number: 2,
			response: { id: "resp_phase", status: "incomplete" },
		} as ResponseStreamEvent;
		return;
	}
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_phase", status: "completed" },
	} as ResponseStreamEvent;
}

describe("OpenAI Responses terminal event handling", () => {
	it("rejects streams that end before a terminal response event", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createEarlyEofEvents(), output, stream, model)).rejects.toThrow(
			"OpenAI Responses stream ended before a terminal response event",
		);
	});

	it("emits an error final result when the wrapper stream ends before a terminal response event", async () => {
		const model = createModel();
		const context: Context = {
			systemPrompt: "",
			messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
			tools: [],
		};
		const stream = streamOpenAIResponses(model, context, { apiKey: "test" });
		const events: AssistantMessageEvent[] = [];
		let initialStopReason: AssistantMessage["stopReason"] | undefined;

		for await (const event of stream) {
			if (event.type === "start") initialStopReason = event.partial.stopReason;
			events.push(event);
		}

		const result = await stream.result();
		const lastEvent = events.at(-1);
		expect(initialStopReason).toBe("pending");
		expect(lastEvent?.type).toBe("error");
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("OpenAI Responses stream ended before a terminal response event");
	});

	it.each([
		{ phases: ["commentary", "commentary"], expected: ["pending", "pending"] },
		{ phases: ["final_answer", "final_answer"], expected: ["stop", "stop"] },
		{ phases: ["commentary", "final_answer"], expected: ["pending", "stop"] },
	] as const)("tracks message phases $phases", async ({ phases, expected }) => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const observedStopReasons: AssistantMessage["stopReason"][] = [];
		const push = stream.push.bind(stream);
		stream.push = (event) => {
			if ("partial" in event) observedStopReasons.push(event.partial.stopReason);
			push(event);
		};

		await processResponsesStream(createPhasedMessageEvents(phases), output, stream, model);

		expect(observedStopReasons).toEqual(expected);
		expect(output.stopReason).toBe("stop");
	});

	it("replaces a provisional final-answer stop with an incomplete terminal reason", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const observedStopReasons: AssistantMessage["stopReason"][] = [];
		const push = stream.push.bind(stream);
		stream.push = (event) => {
			if ("partial" in event) observedStopReasons.push(event.partial.stopReason);
			push(event);
		};

		await processResponsesStream(
			createPhasedMessageEvents(["final_answer", "final_answer"], "incomplete"),
			output,
			stream,
			model,
		);

		expect(observedStopReasons).toEqual(["stop", "stop"]);
		expect(output.stopReason).toBe("length");
	});

	it("finalizes completed terminal events as stop", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createCompletedEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_completed");
		expect(output.stopReason).toBe("stop");
		expect(output.rawStopReason).toBe("completed");
		expect(output.usage).toMatchObject({
			input: 15,
			output: 7,
			cacheRead: 2,
			cacheWrite: 3,
			totalTokens: 27,
		});
	});

	it("finalizes incomplete terminal events as length stops", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await processResponsesStream(createIncompleteEvents(), output, stream, model);

		expect(output.responseId).toBe("resp_incomplete");
		expect(output.stopReason).toBe("length");
		expect(output.rawStopReason).toBe("incomplete");
		expect(output.usage).toMatchObject({
			input: 25,
			output: 12,
			cacheRead: 5,
			cacheWrite: 0,
			totalTokens: 42,
		});
	});

	it("rejects failed terminal events with the provider error", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		await expect(processResponsesStream(createFailedEvents(), output, stream, model)).rejects.toThrow(
			"server_error: boom",
		);
		expect(output.rawStopReason).toBe("failed");
	});
});
