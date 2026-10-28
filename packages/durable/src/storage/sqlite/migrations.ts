import {
	applySqliteMigrations as applyMigrations,
	type SqliteDatabase,
	type SqliteMigration,
} from "@earendil-works/chord/sqlite";
import { DEFAULT_SQLITE_SCHEMA, type SqliteSchema } from "./schema.ts";

export type { SqliteMigration } from "@earendil-works/chord/sqlite";

/** Build immutable, ordered schema history for a set of SQLite identifiers. */
export function createSqliteMigrations(schema: SqliteSchema): readonly SqliteMigration[] {
	const { tables, indexes } = schema;
	// next_id is TEXT because node:sqlite rejects INTEGER results outside JavaScript's safe integer range.
	const initialSchema: readonly string[] = [
		`CREATE TABLE ${tables.durableMetadata} (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			next_id TEXT NOT NULL,
			next_seq INTEGER NOT NULL
		) STRICT`,
		`INSERT INTO ${tables.durableMetadata} (singleton, next_id, next_seq) VALUES (1, '2', 1)`,
		`CREATE TABLE ${tables.recordIds} (
			id INTEGER PRIMARY KEY,
			record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
		) STRICT`,
		`CREATE TABLE ${tables.conversations} (
			id INTEGER PRIMARY KEY,
			owner_conversation_id INTEGER,
			owner_task_id INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${indexes.conversationsByOwnerConversation} ON ${tables.conversations} (owner_conversation_id, id)`,
		`CREATE INDEX ${indexes.conversationsByOwnerTask} ON ${tables.conversations} (owner_task_id, id)`,
		`CREATE TABLE ${tables.entries} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			head INTEGER,
			commit_seq INTEGER NOT NULL,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${indexes.entriesByConversation} ON ${tables.entries} (conversation_id, id DESC)`,
		`CREATE INDEX ${indexes.entryHeadsByConversation} ON ${tables.entries} (conversation_id, id DESC) WHERE head IS NOT NULL`,
		`CREATE TABLE ${tables.tasks} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${indexes.tasksByStatus} ON ${tables.tasks} (status, id)`,
		`CREATE INDEX ${indexes.tasksByConversation} ON ${tables.tasks} (conversation_id, id)`,
		`CREATE INDEX ${indexes.tasksByKind} ON ${tables.tasks} (kind, id)`,
		`CREATE INDEX ${indexes.tasksByAbortRequested} ON ${tables.tasks} (abort_requested, id)`,
		`CREATE INDEX ${indexes.tasksByBackground} ON ${tables.tasks} (background, id)`,
		`CREATE TABLE ${tables.submissions} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			request_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${indexes.submissionsByRequest} ON ${tables.submissions} (conversation_id, request_id)`,
		`CREATE INDEX ${indexes.submissionsByConversation} ON ${tables.submissions} (conversation_id, id)`,
		`CREATE INDEX ${indexes.submissionsByStatus} ON ${tables.submissions} (status, id)`,
		`CREATE TABLE ${tables.documents} (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL,
			family INTEGER NOT NULL CHECK (family IN (0, 1)),
			key_value TEXT NOT NULL,
			scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
			owner_id INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			retired_at INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`CREATE INDEX ${indexes.documentsByAddress}
			ON ${tables.documents} (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at)`,
		`CREATE INDEX ${indexes.documentsByScope} ON ${tables.documents} (scope_kind, owner_id, id)`,
		`CREATE INDEX ${indexes.documentsByScopeKind} ON ${tables.documents} (scope_kind, owner_id, kind, id)`,
		`CREATE TABLE ${tables.documentRevisions} (
			document_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
			version INTEGER NOT NULL,
			content TEXT NOT NULL CHECK (json_valid(content)),
			PRIMARY KEY (document_id, seq)
		) STRICT`,
		`CREATE INDEX ${indexes.documentRevisionsByKind} ON ${tables.documentRevisions} (document_id, kind, seq DESC)`,
	];
	// Version 2 adds the `sleeping` task status. SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
	const rebuiltTasks = `${tables.tasks}_v2`;
	const sleepingStatus: readonly string[] = [
		`CREATE TABLE ${rebuiltTasks} (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT`,
		`INSERT INTO ${rebuiltTasks} (id, conversation_id, kind, status, abort_requested, background, record)
			SELECT id, conversation_id, kind, status, abort_requested, background, record FROM ${tables.tasks}`,
		`DROP TABLE ${tables.tasks}`,
		`ALTER TABLE ${rebuiltTasks} RENAME TO ${tables.tasks}`,
		`CREATE INDEX ${indexes.tasksByStatus} ON ${tables.tasks} (status, id)`,
		`CREATE INDEX ${indexes.tasksByConversation} ON ${tables.tasks} (conversation_id, id)`,
		`CREATE INDEX ${indexes.tasksByKind} ON ${tables.tasks} (kind, id)`,
		`CREATE INDEX ${indexes.tasksByAbortRequested} ON ${tables.tasks} (abort_requested, id)`,
		`CREATE INDEX ${indexes.tasksByBackground} ON ${tables.tasks} (background, id)`,
	];
	return [
		{ version: 1, statements: initialSchema },
		{ version: 2, statements: sleepingStatus },
	];
}

export const SQLITE_MIGRATIONS: readonly SqliteMigration[] = createSqliteMigrations(DEFAULT_SQLITE_SCHEMA);

export const CURRENT_SQLITE_SCHEMA_VERSION = SQLITE_MIGRATIONS.at(-1)?.version ?? 0;

/** Apply all pending schema migrations atomically. */
export async function applySqliteMigrations(
	database: SqliteDatabase,
	migrations: readonly SqliteMigration[] = SQLITE_MIGRATIONS,
): Promise<void> {
	await applySqliteMigrationsForSchema(database, DEFAULT_SQLITE_SCHEMA, migrations);
}

/** Apply migrations rendered for a particular schema. */
export async function applySqliteMigrationsForSchema(
	database: SqliteDatabase,
	schema: SqliteSchema,
	migrations: readonly SqliteMigration[] = createSqliteMigrations(schema),
): Promise<void> {
	await applyMigrations(database, migrations, { table: schema.tables.durableSchema });
}
