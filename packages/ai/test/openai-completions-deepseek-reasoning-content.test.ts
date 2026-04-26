import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/openai-completions.js";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
} from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	reasoningEffortMap: {},
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: true,
	thinkingFormat: "deepseek",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	zaiToolStream: false,
	supportsStrictMode: true,
	cacheControlFormat: undefined,
	sendSessionAffinityHeaders: false,
	supportsLongCacheRetention: true,
} satisfies Required<Omit<OpenAICompletionsCompat, "cacheControlFormat">> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

interface AssistantReplayMessage {
	role: "assistant";
	content?: unknown;
	reasoning_content?: string;
	tool_calls?: unknown;
}

function buildModel(): Model<"openai-completions"> {
	return {
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-completions",
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat,
	};
}

function buildAssistant(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "deepseek",
		model: "deepseek-v4-flash",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp,
	};
}

function buildToolResult(timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "tool-1",
		toolName: "read",
		content: [{ type: "text", text: "tool result" }],
		isError: false,
		timestamp,
	};
}

describe("openai-completions DeepSeek reasoning_content replay", () => {
	it("replays prior thinking as reasoning_content across a tool-result follow-up assistant message", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Inspect the file", timestamp: 1 },
				buildAssistant(
					[
						{
							type: "thinking",
							thinking: "I should inspect the file before answering.",
							thinkingSignature: "reasoning_content",
						},
						{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "notes.md" } },
					],
					2,
				),
				buildToolResult(3),
				buildAssistant([{ type: "text", text: "The file contains project notes." }], 4),
				{ role: "user", content: "Continue", timestamp: 5 },
			],
		};

		const messages = convertMessages(buildModel(), context, compat);
		const toolCallingAssistant = messages[1] as AssistantReplayMessage;
		const followUpAssistant = messages[3] as AssistantReplayMessage;

		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "user"]);
		expect(toolCallingAssistant.reasoning_content).toBe("I should inspect the file before answering.");
		expect(toolCallingAssistant.tool_calls).toBeDefined();
		expect(followUpAssistant).toMatchObject({
			role: "assistant",
			content: "The file contains project notes.",
			reasoning_content: "I should inspect the file before answering.",
		});
	});

	it("does not replay stale reasoning after an ordinary user turn", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Think first", timestamp: 1 },
				buildAssistant(
					[
						{ type: "thinking", thinking: "Initial reasoning.", thinkingSignature: "reasoning_content" },
						{ type: "text", text: "Visible answer." },
					],
					2,
				),
				{ role: "user", content: "New request", timestamp: 3 },
				buildAssistant([{ type: "text", text: "New visible answer without thinking." }], 4),
			],
		};

		const messages = convertMessages(buildModel(), context, compat);
		const nextAssistant = messages[3] as AssistantReplayMessage;

		expect(nextAssistant).toMatchObject({
			role: "assistant",
			content: "New visible answer without thinking.",
			reasoning_content: "",
		});
	});
});
