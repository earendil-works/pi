import type { Context, JsonValue } from "@earendil-works/chord";
import type { Message } from "@earendil-works/pi-ai";

/** Session-global identifier shared by every durable record table. */
export type Id = number;

/** Monotonic sequence assigned to one atomic storage commit. */
export type Seq = number;

/** The root conversation always uses this reserved ID. */
export const ROOT_CONVERSATION_ID: Id = 1;

/** JSON-safe error snapshot persisted instead of a runtime `Error` object. */
export type StoredError = {
	readonly message: string;
	/** Optional structured diagnostic data for inspection or recovery. */
	readonly detail?: JsonValue;
};

/** Immutable identity, history ancestry, and task ownership of a transcript scope. */
export type ConversationRecord = {
	readonly id: Id;
	/** Fork source and inclusive parent entry through which history is inherited. */
	readonly parent?: {
		readonly conversationId: Id;
		readonly at: Id;
	};
	/** Creator edge used for authorization, subtree abort, and subtree idle waits. */
	readonly owner?: {
		readonly conversationId: Id;
		readonly taskId: Id;
	};
};

/** An immutable override of one visible entry's contribution to model context. */
export type ContextEdit = {
	/** Entry whose model messages are omitted or replaced. */
	readonly target: Id;
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
	readonly id: Id;
	readonly conversationId: Id;
	/** Application-defined entry discriminator. */
	readonly kind: string;
	/** Messages contributed to model context; absent for display or bookkeeping entries. */
	readonly model?: readonly Message[];
	/** JSON payload consumed by views, plugins, or bookkeeping logic. */
	readonly data?: JsonValue;
	/** First entry in the active context selected by this entry. */
	readonly head?: Id;
	/** Context-only overrides of earlier visible entries. */
	readonly edits?: readonly ContextEdit[];
	/** Task that appended this entry, when it was produced by durable work. */
	readonly byTaskId?: Id;
};

/** Entry content supplied before the Session assigns identity and task attribution. */
export type EntryDraft = Omit<EntryRecord, "id" | "conversationId" | "byTaskId" | "head"> & {
	/** `"self"` starts active context at the newly assigned entry ID. */
	readonly head?: Id | "self";
};

/** Identity fields shared by every input lifecycle state. */
type InputBase = {
	readonly id: Id;
	readonly conversationId: Id;
	/** Host-provided deduplication key, scoped to the conversation. */
	readonly requestId?: string;
};

/** Durable lifecycle of one admitted host input and the handle waiting for it. */
export type Input = InputBase &
	(
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
				/** User transcript entry created when this input was placed. */
				readonly entry: Id;
				readonly answer?: never;
				readonly reason?: never;
				readonly detail?: never;
		  }
		| {
				/** Successfully settled with a durable transcript result. */
				readonly status: "done";
				/** User or passive-write transcript entry created when this input was placed. */
				readonly entry: Id;
				/** Assistant answer entry; absent for a completed passive write. */
				readonly answer?: Id;
				readonly reason?: never;
				readonly detail?: never;
		  }
		| {
				/** Terminal input that can no longer receive an answer. */
				readonly status: "unanswered";
				/** Present when the input was placed before becoming unanswered. */
				readonly entry?: Id;
				readonly answer?: never;
				/** Stable machine-readable explanation such as `"aborted"` or `"stale"`. */
				readonly reason: string;
				/** Optional structured diagnostic data. */
				readonly detail?: JsonValue;
		  }
	);

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
			readonly error: StoredError;
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
			readonly error: StoredError;
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
type TaskRecordBase<I> = {
	readonly id: Id;
	readonly conversationId: Id;
	/** Registered task definition name. */
	readonly kind: string;
	/** Definition version used to migrate live input and checkpoints. */
	readonly version: number;
	/** Original task input retained while the task is live or terminal. */
	readonly input: I;
	/** Tasks that must be terminal before ordinary execution may begin. */
	readonly after: readonly Id[];
	/** Whether this task is excluded from ordinary idle waits and conversation aborts. */
	readonly background: boolean;
	/** Durable abort mark checked before run-mode progress is committed. */
	readonly abortRequested: boolean;
};

