import { describe, expect, it } from "vitest";
import { applySqliteMigrations, type SqliteMigration, validateSqliteSchemaPrefix } from "../../src/sqlite/index.ts";
import { openNodeSqliteDatabase } from "../../src/sqlite/node.ts";

describe("SQLite migrations", () => {
	it("tracks independent histories and skips migrations already applied", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		try {
			const first: readonly SqliteMigration[] = [
				{ version: 1, statements: ["CREATE TABLE notes (body TEXT)", "INSERT INTO notes VALUES ('kept')"] },
			];
			await applySqliteMigrations(database, first, { table: "notes_schema" });
			await applySqliteMigrations(database, first, { table: "notes_schema" });
			await applySqliteMigrations(database, [], { table: "other_schema" });
			await applySqliteMigrations(
				database,
				[...first, { version: 2, statements: ["ALTER TABLE notes ADD COLUMN title TEXT"] }],
				{ table: "notes_schema" },
			);
			expect(await database.all("SELECT body, title FROM notes")).toEqual([{ body: "kept", title: null }]);
			expect(await database.get("SELECT version FROM notes_schema")).toEqual({ version: 2 });
			expect(await database.get("SELECT version FROM other_schema")).toEqual({ version: 0 });
			await expect(applySqliteMigrations(database, first, { table: "notes_schema" })).rejects.toThrow(
				"SQLite schema version 2 is newer than supported version 1",
			);
		} finally {
			await database.close();
		}
	});

	it("rejects invalid migration versions before touching the database", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		try {
			for (const versions of [[0], [2], [1, 3], [1, 1]]) {
				await expect(
					applySqliteMigrations(
						database,
						versions.map((version) => ({ version, statements: [] })),
						{ table: "app_schema" },
					),
				).rejects.toThrow("contiguous versions starting at 1");
			}
			expect(await database.all("SELECT name FROM sqlite_schema")).toEqual([]);
		} finally {
			await database.close();
		}
	});

	it("validates prefixes and migration table identifiers before executing SQL", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		try {
			for (const prefix of ["", "1bad", "bad-prefix", "bad; DROP TABLE notes", "sqlite_app", "SQLITE_app"]) {
				expect(() => validateSqliteSchemaPrefix(prefix)).toThrow();
				await expect(applySqliteMigrations(database, [], { table: prefix })).rejects.toThrow();
			}
			for (const prefix of ["pi_", "_private", "app2"])
				expect(() => validateSqliteSchemaPrefix(prefix)).not.toThrow();
			expect(await database.all("SELECT name FROM sqlite_schema")).toEqual([]);
		} finally {
			await database.close();
		}
	});

	it("rolls initial bootstrap and every pending migration back together", async () => {
		const database = await openNodeSqliteDatabase(":memory:");
		try {
			const failed: readonly SqliteMigration[] = [
				{
					version: 1,
					statements: [
						"CREATE TABLE migration_first (value TEXT) STRICT",
						"INSERT INTO migration_first (value) VALUES ('retained')",
					],
				},
				{
					version: 2,
					statements: ["CREATE TABLE migration_second (value TEXT) STRICT", "THIS IS NOT SQL"],
				},
			];
			await expect(applySqliteMigrations(database, failed, { table: "app_schema" })).rejects.toThrow();
			expect(
				await database.get(
					"SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('app_schema', 'migration_first', 'migration_second')",
				),
			).toEqual({ count: 0 });

			await applySqliteMigrations(
				database,
				[failed[0], { version: 2, statements: ["CREATE TABLE migration_second (value TEXT) STRICT"] }],
				{ table: "app_schema" },
			);
			expect(await database.get("SELECT version FROM app_schema WHERE singleton = 1")).toEqual({
				version: 2,
			});
			expect(await database.get("SELECT value FROM migration_first")).toEqual({
				value: "retained",
			});
		} finally {
			await database.close();
		}
	});
});
