import type { Context, Draft, JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { Message } from "@earendil-works/pi-ai";

/** JSON object used as the root of every durable document. */
export type JsonObject = { [key: string]: JsonValue };

declare const idBrand: unique symbol;

/** Erased nominal number identifying one durable record kind. */
export type Id<Kind extends string, Type = unknown> = number & {
	readonly [idBrand]: {
		readonly kind: Kind;
		readonly type: Type;
	};
};

export type ConversationId = Id<"conversation">;
export type EntryId = Id<"entry">;
export type TaskId<Result = unknown> = Id<"task", Result>;
export type SubmissionId = Id<"submission">;
export type DocumentId = Id<"document">;

declare const seqBrand: unique symbol;

/** Strictly increasing sequence assigned to one atomic storage commit; gaps are permitted. */
export type Seq = number & { readonly [seqBrand]: "sequence" };

/** The root conversation always uses this reserved ID. */
export const ROOT_CONVERSATION_ID = 1 as ConversationId;

/** Conversation document that retains only its current state. */
export type LatestConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "latest";
	readonly fork: "current" | "initial";
};

/** Conversation document whose history remains addressable for as-of reads. */
export type RewindableConversationSemantics = {
	readonly scope: "conversation";
	readonly history: "rewindable";
	readonly fork: "asOf" | "current" | "initial";
};

/** Ownership and lifetime of a document; only conversation documents declare history and fork behavior. */
export type DocumentSemantics =
	| { readonly scope: "session"; readonly history?: never; readonly fork?: never }
	| LatestConversationSemantics
	| RewindableConversationSemantics
	| { readonly scope: "task"; readonly history?: never; readonly fork?: never };

/** Definition fields shared by singleton documents and document families. */
export type CommonDocDefinition<T extends JsonObject> = {
	/** Stable persisted kind; part of the public protocol. */
	readonly kind: string;
	/** Positive integer version of the stored value shape. */
	readonly version: number;
	initial(): T;
	migrate?(value: JsonObject, fromVersion: number): T;
	checkpointWhen?(value: Readonly<T>, ops: readonly Op[]): boolean;
};

/** Singleton document definition. */
export type DocDefinition<T extends JsonObject> = CommonDocDefinition<T> & DocumentSemantics;

/** Keyed document family definition; `initial(seed)` runs only when a member is absent. */
export type DocFamilyDefinition<T extends JsonObject, I extends JsonValue> = Omit<CommonDocDefinition<T>, "initial"> &
	DocumentSemantics & {
		readonly family: true;
		initial(seed: I): T;
	};

declare const docType: unique symbol;

/** Typed singleton document token passed explicitly to typed access. */
export interface DocToken<T extends JsonObject, D extends DocDefinition<T>> {
	readonly definition: D;
	readonly [docType]?: T;
}

/** Typed document family token passed explicitly to typed access. */
export interface DocFamilyToken<T extends JsonObject, I extends JsonValue, D extends DocFamilyDefinition<T, I>> {
	readonly definition: D;
	readonly [docType]?: T;
}

export type SessionDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "session" }>;
export type ConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
export type RewindableConversationDocToken<T extends JsonObject> = DocToken<
	T,
	CommonDocDefinition<T> & RewindableConversationSemantics
>;
export type TaskDocToken<T extends JsonObject> = DocToken<T, CommonDocDefinition<T> & { readonly scope: "task" }>;

export type SessionDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "session" }
>;
export type ConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & (LatestConversationSemantics | RewindableConversationSemantics)
>;
export type RewindableConversationDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & RewindableConversationSemantics
>;
export type TaskDocFamilyToken<T extends JsonObject, I extends JsonValue> = DocFamilyToken<
	T,
	I,
	DocFamilyDefinition<T, I> & { readonly scope: "task" }
>;

declare const taskResultType: unique symbol;

/** Task definition fields currently supported by Session task creation. */
export type TaskDefinition<I, S extends { phase: string }, R, H extends object> = {
	/** Registered task kind persisted in `TaskRecord.kind`. */
	readonly name: string;
	/** Definition version persisted with live input and checkpoints. */
	readonly version: number;
	/** First durable checkpoint for a newly created task. */
	initial(input: I): S;
	readonly hooks?: H;
	/** Type-only result marker until phase handlers commit typed outcomes. */
	readonly [taskResultType]?: R;
};

