// Durable's records as declared tables of the store (slice 6b D2, §2.2): every row carries its record's indexed columns
// and the whole record as one `json(...)` cell. Indexed strings that must stay lossless (`kind`, `request_id`) hold
// Durable's JSON encoding; index columns are never `opt`, so absent values take sentinels no encoded value can be
// (`0` for an absent owner, which is never an id; `""` for an absent request id: an encoded string starts with `"`).

import type { JsonValue } from "@earendil-works/chord";
import { defineTable, int, json, str, unknown } from "@earendil-works/chord/next";
import type { ConversationRecord, EntryRecord, SubmissionRecord, TaskRecord } from "../../types.ts";

/** A record as one `json(...)` cell. */
const record = () => json(unknown(), { version: 1 });

/** Which record type owns an id: Durable's one namespace across its five record types. */
export const RecordIds = defineTable("record_ids", {
	version: 1,
	columns: { id: int(), record_type: str() },
	key: ["id"],
});

export const Conversations = defineTable("conversations", {
	version: 1,
	columns: { id: int(), owner_conversation_id: int(), owner_task_id: int(), record: record() },
	key: ["id"],
	indexes: { by_owner_conversation: ["owner_conversation_id"], by_owner_task: ["owner_task_id"] },
});

export const Entries = defineTable("entries", {
	version: 1,
	columns: { id: int(), conversation_id: int(), commit_seq: int(), record: record() },
	key: ["id"],
	indexes: { by_conversation: ["conversation_id"] },
});

/**
 * The entries with a head marker, by conversation: what `SqliteStorage`'s partial index on `head IS NOT NULL` is,
 * as rows written only with such an entry, so a commit of an entry without one updates no second index.
 */
export const EntryHeads = defineTable("entry_heads", {
	version: 1,
	columns: { id: int(), conversation_id: int() },
	key: ["id"],
	indexes: { by_conversation: ["conversation_id"] },
});

export const Tasks = defineTable("tasks", {
	version: 1,
	columns: {
		id: int(),
		conversation_id: int(),
		kind: str(),
		status: str(),
		abort_requested: int(),
		background: int(),
		record: record(),
	},
	key: ["id"],
	indexes: {
		by_status: ["status"],
		by_conversation: ["conversation_id"],
		by_kind: ["kind"],
		by_abort_requested: ["abort_requested"],
		by_background: ["background"],
	},
});

export const Submissions = defineTable("submissions", {
	version: 1,
	columns: { id: int(), conversation_id: int(), request_id: str(), status: str(), record: record() },
	key: ["id"],
	indexes: {
		by_request: ["conversation_id", "request_id"],
		by_conversation: ["conversation_id"],
		by_status: ["status"],
	},
});

/** Durable's JSON encoding of an indexed string: lossless whatever the string (lone surrogates, NUL). */
export const encodeIndexed = (value: string): string => JSON.stringify(value);

/** The row of a conversation record. */
export function conversationRow(value: ConversationRecord): object {
	return {
		id: value.id,
		owner_conversation_id: value.owner?.conversationId ?? 0,
		owner_task_id: value.owner?.taskId ?? 0,
		record: value,
	};
}

/** The row of an entry record; `commit_seq` is stamped by the step. */
export function entryRow(value: EntryRecord): object {
	return {
		id: value.id,
		conversation_id: value.conversationId,
		commit_seq: 0,
		record: value,
	};
}

/** The row of a task record. */
export function taskRow(value: TaskRecord<JsonValue, JsonValue, JsonValue>): object {
	return {
		id: value.id,
		conversation_id: value.conversationId,
		kind: encodeIndexed(value.kind),
		status: value.state.status,
		abort_requested: value.abortRequested ? 1 : 0,
		background: value.background ? 1 : 0,
		record: value,
	};
}

/** The row of a submission record. */
export function submissionRow(value: SubmissionRecord): object {
	return {
		id: value.id,
		conversation_id: value.conversationId,
		request_id: value.requestId === undefined ? "" : encodeIndexed(value.requestId),
		status: value.status,
		record: value,
	};
}
