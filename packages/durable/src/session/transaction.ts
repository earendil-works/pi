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
	DocumentCommitChange,
	DocumentCopySource,
	DocumentCreate,
	DocumentId,
	DocumentRecord,
	Entry,
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
	SubmissionCreate,
	SubmissionId,
	SubmissionRecord,
	SubmissionSettlement,
	Task,
	TaskDocFamilyToken,
	TaskDocToken,
	TaskId,
	TaskOptions,
	TaskQuery,
	TaskRecord,
	Tx,
	TypedEntry,
	TypedEntryDraft,
} from "../types.ts";
import { ROOT_CONVERSATION_ID } from "../types.ts";
import { prepareForkDocumentCopies } from "./forks.ts";

type AnyTaskRecord = TaskRecord<JsonValue, JsonValue, JsonValue>;

/** A staged submission change: a settlement, or the placement of a queued submission at its entry. */
type SubmissionChange = SubmissionSettlement | { readonly status: "placed"; readonly entry: EntryId };

/**
 * Complete record after applying one change. Placement turns a queued input `placed` and a queued write `done`; only a
 * placed input can be answered. A settled record stays.
 */
function applySubmissionChange(current: SubmissionRecord, change: SubmissionChange): SubmissionRecord {
	if (current.status === "done" || current.status === "unanswered") return current;
	if (change.status === "placed") {
		if (current.status !== "queued") throw new Error(`Submission ${current.id} is not queued`);
		const status = current.type === "input" ? "placed" : "done";
		return { ...current, status, entry: change.entry } as SubmissionRecord;
	}
	if (change.status === "done" && current.status !== "placed") {
		throw new Error(`Submission ${current.id} is not a placed input`);
	}
	// Queued and placed records carry no answer, reason, or detail; an unanswered input keeps its entry.
	return { ...current, ...change } as SubmissionRecord;
}

const INTERNAL_SCAN_PAGE_SIZE = 256;
const EMPTY_OPERATIONS: readonly Op[] = [];
const TABLE_JSON_COPY_OPTIONS = { omitUndefinedProperties: true } as const;

/** One committed document incarnation owned by the Session tracker cache. */
export type LoadedDocument = {
	readonly addressId: string;
	readonly record: DocumentRecord;
	/** Persisted definition version; older while the tracked value is migrated only in memory. */
	storedVersion: number;
	/** Definition version whose shape the tracked value has; access with another version reloads from Storage. */
	readonly valueVersion: number;
	/** Stored deltas after the newest base; advanced by adoption so the next predicate call needs no read. */
	deltasSinceBase: number;
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
	/** Stage writes that belong to every newly created or forked conversation, in its creating transaction. */
	conversationCreated(tx: Transaction, record: ConversationRecord): Promise<void>;
}

/** Committed and candidate state for one task touched by this transaction. */
type TransactionTask = {
	committedRead?: Promise<AnyTaskRecord | undefined>;
	write?: { readonly kind: "create" | "replace"; readonly record: AnyTaskRecord };
	publicationConversationId?: ConversationId;
};

/** Defaults a commit binds to: `tx.createTask()` conversation and the task attributed to appended entries. */
export type TransactionScope = {
	readonly conversationId?: ConversationId;
	/** Task whose runtime commit this is; stamped as `byTaskId` on appended entries. */
	readonly taskId?: TaskId;
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
};

/**
 * What one staged incarnation writes and publishes, decided once before Storage admission so adoption only applies it.
 * `record` is a `DocumentRecord` for an incarnation that is already committed and a `DocumentCreate` for a new one.
 */
