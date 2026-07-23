import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { appendGrammarToolInputJsonDelta } from "../src/api/constrained-sampling.ts";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model, Tool, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

function makeModel(): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* iterateEvents(events: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
	yield* events;
}

function makeTool(overrides: Partial<Tool> = {}): Tool {
	return {
		name: "sample_tool",
		description: "Sample tool",
		parameters: Type.Object({ payload: Type.String() }, { additionalProperties: false }),
		...overrides,
	};
}

function captureToolCallDeltas(stream: AssistantMessageEventStream): string[] {
	const deltas: string[] = [];
	const originalPush = stream.push.bind(stream);
	stream.push = (event) => {
		if (event.type === "toolcall_delta") {
			deltas.push(event.delta);
		}
		originalPush(event);
	};
	return deltas;
}

describe("constrained tool sampling", () => {
	it("converts supported constraints and falls back when unsupported", () => {
		expect(
			convertResponsesTools([makeTool({ constrainedSampling: { type: "json_schema", strict: "prefer" } })])[0],
		).toMatchObject({ type: "function", name: "sample_tool", strict: true });

		expect(() =>
			convertResponsesTools([makeTool({ constrainedSampling: { type: "json_schema", strict: "require" } })], {
				supportsStrictMode: false,
			}),
		).toThrow('Tool "sample_tool" requires JSON-schema constrained sampling');

		const grammarTool = makeTool({
			constrainedSampling: { type: "grammar", variants: { openai_lark: "start: /[a-z]+/" } },
		});
		expect(convertResponsesTools([grammarTool], { supportsOpenAIGrammarTools: true })[0]).toMatchObject({
			type: "custom",
			name: "sample_tool",
			format: { type: "grammar", syntax: "lark", definition: "start: /[a-z]+/" },
		});
		expect(() =>
			convertResponsesTools([makeTool({ constrainedSampling: { type: "grammar", variants: {} } })], {
				supportsOpenAIGrammarTools: true,
			}),
		).toThrow(
			'Tool "sample_tool" cannot use grammar constrained sampling: no supported grammar variant was provided',
		);

		const fallback = convertResponsesTools([grammarTool], {
			supportsOpenAIGrammarTools: false,
			supportsStrictMode: false,
		})[0];
		expect(fallback).toMatchObject({ type: "function", name: "sample_tool" });
		expect("strict" in (fallback as object)).toBe(false);

		expect(convertResponsesTools([makeTool({ constrainedSampling: false })])).toEqual(
			convertResponsesTools([makeTool()]),
		);
	});

	it("replays grammar calls as custom Responses items", () => {
		const replayedToolCall: ToolCall = {
			type: "toolCall",
			id: "call_1|ctc_1",
			name: "sample_tool",
			arguments: { payload: "abc" },
		};
		const context: Context = {
			messages: [
				{
					role: "assistant",
					api: "openai-responses",
					provider: "openai",
					model: "gpt-test",
					content: [replayedToolCall],
					usage: makeUsage(),
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "toolResult",
					toolCallId: "call_1|ctc_1",
					toolName: "sample_tool",
					content: [{ type: "text", text: "done" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};
		for (const invalidArguments of [{}, { payload: 42 }]) {
			replayedToolCall.arguments = invalidArguments;
			expect(() =>
				convertResponsesMessages(makeModel(), context, new Set(["openai"]), {
					grammarToolInputProperties: new Map([["sample_tool", "payload"]]),
				}),
			).toThrow('Grammar tool call "sample_tool" requires argument "payload" to be a string');
		}

		replayedToolCall.arguments = { payload: "abc" };
		const messages = convertResponsesMessages(makeModel(), context, new Set(["openai"]), {
			grammarToolInputProperties: new Map([["sample_tool", "payload"]]),
		});

		expect(messages).toContainEqual({
			type: "custom_tool_call",
			id: "ctc_1",
			call_id: "call_1",
			name: "sample_tool",
			input: "abc",
		});
		expect(messages).toContainEqual({
			type: "custom_tool_call_output",
			call_id: "call_1",
			output: "done",
		});
	});

	it("keeps grammar input JSON deltas append-only", () => {
		const buffer = { input: "", started: false, closed: false };
		const first = appendGrammarToolInputJsonDelta(buffer, "payload", 'a"', false);
		const second = appendGrammarToolInputJsonDelta(buffer, "payload", 'a"\nb', true);

		expect(JSON.parse(`${first}${second}`)).toEqual({ payload: 'a"\nb' });
		expect(appendGrammarToolInputJsonDelta(buffer, "payload", 'a"\nb', true)).toBeUndefined();
		expect(() => appendGrammarToolInputJsonDelta(buffer, "payload", "changed", true)).toThrow(
			'grammar tool input for property "payload" changed after it was closed',
		);
	});

	it("streams custom Responses tool calls as string arguments", async () => {
		const output = makeOutput();
		const stream = new AssistantMessageEventStream();
		const deltas = captureToolCallDeltas(stream);
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "custom_tool_call", call_id: "call_1", id: "ctc_1", name: "sample_tool", input: "" },
			},
			{
				type: "response.custom_tool_call_input.delta",
				output_index: 0,
				item_id: "ctc_1",
				delta: "ab",
			},
			{
				type: "response.custom_tool_call_input.done",
				output_index: 0,
				item_id: "ctc_1",
				input: "abc",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "custom_tool_call", call_id: "call_1", id: "ctc_1", name: "sample_tool", input: "abc" },
			},
			{
				type: "response.completed",
				response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
			},
		] as ResponseStreamEvent[];

		await processResponsesStream(iterateEvents(events), output, stream, makeModel(), {
			grammarToolInputProperties: new Map([["sample_tool", "payload"]]),
		});

		expect(output.stopReason).toBe("toolUse");
		expect(output.content).toEqual([
			{ type: "toolCall", id: "call_1|ctc_1", name: "sample_tool", arguments: { payload: "abc" } },
		]);
		expect(JSON.parse(deltas.join(""))).toEqual({ payload: "abc" });
	});
});
