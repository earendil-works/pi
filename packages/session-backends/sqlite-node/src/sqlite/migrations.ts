import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "./sql.ts";
import type { SqliteDatabase } from "./types.ts";

export interface SqliteMigration {
	id: string;
	order: number;
	sql: string;
}

async function loadMigrationSql(relativePath: string): Promise<string> {
	return readFile(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

export async function loadMigrations(): Promise<SqliteMigration[]> {
	return [
		{
			id: "001_initial.sql",
			order: 1,
			sql: await loadMigrationSql("./migrations/001_initial.sql"),
		},
	];
}

function ensureMigrationsTable(db: SqliteDatabase): void {
	sql`
CREATE TABLE IF NOT EXISTS migrations (
	id TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
);
`.exec(db);
}

export async function applyMigrations(db: SqliteDatabase): Promise<void> {
	ensureMigrationsTable(db);
	const migrations = await loadMigrations();
	const appliedRows = sql`SELECT id FROM migrations ORDER BY applied_at, id`.all<{ id: string }>(db);
	const applied = new Set(appliedRows.map((row) => row.id));

	for (const migration of migrations) {
		if (applied.has(migration.id)) continue;
		db.transaction(() => {
			db.exec(migration.sql);
			sql`INSERT INTO migrations (id, applied_at) VALUES (${migration.id}, ${new Date().toISOString()})`.run(db);
		});
		applied.add(migration.id);
	}
}
