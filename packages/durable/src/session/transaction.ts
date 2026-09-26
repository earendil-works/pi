import { type Context, copyJson, type Draft, type JsonValue } from "@earendil-works/chord";
import { type Change, type Op, type Prepared, type Tracker, track } from "@earendil-works/chord/delta";
import {
	type AnyDocDefinition,
	type AnyDocToken,
	addressId,
	checkRecordScope,
	checkRecordVersion,
	documentCreate,
	materializeDocumentValue,
	type ResolvedAddress,
	resolveAddress,
} from "../documents.ts";
import { ReadAfterWrite } from "../errors.ts";
import type {
	ConversationDocFamilyToken,
	ConversationDocToken,
	ConversationId,
	ConversationOwnership,
	ConversationQuery,
	ConversationRecord,
	Cursor,
	DocumentAddress,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	EntryDraft,
	EntryId,
	EntryQuery,
	EntryRecord,
	JsonObject,
	Seq,
	SessionDocFamilyToken,
	SessionDocToken,
	Storage,
	StorageWrite,
	Task,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskOptions,
	TaskQuery,
	TaskRecord,
	Tx,
} from "../types.ts";
import { prepareForkDocumentCopies } from "./forks.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

const INTERNAL_SCAN_PAGE_SIZE = 256;
const EMPTY_OPERATIONS: readonly Op[] = [];
const TABLE_JSON_COPY_OPTIONS = { omitUndefinedProperties: true } as const;

/** Committed change of one document incarnation. */
export type DocumentCommitChange =
	| {
			readonly type: "document";
			readonly record: DocumentRecord;
			/** Conversation owning the document; task documents derive it from their task record. Undefined only for Session documents. */
			readonly conversationId: ConversationId | undefined;
			/** Definition version of `value`; absent when this commit retired the incarnation. */
			readonly version: number | undefined;
			/** Exact adopted immutable revision, or `null` when this commit retired the incarnation. */
			readonly value: JsonObject | null;
			/** Exact adopted operations for an ordinary update; empty for creation and retirement. */
			readonly ops: readonly Op[];
	  }
	| {
			/** Definition-free child initialization; consumers hydrate through a source or watch. */
			readonly type: "document.copy";
			readonly record: DocumentRecord;
			readonly conversationId: ConversationId;
			readonly source: DocumentCopySource;
	  };

/** One committed document incarnation owned by the Session tracker cache. */
export type LoadedDocument = {
	readonly addressId: string;
	readonly record: DocumentRecord;
	/** Persisted definition version; older while the tracked value is migrated only in memory. */
	storedVersion: number;
	readonly tracker: Tracker<JsonObject>;
};

/** Session services used by a transaction while it holds the mutation line. */
export interface TransactionHost {
	readonly storage: Storage;
	/** Return the cached current incarnation without loading. */
	cached(addressId: string): LoadedDocument | undefined;
	/** Return the cached current incarnation, cold-loading and migrating it when necessary. */
	load(
		definition: AnyDocDefinition,
		addressId: string,
		address: DocumentAddress,
		context: Context,
	): Promise<LoadedDocument | undefined>;
	/** Install a newly committed incarnation. */
	install(document: LoadedDocument): void;
	/** Remove a retired incarnation if it is still the cached occupant of its address. */
	evict(addressId: string, recordId: DocumentId): void;
}

/** Committed and candidate state for one task touched by this transaction. */
type TransactionTask = {
	committedRead?: Promise<AnyTaskRecord | undefined>;
	write?: { readonly kind: "create" | "replace"; readonly record: AnyTaskRecord };
	publicationConversationId?: ConversationId;
};

/** Storage/cache provenance of one staged document incarnation. */
type DocumentTarget =
	| { readonly kind: "loaded"; readonly document: LoadedDocument }
	| {
			readonly kind: "created";
			readonly record: DocumentCreate;
			readonly version: number;
			readonly tracker: Tracker<JsonObject>;
	  }
	| {
			readonly kind: "fork-copy";
			readonly record: DocumentCreate;
			readonly source: DocumentCopySource;
	  }
	| { readonly kind: "retire-only"; readonly record: DocumentRecord };

