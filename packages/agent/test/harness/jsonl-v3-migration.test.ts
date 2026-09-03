import type { Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, type Context } from "../../src/harness/context.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	JSONL_FORMAT_VERSION,
	JSONL_STORAGE_VERSION,
	type JsonlSessionMetadata,
	JsonlSessionRepo,
	JsonlStorage,
} from "../../src/harness/session/jsonl/index.ts";
import type { Entry, Session } from "../../src/harness/session/types.ts";
import * as storedValues from "../../src/harness/session/values.ts";
import { err, FileError, getOrThrow, type Result } from "../../src/harness/types.ts";
import type { AgentMessage } from "../../src/types.ts";
import { createTempDir } from "./session-test-utils.ts";

const NOW = 1_700_000_000_000;

class FailableRenameNodeExecutionEnv extends NodeExecutionEnv {
	failRename = false;

	override async renameFile(
		sourcePath: string,
		destinationPath: string,
		context: Context,
	): Promise<Result<void, FileError>> {
		if (this.failRename) {
			return err(new FileError("unknown", "Injected rename failure", sourcePath));
		}
		return super.renameFile(sourcePath, destinationPath, context);
	}
}

function uuidTimestamp(id: string): number {
	return Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
}

async function mainBranch(session: Session) {
	const branch = await session.branch("main", BACKGROUND_CONTEXT);
	if (branch === undefined) throw new Error("Expected imported main Branch");
	return branch;
}

async function mainTip(session: Session): Promise<string | null> {
	return (await mainBranch(session)).getTipId(BACKGROUND_CONTEXT);
}

