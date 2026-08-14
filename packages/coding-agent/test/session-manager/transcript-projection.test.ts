import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	buildTranscriptProjection,
	type TranscriptBlock,
	type TranscriptToolBlock,
} from "../../src/core/transcript-projection.ts";

const usage: Usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolResult(toolCallId: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function blockEntryIds(blocks: readonly TranscriptBlock[]): string[] {
	return blocks.map((block) => block.entryId);
}

function toolBlocks(blocks: readonly TranscriptBlock[]): TranscriptToolBlock[] {
	return blocks.filter((block): block is TranscriptToolBlock => block.kind === "tool");
}

describe("transcript block projection", () => {
	it("keeps the full human branch while repeated compaction narrows model context", () => {
		const session = SessionManager.inMemory();
		const user1 = session.appendMessage(user("one"));
		const assistant1 = session.appendMessage(assistant([{ type: "text", text: "answer one" }]));
		const user2 = session.appendMessage(user("two"));
		const assistant2 = session.appendMessage(assistant([{ type: "text", text: "answer two" }]));
		const compaction1 = session.appendCompaction("first summary", user2, 100);
		const user3 = session.appendMessage(user("three"));
		const assistant3 = session.appendMessage(assistant([{ type: "text", text: "answer three" }]));
		const compaction2 = session.appendCompaction("second summary", user3, 200);
		const user4 = session.appendMessage(user("four"));

		const firstProjection = buildTranscriptProjection(session);
		const secondProjection = buildTranscriptProjection(session);
		const fullHumanEntryIds = [
			user1,
			assistant1,
			user2,
			assistant2,
			compaction1,
			user3,
			assistant3,
			compaction2,
			user4,
		];

		expect(blockEntryIds(firstProjection.blocks)).toEqual(fullHumanEntryIds);
		expect(secondProjection.blocks.map((block) => block.id)).toEqual(firstProjection.blocks.map((block) => block.id));
		expect(session.buildContextEntries().map((entry) => entry.id)).toEqual([compaction2, user3, assistant3, user4]);
	});

	it("follows only the active branch and renders a branch summary at the new branch point", () => {
		const session = SessionManager.inMemory();
		const root = session.appendMessage(user("root"));
		const common = session.appendMessage(assistant([{ type: "text", text: "common" }]));
		const abandonedUser = session.appendMessage(user("abandoned"));
		const abandonedAssistant = session.appendMessage(assistant([{ type: "text", text: "abandoned answer" }]));

		session.branch(common);
		const firstAlternative = session.appendMessage(user("first alternative"));
		const firstAlternativeAnswer = session.appendMessage(assistant([{ type: "text", text: "first answer" }]));

		const summary = session.branchWithSummary(common, "Summary of abandoned work");
		const activeUser = session.appendMessage(user("active alternative"));
		const projection = buildTranscriptProjection(session);

		expect(blockEntryIds(projection.blocks)).toEqual([root, common, summary, activeUser]);
		expect(blockEntryIds(projection.blocks)).not.toContain(abandonedUser);
		expect(blockEntryIds(projection.blocks)).not.toContain(abandonedAssistant);
		expect(blockEntryIds(projection.blocks)).not.toContain(firstAlternative);
		expect(blockEntryIds(projection.blocks)).not.toContain(firstAlternativeAnswer);

		const summaryBlock = projection.blocks.find((block) => block.entryId === summary);
		expect(summaryBlock?.kind).toBe("entry");
		expect(summaryBlock?.entry.type).toBe("branch_summary");
	});

	it("gives assistant sub-blocks stable IDs and pairs tool results with their calls", () => {
		const session = SessionManager.inMemory();
		session.appendMessage(user("use tools"));
		const assistantEntry = session.appendMessage(
			assistant([
				{ type: "thinking", thinking: "inspect both files" },
				{ type: "toolCall", id: "call/a", name: "read", arguments: { path: "a.ts" } },
				{ type: "text", text: "and" },
				{ type: "toolCall", id: "call/b", name: "read", arguments: { path: "b.ts" } },
			]),
		);

		const pendingProjection = buildTranscriptProjection(session);
		const pendingTools = toolBlocks(pendingProjection.blocks);
		expect(pendingTools).toHaveLength(2);
		expect(pendingTools.map((block) => block.entryId)).toEqual([assistantEntry, assistantEntry]);
		expect(new Set(pendingTools.map((block) => block.id)).size).toBe(2);
		expect(pendingTools.map((block) => block.contentIndex)).toEqual([1, 3]);

		const resultA = session.appendMessage(toolResult("call/a", "a contents"));
		const resultB = session.appendMessage(toolResult("call/b", "b contents"));
		const completedProjection = buildTranscriptProjection(session);
		const completedTools = toolBlocks(completedProjection.blocks);

		expect(completedTools.map((block) => block.id)).toEqual(pendingTools.map((block) => block.id));
		expect(completedTools.map((block) => block.resultEntry?.id)).toEqual([resultA, resultB]);
		expect(completedTools.map((block) => block.result?.toolCallId)).toEqual(["call/a", "call/b"]);
		expect(blockEntryIds(completedProjection.blocks)).not.toContain(resultA);
		expect(blockEntryIds(completedProjection.blocks)).not.toContain(resultB);
		expect(completedProjection.unpairedToolResults).toEqual([]);

		const unpaired = session.appendMessage(toolResult("missing-call", "orphan"));
		const malformedProjection = buildTranscriptProjection(session);
		expect(malformedProjection.unpairedToolResults.map(({ entry }) => entry.id)).toEqual([unpaired]);
	});
});