/** One document incarnation acquired, created, or retired by this transaction. */
type DocumentEntry = {
	readonly addressId: string;
	readonly address: DocumentAddress;
	/** Absent for definition-free fork copies and retirement entries discovered by a terminal-task scan. */
	definition?: AnyDocDefinition;
	/** Memoized public acquisition; absent for metadata-only retirement. */
	draftPromise?: Promise<Draft<JsonObject>>;
	/** Set after acquisition or retirement lookup finds the affected incarnation. */
	target?: DocumentTarget;
	change?: Change<JsonObject>;
	prepared?: Prepared<JsonObject>;
	retireOnCommit: boolean;
	/** Resolved before Storage admission so adoption performs no reads. */
	conversationId?: ConversationId;
};

/**
 * Transaction for one Session commit callback.
 *
 * Every asynchronous operation is tracked so callback settlement can reject and drain unfinished work. Session calls
 * one settlement method, then either discards prepared changes or adopts them once after Storage succeeds.
 */
export class Transaction implements Tx {
	readonly #host: TransactionHost;
	readonly #context: Context;
	readonly #pendingOperations = new Set<Promise<unknown>>();
	#sealed = false;
	#hasTableWrite = false;

	/** Atomic batch; conversation and entry writes stage eagerly, while task and document writes assemble later. */
	readonly #writes: StorageWrite[] = [];
	readonly #createdConversationIds = new Set<ConversationId>();
	readonly #forkSourceConversationIds = new Set<ConversationId>();
	readonly #forkSourceDocumentIds = new Set<DocumentId>();
	/** One entry per task touched by a public read, candidate write, or document-owner lookup. */
	readonly #tasksById = new Map<TaskId, TransactionTask>();

	/** Every document acquisition or retirement marker in staging order. */
	readonly #documents: DocumentEntry[] = [];
	/** Latest transaction-local incarnation or retirement marker at each logical address. */
	readonly #latestDocumentByAddress = new Map<string, DocumentEntry>();

	constructor(host: TransactionHost, context: Context) {
		this.#host = host;
		this.#context = context;
	}

	// ─── Table reads ────────────────────────────────────────────────────────

	conversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		return this.#read("conversation", () => this.#host.storage.conversation(id, this.#context));
	}

	entry(id: EntryId): Promise<EntryRecord | undefined> {
		return this.#read("entry", async () => (await this.#host.storage.entry(id, this.#context))?.entry);
	}

	task(id: TaskId): Promise<AnyTaskRecord | undefined> {
		return this.#read("task", () => this.#committedTask(id));
	}

	scanConversations(query: ConversationQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanConversations", () =>
			this.#host.storage.scanConversations(query, limit, cursor, this.#context),
		);
	}

	scanEntries(query: EntryQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanEntries", () => this.#host.storage.scanEntries(query, limit, cursor, this.#context));
	}

	scanTasks(query: TaskQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanTasks", () => this.#host.storage.scanTasks(query, limit, cursor, this.#context));
	}

	// ─── Table writes ───────────────────────────────────────────────────────

	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord> {
		return this.#write(() => this.#stageConversation(undefined, options.ownership));
	}

	forkConversation(
		parentConversationId: ConversationId,
		at: EntryId,
		options: { readonly ownership: ConversationOwnership },
	): Promise<ConversationRecord> {
		return this.#write(() =>
			this.#stageConversation({ conversationId: parentConversationId, at }, options.ownership),
		);
	}

	async #stageConversation(
		parent: NonNullable<ConversationRecord["parent"]> | undefined,
		ownership: ConversationOwnership,
	): Promise<ConversationRecord> {
		const ownerTaskId = ownership.kind === "task" ? ownership.taskId : undefined;
		const id = await this.#host.storage.mintId<ConversationId>();
		this.#assertOpen();
		let owner: ConversationRecord["owner"];
		if (ownerTaskId !== undefined) {
			const task = await this.#currentTask(ownerTaskId);
			this.#assertOpen();
			if (task === undefined) throw new Error(`Conversation owner task ${ownerTaskId} does not exist`);
			owner = { conversationId: task.conversationId, taskId: ownerTaskId };
		}
		const record: ConversationRecord = {
			id,
			...(parent === undefined ? {} : { parent }),
			...(owner === undefined ? {} : { owner }),
		};
		const copies =
			parent === undefined
				? []
				: await prepareForkDocumentCopies(this.#host.storage, parent.conversationId, parent.at, id, this.#context);
		this.#assertOpen();
		for (const copy of copies) {
			this.#forkSourceDocumentIds.add(copy.source.id);
			const entry: DocumentEntry = {
				addressId: addressId(copy.record),
				address: copy.record,
				target: { kind: "fork-copy", ...copy },
				retireOnCommit: false,
			};
			this.#documents.push(entry);
			this.#latestDocumentByAddress.set(entry.addressId, entry);
		}
		if (parent !== undefined) this.#forkSourceConversationIds.add(parent.conversationId);
		this.#createdConversationIds.add(id);
		this.#writes.push({ type: "conversation", value: record });
		return record;
	}

	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord> {
		return this.#write(async () => {
			await this.#requireConversation(conversationId);
			this.#assertOpen();
			const id = await this.#host.storage.mintId<EntryId>();
			this.#assertOpen();
			const { head, ...rest } = value;
			const record = copyJson(
				head === undefined
					? { ...rest, id, conversationId }
					: { ...rest, id, conversationId, head: head === "self" ? id : head },
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as EntryRecord;
			this.#writes.push({ type: "entry", value: record });
			return record;
		});
	}

	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options?: TaskOptions,
	): Promise<TaskId<R>> {
		return this.#write(async () => {
			const conversationId = options?.conversationId;
			if (conversationId === undefined) throw new TypeError("Tx.createTask() requires options.conversationId");
			await this.#requireConversation(conversationId);
			this.#assertOpen();
			const definition = task.definition;
			const checkpoint = definition.initial(input);
			const id = await this.#host.storage.mintId<TaskId<R>>();
			this.#assertOpen();
			const record = copyJson(
				{
					id,
					conversationId,
					kind: definition.name,
					version: definition.version,
					input,
					after: options?.after ?? [],
					background: options?.background ?? false,
					abortRequested: false,
					state: { status: "pending", checkpoint },
				},
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as AnyTaskRecord;
			this.#tasksById.set(id, { write: { kind: "create", record } });
			return id;
		});
	}

	setTask(value: AnyTaskRecord): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		const task = this.#taskEntry(value.id);
		const candidate = task.write?.record;
		if (candidate?.state.status === "terminal") {
			throw new Error(`Task ${value.id} already has a terminal candidate`);
		}
		if (candidate !== undefined && candidate.conversationId !== value.conversationId) {
			throw new Error(`Task ${value.id} cannot change conversations`);
		}
		task.write = {
			kind: task.write?.kind === "create" ? "create" : "replace",
			record: copyJson(value, TABLE_JSON_COPY_OPTIONS) as unknown as AnyTaskRecord,
		};
	}

	// ─── Documents ──────────────────────────────────────────────────────────
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
	doc(token: AnyDocToken, ...args: readonly unknown[]): Promise<Draft<JsonObject>> {
		try {
			this.#assertOpen();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			this.#assertTaskDocumentsOpen(resolved);
			const latest = this.#latestDocumentByAddress.get(resolved.id);
			if (latest !== undefined && !latest.retireOnCommit) {
				if (latest.draftPromise !== undefined) return latest.draftPromise;
				if (latest.target?.kind === "fork-copy") {
					latest.draftPromise = this.#track(this.#acquireForkCopy(latest, definition, latest.target));
					return latest.draftPromise;
				}
			}
			const seed = definition.family === true ? copyJson(args[resolved.nextArgument]) : undefined;
			const docEntry: DocumentEntry = {
				addressId: resolved.id,
				address: resolved.address,
				definition,
				retireOnCommit: false,
			};
			this.#documents.push(docEntry);
			this.#latestDocumentByAddress.set(docEntry.addressId, docEntry);
			// Capture retirement before awaiting so a pending old acquisition and its replacement stay distinct.
			docEntry.draftPromise = this.#track(this.#acquire(docEntry, seed, latest?.retireOnCommit === true));
			return docEntry.draftPromise;
		} catch (error) {
			return Promise.reject(error);
		}
	}

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
	retireDoc(token: AnyDocToken, ...args: readonly unknown[]): Promise<void> {
		try {
			this.#assertOpen();
			const definition = token.definition;
			const resolved = resolveAddress(definition, args);
			const latest = this.#latestDocumentByAddress.get(resolved.id);
			if (latest?.retireOnCommit) return Promise.resolve();
			if (latest?.target?.kind === "fork-copy") {
				checkRecordScope(definition, latest.target.record);
				latest.retireOnCommit = true;
				return Promise.resolve();
			}
			if (latest?.draftPromise !== undefined) {
				// Retirement of an acquired draft persists its final content before retirement.
				latest.retireOnCommit = true;
				return this.#track(latest.draftPromise.then(() => undefined));
			}
			const entry: DocumentEntry = {
				addressId: resolved.id,
				address: resolved.address,
				definition,
				retireOnCommit: true,
			};
			this.#documents.push(entry);
			this.#latestDocumentByAddress.set(entry.addressId, entry);
			return this.#track(this.#findRetirement(entry));
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async #acquire(entry: DocumentEntry, seed: JsonValue | undefined, skipLoad: boolean): Promise<Draft<JsonObject>> {
		const definition = entry.definition!;
		const loaded = skipLoad
			? undefined
			: await this.#host.load(definition, entry.addressId, entry.address, this.#context);
		this.#assertOpen();
		if (loaded !== undefined) {
			checkRecordScope(definition, loaded.record);
			checkRecordVersion(definition, loaded.record, loaded.storedVersion);
			entry.target = { kind: "loaded", document: loaded };
			entry.change = loaded.tracker.beginChange();
			return entry.change.state;
		}
		const scope = entry.address.scope;
		if (scope.kind === "conversation") await this.#requireConversation(scope.conversationId);
		if (scope.kind === "task") {
			const task = await this.#currentTask(scope.taskId);
			if (task === undefined) throw new Error(`Task ${scope.taskId} does not exist`);
			if (task.state.status === "terminal") throw new Error(`Task ${scope.taskId} is terminal`);
		}
		this.#assertOpen();
		const value = copyJson(
			definition.family === true ? definition.initial(seed) : definition.initial(),
		) as JsonObject;
		const id = await this.#host.storage.mintId<DocumentId>();
		this.#assertOpen();
		const tracker = track(value);
		entry.target = {
			kind: "created",
			record: documentCreate(definition, entry.address, id),
			version: definition.version,
			tracker,
		};
		entry.change = tracker.beginChange();
		return entry.change.state;
	}

	async #acquireForkCopy(
		entry: DocumentEntry,
		definition: AnyDocDefinition,
		target: Extract<DocumentTarget, { readonly kind: "fork-copy" }>,
	): Promise<Draft<JsonObject>> {
		const stored = await this.#host.storage.document(target.source.id, target.source.at, this.#context);
		this.#assertOpen();
		if (stored === undefined) {
			throw new Error(`Fork source document ${target.source.id} cannot be read`);
		}
		if (
			stored.record.scope.kind !== "conversation" ||
			stored.record.kind !== target.record.kind ||
			stored.record.key !== target.record.key ||
			stored.record.history !== target.record.history ||
			stored.record.fork !== target.record.fork
		) {
			throw new Error(`Fork source document ${target.source.id} does not match the copied record`);
		}
		const value = materializeDocumentValue(definition, target.record, stored.version, stored.value);
		const tracker = track(value);
		entry.definition = definition;
		entry.target = { kind: "created", record: target.record, version: definition.version, tracker };
		entry.change = tracker.beginChange();
		return entry.change.state;
	}

	async #findRetirement(entry: DocumentEntry): Promise<void> {
		const record =
			this.#host.cached(entry.addressId)?.record ??
			(await this.#host.storage.findDocument(entry.address, "current", this.#context));
		this.#assertOpen();
		if (record === undefined) return;
		checkRecordScope(entry.definition!, record);
		entry.target = { kind: "retire-only", record };
	}

	// ─── Settlement ─────────────────────────────────────────────────────────

	/** Seal after callback failure: abort every change and observe every pending operation. */
	async settleFailure(): Promise<void> {
		this.#sealed = true;
		this.#abortChanges();
		await this.#drain();
	}

	/**
	 * Seal after callback success, prepare every open change, and assemble the atomic batch.
	 * Any failure aborts every change before Storage admission.
	 */
	async settleSuccess(): Promise<readonly StorageWrite[]> {
		this.#sealed = true;
		if (this.#pendingOperations.size > 0) {
			this.#abortChanges();
			await this.#drain();
			throw new Error("Session commit callback settled before its pending Tx operations");
		}
		try {
			// Synchronously prepare every open change; this revokes every draft.
			for (const document of this.#documents) {
				if (document.change !== undefined) document.prepared = document.change.prepare();
			}
			return await this.#assemble();
		} catch (error) {
			this.#abortChanges();
			throw error;
		}
	}

	/** Abort every prepared change after Storage failure or when no write is required. */
	discard(): void {
		this.#abortChanges();
	}

	/** Adopt every prepared change by pointer swap after Storage success and describe the publication. */
	adopt(seq: Seq): DocumentCommitChange[] {
		const publications: DocumentCommitChange[] = [];
		for (const document of this.#documents) {
			const target = document.target;
			if (target === undefined) continue;
			switch (target.kind) {
				case "created": {
					const prepared = document.prepared!;
					const record: DocumentRecord = document.retireOnCommit
						? { ...target.record, createdAt: seq, retiredAt: seq }
						: { ...target.record, createdAt: seq };
					if (document.retireOnCommit) prepared.abort();
					else {
						target.tracker.adopt(prepared);
						this.#host.install({
							addressId: document.addressId,
							record,
							storedVersion: target.version,
							tracker: target.tracker,
						});
					}
					publications.push({
						type: "document",
						record,
						conversationId: document.conversationId,
						version: document.retireOnCommit ? undefined : target.version,
						value: document.retireOnCommit ? null : prepared.value,
						ops: EMPTY_OPERATIONS,
					});
					break;
				}
				case "fork-copy": {
					const record: DocumentRecord = document.retireOnCommit
						? { ...target.record, createdAt: seq, retiredAt: seq }
						: { ...target.record, createdAt: seq };
					if (document.retireOnCommit) {
						publications.push({
							type: "document",
							record,
							conversationId: document.conversationId,
							version: undefined,
							value: null,
							ops: EMPTY_OPERATIONS,
						});
					} else {
						publications.push({
							type: "document.copy",
							record,
							conversationId: document.conversationId!,
							source: target.source,
						});
					}
					break;
				}
				case "loaded": {
					const prepared = document.prepared!;
					const changed = prepared.ops.length > 0;
					if (changed) target.document.tracker.adopt(prepared);
					else prepared.abort();
					if (target.document.storedVersion < document.definition!.version) {
						target.document.storedVersion = document.definition!.version;
					}
					if (!document.retireOnCommit && !changed) break;
					if (document.retireOnCommit) {
						this.#host.evict(target.document.addressId, target.document.record.id);
					}
					publications.push({
						type: "document",
						record: document.retireOnCommit
							? { ...target.document.record, retiredAt: seq }
							: target.document.record,
						conversationId: document.conversationId,
						version: document.retireOnCommit ? undefined : document.definition!.version,
						value: document.retireOnCommit ? null : prepared.value,
						ops: document.retireOnCommit ? EMPTY_OPERATIONS : prepared.ops,
					});
					break;
				}
				case "retire-only":
					this.#host.evict(document.addressId, target.record.id);
					publications.push({
						type: "document",
						record: { ...target.record, retiredAt: seq },
						conversationId: document.conversationId,
						version: undefined,
						value: null,
						ops: EMPTY_OPERATIONS,
					});
					break;
			}
		}
		return publications;
	}

	async #assemble(): Promise<StorageWrite[]> {
		const storage = this.#host.storage;
		this.#rejectForkSourceWrites();
		await this.#validateConversationOwners();
		for (const [id, task] of this.#tasksById) {
			if (task.write?.kind !== "replace") continue;
			const committed = await this.#committedTask(id);
			if (committed === undefined) throw new Error(`Task ${id} does not exist`);
			if (committed.state.status === "terminal") throw new Error(`Task ${id} is already terminal`);
			if (committed.conversationId !== task.write.record.conversationId) {
				throw new Error(`Task ${id} cannot change conversations`);
			}
		}

		// Terminal settlement retires every task document, including ones created by this transaction.
		let terminalTaskIds: Set<TaskId> | undefined;
		for (const task of this.#tasksById.values()) {
			const candidate = task.write?.record;
			if (candidate?.state.status !== "terminal") continue;
			terminalTaskIds ??= new Set();
			terminalTaskIds.add(candidate.id);
		}
		if (terminalTaskIds !== undefined) {
			const targetedDocumentIds = new Set<DocumentId>();
			for (const document of this.#documents) {
				const scope = document.address.scope;
				if (scope.kind !== "task" || !terminalTaskIds.has(scope.taskId)) continue;
				document.retireOnCommit = true;
				const target = document.target;
				if (target?.kind === "loaded") targetedDocumentIds.add(target.document.record.id);
				if (target?.kind === "created" || target?.kind === "retire-only") targetedDocumentIds.add(target.record.id);
			}
			for (const taskId of terminalTaskIds) {
				if (this.#tasksById.get(taskId)?.write?.kind === "create") continue;
				let cursor: Cursor | undefined;
				do {
					const page = await storage.scanDocuments(
						{ scope: { kind: "task", taskId }, at: "current" },
						INTERNAL_SCAN_PAGE_SIZE,
						cursor,
						this.#context,
					);
					for (const record of page.items) {
						if (targetedDocumentIds.has(record.id)) continue;
						this.#documents.push({
							addressId: addressId(record),
							address: record,
							target: { kind: "retire-only", record },
							retireOnCommit: true,
						});
						targetedDocumentIds.add(record.id);
					}
					cursor = page.next;
				} while (cursor !== undefined);
			}
		}

		// Resolve task-document publication ownership before Storage admission so adoption remains synchronous.
		for (const document of this.#documents) {
			const target = document.target;
			if (target === undefined) continue;
			if (target.kind === "loaded" && !document.retireOnCommit && document.prepared!.ops.length === 0) continue;
			const scope = document.address.scope;
			if (scope.kind === "conversation") document.conversationId = scope.conversationId;
			if (scope.kind !== "task") continue;
			const task = this.#taskEntry(scope.taskId);
			if (task.publicationConversationId === undefined) {
				const current = await this.#currentTask(scope.taskId);
				if (current !== undefined) task.publicationConversationId = current.conversationId;
			}
			document.conversationId = task.publicationConversationId;
		}

		const writes = this.#writes;
		for (const task of this.#tasksById.values()) {
			if (task.write !== undefined) writes.push({ type: "task", value: task.write.record });
		}
		for (const document of this.#documents) {
			const target = document.target;
			if (target === undefined) continue;
			switch (target.kind) {
				case "created":
					writes.push({
						type: "document.create",
						record: target.record,
						content: { version: target.version, kind: "base", value: document.prepared!.value },
					});
					if (document.retireOnCommit) writes.push({ type: "document.retire", id: target.record.id });
					break;
				case "fork-copy":
					writes.push({ type: "document.copy", record: target.record, source: target.source });
					if (document.retireOnCommit) writes.push({ type: "document.retire", id: target.record.id });
					break;
				case "loaded": {
					const definition = document.definition!;
					const prepared = document.prepared!;
					if (target.document.storedVersion < definition.version) {
						writes.push({
							type: "document.change",
							id: target.document.record.id,
							content: { version: definition.version, kind: "base", value: prepared.value },
						});
					} else if (prepared.ops.length > 0) {
						const useBase = definition.checkpointWhen?.(prepared.value, prepared.ops) ?? false;
						writes.push({
							type: "document.change",
							id: target.document.record.id,
							content: useBase
								? { version: definition.version, kind: "base", value: prepared.value }
								: { version: definition.version, kind: "delta", ops: prepared.ops },
						});
					}
					if (document.retireOnCommit) {
						writes.push({ type: "document.retire", id: target.document.record.id });
					}
					break;
				}
				case "retire-only":
					writes.push({ type: "document.retire", id: target.record.id });
					break;
			}
		}
		return writes;
	}

	// ─── Helpers ────────────────────────────────────────────────────────────

	async #validateConversationOwners(): Promise<void> {
		for (const write of this.#writes) {
			if (write.type !== "conversation" || write.value.owner === undefined) continue;
			const owner = write.value.owner;
			const task = await this.#currentTask(owner.taskId);
			if (task === undefined) throw new Error(`Conversation owner task ${owner.taskId} does not exist`);
			if (task.conversationId !== owner.conversationId) {
				throw new Error(`Conversation owner task ${owner.taskId} changed conversations`);
			}
			if (task.state.status === "terminal") {
				throw new Error(`Conversation owner task ${owner.taskId} is terminal`);
			}
			if (task.abortRequested) {
				throw new Error(`Conversation owner task ${owner.taskId} is abort-marked`);
			}
		}
	}

	#rejectForkSourceWrites(): void {
		for (const document of this.#documents) {
			const target = document.target;
			if (target === undefined) continue;
			const writes =
				target.kind !== "loaded" ||
				document.retireOnCommit ||
				target.document.storedVersion < document.definition!.version ||
				document.prepared!.ops.length > 0;
			if (!writes) continue;
			const record = target.kind === "loaded" ? target.document.record : target.record;
			if (this.#forkSourceDocumentIds.has(record.id)) {
				throw new Error(`Cannot change fork source document ${record.id} in the fork transaction`);
			}
			const scope = document.address.scope;
			if (
				scope.kind === "conversation" &&
				this.#forkSourceConversationIds.has(scope.conversationId) &&
				record.scope.kind === "conversation" &&
				record.fork === "current"
			) {
				throw new Error(
					`Cannot fork conversation ${scope.conversationId} while changing its current-policy documents`,
				);
			}
		}
	}

	#abortChanges(): void {
		for (const document of this.#documents) document.change?.abort();
	}

	async #drain(): Promise<void> {
		await Promise.allSettled(this.#pendingOperations);
	}

	#assertOpen(): void {
		if (this.#sealed) throw new Error("Transaction has settled");
	}

	#assertTaskDocumentsOpen(resolved: ResolvedAddress): void {
		const scope = resolved.address.scope;
		if (scope.kind === "task" && this.#tasksById.get(scope.taskId)?.write?.record.state.status === "terminal") {
			throw new Error(`Task ${scope.taskId} is terminal`);
		}
	}

	/** Register an operation so callback settlement can reject and drain it. */
	#track<T>(operation: Promise<T>): Promise<T> {
		this.#pendingOperations.add(operation);
		const settle = (): void => {
			this.#pendingOperations.delete(operation);
		};
		operation.then(settle, settle);
		return operation;
	}

	#read<T>(method: string, read: () => Promise<T>): Promise<T> {
		try {
			this.#assertOpen();
			if (this.#hasTableWrite) throw new ReadAfterWrite(method);
			return this.#track(read());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	#write<T>(write: () => Promise<T>): Promise<T> {
		try {
			this.#assertOpen();
			this.#hasTableWrite = true;
			return this.#track(write());
		} catch (error) {
			return Promise.reject(error);
		}
	}

	async #requireConversation(id: ConversationId): Promise<void> {
		if (this.#createdConversationIds.has(id)) return;
		if ((await this.#host.storage.conversation(id, this.#context)) === undefined) {
			throw new Error(`Conversation ${id} does not exist`);
		}
	}

	#taskEntry(id: TaskId): TransactionTask {
		let task = this.#tasksById.get(id);
		if (task === undefined) {
			task = {};
			this.#tasksById.set(id, task);
		}
		return task;
	}

	/** Latest candidate task record, falling back to committed state; not a caller table read. */
	async #currentTask(id: TaskId): Promise<AnyTaskRecord | undefined> {
		return this.#tasksById.get(id)?.write?.record ?? (await this.#committedTask(id));
	}

	#committedTask(id: TaskId): Promise<AnyTaskRecord | undefined> {
		const task = this.#taskEntry(id);
		task.committedRead ??= this.#host.storage.task(id, this.#context);
		return task.committedRead;
	}
}