describe("JSONL v3 migration", () => {
	let fileSystem: FailableRenameNodeExecutionEnv;
	let repo: JsonlSessionRepo;

	beforeEach(() => {
		fileSystem = new FailableRenameNodeExecutionEnv({ cwd: createTempDir() });
		repo = new JsonlSessionRepo({
			fileSystem,
			sessionsRoot: "sessions",
			now: () => NOW,
		});
	});

	afterEach(async () => {
		await repo.close(BACKGROUND_CONTEXT);
	});

	async function writeLegacyV3Fixture(
		records: readonly unknown[],
		headerOptions: { parentSession?: string } = {},
	): Promise<{ path: string; content: string }> {
		const directory = getOrThrow(await fileSystem.joinPath(["sessions", "--workspace--"], BACKGROUND_CONTEXT));
		getOrThrow(await fileSystem.createDir(directory, undefined, BACKGROUND_CONTEXT));
		const relativePath = getOrThrow(await fileSystem.joinPath([directory, "legacy.jsonl"], BACKGROUND_CONTEXT));
		const path = getOrThrow(await fileSystem.absolutePath(relativePath, BACKGROUND_CONTEXT));
		const content = `${[
			{
				type: "session",
				version: 3,
				id: "legacy",
				timestamp: new Date(NOW).toISOString(),
				cwd: "/workspace",
				...headerOptions,
			},
			...records,
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`;
		getOrThrow(await fileSystem.writeFile(path, content, BACKGROUND_CONTEXT));
		return { path, content };
	}

	it("discovers legacy v3 session files without rewriting them", async () => {
		const { path, content } = await writeLegacyV3Fixture([], {
			parentSession: "/old-session.jsonl",
		});

		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		const after = getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT));

		expect(metadata).toMatchObject({
			id: "legacy",
			createdAt: NOW,
			storageVersion: JSONL_STORAGE_VERSION,
			cwd: "/workspace",
			path,
			legacyParentSessionPath: "/old-session.jsonl",
		});
		expect(Number.isFinite(metadata?.modifiedAt)).toBe(true);
		expect(after).toBe(content);
	});

	it.each([
		{
			format: "v3",
			parentId: "legacy-parent",
			header: {
				type: "session",
				version: 3,
				id: "legacy-parent",
				timestamp: new Date(NOW - 1_000).toISOString(),
				cwd: "/workspace",
			},
		},
		{
			format: "v4",
			parentId: "current-parent",
			header: {
				v: 4,
				kind: "header",
				id: "current-parent",
				storageVersion: JSONL_STORAGE_VERSION,
				createdAt: NOW - 1_000,
				cwd: "/workspace",
			},
		},
	])("resolves an available $format parent path to its session id", async ({ format, parentId, header }) => {
		const parentPath = getOrThrow(await fileSystem.absolutePath(`parent-${format}.jsonl`, BACKGROUND_CONTEXT));
		getOrThrow(await fileSystem.writeFile(parentPath, `${JSON.stringify(header)}\n`, BACKGROUND_CONTEXT));
		await writeLegacyV3Fixture([], { parentSession: parentPath });

		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		expect(metadata).toMatchObject({
			id: "legacy",
			parentSessionId: parentId,
		});
		expect(metadata).not.toHaveProperty("legacyParentSessionPath");
		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		expect(session.metadata).toMatchObject({ parentSessionId: parentId });
		expect(session.metadata).not.toHaveProperty("legacyParentSessionPath");
		await session.close(BACKGROUND_CONTEXT);
	});

	it("preserves an invalid parent path as legacy metadata", async () => {
		const parentPath = getOrThrow(await fileSystem.absolutePath("invalid-parent.jsonl", BACKGROUND_CONTEXT));
		getOrThrow(await fileSystem.writeFile(parentPath, '{"not":"a session header"}\n', BACKGROUND_CONTEXT));
		await writeLegacyV3Fixture([], { parentSession: parentPath });

		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);

		expect(metadata).toMatchObject({
			id: "legacy",
			legacyParentSessionPath: parentPath,
		});
		expect(metadata).not.toHaveProperty("parentSessionId");
	});

	describe("forking legacy v3 sessions", () => {
		const firstMessage = {
			role: "user",
			content: [{ type: "text", text: "fork me" }],
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;
		const usage = {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: {
				input: 0.1,
				output: 0.05,
				cacheRead: 0.02,
				cacheWrite: 0.01,
				total: 0.18,
			},
		} satisfies Usage;
		const secondMessage = {
			role: "assistant",
			content: [{ type: "text", text: "forked" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage,
			stopReason: "stop",
			timestamp: NOW + 4_000,
		} satisfies AgentMessage;

		async function writeForkFixture() {
			const fixture = await writeLegacyV3Fixture([
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: new Date(NOW + 1_000).toISOString(),
					message: firstMessage,
				},
				{
					type: "label",
					id: "label-1",
					parentId: "message-1",
					timestamp: new Date(NOW + 2_000).toISOString(),
					targetId: "message-1",
					label: "Fork point",
				},
				{
					type: "session_info",
					id: "session-info",
					parentId: "label-1",
					timestamp: new Date(NOW + 3_000).toISOString(),
					name: "Imported fork",
				},
				{
					type: "message",
					id: "message-2",
					parentId: "session-info",
					timestamp: new Date(NOW + 4_000).toISOString(),
					message: secondMessage,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");
			return { ...fixture, metadata };
		}

		async function expectForkedState(fork: Session<JsonlSessionMetadata>): Promise<Entry[]> {
			expect(fork.metadata).toMatchObject({
				storageVersion: JSONL_STORAGE_VERSION,
				parentSessionId: "legacy",
			});
			const entries = await fork.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(2);
			const [first, second] = entries;
			if (first === undefined || second === undefined) throw new Error("Forked entries were not written");
			expect(first).toMatchObject({
				type: "message",
				parentId: null,
				message: firstMessage,
			});
			expect(second).toMatchObject({
				type: "message",
				parentId: first.id,
				message: secondMessage,
			});
			expect(first.id).not.toBe("message-1");
			expect(second.id).not.toBe("message-2");
			expect(await mainTip(fork)).toBe(second.id);
			expect(await fork.getName(BACKGROUND_CONTEXT)).toBe("Imported fork");
			expect(await fork.getLabel(first.id, BACKGROUND_CONTEXT)).toBe("Fork point");
			expect(await fork.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await fork.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await fork.getStats(BACKGROUND_CONTEXT)).toEqual({
				messageCount: 2,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			return entries;
		}

		it("forks a closed source into a complete v4 destination without rewriting it", async () => {
			const { path, content, metadata } = await writeForkFixture();

			const fork = await repo.fork(metadata, { id: "closed-fork", scope: "tree" }, BACKGROUND_CONTEXT);

			expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
			expect(fork.metadata.id).toBe("closed-fork");
			const [headerLine] = getOrThrow(
				await fileSystem.readTextLines(fork.metadata.path, { maxLines: 1 }, BACKGROUND_CONTEXT),
			);
			if (headerLine === undefined) throw new Error("Fork header was not written");
			expect(JSON.parse(headerLine)).toMatchObject({
				v: 4,
				kind: "header",
				id: "closed-fork",
				storageVersion: JSONL_STORAGE_VERSION,
				parentSessionId: "legacy",
			});
			await expectForkedState(fork);

			await fork.close(BACKGROUND_CONTEXT);
			const destinationStorage = await JsonlStorage.open(
				{ fileSystem, path: fork.metadata.path, now: () => NOW },
				BACKGROUND_CONTEXT,
			);
			expect(await destinationStorage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual([]);
			await destinationStorage.close(BACKGROUND_CONTEXT);
			expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
		});

		it("forks an already-open source without converting or renormalizing it", async () => {
			const { path, content, metadata } = await writeForkFixture();
			const source = await repo.open(metadata, BACKGROUND_CONTEXT);
			const sourceEntries = await source.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			const sourceStats = await source.getStats(BACKGROUND_CONTEXT);

			const fork = await repo.fork(metadata, { id: "open-fork", scope: "tree" }, BACKGROUND_CONTEXT);
			const forkEntries = await expectForkedState(fork);

			expect(fork.metadata.id).toBe("open-fork");
			expect(forkEntries).toEqual(sourceEntries);
			expect(sourceStats.usage).toEqual(usage);
			expect(await source.getStats(BACKGROUND_CONTEXT)).toEqual(sourceStats);
			expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
			await Promise.all([source.close(BACKGROUND_CONTEXT), fork.close(BACKGROUND_CONTEXT)]);
			expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
		});
	});

	it("opens an empty legacy session with a data-only main Branch", async () => {
		await writeLegacyV3Fixture([]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		expect(await session.findEntries(undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await mainTip(session)).toBeNull();
		expect(await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("reports embedded legacy usage without creating usage rows or rewriting the source", async () => {
		const usage = (factor: number): Usage => ({
			input: factor,
			output: factor * 2,
			cacheRead: factor * 3,
			cacheWrite: factor * 4,
			cacheWrite1h: factor * 5,
			reasoning: factor * 6,
			totalTokens: factor * 10,
			cost: {
				input: factor,
				output: factor * 2,
				cacheRead: factor * 3,
				cacheWrite: factor * 4,
				total: factor * 10,
			},
		});
		const assistantUsage = usage(1);
		const toolUsage = usage(10);
		const compactionUsage = usage(100);
		const branchSummaryUsage = usage(1_000);
		const { path, content } = await writeLegacyV3Fixture([
			{
				type: "message",
				id: "assistant",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "text", text: "answer" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: assistantUsage,
					stopReason: "stop",
					timestamp: NOW + 1_000,
				} satisfies AgentMessage,
			},
			{
				type: "message",
				id: "tool-result",
				parentId: "assistant",
				timestamp: new Date(NOW + 2_000).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "test",
					content: [{ type: "text", text: "result" }],
					usage: toolUsage,
					isError: false,
					timestamp: NOW + 2_000,
				} satisfies AgentMessage,
			},
			{
				type: "compaction",
				id: "compaction",
				parentId: "tool-result",
				timestamp: new Date(NOW + 3_000).toISOString(),
				summary: "Earlier context",
				firstKeptEntryId: "assistant",
				tokensBefore: 1_000,
				usage: compactionUsage,
			},
			{
				type: "branch_summary",
				id: "branch-summary",
				parentId: "compaction",
				timestamp: new Date(NOW + 4_000).toISOString(),
				fromId: "assistant",
				summary: "Abandoned branch",
				usage: branchSummaryUsage,
			},
		]);

		const storage = await JsonlStorage.open({ fileSystem, path, now: () => NOW }, BACKGROUND_CONTEXT);

		expect(await storage.getStats(BACKGROUND_CONTEXT)).toEqual({
			messageCount: 2,
			usage: usage(1_111),
		});
		expect(await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual([]);
		await storage.close(BACKGROUND_CONTEXT);
		expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
	});

	describe("upgrading legacy v3 sessions to v4", () => {
		const importedUsage = {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: {
				input: 0.1,
				output: 0.05,
				cacheRead: 0.02,
				cacheWrite: 0.01,
				total: 0.18,
			},
		} satisfies Usage;
		const importedMessage = {
			role: "assistant",
			content: [{ type: "text", text: "imported answer" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: importedUsage,
			stopReason: "stop",
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;

		function writeUsageFixture() {
			return writeLegacyV3Fixture([
				{
					type: "message",
					id: "assistant",
					parentId: null,
					timestamp: new Date(NOW + 1_000).toISOString(),
					message: importedMessage,
				},
			]);
		}

		it("writes one zero-valued usage adjustment when converting a session without imported usage", async () => {
			const { path } = await writeLegacyV3Fixture([]);
			const storage = await JsonlStorage.open({ fileSystem, path, now: () => NOW }, BACKGROUND_CONTEXT);

			await storage.commit(
				[storedValues.setValue(storedValues.sessionName, "Converted session")],
				BACKGROUND_CONTEXT,
			);

			const usageRows = await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(usageRows).toHaveLength(1);
			expect(usageRows[0]).toMatchObject({
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				adjustment: true,
				details: { source: "v3-import" },
			});
			expect(usageRows[0]).not.toHaveProperty("entryId");
			await storage.close(BACKGROUND_CONTEXT);
		});

		it("converts to v4 and preserves the first caller transaction with one usage adjustment", async () => {
			// Seed a v3 session whose embedded usage must become a durable v4 ledger adjustment.
			const { path } = await writeUsageFixture();
			// Capture the normalized read-only view so conversion can be checked for identity and stats stability.
			const options = { fileSystem, path, now: () => NOW };
			const storage = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
			const importedEntries = await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			const statsBefore = await storage.getStats(BACKGROUND_CONTEXT);

			// The first caller write triggers conversion and must not expose the internal adjustment sequence.
			const committed = await storage.commit(
				[storedValues.setValue(storedValues.sessionName, "Converted session")],
				BACKGROUND_CONTEXT,
			);

			expect(committed.seqs).toHaveLength(1);
			expect(committed.firstSeq).toBe(committed.seqs[0]);
			expect((await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.seq).toBe(committed.seqs[0]);
			const usageRows = await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(usageRows).toHaveLength(1);
			const [adjustment] = usageRows;
			if (adjustment === undefined) throw new Error("Import usage adjustment was not committed");
			expect(adjustment).toMatchObject({
				usage: importedUsage,
				adjustment: true,
				details: { source: "v3-import" },
			});
			expect(adjustment).not.toHaveProperty("entryId");
			expect(committed.seqs).not.toContain(adjustment.seq);
			expect(committed.stats).toEqual(statsBefore);
			expect(await storage.getStats(BACKGROUND_CONTEXT)).toEqual(statsBefore);

			// Conversion replaces the legacy file and retains the adjustment and caller writes as its first transaction.
			const convertedLines = getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))
				.trimEnd()
				.split("\n");
			const headerLine = convertedLines[0];
			const transactionLine = convertedLines.at(-1);
			if (headerLine === undefined || transactionLine === undefined)
				throw new Error("Converted file was not written");
			expect(JSON.parse(headerLine)).toMatchObject({
				v: JSONL_FORMAT_VERSION,
				kind: "header",
				id: "legacy",
				storageVersion: JSONL_STORAGE_VERSION,
				createdAt: NOW,
				cwd: "/workspace",
			});
			expect(JSON.parse(transactionLine)).toEqual([
				{ kind: "usage", ...adjustment },
				{
					kind: "value",
					op: "set",
					seq: committed.seqs[0],
					namespace: storedValues.sessionName.namespace,
					key: storedValues.sessionName.key,
					value: "Converted session",
				},
			]);
			await storage.close(BACKGROUND_CONTEXT);

			// Reopening through the ordinary v4 path must recover the complete normalized and newly committed state.
			const reopened = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
			expect(await reopened.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual(importedEntries);
			const [importedEntry] = importedEntries;
			if (importedEntry === undefined) throw new Error("Legacy message was not imported");
			expect((await reopened.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT))?.value).toBe(
				importedEntry.id,
			);
			expect(await reopened.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect((await reopened.getValue(storedValues.sessionName, BACKGROUND_CONTEXT))?.value).toBe(
				"Converted session",
			);
			expect(await reopened.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual([adjustment]);
			expect(await reopened.getStats(BACKGROUND_CONTEXT)).toEqual(statsBefore);
			await reopened.close(BACKGROUND_CONTEXT);
		});

		it("leaves the v3 source and live state unchanged when atomic publication fails", async () => {
			const { path, content } = await writeUsageFixture();
			const options = { fileSystem, path, now: () => NOW };
			const storage = await JsonlStorage.open(options, BACKGROUND_CONTEXT);
			const entriesBefore = await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			const leafBefore = await storage.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT);
			const laneStateBefore = await storage.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT);
			const nameBefore = await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT);
			const statsBefore = await storage.getStats(BACKGROUND_CONTEXT);
			const usageBefore = await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT);
			if (leafBefore === undefined) throw new Error("Normalized main Branch tip is missing");
			expect(laneStateBefore).toBeUndefined();

			fileSystem.failRename = true;
			await expect(
				storage.commit([storedValues.setValue(storedValues.sessionName, "Converted session")], BACKGROUND_CONTEXT),
			).rejects.toThrow(`Failed to publish JSONL storage ${path}`);
			fileSystem.failRename = false;

			expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
			expect(await storage.scanEntries({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual(entriesBefore);
			expect(await storage.getValue(storedValues.branchTip("main"), BACKGROUND_CONTEXT)).toEqual(leafBefore);
			expect(await storage.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT)).toEqual(laneStateBefore);
			expect(await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toEqual(nameBefore);
			expect(await storage.getStats(BACKGROUND_CONTEXT)).toEqual(statsBefore);
			expect(await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT)).toEqual(usageBefore);

			const committed = await storage.commit(
				[storedValues.setValue(storedValues.sessionName, "Converted session")],
				BACKGROUND_CONTEXT,
			);

			expect(committed.firstSeq).toBe(leafBefore.seq + 2);
			expect(committed.seqs).toEqual([committed.firstSeq]);
			expect(await storage.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toMatchObject({
				seq: committed.firstSeq,
				value: "Converted session",
			});
			const usageRows = await storage.scanUsage({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(usageRows).toHaveLength(1);
			expect(usageRows[0]).toMatchObject({
				usage: importedUsage,
				adjustment: true,
				details: { source: "v3-import" },
			});
			expect(await storage.getStats(BACKGROUND_CONTEXT)).toEqual(statsBefore);
			await storage.close(BACKGROUND_CONTEXT);
		});
	});

	describe("reconstructing legacy lane configuration", () => {
		const firstTimestamp = NOW + 1_000;
		const modelChangeTimestamp = NOW + 2_000;
		const thinkingChangeTimestamp = NOW + 3_000;
		const activeToolsChangeTimestamp = NOW + 4_000;
		const secondTimestamp = NOW + 5_000;
		const firstMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: firstTimestamp,
		} satisfies AgentMessage;
		const secondMessage = {
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: secondTimestamp,
		} satisfies AgentMessage;
		const configurationChanges = [
			{
				type: "model_change",
				id: "model-change",
				parentId: "message-1",
				timestamp: new Date(modelChangeTimestamp).toISOString(),
				provider: "anthropic",
				modelId: "claude-sonnet-4-5",
			},
			{
				type: "thinking_level_change",
				id: "thinking-change",
				parentId: "model-change",
				timestamp: new Date(thinkingChangeTimestamp).toISOString(),
				thinkingLevel: "high",
			},
			{
				type: "active_tools_change",
				id: "active-tools-change",
				parentId: "thinking-change",
				timestamp: new Date(activeToolsChangeTimestamp).toISOString(),
				activeToolNames: ["read", "bash"],
			},
		] as const;

		it("reparents a retained child through configuration changes", async () => {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: new Date(firstTimestamp).toISOString(),
					message: firstMessage,
				},
				...configurationChanges,
				{
					type: "message",
					id: "message-2",
					parentId: "active-tools-change",
					timestamp: new Date(secondTimestamp).toISOString(),
					message: secondMessage,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(2);
			const [first, second] = entries;
			if (first === undefined || second === undefined) {
				throw new Error("Legacy configuration-change chain was not imported");
			}
			expect(first).toMatchObject({
				type: "message",
				parentId: null,
				message: firstMessage,
			});
			expect(second).toMatchObject({
				type: "message",
				parentId: first.id,
				message: secondMessage,
			});
			expect(second.seq).toBeGreaterThan(first.seq);
			expect(await mainTip(session)).toBe(second.id);
			expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinkingLevel: "high",
				activeToolNames: ["read", "bash"],
			});
			expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				currentOperationId: null,
				lastOperationId: null,
				inbox: [],
			});
			await session.close(BACKGROUND_CONTEXT);
		});

		it("retains only configuration changes on the selected physical branch", async () => {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: new Date(firstTimestamp).toISOString(),
					message: firstMessage,
				},
				{
					type: "model_change",
					id: "selected-model",
					parentId: "root",
					timestamp: new Date(modelChangeTimestamp).toISOString(),
					provider: "anthropic",
					modelId: "selected",
				},
				{
					type: "thinking_level_change",
					id: "selected-thinking",
					parentId: "selected-model",
					timestamp: new Date(thinkingChangeTimestamp).toISOString(),
					thinkingLevel: "high",
				},
				{
					type: "model_change",
					id: "abandoned-model",
					parentId: "root",
					timestamp: new Date(activeToolsChangeTimestamp).toISOString(),
					provider: "openai",
					modelId: "abandoned",
				},
				{
					type: "message",
					id: "selected-tip",
					parentId: "selected-thinking",
					timestamp: new Date(secondTimestamp).toISOString(),
					message: secondMessage,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				model: { provider: "anthropic", modelId: "selected" },
				thinkingLevel: "high",
				activeToolNames: [],
			});
			expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				currentOperationId: null,
				lastOperationId: null,
				inbox: [],
			});
			await session.close(BACKGROUND_CONTEXT);
		});

		it("omits an unsupported nearest value instead of falling back to an older change", async () => {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: new Date(firstTimestamp).toISOString(),
					message: firstMessage,
				},
				{
					type: "model_change",
					id: "older-model",
					parentId: "root",
					timestamp: new Date(modelChangeTimestamp).toISOString(),
					provider: "anthropic",
					modelId: "older",
				},
				{
					type: "model_change",
					id: "invalid-model",
					parentId: "older-model",
					timestamp: new Date(thinkingChangeTimestamp).toISOString(),
					provider: "",
					modelId: "",
				},
				{
					type: "message",
					id: "tip",
					parentId: "invalid-model",
					timestamp: new Date(secondTimestamp).toISOString(),
					message: secondMessage,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			expect(await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			await session.close(BACKGROUND_CONTEXT);
		});

		it.each([
			{
				name: "missing model",
				changes: [
					{
						type: "thinking_level_change",
						id: "thinking",
						parentId: "root",
						timestamp: new Date(thinkingChangeTimestamp).toISOString(),
						thinkingLevel: "high",
					},
				],
			},
			{
				name: "missing thinking level",
				changes: [
					{
						type: "model_change",
						id: "model",
						parentId: "root",
						timestamp: new Date(modelChangeTimestamp).toISOString(),
						provider: "anthropic",
						modelId: "selected",
					},
				],
			},
			{
				name: "invalid thinking level",
				changes: [
					{
						type: "model_change",
						id: "model",
						parentId: "root",
						timestamp: new Date(modelChangeTimestamp).toISOString(),
						provider: "anthropic",
						modelId: "selected",
					},
					{
						type: "thinking_level_change",
						id: "thinking",
						parentId: "model",
						timestamp: new Date(thinkingChangeTimestamp).toISOString(),
						thinkingLevel: "unsupported",
					},
				],
			},
		])("leaves main data-only for $name", async ({ changes }) => {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: new Date(firstTimestamp).toISOString(),
					message: firstMessage,
				},
				...changes,
				{
					type: "message",
					id: "tip",
					parentId: changes.at(-1)?.id ?? "root",
					timestamp: new Date(secondTimestamp).toISOString(),
					message: secondMessage,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			expect(await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			await session.close(BACKGROUND_CONTEXT);
		});

		it("normalizes malformed active-tool history without compatibility state", async () => {
			await writeLegacyV3Fixture([
				{
					type: "model_change",
					id: "model",
					parentId: null,
					timestamp: new Date(modelChangeTimestamp).toISOString(),
					provider: "anthropic",
					modelId: "selected",
				},
				{
					type: "thinking_level_change",
					id: "thinking",
					parentId: "model",
					timestamp: new Date(thinkingChangeTimestamp).toISOString(),
					thinkingLevel: "high",
				},
				{
					type: "active_tools_change",
					id: "tools",
					parentId: "thinking",
					timestamp: new Date(activeToolsChangeTimestamp).toISOString(),
					activeToolNames: ["read", 42],
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				model: { provider: "anthropic", modelId: "selected" },
				thinkingLevel: "high",
				activeToolNames: [],
			});
			expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				currentOperationId: null,
				lastOperationId: null,
				inbox: [],
			});
			await session.close(BACKGROUND_CONTEXT);
		});

		it("resolves the main tip through trailing configuration changes", async () => {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: new Date(firstTimestamp).toISOString(),
					message: firstMessage,
				},
				...configurationChanges,
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(1);
			const [message] = entries;
			if (message === undefined) throw new Error("Legacy message was not imported");
			expect(await mainTip(session)).toBe(message.id);
			expect((await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				thinkingLevel: "high",
				activeToolNames: ["read", "bash"],
			});
			expect((await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT))?.value).toEqual({
				currentOperationId: null,
				lastOperationId: null,
				inbox: [],
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("imports session info as the current name without retaining a tree entry", async () => {
		await writeLegacyV3Fixture([
			{
				type: "session_info",
				id: "session-info",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
				name: "Imported session",
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		expect(await session.getName(BACKGROUND_CONTEXT)).toBe("Imported session");
		expect(await session.findEntries(undefined, BACKGROUND_CONTEXT)).toEqual([]);
		expect(await mainTip(session)).toBeNull();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("uses the latest session info and resolves tree structure through discarded records", async () => {
		const firstMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;
		const secondMessage = {
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: NOW + 3_000,
		} satisfies AgentMessage;
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
				message: firstMessage,
			},
			{
				type: "session_info",
				id: "session-info-1",
				parentId: "message-1",
				timestamp: new Date(NOW + 2_000).toISOString(),
				name: "Earlier name",
			},
			{
				type: "message",
				id: "message-2",
				parentId: "session-info-1",
				timestamp: new Date(NOW + 3_000).toISOString(),
				message: secondMessage,
			},
			{
				type: "session_info",
				id: "session-info-2",
				parentId: "message-2",
				timestamp: new Date(NOW + 4_000).toISOString(),
				name: "Latest name",
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [first, second] = entries;
		if (first === undefined || second === undefined) throw new Error("Legacy message chain was not imported");
		expect(second.parentId).toBe(first.id);
		expect(await session.getName(BACKGROUND_CONTEXT)).toBe("Latest name");
		expect(await mainTip(session)).toBe(second.id);
		await session.close(BACKGROUND_CONTEXT);
	});

	it.each([{ name: undefined }, { name: "" }])("clears the session name with $name", async ({ name }) => {
		await writeLegacyV3Fixture([
			{
				type: "session_info",
				id: "session-info-1",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
				name: "Earlier name",
			},
			{
				type: "session_info",
				id: "session-info-2",
				parentId: "session-info-1",
				timestamp: new Date(NOW + 2_000).toISOString(),
				...(name === undefined ? {} : { name }),
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		expect(await session.getValue(storedValues.sessionName, BACKGROUND_CONTEXT)).toBeUndefined();
		await session.close(BACKGROUND_CONTEXT);
	});

	it("imports a label for its remapped entry without retaining a tree node", async () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "label me" }],
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
				message,
			},
			{
				type: "label",
				id: "label-1",
				parentId: "message-1",
				timestamp: new Date(NOW + 2_000).toISOString(),
				targetId: "message-1",
				label: "Important",
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		if (entry === undefined) throw new Error("Legacy message was not imported");
		expect((await session.getValue(storedValues.entryLabel(entry.id), BACKGROUND_CONTEXT))?.value).toBe("Important");
		expect(await mainTip(session)).toBe(entry.id);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("skips a label whose target has no retained ancestor", async () => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "retained message" }],
			timestamp: NOW + 3_000,
		} satisfies AgentMessage;
		await writeLegacyV3Fixture([
			{
				type: "session_info",
				id: "root-session-info",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
			},
			{
				type: "label",
				id: "root-label",
				parentId: "root-session-info",
				timestamp: new Date(NOW + 2_000).toISOString(),
				targetId: "root-session-info",
				label: "Skipped label",
			},
			{
				type: "message",
				id: "message-1",
				parentId: "root-label",
				timestamp: new Date(NOW + 3_000).toISOString(),
				message,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(1);
		const [entry] = entries;
		if (entry === undefined) throw new Error("Legacy message was not imported");
		expect(entry.parentId).toBeNull();
		expect(await session.getLabel(entry.id, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await mainTip(session)).toBe(entry.id);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("uses the latest label after remapping discarded targets", async () => {
		const firstMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;
		const secondMessage = {
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: NOW + 5_000,
		} satisfies AgentMessage;
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
				message: firstMessage,
			},
			{
				type: "session_info",
				id: "session-info",
				parentId: "message-1",
				timestamp: new Date(NOW + 2_000).toISOString(),
			},
			{
				type: "label",
				id: "label-1",
				parentId: "session-info",
				timestamp: new Date(NOW + 3_000).toISOString(),
				targetId: "session-info",
				label: "Earlier label",
			},
			{
				type: "label",
				id: "label-2",
				parentId: "label-1",
				timestamp: new Date(NOW + 4_000).toISOString(),
				targetId: "message-1",
				label: "Latest label",
			},
			{
				type: "message",
				id: "message-2",
				parentId: "label-2",
				timestamp: new Date(NOW + 5_000).toISOString(),
				message: secondMessage,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [first, second] = entries;
		if (first === undefined || second === undefined) throw new Error("Legacy message chain was not imported");
		expect(second.parentId).toBe(first.id);
		expect(await session.getLabel(first.id, BACKGROUND_CONTEXT)).toBe("Latest label");
		expect(await mainTip(session)).toBe(second.id);
		await session.close(BACKGROUND_CONTEXT);
	});

	it.each([{ label: undefined }, { label: "" }])("clears a label with $label", async ({ label }) => {
		const message = {
			role: "user",
			content: [{ type: "text", text: "clear my label" }],
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(NOW + 1_000).toISOString(),
				message,
			},
			{
				type: "label",
				id: "label-1",
				parentId: "message-1",
				timestamp: new Date(NOW + 2_000).toISOString(),
				targetId: "message-1",
				label: "Earlier label",
			},
			{
				type: "label",
				id: "label-2",
				parentId: "label-1",
				timestamp: new Date(NOW + 3_000).toISOString(),
				targetId: "message-1",
				...(label === undefined ? {} : { label }),
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries(undefined, BACKGROUND_CONTEXT);
		const [entry] = entries;
		if (entry === undefined) throw new Error("Legacy message was not imported");
		expect(await session.getLabel(entry.id, BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await mainTip(session)).toBe(entry.id);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("imports a custom entry without rewriting opaque data references", async () => {
		const messageTimestamp = NOW + 1_000;
		const customTimestamp = NOW + 2_000;
		const message = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: messageTimestamp,
		} satisfies AgentMessage;
		const data = {
			legacyReference: "message-1",
			nested: { legacyReference: "custom-1" },
		};
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(messageTimestamp).toISOString(),
				message,
			},
			{
				type: "custom",
				id: "custom-1",
				parentId: "message-1",
				timestamp: new Date(customTimestamp).toISOString(),
				customType: "checkpoint",
				data,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [messageEntry, customEntry] = entries;
		if (messageEntry === undefined || customEntry === undefined) {
			throw new Error("Legacy custom chain was not imported");
		}
		expect(messageEntry.seq).toBe(1);
		expect(customEntry).toMatchObject({
			type: "custom",
			parentId: messageEntry.id,
			seq: 2,
			timestamp: customTimestamp,
			customType: "checkpoint",
			data,
		});
		expect(customEntry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(uuidTimestamp(customEntry.id)).toBe(customTimestamp);
		expect(await mainTip(session)).toBe(customEntry.id);
		await session.close(BACKGROUND_CONTEXT);
	});

	it("imports a custom message as a current message entry", async () => {
		const parentTimestamp = NOW + 1_000;
		const customMessageTimestamp = NOW + 2_000;
		const parentMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: parentTimestamp,
		} satisfies AgentMessage;
		const content = [{ type: "text", text: "legacy custom message" }];
		const details = { status: "complete" };
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(parentTimestamp).toISOString(),
				message: parentMessage,
			},
			{
				type: "custom_message",
				id: "custom-message-1",
				parentId: "message-1",
				timestamp: new Date(customMessageTimestamp).toISOString(),
				customType: "status",
				content,
				details,
				display: false,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [parentEntry, customMessageEntry] = entries;
		if (parentEntry === undefined || customMessageEntry === undefined) {
			throw new Error("Legacy custom message chain was not imported");
		}
		expect(parentEntry.seq).toBe(1);
		expect(customMessageEntry).toMatchObject({
			type: "message",
			parentId: parentEntry.id,
			seq: 2,
			timestamp: customMessageTimestamp,
			message: {
				role: "custom",
				customType: "status",
				content,
				details,
				display: false,
				timestamp: customMessageTimestamp,
			},
		});
		expect(customMessageEntry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(uuidTimestamp(customMessageEntry.id)).toBe(customMessageTimestamp);
		expect(await mainTip(session)).toBe(customMessageEntry.id);
		expect((await session.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(2);
		await session.close(BACKGROUND_CONTEXT);
	});

	describe("importing branch summaries", () => {
		const branchPointTimestamp = NOW + 1_000;
		const abandonedResponseTimestamp = NOW + 2_000;
		const summaryTimestamp = NOW + 3_000;
		const details = { reason: "navigation" };
		const usage = {
			input: 11,
			output: 7,
			cacheRead: 3,
			cacheWrite: 2,
			totalTokens: 23,
			cost: {
				input: 0.11,
				output: 0.07,
				cacheRead: 0.03,
				cacheWrite: 0.02,
				total: 0.23,
			},
		} satisfies Usage;
		const branchPointMessage = {
			role: "user",
			content: [{ type: "text", text: "Try the first approach" }],
			timestamp: branchPointTimestamp,
		} satisfies AgentMessage;
		const abandonedResponse = {
			role: "assistant",
			content: [{ type: "text", text: "Implemented the first approach" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 20,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 30,
				cost: {
					input: 0.2,
					output: 0.1,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.3,
				},
			},
			stopReason: "stop",
			timestamp: abandonedResponseTimestamp,
		} satisfies AgentMessage;

		async function openFixture(fromHook?: true) {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "branch-point",
					parentId: null,
					timestamp: new Date(branchPointTimestamp).toISOString(),
					message: branchPointMessage,
				},
				{
					type: "message",
					id: "abandoned-response",
					parentId: "branch-point",
					timestamp: new Date(abandonedResponseTimestamp).toISOString(),
					message: abandonedResponse,
				},
				{
					type: "branch_summary",
					id: "summary",
					parentId: "branch-point",
					timestamp: new Date(summaryTimestamp).toISOString(),
					fromId: "branch-point",
					summary: "Summary of the abandoned branch",
					details,
					usage,
					...(fromHook === undefined ? {} : { fromHook }),
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(3);
			const [branchPoint, abandoned, branchSummary] = entries;
			if (branchPoint === undefined || abandoned === undefined || branchSummary === undefined) {
				throw new Error("Legacy branch summary chain was not imported");
			}
			return { session, branchPoint, abandoned, branchSummary };
		}

		it("preserves payload and remaps references", async () => {
			const { session, branchPoint, abandoned, branchSummary } = await openFixture();

			expect(abandoned.parentId).toBe(branchPoint.id);
			expect(branchSummary).toMatchObject({
				type: "branch_summary",
				parentId: branchPoint.id,
				seq: 3,
				timestamp: summaryTimestamp,
				fromId: branchPoint.id,
				summary: "Summary of the abandoned branch",
				details,
				usage,
				fromHook: false,
			});
			expect(branchSummary.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(uuidTimestamp(branchSummary.id)).toBe(summaryTimestamp);
			expect(await mainTip(session)).toBe(branchSummary.id);
			await session.close(BACKGROUND_CONTEXT);
		});

		it("preserves an explicit fromHook flag", async () => {
			const { session, branchSummary } = await openFixture(true);

			expect(branchSummary).toMatchObject({
				type: "branch_summary",
				fromHook: true,
			});
			await session.close(BACKGROUND_CONTEXT);
		});

		it('normalizes fromId "root" to null', async () => {
			await writeLegacyV3Fixture([
				{
					type: "branch_summary",
					id: "summary",
					parentId: null,
					timestamp: new Date(summaryTimestamp).toISOString(),
					fromId: "root",
					summary: "Summary from the root",
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				type: "branch_summary",
				fromId: null,
			});
			await session.close(BACKGROUND_CONTEXT);
		});

		it("rejects a missing fromId", async () => {
			await writeLegacyV3Fixture([
				{
					type: "branch_summary",
					id: "summary",
					parentId: null,
					timestamp: new Date(summaryTimestamp).toISOString(),
					fromId: "missing-legacy-entry",
					summary: "Summary from a missing source",
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			await expect(repo.open(metadata, BACKGROUND_CONTEXT)).rejects.toThrow(
				"Missing legacy v3 entry reference: missing-legacy-entry",
			);
		});

		it("keeps fromId null when a discarded source has no retained ancestor", async () => {
			await writeLegacyV3Fixture([
				{
					type: "model_change",
					id: "model-change",
					parentId: null,
					timestamp: new Date(branchPointTimestamp).toISOString(),
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
				},
				{
					type: "branch_summary",
					id: "summary",
					parentId: "model-change",
					timestamp: new Date(summaryTimestamp).toISOString(),
					fromId: "model-change",
					summary: "Summary from the root",
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatchObject({
				type: "branch_summary",
				parentId: null,
				fromId: null,
			});
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	describe("importing compactions", () => {
		const excludedTimestamp = NOW + 1_000;
		const retainedTimestamp = NOW + 2_000;
		const compactionTimestamp = NOW + 3_000;
		const excludedMessage = {
			role: "user",
			content: [{ type: "text", text: "old context" }],
			timestamp: excludedTimestamp,
		} satisfies AgentMessage;
		const retainedMessage = {
			role: "user",
			content: [{ type: "text", text: "retain this context" }],
			timestamp: retainedTimestamp,
		} satisfies AgentMessage;
		const details = { strategy: "default" };
		const usage = {
			input: 120,
			output: 30,
			cacheRead: 10,
			cacheWrite: 5,
			totalTokens: 165,
			cost: {
				input: 1.2,
				output: 0.3,
				cacheRead: 0.1,
				cacheWrite: 0.05,
				total: 1.65,
			},
		} satisfies Usage;

		async function openFixture(fromHook?: true) {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "excluded-message",
					parentId: null,
					timestamp: new Date(excludedTimestamp).toISOString(),
					message: excludedMessage,
				},
				{
					type: "message",
					id: "retained-message",
					parentId: "excluded-message",
					timestamp: new Date(retainedTimestamp).toISOString(),
					message: retainedMessage,
				},
				{
					type: "compaction",
					id: "compaction",
					parentId: "retained-message",
					timestamp: new Date(compactionTimestamp).toISOString(),
					summary: "Summary of the earlier context",
					firstKeptEntryId: "retained-message",
					tokensBefore: 12_000,
					details,
					usage,
					...(fromHook === undefined ? {} : { fromHook }),
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(3);
			const [excluded, retained, compaction] = entries;
			if (excluded === undefined || retained === undefined || compaction === undefined) {
				throw new Error("Legacy compaction chain was not imported");
			}
			return { session, excluded, retained, compaction };
		}

		it("materializes the retained tail and preserves the payload", async () => {
			const { session, excluded, retained, compaction } = await openFixture();

			expect(retained).toMatchObject({ parentId: excluded.id, seq: 2 });
			expect(compaction).toMatchObject({
				type: "compaction",
				parentId: retained.id,
				seq: 3,
				timestamp: compactionTimestamp,
				summary: "Summary of the earlier context",
				retainedTail: [retainedMessage],
				tokensBefore: 12_000,
				details,
				usage,
				fromHook: false,
			});
			expect(compaction).not.toHaveProperty("firstKeptEntryId");
			expect(compaction.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(uuidTimestamp(compaction.id)).toBe(compactionTimestamp);
			expect(await mainTip(session)).toBe(compaction.id);
			await session.close(BACKGROUND_CONTEXT);
		});

		it("builds the retained tail from the compaction branch rather than physical order", async () => {
			const firstMainMessage = {
				role: "user",
				content: [{ type: "text", text: "first main-branch message" }],
				timestamp: NOW + 10_000,
			} satisfies AgentMessage;
			const firstOtherBranchMessage = {
				role: "user",
				content: [{ type: "text", text: "first unrelated-branch message" }],
				timestamp: NOW + 11_000,
			} satisfies AgentMessage;
			const secondMainMessage = {
				role: "user",
				content: [{ type: "text", text: "second main-branch message" }],
				timestamp: NOW + 12_000,
			} satisfies AgentMessage;
			const secondOtherBranchMessage = {
				role: "user",
				content: [{ type: "text", text: "second unrelated-branch message" }],
				timestamp: NOW + 13_000,
			} satisfies AgentMessage;
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "main-1",
					parentId: null,
					timestamp: new Date(NOW + 10_000).toISOString(),
					message: firstMainMessage,
				},
				{
					type: "message",
					id: "other-1",
					parentId: "main-1",
					timestamp: new Date(NOW + 11_000).toISOString(),
					message: firstOtherBranchMessage,
				},
				{
					type: "message",
					id: "main-2",
					parentId: "main-1",
					timestamp: new Date(NOW + 12_000).toISOString(),
					message: secondMainMessage,
				},
				{
					type: "message",
					id: "other-2",
					parentId: "other-1",
					timestamp: new Date(NOW + 13_000).toISOString(),
					message: secondOtherBranchMessage,
				},
				{
					type: "compaction",
					id: "compaction",
					parentId: "main-2",
					timestamp: new Date(NOW + 14_000).toISOString(),
					summary: "Summary before the retained main branch",
					firstKeptEntryId: "main-1",
					tokensBefore: 8_000,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			const compaction = entries.find((entry) => entry.type === "compaction");

			expect(compaction).toMatchObject({
				type: "compaction",
				retainedTail: [firstMainMessage, secondMainMessage],
			});
			await session.close(BACKGROUND_CONTEXT);
		});

		it("projects every supported legacy node in a retained tail", async () => {
			const ordinaryTimestamp = NOW + 30_000;
			const customMessageTimestamp = NOW + 31_000;
			const customEntryTimestamp = NOW + 32_000;
			const branchSummaryTimestamp = NOW + 33_000;
			const olderCompactionTimestamp = NOW + 34_000;
			const finalCompactionTimestamp = NOW + 35_000;
			const ordinaryMessage = {
				role: "user",
				content: [{ type: "text", text: "ordinary retained message" }],
				timestamp: ordinaryTimestamp,
			} satisfies AgentMessage;
			const customContent = [{ type: "text" as const, text: "custom retained message" }];
			const customDetails = { status: "complete" };
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "ordinary-message",
					parentId: null,
					timestamp: new Date(ordinaryTimestamp).toISOString(),
					message: ordinaryMessage,
				},
				{
					type: "custom_message",
					id: "custom-message",
					parentId: "ordinary-message",
					timestamp: new Date(customMessageTimestamp).toISOString(),
					customType: "notice",
					content: customContent,
					details: customDetails,
					display: false,
				},
				{
					type: "custom",
					id: "plain-custom",
					parentId: "custom-message",
					timestamp: new Date(customEntryTimestamp).toISOString(),
					customType: "checkpoint",
					data: { ignored: true },
				},
				{
					type: "branch_summary",
					id: "branch-summary",
					parentId: "plain-custom",
					timestamp: new Date(branchSummaryTimestamp).toISOString(),
					fromId: "ordinary-message",
					summary: "Earlier branch work",
				},
				{
					type: "compaction",
					id: "older-compaction",
					parentId: "branch-summary",
					timestamp: new Date(olderCompactionTimestamp).toISOString(),
					summary: "Older compacted context",
					firstKeptEntryId: "ordinary-message",
					tokensBefore: 4_000,
				},
				{
					type: "compaction",
					id: "final-compaction",
					parentId: "older-compaction",
					timestamp: new Date(finalCompactionTimestamp).toISOString(),
					summary: "Final compacted context",
					firstKeptEntryId: "ordinary-message",
					tokensBefore: 8_000,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			const session = await repo.open(metadata, BACKGROUND_CONTEXT);
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(6);
			const ordinary = entries.at(0);
			const finalCompaction = entries.at(-1);
			if (ordinary === undefined || finalCompaction?.type !== "compaction") {
				throw new Error("Legacy retained-tail fixture was not imported");
			}

			expect(uuidTimestamp(ordinary.id)).toBe(ordinaryTimestamp);
			expect(finalCompaction.retainedTail).toEqual([
				ordinaryMessage,
				{
					role: "custom",
					customType: "notice",
					content: customContent,
					details: customDetails,
					display: false,
					timestamp: customMessageTimestamp,
				},
				{
					role: "branchSummary",
					summary: "Earlier branch work",
					fromId: ordinary.id,
					timestamp: branchSummaryTimestamp,
				},
				{
					role: "compactionSummary",
					summary: "Older compacted context",
					tokensBefore: 4_000,
					timestamp: olderCompactionTimestamp,
				},
			]);
			await session.close(BACKGROUND_CONTEXT);
		});

		it.each([
			{ boundary: "missing", firstKeptEntryId: "missing-entry" },
			{ boundary: "off-branch", firstKeptEntryId: "other-branch" },
		])("rejects a $boundary firstKeptEntryId", async ({ firstKeptEntryId }) => {
			await writeLegacyV3Fixture([
				{
					type: "message",
					id: "root",
					parentId: null,
					timestamp: new Date(NOW + 20_000).toISOString(),
					message: excludedMessage,
				},
				{
					type: "message",
					id: "main-branch",
					parentId: "root",
					timestamp: new Date(NOW + 21_000).toISOString(),
					message: retainedMessage,
				},
				{
					type: "message",
					id: "other-branch",
					parentId: "root",
					timestamp: new Date(NOW + 22_000).toISOString(),
					message: excludedMessage,
				},
				{
					type: "compaction",
					id: "compaction",
					parentId: "main-branch",
					timestamp: new Date(NOW + 23_000).toISOString(),
					summary: "Summary before the retained main branch",
					firstKeptEntryId,
					tokensBefore: 8_000,
				},
			]);
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

			await expect(repo.open(metadata, BACKGROUND_CONTEXT)).rejects.toThrow(
				"firstKeptEntryId is not on its parent branch",
			);
		});

		it("preserves an explicit fromHook flag", async () => {
			const { session, compaction } = await openFixture(true);

			expect(compaction).toMatchObject({ type: "compaction", fromHook: true });
			await session.close(BACKGROUND_CONTEXT);
		});
	});

	it("remaps a legacy message chain and exposes it through current APIs", async () => {
		const firstTimestamp = NOW + 1_000;
		const secondTimestamp = NOW + 2_000;
		const firstMessage = {
			role: "user",
			content: [{ type: "text", text: "first" }],
			timestamp: firstTimestamp,
		} satisfies AgentMessage;
		const secondMessage = {
			role: "user",
			content: [{ type: "text", text: "second" }],
			timestamp: secondTimestamp,
		} satisfies AgentMessage;
		await writeLegacyV3Fixture([
			{
				type: "message",
				id: "message-1",
				parentId: null,
				timestamp: new Date(firstTimestamp).toISOString(),
				message: firstMessage,
			},
			{
				type: "message",
				id: "message-2",
				parentId: "message-1",
				timestamp: new Date(secondTimestamp).toISOString(),
				message: secondMessage,
			},
		]);
		const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
		if (metadata === undefined) throw new Error("Legacy fixture was not discovered");

		const session = await repo.open(metadata, BACKGROUND_CONTEXT);
		const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
		expect(entries).toHaveLength(2);
		const [first, second] = entries;
		if (first === undefined || second === undefined) throw new Error("Legacy message chain was not imported");
		expect(first).toMatchObject({
			parentId: null,
			seq: 1,
			timestamp: firstTimestamp,
			message: firstMessage,
		});
		expect(second).toMatchObject({
			parentId: first.id,
			seq: 2,
			timestamp: secondTimestamp,
			message: secondMessage,
		});
		expect(await mainTip(session)).toBe(second.id);
		expect(
			(await (await mainBranch(session)).findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT)).map(
				(entry) => entry.id,
			),
		).toEqual([first.id, second.id]);
		expect((await session.getStats(BACKGROUND_CONTEXT)).messageCount).toBe(2);
		await session.close(BACKGROUND_CONTEXT);
	});

	describe("opening a legacy v3 message session", () => {
		const entryTimestamp = NOW + 1_234;
		const message = {
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: NOW + 1_000,
		} satisfies AgentMessage;
		let session: Session<JsonlSessionMetadata>;
		let path: string;
		let content: string;
		let beforeMtime: number;

		beforeEach(async () => {
			({ path, content } = await writeLegacyV3Fixture([
				{
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: new Date(entryTimestamp).toISOString(),
					message,
				},
			]));
			beforeMtime = getOrThrow(await fileSystem.fileInfo(path, BACKGROUND_CONTEXT)).mtimeMs;
			const [metadata] = await repo.list({ cwd: "/workspace" }, BACKGROUND_CONTEXT);
			if (metadata === undefined) throw new Error("Legacy fixture was not discovered");
			session = await repo.open(metadata, BACKGROUND_CONTEXT);
		});

		afterEach(async () => {
			await session?.close(BACKGROUND_CONTEXT);
		});

		async function importedEntry(): Promise<Entry> {
			const entries = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);
			expect(entries).toHaveLength(1);
			const [entry] = entries;
			if (entry === undefined) throw new Error("Legacy message was not imported");
			return entry;
		}

		it("exposes the legacy message through the current entry API", async () => {
			expect(await importedEntry()).toMatchObject({
				type: "message",
				parentId: null,
				seq: 1,
				timestamp: entryTimestamp,
				message,
			});
		});

		it("remints the entry id as a UUIDv7 with the legacy timestamp", async () => {
			const entry = await importedEntry();

			expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			expect(uuidTimestamp(entry.id)).toBe(entryTimestamp);
		});

		it("initializes a data-only main Branch at the imported entry", async () => {
			const entry = await importedEntry();

			expect(await mainTip(session)).toBe(entry.id);
			expect(await session.getValue(storedValues.laneState("main"), BACKGROUND_CONTEXT)).toBeUndefined();
			expect(await session.getValue(storedValues.laneConfig("main"), BACKGROUND_CONTEXT)).toBeUndefined();
		});

		it("leaves the legacy source untouched after open and close", async () => {
			await session.close(BACKGROUND_CONTEXT);

			expect(getOrThrow(await fileSystem.readTextFile(path, BACKGROUND_CONTEXT))).toBe(content);
			expect(getOrThrow(await fileSystem.fileInfo(path, BACKGROUND_CONTEXT)).mtimeMs).toBe(beforeMtime);
		});
	});
});
