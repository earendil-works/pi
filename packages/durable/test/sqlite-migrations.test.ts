import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it } from "vitest";
import { idFromNumber } from "../src/ids.ts";
import {
	applySqliteMigrations,
	CURRENT_SQLITE_SCHEMA_VERSION,
	SQLITE_MIGRATIONS,
	type SqliteMigration,
} from "../src/storage/sqlite/index.ts";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { type EntryId, ROOT_CONVERSATION_ID } from "../src/types.ts";

const directories = new Set<string>();

async function databasePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-migrations-"));
	directories.add(directory);
	return join(directory, "storage.sqlite");
}

afterEach(async () => {
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

describe("durable SQLite migrations", () => {
	it("creates the current schema and can be applied repeatedly", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
		try {
			await applySqliteMigrations(database);
			await applySqliteMigrations(database);
			expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
				version: CURRENT_SQLITE_SCHEMA_VERSION,
			});
			expect(database.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1").get()).toEqual({
				next_id: "2",
				next_seq: 1,
			});
		} finally {
			database.close();
		}
	});

	it("rejects a database newer than the portable core", async () => {
		const path = await databasePath();
		const database = await openNodeSqliteDatabase(path);
		await applySqliteMigrations(database);
		database
			.prepare("UPDATE durable_schema SET version = ? WHERE singleton = 1")
			.run(CURRENT_SQLITE_SCHEMA_VERSION + 1);
		database.close();

		await expect(openNodeSqliteStorage(path)).rejects.toThrow("is newer than supported version");
	});

	it("rolls initial bootstrap and every pending migration back together", async () => {
		const database = await openNodeSqliteDatabase(await databasePath());
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
			await expect(applySqliteMigrations(database, failed)).rejects.toThrow();
			expect(
				database
					.prepare(
						"SELECT count(*) AS count FROM sqlite_schema WHERE name IN ('durable_schema', 'migration_first', 'migration_second')",
					)
					.get(),
			).toEqual({ count: 0 });

			await applySqliteMigrations(database, [
				failed[0],
				{ version: 2, statements: ["CREATE TABLE migration_second (value TEXT) STRICT"] },
			]);
			expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
				version: 2,
			});
			expect(database.prepare("SELECT value FROM migration_first").get()).toEqual({ value: "retained" });
		} finally {
			database.close();
		}
	});

	it("rolls a failed migration back and preserves stored data for a successful retry", async () => {
		const path = await databasePath();
		const storage = await openNodeSqliteStorage(path);
		await storage.commit(
			[
				{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
				{
					type: "entry",
					value: {
						id: idFromNumber<EntryId>(2),
						conversationId: ROOT_CONVERSATION_ID,
						kind: "retained",
						data: { retained: true },
					},
				},
			],
			BACKGROUND_CONTEXT,
		);
		await storage.close(BACKGROUND_CONTEXT);

		const database = await openNodeSqliteDatabase(path);
		const nextVersion = CURRENT_SQLITE_SCHEMA_VERSION + 1;
		const failedMigrations: readonly SqliteMigration[] = [
			...SQLITE_MIGRATIONS,
			{
				version: nextVersion,
				statements: ["CREATE TABLE migration_probe (value TEXT) STRICT", "THIS IS NOT SQL"],
			},
		];
		await expect(applySqliteMigrations(database, failedMigrations)).rejects.toThrow();
		expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
			version: CURRENT_SQLITE_SCHEMA_VERSION,
		});
		expect(
			database
				.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'migration_probe'")
				.get(),
		).toEqual({ count: 0 });

		const successfulMigrations: readonly SqliteMigration[] = [
			...SQLITE_MIGRATIONS,
			{ version: nextVersion, statements: ["CREATE TABLE migration_probe (value TEXT) STRICT"] },
		];
		await applySqliteMigrations(database, successfulMigrations);
		expect(database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get()).toEqual({
			version: nextVersion,
		});
		expect(database.prepare("SELECT record, commit_seq FROM entries WHERE id = 2").get()).toEqual({
			record: JSON.stringify({
				id: 2,
				conversationId: ROOT_CONVERSATION_ID,
				kind: "retained",
				data: { retained: true },
			}),
			commit_seq: 1,
		});
		expect(database.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1").get()).toEqual({
			next_id: "3",
			next_seq: 2,
		});
		database.close();
	});
});
