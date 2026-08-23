import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessageEvent, Model, Tool } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunkSets: [] as unknown[][],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: () => {
					const chunks = mockState.chunkSets.shift() ?? [];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) yield chunk;
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

const writeTool: Tool = {
	name: "write",
	description: "Write a file",
	parameters: Type.Object({ path: Type.String(), content: Type.String() }),
};

function model(): Model<"openai-completions"> {
	return {
		id: "deepseek/deepseek-v4-flash-0731",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-repro",
		model: "deepseek/deepseek-v4-flash-0731",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function toolCallChunk(argumentsJson: string): unknown {
	return chunk({
		tool_calls: [
			{
				index: 0,
				id: "call_write",
				type: "function",
				function: { name: "write", arguments: argumentsJson },
			},
		],
	});
}

async function collectEvents(): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	const eventStream = streamOpenAICompletions(
		model(),
		normalizeContext({
			messages: [{ role: "user", content: "Write the handoff", timestamp: 1 }],
			tools: [writeTool],
		}),
		{ apiKey: "test" },
	);
	for await (const event of eventStream) events.push(event);
	return events;
}

describe("openai-completions final tool arguments", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
	});

	it("rejects a truncated tool call even when the provider reports tool_calls", async () => {
		mockState.chunkSets = [
			[toolCallChunk('{"content":"# NEXT SHELL PROMPT\\npartial handoff'), chunk({}, "tool_calls")],
		];

		const events = await collectEvents();
		const terminalEvent = events.at(-1);

		expect(events.map((event) => event.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "error"]);
		expect(terminalEvent?.type).toBe("error");
		if (terminalEvent?.type !== "error") throw new Error("Expected terminal error event");
		expect(terminalEvent.error.stopReason).toBe("error");
		expect(terminalEvent.error.errorMessage).toContain(
			'Provider returned error: incomplete or invalid final arguments for tool call "write"',
		);
		expect(terminalEvent.error.content).toEqual([]);
		expect(isRetryableAssistantError(terminalEvent.error)).toBe(true);
	});

	it("emits a complete tool call after strictly parsing its final arguments", async () => {
		mockState.chunkSets = [
			[toolCallChunk('{"path":"NEXT_SHELL_PROMPT.md","content":"complete handoff"}'), chunk({}, "tool_calls")],
		];

		const events = await collectEvents();
		const terminalEvent = events.at(-1);

		expect(events.map((event) => event.type)).toEqual([
			"start",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(terminalEvent?.type).toBe("done");
		if (terminalEvent?.type !== "done") throw new Error("Expected terminal done event");
		expect(terminalEvent.message.content).toEqual([
			{
				type: "toolCall",
				id: "call_write",
				name: "write",
				arguments: { path: "NEXT_SHELL_PROMPT.md", content: "complete handoff" },
			},
		]);
	});
});