/** Typed executable task definition. */
export interface Task<I, S extends { phase: string }, R, H extends object> {
	readonly definition: TaskDefinition<I, S, R, H>;
}

/** Creation options for a durable task. */
export type TaskOptions = {
	/** Owning conversation; required for Session commits that are not bound to a conversation. */
	readonly conversationId?: ConversationId;
	/** Tasks that must be terminal before ordinary execution may begin. */
	readonly after?: readonly TaskId[];
	/** Excluded from ordinary idle waits and conversation aborts. */
	readonly background?: boolean;
};

/** Ownership selected explicitly whenever a conversation is created. */
export type ConversationOwnership = { readonly kind: "ownerless" } | { readonly kind: "task"; readonly taskId: TaskId };

/** Immutable identity, history ancestry, and task ownership of a transcript scope. */
export type ConversationRecord = {
	readonly id: ConversationId;
	/** Fork source and inclusive parent entry through which history is inherited. */
	readonly parent?: {
		readonly conversationId: ConversationId;
		readonly at: EntryId;
	};
	/** Creator edge used for attribution, subtree abort, and subtree idle waits. */
	readonly owner?: {
		readonly conversationId: ConversationId;
		readonly taskId: TaskId;
	};
};

/** An immutable override of one visible entry's contribution to model context. */
export type ContextEdit = {
	/** Entry whose model messages are omitted or replaced. */
	readonly target: EntryId;
} & (
	| {
			readonly action: "omit";
			readonly messages?: never;
	  }
	| {
			readonly action: "replace";
			/** Messages contributed instead of the target entry's model messages. */
			readonly messages: readonly Message[];
	  }
);

/** Immutable transcript event with separate model-facing and application-facing payloads. */
export type EntryRecord = {
	readonly id: EntryId;
	readonly conversationId: ConversationId;
	/** Application-defined entry discriminator. */
	readonly kind: string;
	/** Messages contributed to model context; absent for display or bookkeeping entries. */
	readonly model?: readonly Message[];
	/** JSON payload consumed by views, extensions, or bookkeeping logic. */
	readonly data?: JsonValue;
	/** First entry in the active context selected by this entry. */
	readonly head?: EntryId;
	/** Context-only overrides of earlier visible entries. */
	readonly edits?: readonly ContextEdit[];
	/** Task that appended this entry, when it was produced by durable work. */
	readonly byTaskId?: TaskId;
};

/** Entry content supplied before the Session assigns identity and task attribution. */
export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
	/** `"self"` starts active context at the newly assigned entry ID. */
	readonly head?: EntryId | "self";
};

/** Identity fields shared by every durable submission state. */
type SubmissionRecordBase = {
	readonly id: SubmissionId;
	readonly conversationId: ConversationId;
	/** Host-provided deduplication key, scoped to the conversation. */
	readonly requestId?: string;
};

