import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../src/index.ts";
import { createAssistantMessage, createTempDir, createUserMessage } from "./test-utils.ts";

describe("SQLite branch queries", () => {
	it("does not decode entries outside bounded branch queries", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const middleId = await session.appendMessage(createAssistantMessage("middle"));
		const leafId = await session.appendMessage(createUserMessage("leaf"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", "session-1", middleId);
			const branch = await db
				.prepare("SELECT branch_id FROM branch_entries WHERE session_id = ? AND entry_id = ?")
				.get<{ branch_id: string }>("session-1", leafId);
			if (!branch) throw new Error("Missing branch cache for bounded SQLite query test");
			await db
				.prepare("DELETE FROM branch_entries WHERE session_id = ? AND branch_id = ? AND entry_id = ?")
				.run("session-1", branch.branch_id, middleId);
		} finally {
			await db.close();
		}

		expect((await session.findEntriesOnBranch({ start: leafId, stopAtId: leafId })).map((entry) => entry.id)).toEqual(
			[leafId],
		);
		expect(
			(
				await session.findEntriesOnBranch({
					start: leafId,
					stopAtId: rootId,
					order: "oldestFirst",
					limit: 1,
				})
			).map((entry) => entry.id),
		).toEqual([rootId]);
		await expect(session.findEntriesOnBranch({ start: leafId, limit: 2 })).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining(`Entry ${middleId} not found`),
		});
	});

	it("validates entries before branch query filters and limits", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		await session.appendMessage(createUserMessage("root"));
		const customId = await session.appendCustomEntry("note", { value: 1 });
		const leafId = await session.appendMessage(createAssistantMessage("leaf"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("{}", "session-1", customId);
		} finally {
			await db.close();
		}
		await expect(session.findEntriesOnBranch({ start: leafId, type: "message", limit: 1 })).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining(`failed to decode entry ${customId}`),
		});

		const invalidJsonDb = await sqlite.open(databasePath);
		try {
			await invalidJsonDb
				.prepare("UPDATE entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", "session-1", customId);
		} finally {
			await invalidJsonDb.close();
		}
		await expect(session.findEntriesOnBranch({ start: leafId, customType: "other" })).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining(`failed to decode entry ${customId}`),
		});
	});

	it("does not validate ancestors beyond newest-first stop bounds", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		const childId = await session.appendMessage(createAssistantMessage("child"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE entries SET parent_id = ? WHERE session_id = ? AND id = ?")
				.run("missing-parent", "session-1", childId);
		} finally {
			await db.close();
		}
		expect(
			(await session.findEntriesOnBranch({ start: childId, stopAtId: childId })).map((entry) => entry.id),
		).toEqual([childId]);
		expect(
			(await session.findEntriesOnBranch({ start: childId, stopAtType: "message" })).map((entry) => entry.id),
		).toEqual([childId]);
		await expect(session.findEntriesOnBranch({ start: childId })).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining("Entry missing-parent not found"),
		});

		const cycleDb = await sqlite.open(databasePath);
		try {
			await cycleDb
				.prepare("UPDATE entries SET parent_id = ? WHERE session_id = ? AND id = ?")
				.run(rootId, "session-1", childId);
			await cycleDb
				.prepare("UPDATE entries SET parent_id = ? WHERE session_id = ? AND id = ?")
				.run(childId, "session-1", rootId);
		} finally {
			await cycleDb.close();
		}
		expect(
			(await session.findEntriesOnBranch({ start: childId, stopAtId: childId })).map((entry) => entry.id),
		).toEqual([childId]);
		expect(
			(await session.findEntriesOnBranch({ start: childId, stopAtType: "message" })).map((entry) => entry.id),
		).toEqual([childId]);
		await expect(session.findEntriesOnBranch({ start: childId })).rejects.toMatchObject({
			code: "invalid_entry",
			message: expect.stringContaining(`Entry ${childId} not found`),
		});
	});
});
