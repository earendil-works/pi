// The keys of the Session line: what a commit writes and a job reads, so a read of an unpublished write waits for it.
import type { Context, JsonValue } from "@earendil-works/chord";
import { addressId } from "../documents.ts";
import type {
	CommitResult,
	ConversationId,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentId,
	DocumentPoint,
	DocumentQuery,
	DocumentRecord,
	EntryId,
	EntryQuery,
	EntryRecord,
	Id,
	Page,
	Seq,
	Storage,
	StorageWrite,
	StoredDocument,
	SubmissionId,
	SubmissionQuery,
	SubmissionRecord,
	TaskId,
	TaskQuery,
	TaskRecord,
} from "../types.ts";

type StoredEntry = { readonly entry: EntryRecord; readonly commitSeq: Seq };

/** A task record. */
export function taskKey(id: TaskId): string {
	return `task:${id}`;
}

/** A conversation record. */
export function conversationKey(id: ConversationId): string {
	return `conv:${id}`;
}

/** An entry record. */
export function entryKey(id: EntryId): string {
	return `entry:${id}`;
}

/** The newest entries of a conversation: appended blind, read by scans, the newest entry, and head markers. */
export function appendKey(id: ConversationId): string {
	return `entry-append:${id}`;
}

/** A submission record. */
export function submissionKey(id: SubmissionId): string {
	return `sub:${id}`;
}

/** The submission a conversation's request ID names. */
export function requestKey(conversationId: ConversationId, requestId: string): string {
	return `req:${conversationId}:${requestId}`;
}

/** A document address (`addressId()`): its current incarnation, value, and held changes. */
export function documentKey(addressId: string): string {
	return `doc:${addressId}`;
}

/** A document incarnation, for reads by its ID. */
export function incarnationKey(id: DocumentId): string {
	return `docid:${id}`;
}

/** The incarnations alive in a scope: created and retired blind, read by scans and the task-document index. */
export function scopeKey(scope: DocumentRecord["scope"]): string {
	switch (scope.kind) {
		case "session":
			return "docscope:session";
		case "conversation":
			return `docscope:c${scope.conversationId}`;
		case "task":
			return `docscope:t${scope.taskId}`;
	}
}

/**
 * A node of the scheduler's ownership tree (a task ID, or `c<conversation ID>`): the live work listed below it. Written
 * by task creation and a task becoming terminal for every node from the task's parent up to and including the nearest
 * live task or the root conversation; read by every walk that expands the node.
 */
export function ownedKey(node: TaskId | string): string {
	return `owned:${node}`;
}

/** The ownerless conversations with live work below them, which global idle walks from. */
export const ROOTS_KEY = "roots";

/** The live tasks with cancellation intent: abort marks, and held outcomes other than `completed`. */
export const INTENT_KEY = "intent";

/** Every unpublished write: what a read that cannot be keyed, such as a scan, touches. */
export const ALL_KEYS = "*";

/** The keys of the table records in `writes`; document writes are keyed by the transaction, which knows addresses. */
export function tableKeys(writes: readonly StorageWrite[], keys: string[]): void {
	for (const write of writes) {
		switch (write.type) {
			case "conversation":
				keys.push(conversationKey(write.value.id));
				break;
			case "entry":
				keys.push(entryKey(write.value.id), appendKey(write.value.conversationId));
				break;
			case "task":
				keys.push(taskKey(write.value.id));
				break;
			case "submission":
				keys.push(submissionKey(write.value.id));
				if (write.value.requestId !== undefined) {
					keys.push(requestKey(write.value.conversationId, write.value.requestId));
				}
				break;
		}
	}
}

/**
 * The Storage a job on the line reads through: every read first touches its key (`touch`), which waits while the key
 * has an unpublished writer, so the read sees what the line admitted before it. Scans that cannot be keyed touch
 * `ALL_KEYS`. Commits and `close()` pass through; the line never commits through it.
 */
export class GatedStorage implements Storage {
	readonly #storage: Storage;
	readonly #touch: (key: string) => Promise<void> | undefined;

	constructor(storage: Storage, touch: (key: string) => Promise<void> | undefined) {
		this.#storage = storage;
		this.#touch = touch;
	}

	commit(
		batches: readonly (readonly StorageWrite[])[],
		receive: (index: number, seq: Seq) => void,
		context: Context,
	): Promise<CommitResult> {
		return this.#storage.commit(batches, receive, context);
	}

	mintId<I extends Id<string>>(): Promise<I> {
		return this.#storage.mintId<I>();
	}

	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
		return this.#after(conversationKey(id), () => this.#storage.conversation(id, context));
	}

	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>> {
		return this.#after(ALL_KEYS, () => this.#storage.scanConversations(query, limit, cursor, context));
	}

	entry(id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(conversationId: ConversationId, id: EntryId, context: Context): Promise<StoredEntry | undefined>;
	entry(
		first: EntryId | ConversationId,
		second: EntryId | Context,
		third?: Context,
	): Promise<StoredEntry | undefined> {
		if (third === undefined) {
			const id = first as EntryId;
			return this.#after(entryKey(id), () => this.#storage.entry(id, second as Context));
		}
		const conversationId = first as ConversationId;
		const id = second as EntryId;
		// Visibility follows the conversation's immutable ancestry; the conversation may be unpublished itself.
		return this.#after(conversationKey(conversationId), () =>
			this.#after(entryKey(id), () => this.#storage.entry(conversationId, id, third)),
		);
	}

	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
		return this.#afterEntries(conversationId, () =>
			this.#storage.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context),
		);
	}

	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>> {
		return this.#afterEntries(query.conversationId, () => this.#storage.scanEntries(query, limit, cursor, context));
	}

	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
		return this.#after(taskKey(id), () => this.#storage.task(id, context));
	}

	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
		return this.#after(ALL_KEYS, () => this.#storage.scanTasks(query, limit, cursor, context));
	}

	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
		return this.#after(submissionKey(id), () => this.#storage.submission(id, context));
	}

	scanSubmissions(
		query: SubmissionQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<SubmissionRecord, Cursor>> {
		return this.#after(ALL_KEYS, () => this.#storage.scanSubmissions(query, limit, cursor, context));
	}

	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined> {
		return this.#after(requestKey(conversationId, requestId), () =>
			this.#storage.submissionByRequest(conversationId, requestId, context),
		);
	}

	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined> {
		return this.#after(documentKey(addressId(address)), () => this.#storage.findDocument(address, at, context));
	}

	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined> {
		return this.#after(incarnationKey(id), () => this.#storage.document(id, at, context));
	}

	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>> {
		return this.#after(scopeKey(query.scope), () => this.#storage.scanDocuments(query, limit, cursor, context));
	}

	close(context: Context): Promise<void> {
		return this.#storage.close(context);
	}

	/**
	 * Run a read of a conversation's entries once neither its appends nor its creation has an unpublished writer: Storage
	 * refuses the read of a conversation it does not have yet.
	 */
	#afterEntries<T>(conversationId: ConversationId, read: () => Promise<T>): Promise<T> {
		return this.#after(conversationKey(conversationId), () => this.#after(appendKey(conversationId), read));
	}

	/** Run `read` once `key` has no unpublished writer. */
	#after<T>(key: string, read: () => Promise<T>): Promise<T> {
		const gate = this.#touch(key);
		return gate === undefined ? read() : gate.then(read);
	}
}
