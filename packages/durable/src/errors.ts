import type { ConversationId } from "./types.ts";

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

/** A transaction read a table after its first table write. Read every required row before writing. */
export class ReadAfterWrite extends Error {
	constructor(method: string) {
		super(`Tx.${method}() cannot read tables after the first table write`);
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
