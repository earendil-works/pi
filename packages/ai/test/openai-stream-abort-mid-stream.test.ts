import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

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

/**
 * Creates a mock event stream that yields many text deltas.
 * Records how many events were actually consumed by the caller.
 */
function createManyDeltaEvents(count: number): {
	iterable: AsyncIterable<ResponseStreamEvent>;
	consumed: { value: number };
} {
	const consumed = { value: 0 };

	async function* generate(): AsyncIterable<ResponseStreamEvent> {
		yield {
			type: "response.created",
			sequence_number: 0,
			response: { id: "resp_abort_test" },
		} as ResponseStreamEvent;

		yield {
			type: "response.output_item.added",
			sequence_number: 1,
			output_index: 0,
			item: { type: "message", id: "msg_abort_test", role: "assistant", status: "in_progress", content: [] },
		} as ResponseStreamEvent;

		for (let i = 0; i < count; i++) {
			consumed.value++;
			yield {
				type: "response.output_text.delta",
				sequence_number: 2 + i,
				output_index: 0,
				content_index: 0,
				item_id: "msg_abort_test",
				delta: `chunk-${i} `,
			} as ResponseStreamEvent;
		}

		consumed.value++;
		yield {
			type: "response.completed",
			sequence_number: 2 + count,
			response: {
				id: "resp_abort_test",
				status: "completed",
				output: [],
				usage: { input_tokens: 10, output_tokens: count, total_tokens: 10 + count },
			},
		} as unknown as ResponseStreamEvent;
	}

	return { iterable: generate(), consumed };
}

describe("processResponsesStream abort mid-stream", () => {
	it("should stop consuming events when signal is already aborted", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const controller = new AbortController();
		controller.abort();

		const { iterable, consumed } = createManyDeltaEvents(100);

		await processResponsesStream(iterable, output, stream, model, { signal: controller.signal });

		// With signal pre-aborted, the loop should break immediately (0 events consumed)
		expect(consumed.value).toBe(0);
		// stopReason stays pending since we never hit a terminal event
		expect(output.stopReason).toBe("pending");
	});

	it("should stop consuming events shortly after signal aborts mid-stream", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();
		const controller = new AbortController();

		// Abort after 5 delta events
		let deltaCount = 0;
		const originalPush = stream.push.bind(stream);
		stream.push = (event) => {
			originalPush(event);
			if (event.type === "text_delta") {
				deltaCount++;
				if (deltaCount === 5) {
					controller.abort();
				}
			}
		};

		const { iterable, consumed } = createManyDeltaEvents(100);

		await processResponsesStream(iterable, output, stream, model, { signal: controller.signal });

		// The abort fires after the 5th delta is processed. The loop checks signal at
		// the top of the next iteration, so at most one more event may be consumed
		// before breaking. The key assertion: far fewer than all 100 deltas were consumed.
		expect(consumed.value).toBeLessThan(10);
		expect(output.stopReason).toBe("pending");
	});

	it("should consume all events when no abort signal is provided", async () => {
		const model = createModel();
		const output = createOutput(model);
		const stream = new AssistantMessageEventStream();

		const { iterable, consumed } = createManyDeltaEvents(20);

		await processResponsesStream(iterable, output, stream, model);

		// All events consumed: 20 deltas + 1 response.completed = 21
		expect(consumed.value).toBe(21);
		expect(output.stopReason).toBe("stop");
	});
});
