import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, createNodeSqliteFactory } from "../src/index.ts";
import { appendFact, readLatestFact, readLatestLabelFacts } from "../src/sqlite/storage/facts.ts";
import { createTempDir } from "./test-utils.ts";

describe("SQLite fact queries", () => {
	it("reads latest facts and latest non-null labels", async () => {
		const databasePath = join(createTempDir(), "sessions.sqlite");
		const db = await createNodeSqliteFactory().open(databasePath);
		try {
			await applyMigrations(db);
			appendFact(db, "session-1", 1, "label", "entry-1", JSON.stringify("old"));
			appendFact(db, "session-1", 2, "label", "entry-2", JSON.stringify("kept"));
			appendFact(db, "session-1", 3, "label", "entry-1", JSON.stringify("new"));
			appendFact(db, "session-1", 4, "label", "entry-3", JSON.stringify("removed"));
			appendFact(db, "session-1", 5, "label", "entry-3", null);
			appendFact(db, "session-1", 6, "name", null, JSON.stringify("session name"));
			appendFact(db, "other-session", 1, "label", "entry-1", JSON.stringify("other"));

			expect(readLatestFact(db, "session-1", "label", "entry-1")?.value).toBe(JSON.stringify("new"));
			expect(readLatestFact(db, "session-1", "name", null)?.value).toBe(JSON.stringify("session name"));
			expect(readLatestLabelFacts(db, "session-1")).toEqual([
				{ key: "entry-1", value: JSON.stringify("new") },
				{ key: "entry-2", value: JSON.stringify("kept") },
			]);
		} finally {
			db.close();
		}
	});
});
