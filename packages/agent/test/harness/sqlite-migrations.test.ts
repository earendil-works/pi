import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyMigrations,
	createNodeSqliteFactory,
	loadMigrations,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteRunResult,
	type SqliteSessionMetadata,
	SqliteSessionRepository,
	type SqliteStatement,
} from "../../../storage/sqlite-node/src/index.ts";
import { SqliteSessionConnection } from "../../../storage/sqlite-node/src/sqlite/storage/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createAssistantMessage, createUserMessage } from "./session-test-utils.ts";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-agent-sqlite-"));
}

class ThrowingStatement implements SqliteStatement {
	private readonly onRun: () => Promise<SqliteRunResult>;

	constructor(onRun: () => Promise<SqliteRunResult>) {
		this.onRun = onRun;
	}

	async run(..._params: unknown[]): Promise<SqliteRunResult> {
		return this.onRun();
	}

	async get<TRow extends object>(..._params: unknown[]): Promise<TRow | undefined> {
		return undefined;
	}

	async all<TRow extends object>(..._params: unknown[]): Promise<TRow[]> {
		return [];
	}
}

class CountingDatabase implements SqliteDatabase {
	closeCount = 0;
	private readonly statementFactory: (sql: string) => SqliteStatement;

	constructor(statementFactory: (sql: string) => SqliteStatement) {
		this.statementFactory = statementFactory;
	}

	async exec(_sql: string): Promise<void> {}

	prepare(sql: string): SqliteStatement {
		return this.statementFactory(sql);
	}

	async transaction<T>(fn: () => Promise<T>): Promise<T> {
		return fn();
	}

