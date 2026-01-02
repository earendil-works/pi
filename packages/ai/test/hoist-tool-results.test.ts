import { describe, expect, it } from "vitest";

// Inline the hoistToolResults function for testing
// (since it's not exported from the module)
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "../src/types.js";

function hoistToolResults(messages: Message[]): Message[] {
	const result: Message[] = [];

	for (const msg of messages) {
		if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			let parentIndex = -1;

			for (let i = result.length - 1; i >= 0; i--) {
				const m = result[i];
				if (m.role === "assistant") {
					const am = m as AssistantMessage;
					if (am.content.some((c) => c.type === "toolCall" && c.id === tr.toolCallId)) {
						parentIndex = i;
						break;
					}
				}
			}

			if (parentIndex !== -1) {
				let insertPos = parentIndex + 1;
				while (insertPos < result.length && result[insertPos].role === "toolResult") {
					insertPos++;
				}
				result.splice(insertPos, 0, msg);
			} else {
				result.push(msg);
			}
		} else {
			result.push(msg);
		}
	}

	return result;
}

describe("hoistToolResults", () => {
	it("hoists orphaned tool result to be adjacent to parent assistant", () => {
		const messages: Message[] = [
			// LLM starts a tool call
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_A", name: "bash", arguments: { command: "librarian add..." } }],
				api: "anthropic-messages",
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
				stopReason: "toolUse",
				timestamp: 1000,
			} as AssistantMessage,

			// User interrupts with !ls
			{
				role: "user",
				content: [{ type: "text", text: "[User executed shell command: ls]" }],
				timestamp: 2000,
			} as UserMessage,

			// Synthetic assistant for user bash
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "user_B", name: "bash", arguments: { command: "ls" } }],
				api: "anthropic-messages",
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
				stopReason: "toolUse",
				timestamp: 2001,
			} as AssistantMessage,

			// Result for user bash
			{
				role: "toolResult",
				toolCallId: "user_B",
				toolName: "bash",
				content: [{ type: "text", text: "file1.txt" }],
				isError: false,
				timestamp: 2002,
			} as ToolResultMessage,

			// Result for LLM's original call - ORPHANED!
			{
				role: "toolResult",
				toolCallId: "toolu_A",
				toolName: "bash",
				content: [{ type: "text", text: "Added book" }],
				isError: false,
				timestamp: 3000,
			} as ToolResultMessage,
		];

		const result = hoistToolResults(messages);

		// Expected order after hoisting:
		// [0] assistant (toolu_A)
		// [1] toolResult (toolu_A) <- HOISTED
		// [2] user
		// [3] assistant (user_B)
		// [4] toolResult (user_B)

		expect(result.length).toBe(5);
		expect(result[0].role).toBe("assistant");
		expect((result[0] as AssistantMessage).content[0]).toMatchObject({ type: "toolCall", id: "toolu_A" });

		expect(result[1].role).toBe("toolResult");
		expect((result[1] as ToolResultMessage).toolCallId).toBe("toolu_A");

		expect(result[2].role).toBe("user");

		expect(result[3].role).toBe("assistant");
		expect((result[3] as AssistantMessage).content[0]).toMatchObject({ type: "toolCall", id: "user_B" });

		expect(result[4].role).toBe("toolResult");
		expect((result[4] as ToolResultMessage).toolCallId).toBe("user_B");
	});

	it("handles multiple consecutive user bash commands", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "toolu_A", name: "bash", arguments: {} }],
				api: "anthropic-messages",
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
				stopReason: "toolUse",
				timestamp: 1000,
			} as AssistantMessage,

			// First user bash
			{ role: "user", content: [{ type: "text", text: "!cmd1" }], timestamp: 2000 } as UserMessage,
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "user_B", name: "bash", arguments: {} }],
				api: "anthropic-messages",
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
				stopReason: "toolUse",
				timestamp: 2001,
			} as AssistantMessage,
			{
				role: "toolResult",
				toolCallId: "user_B",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: 2002,
			} as ToolResultMessage,

			// Second user bash
			{ role: "user", content: [{ type: "text", text: "!cmd2" }], timestamp: 3000 } as UserMessage,
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "user_C", name: "bash", arguments: {} }],
				api: "anthropic-messages",
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
				stopReason: "toolUse",
				timestamp: 3001,
			} as AssistantMessage,
			{
				role: "toolResult",
				toolCallId: "user_C",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: 3002,
			} as ToolResultMessage,

			// LLM's original result - ORPHANED
			{
				role: "toolResult",
				toolCallId: "toolu_A",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: 4000,
			} as ToolResultMessage,
		];

		const result = hoistToolResults(messages);

		// toolu_A result should be hoisted to position 1
		expect(result[0].role).toBe("assistant");
		expect((result[0] as AssistantMessage).content[0]).toMatchObject({ id: "toolu_A" });
		expect(result[1].role).toBe("toolResult");
		expect((result[1] as ToolResultMessage).toolCallId).toBe("toolu_A");
	});

	it("handles no parent found gracefully", () => {
		const messages: Message[] = [
			// Orphan result with no parent (truncated history)
			{
				role: "toolResult",
				toolCallId: "unknown",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: 1000,
			} as ToolResultMessage,
		];

		const result = hoistToolResults(messages);

		// Should just append normally
		expect(result.length).toBe(1);
		expect(result[0].role).toBe("toolResult");
	});

	it("handles multiple tool calls in same assistant message", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "toolu_A", name: "read", arguments: {} },
					{ type: "toolCall", id: "toolu_B", name: "bash", arguments: {} },
				],
				api: "anthropic-messages",
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
				stopReason: "toolUse",
				timestamp: 1000,
			} as AssistantMessage,

			// User interrupts
			{ role: "user", content: [{ type: "text", text: "!ls" }], timestamp: 2000 } as UserMessage,
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "user_C", name: "bash", arguments: {} }],
				api: "anthropic-messages",
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
				stopReason: "toolUse",
				timestamp: 2001,
			} as AssistantMessage,
			{
				role: "toolResult",
				toolCallId: "user_C",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: 2002,
			} as ToolResultMessage,

			// Both LLM results arrive out of order
			{
				role: "toolResult",
				toolCallId: "toolu_B",
				toolName: "bash",
				content: [],
				isError: false,
				timestamp: 3000,
			} as ToolResultMessage,
			{
				role: "toolResult",
				toolCallId: "toolu_A",
				toolName: "read",
				content: [],
				isError: false,
				timestamp: 3001,
			} as ToolResultMessage,
		];

		const result = hoistToolResults(messages);

		// Both toolu_A and toolu_B results should be hoisted after assistant[0]
		expect(result[0].role).toBe("assistant");
		expect(result[1].role).toBe("toolResult");
		expect((result[1] as ToolResultMessage).toolCallId).toBe("toolu_B");
		expect(result[2].role).toBe("toolResult");
		expect((result[2] as ToolResultMessage).toolCallId).toBe("toolu_A");
	});
});
