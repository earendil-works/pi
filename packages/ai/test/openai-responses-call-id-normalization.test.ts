import type {
	ResponseFunctionToolCall,
	ResponseInputItem,
} from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.js";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Context, Message, Model, ToolCall, ToolResultMessage } from "../src/types.js";

const OPENAI_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

function makeOpenAIResponsesModel(): Model<"openai-responses"> {
	return {
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
}

function makeLongOpenAIToolCallId(): string {
	const longCallId = `call_${"a".repeat(90)}`;
	const longItemId = `reasoning|item/${"b".repeat(90)}`;
	return `${longCallId}|${longItemId}`;
}

function normalizeLikeOpenAIResponses(id: string): string {
	const [callId, itemId] = id.split("|");
	const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
	let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!sanitizedItemId.startsWith("fc")) {
		sanitizedItemId = `fc_${sanitizedItemId}`;
	}
	let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
	let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
	normalizedCallId = normalizedCallId.replace(/_+$/, "");
	normalizedItemId = normalizedItemId.replace(/_+$/, "");
	return `${normalizedCallId}|${normalizedItemId}`;
}

function makeAssistantToolCallMessage(toolCallId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: toolCallId,
				name: "bash",
				arguments: { command: "pwd" },
			},
		],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function makeToolResultMessage(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("OpenAI Responses call_id normalization", () => {
	it("normalizes same-model replayed tool call ids in transformMessages", () => {
		const model = makeOpenAIResponsesModel();
		const originalToolCallId = makeLongOpenAIToolCallId();
		const messages: Message[] = [
			{ role: "user", content: "run a tool", timestamp: Date.now() },
			makeAssistantToolCallMessage(originalToolCallId),
			makeToolResultMessage(originalToolCallId),
		];

		const transformed = transformMessages(messages, model, (id) => normalizeLikeOpenAIResponses(id));

		const assistant = transformed.find((msg) => msg.role === "assistant") as AssistantMessage;
		const toolCall = assistant.content.find((block) => block.type === "toolCall") as ToolCall;
		const toolResult = transformed.find((msg) => msg.role === "toolResult") as ToolResultMessage;

		expect(toolCall.id).not.toBe(originalToolCallId);
		expect(toolResult.toolCallId).toBe(toolCall.id);

		const [callId, itemId] = toolCall.id.split("|");
		expect(callId.length).toBeLessThanOrEqual(64);
		expect(itemId.length).toBeLessThanOrEqual(64);
	});

	it("sends normalized call_id values to the OpenAI Responses API on same-model replay", () => {
		const model = makeOpenAIResponsesModel();
		const originalToolCallId = makeLongOpenAIToolCallId();
		const context: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: [
				{ role: "user", content: "run a tool", timestamp: Date.now() },
				makeAssistantToolCallMessage(originalToolCallId),
				makeToolResultMessage(originalToolCallId),
			],
		};

		const payload = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS);
		const functionCall = payload.find(
			(item): item is ResponseFunctionToolCall =>
				typeof item === "object" && item !== null && "type" in item && item.type === "function_call",
		);
		const functionCallOutput = payload.find(
			(item): item is Extract<ResponseInputItem, { type: "function_call_output" }> =>
				typeof item === "object" && item !== null && "type" in item && item.type === "function_call_output",
		);

		expect(functionCall).toBeTruthy();
		expect(functionCallOutput).toBeTruthy();
		if (!functionCall || !functionCallOutput) {
			throw new Error("Expected both function_call and function_call_output items");
		}

		expect(functionCall.call_id.length).toBeLessThanOrEqual(64);
		expect(functionCallOutput.call_id.length).toBeLessThanOrEqual(64);
		expect(functionCall.call_id).toBe(functionCallOutput.call_id);
		expect(functionCall.call_id).not.toBe(originalToolCallId.split("|")[0]);
	});
});
