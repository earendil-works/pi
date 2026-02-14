import type { AssistantMessage, Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

import { formatMessagesForHandoffSelection } from "../src/handoff-selection-transcript.js";

describe("formatMessagesForHandoffSelection", () => {
	it("includes tool-call arguments (e.g. Read.path) so file selection can see filenames", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: "dummy",
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "Reading a file..." },
				{
					type: "toolCall",
					id: "tool_1",
					name: "read",
					arguments: { path: "packages/coding-agent/src/tui/tui-renderer.ts", offset: 10, limit: 20 },
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const toolResultMsg: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "tool_1",
			toolName: "read",
			content: [{ type: "text", text: "(file contents omitted)" }],
			isError: false,
			timestamp: Date.now(),
		};

		const messages: Message[] = [
			{ role: "user", content: "Please help", timestamp: Date.now() },
			assistantMsg,
			toolResultMsg,
		];

		const transcript = formatMessagesForHandoffSelection(messages);
		expect(transcript).toContain("[ToolCall read");
		expect(transcript).toContain("packages/coding-agent/src/tui/tui-renderer.ts");
	});
});
