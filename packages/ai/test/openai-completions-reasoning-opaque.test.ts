import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

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

const model: Model<"openai-completions"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "openai-completions",
	provider: "github-copilot",
	baseUrl: "https://api.individual.githubcopilot.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-test",
		model: model.id,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function toolCallChunk(index: number, id: string): unknown {
	return chunk({
		tool_calls: [{ index, id, type: "function", function: { name: "read", arguments: '{"path":"README.md"}' } }],
	});
}

async function run(messages: AssistantMessage[] = []): Promise<AssistantMessage> {
	return await streamOpenAICompletions(model, normalizeContext({ messages, tools: [readTool] }), {
		apiKey: "test",
	}).result();
}

function assistantPayload(index: number): Record<string, unknown> | undefined {
	const messages = (mockState.payloads[index] as { messages: Array<Record<string, unknown>> }).messages;
	return messages.find((message) => message.role === "assistant");
}

// https://github.com/earendil-works/pi/issues/12418
describe("openai-completions reasoning_opaque replay", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
		mockState.payloads = [];
	});

	it("replays reasoning_opaque with the reasoning_text it streamed after", async () => {
		mockState.chunkSets = [
			[
				chunk({ role: "assistant", reasoning_text: "Read the readme" }),
				chunk({ reasoning_text: " first." }),
				chunk({ role: "assistant", reasoning_opaque: "opaque-1" }),
				toolCallChunk(0, "call_1"),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }, "stop")],
		];

		const assistantMessage = await run();
		expect(assistantMessage.content[0]).toEqual({
			type: "thinking",
			thinking: "Read the readme first.",
			thinkingSignature: JSON.stringify({ field: "reasoning_text", reasoning_opaque: "opaque-1" }),
		});

		await run([assistantMessage]);
		expect(assistantPayload(1)).toMatchObject({
			content: null,
			reasoning_text: "Read the readme first.",
			reasoning_opaque: "opaque-1",
		});
	});

	it("replays the latest reasoning_opaque with the concatenated reasoning text", async () => {
		mockState.chunkSets = [
			[
				chunk({ reasoning_text: "Read the readme." }),
				chunk({ reasoning_opaque: "opaque-first" }),
				toolCallChunk(0, "call_1"),
				chunk({ reasoning_text: " Then the manifest." }),
				chunk({ reasoning_opaque: "opaque-second" }),
				toolCallChunk(1, "call_2"),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }, "stop")],
		];

		const assistantMessage = await run();
		await run([assistantMessage]);
		expect(assistantPayload(1)).toMatchObject({
			reasoning_text: "Read the readme. Then the manifest.",
			reasoning_opaque: "opaque-second",
		});
	});

	it("replays a reasoning_opaque that arrived without reasoning text", async () => {
		mockState.chunkSets = [
			[
				chunk({ content: "Checking.", reasoning_opaque: "opaque-only" }),
				toolCallChunk(0, "call_1"),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }, "stop")],
		];

		const assistantMessage = await run();
		expect(assistantMessage.content.map((block) => block.type)).toEqual(["thinking", "text", "toolCall"]);

		await run([assistantMessage]);
		const payload = assistantPayload(1);
		expect(payload).toMatchObject({ content: "Checking.", reasoning_opaque: "opaque-only" });
		expect(payload).not.toHaveProperty("reasoning_text");
	});

	it("reads reasoning_text and reasoning_opaque from the same chunk", async () => {
		mockState.chunkSets = [
			[
				chunk({ reasoning_text: "Plan.", reasoning_opaque: "opaque-1" }),
				toolCallChunk(0, "call_1"),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }, "stop")],
		];

		const assistantMessage = await run();
		await run([assistantMessage]);
		expect(assistantPayload(1)).toMatchObject({ reasoning_text: "Plan.", reasoning_opaque: "opaque-1" });
	});

	it("replays reasoning_details instead of reasoning_opaque when a stream has both", async () => {
		const detail = { type: "reasoning.encrypted", id: "call_1", data: "encrypted" };
		mockState.chunkSets = [
			[
				chunk({ reasoning_text: "Plan.", reasoning_details: [detail] }),
				chunk({ reasoning_opaque: "opaque-1" }),
				toolCallChunk(0, "call_1"),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }, "stop")],
		];

		const assistantMessage = await run();
		await run([assistantMessage]);
		const payload = assistantPayload(1);
		expect(payload).toMatchObject({ reasoning_details: [detail] });
		expect(payload).not.toHaveProperty("reasoning_opaque");
		expect(payload).not.toHaveProperty("reasoning_text");
	});

	it("keeps reasoning_opaque on the thinking block when the stream fails", async () => {
		mockState.chunkSets = [[chunk({ reasoning_text: "Plan." }), chunk({ reasoning_opaque: "opaque-1" })]];

		const assistantMessage = await run();
		expect(assistantMessage.stopReason).toBe("error");
		expect(assistantMessage.errorMessage).toContain("Stream ended without finish_reason");
		expect(assistantMessage.content[0]).toEqual({
			type: "thinking",
			thinking: "Plan.",
			thinkingSignature: JSON.stringify({ field: "reasoning_text", reasoning_opaque: "opaque-1" }),
		});
	});

	it("does not replay reasoning_opaque to another model", async () => {
		mockState.chunkSets = [
			[
				chunk({ reasoning_text: "Plan." }),
				chunk({ reasoning_opaque: "opaque-1" }),
				chunk({ content: "Done." }, "stop"),
			],
			[chunk({ content: "ok" }, "stop")],
		];

		const assistantMessage = await run();
		await run([{ ...assistantMessage, model: "other-model" }]);
		const payload = assistantPayload(1);
		expect(payload).toMatchObject({ content: "Done." });
		expect(payload).not.toHaveProperty("reasoning_opaque");
		expect(payload).not.toHaveProperty("reasoning_text");
	});
});
