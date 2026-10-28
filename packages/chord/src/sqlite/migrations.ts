import type { SqliteDatabase } from "./database.ts";
import { validateSqliteSchemaPrefix } from "./schema.ts";

export type SqliteMigration = {
	readonly version: number;
	readonly statements: readonly string[];
};

type SchemaRow = { readonly version: number };

/** Apply all pending migrations atomically, tracking their version in the named metadata table. */
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[],
	options: { readonly table: string },
): Promise<void> {
	const { table } = options;
	validateSqliteSchemaPrefix(table);
	for (let index = 0; index < migrations.length; index++) {
		if (migrations[index]?.version !== index + 1) {
			throw new Error("SQLite migrations must have contiguous versions starting at 1");
		}
	}

	await database.transaction(async (transaction) => {
		await transaction.exec(`CREATE TABLE IF NOT EXISTS ${table} (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT`);
		await transaction.run(`INSERT OR IGNORE INTO ${table} (singleton, version) VALUES (1, 0)`);
		const row = await transaction.get<SchemaRow>(`SELECT version FROM ${table} WHERE singleton = 1`);
		if (row === undefined) throw new Error("SQLite schema metadata is missing");
		const currentVersion = migrations.at(-1)?.version ?? 0;
		if (row.version > currentVersion) {
			throw new Error(`SQLite schema version ${row.version} is newer than supported version ${currentVersion}`);
		}
		for (const migration of migrations) {
			if (migration.version <= row.version) continue;
			for (const statement of migration.statements) await transaction.exec(statement);
			await transaction.run(`UPDATE ${table} SET version = ? WHERE singleton = 1`, migration.version);
		}
	});
}
