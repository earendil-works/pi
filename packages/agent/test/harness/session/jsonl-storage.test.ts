import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import type {
	Entry,
	JsonlSessionMetadata,
	LaneRecord,
	MessageEntry,
	NewRecord,
	Session,
} from "../../../src/harness/session/index.ts";
import { JsonlSessionRepo } from "../../../src/harness/session/index.ts";
import { FileError } from "../../../src/harness/types.ts";
import type { AgentMessage } from "../../../src/types.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-jsonl-storage-"));
	tempDirs.push(directory);
	return directory;
}

function createRepository(root: string): JsonlSessionRepo {
	return new JsonlSessionRepo({
		fs: new NodeExecutionEnv({ cwd: root }),
		sessionsRoot: root,
	});
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function createUsage(multiplier: number): Usage {
	return {
		input: multiplier,
		output: multiplier * 2,
		cacheRead: multiplier * 3,
		cacheWrite: multiplier * 4,
		totalTokens: multiplier * 10,
		cost: {
			input: multiplier * 0.1,
			output: multiplier * 0.2,
			cacheRead: multiplier * 0.3,
			cacheWrite: multiplier * 0.4,
			total: multiplier,
		},
	};
}

async function reopen(root: string, session: Session<JsonlSessionMetadata>): Promise<Session<JsonlSessionMetadata>> {
	return createRepository(root).open(await session.getMetadata());
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("JSONL v4 per-session storage", () => {
	it("round trips every entry type and bounded branch queries", async () => {
		const root = createTempDir();
		const session = await createRepository(root).create({ id: "entries", cwd: root });
		const committed: Entry[] = [];
		committed.push(
			await session.appendEntry<MessageEntry>(
				{ type: "message", id: "message", message: userMessage("question") },
				"main",
			),
		);
		committed.push(
			await session.appendEntry<MessageEntry>(
				{
					type: "message",
					id: "assistant-tool-call",
					message: {
						role: "assistant",
						content: [
							{ type: "text", text: "I'll inspect it." },
							{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
						],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						usage: createUsage(1),
						stopReason: "toolUse",
						timestamp: 2,
					},
				},
				"main",
			),
		);
		committed.push(
			await session.appendEntry<MessageEntry>(
				{
					type: "message",
					id: "tool-result",
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "read",
						content: [{ type: "text", text: "contents" }],
						details: { path: "README.md" },
						usage: createUsage(2),
						isError: false,
						timestamp: 3,
					},
					terminate: true,
				},
				"main",
			),
		);
		committed.push(
			await session.appendEntry(
				{ type: "model_change", id: "model", provider: "anthropic", modelId: "claude-sonnet-4-5" },
				"main",
			),
		);
		committed.push(
			await session.appendEntry({ type: "thinking_level_change", id: "thinking", thinkingLevel: "high" }, "main"),
		);
		committed.push(
			await session.appendEntry(
				{ type: "active_tools_change", id: "tools", activeToolNames: ["read", "bash"] },
				"main",
			),
		);
		committed.push(
			await session.appendEntry(
				{
					type: "compaction",
					id: "compaction",
					summary: "summary",
					retainedTail: [userMessage("retained")],
					tokensBefore: 123,
					details: { source: "test" },
					usage: createUsage(1),
				},
				"main",
			),
		);
		committed.push(
			await session.appendEntry(
				{
					type: "branch_summary",
					id: "branch-summary",
					fromId: "message",
					summary: "branch",
					details: { reason: "navigation" },
					usage: createUsage(2),
				},
				"main",
			),
		);
		committed.push(
			await session.appendEntry(
				{ type: "custom", id: "custom", customType: "note", data: { nested: { value: 1 } } },
				"main",
			),
		);

		const restored = await reopen(root, session);
		expect(await restored.findEntries({ order: "oldestFirst" })).toEqual(committed);
		expect((await restored.findEntriesOnBranch({ stopAtType: "compaction" })).map((entry) => entry.id)).toEqual([
			"custom",
			"branch-summary",
			"compaction",
		]);
		expect(
			(
				await restored.findEntries({
					order: "oldestFirst",
					cursor: { afterSeq: committed[5]!.seq },
					limit: 2,
				})
			).map((entry) => entry.id),
		).toEqual(["compaction", "branch-summary"]);
		expect((await restored.findEntries({ customType: "note" })).map((entry) => entry.id)).toEqual(["custom"]);
		expect(await restored.getStats()).toEqual({
			messageCount: 3,
			cachedTokens: 0,
			uncachedTokens: 0,
			totalTokens: 0,
			costTotal: 0,
		});

		const custom = await restored.getEntry("custom");
		if (custom?.type !== "custom") throw new Error("Expected custom entry");
		(custom.data as { nested: { value: number } }).nested.value = 99;
		const logCustom = (await restored.getLog()).find((item) => item.kind === "entry" && item.entry.type === "custom");
		if (logCustom?.kind !== "entry" || logCustom.entry.type !== "custom") {
			throw new Error("Expected custom entry in log");
		}
		(logCustom.entry.data as { nested: { value: number } }).nested.value = 100;

		expect(await restored.getEntry("custom")).toEqual(committed.at(-1));
		expect(await restored.findEntries({ order: "oldestFirst" })).toEqual(committed);
	});

	it("round trips every record type, recovery projection, and ledger statistics", async () => {
		const root = createTempDir();
		const session = await createRepository(root).create({ id: "records", cwd: root });
		await session.appendCustomEntry("anchor");
		const records: LaneRecord[] = [];
		const append = async (record: NewRecord): Promise<void> => {
			records.push(await session.appendRecord(record));
		};

		await append({
			type: "operation_started",
			id: "run",
			lane: "main",
			sourceLeafId: "anchor",
			intent: {
				kind: "run",
				originalPrompt: [userMessage("prompt")],
				initialMessages: [{ type: "message", id: "initial", message: userMessage("initial") }],
				systemPromptOverride: "system",
				resumeData: { extension: { version: 1 } },
			},
		});
		await append({
			type: "queue_enqueued",
			id: "steer",
			lane: "main",
			queue: "steer",
			runId: "run",
			target: { type: "message", id: "steer-message", message: userMessage("steer") },
		});
		await append({
			type: "queue_enqueued",
			id: "follow-up",
			lane: "main",
			queue: "followUp",
			runId: "run",
			target: { type: "message", id: "follow-up-message", message: userMessage("follow up") },
		});
		await append({
			type: "step_attempt",
			id: "assistant-attempt",
			lane: "main",
			runId: "run",
			step: "assistant",
			attempt: 1,
			resultEntryId: "assistant-result",
		});
		await append({
			type: "tool_started",
			id: "tool",
			lane: "main",
			runId: "run",
			assistantEntryId: "assistant-result",
			toolIndex: 0,
			toolCallId: "call-1",
			toolName: "read",
			effectiveArgs: { path: "README.md" },
			resultEntryId: "tool-result",
			replay: "safe",
		});
		await append({
			type: "write_deferred",
			id: "deferred-write",
			lane: "main",
			runId: "run",
			target: { type: "custom", id: "deferred-entry", customType: "fact", data: { value: true } },
		});
		await append({
			type: "usage",
			id: "assistant-usage",
			lane: "main",
			cause: "assistant",
			runId: "run",
			entryId: "assistant-result",
			attempt: 1,
			stopReason: "stop",
			usage: createUsage(1),
		});
		await append({
			type: "usage",
			id: "deferred-usage",
			lane: "main",
			cause: "deferred_fetch",
			runId: "run",
			entryId: "deferred-result",
			attempt: 1,
			stopReason: "deferred",
			usage: createUsage(2),
		});
		await append({
			type: "usage",
			id: "tool-usage",
			lane: "main",
			cause: "tool",
			runId: "run",
			entryId: "tool-result",
			toolCallId: "call-1",
			usage: createUsage(3),
		});
		await append({
			type: "usage",
			id: "hook-usage",
			lane: "main",
			cause: "hook",
			runId: "run",
			entryId: "hook-result",
			usage: createUsage(4),
		});
		await append({
			type: "usage",
			id: "adjustment",
			lane: "main",
			cause: "adjustment",
			details: { reason: "correction" },
			usage: createUsage(5),
		});
		await append({ type: "abort_requested", id: "abort", lane: "main", runId: "run" });
		await append({
			type: "operation_finished",
			id: "run-finished",
			lane: "main",
			runId: "run",
			outcome: "aborted",
		});
		await append({
			type: "queue_enqueued",
			id: "next-run",
			lane: "main",
			queue: "nextRun",
			target: { type: "message", id: "next-message", message: userMessage("next") },
		});
		await append({ type: "queue_cancelled", id: "queue-cancelled", lane: "main", entryId: "next-message" });
		await append({
			type: "operation_started",
			id: "compaction",
			lane: "main",
			sourceLeafId: "anchor",
			intent: { kind: "compaction", customInstructions: "short", resultEntryId: "compaction-result" },
		});
		await append({
			type: "step_attempt",
			id: "compaction-attempt",
			lane: "main",
			runId: "compaction",
			step: "compaction",
			attempt: 1,
			resultEntryId: "compaction-result",
			compactionReason: "manual",
		});
		await append({
			type: "operation_finished",
			id: "compaction-finished",
			lane: "main",
			runId: "compaction",
			outcome: "completed",
		});
		await append({
			type: "operation_started",
			id: "navigation",
			lane: "main",
			sourceLeafId: "anchor",
			intent: {
				kind: "navigation",
				targetId: null,
				summarize: true,
				customInstructions: "summarize",
				label: "checkpoint",
				summaryEntryId: "navigation-summary",
			},
		});
		await append({
			type: "step_attempt",
			id: "branch-attempt",
			lane: "main",
			runId: "navigation",
			step: "branch_summary",
			attempt: 1,
			resultEntryId: "navigation-summary",
		});

		const restored = await reopen(root, session);
		expect(await restored.findRecords({ order: "oldestFirst" })).toEqual(records);
		expect(
			(
				await restored.findRecords({
					type: "operation_started",
					operationKind: "run",
					limit: 1,
				})
			).map((record) => record.id),
		).toEqual(["run"]);
		expect(
			(await restored.findRecords({ runId: "compaction", order: "oldestFirst" })).map((record) => record.id),
		).toEqual(["compaction", "compaction-attempt", "compaction-finished"]);
		expect(
			(await restored.findRecords({ type: "usage", afterSeq: records[6]!.seq, limit: 2 })).map(
				(record) => record.id,
			),
		).toEqual(["adjustment", "hook-usage"]);
		expect((await restored.findOpenOperations("main", { limit: 2 })).map((record) => record.id)).toEqual([
			"navigation",
		]);
		expect(await restored.getStats()).toEqual({
			messageCount: 0,
			cachedTokens: 45,
			uncachedTokens: 75,
			totalTokens: 150,
			costTotal: 15,
		});

		const [started] = await restored.findRecords({ type: "operation_started", operationKind: "run" });
		if (started?.intent.kind !== "run") throw new Error("Expected restored run record");
		started.intent.originalPrompt.push(userMessage("mutated"));
		expect(await restored.findRecords({ order: "oldestFirst" })).toEqual(records);
	});

	it("persists concurrent cross-lane writes in shared sequence order", async () => {
		const root = createTempDir();
		const session = await createRepository(root).create({ id: "concurrent", cwd: root });
		const rootEntry = await session.appendEntry({ type: "custom", id: "root", customType: "root" }, "main");
		await session.createLane("thread", rootEntry.id);

		const entries = await Promise.all([
			session.appendEntry({ type: "custom", id: "main-1", customType: "note" }, "main"),
			session.appendEntry({ type: "custom", id: "thread-1", customType: "note" }, "thread"),
			session.appendEntry({ type: "custom", id: "main-2", customType: "note" }, "main"),
			session.appendEntry({ type: "custom", id: "thread-2", customType: "note" }, "thread"),
		]);
		const commitOrder = [...entries].sort((left, right) => left.seq - right.seq).map((entry) => entry.id);

		const restored = await reopen(root, session);
		const restoredConcurrentEntries = (await restored.getLog()).flatMap((item) =>
			item.kind === "entry" && item.entry.id !== "root" ? [item.entry] : [],
		);
		expect(restoredConcurrentEntries.map((entry) => entry.id)).toEqual(commitOrder);
		expect(new Set(restoredConcurrentEntries.map((entry) => entry.seq)).size).toBe(entries.length);
		expect((await restored.getLog()).map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("rejects non-JSON payloads without changing the durable prefix", async () => {
		const root = createTempDir();
		const session = await createRepository(root).create({ id: "validation", cwd: root });
		const metadata = await session.getMetadata();
		const prefix = readFileSync(metadata.path, "utf8");
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;

		await expect(session.appendCustomEntry("invalid", cyclic)).rejects.toMatchObject({ code: "invalid_payload" });
		// JSON.stringify would silently omit undefined, changing the effective arguments used during recovery.
		await expect(
			session.appendRecord({
				type: "tool_started",
				id: "invalid-record",
				lane: "main",
				runId: "run",
				assistantEntryId: "assistant",
				toolIndex: 0,
				toolCallId: "call",
				toolName: "read",
				effectiveArgs: { value: undefined },
				resultEntryId: "result",
				replay: "never",
			}),
		).rejects.toMatchObject({ code: "invalid_payload" });
		expect(readFileSync(metadata.path, "utf8")).toBe(prefix);

		const restored = await reopen(root, session);
		expect(await restored.getLog()).toEqual([]);
		const valid = await restored.appendEntry(
			{ type: "custom", id: "valid", customType: "note", data: { value: 1 } },
			"main",
		);
		expect(valid.seq).toBe(1);
		expect((await reopen(root, restored)).getEntry("valid")).resolves.toEqual(valid);
	});

	it("does not advance state or poison the write queue after an append failure", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		vi.spyOn(env, "appendFile").mockResolvedValueOnce({
			ok: false,
			error: new FileError("unknown", "injected append failure"),
		});
		const repository = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repository.create({ id: "append-failure", cwd: root });

		await expect(session.appendCustomEntry("rejected")).rejects.toMatchObject({ code: "storage" });
		expect(await session.getLog()).toEqual([]);
		const committed = await session.appendEntry({ type: "custom", id: "committed", customType: "note" }, "main");
		expect(committed.seq).toBe(1);

		const reopened = await createRepository(root).open(await session.getMetadata());
		expect(await reopened.getLog()).toEqual([{ kind: "entry", seq: 1, entry: committed }]);
	});
});
