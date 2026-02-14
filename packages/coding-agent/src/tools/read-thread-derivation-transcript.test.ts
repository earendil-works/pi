import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@kennyfrc/mu-ai";
import { describe, expect, it } from "vitest";
import { selectReadThreadChunks } from "./read-thread-chunk-selection.js";
import { formatMessagesForReadThreadDerivation, type IndexedMessage } from "./read-thread-derivation-transcript.js";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function makeUserMessage(text: string, timestamp: number): Message {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function makeAssistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp,
	};
}

function makeToolResultMessage(text: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "glob",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

describe("read_thread derivation transcript", () => {
	it("selects tail-biased chunks and inserts skipped-message markers", () => {
		const indexed: IndexedMessage[] = Array.from({ length: 20 }, (_, i) => ({
			index: i,
			message: makeUserMessage(`m${i}`, i),
		}));

		const selection = selectReadThreadChunks({
			messages: indexed,
			goal: "Find details about m2",
			maxSelectedMessages: 10,
			alwaysIncludeLastN: 4,
			hitWindowRadius: 1,
		});

		const selectedIndices = selection.selected.map((m) => m.index);
		expect(selectedIndices).toEqual([1, 2, 3, 16, 17, 18, 19]);

		const transcript = formatMessagesForReadThreadDerivation(selection.selected, { maxTranscriptChars: 50_000 });
		expect(transcript).toContain("#2 User: m2");
		expect(transcript).toContain("...[skipped messages 4-15]...");
	});

	it("includes assistant thinking blocks, tool args, and truncates tool results", () => {
		const longOutput = "x".repeat(5000);
		const indexed: IndexedMessage[] = [
			{
				index: 0,
				message: makeAssistantMessage(
					[
						{ type: "thinking", thinking: "plan: do the thing" },
						{ type: "text", text: "Running glob." },
						{ type: "toolCall", id: "call-1", name: "glob", arguments: { pattern: "**/*.ts", path: "/x" } },
					],
					0,
				),
			},
			{ index: 1, message: makeToolResultMessage(longOutput, 1) },
		];

		const transcript = formatMessagesForReadThreadDerivation(indexed, { maxTranscriptChars: 50_000 });
		expect(transcript).toContain("AssistantThinking: plan: do the thing");
		expect(transcript).toContain("ToolCall: glob");
		expect(transcript).toContain('"pattern"');
		expect(transcript).toContain('"path"');

		expect(transcript).toContain("ToolResult(glob):");
		expect(transcript).toContain("[truncated");
	});
});
