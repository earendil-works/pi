import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applyMigrations,
	createNodeSqliteFactory,
	type SqliteDatabase,
	type SqliteDatabaseFactory,
	type SqliteRunResult,
	type SqliteSessionMetadata,
	SqliteSessionRepo,
	SqliteSessionStorage,
	type SqliteStatement,
} from "../../../storage/sqlite-node/src/index.ts";
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

describe("SQLite migrations", () => {
	it("applies file-based migrations and records them", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepo({ env, sqlite, databasePath });
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
					"session_entries",
					"session_sequences",
					"branch_entries",
					"session_materialized",
					"entry_materialized",
				]),
			);
			const sessionColumns = await db.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
			expect(sessionColumns.map((column) => column.name)).toContain("active_leaf_id");
			for (const tableName of [
				"sessions",
				"session_sequences",
				"branch_entries",
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

	it("persists session metadata through create, list, open, and fork", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepo({ env, sqlite: createNodeSqliteFactory(), databasePath });
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

	it("materializes active leaf id in sessions transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepo({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const childId = await session.appendMessage(createAssistantMessage("child"));
		await session.getStorage().setLeafId(rootId);

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
		const repo = new SqliteSessionRepo({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const firstChildId = await session.appendMessage(createAssistantMessage("first child"));
		await session.getStorage().setLeafId(rootId);
		const secondChildId = await session.appendMessage(createAssistantMessage("second child"));

		const db = await sqlite.open(databasePath);
		try {
			const branchRows = await db
				.prepare(
					"SELECT branch_id, entry_id, entry_seq FROM branch_entries WHERE session_id = ? ORDER BY branch_id, entry_seq",
				)
				.all<{ branch_id: string; entry_id: string; entry_seq: number }>("session-1");
			const branchIds = [...new Set(branchRows.map((row) => row.branch_id))];
			expect(branchIds).toHaveLength(3);
			expect(branchRows.filter((row) => row.entry_id === rootId)).toHaveLength(3);
			expect(branchRows.filter((row) => row.entry_id === firstChildId)).toHaveLength(1);
			expect(branchRows.filter((row) => row.entry_id === secondChildId)).toHaveLength(1);
		} finally {
			await db.close();
		}
	});

	it("reopens using branch materialization and session summary state", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepo({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		await session.appendMessage(createAssistantMessage("first child"));
		await session.appendSessionName("  Reopened Session  ");
		await session.getStorage().setLeafId(rootId);
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
		const repo = new SqliteSessionRepo({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("one"));
		await session.appendMessage(createAssistantMessage("two"));
		await session.appendMessage(createUserMessage("three"));

		expect((await session.getEntries({ limit: 2 })).map((entry) => entry.type)).toEqual(["message", "message"]);
		expect((await session.getEntries({ afterEntrySeq: 2, limit: 2 })).map((entry) => entry.type)).toEqual([
			"message",
			"message",
		]);
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
		const repo = new SqliteSessionRepo({ env, sqlite, databasePath: join(root, "sessions.sqlite") });

		await expect(repo.create({ cwd: root, id: "session-1" })).rejects.toThrow("insert failed");
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
		const repo = new SqliteSessionRepo({ env, sqlite, databasePath: join(root, "sessions.sqlite") });
		const metadata: SqliteSessionMetadata = {
			id: "missing",
			createdAt: new Date().toISOString(),
			cwd: root,
			path: join(root, "sessions.sqlite"),
		};
		writeFileSync(metadata.path, "");

		await expect(repo.open(metadata)).rejects.toThrow("Session not found: missing");
		expect(db.closeCount).toBe(1);
	});

	it("closes the source storage after fork reads its entries", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepo({ env, sqlite: createNodeSqliteFactory(), databasePath });
		let cleanupCount = 0;
		const sourceStorage = {
			async getEntries() {
				return [];
			},
			async getPathToRootOrCompaction() {
				return [];
			},
			async cleanup() {
				cleanupCount += 1;
			},
		} as const;
		const originalOpen = repo.open.bind(repo);
		repo.open = async () =>
			({
				getStorage() {
					return sourceStorage;
				},
			}) as never;

		try {
			await repo.fork(
				{
					id: "session-1",
					createdAt: new Date().toISOString(),
					cwd: root,
					path: databasePath,
				},
				{ cwd: root, id: "session-2" },
			);
		} finally {
			repo.open = originalOpen;
		}

		expect(cleanupCount).toBe(1);
	});

	it("restores in-memory state when appendEntry fails after mutating caches", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		await applyMigrations(db);
		const storage = await SqliteSessionStorage.create(db, databasePath, {
			cwd: root,
			sessionId: "session-1",
		});
		const originalPrepare = db.prepare.bind(db);
		db.prepare = (sql: string) => {
			if (sql.startsWith("UPDATE sessions SET active_leaf_id = ?")) {
				return new ThrowingStatement(async () => {
					throw new Error("active leaf update failed");
				});
			}
			return originalPrepare(sql);
		};

		await expect(
			storage.appendEntry({
				type: "message",
				id: "root",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: createUserMessage("root"),
			}),
		).rejects.toMatchObject({ code: "storage" });
		expect(await storage.getLeafId()).toBeNull();
		expect(await storage.getEntry("root")).toBeUndefined();
		expect(await storage.getEntries()).toEqual([]);
		await db.close();
	});

	it("materializes session summary fields transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepo({ env, sqlite, databasePath });
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
