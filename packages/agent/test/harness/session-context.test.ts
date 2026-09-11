import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { buildSessionContext } from "../../src/harness/session/context.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	CustomEntry,
	MessageEntry,
} from "../../src/harness/session/types.ts";
import type { AgentMessage } from "../../src/types.ts";

const NOW = 1_700_000_000_000;
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: NOW };
}

function assistantMessage(stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage {
	return {
		role: "assistant",
		content:
			stopReason === "toolUse"
				? [{ type: "toolCall", id: "call", name: "read", arguments: {} }]
				: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage,
		stopReason,
		...(stopReason === "deferred"
			? { deferred: { provider: "anthropic", modelId: "claude-sonnet-4-5", api: "anthropic-messages", id: "job" } }
			: {}),
		timestamp: NOW,
	};
}

function messageEntry(id: string, parentId: string | null, seq: number, message: AgentMessage): MessageEntry {
	return { id, parentId, seq, timestamp: NOW, type: "message", message };
}

describe("session context projection", () => {
	it("filters non-context assistant response entries while preserving valid messages", async () => {
		const user = userMessage("question");
		const stopped = assistantMessage("stop", "answer");
		const length = assistantMessage("length", "truncated answer");
		const toolUse = assistantMessage("toolUse", "");
		const failed = assistantMessage("error", "failed");
		const aborted = assistantMessage("aborted", "aborted");
		const deferred = assistantMessage("deferred", "");
		const entries = [
			messageEntry("user", null, 1, user),
			messageEntry("failed", "user", 2, failed),
			messageEntry("stopped", "failed", 3, stopped),
			messageEntry("aborted", "stopped", 4, aborted),
			messageEntry("tool-use", "aborted", 5, toolUse),
			messageEntry("deferred", "tool-use", 6, deferred),
			messageEntry("length", "deferred", 7, length),
		];

		expect(await buildSessionContext(entries, undefined, BACKGROUND_CONTEXT)).toEqual([
			user,
			stopped,
			toolUse,
			length,
		]);
	});

	it("projects branch summaries in branch order", async () => {
		const before = messageEntry("before", null, 1, userMessage("before summary"));
		const summary: BranchSummaryEntry = {
			id: "branch-summary",
			parentId: before.id,
			seq: 2,
			timestamp: NOW,
			type: "branch_summary",
			fromId: "source-leaf",
			summary: "work on the abandoned branch",
			fromHook: false,
		};
		const after = messageEntry("after", summary.id, 3, userMessage("after summary"));

		expect(await buildSessionContext([before, summary, after], undefined, BACKGROUND_CONTEXT)).toEqual([
			userMessage("before summary"),
			{
				role: "branchSummary",
				summary: "work on the abandoned branch",
				fromId: "source-leaf",
				timestamp: NOW,
			},
			userMessage("after summary"),
		]);
	});

	it("filters retained-tail responses without hiding the compaction summary", async () => {
		const user = userMessage("kept user");
		const stopped = assistantMessage("stop", "kept answer");
		const toolUse = assistantMessage("toolUse", "");
		const length = assistantMessage("length", "kept truncated answer");
		const failed = assistantMessage("error", "failed");
		const aborted = assistantMessage("aborted", "aborted");
		const deferred = assistantMessage("deferred", "");
		const compaction: CompactionEntry = {
			id: "compaction",
			parentId: null,
			seq: 1,
			timestamp: NOW,
			type: "compaction",
			summary: "summary",
			retainedTail: [failed, user, aborted, stopped, deferred, toolUse, length],
			tokensBefore: 100,
			fromHook: false,
		};

		expect(await buildSessionContext([compaction], undefined, BACKGROUND_CONTEXT)).toEqual([
			{ role: "compactionSummary", summary: "summary", tokensBefore: 100, timestamp: NOW },
			user,
			stopped,
			toolUse,
			length,
		]);
	});
	it("uses only the latest compaction checkpoint and entries after it", async () => {
		const beforeFirst = messageEntry("before-first", null, 1, userMessage("before first"));
		const first: CompactionEntry = {
			id: "first-compaction",
			parentId: beforeFirst.id,
			seq: 2,
			timestamp: NOW,
			type: "compaction",
			summary: "stale summary",
			retainedTail: [userMessage("stale tail")],
			tokensBefore: 100,
			fromHook: false,
		};
		const between = messageEntry("between", first.id, 3, userMessage("between compactions"));
		const latest: CompactionEntry = {
			id: "latest-compaction",
			parentId: between.id,
			seq: 4,
			timestamp: NOW,
			type: "compaction",
			summary: "latest summary",
			retainedTail: [userMessage("latest tail")],
			tokensBefore: 200,
			fromHook: false,
		};
		const after = messageEntry("after", latest.id, 5, userMessage("after latest"));

		expect(
			await buildSessionContext([beforeFirst, first, between, latest, after], undefined, BACKGROUND_CONTEXT),
		).toEqual([
			{ role: "compactionSummary", summary: "latest summary", tokensBefore: 200, timestamp: NOW },
			userMessage("latest tail"),
			userMessage("after latest"),
		]);
	});

	it("projects custom entries through synchronous and asynchronous canonical projectors in branch order", async () => {
		const oldCustom: CustomEntry = {
			id: "old-custom",
			parentId: null,
			seq: 1,
			timestamp: NOW,
			type: "custom",
			customType: "sync",
		};
		const compaction: CompactionEntry = {
			id: "compaction",
			parentId: oldCustom.id,
			seq: 2,
			timestamp: NOW,
			type: "compaction",
			summary: "summary",
			retainedTail: [],
			tokensBefore: 100,
			fromHook: false,
		};
		const syncCustom: CustomEntry = {
			id: "sync-custom",
			parentId: compaction.id,
			seq: 3,
			timestamp: NOW,
			type: "custom",
			customType: "sync",
		};
		const omittedCustom: CustomEntry = {
			id: "omitted-custom",
			parentId: syncCustom.id,
			seq: 4,
			timestamp: NOW,
			type: "custom",
			customType: "omitted",
		};
		const asyncCustom: CustomEntry = {
			id: "async-custom",
			parentId: omittedCustom.id,
			seq: 5,
			timestamp: NOW,
			type: "custom",
			customType: "async",
		};
		const projectedIds: string[] = [];

		const messages = await buildSessionContext(
			[oldCustom, compaction, syncCustom, omittedCustom, asyncCustom],
			{
				entryProjectors: {
					sync: (entry) => {
						projectedIds.push(entry.id);
						return [userMessage(`projected:${entry.id}`)];
					},
					async: async (entry) => {
						await Promise.resolve();
						projectedIds.push(entry.id);
						return [userMessage(`projected:${entry.id}`)];
					},
				},
			},
			BACKGROUND_CONTEXT,
		);

		expect(projectedIds).toEqual([syncCustom.id, asyncCustom.id]);
		expect(messages).toEqual([
			{ role: "compactionSummary", summary: "summary", tokensBefore: 100, timestamp: NOW },
			userMessage(`projected:${syncCustom.id}`),
			userMessage(`projected:${asyncCustom.id}`),
		]);
	});

	it("propagates custom projector failures", async () => {
		const custom: CustomEntry = {
			id: "custom",
			parentId: null,
			seq: 1,
			timestamp: NOW,
			type: "custom",
			customType: "broken",
		};
		const failure = new Error("projector failed");

		await expect(
			buildSessionContext(
				[custom],
				{
					entryProjectors: { broken: async () => Promise.reject(failure) },
				},
				BACKGROUND_CONTEXT,
			),
		).rejects.toBe(failure);
	});
});
