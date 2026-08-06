import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations, createNodeSqliteFactory } from "../src/index.ts";
import { createTempDir } from "./test-utils.ts";

describe("SQLite migrations", () => {
	it("applies the current schema once and records its migration", async () => {
		const databasePath = join(createTempDir(), "sessions.sqlite");
		const db = await createNodeSqliteFactory().open(databasePath);
		try {
			await applyMigrations(db);
			await applyMigrations(db);

			const rows = db.prepare("SELECT id FROM migrations ORDER BY id").all<{ id: string }>();
			expect(rows.map((row) => row.id)).toEqual(["001_initial.sql"]);
			const tables = db
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
				.all<{ name: string }>();
			expect(tables.map((row) => row.name)).toEqual(
				expect.arrayContaining([
					"migrations",
					"sessions",
					"entries",
					"session_sequences",
					"session_stats",
					"branch_entries",
					"branch_tips",
					"lanes",
					"records",
					"lane_moves",
					"facts",
					"writer_leases",
				]),
			);
			const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all<{ name: string }>();
			expect(sessionColumns.map((column) => column.name)).not.toContain("leaf_id");
			const laneColumns = db.prepare("PRAGMA table_info(lanes)").all<{ name: string }>();
			expect(laneColumns.map((column) => column.name)).toContain("open_operation_id");
		} finally {
			db.close();
		}
	});
});