/** Complete replacement record for one durable task state machine. */
export type TaskRecord<I, S, R> = TaskRecordBase<I> &
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
	readonly id: Id;
	/** Registered document kind. */
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
	| ({ readonly scope: { readonly kind: "conversation"; readonly conversationId: Id } } & (
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
			readonly scope: { readonly kind: "task"; readonly taskId: Id };
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

/** Inclusive ID bounds for a newest-first scan of one conversation's fork-aware history. */
export type EntryQuery = {
	readonly conversationId: Id;
	/** Oldest entry ID that may be returned. */
	readonly minEntryId?: Id;
	/** Newest entry ID that may be returned. */
	readonly maxEntryId?: Id;
};

/** Optional filters for an ordered scan of durable task records. */
export type TaskQuery = {
	readonly conversationId?: Id;
	readonly kind?: string;
	readonly status?: "pending" | "running" | "terminal";
	readonly abortRequested?: boolean;
	readonly background?: boolean;
};

/** One table mutation in an atomic storage commit; task and input writes replace whole records. */
export type StorageWrite =
	| { readonly type: "conversation"; readonly value: ConversationRecord }
	| { readonly type: "entry"; readonly value: EntryRecord }
	| { readonly type: "task"; readonly value: TaskRecord<JsonValue, JsonValue, JsonValue> }
	| { readonly type: "input"; readonly value: Input };

/**
 * Atomic persistence boundary for Session records.
 *
 * Storage trusts the owning Session to supply semantically valid records, references,
 * ancestry, and transitions. Implementations enforce atomicity, global ID ownership,
 * immutable conversation/entry creation, and detached values; Session serializes commits.
 */
export interface Storage {
	/** Atomically persist one batch and return the sequence assigned to that commit. */
	commit(writes: readonly StorageWrite[], context: Context): Promise<Seq>;

	/** Return a fresh candidate from the Session-global record ID namespace. */
	mintId(): Id;

	/** Look up one conversation by exact ID. */
	conversation(id: Id, context: Context): Promise<ConversationRecord | undefined>;

	/** Scan conversations in ascending ID order. */
	scanConversations(
		cursor: Cursor | undefined,
		limit: number,
		context: Context,
	): Promise<Page<ConversationRecord, Cursor>>;

	/** Look up one global entry and the sequence of the commit that persisted it. */
	entry(id: Id, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;

	/**
	 * Return the newest visible entry with a `head` at or below the optional inclusive cutoff.
	 * The returned entry is the marker; its `head` value is the range's actual lower bound.
	 */
	findLatestHeadMarker(
		conversationId: Id,
		atOrBeforeEntryId: Id | undefined,
		context: Context,
	): Promise<(EntryRecord & { readonly head: Id }) | undefined>;

	/** Scan the inclusive visible range newest-first, returning at most `limit` entries. */
	scanEntries(
		query: EntryQuery,
		cursor: Cursor | undefined,
		limit: number,
		context: Context,
	): Promise<Page<EntryRecord, Cursor>>;

	/** Look up the latest complete record for one task. */
	task(id: Id, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined>;

	/** Scan task records matching every supplied filter. */
	scanTasks(
		query: TaskQuery,
		cursor: Cursor | undefined,
		limit: number,
		context: Context,
	): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>;

	/** Look up the latest complete record for one admitted input. */
	input(id: Id, context: Context): Promise<Input | undefined>;

	/** Find an input by its conversation-scoped host deduplication key. */
	inputByRequest(conversationId: Id, requestId: string, context: Context): Promise<Input | undefined>;

	/** Release backend resources; all later operations must reject. */
	close(context: Context): Promise<void>;
}
