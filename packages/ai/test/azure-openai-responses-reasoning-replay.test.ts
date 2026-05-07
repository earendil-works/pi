import type {
	ResponseCreateParamsStreaming,
	ResponseReasoningItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.js";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import type { AssistantMessage, Context, Message, ThinkingContent } from "../src/types.js";

// -----------------------------------------------------------------------------
// Mock AzureOpenAI client
// -----------------------------------------------------------------------------

interface CapturedCreateCall {
	params: ResponseCreateParamsStreaming;
	response: unknown;
}

const azureMock = vi.hoisted(() => ({
	createCalls: [] as CapturedCreateCall[],
	queuedStreams: [] as AsyncIterable<ResponseStreamEvent>[],
}));

vi.mock("openai", () => {
	class AzureOpenAI {
		responses = {
			create: (params: ResponseCreateParamsStreaming) => {
				const nextStream = azureMock.queuedStreams.shift();
				if (!nextStream) {
					throw new Error("No mock stream queued for AzureOpenAI.responses.create call");
				}
				azureMock.createCalls.push({ params, response: nextStream });
				const promise = Promise.resolve(nextStream) as Promise<AsyncIterable<ResponseStreamEvent>> & {
					withResponse: () => Promise<{
						data: AsyncIterable<ResponseStreamEvent>;
						response: { status: number; headers: Headers };
					}>;
				};
				promise.withResponse = async () => ({
					data: nextStream,
					response: { status: 200, headers: new Headers() },
				});
				return promise;
			},
		};
	}

	return { AzureOpenAI };
});

function makeStream(events: ResponseStreamEvent[]): AsyncIterable<ResponseStreamEvent> {
	return {
		[Symbol.asyncIterator]: async function* () {
			for (const event of events) {
				yield event;
			}
		},
	};
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

type DeepPartial<T> = T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

function reasoningEvents({
	reasoningItem,
	finalReasoningItem,
	messageText = "hello",
}: {
	reasoningItem: ResponseReasoningItem;
	finalReasoningItem?: ResponseReasoningItem;
	messageText?: string;
}): ResponseStreamEvent[] {
	const responseId = "resp_test_1";
	const messageId = "msg_test_1";
	const messageItem = {
		type: "message" as const,
		id: messageId,
		role: "assistant" as const,
		status: "completed" as const,
		content: [{ type: "output_text" as const, text: messageText, annotations: [] }],
	};

	// ResponseStreamEvent is a massive union. Type assertions avoid reproducing
	// the full shape of every event when all we need is a realistic sequence.
	const events: DeepPartial<ResponseStreamEvent>[] = [
		{
			type: "response.created",
			response: { id: responseId },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: reasoningItem,
		},
		...((reasoningItem.summary ?? []).flatMap((part, idx) => [
			{
				type: "response.reasoning_summary_part.added",
				item_id: reasoningItem.id,
				output_index: 0,
				summary_index: idx,
				part: { type: "summary_text", text: "" },
			},
			{
				type: "response.reasoning_summary_text.delta",
				item_id: reasoningItem.id,
				output_index: 0,
				summary_index: idx,
				delta: part.text,
			},
			{
				type: "response.reasoning_summary_part.done",
				item_id: reasoningItem.id,
				output_index: 0,
				summary_index: idx,
				part,
			},
		]) as DeepPartial<ResponseStreamEvent>[]),
		{
			type: "response.output_item.done",
			output_index: 0,
			item: reasoningItem,
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: messageItem,
		},
		{
			type: "response.content_part.added",
			item_id: messageId,
			output_index: 1,
			content_index: 0,
			part: { type: "output_text", text: "", annotations: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: messageId,
			output_index: 1,
			content_index: 0,
			delta: messageText,
		},
		{
			type: "response.output_item.done",
			output_index: 1,
			item: messageItem,
		},
		{
			type: "response.completed",
			response: {
				id: responseId,
				status: "completed",
				usage: {
					input_tokens: 10,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens: 20,
					output_tokens_details: { reasoning_tokens: 15 },
					total_tokens: 30,
				},
				output: [finalReasoningItem ?? reasoningItem, messageItem],
			},
		},
	];

	return events as ResponseStreamEvent[];
}

const originalAzureBaseUrl = process.env.AZURE_OPENAI_BASE_URL;
const originalAzureApiKey = process.env.AZURE_OPENAI_API_KEY;

beforeEach(() => {
	azureMock.createCalls.length = 0;
	azureMock.queuedStreams.length = 0;
	process.env.AZURE_OPENAI_BASE_URL = "https://test.openai.azure.com/openai/v1";
	process.env.AZURE_OPENAI_API_KEY = "test-api-key";
});

afterEach(() => {
	if (originalAzureBaseUrl === undefined) {
		delete process.env.AZURE_OPENAI_BASE_URL;
	} else {
		process.env.AZURE_OPENAI_BASE_URL = originalAzureBaseUrl;
	}
	if (originalAzureApiKey === undefined) {
		delete process.env.AZURE_OPENAI_API_KEY;
	} else {
		process.env.AZURE_OPENAI_API_KEY = originalAzureApiKey;
	}
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("Azure OpenAI Responses multi-turn reasoning replay", () => {
	it("replays reasoning item with encrypted_content when present in response.output_item.done", async () => {
		const model = getModel("azure-openai-responses", "gpt-5-mini");

		const reasoningItem: ResponseReasoningItem = {
			id: "rs_happy_path",
			type: "reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: "Think about hello." }],
			encrypted_content: "ENCRYPTED_IN_OUTPUT_ITEM_DONE",
		};
		azureMock.queuedStreams.push(makeStream(reasoningEvents({ reasoningItem })));

		const turn1Context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const assistantMessage = await streamAzureOpenAIResponses(model, turn1Context, {
			reasoningEffort: "medium",
		}).result();

		expect(assistantMessage.stopReason).toBe("stop");
		const thinkingBlock = assistantMessage.content.find((b): b is ThinkingContent => b.type === "thinking");
		expect(thinkingBlock?.thinkingSignature).toBeTruthy();
		const parsed = JSON.parse(thinkingBlock!.thinkingSignature!) as ResponseReasoningItem;
		expect(parsed.encrypted_content).toBe("ENCRYPTED_IN_OUTPUT_ITEM_DONE");

		// Turn 2: replay the assistant message and verify encrypted_content is forwarded.
		azureMock.queuedStreams.push(
			makeStream([
				{
					type: "response.completed",
					response: {
						id: "resp_test_2",
						status: "completed",
						usage: {
							input_tokens: 10,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens: 1,
							output_tokens_details: { reasoning_tokens: 0 },
							total_tokens: 11,
						},
						output: [],
					},
				} as unknown as ResponseStreamEvent,
			]),
		);

		const followUp: Message = { role: "user", content: "Now say goodbye.", timestamp: Date.now() };
		const turn2Context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }, assistantMessage, followUp],
		};
		await streamAzureOpenAIResponses(model, turn2Context, { reasoningEffort: "medium" }).result();

		expect(azureMock.createCalls).toHaveLength(2);
		const turn2Input = azureMock.createCalls[1].params.input as unknown as Array<Record<string, unknown>>;
		const replayedReasoning = turn2Input.find((item) => item.type === "reasoning") as
			| ResponseReasoningItem
			| undefined;
		expect(replayedReasoning).toBeDefined();
		expect(replayedReasoning?.id).toBe("rs_happy_path");
		expect(replayedReasoning?.encrypted_content).toBe("ENCRYPTED_IN_OUTPUT_ITEM_DONE");
	});

	it("backfills encrypted_content from response.completed when output_item.done omits it", async () => {
		// This is the real-world bug: Azure does NOT include encrypted_content on the
		// intermediate response.output_item.done event, only on the final
		// response.completed event's response.output[] array. Without the fix,
		// the thinking signature captured at output_item.done time is missing
		// encrypted_content, and turn 2 fails with
		// "Item with id 'rs_...' not found. Items are not persisted when `store`
		// is set to false."
		const model = getModel("azure-openai-responses", "gpt-5-mini");

		const reasoningItemIntermediate: ResponseReasoningItem = {
			id: "rs_late_encryption",
			type: "reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: "Consider a friendly goodbye." }],
			// encrypted_content intentionally missing here.
		};
		const reasoningItemFinal: ResponseReasoningItem = {
			...reasoningItemIntermediate,
			encrypted_content: "ENCRYPTED_IN_RESPONSE_COMPLETED",
		};
		azureMock.queuedStreams.push(
			makeStream(
				reasoningEvents({
					reasoningItem: reasoningItemIntermediate,
					finalReasoningItem: reasoningItemFinal,
				}),
			),
		);

		const turn1Context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const assistantMessage: AssistantMessage = await streamAzureOpenAIResponses(model, turn1Context, {
			reasoningEffort: "medium",
		}).result();

		expect(assistantMessage.stopReason).toBe("stop");
		const thinkingBlock = assistantMessage.content.find((b): b is ThinkingContent => b.type === "thinking");
		expect(thinkingBlock?.thinkingSignature).toBeTruthy();
		const parsed = JSON.parse(thinkingBlock!.thinkingSignature!) as ResponseReasoningItem;
		expect(parsed.encrypted_content).toBe("ENCRYPTED_IN_RESPONSE_COMPLETED");

		// Turn 2: replay. The replayed reasoning item must carry encrypted_content
		// so the Azure API can verify the item without a server-side lookup.
		azureMock.queuedStreams.push(
			makeStream([
				{
					type: "response.completed",
					response: {
						id: "resp_test_2",
						status: "completed",
						usage: {
							input_tokens: 10,
							input_tokens_details: { cached_tokens: 0 },
							output_tokens: 1,
							output_tokens_details: { reasoning_tokens: 0 },
							total_tokens: 11,
						},
						output: [],
					},
				} as unknown as ResponseStreamEvent,
			]),
		);

		const followUp: Message = { role: "user", content: "Now say goodbye.", timestamp: Date.now() };
		const turn2Context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }, assistantMessage, followUp],
		};
		await streamAzureOpenAIResponses(model, turn2Context, { reasoningEffort: "medium" }).result();

		expect(azureMock.createCalls).toHaveLength(2);
		const turn2Input = azureMock.createCalls[1].params.input as unknown as Array<Record<string, unknown>>;
		const replayedReasoning = turn2Input.find((item) => item.type === "reasoning") as
			| ResponseReasoningItem
			| undefined;
		expect(replayedReasoning).toBeDefined();
		expect(replayedReasoning?.id).toBe("rs_late_encryption");
		expect(replayedReasoning?.encrypted_content).toBe("ENCRYPTED_IN_RESPONSE_COMPLETED");
	});

	it("forwards explicit store:true to the Azure request body", async () => {
		const model = getModel("azure-openai-responses", "gpt-5-mini");

		const reasoningItem: ResponseReasoningItem = {
			id: "rs_store_true",
			type: "reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: "Ok." }],
		};
		azureMock.queuedStreams.push(makeStream(reasoningEvents({ reasoningItem })));

		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Hi.", timestamp: Date.now() }],
		};
		await streamAzureOpenAIResponses(model, context, {
			reasoningEffort: "medium",
			store: true,
		}).result();

		expect(azureMock.createCalls).toHaveLength(1);
		expect(azureMock.createCalls[0].params.store).toBe(true);
	});

	it("does not set store by default on Azure Responses (preserves server default)", async () => {
		const model = getModel("azure-openai-responses", "gpt-5-mini");

		const reasoningItem: ResponseReasoningItem = {
			id: "rs_default_store",
			type: "reasoning",
			status: "completed",
			summary: [{ type: "summary_text", text: "Ok." }],
		};
		azureMock.queuedStreams.push(makeStream(reasoningEvents({ reasoningItem })));

		const context: Context = {
			systemPrompt: "You are concise.",
			messages: [{ role: "user", content: "Hi.", timestamp: Date.now() }],
		};
		await streamAzureOpenAIResponses(model, context, { reasoningEffort: "medium" }).result();

		expect(azureMock.createCalls).toHaveLength(1);
		expect(azureMock.createCalls[0].params.store).toBeUndefined();
	});
});
