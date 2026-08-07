import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Message, Model, Tool } from "../src/types.ts";

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

function toolCallChunk(extraContent?: unknown): unknown {
	return chunk({
		tool_calls: [
			{
				index: 0,
				id: "call_1",
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
				...(extraContent ? { extra_content: extraContent } : {}),
			},
		],
	});
}

async function runOpenAICompletionsStream(messages: Message[] = []): Promise<AssistantMessage> {
	return await streamOpenAICompletions(model(), { messages, tools: [readTool] }, { apiKey: "test" }).result();
}

type AssistantPayload = {
	reasoning_details?: unknown;
	tool_calls?: Array<{ extra_content?: unknown }>;
};

function getAssistantPayload(payload: unknown): AssistantPayload | undefined {
	const messages = (payload as { messages?: Array<AssistantPayload & { role?: string }> }).messages ?? [];
	return messages.find((message) => message.role === "assistant");
}

describe("openai-completions tool call signature streaming", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
		mockState.payloads = [];
	});

	it("preserves reasoning_details that arrive before their matching tool call", async () => {
		mockState.chunkSets = [
			[chunk({ reasoning_details: [reasoningDetail] }), toolCallChunk(), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		const toolCall = assistantMessage.content.find((block) => block.type === "toolCall");
		expect(toolCall).toMatchObject({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: JSON.stringify(reasoningDetail),
		});

		await runOpenAICompletionsStream([assistantMessage]);

		expect(getAssistantPayload(mockState.payloads[1])?.reasoning_details).toEqual([reasoningDetail]);
	});

	it.each(["google", "vertex"] as const)(
		"round-trips %s thought signatures from tool call extra_content",
		async (namespace) => {
			const extraContent = { [namespace]: { thought_signature: "opaque-signature" } };
			mockState.chunkSets = [
				[toolCallChunk(extraContent), chunk({}, "tool_calls")],
				[chunk({ content: "ok" }), chunk({}, "stop")],
			];

			const userMessage: Message = {
				role: "user",
				content: "Read README.md",
				timestamp: 1,
			};
			const assistantMessage = await runOpenAICompletionsStream([userMessage]);
			const toolCall = assistantMessage.content.find((block) => block.type === "toolCall");
			expect(toolCall).toMatchObject({
				type: "toolCall",
				id: "call_1",
				thoughtSignature: JSON.stringify(extraContent),
			});

			const toolResult: Message = {
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "README contents" }],
				isError: false,
				timestamp: 2,
			};
			await runOpenAICompletionsStream([userMessage, assistantMessage, toolResult]);

			const replayedAssistant = getAssistantPayload(mockState.payloads[1]);
			expect(replayedAssistant?.tool_calls?.[0]?.extra_content).toEqual(extraContent);
			expect(replayedAssistant?.reasoning_details).toBeUndefined();
		},
	);
});
