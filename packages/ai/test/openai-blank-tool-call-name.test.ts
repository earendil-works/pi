import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { convertResponsesMessages, processResponsesStream } from "../src/api/openai-responses-shared.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage, Model, OpenAICompletionsCompat, ToolResultMessage, Usage } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const completionsCompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsThinkingTokenBudget: false,
	thinkingTokenBudgetField: undefined,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
} satisfies Omit<
	Required<OpenAICompletionsCompat>,
	"cacheControlFormat" | "thinkingTokenBudgetField" | "vllmPriority"
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
	thinkingTokenBudgetField?: OpenAICompletionsCompat["thinkingTokenBudgetField"];
};

function responsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function assistant(model: Model<AssistantMessage["api"]>, content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: toolName.length === 0,
		timestamp: 3,
	};
}

async function* responseEvents(events: unknown[]): AsyncIterable<ResponseStreamEvent> {
	for (const event of events) yield event as ResponseStreamEvent;
}

function functionCallItem(id: string, callId: string, name: string, argumentsJson: string) {
	return {
		type: "function_call" as const,
		id,
		call_id: callId,
		name,
		arguments: argumentsJson,
	};
}

describe("blank tool-call names", () => {
	it("omits a blank responses function call and its result, and keeps a named call", () => {
		const model = getModel("openai", "gpt-4o-mini");
		const input = convertResponsesMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "continue", timestamp: 1 },
					assistant(model, [
						{ type: "text", text: "kept" },
						{ type: "toolCall", id: "call_x|fc_x", name: "", arguments: {} },
					]),
					toolResult("call_x|fc_x", "", "Tool  not found"),
					assistant(model, [
						{ type: "toolCall", id: "call_y|fc_y", name: "bash", arguments: { command: "true" } },
					]),
					toolResult("call_y|fc_y", "bash", "ok"),
				],
			}),
			new Set(["openai", "openai-codex", "opencode"]),
		);

		const calls = input.filter((item) => item.type === "function_call");
		const outputs = input.filter((item) => item.type === "function_call_output");
		expect(calls.map((item) => (item.type === "function_call" ? item.name : ""))).toEqual(["bash"]);
		expect(outputs.map((item) => (item.type === "function_call_output" ? item.call_id : ""))).toEqual(["call_y"]);
		expect(outputs.map((item) => (item.type === "function_call_output" ? item.output : ""))).toEqual(["ok"]);
	});

	it("recovers one MiMo function name that is in the request tool list", async () => {
		const model = responsesModel();
		const output = assistant(model, []);
		output.content = [];
		output.stopReason = "pending";
		const malformed =
			"<tool_call><function=subagent_wait</parameter><parameter=id>abc</parameter></function></tool_call>";
		await processResponsesStream(
			responseEvents([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_1", content: [], role: "assistant", status: "in_progress" },
				},
				{ type: "response.output_text.delta", output_index: 0, delta: malformed },
				{
					type: "response.output_item.done",
					sequence_number: 3,
					output_index: 0,
					item: {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: malformed, annotations: [] }],
					},
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: functionCallItem("fc_1", "call_1", "", ""),
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: functionCallItem("fc_1", "call_1", "", ""),
				},
				{
					type: "response.completed",
					response: { id: "resp_1", status: "completed", output: [] },
				},
			]),
			output,
			new AssistantMessageEventStream(),
			model,
			{ toolNames: new Set(["subagent_wait", "bash"]) },
		);

		const calls = output.content.filter((block) => block.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.type === "toolCall" ? calls[0].name : "").toBe("subagent_wait");
		expect(output.stopReason).toBe("toolUse");
	});

	it("drops an unknown function tag and leaves stopReason stop", async () => {
		const model = responsesModel();
		const output = assistant(model, []);
		output.content = [];
		output.stopReason = "pending";
		await processResponsesStream(
			responseEvents([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: { type: "message", id: "msg_2", content: [], role: "assistant", status: "in_progress" },
				},
				{
					type: "response.output_item.done",
					sequence_number: 2,
					output_index: 0,
					item: {
						type: "message",
						id: "msg_2",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: "<function=not_a_tool>", annotations: [] }],
					},
				},
				{
					type: "response.output_item.added",
					output_index: 1,
					item: functionCallItem("fc_2", "call_2", "", "{}"),
				},
				{
					type: "response.output_item.done",
					output_index: 1,
					item: functionCallItem("fc_2", "call_2", "", "{}"),
				},
				{
					type: "response.completed",
					response: { id: "resp_2", status: "completed", output: [] },
				},
			]),
			output,
			new AssistantMessageEventStream(),
			model,
			{ toolNames: new Set(["subagent_wait"]) },
		);

		expect(output.content.some((block) => block.type === "toolCall")).toBe(false);
		expect(output.stopReason).toBe("stop");
	});

	it("keeps a function name that arrives on output_item.done", async () => {
		const model = responsesModel();
		const output = assistant(model, []);
		output.content = [];
		output.stopReason = "pending";
		const argumentsJson = '{"command":"pwd"}';
		await processResponsesStream(
			responseEvents([
				{
					type: "response.output_item.added",
					output_index: 0,
					item: functionCallItem("fc_3", "call_3", "", ""),
				},
				{
					type: "response.function_call_arguments.delta",
					output_index: 0,
					delta: argumentsJson,
				},
				{
					type: "response.output_item.done",
					output_index: 0,
					item: functionCallItem("fc_3", "call_3", "bash", argumentsJson),
				},
				{
					type: "response.completed",
					response: { id: "resp_3", status: "completed", output: [] },
				},
			]),
			output,
			new AssistantMessageEventStream(),
			model,
			{ toolNames: new Set(["bash"]) },
		);

		expect(output.content).toHaveLength(1);
		const call = output.content[0];
		expect(call?.type).toBe("toolCall");
		if (call?.type !== "toolCall") throw new Error("Expected toolCall");
		expect(call.name).toBe("bash");
		expect(call.arguments).toEqual({ command: "pwd" });
		expect(output.stopReason).toBe("toolUse");
	});

	it("omits a blank chat-completions tool call and its result", () => {
		const model: Model<"openai-completions"> = {
			id: "repro-model",
			name: "Repro Model",
			api: "openai-completions",
			provider: "repro-provider",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const messages = convertMessages(
			model,
			normalizeContext({
				messages: [
					{ role: "user", content: "continue", timestamp: 1 },
					assistant(model, [
						{ type: "text", text: "kept" },
						{ type: "toolCall", id: "call_blank", name: "", arguments: {} },
					]),
					toolResult("call_blank", "", "Tool  not found"),
					assistant(model, [{ type: "toolCall", id: "call_bash", name: "bash", arguments: { command: "true" } }]),
					toolResult("call_bash", "bash", "ok"),
				],
			}),
			completionsCompat,
		);

		const names = messages.flatMap((message) => {
			if (message.role !== "assistant" || message.tool_calls === undefined) return [];
			return message.tool_calls.flatMap((call) => (call.type === "function" ? [call.function.name] : []));
		});
		expect(names).toEqual(["bash"]);
		const toolMessages = messages.filter((message) => message.role === "tool");
		expect(toolMessages.map((message) => message.tool_call_id)).toEqual(["call_bash"]);
	});
});
