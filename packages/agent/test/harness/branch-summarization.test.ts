import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { collectEntriesForBranchSummary } from "../../src/harness/compaction/branch-summarization.ts";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import type { Branch, Entry, MessageEntry, Session } from "../../src/harness/session/index.ts";

function message(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function messageEntry(id: string, parentId: string | null, text: string, seq: number): MessageEntry {
	return { type: "message", id, parentId, message: message(text), seq, timestamp: seq };
}

function branchReader(entries: Entry[]): {
	branch: Pick<Branch, "findEntries">;
	session: Pick<Session, "getEntry">;
} {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	return {
		session: {
			async getEntry(id) {
				return byId.get(id);
			},
		},
		branch: {
			async findEntries(query = {}) {
				const path: Entry[] = [];
				let currentId = query.start ?? null;
				while (currentId !== null) {
					const entry = byId.get(currentId);
					if (!entry) throw new Error(`Unknown entry ${currentId}`);
					path.push(entry);
					currentId = entry.parentId;
				}
				return path;
			},
		},
	};
}

describe("v4 branch summarization", () => {
	it("collects the abandoned side of a branch in chronological order", async () => {
		const root = messageEntry("root", null, "root", 1);
		const common = messageEntry("common", root.id, "common", 2);
		const abandoned1 = messageEntry("abandoned-1", common.id, "abandoned 1", 3);
		const abandoned2 = messageEntry("abandoned-2", abandoned1.id, "abandoned 2", 4);
		const target = messageEntry("target", common.id, "target", 5);
		const { branch, session } = branchReader([root, common, abandoned1, abandoned2, target]);

		const result = await collectEntriesForBranchSummary(
			branch,
			session,
			abandoned2.id,
			target.id,
			BACKGROUND_CONTEXT,
		);
		expect(result.commonAncestorId).toBe(common.id);
		expect(result.entries.map((entry) => entry.id)).toEqual([abandoned1.id, abandoned2.id]);
		expect(result.entries.some((entry) => entry.id === root.id)).toBe(false);
	});

	it("returns no entries when there was no previous leaf", async () => {
		const target = messageEntry("target", null, "target", 1);
		const { branch, session } = branchReader([target]);
		expect(await collectEntriesForBranchSummary(branch, session, null, target.id, BACKGROUND_CONTEXT)).toEqual({
			entries: [],
			commonAncestorId: null,
		});
	});
});
