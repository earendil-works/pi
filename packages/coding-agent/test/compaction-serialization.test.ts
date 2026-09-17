import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	// Regression for #9602: prevent thinking-only messages from inflating compaction prompts.
	it("truncates long thinking-only messages", () => {
		const head = "a".repeat(1000);
		const tail = "z".repeat(1000);
		const message = fauxAssistantMessage([{ type: "thinking", thinking: `${head}${"m".repeat(3000)}${tail}` }]);
		const marker = "[... 3000 more characters truncated]";
		const expected = `[Assistant thinking]: ${head}\n\n${marker}\n\n${tail}`;

		expect(serializeConversation([message])).toBe(expected);
	});

	it("preserves thinking at the character limit", () => {
		const thinking = "t".repeat(2000);
		const message = fauxAssistantMessage([{ type: "thinking", thinking }]);

		expect(serializeConversation([message])).toBe(`[Assistant thinking]: ${thinking}`);
	});

	it("treats whitespace-only text as thinking-only", () => {
		const head = "a".repeat(1000);
		const tail = "z".repeat(1000);
		const message = fauxAssistantMessage([
			{ type: "thinking", thinking: `${head}${"m".repeat(1000)}${tail}` },
			{ type: "text", text: " \n\t" },
		]);
		const marker = "[... 1000 more characters truncated]";
		const expected = `[Assistant thinking]: ${head}\n\n${marker}\n\n${tail}`;

		expect(serializeConversation([message])).toContain(expected);
	});

	it("preserves long thinking with meaningful text or tool calls", () => {
		const thinking = "t".repeat(5000);
		const withText = fauxAssistantMessage([
			{ type: "thinking", thinking },
			{ type: "text", text: "Answer" },
		]);
		const withTool = fauxAssistantMessage([
			{ type: "thinking", thinking },
			{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "file.ts" } },
		]);

		expect(serializeConversation([withText])).toBe(`[Assistant thinking]: ${thinking}\n\n[Assistant]: Answer`);
		expect(serializeConversation([withTool])).toBe(
			`[Assistant thinking]: ${thinking}\n\n[Assistant tool calls]: read(path="file.ts")`,
		);
	});

	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// First 2000 chars should be present
		expect(result).toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
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

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});
});
