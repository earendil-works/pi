import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeSqliteFactory } from "../../../storage/sqlite-node/src/index.ts";
import { createTempDir } from "./session-test-utils.ts";

describe("sqlite-node adapter", () => {
	it("supports node:sqlite-style named parameters", async () => {
		const root = createTempDir();
		const databasePath = join(root, "adapter.sqlite");
		const sqlite = createNodeSqliteFactory();
		const db = await sqlite.open(databasePath);
		try {
			await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)");
			await db.prepare("INSERT INTO items (id, text) VALUES ($id, $text)").run({ $id: 1, $text: "hello" });
			const row = await db.prepare("SELECT text FROM items WHERE id = $id").get<{ text: string }>({ $id: 1 });
			expect(row).toEqual({ text: "hello" });
		} finally {
			await db.close();
		}
	});
});
