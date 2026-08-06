import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import {
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteRunResult,
	SqliteSessionRepository,
	type SqliteStatement,
} from "../src/index.ts";
import {
	appendSqliteCompaction,
	createAssistantMessage,
	createSetupFailureSqlite,
	createTempDir,
	createUserMessage,
	getSqliteEntries,
	moveSqliteMainLane,
} from "./test-utils.ts";

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

describe("SQLite session repository", () => {
	it("persists session metadata through create, list, open, and fork", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		await using repo = new SqliteSessionRepository({ env, sqlite: createNodeSqliteFactory(), databasePath });
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
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
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

	it("retains an opened database after a failed operation until disposal", async () => {
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
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath: join(root, "sessions.sqlite") });

		await expect(repo.create({ cwd: root, id: "session-1" })).rejects.toThrow("insert failed");
		expect(db.closeCount).toBe(0);
		await repo[Symbol.asyncDispose]();
		expect(db.closeCount).toBe(1);
	});

	it("closes the database when repository setup fails", async () => {
		const root = createTempDir();
		const { sqlite, counts } = createSetupFailureSqlite();
		await using repository = new SqliteSessionRepository({
			env: new NodeExecutionEnv({ cwd: root }),
			sqlite,
			databasePath: join(root, "sessions.sqlite"),
		});

		await expect(repository.create({ cwd: root, id: "session-1" })).rejects.toThrow("setup failed");
		expect(counts.closes).toBe(1);
	});

	it("closes active sessions when the repository is disposed", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		await using repo = new SqliteSessionRepository({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });

		await repo[Symbol.asyncDispose]();

		await expect(session.appendMessage(createUserMessage("late"))).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("SQLite session session-1 is closed"),
		});
	});

	it("retains one connection for repeated session operations", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const { sqlite, counts } = createCloseCountingSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });

		const session = await repo.create({ cwd: root, id: "session-1" });
		for (let i = 0; i < 10; i++) await session.appendMessage(createUserMessage(`message ${i}`));
		await getSqliteEntries(session);
		expect(counts).toEqual({ opens: 1, closes: 0 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
		await repo[Symbol.asyncDispose]();
		expect(counts).toEqual({ opens: 1, closes: 1 });
	});

	it("rejects a missing lane leaf when listing lanes and opening", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
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

	it.each([
		["invalid JSON", "not json", "metadata is not valid JSON"],
		["a non-object value", "[]", "metadata must be an object"],
	])("rejects stored session metadata containing %s", async (_case, stored, message) => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		await repo.create({ cwd: root, id: "session-1" });

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("UPDATE sessions SET metadata = ? WHERE id = ?").run(stored, "session-1");
		} finally {
			await db.close();
		}

		await expect(repo.list()).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining(message),
		});
	});

	it.each([
		["invalid JSON", "not json", "name is not valid JSON"],
		["a non-string value", "{}", "name must be a string"],
		["a NULL value", null, "name must be a string"],
	])("rejects stored session names containing %s", async (_case, stored, message) => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.setName("valid name");

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("UPDATE facts SET value = ? WHERE session_id = ? AND kind = 'name'").run(stored, "session-1");
		} finally {
			await db.close();
		}

		await expect(repo.list()).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining(message),
		});
		await expect(session.getMetadata()).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining(message),
		});
	});

	it("fails loudly when a stored entry is read and cannot be decoded", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
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

	it("fails loudly when a stored record cannot be decoded", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendRecord({
			type: "operation_finished",
			id: "record-1",
			lane: "main",
			runId: "run-1",
			outcome: "completed",
		});

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE records SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", "session-1", "record-1");
		} finally {
			await db.close();
		}

		await expect(session.findRecords()).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("failed to decode payload"),
		});
	});

	it("does not publish connection state when an append transaction fails", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
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

	it("accounts for assistant, compaction, and branch-summary usage", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
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
		expect(await session.getStats()).toEqual({
			messageCount: 2,
			cachedTokens: 50,
			uncachedTokens: 128,
			totalTokens: 211,
			costTotal: 0.73,
		});
	});
});
