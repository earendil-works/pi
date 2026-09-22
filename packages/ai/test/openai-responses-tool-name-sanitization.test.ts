import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import {
	convertResponsesMessages,
	convertResponsesTools,
	createToolNameMaps,
	processResponsesStream,
} from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Model, Tool, ToolCall } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-responses"> = {
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

const tool: Tool = {
	name: "mcp:server:tool",
	description: "A namespaced tool",
	parameters: { type: "object", properties: {} },
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
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

async function* createFunctionCallEvents(): AsyncIterable<ResponseStreamEvent> {
	yield {
		type: "response.output_item.added",
		sequence_number: 0,
		output_index: 0,
		item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "mcp_server_tool", arguments: "{}" },
	} as ResponseStreamEvent;
	yield {
		type: "response.output_item.done",
		sequence_number: 1,
		output_index: 0,
		item: {
			type: "function_call",
			id: "fc_1",
			call_id: "call_1",
			name: "mcp_server_tool",
			arguments: "{}",
		},
	} as ResponseStreamEvent;
	yield {
		type: "response.completed",
		sequence_number: 2,
		response: { id: "resp_1", status: "completed" },
	} as ResponseStreamEvent;
}

function getToolCall(output: AssistantMessage): ToolCall {
	const block = output.content[0];
	if (!block || block.type !== "toolCall") throw new Error("Expected toolCall block");
	return block;
}

describe("OpenAI Responses tool name sanitization", () => {
	it("sanitizes declared tool names", () => {
		const [declared] = convertResponsesTools([tool]);
		expect(declared).toMatchObject({ type: "function", name: "mcp_server_tool" });
	});

	it("sanitizes replayed tool calls", () => {
		const context = normalizeContext({
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "mcp:server:tool",
							arguments: {},
						},
					],
					timestamp: Date.now(),
				},
			],
		});

		const input = convertResponsesMessages(model, context, new Set(["openai"]));
		expect(input[0]).toEqual(expect.objectContaining({ type: "function_call", name: "mcp_server_tool" }));
	});

	it("maps sanitized stream tool names back to originals", async () => {
		const output = createOutput();
		await processResponsesStream(createFunctionCallEvents(), output, new AssistantMessageEventStream(), model, {
			toolNameMap: createToolNameMaps([tool]).reverse,
		});

		expect(getToolCall(output).name).toBe("mcp:server:tool");
	});
});
