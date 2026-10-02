import { type Context, type JsonValue, replicatedState } from "@earendil-works/chord";
import { awaitWithContext, withoutAbortSignal } from "@earendil-works/chord/context";
import { type Op, track } from "@earendil-works/chord/delta";
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
	CommitChange,
	CommitPublication,
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationRecord,
	DocumentAddress,
	DocumentCommitChange,
	DocumentRecord,
	DocumentState,
	DocumentWatch,
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
import {
	CommittedStateSource,
	CommittedWatch,
	type ObservedDocumentValue,
	RETIREMENT_OPERATIONS,
} from "./observation.ts";
import { type LoadedDocument, Transaction, type TransactionHost, type TransactionScope } from "./transaction.ts";

/** Open a Session kernel over one storage backend. */
export function createSession(storage: Storage): Session {
	return new SessionImpl(storage);
}

/**
 * Session kernel: one mutation line, the loaded document tracker cache, and committed publication.
 *
 * Only committed state is observable. Every commit callback, preparation, Storage settlement, adoption, and
 * publication enqueue runs while the line is held; listeners run later.
 */
export class SessionImpl implements Session {
	readonly #storage: Storage;
	readonly #documents = new Map<string, LoadedDocument>();
	readonly #commitListeners = new Set<(publication: CommitPublication, context: Context) => void>();
	readonly #closeListeners = new Set<() => void>();
	readonly #host: TransactionHost;
	#tail: Promise<void> = Promise.resolve();
	#closing: Promise<void> | undefined;
	#poison: { readonly error: unknown } | undefined;

	constructor(storage: Storage) {
		this.#storage = storage;
		this.#host = {
			storage,
			cached: (id) => this.#documents.get(id),
			load: (definition, addressId, address, context) => this.#loadDocument(definition, addressId, address, context),
			install: (document) => {
				this.#documents.set(document.addressId, document);
			},
			evict: (id, recordId) => {
				if (this.#documents.get(id)?.record.id === recordId) this.#documents.delete(id);
			},
			conversationCreated: (tx, record) => this.conversationCreated(tx, record),
		};
	}

	commit<T>(change: (tx: Tx) => T | Promise<T>, context: Context): Promise<T> {
		return this.commitWith(change, context);
	}

	/**
	 * Internal commit exposing the concrete transaction and its internal operations, such as the reserved-ID root
	 * bootstrap and task replacement. `scope` sets the default `tx.createTask()` conversation and the task attributed to
	 * appended entries.
	 */
	commitWith<T>(change: (tx: Transaction) => T | Promise<T>, context: Context, scope?: TransactionScope): Promise<T> {
		try {
			this.#assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(() => this.#runCommit(change, context, scope));
	}

	/** Internal: run a read-only job on the mutation line so multi-read derivations observe one committed state. */
	readOnLine<T>(job: () => Promise<T>): Promise<T> {
		try {
			this.#assertUsable();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.#enqueue(async () => {
			this.#assertHealthy();
			return job();
		});
	}

