import type { ConversationId, TaskId } from "./types.ts";

/**
 * The message of a thrown value, without throwing itself: `String()` throws for values such as `Object.create(null)`,
 * and code that formats an error must not fail for the value it formats.
 */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return Object.prototype.toString.call(error);
	}
}

/**
 * A transaction read a table after its first table write, or admitted a submission (`submit(tx, draft)`) after it. Read
 * every required row, and admit, before writing.
 */
export class ReadAfterWrite extends Error {
	/** `operation` names the call, such as `Tx.task()`. */
	constructor(operation: string) {
		super(`${operation} cannot read tables after the first table write`);
		this.name = "ReadAfterWrite";
	}
}

/**
 * A Storage read rejected an invalid request, such as an unknown conversation or a cursor from another scan, with no
 * durable effect. Unlike any other error a Storage throws, it fails only that read, not the Session; from `commit()` it is
 * fatal like any other.
 */
export class StorageRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageRequestError";
	}
}

/**
 * The Session failed, so nothing runs or commits any more. It fails when a Storage method throws, a commit cannot be
 * adopted, or the Harness's own bookkeeping throws (a scheduler commit, an internal commit listener, a registry whose
 * `snapshot()` throws). `cause` is that first error. Reopen the Session; reopening recovers from what was committed.
 */
export class SessionFailed extends Error {
	constructor(cause: unknown) {
		super("Session failed after a storage error; close and reopen it", { cause });
		this.name = "SessionFailed";
	}
}

/**
 * The Harness was opened read-only (`HarnessOptions.readOnly`): a commit with writes, or a call that would run tasks, was
 * refused. Nothing was written, and the Harness stays usable for reads.
 */
export class ReadOnlySession extends Error {
	constructor(what: string) {
		super(`Read-only Harness: ${what} refused`);
		this.name = "ReadOnlySession";
	}
}

/** A submission reached a busy conversation and was not admitted. */
export class ConversationBusy extends Error {
	readonly conversationId: ConversationId;

	constructor(conversationId: ConversationId) {
		super(`Conversation ${conversationId} is busy`);
		this.name = "ConversationBusy";
		this.conversationId = conversationId;
	}
}

/** An input with `whenIdle: "reject"` reached an idle conversation and was not admitted. */
export class ConversationIdle extends Error {
	readonly conversationId: ConversationId;

	constructor(conversationId: ConversationId) {
		super(`Conversation ${conversationId} is idle`);
		this.name = "ConversationIdle";
		this.conversationId = conversationId;
	}
}

/**
 * The conversation is being deleted (`Harness.deleteConversations()`): it takes no new submission, task, or fork.
 */
export class ConversationDeleting extends Error {
	readonly conversationId: ConversationId;

	constructor(conversationId: ConversationId) {
		super(`Conversation ${conversationId} is being deleted`);
		this.name = "ConversationDeleting";
		this.conversationId = conversationId;
	}
}

/**
 * Why `Harness.deleteConversations()` refused a conversation: the Storage cannot delete; it is the root conversation;
 * a live task outside the deleted set owns it; a fork outside the set reads its history.
 */
export type DeletionRefusal =
	| { readonly kind: "unsupported" }
	| { readonly kind: "root" }
	| { readonly kind: "owner"; readonly taskId: TaskId }
	| { readonly kind: "fork"; readonly forkId: ConversationId };

/** `Harness.deleteConversations()` refused, before it aborted or deleted anything. */
export class DeletionRefused extends Error {
	readonly conversationId: ConversationId;
	readonly refusal: DeletionRefusal;

	constructor(conversationId: ConversationId, refusal: DeletionRefusal) {
		super(`Conversation ${conversationId} cannot be deleted: ${refusalText(refusal)}`);
		this.name = "DeletionRefused";
		this.conversationId = conversationId;
		this.refusal = refusal;
	}
}

function refusalText(refusal: DeletionRefusal): string {
	switch (refusal.kind) {
		case "unsupported":
			return "the storage cannot delete conversations";
		case "root":
			return "it is the root conversation";
		case "owner":
			return `live task ${refusal.taskId} owns it`;
		case "fork":
			return `fork ${refusal.forkId} is not deleted with it`;
	}
}
