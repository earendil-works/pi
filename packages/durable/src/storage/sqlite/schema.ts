import { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";

export { validateSqliteSchemaPrefix } from "@earendil-works/chord/sqlite";

/**
 * Immutable identifier history for migrations and runtime queries. Never change or remove an existing value; a
 * rename adds a new entry so historical migrations keep rendering their original object names.
 */
const TABLE_NAMES = {
	durableSchema: "durable_schema",
	durableMetadata: "durable_metadata",
	recordIds: "record_ids",
	conversations: "conversations",
	entries: "entries",
	tasks: "tasks",
	submissions: "submissions",
	documents: "documents",
	documentRevisions: "document_revisions",
} as const;

const INDEX_NAMES = {
	conversationsByOwnerConversation: "conversations_by_owner_conversation",
	conversationsByOwnerTask: "conversations_by_owner_task",
	entriesByConversation: "entries_by_conversation",
	entryHeadsByConversation: "entry_heads_by_conversation",
	tasksByStatus: "tasks_by_status",
	tasksByConversation: "tasks_by_conversation",
	tasksByKind: "tasks_by_kind",
	tasksByAbortRequested: "tasks_by_abort_requested",
	tasksByBackground: "tasks_by_background",
	submissionsByRequest: "submissions_by_request",
	submissionsByConversation: "submissions_by_conversation",
	submissionsByStatus: "submissions_by_status",
	documentsByAddress: "documents_by_address",
	documentsByScope: "documents_by_scope",
	documentsByScopeKind: "documents_by_scope_kind",
	documentRevisionsByKind: "document_revisions_by_kind",
} as const;

type SqliteIdentifiers<T extends Record<string, string>> = { readonly [K in keyof T]: string };

export type SqliteSchema = {
	readonly tables: SqliteIdentifiers<typeof TABLE_NAMES>;
	readonly indexes: SqliteIdentifiers<typeof INDEX_NAMES>;
};

function prefixIdentifiers<T extends Record<string, string>>(names: T, prefix: string): SqliteIdentifiers<T> {
	return Object.fromEntries(
		Object.entries(names).map(([key, name]) => [key, `${prefix}${name}`]),
	) as SqliteIdentifiers<T>;
}

/** Build the identifiers used by every migration and storage query. */
export function createSqliteSchema(prefix?: string): SqliteSchema {
	if (prefix !== undefined) validateSqliteSchemaPrefix(prefix);
	const actualPrefix = prefix ?? "";
	return {
		tables: prefixIdentifiers(TABLE_NAMES, actualPrefix),
		indexes: prefixIdentifiers(INDEX_NAMES, actualPrefix),
	};
}

export const DEFAULT_SQLITE_SCHEMA = createSqliteSchema();
