import type { Context, JsonValue } from "@earendil-works/chord";
import { awaitWithContext, withoutAbortSignal } from "@earendil-works/chord/context";
import { track } from "@earendil-works/chord/delta";
import {
	type AnyDocToken,
	checkRecordScope,
	checkRecordVersion,
	materializeDocument,
	resolveAddress,
} from "../documents.ts";
import { StorageRejected } from "../errors.ts";
import { idFromNumber } from "../ids.ts";
import type {
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	DocumentAddress,
	EntryId,
	JsonObject,
	RewindableConversationDocFamilyToken,
	RewindableConversationDocToken,
	Seq,
	Session,
	SessionDocFamilyToken,
	SessionDocToken,
	Storage,
	StorageWrite,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	Tx,
} from "../types.ts";
import type { CommitChange, CommitPublication } from "./publications.ts";
import { type DocumentCommitChange, type LoadedDocument, Transaction, type TransactionHost } from "./transaction.ts";

/** Open a Session kernel over one storage backend. */
export function createSession(storage: Storage): Session {
	return new SessionKernel(storage);
}

/**
 * Session kernel: one mutation line, the loaded document tracker cache, and committed publication.
 *
 * Only committed state is observable. Every commit callback, preparation, Storage settlement, adoption, and
 * publication enqueue runs while the line is held; listeners run later.
 */
export class SessionKernel implements Session {
	readonly #storage: Storage;
	readonly #documents = new Map<string, LoadedDocument>();
	readonly #listeners = new Set<(publication: CommitPublication, context: Context) => void>();
	readonly #host: TransactionHost;
	#tail: Promise<void> = Promise.resolve();
	#closing: Promise<void> | undefined;
	#poison: { readonly error: unknown } | undefined;

	constructor(storage: Storage) {
		this.#storage = storage;
		this.#host = {
			storage,
			cached: (id) => this.#documents.get(id),
			load: (definition, addressId, address, context) => this.#load(definition, addressId, address, context),
			install: (document) => {
				this.#documents.set(document.addressId, document);
			},
			evict: (id, recordId) => {
				if (this.#documents.get(id)?.record.id === recordId) this.#documents.delete(id);
			},
		};
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		try {
			this.#assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(() => this.#runCommit(change, context));
	}

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
	async snapshot(token: AnyDocToken, ...args: readonly unknown[]): Promise<JsonObject | undefined> {
		this.#assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const loaded =
			this.#documents.get(resolved.id) ??
			(await this.#enqueue(async () => {
				this.#assertHealthy();
				return this.#load(definition, resolved.id, resolved.address, context);
			}));
		if (loaded === undefined) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return loaded.tracker.value;
	}

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
	async snapshotAsOf(token: AnyDocToken, ...args: readonly unknown[]): Promise<JsonObject | undefined> {
		this.#assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		if (resolved.address.scope.kind !== "conversation") {
			throw new TypeError("Session.snapshotAsOf() requires a conversation document");
		}
		const conversationId = resolved.address.scope.conversationId;
		const atValue = args[resolved.nextArgument];
		if (typeof atValue !== "number" || !Number.isSafeInteger(atValue)) {
			throw new TypeError("Session.snapshotAsOf() requires an entry ID");
		}
		const at = idFromNumber<EntryId>(atValue);
		const context = args[resolved.nextArgument + 1] as Context;
		return this.#enqueue(async () => {
			this.#assertHealthy();
			const storedEntry = await this.#storage.entry(conversationId, at, context);
			if (storedEntry === undefined) {
				throw new Error(`Entry ${at} is not visible from conversation ${conversationId}`);
			}
			const address: DocumentAddress = {
				...resolved.address,
				scope: { kind: "conversation", conversationId: storedEntry.entry.conversationId },
			};
			const record = await this.#storage.findDocument(address, storedEntry.commitSeq, context);
			if (record === undefined) return undefined;
			const stored = await this.#storage.document(record.id, storedEntry.commitSeq, context);
			if (stored === undefined) {
				throw new Error(`Historical document ${record.id} (${record.kind}) cannot be read`);
			}
			return materializeDocument(definition, stored);
		});
	}

	close(context: Context): Promise<void> {
		if (this.#closing === undefined) {
			const cleanup = withoutAbortSignal(context);
			this.#closing = this.#enqueue(async () => {
				this.#documents.clear();
				await this.#storage.close(cleanup);
			});
		}
		return awaitWithContext(this.#closing, context);
	}

	/** Register an internal commit listener. Callbacks run later in commit order and must not throw. */
	subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Drop every loaded tracker on the mutation line; later access cold-loads from Storage. */
	unloadDocuments(): Promise<void> {
		return this.#enqueue(async () => {
			this.#documents.clear();
		});
	}

	async #runCommit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		this.#assertHealthy();
		context.abortSignal?.throwIfAborted();
		const tx = new Transaction(this.#host, context);
		let result: T;
		try {
			result = await change(tx);
		} catch (error) {
			await tx.settleFailure();
			throw error;
		}
		const writes = await tx.settleSuccess();
		if (writes.length === 0) {
			tx.discard();
			return result;
		}
		let seq: Seq;
		try {
			// Once admitted, caller cancellation does not interrupt Storage settlement.
			seq = await this.#storage.commit(writes, withoutAbortSignal(context));
		} catch (error) {
			tx.discard();
			// Callback errors never reach this branch; StorageRejected alone guarantees that no batch effect committed.
			if (!(error instanceof StorageRejected)) this.#poison = { error };
			throw error;
		}
		let documents: DocumentCommitChange[];
		try {
			documents = tx.adopt(seq);
		} catch (error) {
			// Storage already committed; a failed adoption leaves memory behind durable state.
			this.#poison = { error };
			throw error;
		}
		this.#publish(seq, writes, documents, context);
		return result;
	}

	#publish(
		seq: Seq,
		writes: readonly StorageWrite[],
		documents: readonly DocumentCommitChange[],
		context: Context,
	): void {
		if (this.#listeners.size === 0) return;
		const changes: CommitChange[] = [];
		for (const write of writes) {
			switch (write.type) {
				case "conversation":
				case "entry":
				case "task":
				case "submission":
					changes.push(write);
			}
		}
		for (const document of documents) changes.push(document);
		const publication: CommitPublication = { seq, changes };
		const listeners = [...this.#listeners];
		queueMicrotask(() => {
			for (const listener of listeners) listener(publication, context);
		});
	}

	async #load(
		definition: AnyDocToken["definition"],
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined> {
		const cached = this.#documents.get(addressId);
		if (cached !== undefined) return cached;
		const record = await this.#storage.findDocument(address, "current", context);
		if (record === undefined) return undefined;
		const stored = await this.#storage.document(record.id, "current", context);
		if (stored === undefined) throw new Error(`Current document ${record.id} (${record.kind}) cannot be read`);
		const value = materializeDocument(definition, stored);
		const loaded: LoadedDocument = {
			addressId,
			record: stored.record,
			storedVersion: stored.version,
			tracker: track(value),
		};
		this.#documents.set(addressId, loaded);
		return loaded;
	}

	#enqueue<T>(job: () => Promise<T>): Promise<T> {
		const run = this.#tail.then(job);
		this.#tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#assertUsable(): void {
		if (this.#closing !== undefined) throw new Error("Session is closed");
		this.#assertHealthy();
	}

	#assertHealthy(): void {
		if (this.#poison !== undefined) {
			throw new Error("Session is poisoned by a failed commit after storage admission; reopen it", {
				cause: this.#poison.error,
			});
		}
	}
}
