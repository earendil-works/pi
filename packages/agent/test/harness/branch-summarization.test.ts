import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../../src/harness/compaction/branch-summarization.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function message(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

describe("v4 branch summarization", () => {
	it("collects the abandoned side of a branch in chronological order", async () => {
		let nextId = 0;
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }), {
			idGenerator: { next: () => `entry-${++nextId}` },
		});
		const rootId = await session.appendMessage(message("root"));
		const commonId = await session.appendMessage(message("common"));
		const abandonedIds = [
			await session.appendMessage(message("abandoned 1")),
			await session.appendMessage(message("abandoned 2")),
		];
		await session.createLane("target", commonId);
		const targetId = await session.view("target").appendMessage(message("target"));

		const result = await collectEntriesForBranchSummary(session, abandonedIds[1]!, targetId);
		expect(result.commonAncestorId).toBe(commonId);
		expect(result.entries.map((entry) => entry.id)).toEqual(abandonedIds);
		expect(result.entries.some((entry) => entry.id === rootId)).toBe(false);
	});

	it("returns no entries when there was no previous leaf", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session", createdAt: 1 }));
		const targetId = await session.appendMessage(message("target"));
		expect(await collectEntriesForBranchSummary(session, null, targetId)).toEqual({
			entries: [],
			commonAncestorId: null,
		});
	});
});