/** Durable lifecycle of one admitted user input or passive entry write. */
export type SubmissionRecord =
	| (SubmissionRecordBase & {
			readonly type: "input";
	  } & (
				| {
						/** Admitted but not yet represented in the transcript. */
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Added to the transcript and owned by an active turn. */
						readonly status: "placed";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Successfully answered user input. */
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer: EntryId;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Terminal input that can no longer receive an answer. */
						readonly status: "unanswered";
						readonly entry?: EntryId;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			))
	| (SubmissionRecordBase & {
			readonly type: "write";
	  } & (
				| {
						/** Admitted but not yet appended to the transcript. */
						readonly status: "queued";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Successfully appended passive entry. */
						readonly status: "done";
						readonly entry: EntryId;
						readonly answer?: never;
						readonly reason?: never;
						readonly detail?: never;
				  }
				| {
						/** Terminal passive write that could not be placed. */
						readonly status: "unanswered";
						readonly entry?: never;
						readonly answer?: never;
						readonly reason: string;
						readonly detail?: JsonValue;
				  }
			));

/** Submission fields supplied before the Session assigns an ID. */
export type SubmissionCreate = SubmissionRecord extends infer Record
	? Record extends SubmissionRecord
		? Omit<Record, "id">
		: never
	: never;

/** JSON-safe error snapshot persisted instead of a runtime `Error` object. */
export type TaskOutcomeError = {
	readonly message: string;
	/** Optional structured diagnostic data for inspection or recovery. */
	readonly detail?: JsonValue;
};

/** Durable reason and optional result recorded when a task becomes terminal. */
export type TaskOutcome<R> =
	| {
			readonly status: "completed";
			readonly result: R;
			readonly error?: never;
			readonly reason?: never;
	  }
	/** Expected task or domain failure explicitly committed by its implementation. */
	| {
			readonly status: "failed";
			readonly error: TaskOutcomeError;
			readonly result?: R;
			readonly reason?: never;
	  }
	/** Explicit cancellation handled by the task's abort protocol. */
	| {
			readonly status: "aborted";
			readonly reason?: string;
			readonly result?: R;
			readonly error?: never;
	  }
	/** Task that cannot resume because its definition or migration is unavailable. */
	| {
			readonly status: "orphaned";
			readonly reason: string;
			readonly result?: never;
			readonly error?: never;
	  }
	/** Runtime-detected contract failure, such as an uncaught throw or no durable progress. */
	| {
			readonly status: "faulted";
			readonly error: TaskOutcomeError;
			readonly result?: never;
			readonly reason?: never;
	  };

/** Complete durable execution state of a task. */
export type TaskState<S, R> =
	| {
			/** Eligible for scheduling when its dependencies are terminal. */
			readonly status: "pending";
			/** Complete durable state from which execution resumes. */
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			/** Reserved by one in-memory task invocation. */
			readonly status: "running";
			/** Complete durable state from which execution resumes. */
			readonly checkpoint: S;
			readonly outcome?: never;
	  }
	| {
			/** Permanently settled durable result receipt. */
			readonly status: "terminal";
			readonly checkpoint?: never;
			readonly outcome: TaskOutcome<R>;
	  };

/** Identity, definition, and scheduling fields shared by every task state. */
type TaskRecordBase<I, R> = {
	readonly id: TaskId<R>;
	readonly conversationId: ConversationId;
	/** Registered task definition name. */
	readonly kind: string;
	/** Definition version used to migrate live input and checkpoints. */
	readonly version: number;
	/** Original task input retained while the task is live or terminal. */
	readonly input: I;
	/** Tasks that must be terminal before ordinary execution may begin. */
	readonly after: readonly TaskId[];
	/** Whether this task is excluded from ordinary idle waits and conversation aborts. */
	readonly background: boolean;
	/** Durable abort mark checked before run-mode progress is committed. */
	readonly abortRequested: boolean;
};

/** Complete replacement record for one durable task state machine. */
export type TaskRecord<I, S, R> = TaskRecordBase<I, R> &
	(
		| {
				readonly state: Extract<TaskState<S, R>, { readonly status: "pending" | "running" }>;
				/** Small first-writer-wins values retained while the task is live. */
				readonly memos?: Readonly<Record<string, JsonValue>>;
		  }
		| {
				readonly state: Extract<TaskState<S, R>, { readonly status: "terminal" }>;
				readonly memos?: never;
		  }
	);

/** Persisted lifecycle record for one create-to-retire document incarnation. */
export type DocumentRecord = {
	/** Unique incarnation ID; never reused when the same logical document is recreated. */
	readonly id: DocumentId;
	/** Stable document definition kind. */
	readonly kind: string;
	/** Family member key; absent for singleton documents. */
	readonly key?: string;
	/** Commit that created the incarnation, stamped by storage. */
	readonly createdAt: Seq;
	/** Commit that retired the incarnation; absent while it is current. */
	readonly retiredAt?: Seq;
} & (
	| {
			readonly scope: { readonly kind: "session" };
			readonly history?: never;
			readonly fork?: never;
	  }
	| ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: ConversationId } } & (
			| {
					/** Retain only current state. */
					readonly history: "latest";
					/** Initialize a fork from current source state or the definition's initial value. */
					readonly fork: "current" | "initial";
			  }
			| {
					/** Retain history needed for as-of reads. */
					readonly history: "rewindable";
					/** Initialize a fork at its cutoff, from current state, or from the initial value. */
					readonly fork: "asOf" | "current" | "initial";
			  }
	  ))
	| {
			readonly scope: { readonly kind: "task"; readonly taskId: TaskId };
			readonly history?: never;
			readonly fork?: never;
	  }
);

