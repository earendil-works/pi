import type { ConversationId } from "./types.ts";

/** A transaction read a table after its first table write. Read every required row before writing. */
export class ReadAfterWrite extends Error {
	constructor(method: string) {
		super(`Tx.${method}() cannot read tables after the first table write`);
		this.name = "ReadAfterWrite";
	}
}

/** Storage rejected a batch before any durable effect; the owning Session may continue safely. */
export class StorageRejected extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "StorageRejected";
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
