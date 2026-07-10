import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import {
	convertResponsesMessages,
	convertResponsesTools,
	processResponsesStream,
} from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5-mini",
	name: "GPT-5 Mini",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function createOutput(): AssistantMessage {
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
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function* createCustomToolCallEvents(input: string): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		output_index: 0,
		item: {
			id: "fc_patch",
			call_id: "call_patch",
			name: "apply_patch",
			type: "custom_tool_call",
			input: "",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.custom_tool_call_input.delta",
		output_index: 0,
		item_id: "fc_patch",
		sequence_number: 1,
		delta: input.slice(0, 10),
	} as ResponseStreamEvent;
	yield {
		type: "response.custom_tool_call_input.delta",
		output_index: 0,
		item_id: "fc_patch",
		sequence_number: 2,
		delta: input.slice(10),
	} as ResponseStreamEvent;
	yield {
		type: "response.custom_tool_call_input.done",
		output_index: 0,
		item_id: "fc_patch",
		sequence_number: 3,
		input,
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		output_index: 0,
		item: {
			id: "fc_patch",
			call_id: "call_patch",
			name: "apply_patch",
			type: "custom_tool_call",
			input,
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 4,
		response: { id: "resp_test", status: "completed" },
	} as ResponseStreamEvent;
}

describe("OpenAI Responses custom tools", () => {
	it("converts freeform tools to custom tools", () => {
		const tools = convertResponsesTools([
			{
				type: "freeform",
				name: "apply_patch",
				description: "Apply a patch",
				format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
			},
		]);

		expect(tools).toEqual([
			{
				type: "custom",
				name: "apply_patch",
				description: "Apply a patch",
				format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
			},
		]);
	});

	it("replays freeform tool calls and outputs as custom items", () => {
		const context: Context = {
			messages: [
				{
					...createOutput(),
					content: [
						{
							type: "toolCall",
							id: "call_patch|fc_patch",
							name: "apply_patch",
							inputType: "freeform",
							input: "*** Begin Patch\n*** End Patch",
						},
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "call_patch|fc_patch",
					toolName: "apply_patch",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai"]), { includeSystemPrompt: false });

		expect(input).toEqual([
			{
				type: "custom_tool_call",
				id: "fc_patch",
				call_id: "call_patch",
				name: "apply_patch",
				input: "*** Begin Patch\n*** End Patch",
			},
			{
				type: "custom_tool_call_output",
				call_id: "call_patch",
				output: "ok",
			},
		]);
	});

	it("replays legacy JSON tool calls without inputType as function items", () => {
		const legacyToolCall = {
			type: "toolCall",
			id: "call_bash|fc_bash",
			name: "bash",
			arguments: { command: "pwd" },
		} as unknown as ToolCall;
		const context: Context = {
			messages: [
				{
					...createOutput(),
					content: [legacyToolCall],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "call_bash|fc_bash",
					toolName: "bash",
					content: [{ type: "text", text: "/tmp" }],
					isError: false,
					timestamp: Date.now(),
				},
			],
		};

		const input = convertResponsesMessages(model, context, new Set(["openai"]), { includeSystemPrompt: false });

		expect(input).toEqual([
			{
				type: "function_call",
				id: "fc_bash",
				call_id: "call_bash",
				name: "bash",
				arguments: '{"command":"pwd"}',
			},
			{
				type: "function_call_output",
				call_id: "call_bash",
				output: "/tmp",
			},
		]);
	});

	it("parses streamed custom tool calls", async () => {
		const output = createOutput();
		const stream = new AssistantMessageEventStream();
		const input = "*** Begin Patch\n*** End Patch";

		await processResponsesStream(createCustomToolCallEvents(input), output, stream, model);

		expect(output.content).toHaveLength(1);
		const toolCall = output.content[0];
		expect(toolCall).toEqual({
			type: "toolCall",
			id: "call_patch|fc_patch",
			name: "apply_patch",
			inputType: "freeform",
			input,
		});
	});
});
