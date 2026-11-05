// The SQLite telemetry store's tables and their versions: the migrations a recorder applies, and the check a reader
// makes that a file holds a store of this version.

import { applySqliteMigrations, type SqliteDatabase, type SqliteMigration } from "../sqlite/index.ts";

/** The table that records the store's version. */
const VERSION_TABLE = "telemetry_schema";

/**
 * The store's versions. 1: spans with their start and end in milliseconds (`started_ms`, `ended_ms`, whole
 * milliseconds at the start); 2: in whole microseconds (`started_us`, `ended_us`, integers), the rows of 1 kept,
 * their times multiplied.
 */
const MIGRATIONS: readonly SqliteMigration[] = [
	{
		version: 1,
		statements: [
			`CREATE TABLE telemetry_spans (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, name TEXT, started_ms REAL,
			ended_ms REAL NOT NULL, attributes TEXT, events TEXT, links TEXT, status TEXT)`,
			"CREATE INDEX telemetry_spans_ended_ms ON telemetry_spans(ended_ms)",
			"CREATE INDEX telemetry_spans_trace_started ON telemetry_spans(trace_id, started_ms)",
			"CREATE INDEX telemetry_spans_started_ms ON telemetry_spans(started_ms)",
			`CREATE TABLE telemetry_metrics (interval_ms INTEGER, series_key TEXT, name TEXT, kind TEXT,
			unit TEXT, attributes TEXT, count INTEGER, sum REAL, min REAL, max REAL, PRIMARY KEY(interval_ms, series_key))`,
		],
	},
	{
		version: 2,
		statements: [
			`CREATE TABLE telemetry_spans_us (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT, name TEXT,
			started_us INTEGER, ended_us INTEGER NOT NULL, attributes TEXT, events TEXT, links TEXT, status TEXT)`,
			`INSERT INTO telemetry_spans_us SELECT id, trace_id, parent_id, name, CAST(round(started_ms * 1000) AS INTEGER),
			CAST(round(ended_ms * 1000) AS INTEGER), attributes, events, links, status FROM telemetry_spans`,
			"DROP TABLE telemetry_spans",
			"ALTER TABLE telemetry_spans_us RENAME TO telemetry_spans",
			"CREATE INDEX telemetry_spans_ended_us ON telemetry_spans(ended_us)",
			"CREATE INDEX telemetry_spans_trace_started ON telemetry_spans(trace_id, started_us)",
			"CREATE INDEX telemetry_spans_started_us ON telemetry_spans(started_us)",
		],
	},
];

/** Brings the store in `db` to this version (made when absent; one of an older version migrated, its rows kept). */
export function migrateTelemetryStore(db: SqliteDatabase): Promise<void> {
	return applySqliteMigrations(db, MIGRATIONS, { table: VERSION_TABLE });
}

/**
 * Throws unless `db` holds a store of this version: a reader cannot migrate (a recorder of this version, opened on the
 * file once, does).
 */
export async function assertTelemetryStore(db: SqliteDatabase): Promise<void> {
	const expected = MIGRATIONS.at(-1)!.version;
	// The file is the trust boundary here: any file may be named, a store or not.
	const tables = await db.all<{ name: string }>(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
		VERSION_TABLE,
	);
	if (tables.length === 0) throw new Error("not a telemetry store: no telemetry_schema table");
	const row = await db.get<{ version: number }>(`SELECT version FROM ${VERSION_TABLE} WHERE singleton = 1`);
	const version = row?.version ?? 0;
	if (version > expected)
		throw new Error(`telemetry store version ${version} is newer than this reader's ${expected}`);
	if (version < expected) {
		throw new Error(
			`telemetry store version ${version}, not ${expected}: a recorder (createSqliteTelemetry) migrates it`,
		);
	}
}
