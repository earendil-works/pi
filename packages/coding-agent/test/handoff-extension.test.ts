import { describe, expect, it, vi } from "vitest";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "../src/core/session-manager.js";

vi.mock("@mariozechner/pi-coding-agent", async () => {
	const [{ convertToLlm }, { serializeConversation }, { buildSessionContext }] = await Promise.all([
		import("../src/core/messages.js"),
		import("../src/core/compaction/utils.js"),
		import("../src/core/session-manager.js"),
	]);

	return {
		BorderedLoader: class BorderedLoader {},
		buildSessionContext,
		convertToLlm,
		serializeConversation,
	};
});

import { buildHandoffConversation } from "../examples/extensions/handoff.js";

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

describe("handoff extension conversation context", () => {
	it("serializes compacted context instead of all raw branch messages", () => {
		const entries: SessionEntry[] = [
			msg("1", null, "user", "OLD RAW USER MESSAGE"),
			msg("2", "1", "assistant", "OLD RAW ASSISTANT MESSAGE"),
			msg("3", "2", "user", "KEPT USER MESSAGE"),
			msg("4", "3", "assistant", "KEPT ASSISTANT MESSAGE"),
			compaction("5", "4", "COMPACTED SESSION SUMMARY", "3"),
			msg("6", "5", "user", "RECENT USER MESSAGE"),
			msg("7", "6", "assistant", "RECENT ASSISTANT MESSAGE"),
		];

		const conversation = buildHandoffConversation({
			getEntries: () => entries,
			getLeafId: () => "7",
		});

		expect(conversation.messageCount).toBe(5);
		expect(conversation.text).toContain("COMPACTED SESSION SUMMARY");
		expect(conversation.text).toContain("KEPT USER MESSAGE");
		expect(conversation.text).toContain("KEPT ASSISTANT MESSAGE");
		expect(conversation.text).toContain("RECENT USER MESSAGE");
		expect(conversation.text).toContain("RECENT ASSISTANT MESSAGE");
		expect(conversation.text).not.toContain("OLD RAW USER MESSAGE");
		expect(conversation.text).not.toContain("OLD RAW ASSISTANT MESSAGE");
	});
});
