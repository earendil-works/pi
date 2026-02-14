import type { AssistantMessage, Message, ToolResultMessage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";

import { extractHandoffFileTracking } from "../src/handoff-file-tracking.js";

describe("extractHandoffFileTracking", () => {
	it("derives read/modified files deterministically from tool calls (including apply_patch)", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: "dummy",
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "tool_1",
					name: "read",
					arguments: { path: "src/readme.md", offset: 1, limit: 50 },
				},
				{
					type: "toolCall",
					id: "tool_2",
					name: "write",
					arguments: { path: "src/new-file.ts", content: "console.log('hi')" },
				},
				{
					type: "toolCall",
					id: "tool_3",
					name: "edit",
					arguments: { path: "src/existing.ts", oldText: "a", newText: "b" },
				},
				{
					type: "toolCall",
					id: "tool_4",
					name: "apply_patch",
					arguments: {
						input: [
							"*** Begin Patch",
							"*** Update File: src/patched.ts",
							"@@",
							"-old",
							"+new",
							"*** End Patch",
						].join("\n"),
					},
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
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		};

		const messages: Message[] = [
			{ role: "user", content: "do stuff", timestamp: Date.now() },
			assistantMsg,
			toolResultMsg,
		];

		const tracking = extractHandoffFileTracking(messages);
		expect(tracking.readFiles).toEqual(["src/readme.md"]);
		expect(tracking.modifiedFiles).toEqual(["src/new-file.ts", "src/existing.ts", "src/patched.ts"]);
	});

	it("dedupes paths while preserving first-seen order", () => {
		const assistantMsg: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: "dummy",
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "t2", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "t3", name: "write", arguments: { path: "b.ts", content: "x" } },
				{ type: "toolCall", id: "t4", name: "edit", arguments: { path: "b.ts", oldText: "x", newText: "y" } },
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

		const tracking = extractHandoffFileTracking([assistantMsg]);
		expect(tracking.readFiles).toEqual(["a.ts"]);
		expect(tracking.modifiedFiles).toEqual(["b.ts"]);
	});
});
