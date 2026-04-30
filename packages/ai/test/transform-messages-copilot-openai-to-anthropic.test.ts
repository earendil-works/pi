import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/providers/transform-messages.js";
import type { AssistantMessage, Message, Model, ToolCall } from "../src/types.js";

// Normalize function matching what anthropic.ts uses
function anthropicNormalizeToolCallId(
	id: string,
	_model: Model<"anthropic-messages">,
	_source: AssistantMessage,
): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function makeCopilotClaudeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "github-copilot",
		model: "gpt-5",
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

describe("OpenAI to Anthropic session migration for Copilot Claude", () => {
	it("converts thinking blocks to plain text when source model differs", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "Let me think about this...",
						thinkingSignature: "reasoning_content",
					},
					{ type: "text", text: "Hi there!" },
				],
				api: "openai-completions",
				provider: "github-copilot",
				model: "gpt-4o",
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
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;

		// Thinking block should be converted to text since models differ
		const textBlocks = assistantMsg.content.filter((b) => b.type === "text");
		const thinkingBlocks = assistantMsg.content.filter((b) => b.type === "thinking");
		expect(thinkingBlocks).toHaveLength(0);
		expect(textBlocks.length).toBeGreaterThanOrEqual(2);
	});

	it("removes thoughtSignature from tool calls when migrating between models", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call_123",
						name: "bash",
						arguments: { command: "ls" },
						thoughtSignature: JSON.stringify({ type: "reasoning.encrypted", id: "call_123", data: "encrypted" }),
					},
				],
				api: "openai-responses",
				provider: "github-copilot",
				model: "gpt-5",
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
			},
			{
				role: "toolResult",
				toolCallId: "call_123",
				toolName: "bash",
				content: [{ type: "text", text: "output" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const assistantMsg = result.find((m) => m.role === "assistant") as AssistantMessage;
		const toolCall = assistantMsg.content.find((b) => b.type === "toolCall") as ToolCall;

		expect(toolCall.thoughtSignature).toBeUndefined();
	});

	it("adds synthetic tool results for trailing orphaned tool calls", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "read the file", timestamp: Date.now() },
			makeAssistantMessage([
				{
					type: "toolCall",
					id: "call_123|fc_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			]),
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const lastMessage = result[result.length - 1];

		expect(lastMessage).toMatchObject({
			role: "toolResult",
			toolCallId: "call_123_fc_123",
			toolName: "read",
			isError: true,
			content: [{ type: "text", text: "No result provided" }],
		});
	});

	it("adds synthetic results only for trailing tool calls that are still missing results", () => {
		const model = makeCopilotClaudeModel();
		const messages: Message[] = [
			{ role: "user", content: "run commands", timestamp: Date.now() },
			makeAssistantMessage([
				{ type: "toolCall", id: "call_1|fc_1", name: "read", arguments: { path: "README.md" } },
				{ type: "toolCall", id: "call_2|fc_2", name: "bash", arguments: { command: "pwd" } },
			]),
			{
				role: "toolResult",
				toolCallId: "call_1|fc_1",
				toolName: "read",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = transformMessages(messages, model, anthropicNormalizeToolCallId);
		const syntheticResults = result.filter((message) => message.role === "toolResult" && message.isError);

		expect(syntheticResults).toHaveLength(1);
		expect(syntheticResults[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "call_2_fc_2",
			toolName: "bash",
			content: [{ type: "text", text: "No result provided" }],
		});
	});
});
