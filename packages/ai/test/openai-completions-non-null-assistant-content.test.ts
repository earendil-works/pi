import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const baseCompat: Omit<Required<OpenAICompletionsCompat>, "deferredToolsMode"> & {
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresNonNullAssistantContent: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	supportsOpenAIGrammarTools: false,
	cacheControlFormat: "anthropic",
	sendSessionAffinityHeaders: false,
	sessionAffinityFormat: "openai",
	supportsLongCacheRetention: true,
};

function buildModel(): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return { ...baseModel, api: "openai-completions", input: ["text", "image"] };
}

function buildContext(model: Model<"openai-completions">): Context {
	const now = Date.now();
	const assistantMessage: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "true" } }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: now,
	};
	return {
		messages: [
			{ role: "user", content: "Run the command", timestamp: now - 1 },
			assistantMessage,
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: now + 1,
			},
			{ role: "user", content: "Thanks", timestamp: now + 2 },
		],
	};
}

describe("requiresNonNullAssistantContent", () => {
	it("sends null content for tool-call-only assistant messages by default", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), baseCompat);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages.length).toBe(1);
		expect(assistantMessages[0].content).toBe(null);
	});

	it("sends empty string content without inserting an assistant message after tool results", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), {
			...baseCompat,
			requiresNonNullAssistantContent: true,
		});
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "user"]);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages.length).toBe(1);
		expect(assistantMessages[0].content).toBe("");
	});

	it("still inserts an assistant message when requiresAssistantAfterToolResult is enabled", () => {
		const model = buildModel();
		const messages = convertMessages(model, buildContext(model), {
			...baseCompat,
			requiresAssistantAfterToolResult: true,
		});
		const roles = messages.map((message) => message.role);
		expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		const assistantMessages = messages.filter((message) => message.role === "assistant");
		expect(assistantMessages[0].content).toBe("");
		expect(assistantMessages[1].content).toBe("I have processed the tool results.");
	});
});
