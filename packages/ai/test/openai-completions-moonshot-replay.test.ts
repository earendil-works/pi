import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/providers/openai-completions.js";
import type { AssistantMessage, Context, Model, OpenAICompletionsCompat, Usage } from "../src/types.js";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const baseCompat = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: true,
	reasoningContentFallback: "",
	thinkingFormat: "openai",
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

function buildModel(): Model<"openai-completions"> {
	return {
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		provider: "moonshotai",
		baseUrl: "https://api.moonshot.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
		compat: {},
	};
}

function buildAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "moonshotai",
		model: "kimi-k2.6",
		usage: emptyUsage,
		stopReason: "stop",
		timestamp: 2,
	};
}

function buildContextWithToolCall(assistant: AssistantMessage): Context {
	return {
		messages: [
			{ role: "user", content: "run a tool", timestamp: 1 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "echo",
				content: [{ type: "text", text: "hi" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user", content: "continue", timestamp: 4 },
		],
	};
}

function readReasoningContent(msg: unknown): string | undefined {
	if (msg && typeof msg === "object" && "reasoning_content" in msg) {
		const value = (msg as { reasoning_content?: unknown }).reasoning_content;
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}

describe("openai-completions reasoning_content fallback on assistant tool-call replay", () => {
	it("uses configured reasoningContentFallback when assistant has tool_calls but no thinking", () => {
		const compat = { ...baseCompat, reasoningContentFallback: " " };
		const messages = convertMessages(
			buildModel(),
			buildContextWithToolCall(
				buildAssistant([{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } }]),
			),
			compat,
		);
		const assistantMsg = messages[1];
		expect(assistantMsg?.role).toBe("assistant");
		expect(readReasoningContent(assistantMsg)).toBe(" ");
	});

	it("defaults to empty string when reasoningContentFallback is not configured", () => {
		const messages = convertMessages(
			buildModel(),
			buildContextWithToolCall(
				buildAssistant([{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } }]),
			),
			baseCompat,
		);
		const assistantMsg = messages[1];
		expect(assistantMsg?.role).toBe("assistant");
		expect(readReasoningContent(assistantMsg)).toBe("");
	});

	it("does not overwrite reasoning_content when thinking blocks have set it via signature", () => {
		const compat = { ...baseCompat, reasoningContentFallback: " " };
		const messages = convertMessages(
			buildModel(),
			buildContextWithToolCall(
				buildAssistant([
					{ type: "thinking", thinking: "real reasoning", thinkingSignature: "reasoning_content" },
					{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } },
				]),
			),
			compat,
		);
		const assistantMsg = messages[1];
		expect(assistantMsg?.role).toBe("assistant");
		expect(readReasoningContent(assistantMsg)).toBe("real reasoning");
	});

	it("does not set reasoning_content when requiresReasoningContentOnAssistantMessages is false", () => {
		const compat = {
			...baseCompat,
			requiresReasoningContentOnAssistantMessages: false,
			reasoningContentFallback: " ",
		};
		const messages = convertMessages(
			buildModel(),
			buildContextWithToolCall(
				buildAssistant([{ type: "toolCall", id: "call_1", name: "echo", arguments: { text: "hi" } }]),
			),
			compat,
		);
		const assistantMsg = messages[1];
		expect(assistantMsg?.role).toBe("assistant");
		expect(readReasoningContent(assistantMsg)).toBeUndefined();
	});
});
