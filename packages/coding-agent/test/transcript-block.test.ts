import type { AssistantMessage, ToolCall, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { getTranscriptTarget, Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { SessionMessageEntry } from "../src/core/session-manager.ts";
import {
	createMessageTranscriptTarget,
	createToolTranscriptTarget,
	type MessageTranscriptMetadata,
	type ToolTranscriptMetadata,
	TranscriptBlockComponent,
} from "../src/modes/interactive/transcript-block.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function entry(id: string, message: SessionMessageEntry["message"]): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message };
}

describe("transcript block targets", () => {
	it("preserves original message and entry object identities", () => {
		const message: UserMessage = { role: "user", content: "question", timestamp: 1 };
		const messageEntry = entry("user-entry", message);
		const target = createMessageTranscriptTarget("entry:user", "user", message, messageEntry);
		const component = new TranscriptBlockComponent(target, [new Text("question", 0, 0)]);
		const metadata = getTranscriptTarget(component)?.metadata as MessageTranscriptMetadata;

		expect(component.render(80).map((line) => line.trimEnd())).toEqual(["question"]);
		expect(metadata.message).toBe(message);
		expect(metadata.entry).toBe(messageEntry);
	});

	it("updates provisional live metadata without changing semantic identity", () => {
		const initial: UserMessage = { role: "user", content: "partial", timestamp: 1 };
		const complete: UserMessage = { role: "user", content: "complete", timestamp: 1 };
		const component = new TranscriptBlockComponent(createMessageTranscriptTarget("live:1", "user", initial), [
			new Text("complete", 0, 0),
		]);

		component.setMetadata({ message: complete });

		expect(getTranscriptTarget(component)).toEqual({
			id: "live:1",
			kind: "user",
			metadata: { message: complete },
		});
	});

	it("preserves paired tool metadata and stable target identity", () => {
		const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } };
		const message: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2,
		};
		const messageEntry = entry("assistant-entry", message);
		const resultEntry = entry("result-entry", result);
		const target = createToolTranscriptTarget("entry:assistant:tool:call-1:0", {
			entry: messageEntry,
			message,
			toolCall,
			resultEntry,
			result,
		});
		const metadata = target.metadata as ToolTranscriptMetadata;

		expect(target.id).toBe("entry:assistant:tool:call-1:0");
		expect(metadata.entry).toBe(messageEntry);
		expect(metadata.message).toBe(message);
		expect(metadata.toolCall).toBe(toolCall);
		expect(metadata.resultEntry).toBe(resultEntry);
		expect(metadata.result).toBe(result);
	});
});
