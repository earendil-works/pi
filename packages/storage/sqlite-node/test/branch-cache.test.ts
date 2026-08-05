import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../src/index.ts";
import {
	appendSqliteCompaction,
	createAssistantMessage,
	createTempDir,
	createUserMessage,
	getSqliteBranch,
	moveSqliteMainLane,
} from "./test-utils.ts";

describe("SQLite branch cache", () => {
	it("collects complete root paths for branches created after compaction", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const keptId = await session.appendMessage(createUserMessage("kept"));
		const compactionId = await appendSqliteCompaction(session, "summary", 100);
		await session.appendMessage(createAssistantMessage("first child"));
		await moveSqliteMainLane(session, compactionId);
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
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const oldId = await session.appendMessage(createUserMessage("old"));
		await session.appendMessage(createUserMessage("kept"));
		const compactionId = await appendSqliteCompaction(session, "summary", 100);
		const leafId = await session.appendMessage(createAssistantMessage("new"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", "session-1", oldId);
		} finally {
			await db.close();
		}

		expect((await getSqliteBranch(session)).map((entry) => entry.id)).toEqual([compactionId, leafId]);
	});

	it("preserves nested compaction boundaries when reading the cache", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		await using repo = new SqliteSessionRepository({ env, sqlite: createNodeSqliteFactory(), databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("root"));
		await appendSqliteCompaction(session, "first summary", 100, undefined, undefined, []);
		await session.appendMessage(createUserMessage("middle"));
		const secondCompactionId = await appendSqliteCompaction(session, "second summary", 200);
		const leafId = await session.appendMessage(createAssistantMessage("new"));

		expect((await getSqliteBranch(session)).map((entry) => entry.id)).toEqual([secondCompactionId, leafId]);
	});

	it("rejects reads and writes without repairing a missing private branch cache", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("root"));
		await session.appendMessage(createAssistantMessage("child"));

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run("session-1");
			await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run("session-1");
		} finally {
			await db.close();
		}

		await expect(getSqliteBranch(session)).rejects.toMatchObject({ code: "invalid_entry" });
		await expect(session.appendMessage(createAssistantMessage("later"))).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining("has no branch containing parent entry"),
		});

		const inspection = await sqlite.open(databasePath);
		try {
			expect(
				await inspection.prepare("SELECT entry_id FROM branch_entries WHERE session_id = ?").all("session-1"),
			).toEqual([]);
		} finally {
			await inspection.close();
		}
	});

	it("repairs the private branch cache explicitly", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const childId = await session.appendMessage(createAssistantMessage("child"));
		const metadata = await session.getMetadata();

		const db = await sqlite.open(databasePath);
		try {
			await db.prepare("DELETE FROM branch_tips WHERE session_id = ?").run("session-1");
			await db.prepare("DELETE FROM branch_entries WHERE session_id = ?").run("session-1");
		} finally {
			await db.close();
		}

		await expect(getSqliteBranch(session)).rejects.toMatchObject({ code: "invalid_entry" });

		await repo.repairBranchCache(metadata);

		expect((await getSqliteBranch(session)).map((entry) => entry.id)).toEqual([rootId, childId]);
	});

	it("fails when forking from a source with a missing branch cache", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
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

		expect(rootId).not.toBe(childId);
		await expect(
			repo.fork(await source.getMetadata(), {
				cwd: root,
				id: "fork",
				entryId: childId,
				position: "at",
			}),
		).rejects.toMatchObject({ code: "invalid_fork_target" });
	});

	it("fails when the private branch cache is stale", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const staleId = await session.appendMessage(createAssistantMessage("stale"));
		const leafId = await session.appendMessage(createUserMessage("leaf"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE entries SET parent_id = ? WHERE session_id = ? AND id = ?")
				.run(rootId, "session-1", leafId);
		} finally {
			await db.close();
		}

		expect(staleId).not.toBe(leafId);
		await expect(session.findEntriesOnBranch({ start: leafId, order: "oldestFirst" })).rejects.toMatchObject({
			code: "invalid_entry",
		});
	});

	it("deletes branch entries and tips with the session", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
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
