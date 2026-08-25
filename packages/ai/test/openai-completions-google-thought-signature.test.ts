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

const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function model(enabled: boolean): Model<"openai-completions"> {
	return {
		id: "google/gemini-3-test",
		name: "Gemini 3 Test",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
		compat: { supportsGoogleThoughtSignatures: enabled },
	};
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-test",
		model: "google/gemini-3-test",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function toolCallChunk(index: number, id: string, signature?: string): unknown {
	return chunk({
		tool_calls: [
			{
				index,
				id,
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
				...(signature !== undefined ? { extra_content: { google: { thought_signature: signature } } } : {}),
			},
		],
	});
}

async function runStream(enabled: boolean, messages: AssistantMessage[] = []): Promise<AssistantMessage> {
	return await streamOpenAICompletions(model(enabled), { messages, tools: [readTool] }, { apiKey: "test" }).result();
}

function getToolCalls(
	block: AssistantMessage["content"][number],
): block is Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
	return block.type === "toolCall";
}

type AssistantPayload = {
	tool_calls?: Array<{ type?: string; extra_content?: unknown }>;
	reasoning_details?: unknown;
};

function getAssistantPayload(payload: unknown): AssistantPayload | undefined {
	const messages = (payload as { messages?: Array<{ role?: string }> }).messages;
	const assistant = messages?.find((message) => message.role === "assistant");
	return assistant as AssistantPayload | undefined;
}

const SIGNATURE_A = "AgGDja8BCEmVrN0base64sigA";
const SIGNATURE_B = "AgGDja8BCEmVrN0base64sigB";

describe("openai-completions Google thought signatures", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
		mockState.payloads = [];
	});

	it("captures extra_content.google.thought_signature onto the final AssistantMessage", async () => {
		mockState.chunkSets = [
			[toolCallChunk(0, "call_1", SIGNATURE_A), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(true);
		const toolCall = message.content.find(getToolCalls);
		expect(toolCall).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md" },
			thoughtSignature: SIGNATURE_A,
		});
	});

	it("keeps the first non-empty signature and ignores later deltas for the same call", async () => {
		mockState.chunkSets = [
			[toolCallChunk(0, "call_1", SIGNATURE_A), toolCallChunk(0, "call_1", SIGNATURE_B), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(true);
		const toolCalls = message.content.filter(getToolCalls);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].thoughtSignature).toBe(SIGNATURE_A);
	});

	it("ignores malformed extra_content shapes without crashing or capturing", async () => {
		mockState.chunkSets = [
			[
				chunk({
					tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "" } }],
				}),
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "read", arguments: '{"path"' },
							extra_content: {},
						},
					],
				}),
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: { name: "read", arguments: ':"README.md"}' },
							extra_content: { google: {} },
						},
					],
				}),
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							extra_content: { google: { thought_signature: 12345 } },
						},
					],
				}),
				chunk({
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							extra_content: { google: { thought_signature: "" } },
						},
					],
				}),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(true);
		const toolCalls = message.content.filter(getToolCalls);
		expect(toolCalls).toHaveLength(1);
		expect(toolCalls[0].id).toBe("call_1");
		expect(toolCalls[0].name).toBe("read");
		expect(toolCalls[0].thoughtSignature).toBeUndefined();
	});

	it("keeps distinct signatures for multiple tool calls in one turn", async () => {
		mockState.chunkSets = [
			[toolCallChunk(0, "call_1", SIGNATURE_A), toolCallChunk(1, "call_2", SIGNATURE_B), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(true);
		const toolCalls = message.content.filter(getToolCalls);
		expect(toolCalls).toHaveLength(2);
		expect(toolCalls[0]).toMatchObject({ id: "call_1", thoughtSignature: SIGNATURE_A });
		expect(toolCalls[1]).toMatchObject({ id: "call_2", thoughtSignature: SIGNATURE_B });
	});

	it("captures nothing when the flag is disabled", async () => {
		mockState.chunkSets = [
			[toolCallChunk(0, "call_1", SIGNATURE_A), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(false);
		const toolCall = message.content.find(getToolCalls);
		expect(toolCall).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md" },
		});
		expect("thoughtSignature" in (toolCall ?? {})).toBe(false);

		await runStream(false, [message]);
		const assistantPayload = getAssistantPayload(mockState.payloads[1]);
		const replayed = assistantPayload?.tool_calls?.find((tc) => tc.type === "function");
		expect(replayed && "extra_content" in replayed).toBe(false);
	});

	it("echoes captured signatures back verbatim on replayed function tool calls", async () => {
		mockState.chunkSets = [
			[toolCallChunk(0, "call_1", SIGNATURE_A), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(true);

		await runStream(true, [message]);

		const assistantPayload = getAssistantPayload(mockState.payloads[1]);
		expect(assistantPayload?.tool_calls).toHaveLength(1);
		expect(assistantPayload?.tool_calls?.[0].type).toBe("function");
		expect(assistantPayload?.tool_calls?.[0].extra_content).toEqual({
			google: { thought_signature: SIGNATURE_A },
		});
	});

	it("does not emit extra_content on replay when no signature was captured", async () => {
		mockState.chunkSets = [
			[toolCallChunk(0, "call_1"), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(true);

		await runStream(true, [message]);

		const replayed = getAssistantPayload(mockState.payloads[1])?.tool_calls?.[0];
		expect(replayed && "extra_content" in replayed).toBe(false);
	});

	it("leaves the legacy encrypted reasoning-details path untouched alongside a captured signature", async () => {
		mockState.chunkSets = [
			[toolCallChunk(0, "call_1", SIGNATURE_A), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const message = await runStream(true);

		await runStream(true, [message]);

		const assistantPayload = getAssistantPayload(mockState.payloads[1]);
		// A raw Google signature is not JSON, so it must not be parsed into
		// reasoning_details, yet the echo must still be present.
		expect(assistantPayload?.reasoning_details).toBeUndefined();
		expect(assistantPayload?.tool_calls?.[0].extra_content).toEqual({
			google: { thought_signature: SIGNATURE_A },
		});
	});
});
