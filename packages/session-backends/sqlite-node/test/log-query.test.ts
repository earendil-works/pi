import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory, SqliteSessionRepository } from "../src/index.ts";
import { createTempDir, createUserMessage } from "./test-utils.ts";

describe("SQLite log queries", () => {
	it("does not decode rows beyond the requested log limit", async () => {
		const root = createTempDir();
		const databasePath = join(root, "sessions.sqlite");
		const env = new NodeExecutionEnv({ cwd: root });
		const sqlite = createNodeSqliteFactory();
		await using repo = new SqliteSessionRepository({ env, sqlite, databasePath });
		const session = await repo.create({ cwd: root, id: "session-1" });
		const rootId = await session.appendMessage(createUserMessage("root"));
		await session.setName("name");
		const tailId = await session.appendMessage(createUserMessage("tail"));

		const db = await sqlite.open(databasePath);
		try {
			await db
				.prepare("UPDATE entries SET payload = ? WHERE session_id = ? AND id = ?")
				.run("not json", "session-1", tailId);
		} finally {
			await db.close();
		}

		expect(await session.getLog({ limit: 1 })).toEqual([
			expect.objectContaining({ kind: "entry", seq: 1, entry: expect.objectContaining({ id: rootId }) }),
		]);
		expect(await session.getLog({ afterSeq: 1, limit: 1 })).toEqual([
			expect.objectContaining({ kind: "fact", seq: 2, fact: "name", name: "name" }),
		]);
	});
});