	/**
	 * Internal: a conversation document's current incarnation and value, for a job already running on the line (see
	 * `readOnLine()`). Absent documents are `undefined`.
	 */
	async conversationDocumentOnLine(
		token: ConversationDocToken<JsonObject>,
		conversationId: ConversationId,
		context: Context,
	): Promise<{ readonly record: DocumentRecord; readonly version: number; readonly value: JsonObject } | undefined> {
		const definition = token.definition;
		const resolved = resolveAddress(definition, [conversationId, context]);
		const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
		if (loaded === undefined) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return { record: loaded.record, version: loaded.valueVersion, value: loaded.tracker.value };
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
		const cached = this.#documents.get(resolved.id);
		const loaded =
			cached?.valueVersion === definition.version
				? cached
				: await this.#enqueue(async () => {
						this.#assertHealthy();
						return this.#loadDocument(definition, resolved.id, resolved.address, context);
					});
		if (loaded === undefined) return undefined;
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		return loaded.tracker.value;
	}

	documentState<T extends JsonObject>(
		token: SessionDocToken<T>,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentState<T> | undefined>;
	documentState(token: AnyDocToken, ...args: readonly unknown[]): Promise<DocumentState<JsonObject> | undefined> {
		try {
			this.#assertUsable();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const context = args[resolved.nextArgument] as Context;
			return this.#enqueue(async () => {
				this.#assertHealthy();
				const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
				if (loaded === undefined) return undefined;
				const { observer: source, detach } = this.#attachDocument(
					definition,
					loaded,
					(value, release) => new CommittedStateSource<ObservedDocumentValue>(value, release),
				);
				try {
					return replicatedState(source) as DocumentState<JsonObject>;
				} catch (error) {
					detach();
					throw error;
				}
			});
		} catch (error) {
			return Promise.reject(error);
		}
	}

	watchDoc<T extends JsonObject>(token: SessionDocToken<T>, context: Context): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: ConversationDocToken<T>,
		conversationId: ConversationId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject>(
		token: TaskDocToken<T>,
		taskId: TaskId,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: SessionDocFamilyToken<T, I>,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: ConversationDocFamilyToken<T, I>,
		conversationId: ConversationId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	watchDoc<T extends JsonObject, I extends JsonValue>(
		token: TaskDocFamilyToken<T, I>,
		taskId: TaskId,
		key: string,
		context: Context,
	): Promise<DocumentWatch<T> | undefined>;
	async watchDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<DocumentWatch<JsonObject> | undefined> {
		this.#assertUsable();
		const definition = token.definition;
		const resolved = resolveAddress(definition, args);
		const context = args[resolved.nextArgument] as Context;
		const signal = context.abortSignal;
		let cancelled = signal?.aborted ?? false;
		const markCancelled = (): void => {
			cancelled = true;
		};
		signal?.addEventListener("abort", markCancelled, { once: true });
		try {
			const watch = await this.#enqueue(async () => {
				this.#assertHealthy();
				if (cancelled) throw cancellationError(signal!);
				const loaded = await this.#loadDocument(definition, resolved.id, resolved.address, context);
				if (cancelled) throw cancellationError(signal!);
				if (loaded === undefined) return undefined;
				return this.#attachDocument(
					definition,
					loaded,
					(value, release) => new CommittedWatch<ObservedDocumentValue>(value, release),
				).observer;
			});
			if (watch === undefined) return undefined;
			if (cancelled) {
				watch.cancel();
				throw cancellationError(signal!);
			}
			if (signal !== undefined) watch.observeCancellation(signal);
			return watch as DocumentWatch<JsonObject>;
		} finally {
			signal?.removeEventListener("abort", markCancelled);
		}
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
			// Seal admission before anything else runs, then stop observers; admitted work settles before Storage closes.
			this.#closing = Promise.resolve()
				.then(() => this.beforeClose())
				.then(() =>
					this.#enqueue(async () => {
						this.#commitListeners.clear();
						this.#documents.clear();
						await this.#storage.close(cleanup);
					}),
				);
			const listeners = [...this.#closeListeners];
			this.#closeListeners.clear();
			for (const listener of listeners) listener();
		}
		return awaitWithContext(this.#closing, context);
	}

	/**
	 * Runs inside every transaction that creates or forks a conversation, after the conversation record is staged. A
	 * plain Session stages nothing; a Harness stages its built-in documents.
	 */
	protected conversationCreated(_tx: Transaction, _record: ConversationRecord): Promise<void> {
		return Promise.resolve();
	}

	/** Runs after close seals admission and before the line closes Storage; must not reject. */
	protected beforeClose(): Promise<void> {
		return Promise.resolve();
	}

	/** Register a synchronous post-adoption listener. It must not throw, block, or call Session operations. */
	subscribeCommits(listener: (publication: CommitPublication, context: Context) => void): () => void {
		this.#assertUsable();
		this.#commitListeners.add(listener);
		return () => this.#commitListeners.delete(listener);
	}

	/** Register a listener called synchronously when close begins. It must not throw, block, or call Session operations. */
	subscribeClose(listener: () => void): () => void {
		this.#assertUsable();
		this.#closeListeners.add(listener);
		return () => this.#closeListeners.delete(listener);
	}

	/** Drop every loaded tracker on the mutation line; later access cold-loads from Storage. */
	unloadDocuments(): Promise<void> {
		return this.#enqueue(async () => {
			this.#documents.clear();
		});
	}

	async #runCommit<T>(
		change: (tx: Transaction) => T | Promise<T>,
		context: Context,
		scope?: TransactionScope,
	): Promise<T> {
		this.#assertHealthy();
		context.abortSignal?.throwIfAborted();
		const tx = new Transaction(this.#host, context, scope);
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
		if (this.#commitListeners.size === 0) return;
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
		for (const listener of [...this.#commitListeners]) listener(publication, context);
	}

	/**
	 * Attach an observer to one committed incarnation: check the definition, then forward this incarnation's committed
	 * changes and close. `detach` removes both subscriptions.
	 */
	#attachDocument<O extends CommittedStateSource | CommittedWatch>(
		definition: AnyDocToken["definition"],
		loaded: LoadedDocument,
		create: (value: JsonObject, detach: () => void) => O,
	): { observer: O; detach: () => void } {
		checkRecordScope(definition, loaded.record);
		checkRecordVersion(definition, loaded.record, loaded.storedVersion);
		let unsubscribeCommit = (): void => {};
		let unsubscribeClose = (): void => {};
		const detach = (): void => {
			unsubscribeCommit();
			unsubscribeClose();
		};
		const observer = create(loaded.tracker.value, detach);
		const observed = { version: loaded.valueVersion };
		unsubscribeCommit = this.subscribeCommits((publication, context) => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.record.id !== loaded.record.id) continue;
				// A document state's frames carry no caller cancellation; a watch observes its own cancellation.
				const frameContext = observer instanceof CommittedStateSource ? withoutAbortSignal(context) : context;
				const ops = observedOperations(observed, change);
				// A migration-only base changes nothing for an observer of the new version.
				if (ops.length === 0) continue;
				observer.advance(change.value, ops, frameContext);
			}
		});
		unsubscribeClose = this.subscribeClose(() => observer.closeSession());
		return { observer, detach };
	}

	async #loadDocument(
		definition: AnyDocToken["definition"],
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined> {
		const cached = this.#documents.get(addressId);
		// A tracker serves only tokens of the version its value was materialized for; others reload from Storage.
		if (cached?.valueVersion === definition.version) return cached;
		if (cached !== undefined) this.#documents.delete(addressId);
		const record = await this.#storage.findDocument(address, "current", context);
		if (record === undefined) return undefined;
		const stored = await this.#storage.document(record.id, "current", context);
		if (stored === undefined) throw new Error(`Current document ${record.id} (${record.kind}) cannot be read`);
		const value = materializeDocument(definition, stored);
		const loaded: LoadedDocument = {
			addressId,
			record: stored.record,
			storedVersion: stored.version,
			valueVersion: definition.version,
			deltasSinceBase: stored.deltasSinceBase,
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

/**
 * Operations an observer applies for one committed change. An observer hydrated under another definition version holds
 * a differently shaped value, so it receives the new value as a root replacement instead of operations for that shape.
 */
function observedOperations(
	observed: { version: number },
	change: Extract<DocumentCommitChange, { readonly type: "document" }>,
): readonly Op[] {
	if (change.value === null) return RETIREMENT_OPERATIONS;
	if (change.version === observed.version) return change.ops;
	observed.version = change.version!;
	return [["r", change.value]];
}

function cancellationError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
}
