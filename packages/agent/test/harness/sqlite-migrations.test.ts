import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteRunResult,
	type SqliteSessionMetadata,
	SqliteSessionRepository,
	type SqliteStatement,
} from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import {
	appendSqliteCompaction,
	appendSqliteLabel,
	appendSqliteSessionName,
	buildSqliteContext,
	createAssistantMessage,
	createUserMessage,
	getSqliteEntries,
	moveSqliteMainLane,
} from "./session-test-utils.ts";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-agent-sqlite-"));
}

class ThrowingStatement implements SqliteStatement {
	private readonly onRun: () => SqliteRunResult;

	constructor(onRun: () => SqliteRunResult) {
		this.onRun = onRun;
	}

	run(..._params: unknown[]): SqliteRunResult {
		return this.onRun();
	}

	get<TRow extends object>(..._params: unknown[]): TRow | undefined {
		return undefined;
	}

	all<TRow extends object>(..._params: unknown[]): TRow[] {
		return [];
	}
}

class CountingDatabase implements SqliteDatabase {
	closeCount = 0;
	private readonly statementFactory: (sql: string) => SqliteStatement;

	constructor(statementFactory: (sql: string) => SqliteStatement) {
		this.statementFactory = statementFactory;
	}

	exec(_sql: string): void {}

	prepare(sql: string): SqliteStatement {
		return this.statementFactory(sql);
	}

	transaction<T>(fn: () => T): T {
		return fn();
	}

	close(): void {
		this.closeCount += 1;
	}
}

function createCloseCountingSqliteFactory(): {
	sqlite: SqliteDatabaseFactory;
	counts: { opens: number; closes: number };
} {
	const source = createNodeSqliteFactory();
	const counts = { opens: 0, closes: 0 };
	return {
		counts,
		sqlite: {
			async open(path) {
				const db = await source.open(path);
				counts.opens += 1;
				return {
					exec: (sql) => db.exec(sql),
					prepare: (sql) => db.prepare(sql),
					transaction: (fn) => db.transaction(fn),
					close() {
						counts.closes += 1;
						db.close();
					},
				};
			},
		},
	};
}