/** Fields supplied when storage creates and stamps a new `DocumentRecord`. */
export type DocumentCreate = DocumentRecord extends infer Record
	? Record extends DocumentRecord
		? Omit<Record, "createdAt" | "retiredAt">
		: never
	: never;

/** One ordered scan result and its optional continuation state. */
export type Page<T, C> = {
	readonly items: readonly T[];
	readonly next?: C;
};

/** Backend-owned JSON continuation state that callers only round-trip to the same scan. */
export type Cursor = Readonly<Record<string, JsonValue>>;

/** Optional filters for an ordered conversation scan. */
export type ConversationQuery = {
	readonly ownerConversationId?: ConversationId;
	readonly ownerTaskId?: TaskId;
};

/** Inclusive ID bounds for a newest-first scan of one conversation's fork-aware history. */
export type EntryQuery = {
	readonly conversationId: ConversationId;
	/** Oldest entry ID that may be returned. */
	readonly minEntryId?: EntryId;
	/** Newest entry ID that may be returned. */
	readonly maxEntryId?: EntryId;
};

/** Optional filters for an ordered scan of durable task records. */
export type TaskQuery = {
	readonly conversationId?: ConversationId;
	readonly kind?: string;
	readonly status?: "pending" | "running" | "terminal";
	readonly abortRequested?: boolean;
	readonly background?: boolean;
};

/** Current state or one historical commit sequence used for document membership and content reads. */
export type DocumentPoint = Seq | "current";

/** Exact logical identity of a singleton or one keyed family member. */
export type DocumentAddress = {
	readonly kind: string;
	readonly scope: DocumentRecord["scope"];
	/** Absent selects the singleton; present selects one family member. */
	readonly key?: string;
};

/** Ordered scan of document incarnations alive in one exact scope at one point. */
export type DocumentQuery = {
	readonly scope: DocumentRecord["scope"];
	readonly at: DocumentPoint;
	readonly kind?: string;
};

/** Complete checkpoint or Chord operation batch selected by the owning Session. */
export type DocumentContent =
	| {
			readonly version: number;
			readonly kind: "base";
			readonly value: JsonObject;
	  }
	| {
			readonly version: number;
			readonly kind: "delta";
			readonly ops: readonly Op[];
	  };

/** Exact persisted source selected for a definition-free document copy. */
export type DocumentCopySource = {
	readonly id: DocumentId;
	readonly at: DocumentPoint;
};

/** Detached materialized value and stored definition version at a selected point. */
export type StoredDocument = {
	readonly record: DocumentRecord;
	readonly version: number;
	readonly value: JsonObject;
};

/** One record or document mutation in an atomic storage commit. */
export type StorageWrite =
	| { readonly type: "conversation"; readonly value: ConversationRecord }
	| { readonly type: "entry"; readonly value: EntryRecord }
	| { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
	| { readonly type: "submission"; readonly value: SubmissionRecord }
	| {
			readonly type: "document.create";
			readonly record: DocumentCreate;
			readonly content: Extract<DocumentContent, { readonly kind: "base" }>;
	  }
	| { readonly type: "document.copy"; readonly record: DocumentCreate; readonly source: DocumentCopySource }
	| {
			readonly type: "document.change";
			readonly id: DocumentId;
			readonly content: DocumentContent;
	  }
	| { readonly type: "document.retire"; readonly id: DocumentId };

/**
 * Transaction surface of one Session commit callback.
 * Table reads and creation results are trusted immutable values and may be shared with internal commit state.
 */
export interface Tx {
	conversation(id: ConversationId): Promise<ConversationRecord | undefined>;
	entry(id: EntryId): Promise<EntryRecord | undefined>;
	task(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<ConversationRecord, Cursor>>;
	scanEntries(query: EntryQuery, limit: number, cursor?: Cursor): Promise<Page<EntryRecord, Cursor>>;
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor?: Cursor,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

	/** Create a conversation with explicitly selected ownership. */
	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord>;
	/** Create a history fork at one concrete visible entry with explicitly selected ownership. */
	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord>;
	/** Returned records are Session-owned immutable values and may be shared with commit listeners. */
	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options?: TaskOptions,
	): Promise<TaskId<R>>;
	/** Replace one task record completely. */
	setTask(value: TaskRecord<JsonValue, JsonValue, JsonValue>): void;

	doc<T extends JsonObject>(token: SessionDocToken<T>): Promise<Draft<T>>;
	doc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<Draft<T>>;
	doc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;
	doc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		seed: I,
	): Promise<Draft<T>>;

	retireDoc<T extends JsonObject>(token: SessionDocToken<T>): Promise<void>;
	retireDoc<T extends JsonObject>(token: ConversationDocToken<T>, conversationId: ConversationId): Promise<void>;
	retireDoc<T extends JsonObject>(token: TaskDocToken<T>, taskId: TaskId): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(token: SessionDocFamilyToken<T, I>, key: string): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
	): Promise<void>;
	retireDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
	): Promise<void>;
}

