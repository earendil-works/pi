import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type {
	AssistantMessage,
	Context,
	Model,
	OpenAICompletionsCompat,
	ToolResultMessage,
	Usage,
} from "../src/types.ts";

const emptyUsage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const compat: Omit<Required<OpenAICompletionsCompat>, "deferredToolsMode"> & {
	deferredToolsMode?: OpenAICompletionsCompat["deferredToolsMode"];
} = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
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

function buildToolResult(toolCallId: string, timestamp: number, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

describe("openai-completions stripMediaMarkers", () => {
	it("strips |image| markers from tool results", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "curl /props" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Check props", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1, "Chat template with |image| marker"),
			],
		};

		const messages = convertMessages(model, context, compat);
		const toolMessage = messages.find((m) => m.role === "tool") as { role: "tool"; content: string } | undefined;
		expect(toolMessage).toBeTruthy();
		expect(toolMessage?.content).toContain("[image]");
		expect(toolMessage?.content).not.toContain("|image|");
	});

	it("strips <|image|> markers from tool results", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "curl /props" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Check props", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1, "Jinja: {{- '<|image|>' }}"),
			],
		};

		const messages = convertMessages(model, context, compat);
		const toolMessage = messages.find((m) => m.role === "tool") as { role: "tool"; content: string } | undefined;
		expect(toolMessage).toBeTruthy();
		expect(toolMessage?.content).toContain("[image]");
		expect(toolMessage?.content).not.toContain("<|image|>");
	});

	it("strips |img| and |video| markers from tool results", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "curl /props" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "Check props", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1, "Multiple |img| and |video| markers"),
			],
		};

		const messages = convertMessages(model, context, compat);
		const toolMessage = messages.find((m) => m.role === "tool") as { role: "tool"; content: string } | undefined;
		expect(toolMessage).toBeTruthy();
		expect(toolMessage?.content).toContain("[img]");
		expect(toolMessage?.content).toContain("[video]");
		expect(toolMessage?.content).not.toContain("|img|");
		expect(toolMessage?.content).not.toContain("|video|");
	});

	it("preserves normal tool results without markers", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		const model: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
			input: ["text"],
		};

		const now = Date.now();
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "ls" } }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage,
			stopReason: "toolUse",
			timestamp: now,
		};

		const context: Context = {
			messages: [
				{ role: "user", content: "List files", timestamp: now - 2 },
				assistantMessage,
				buildToolResult("tool-1", now + 1, "file1.txt\nfile2.txt"),
			],
		};

		const messages = convertMessages(model, context, compat);
		const toolMessage = messages.find((m) => m.role === "tool") as { role: "tool"; content: string } | undefined;
		expect(toolMessage).toBeTruthy();
		expect(toolMessage?.content).toBe("file1.txt\nfile2.txt");
	});
});
