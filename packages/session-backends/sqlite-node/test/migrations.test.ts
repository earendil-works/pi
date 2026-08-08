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
			const sessionIndexes = db.prepare("PRAGMA index_list(sessions)").all<{ name: string }>();
			expect(sessionIndexes.map((index) => index.name)).toContain("idx_sessions_cwd_created_at");
			expect(sessionIndexes.map((index) => index.name)).not.toContain("idx_sessions_parent");
			const laneColumns = db.prepare("PRAGMA table_info(lanes)").all<{ name: string }>();
			expect(laneColumns.map((column) => column.name)).toContain("open_operation_id");
			const entryIndexes = db.prepare("PRAGMA index_list(entries)").all<{ name: string }>();
			expect(entryIndexes.map((index) => index.name)).not.toContain("idx_entries_session_seq");
			const branchEntryIndexes = db.prepare("PRAGMA index_list(branch_entries)").all<{ name: string }>();
			expect(branchEntryIndexes.map((index) => index.name)).toContain("idx_branch_entries_session_entry");
			const recordIndexes = db.prepare("PRAGMA index_list(records)").all<{ name: string }>();
			expect(recordIndexes.map((index) => index.name)).toEqual(
				expect.arrayContaining([
					"idx_records_session_lane_seq",
					"idx_records_session_type_seq",
					"idx_records_session_type_op_kind_seq",
				]),
			);
			expect(recordIndexes.map((index) => index.name)).not.toContain("idx_records_session_seq");
			const laneMoveIndexes = db.prepare("PRAGMA index_list(lane_moves)").all<{ name: string }>();
			expect(laneMoveIndexes.map((index) => index.name)).not.toContain("idx_lane_moves_session_lane_seq");
		} finally {
			db.close();
		}
	});
});