/** Owner of one mutation line, its records, and its tracked documents. */
export interface Session {
	/** Run one atomic transaction on the Session mutation line. */
	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T>;
	/** Seal admission, settle admitted commits, then close storage. */
	close(context: Context): Promise<void>;

	snapshot<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshot<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<Readonly<T> | undefined>;

	snapshotAsOf<T extends JsonObject>(
		token: RewindableConversationDocToken<T>,
		conversationId: ConversationId,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
	snapshotAsOf<T extends JsonObject, I extends JsonValue>(
		token: RewindableConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		at: EntryId,
		context: Context,
	): Promise<Readonly<T> | undefined>;
}

/**
 * Atomic persistence boundary for Session records.
 *
 * Storage trusts the owning Session to supply semantically valid records, references,
 * ancestry, and transitions. Implementations enforce atomicity, global ID ownership,
 * immutable conversation/entry creation, document record consistency, and detached values;
 * Session serializes commits.
 */
export interface Storage {
	/**
	 * Atomically persist one batch and return its sequence. Once resolved, later reads through this storage observe it.
	 */
	commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;

	/** Return a fresh branded candidate from the Session-global numeric ID namespace. */
	mintId<I extends Id<string>>(): Promise<I>;

	/** Look up one conversation by exact ID. */
	conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined>;

	/** Scan conversations in ascending ID order. */
	scanConversations(
		query: ConversationQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>>;

	/** Look up one global entry and the sequence of the commit that persisted it. */
	entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
	/** Look up one entry only when it is visible through the requested conversation's ancestry. */
	entry(
		conversationId: ConversationId,
		id: EntryId,
		context: Context,
	): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;

	/**
	 * Return the newest visible entry with a `head` at or below the optional inclusive cutoff.
	 * The returned entry is the marker; its `head` value is the range's actual lower bound.
	 */
	findLatestHeadMarker(
		conversationId: ConversationId,
		atOrBeforeEntryId: EntryId | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: EntryId }) | undefined>;

	/** Scan the inclusive visible range newest-first, returning at most `limit` entries. */
	scanEntries(
		query: EntryQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;

	/** Look up the latest complete record for one task. */
	task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;

	/** Scan task records matching every supplied filter. */
	scanTasks(
		query: TaskQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

	/** Look up the latest complete record for one admitted submission. */
	submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined>;

	/** Find a submission by its conversation-scoped host deduplication key. */
	submissionByRequest(
		conversationId: ConversationId,
		requestId: string,
		context: Context,
	): Promise<SubmissionRecord | undefined>;

	/** Resolve the incarnation occupying one exact logical address at the selected point. */
	findDocument(address: DocumentAddress, at: DocumentPoint, context: Context): Promise<DocumentRecord | undefined>;

	/** Materialize one specific incarnation by ID at the selected point without following a replacement at its address. */
	document(id: DocumentId, at: DocumentPoint, context: Context): Promise<StoredDocument | undefined>;

	/** Scan incarnations alive in one exact scope at the selected point. */
	scanDocuments(
		query: DocumentQuery,
		limit: number,
		cursor: Cursor | undefined,
		context: Context,
	): Promise<Page<DocumentRecord, Cursor>>;

	/** Release backend resources; all later operations must reject. */
	close(context: Context): Promise<void>;
}
