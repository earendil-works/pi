import type { ResponseReasoningItem, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const ENCRYPTED = "xai-encrypted-reasoning-blob";
const REASONING_ID = "rs_51abe1aa-599b-80b6-57c8-dddc6263362f_us-east-1";

function grok45(): Model<"openai-responses"> {
	return {
		id: "grok-4.5",
		name: "Grok 4.5",
		api: "openai-responses",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256000,
		maxTokens: 64000,
		thinkingLevelMap: { off: null, minimal: null },
		compat: { supportsLongCacheRetention: false },
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

function getReplayedReasoning(model: Model<"openai-responses">, assistant: AssistantMessage) {
	const context: Context = {
		messages: [
			{ role: "user", content: "first", timestamp: Date.now() - 1 },
			assistant,
			{ role: "user", content: "follow-up", timestamp: Date.now() },
		],
	};
	const input = convertResponsesMessages(model, context, new Set(["openai", "openai-codex", "opencode"]));
	return input.find((item) => "type" in item && item.type === "reasoning");
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
			id: "resp_xai_reasoning",
			status: "completed",
			output: [completedItem],
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				total_tokens: 2,
				input_tokens_details: { cached_tokens: 0 },
			},
		},
	} as ResponseStreamEvent;
}

function sseFromEvents(events: unknown[]): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("xAI encrypted reasoning replay", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("requests reasoning.encrypted_content with store:false even without an effort override", async () => {
		let body: Record<string, unknown> | undefined;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			body = JSON.parse(await request.clone().text()) as Record<string, unknown>;
			return sseFromEvents([
				{
					type: "response.completed",
					sequence_number: 0,
					response: {
						id: "resp_include",
						status: "completed",
						output: [],
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		});

		const result = await streamOpenAIResponses(
			grok45(),
			{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
			{ apiKey: "xai-test-token" },
		).result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(body).toMatchObject({
			model: "grok-4.5",
			store: false,
			stream: true,
			include: ["reasoning.encrypted_content"],
		});
	});

	it("replays encrypted_content from output_item.done when summary text is empty", async () => {
		const model = grok45();
		const output = createOutput(model);
		const doneItem: ResponseReasoningItem = {
			type: "reasoning",
			id: REASONING_ID,
			summary: [],
			status: "completed",
			encrypted_content: ENCRYPTED,
		};

		await processResponsesStream(createEvents(doneItem, doneItem), output, new AssistantMessageEventStream(), model);

		const thinking = output.content.find((block) => block.type === "thinking");
		expect(thinking).toMatchObject({ type: "thinking", thinking: "" });
		expect(thinking && "thinkingSignature" in thinking ? thinking.thinkingSignature : undefined).toContain(ENCRYPTED);

		expect(getReplayedReasoning(model, output)).toMatchObject({
			type: "reasoning",
			id: REASONING_ID,
			status: "completed",
			encrypted_content: ENCRYPTED,
		});
	});

	it("backfills encrypted_content from response.completed when output_item.done omitted it", async () => {
		const model = grok45();
		const output = createOutput(model);
		const doneItem: ResponseReasoningItem = {
			type: "reasoning",
			id: REASONING_ID,
			summary: [],
			status: "completed",
		};
		const completedItem: ResponseReasoningItem = {
			...doneItem,
			encrypted_content: ENCRYPTED,
		};

		await processResponsesStream(
			createEvents(doneItem, completedItem),
			output,
			new AssistantMessageEventStream(),
			model,
		);

		expect(getReplayedReasoning(model, output)).toMatchObject({
			type: "reasoning",
			id: REASONING_ID,
			encrypted_content: ENCRYPTED,
		});
	});

	it("keeps encrypted-only thinking blocks when converting same-model history", async () => {
		const model = grok45();
		const assistant: AssistantMessage = {
			...createOutput(model),
			stopReason: "stop",
			content: [
				{
					type: "thinking",
					thinking: "",
					thinkingSignature: JSON.stringify({
						type: "reasoning",
						id: REASONING_ID,
						summary: [],
						status: "completed",
						encrypted_content: ENCRYPTED,
					}),
				},
				{ type: "text", text: "42", textSignature: JSON.stringify({ v: 1, id: "msg_xai" }) },
			],
		};

		expect(getReplayedReasoning(model, assistant)).toMatchObject({
			type: "reasoning",
			id: REASONING_ID,
			encrypted_content: ENCRYPTED,
		});
	});

	it("sends encrypted_content back in the next xAI Responses input", async () => {
		const bodies: Record<string, unknown>[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			bodies.push(JSON.parse(await request.clone().text()) as Record<string, unknown>);
			return sseFromEvents([
				{
					type: "response.created",
					sequence_number: 0,
					response: { id: "resp_sdk", status: "in_progress", output: [] },
				},
				{
					type: "response.output_item.added",
					sequence_number: 1,
					output_index: 0,
					item: { type: "reasoning", id: REASONING_ID, status: "in_progress", summary: [] },
				},
				{
					type: "response.output_item.done",
					sequence_number: 2,
					output_index: 0,
					item: {
						type: "reasoning",
						id: REASONING_ID,
						status: "completed",
						summary: [],
						encrypted_content: ENCRYPTED,
					},
				},
				{
					type: "response.output_item.added",
					sequence_number: 3,
					output_index: 1,
					item: {
						type: "message",
						id: "msg_xai",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				},
				{
					type: "response.output_text.delta",
					sequence_number: 4,
					output_index: 1,
					content_index: 0,
					item_id: "msg_xai",
					delta: "42",
				},
				{
					type: "response.output_item.done",
					sequence_number: 5,
					output_index: 1,
					item: {
						type: "message",
						id: "msg_xai",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "42", annotations: [] }],
					},
				},
				{
					type: "response.completed",
					sequence_number: 6,
					response: {
						id: "resp_sdk",
						status: "completed",
						output: [
							{
								type: "reasoning",
								id: REASONING_ID,
								status: "completed",
								summary: [],
								encrypted_content: ENCRYPTED,
							},
							{
								type: "message",
								id: "msg_xai",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "42", annotations: [] }],
							},
						],
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]);
		});

		const model = grok45();
		const first = await streamOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "How big is the universe?", timestamp: 1 }] },
			{ apiKey: "xai-test-token", reasoningEffort: "medium" },
		).result();
		expect(first.stopReason, first.errorMessage).toBe("stop");

		const second = await streamOpenAIResponses(
			model,
			{
				messages: [
					{ role: "user", content: "How big is the universe?", timestamp: 1 },
					first,
					{ role: "user", content: "How do stars form?", timestamp: 2 },
				],
			},
			{ apiKey: "xai-test-token", reasoningEffort: "medium" },
		).result();
		expect(second.stopReason, second.errorMessage).toBe("stop");
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toMatchObject({
			store: false,
			include: ["reasoning.encrypted_content"],
			reasoning: { effort: "medium" },
		});
		expect(bodies[1].input).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "reasoning",
					id: REASONING_ID,
					status: "completed",
					encrypted_content: ENCRYPTED,
				}),
			]),
		);
	});

	it("parses encrypted_content through the OpenAI SDK SSE client used by xAI", async () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
			sseFromEvents([
				{
					type: "response.created",
					sequence_number: 0,
					response: { id: "resp_sdk", status: "in_progress", output: [] },
				},
				{
					type: "response.output_item.added",
					sequence_number: 1,
					output_index: 0,
					item: { type: "reasoning", id: REASONING_ID, status: "in_progress", summary: [] },
				},
				{
					type: "response.output_item.done",
					sequence_number: 2,
					output_index: 0,
					item: {
						type: "reasoning",
						id: REASONING_ID,
						status: "completed",
						summary: [],
						encrypted_content: ENCRYPTED,
					},
				},
				{
					type: "response.output_item.added",
					sequence_number: 3,
					output_index: 1,
					item: {
						type: "message",
						id: "msg_xai",
						role: "assistant",
						status: "in_progress",
						content: [],
					},
				},
				{
					type: "response.output_text.delta",
					sequence_number: 4,
					output_index: 1,
					content_index: 0,
					item_id: "msg_xai",
					delta: "42",
				},
				{
					type: "response.output_item.done",
					sequence_number: 5,
					output_index: 1,
					item: {
						type: "message",
						id: "msg_xai",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "42", annotations: [] }],
					},
				},
				{
					type: "response.completed",
					sequence_number: 6,
					response: {
						id: "resp_sdk",
						status: "completed",
						output: [
							{
								type: "reasoning",
								id: REASONING_ID,
								status: "completed",
								summary: [],
								encrypted_content: ENCRYPTED,
							},
							{
								type: "message",
								id: "msg_xai",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "42", annotations: [] }],
							},
						],
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							total_tokens: 2,
							input_tokens_details: { cached_tokens: 0 },
						},
					},
				},
			]),
		);

		const model = grok45();
		const result = await streamOpenAIResponses(
			model,
			{ messages: [{ role: "user", content: "How big is the universe?", timestamp: 1 }] },
			{ apiKey: "xai-test-token", reasoningEffort: "medium" },
		).result();

		expect(result.stopReason, result.errorMessage).toBe("stop");
		expect(getReplayedReasoning(model, result)).toMatchObject({
			type: "reasoning",
			id: REASONING_ID,
			encrypted_content: ENCRYPTED,
		});
	});
});
