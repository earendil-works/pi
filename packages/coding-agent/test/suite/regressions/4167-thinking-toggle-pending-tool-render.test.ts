import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { buildTranscriptProjectionFromEntries } from "../../../src/core/transcript-projection.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

describe("issue #4167 pending tool rendering", () => {
	test("display refreshes during streaming do not replace pending live tools", () => {
		const pendingTool = { id: TOOL_CALL_ID };
		const fakeThis = {
			session: { isStreaming: true },
			streamingComponent: undefined,
			pendingTools: new Map([[TOOL_CALL_ID, pendingTool]]),
			transcriptDocument: { invalidate: vi.fn() },
			rebuildTranscriptHistory: vi.fn(),
		};
		const refresh = Reflect.get(InteractiveMode.prototype, "refreshTranscriptHistory") as (
			this: typeof fakeThis,
		) => void;

		refresh.call(fakeThis);

		expect(fakeThis.pendingTools.get(TOOL_CALL_ID)).toBe(pendingTool);
		expect(fakeThis.transcriptDocument.invalidate).toHaveBeenCalledOnce();
		expect(fakeThis.rebuildTranscriptHistory).not.toHaveBeenCalled();
	});

	test("completed historical results pair with their tool block and never become pending live state", () => {
		const projection = buildTranscriptProjectionFromEntries(
			createSessionEntries([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);
		const tool = projection.blocks.find((block) => block.kind === "tool");

		expect(tool?.kind).toBe("tool");
		if (tool?.kind !== "tool") throw new Error("Expected projected tool block");
		expect(tool.result?.content).toEqual([{ type: "text", text: "HISTORICAL_RESULT" }]);
		expect(projection.unpairedToolResults).toEqual([]);
	});
});
