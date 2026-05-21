import { describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, streamAnthropic } from "../src/providers/anthropic.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model, RawProviderPayload } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chatChunks: [] as unknown[],
	responseEvents: [] as unknown[],
}));

vi.mock("openai", () => {
	function createStream(chunks: unknown[]) {
		return {
			async *[Symbol.asyncIterator]() {
				for (const chunk of chunks) yield chunk;
			},
		};
	}

	function createResponsePromise(stream: ReturnType<typeof createStream>) {
		const promise = Promise.resolve(stream) as Promise<typeof stream> & {
			withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
		};
		promise.withResponse = async () => ({
			data: stream,
			response: { status: 200, headers: new Headers({ "x-request-id": "req_header" }) },
		});
		return promise;
	}

	class FakeOpenAI {
		chat = {
			completions: {
				create: () => createResponsePromise(createStream(mockState.chatChunks)),
			},
		};
		responses = {
			create: () => createResponsePromise(createStream(mockState.responseEvents)),
		};
	}

	return { default: FakeOpenAI };
});

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

function openAICompletionsModel(): Model<"openai-completions"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function openAIResponsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-responses-test",
		name: "GPT Responses Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function anthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 4096,
	};
}

describe("provider raw hooks", () => {
	it("captures OpenAI completions request and raw chunks before normalization", async () => {
		const firstChunk = {
			id: "chatcmpl_raw",
			model: "served-model",
			choices: [{ index: 0, delta: { content: "hi" } }],
		};
		mockState.chatChunks = [
			firstChunk,
			{
				id: "chatcmpl_raw",
				model: "served-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			},
		];
		const requests: RawProviderPayload[] = [];
		const chunks: RawProviderPayload[] = [];
		const ends: RawProviderPayload[] = [];

		const stream = streamOpenAICompletions(openAICompletionsModel(), context, {
			apiKey: "test",
			onRawRequestBody: (payload) => {
				requests.push(payload);
			},
			onRawResponseChunk: (payload) => {
				chunks.push(payload);
			},
			onRawResponseEnd: (payload) => {
				ends.push(payload);
			},
		});
		const message = await stream.result();

		expect(message.stopReason).toBe("stop");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			provider: "openai",
			api: "openai-completions",
			model: "gpt-test",
			index: 0,
			raw: { model: "gpt-test", stream: true },
		});
		expect(chunks[0]).toMatchObject({
			provider: "openai",
			api: "openai-completions",
			model: "gpt-test",
			requestId: "chatcmpl_raw",
			status: 200,
			index: 0,
		});
		expect(chunks[0].raw).toBe(firstChunk);
		expect((chunks[0] as { type?: string }).type).not.toBe("text_delta");
		expect(ends).toHaveLength(1);
		expect(ends[0]).toMatchObject({ index: 2, raw: { done: true } });
	});

	it("captures OpenAI Responses raw events before processResponsesStream normalization", async () => {
		const firstEvent = { type: "response.created", response: { id: "resp_raw" } };
		mockState.responseEvents = [
			firstEvent,
			{
				type: "response.output_item.added",
				item: { id: "msg_1", type: "message", role: "assistant", content: [], status: "in_progress" },
			},
			{
				type: "response.content_part.added",
				item_id: "msg_1",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" },
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					id: "msg_1",
					type: "message",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: "hi", annotations: [] }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_raw",
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			},
		];
		const chunks: RawProviderPayload[] = [];

		const stream = streamOpenAIResponses(openAIResponsesModel(), context, {
			apiKey: "test",
			onRawResponseChunk: (payload) => {
				chunks.push(payload);
			},
		});
		const message = await stream.result();

		expect(message.responseId).toBe("resp_raw");
		expect(chunks[0]).toMatchObject({
			provider: "openai",
			api: "openai-responses",
			model: "gpt-responses-test",
			requestId: "resp_raw",
			status: 200,
			index: 0,
		});
		expect(chunks[0].raw).toBe(firstEvent);
	});

	it("captures Anthropic raw message events before normalized deltas", async () => {
		const firstEvent = {
			type: "message_start",
			message: { id: "msg_raw", usage: { input_tokens: 1, output_tokens: 0 } },
		};
		const body = [
			`event: message_start\ndata: ${JSON.stringify(firstEvent)}\n`,
			`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n`,
			`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n`,
			`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n`,
			`event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");
		const client = {
			messages: {
				create: () => ({
					asResponse: async () => new Response(body, { status: 200, headers: { "request-id": "req_anthropic" } }),
				}),
			},
		};
		const chunks: RawProviderPayload[] = [];

		const stream = streamAnthropic(anthropicModel(), context, {
			client: client as unknown as AnthropicOptions["client"],
			onRawResponseChunk: (payload) => {
				chunks.push(payload);
			},
		});
		const message = await stream.result();

		expect(message.responseId).toBe("msg_raw");
		expect(chunks[0]).toMatchObject({
			provider: "anthropic",
			api: "anthropic-messages",
			model: "claude-test",
			requestId: "msg_raw",
			status: 200,
			index: 0,
		});
		expect(chunks[0].raw).toStrictEqual(firstEvent);
	});
});