	async close(): Promise<void> {
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
					async close() {
						counts.closes += 1;
						await db.close();
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
			expect(rows.map((row) => row.id)).toEqual(["001_initial.sql", "002_branch_tips.sql"]);
			const tables = await db
				.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string; sql: string | null }>();
			expect(tables.map((row) => row.name)).toEqual(
				expect.arrayContaining([
					"migrations",
					"sessions",
					"session_entries",
					"session_sequences",
					"branch_entries",
					"branch_tips",
					"session_materialized",
					"entry_materialized",
				]),
			);
			const sessionColumns = await db.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
			expect(sessionColumns.map((column) => column.name)).toContain("active_leaf_id");
			const branchIndexes = await db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'branch_entries'")
				.all<{ name: string }>();
			expect(branchIndexes.map((index) => index.name)).toContain("idx_branch_entries_session_branch_seq");
			expect(branchIndexes.map((index) => index.name)).not.toContain("idx_branch_entries_session_branch");
			for (const tableName of [
				"sessions",
				"session_sequences",
				"branch_entries",
				"branch_tips",
				"session_materialized",
				"entry_materialized",
			]) {
				const table = tables.find((row) => row.name === tableName);
				expect(table?.sql).toContain("WITHOUT ROWID");
			}
		} finally {
			await db.close();
		}
	});

	it("clears legacy branch projections when adding explicit tips", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			const initial = (await loadMigrations()).find((migration) => migration.id === "001_initial.sql");
			if (!initial) throw new Error("Missing initial SQLite migration");
			await db.exec(initial.sql);
			await db.exec("CREATE TABLE migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
			await db
				.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)")
				.run(initial.id, "2026-01-01T00:00:00.000Z");
			await db
				.prepare("INSERT INTO branch_entries (session_id, branch_id, entry_id, entry_seq) VALUES (?, ?, ?, ?)")
				.run("session-1", "legacy-branch", "entry-1", 1);

			await applyMigrations(db);

			expect(await db.prepare("SELECT entry_id FROM branch_entries").all<{ entry_id: string }>()).toEqual([]);
			expect(
				await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'branch_tips'").get(),
			).toBeDefined();
			expect(
				(await db.prepare("SELECT id FROM migrations ORDER BY id").all<{ id: string }>()).map((row) => row.id),
			).toEqual(["001_initial.sql", "002_branch_tips.sql"]);
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
		expect((await (await repo.open(sourceMetadata)).getMetadata()).metadata).toEqual({ profile: "reviewer" });
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
CREATE TRIGGER fail_fork_entry BEFORE INSERT ON session_entries
WHEN new.session_id = 'fork' AND new.entry_seq = 2
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
				await inspection.prepare("SELECT id FROM session_entries WHERE session_id = ?").all<{ id: string }>("fork"),
			).toEqual([]);
		} finally {
			await inspection.close();
		}
	});

	it("materializes active leaf id in sessions transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const childId = await session.appendMessage(createAssistantMessage("child"));
		await session.moveTo(rootId);

		const db = await sqlite.open(databasePath);
		try {
			const row = await db
				.prepare("SELECT active_leaf_id FROM sessions WHERE id = ?")
				.get<{ active_leaf_id: string | null }>("session-1");
			expect(row?.active_leaf_id).toBe(rootId);
			const latestBranchRow = await db
				.prepare(
					"SELECT branch_id, entry_id, entry_seq FROM branch_entries WHERE session_id = ? ORDER BY entry_seq DESC LIMIT 1",
				)
				.get<{ branch_id: string; entry_id: string; entry_seq: number }>("session-1");
			const latestSessionEntry = await db
				.prepare("SELECT id, type FROM session_entries WHERE session_id = ? ORDER BY entry_seq DESC LIMIT 1")
				.get<{ id: string; type: string }>("session-1");
			expect(latestSessionEntry?.type).toBe("leaf");
			expect(latestBranchRow?.entry_id).toBe(latestSessionEntry?.id);
			if (!latestBranchRow) throw new Error("Missing latest branch row");
			const branchTip = await db
				.prepare("SELECT branch_id, tip_id FROM branch_tips WHERE session_id = ? AND branch_id = ?")
				.get<{ branch_id: string; tip_id: string }>("session-1", latestBranchRow.branch_id);
			expect(branchTip?.tip_id).toBe(latestSessionEntry?.id);
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
		await session.moveTo(rootId);
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
		await session.appendSessionName("  Reopened Session  ");
		await session.moveTo(rootId);
		await session.appendMessage(createAssistantMessage("branched child"));

		const reopened = await repo.open(await session.getMetadata());
		expect(await reopened.getSessionName()).toBe("Reopened Session");
		expect((await reopened.buildContext()).messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect((await reopened.buildContext()).messages.at(-1)).toMatchObject({
			content: [{ type: "text", text: "branched child" }],
		});
	});

	it("pages entries by entry_seq cursor", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const ids = [
			await session.appendMessage(createUserMessage("one")),
			await session.appendMessage(createAssistantMessage("two")),
			await session.appendMessage(createUserMessage("three")),
		];

		expect((await session.getEntries({ limit: 2 })).map((entry) => entry.id)).toEqual(ids.slice(0, 2));
		expect((await session.getEntries({ afterEntrySeq: 1, limit: 2 })).map((entry) => entry.id)).toEqual(ids.slice(1));
	});

	it("closes the database when create fails after openDatabase succeeds", async () => {
		const root = createTempDir();
		const db = new CountingDatabase((sql) => {
			if (sql.startsWith("INSERT INTO sessions")) {
				return new ThrowingStatement(async () => {
					throw new Error("insert failed");
				});
			}
			return new ThrowingStatement(async () => ({ changes: 1 }));
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
				return new ThrowingStatement(async () => ({ changes: 0 }));
			}
			return new ThrowingStatement(async () => ({ changes: 1 }));
		});
		const sqlite: SqliteDatabaseFactory = {
			open: async () => db,
		};
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath: join(root, "sessions.sqlite") });
		const metadata: SqliteSessionMetadata = {
			id: "missing",
			createdAt: new Date().toISOString(),
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
		await session.getEntries();
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

	it("rejects a missing active leaf when opened", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("UPDATE sessions SET active_leaf_id = ? WHERE id = ?").run("missing", metadata.id);
		} finally {
			await db.close();
		}

		await expect(repo.open(metadata)).rejects.toMatchObject({
			code: "invalid_session",
			message: "Entry missing not found",
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
				.prepare("UPDATE session_entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", metadata.id, entryId);
		} finally {
			await db.close();
		}

		const reopened = await repo.open(metadata);
		await expect(reopened.getEntries()).rejects.toMatchObject({ code: "invalid_entry" });
	});

	it("does not publish connection state when an append transaction fails", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		await applyMigrations(db);
		const storage = await SqliteSessionConnection.create(db, databasePath, {
			cwd: root,
			sessionId: "session-1",
		});
		await db.exec(`
			CREATE TEMP TRIGGER fail_branch_tip_insert
			BEFORE INSERT ON branch_tips
			BEGIN
				SELECT RAISE(ABORT, 'branch insert failed');
			END;
		`);

		const rootEntry = {
			type: "message" as const,
			id: "root",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: createUserMessage("root"),
		};
		try {
			await expect(storage.appendEntry(rootEntry)).rejects.toMatchObject({ code: "storage" });
		} finally {
			await db.exec("DROP TRIGGER fail_branch_tip_insert");
		}
		const sessionRow = await db
			.prepare("SELECT active_leaf_id FROM sessions WHERE id = ?")
			.get<{ active_leaf_id: string | null }>("session-1");
		expect(sessionRow?.active_leaf_id).toBeNull();
		expect(await storage.readEntries()).toEqual([]);
		await expect(
			storage.appendEntry({
				type: "leaf",
				id: "leaf",
				parentId: null,
				timestamp: new Date().toISOString(),
				targetId: rootEntry.id,
			}),
		).rejects.toMatchObject({ code: "not_found" });
		expect(await storage.readEntries()).toEqual([]);
		await storage.appendEntry(rootEntry);
		expect(await storage.readEntries()).toEqual([rootEntry]);
		await db.close();
	});

	it("materializes session summary fields transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const userId = await session.appendMessage(createUserMessage("one"));
		await session.appendThinkingLevelChange("high");
		await session.appendModelChange("anthropic", "claude-sonnet-4-5");
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
		await session.appendMessage(assistant);
		await session.appendCompaction("summary", userId, 200, undefined, false, {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		});
		await session.moveTo(userId, {
			summary: "branch summary",
			usage: {
				input: 5,
				output: 6,
				cacheRead: 7,
				cacheWrite: 8,
				totalTokens: 26,
				cost: { input: 0.05, output: 0.06, cacheRead: 0.07, cacheWrite: 0.08, total: 0.26 },
			},
		});
		await session.appendSessionName("  My Session  ");
		await session.appendLabel(userId, "checkpoint");

		const db = await sqlite.open(databasePath);
		try {
			const row = await db.prepare("SELECT session_id, payload FROM session_materialized WHERE session_id = ?").get<{
				session_id: string;
				payload: string;
			}>("session-1");
			expect(row).toBeDefined();
			expect(row?.session_id).toBe("session-1");
			expect(JSON.parse(row?.payload ?? "null")).toMatchObject({
				name: "My Session",
				messageCount: 2,
				cachedTokens: 50,
				uncachedTokens: 128,
				totalTokens: 211,
				costTotal: 0.73,
				currentModel: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
				currentThinkingLevel: "high",
			});
			const entryRows = await db
				.prepare(
					"SELECT session_id, entry_seq, type, payload FROM entry_materialized WHERE session_id = ? ORDER BY entry_seq, type",
				)
				.all<{
					session_id: string;
					entry_seq: number;
					type: string;
					payload: string;
				}>("session-1");
			expect(
				entryRows.some((entryRow) => entryRow.type === "label" && JSON.parse(entryRow.payload).targetId === userId),
			).toBe(true);
			expect(entryRows.some((entryRow) => entryRow.type === "thinking")).toBe(false);
			expect(entryRows.some((entryRow) => entryRow.type === "model")).toBe(false);
		} finally {
			await db.close();
		}
	});
});