type DocumentPlan = {
	readonly addressId: string;
	readonly record: DocumentCreate | DocumentRecord;
	retire: boolean;
	/** Creation, copy, or change content; absent when only retirement is written. */
	content?: Extract<StorageWrite, { readonly type: "document.create" | "document.copy" | "document.change" }>;
	/** Prepared change of a tracked incarnation; absent for fork copies and retirement-only entries. */
	readonly change?: {
		readonly tracker: Tracker<JsonObject>;
		readonly prepared: Prepared<JsonObject>;
		readonly version: number;
		/** The cached incarnation this change updates; absent when it creates one. */
		readonly loaded?: LoadedDocument;
		readonly definition?: AnyDocDefinition;
	};
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
	readonly #scope: TransactionScope;
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
	/** Submissions created by this transaction, by ID. */
	readonly #submissions = new Map<SubmissionId, SubmissionRecord>();
	/** Submission settlements and placements in staging order; resolved against the latest candidate record during assembly. */
	readonly #submissionChanges: { readonly id: SubmissionId; readonly change: SubmissionChange }[] = [];

	/** Write and publication plans of every staged incarnation, built during assembly. */
	readonly #plans: DocumentPlan[] = [];
	/** Every document acquisition or retirement marker in staging order. */
	readonly #documents: DocumentEntry[] = [];
	/** Latest transaction-local incarnation or retirement marker at each logical address. */
	readonly #latestDocumentByAddress = new Map<string, DocumentEntry>();

	constructor(host: TransactionHost, context: Context, scope: TransactionScope = {}) {
		this.#host = host;
		this.#context = context;
		this.#scope = scope;
	}

	// ─── Table reads ────────────────────────────────────────────────────────

	conversation(id: ConversationId): Promise<ConversationRecord | undefined> {
		return this.#read("conversation", () => this.#host.storage.conversation(id, this.#context));
	}

	entry(id: EntryId): Promise<EntryRecord | undefined>;
	entry<D extends JsonValue>(token: Entry<D>, id: EntryId): Promise<TypedEntry<D> | undefined>;
	entry(first: EntryId | { readonly kind: string }, second?: EntryId): Promise<EntryRecord | undefined> {
		const kind = typeof first === "number" ? undefined : first.kind;
		const id = typeof first === "number" ? first : second!;
		return this.#read("entry", async () => {
			const entry = (await this.#host.storage.entry(id, this.#context))?.entry;
			return kind === undefined || entry?.kind === kind ? entry : undefined;
		});
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

	latestHeadMarker(conversationId: ConversationId) {
		return this.#read("latestHeadMarker", () =>
			this.#host.storage.findLatestHeadMarker(conversationId, undefined, this.#context),
		);
	}

	scanTasks(query: TaskQuery, limit: number, cursor?: Cursor) {
		return this.#read("scanTasks", () => this.#host.storage.scanTasks(query, limit, cursor, this.#context));
	}

	/** Internal: committed submission record. */
	submission(id: SubmissionId): Promise<SubmissionRecord | undefined> {
		return this.#read("submission", () => this.#host.storage.submission(id, this.#context));
	}

	/** Committed submission with a conversation-scoped request ID. */
	submissionByRequest(conversationId: ConversationId, requestId: string): Promise<SubmissionRecord | undefined> {
		return this.#read("submissionByRequest", () =>
			this.#host.storage.submissionByRequest(conversationId, requestId, this.#context),
		);
	}

	// ─── Table writes ───────────────────────────────────────────────────────

	createConversation(options: { readonly ownership: ConversationOwnership }): Promise<ConversationRecord> {
		return this.#write(() => this.#stageConversation(undefined, options.ownership));
	}

	/** Internal final-form bootstrap path for the reserved root identity. */
	createRootConversation(): Promise<ConversationRecord> {
		return this.#write(() => this.#stageConversation(undefined, { kind: "ownerless" }, ROOT_CONVERSATION_ID));
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
		reservedId?: ConversationId,
	): Promise<ConversationRecord> {
		const ownerTaskId = ownership.kind === "task" ? ownership.taskId : undefined;
		const id = reservedId ?? (await this.#host.storage.mintId<ConversationId>());
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
		await this.#host.conversationCreated(this, record);
		this.#assertOpen();
		return record;
	}

	appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord>;
	appendEntry<D extends JsonValue>(
		token: Entry<D>,
		conversationId: ConversationId,
		value: TypedEntryDraft<NoInfer<D>>,
	): Promise<TypedEntry<D>>;
	appendEntry(
		first: ConversationId | { readonly kind: string },
		second: ConversationId | EntryDraft,
		third?: object,
	): Promise<EntryRecord> {
		if (typeof first === "number") return this.#appendEntry(first, second as EntryDraft);
		return this.#appendEntry(second as ConversationId, { ...third, kind: first.kind } as EntryDraft);
	}

	#appendEntry(conversationId: ConversationId, value: EntryDraft): Promise<EntryRecord> {
		return this.#write(async () => {
			await this.#requireConversation(conversationId);
			this.#assertOpen();
			const id = await this.#host.storage.mintId<EntryId>();
			this.#assertOpen();
			const { head, ...rest } = value;
			// Undefined `head` and `byTaskId` are omitted by the copy.
			const record = copyJson(
				{
					...rest,
					id,
					conversationId,
					head: head === "self" ? id : head,
					byTaskId: this.#scope.taskId,
				},
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as EntryRecord;
			this.#writes.push({ type: "entry", value: record });
			return record;
		});
	}

	createTask<I, S extends { phase: string }, R, H extends object>(
		task: Task<I, S, R, H>,
		input: I,
		options: TaskOptions,
	): Promise<TaskId<R>> {
		return this.#write(async () => {
			const ownership = options.ownership;
			let owner: AnyTaskRecord | undefined;
			if (ownership.kind === "task") {
				// Validated again against the owner's final candidate during assembly.
				owner = await this.#currentTask(ownership.taskId);
				this.#assertOpen();
				if (owner === undefined) throw new Error(`Task owner ${ownership.taskId} does not exist`);
				if (options.background === true) throw new TypeError("A child task cannot be background");
				if (options.conversationId !== undefined && options.conversationId !== owner.conversationId) {
					throw new Error(`A child task lives in its owner's conversation ${owner.conversationId}`);
				}
			}
			const conversationId = owner?.conversationId ?? options.conversationId ?? this.#scope.conversationId;
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
					...(owner === undefined ? {} : { owner: owner.id }),
					background: options.background ?? false,
					abortRequested: false,
					state: { status: "pending", checkpoint },
				},
				TABLE_JSON_COPY_OPTIONS,
			) as unknown as AnyTaskRecord;
			this.#tasksById.set(id, { write: { kind: "create", record } });
			return id;
		});
	}

	/** Create a raw submission record with a fresh ID; no admission rules apply. */
	createSubmission(create: SubmissionCreate): Promise<SubmissionRecord> {
		return this.#write(async () => {
			await this.#requireConversation(create.conversationId);
			this.#assertOpen();
			const id = await this.#host.storage.mintId<SubmissionId>();
			this.#assertOpen();
			const record = copyJson({ ...create, id }, TABLE_JSON_COPY_OPTIONS) as unknown as SubmissionRecord;
			this.#submissions.set(id, record);
			return record;
		});
	}

	/**
	 * Settle a submission. Resolved during assembly against the transaction's latest candidate record, falling back to
	 * committed state, so it is not a caller table read and works after the first table write.
	 */
	settleSubmission(id: SubmissionId, settlement: SubmissionSettlement): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		this.#submissionChanges.push({ id, change: copyJson(settlement) as SubmissionSettlement });
	}

	/** Place a queued submission at `entry`; resolved during assembly like `settleSubmission()`. */
	placeSubmission(id: SubmissionId, entry: EntryId): void {
		this.#assertOpen();
		this.#hasTableWrite = true;
		this.#submissionChanges.push({ id, change: { status: "placed", entry } });
	}

	/** Internal: replace one task record completely. Tasks change their own state through their runtime. */
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

	/** Internal: candidate records of the tasks this transaction created or replaced so far. */
	stagedTasks(): AnyTaskRecord[] {
		const records: AnyTaskRecord[] = [];
		for (const task of this.#tasksById.values()) if (task.write !== undefined) records.push(task.write.record);
		return records;
	}

	/** Internal: conversations this transaction created or forked so far. */
	stagedConversations(): ConversationRecord[] {
		const records: ConversationRecord[] = [];
		for (const write of this.#writes) if (write.type === "conversation") records.push(write.value);
		return records;
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
		await Promise.allSettled(this.#pendingOperations);
	}

	/**
	 * Seal after callback success, prepare every open change, and assemble the atomic batch.
	 * Any failure aborts every change before Storage admission.
	 */
	async settleSuccess(): Promise<readonly StorageWrite[]> {
		this.#sealed = true;
		if (this.#pendingOperations.size > 0) {
			this.#abortChanges();
			await Promise.allSettled(this.#pendingOperations);
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
		for (const plan of this.#plans) {
			const committed = "createdAt" in plan.record;
			let record: DocumentRecord = committed ? (plan.record as DocumentRecord) : { ...plan.record, createdAt: seq };
			if (plan.retire) record = { ...record, retiredAt: seq };
			const change = plan.change;
			if (change !== undefined) {
				const { tracker, prepared, loaded, version } = change;
				// A new incarnation is adopted unless it retires in the same commit; a loaded one only when it changed.
				if (loaded === undefined ? !plan.retire : prepared.ops.length > 0) tracker.adopt(prepared);
				else prepared.abort();
				if (loaded !== undefined) {
					if (loaded.storedVersion < version) loaded.storedVersion = version;
					if (plan.content?.type === "document.change") {
						if (plan.content.content.kind === "base") loaded.deltasSinceBase = 0;
						else loaded.deltasSinceBase++;
					}
				} else if (!plan.retire) {
					this.#host.install({
						addressId: plan.addressId,
						record,
						storedVersion: version,
						valueVersion: version,
						deltasSinceBase: 0,
						tracker,
					});
				}
			}
			const conversationId = plan.conversationId;
			if (plan.retire) {
				if (committed) this.#host.evict(plan.addressId, record.id);
				const retired = { version: undefined, value: null, ops: EMPTY_OPERATIONS };
				publications.push({ type: "document", record, conversationId, ...retired });
			} else if (plan.content?.type === "document.copy") {
				publications.push({
					type: "document.copy",
					record,
					conversationId: conversationId!,
					source: plan.content.source,
				});
			} else if (change !== undefined && publishes(plan)) {
				const ops = change.loaded === undefined ? EMPTY_OPERATIONS : change.prepared.ops;
				publications.push({
					type: "document",
					record,
					conversationId,
					version: change.version,
					value: change.prepared.value,
					ops,
				});
			}
		}
		return publications;
	}

	async #assemble(): Promise<StorageWrite[]> {
		const storage = this.#host.storage;
		const plans = this.#plans;
		for (const document of this.#documents) {
			const plan = planDocument(document);
			if (plan !== undefined) plans.push(plan);
		}
		this.#rejectForkSourceWrites(plans);
		await this.#validateOwners();
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
		const terminalTaskIds = new Set<TaskId>();
		for (const task of this.#tasksById.values()) {
			if (task.write?.record.state.status === "terminal") terminalTaskIds.add(task.write.record.id);
		}
		if (terminalTaskIds.size > 0) {
			const retiring = new Set<DocumentId>();
			for (const plan of plans) {
				const scope = plan.record.scope;
				if (scope.kind !== "task" || !terminalTaskIds.has(scope.taskId)) continue;
				plan.retire = true;
				retiring.add(plan.record.id);
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
						if (retiring.has(record.id)) continue;
						plans.push({ addressId: addressId(record), record, retire: true });
						retiring.add(record.id);
					}
					cursor = page.next;
				} while (cursor !== undefined);
			}
		}

		// Resolve publication ownership before Storage admission so adoption remains synchronous.
		for (const plan of plans) {
			if (!publishes(plan)) continue;
			const scope = plan.record.scope;
			if (scope.kind === "conversation") plan.conversationId = scope.conversationId;
			if (scope.kind !== "task") continue;
			const task = this.#taskEntry(scope.taskId);
			if (task.publicationConversationId === undefined) {
				const current = await this.#currentTask(scope.taskId);
				if (current !== undefined) task.publicationConversationId = current.conversationId;
			}
			plan.conversationId = task.publicationConversationId;
		}

		for (const { id, change } of this.#submissionChanges) {
			const current = this.#submissions.get(id) ?? (await storage.submission(id, this.#context));
			if (current === undefined) throw new Error(`Submission ${id} does not exist`);
			const next = applySubmissionChange(current, change);
			if (next !== current) this.#submissions.set(id, next);
		}

		const writes = this.#writes;
		for (const value of this.#submissions.values()) writes.push({ type: "submission", value });
		for (const task of this.#tasksById.values()) {
			if (task.write !== undefined) writes.push({ type: "task", value: task.write.record });
		}
		for (const plan of plans) {
			const change = plan.change;
			// Checkpoint predicates run last, after every validation.
			if (plan.content?.type === "document.change" && plan.content.content.kind === "delta" && change?.loaded) {
				const { prepared, version } = change;
				const info = { deltasSinceBase: change.loaded.deltasSinceBase };
				if (change.definition?.checkpointWhen?.(prepared.value, prepared.ops, info)) {
					plan.content = { ...plan.content, content: { version, kind: "base", value: prepared.value } };
				}
			}
			if (plan.content !== undefined) writes.push(plan.content);
			if (plan.retire) writes.push({ type: "document.retire", id: plan.record.id });
		}
		return writes;
	}

	// ─── Helpers ────────────────────────────────────────────────────────────

	/**
	 * New owned work needs a live owner, judged on the owner's final candidate: not `completing`, terminal, or
	 * abort-marked. A task therefore cannot create owned work in the commit that finishes it (spec §5.5).
	 */
	async #validateOwners(): Promise<void> {
		const owners: { readonly what: string; readonly taskId: TaskId }[] = [];
		for (const write of this.#writes) {
			if (write.type !== "conversation" || write.value.owner === undefined) continue;
			owners.push({ what: "Conversation owner task", taskId: write.value.owner.taskId });
		}
		for (const task of this.#tasksById.values()) {
			const record = task.write?.kind === "create" ? task.write.record : undefined;
			if (record?.owner !== undefined) owners.push({ what: "Task owner", taskId: record.owner });
		}
		for (const { what, taskId } of owners) {
			const task = await this.#currentTask(taskId);
			if (task === undefined) throw new Error(`${what} ${taskId} does not exist`);
			if (task.state.status === "terminal" || task.state.status === "completing") {
				throw new Error(`${what} ${taskId} is ${task.state.status}`);
			}
			if (task.abortRequested) throw new Error(`${what} ${taskId} is abort-marked`);
		}
	}

	#rejectForkSourceWrites(plans: readonly DocumentPlan[]): void {
		for (const plan of plans) {
			if (plan.content === undefined && !plan.retire) continue;
			const record = plan.record;
			if (this.#forkSourceDocumentIds.has(record.id)) {
				throw new Error(`Cannot change fork source document ${record.id} in the fork transaction`);
			}
			const scope = plan.record.scope;
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

/** Plan of one staged document: its record, content write, and prepared change. Retirement is decided later. */
function planDocument(document: DocumentEntry): DocumentPlan | undefined {
	const target = document.target;
	if (target === undefined) return undefined;
	const plan = { addressId: document.addressId, retire: document.retireOnCommit };
	switch (target.kind) {
		case "created": {
			const prepared = document.prepared!;
			const { record, version, tracker } = target;
			const content = { version, kind: "base", value: prepared.value } as const;
			return {
				...plan,
				record,
				content: { type: "document.create", record, content },
				change: { tracker, prepared, version },
			};
		}
		case "fork-copy":
			return {
				...plan,
				record: target.record,
				content: { type: "document.copy", record: target.record, source: target.source },
			};
		case "retire-only":
			return { ...plan, record: target.record };
		case "loaded": {
			const loaded = target.document;
			const definition = document.definition!;
			const prepared = document.prepared!;
			const version = definition.version;
			const id = loaded.record.id;
			// A version change stores a base even without operations; otherwise only a change stores a delta.
			const content =
				loaded.storedVersion < version
					? ({ type: "document.change", id, content: { version, kind: "base", value: prepared.value } } as const)
					: prepared.ops.length > 0
						? ({ type: "document.change", id, content: { version, kind: "delta", ops: prepared.ops } } as const)
						: undefined;
			const change = {
				tracker: loaded.tracker,
				prepared,
				version,
				loaded,
				definition,
			};
			return { ...plan, record: loaded.record, change, ...(content === undefined ? {} : { content }) };
		}
	}
}

/**
 * Whether adoption publishes the plan: every creation, copy, and retirement, and a loaded incarnation that writes
 * content, which includes a migration-only base so observers of the older shape receive the new value.
 */
function publishes(plan: DocumentPlan): boolean {
	return plan.retire || plan.change?.loaded === undefined || plan.content !== undefined;
}