describe("SQLite migrations", () => {
	it("applies file-based migrations and records them", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			const rows = await db.prepare("SELECT id FROM migrations ORDER BY id").all<{ id: string }>();
			expect(rows.map((row) => row.id)).toEqual(["001_initial.sql"]);
			const tables = await db
				.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string; sql: string | null }>();
			expect(tables.map((row) => row.name)).toEqual(
				expect.arrayContaining([
					"migrations",
					"sessions",
					"entries",
					"session_sequences",
					"branch_entries",
					"branch_tips",
				]),
			);
			const sessionColumns = await db.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
			expect(sessionColumns.map((column) => column.name)).not.toContain("leaf_id");
			expect(tables.map((row) => row.name)).toEqual(
				expect.arrayContaining(["lanes", "records", "lane_moves", "facts", "leases", "session_stats"]),
			);
			const branchIndexes = await db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'branch_entries'")
				.all<{ name: string }>();
			expect(branchIndexes.map((index) => index.name)).toContain("idx_branch_entries_session_branch_seq");
			expect(branchIndexes.map((index) => index.name)).not.toContain("idx_branch_entries_session_branch");
			for (const tableName of [
				"sessions",
				"session_sequences",
				"session_stats",
				"branch_entries",
				"branch_tips",
				"lanes",
				"records",
				"lane_moves",
				"facts",
			]) {
				const table = tables.find((row) => row.name === tableName);
				expect(table?.sql).toContain("WITHOUT ROWID");
			}
		} finally {
			await db.close();
		}
	});

	it("persists session metadata through create, list, open, and fork", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const source = await repo.create({
			cwd: root,
			id: "session-1",
			metadata: { profile: "reviewer" },
		});
		const sourceMetadata = await source.getMetadata();
		expect(sourceMetadata.metadata).toEqual({ profile: "reviewer" });
		expect((await repo.list({ cwd: root })).map((listed) => listed.metadata)).toEqual([{ profile: "reviewer" }]);
		const reopened = await repo.open(sourceMetadata);
		expect((await reopened.getMetadata()).metadata).toEqual({ profile: "reviewer" });
		const fork = await repo.fork(sourceMetadata, { cwd: root, id: "session-2" });
		expect((await fork.getMetadata()).metadata).toEqual({ profile: "reviewer" });
		const overridden = await repo.fork(sourceMetadata, {
			cwd: root,
			id: "session-3",
			metadata: { profile: "writer" },
		});
		expect((await overridden.getMetadata()).metadata).toEqual({ profile: "writer" });
	});

	it("rolls back the entire fork when copying an entry fails", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const source = await repo.create({ cwd: root, id: "source" });
		await source.appendMessage(createUserMessage("one"));
		await source.appendMessage(createAssistantMessage("two"));

		const db = await sqlite.open(databasePath);
		try {
			await db.exec(`
CREATE TRIGGER fail_fork_entry BEFORE INSERT ON entries
WHEN new.session_id = 'fork' AND new.seq = 2
BEGIN
  SELECT RAISE(ABORT, 'fail fork');
END;
`);
		} finally {
			await db.close();
		}

		await expect(repo.fork(await source.getMetadata(), { cwd: root, id: "fork" })).rejects.toMatchObject({
			code: "storage",
		});
		const inspection = await sqlite.open(databasePath);
		try {
			expect(
				await inspection.prepare("SELECT id FROM sessions WHERE id = ?").get<{ id: string }>("fork"),
			).toBeUndefined();
			expect(
				await inspection.prepare("SELECT id FROM entries WHERE session_id = ?").all<{ id: string }>("fork"),
			).toEqual([]);
		} finally {
			await inspection.close();
		}
	});

	it("materializes the main lane leaf transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const childId = await session.appendMessage(createAssistantMessage("child"));
		await moveSqliteMainLane(session, rootId);

		const db = await sqlite.open(databasePath);
		try {
			const row = await db
				.prepare("SELECT leaf_id FROM lanes WHERE session_id = ? AND lane = ?")
				.get<{ leaf_id: string | null }>("session-1", "main");
			expect(row?.leaf_id).toBe(rootId);
			const latestLaneMove = await db
				.prepare("SELECT lane, leaf_id FROM lane_moves WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
				.get<{ lane: string; leaf_id: string | null }>("session-1");
			expect(latestLaneMove).toEqual({ lane: "main", leaf_id: rootId });
		} finally {
			await db.close();
		}

		const reopened = await repo.open(await session.getMetadata());
		expect(await reopened.getLeafId()).toBe(rootId);
		expect(childId).not.toBe(rootId);
	});

	it("materializes a new branch when appending from a parent with an existing child", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const firstChildId = await session.appendMessage(createAssistantMessage("first child"));
		await moveSqliteMainLane(session, rootId);
		const secondChildId = await session.appendMessage(createAssistantMessage("second child"));

		const db = await sqlite.open(databasePath);
		try {
			const branchRows = await db
				.prepare(
					"SELECT branch_id, entry_id, entry_seq FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq",
				)
				.all<{ branch_id: string; entry_id: string; entry_seq: number }>("session-1");
			const branchIds = [...new Set(branchRows.map((row) => row.branch_id))];
			expect(branchIds).toHaveLength(2);
			expect(branchRows.filter((row) => row.entry_id === rootId)).toHaveLength(2);
			expect(branchRows.filter((row) => row.entry_id === firstChildId)).toHaveLength(1);
			expect(branchRows.filter((row) => row.entry_id === secondChildId)).toHaveLength(1);
			const tips = await db
				.prepare("SELECT branch_id, tip_id FROM branch_tips WHERE session_id = ? ORDER BY branch_id")
				.all<{ branch_id: string; tip_id: string }>("session-1");
			expect(tips.map((tip) => tip.branch_id)).toEqual(branchIds.sort());
			expect(new Set(tips.map((tip) => tip.tip_id)).size).toBe(tips.length);
		} finally {
			await db.close();
		}
	});

	it("reopens using branch materialization and session summary state", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		await session.appendMessage(createAssistantMessage("first child"));
		await appendSqliteSessionName(session, "  Reopened Session  ");
		await moveSqliteMainLane(session, rootId);
		await session.appendMessage(createAssistantMessage("branched child"));

		const reopened = await repo.open(await session.getMetadata());
		expect(await reopened.getName()).toBe("Reopened Session");
		expect((await buildSqliteContext(reopened)).messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect((await buildSqliteContext(reopened)).messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: "branched child" }],
		});
	});

	it("closes the database when create fails after openDatabase succeeds", async () => {
		const root = createTempDir();
		const db = new CountingDatabase((sql) => {
			if (sql.startsWith("INSERT INTO sessions")) {
				return new ThrowingStatement(() => {
					throw new Error("insert failed");
				});
			}
			return new ThrowingStatement(() => ({ changes: 1 }));
		});
		const sqlite: SqliteDatabaseFactory = {
			open: async () => db,
		};
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath: join(root, "sessions.sqlite") });

		await expect(repo.create({ cwd: root, id: "session-1" })).rejects.toThrow("insert failed");
		expect(db.closeCount).toBe(0);
		await repo[Symbol.asyncDispose]();
		expect(db.closeCount).toBe(1);
	});

	it("closes the database when open fails after openDatabase succeeds", async () => {
		const root = createTempDir();
		const db = new CountingDatabase((sql) => {
			if (sql.includes("FROM sessions WHERE id = ?")) {
				return new ThrowingStatement(() => ({ changes: 0 }));
			}
			return new ThrowingStatement(() => ({ changes: 1 }));
		});
		const sqlite: SqliteDatabaseFactory = {
			open: async () => db,
		};
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath: join(root, "sessions.sqlite") });
		const metadata: SqliteSessionMetadata = {
			id: "missing",
			createdAt: Date.now(),
			cwd: root,
			path: join(root, "sessions.sqlite"),
		};
		writeFileSync(metadata.path, "");

		await expect(repo.open(metadata)).rejects.toThrow("Session not found: missing");
		expect(db.closeCount).toBe(0);
		await repo[Symbol.asyncDispose]();
		expect(db.closeCount).toBe(1);
	});

	it("retains one connection for repeated session operations", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const { sqlite, counts } = createCloseCountingSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });

		const session = await repo.create({ cwd: root, id: "session-1" });
		for (let i = 0; i < 10; i++) await session.appendMessage(createUserMessage(`message ${i}`));
		await getSqliteEntries(session);
		expect(counts).toEqual({ opens: 1, closes: 0 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
	});

	it("shares one connection across source and fork until the repository is disposed", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const { sqlite, counts } = createCloseCountingSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const source = await repo.create({ cwd: root, id: "session-1" });

		const fork = await repo.fork(await source.getMetadata(), { cwd: root, id: "session-2" });
		await fork.appendMessage(createUserMessage("fork"));
		expect(counts).toEqual({ opens: 1, closes: 0 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
	});

	it("rejects a missing lane leaf when listing lanes and opening", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE lanes SET leaf_id = ? WHERE session_id = ? AND lane = ?")
				.run("missing", metadata.id, "main");
		} finally {
			await db.close();
		}

		await expect(session.getLanes()).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("Lane main points at missing entry missing"),
		});
		await expect(repo.open(metadata)).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("Lane main points at missing entry missing"),
		});
	});

	it("fails loudly when a stored entry is read and cannot be decoded", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const entryId = await session.appendMessage(createUserMessage("message"));
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", metadata.id, entryId);
		} finally {
			await db.close();
		}

		const reopened = await repo.open(metadata);
		await expect(getSqliteEntries(reopened)).rejects.toMatchObject({ code: "invalid_entry" });
	});

	it("does not publish connection state when an append transaction fails", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const db = await sqlite.open(databasePath);
		try {
			await db.exec(`
				CREATE TRIGGER fail_branch_tip_insert
				BEFORE INSERT ON branch_tips
				BEGIN
					SELECT RAISE(ABORT, 'branch insert failed');
				END;
			`);
			await expect(session.appendMessage(createUserMessage("root"))).rejects.toThrow("branch insert failed");
			const lane = await db
				.prepare("SELECT leaf_id FROM lanes WHERE session_id = ? AND lane = ?")
				.get<{ leaf_id: string | null }>("session-1", "main");
			expect(lane?.leaf_id).toBeNull();
			expect(await db.prepare("SELECT id FROM entries WHERE session_id = ?").all("session-1")).toEqual([]);
			expect(await session.getStats()).toMatchObject({ messageCount: 0 });
			await db.exec("DROP TRIGGER fail_branch_tip_insert");
		} finally {
			await db.close();
		}
		const entryId = await session.appendMessage(createUserMessage("root"));
		expect((await getSqliteEntries(session)).map((entry) => entry.id)).toEqual([entryId]);
		expect(await session.getStats()).toMatchObject({ messageCount: 1 });
	});

	it("materializes session summary fields transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const userId = await session.appendMessage(createUserMessage("one"));
		const assistant = {
			...createAssistantMessage("two"),
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 100,
				output: 25,
				cacheRead: 40,
				cacheWrite: 10,
				totalTokens: 175,
				cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
			},
		};
		const assistantId = await session.appendMessage(assistant);
		await session.appendRecord({
			type: "usage",
			id: "assistant-usage",
			lane: "main",
			cause: "assistant",
			runId: "run",
			entryId: assistantId,
			attempt: 1,
			stopReason: "stop",
			usage: assistant.usage,
		});
		const compactionUsage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const compactionId = await appendSqliteCompaction(session, "summary", 200, undefined, compactionUsage);
		await session.appendRecord({
			type: "usage",
			id: "compaction-usage",
			lane: "main",
			cause: "compaction",
			runId: "run",
			entryId: compactionId,
			attempt: 1,
			stopReason: "stop",
			usage: compactionUsage,
		});
		const branchUsage = {
			input: 5,
			output: 6,
			cacheRead: 7,
			cacheWrite: 8,
			totalTokens: 26,
			cost: { input: 0.05, output: 0.06, cacheRead: 0.07, cacheWrite: 0.08, total: 0.26 },
		};
		const branchSummaryId = await moveSqliteMainLane(session, userId, {
			summary: "branch summary",
			usage: branchUsage,
		});
		if (!branchSummaryId) throw new Error("Expected branch summary");
		await session.appendRecord({
			type: "usage",
			id: "branch-summary-usage",
			lane: "main",
			cause: "branch_summary",
			runId: "run",
			entryId: branchSummaryId,
			attempt: 1,
			stopReason: "stop",
			usage: branchUsage,
		});
		await appendSqliteSessionName(session, "  My Session  ");
		await appendSqliteLabel(session, userId, "checkpoint");

		expect(await session.getStats()).toMatchObject({
			messageCount: 2,
			cachedTokens: 50,
			uncachedTokens: 128,
			totalTokens: 211,
			costTotal: 0.73,
		});

		const db = await sqlite.open(databasePath);
		try {
			expect(
				await db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_materialized'")
					.get(),
			).toBeUndefined();
			expect(
				await db
					.prepare("SELECT type, COUNT(*) AS count FROM records WHERE session_id = ? AND type = ? GROUP BY type")
					.get<{ type: string; count: number }>("session-1", "usage"),
			).toEqual({ type: "usage", count: 3 });
			expect(
				await db
					.prepare(
						`SELECT message_count, cached_tokens, uncached_tokens, total_tokens, cost_total
						FROM session_stats
						WHERE session_id = ?`,
					)
					.get("session-1"),
			).toEqual({
				message_count: 2,
				cached_tokens: 50,
				uncached_tokens: 128,
				total_tokens: 211,
				cost_total: 0.73,
			});
			const nameFact = await db
				.prepare("SELECT value FROM facts WHERE session_id = ? AND kind = 'name' ORDER BY seq DESC LIMIT 1")
				.get<{ value: string }>("session-1");
			expect(JSON.parse(nameFact?.value ?? "null")).toBe("My Session");
			const labelFact = await db
				.prepare("SELECT key, value FROM facts WHERE session_id = ? AND kind = 'label' ORDER BY seq DESC LIMIT 1")
				.get<{ key: string; value: string }>("session-1");
			expect(labelFact?.key).toBe(userId);
			expect(JSON.parse(labelFact?.value ?? "null")).toBe("checkpoint");
		} finally {
			await db.close();
		}
	});
});
