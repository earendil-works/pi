import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../../../storage/sqlite-node/src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createAssistantMessage, createUserMessage } from "./session-test-utils.ts";

function createTempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-agent-sqlite-branch-cache-"));
}

describe("SQLite branch cache", () => {
	it("collections complete root paths for branches created after compaction", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const keptId = await session.appendMessage(createUserMessage("kept"));
		const compactionId = await session.appendCompaction("summary", keptId, 100);
		await session.appendMessage(createAssistantMessage("first child"));
		await session.moveTo(compactionId);
		const branchedId = await session.appendMessage(createAssistantMessage("branched child"));

		const db = await sqlite.open(databasePath);
		try {
			const row = await db
				.prepare("SELECT branch_id FROM branch_entries WHERE session_id = ? AND entry_id = ?")
				.get<{ branch_id: string }>("session-1", branchedId);
			if (!row) throw new Error("Missing branched entry cache row");
			const entries = await db
				.prepare("SELECT entry_id FROM branch_entries WHERE session_id = ? AND branch_id = ? ORDER BY entry_seq")
				.all<{ entry_id: string }>("session-1", row.branch_id);
			expect(entries.map((entry) => entry.entry_id)).toEqual([rootId, keptId, compactionId, branchedId]);
		} finally {
			await db.close();
		}
	});

	it("reads only the compacted branch window from the complete cache", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const oldId = await session.appendMessage(createUserMessage("old"));
		const keptId = await session.appendMessage(createUserMessage("kept"));
		const compactionId = await session.appendCompaction("summary", keptId, 100);
		const leafId = await session.appendMessage(createAssistantMessage("new"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE session_entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", "session-1", oldId);
		} finally {
			await db.close();
		}

		expect((await session.getBranch()).map((entry) => entry.id)).toEqual([keptId, compactionId, leafId]);
	});

	it("preserves nested compaction boundaries when reading the cache", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new SqliteSessionRepository({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const firstCompactionId = await session.appendCompaction(
			"first summary",
			rootId,
			100,
			undefined,
			false,
			undefined,
			[],
		);
		const middleId = await session.appendMessage(createUserMessage("middle"));
		const secondCompactionId = await session.appendCompaction("second summary", rootId, 200);
		const leafId = await session.appendMessage(createAssistantMessage("new"));

		expect((await session.getBranch()).map((entry) => entry.id)).toEqual([
			firstCompactionId,
			middleId,
			secondCompactionId,
			leafId,
		]);
	});

	it("repairs a missing branch cache from canonical parent links", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const childId = await session.appendMessage(createAssistantMessage("child"));

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run("session-1");
			await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run("session-1");
		} finally {
			await db.close();
		}

		expect((await session.getBranch()).map((entry) => entry.id)).toEqual([rootId, childId]);

		const inspection = await sqlite.open(databasePath);
		try {
			const rows = await inspection
				.prepare("SELECT branch_id, entry_id FROM branch_entries WHERE session_id = ? ORDER BY entry_seq")
				.all<{ branch_id: string; entry_id: string }>("session-1");
			expect(rows.map((row) => row.entry_id)).toEqual([rootId, childId]);
			const tip = await inspection
				.prepare("SELECT branch_id, tip_id FROM branch_tips WHERE session_id = ?")
				.get<{ branch_id: string; tip_id: string }>("session-1");
			expect(rows).toHaveLength(2);
			expect(tip).toEqual({ branch_id: rows[0]?.branch_id, tip_id: childId });
		} finally {
			await inspection.close();
		}
	});

	it("rolls back an interrupted branch cache repair", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("root"));

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run("session-1");
			await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run("session-1");
			await db.exec(`
				CREATE TRIGGER fail_branch_cache_repair
				BEFORE INSERT ON branch_tips
				BEGIN
					SELECT RAISE(ABORT, 'repair failed');
				END;
			`);
		} finally {
			await db.close();
		}

		await expect(session.getBranch()).rejects.toMatchObject({
			code: "storage",
			message: expect.stringContaining("Failed to rebuild SQLite branch cache"),
		});

		const inspection = await sqlite.open(databasePath);
		try {
			expect(
				await inspection.prepare("SELECT entry_id FROM branch_entries WHERE session_id = ?").all("session-1"),
			).toEqual([]);
			await inspection.exec("DROP TRIGGER fail_branch_cache_repair");
		} finally {
			await inspection.close();
		}
		expect(await session.getBranch()).toHaveLength(1);
	});

	it("repairs a missing source branch cache while forking transactionally", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const source = await repo.create({ cwd: root, id: "source" });
		const rootId = await source.appendMessage(createUserMessage("root"));
		const childId = await source.appendMessage(createAssistantMessage("child"));

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run("source");
			await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run("source");
		} finally {
			await db.close();
		}

		const fork = await repo.fork(await source.getMetadata(), {
			cwd: root,
			id: "fork",
			entryId: childId,
			position: "at",
		});
		expect((await fork.getEntries()).map((entry) => entry.id)).toEqual([rootId, childId]);
	});

	it("repairs a stale branch cache from canonical parent links", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const staleId = await session.appendMessage(createAssistantMessage("stale"));
		const leafId = await session.appendMessage(createUserMessage("leaf"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE session_entries SET parent_id = ? WHERE session_id = ? AND id = ?")
				.run(rootId, "session-1", leafId);
		} finally {
			await db.close();
		}

		expect(
			(await session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" })).map((entry) => entry.id),
		).toEqual([rootId, leafId]);
		const inspection = await sqlite.open(databasePath);
		try {
			const rows = await inspection
				.prepare(
					`SELECT entry_id FROM branch_entries
					WHERE session_id = ? AND branch_id = (
						SELECT branch_id FROM branch_entries WHERE session_id = ? AND entry_id = ? LIMIT 1
					)
					ORDER BY entry_seq`,
				)
				.all<{ entry_id: string }>("session-1", "session-1", leafId);
			expect(rows.map((row) => row.entry_id)).toEqual([rootId, leafId]);
			expect(rows.map((row) => row.entry_id)).not.toContain(staleId);
		} finally {
			await inspection.close();
		}
	});

	it("deletes branch entries and tips with the session", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		const repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("root"));
		const metadata = await session.getMetadata();

		await repo.delete(metadata);

		const db = await sqlite.open(databasePath);
		try {
			expect(await db.prepare("SELECT entry_id FROM branch_entries WHERE session_id = ?").all("session-1")).toEqual(
				[],
			);
			expect(await db.prepare("SELECT tip_id FROM branch_tips WHERE session_id = ?").all("session-1")).toEqual([]);
		} finally {
			await db.close();
		}
	});
});
