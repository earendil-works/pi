import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	chunkSets: [] as unknown[][],
	payloads: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (payload: unknown) => {
					mockState.payloads.push(payload);
					const chunks = mockState.chunkSets.shift() ?? [];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const reasoningDetail = { type: "reasoning.encrypted", id: "call_1", data: "encrypted-signature" };
const signedReasoningTextDetail = {
	type: "reasoning.text",
	text: "I should call the read tool.",
	signature: "sha256:signed-text",
	id: "reasoning-text-1",
	format: "anthropic-claude-v1",
	index: 0,
};
const reasoningSummaryDetail = {
	type: "reasoning.summary",
	summary: "Decided to inspect the requested file.",
	id: "reasoning-summary-1",
	format: "anthropic-claude-v1",
	index: 1,
};
const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function model(): Model<"openai-completions"> {
	return {
		id: "google/gemini-test",
		name: "Gemini Test",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-test",
		model: "google/gemini-test",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function toolCallChunk(): unknown {
	return chunk({
		tool_calls: [
			{
				index: 0,
				id: "call_1",
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
			},
		],
	});
}

async function runOpenAICompletionsStream(messages: AssistantMessage[] = []): Promise<AssistantMessage> {
	return await streamOpenAICompletions(model(), { messages, tools: [readTool] }, { apiKey: "test" }).result();
}

function getAssistantPayload(payload: unknown): { reasoning?: unknown; reasoning_details?: unknown } | undefined {
	const messages = (
		payload as { messages?: Array<{ role?: string; reasoning?: unknown; reasoning_details?: unknown }> }
	).messages;
	return messages?.find((message) => message.role === "assistant");
}

describe("openai-completions reasoning_details streaming", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
		mockState.payloads = [];
	});

	it("preserves reasoning_details in the thinking signature", async () => {
		mockState.chunkSets = [
			[chunk({ reasoning_details: [reasoningDetail] }), toolCallChunk(), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		const thinking = assistantMessage.content.find((block) => block.type === "thinking");
		expect(thinking).toEqual({
			type: "thinking",
			thinking: "",
			thinkingSignature: JSON.stringify([reasoningDetail]),
		});
		const toolCall = assistantMessage.content.find((block) => block.type === "toolCall");
		expect(toolCall).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md" },
		});

		await runOpenAICompletionsStream([assistantMessage]);

		expect(getAssistantPayload(mockState.payloads[1])?.reasoning_details).toEqual([reasoningDetail]);
	});

	it("falls back to encrypted tool-call signatures for older stored assistant messages", async () => {
		mockState.chunkSets = [
			[chunk({ reasoning_details: [reasoningDetail] }), toolCallChunk(), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		assistantMessage.content = assistantMessage.content.filter((block) => block.type !== "thinking");
		const toolCall = assistantMessage.content.find((block) => block.type === "toolCall");
		if (!toolCall || toolCall.type !== "toolCall") throw new Error("Expected tool call");
		toolCall.thoughtSignature = JSON.stringify(reasoningDetail);

		await runOpenAICompletionsStream([assistantMessage]);

		expect(getAssistantPayload(mockState.payloads[1])?.reasoning_details).toEqual([reasoningDetail]);
	});

	it("preserves signed text and summary reasoning_details in their original sequence", async () => {
		mockState.chunkSets = [
			[
				chunk({ reasoning: signedReasoningTextDetail.text, reasoning_details: [signedReasoningTextDetail] }),
				chunk({ reasoning_details: [reasoningDetail, reasoningSummaryDetail] }),
				toolCallChunk(),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		const expectedReasoningDetails = [signedReasoningTextDetail, reasoningDetail, reasoningSummaryDetail];
		const thinking = assistantMessage.content.find((block) => block.type === "thinking");
		expect(thinking).toEqual({
			type: "thinking",
			thinking: signedReasoningTextDetail.text,
			thinkingSignature: JSON.stringify(expectedReasoningDetails),
		});

		await runOpenAICompletionsStream([assistantMessage]);

		const payload = getAssistantPayload(mockState.payloads[1]);
		expect(payload?.reasoning_details).toEqual(expectedReasoningDetails);
		expect(payload?.reasoning).toBeUndefined();
	});
});
